import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PolicyViolation } from "../policy.js";
import type { PurchaseView } from "../purchase/types.js";
import type { SompiPurchaseRuntime } from "../runtime/purchase-runtime.js";
import type { TreasuryOperationModule, TreasuryOperationView } from "../treasury/operations.js";
import type { VaultConfig } from "../vault.js";
import { formatKas, parseKasToSompi } from "../wallet.js";
import { createPurchaseToolHandlers } from "./purchase-tools.js";

const TESTNET = "testnet-10" as const;
const MAX_MCP_RESULT_BYTES = 48 * 1024;
const MAX_POLICY_ALLOWLIST_RESULTS = 128;
const MAX_FEE_BUCKET_RESULTS = 8;
const UINT64_MAX = (1n << 64n) - 1n;

const ADDRESS = z
  .string()
  .min(11)
  .max(256)
  .regex(/^kaspatest:[a-z0-9]+$/, "must be a testnet-10 Kaspa address");
const POSITIVE_ATOMIC = z
  .string()
  .max(20)
  .regex(/^[1-9][0-9]*$/, "must be a positive canonical sompi integer");
const POSITIVE_KAS = z
  .string()
  .max(30)
  .regex(/^(?:0\.[0-9]{1,8}|[1-9][0-9]*(?:\.[0-9]{1,8})?)$/, "must be a positive KAS decimal with at most 8 places");
const NONNEGATIVE_ATOMIC = z
  .string()
  .max(20)
  .regex(/^(?:0|[1-9][0-9]*)$/, "must be a canonical sompi integer");
const NONNEGATIVE_KAS = z
  .string()
  .max(30)
  .regex(/^(?:0(?:\.[0-9]{1,8})?|[1-9][0-9]*(?:\.[0-9]{1,8})?)$/, "must be a non-negative KAS decimal with at most 8 places");
const PURCHASE_ID = z.string().regex(/^pur_[A-Za-z0-9_-]{22}$/);
const PURCHASE_REQUEST_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,160}$/);
const TREASURY_OPERATION_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,160}$/);
const HTTP_METHOD = z
  .string()
  .max(32)
  .regex(/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/)
  .default("GET");

export interface McpToolResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly isError?: boolean;
}

export interface McpToolRegistrar {
  registerTool(
    name: string,
    config: {
      readonly description: string;
      readonly inputSchema?: Readonly<Record<string, z.ZodTypeAny>>;
    },
    handler: (args: any) => Promise<McpToolResult>
  ): unknown;
}

/** Creates the agent-facing server without exposing any protocol adapter. */
export function createSompiMcpServer(
  runtime: SompiPurchaseRuntime,
  version: string,
  treasuryOperations?: TreasuryOperationModule
): McpServer {
  if (!version || version.length > 100) {
    throw new Error("Sompi MCP version is invalid");
  }
  const server = new McpServer({ name: "sompi", version });
  registerSompiTools(
    {
      registerTool(name, config, handler) {
        // The SDK's registerTool generics exceed TypeScript's instantiation
        // depth for this many Zod shapes. This is the single typed boundary.
        (server as any).registerTool(name, config, handler);
      },
    },
    runtime,
    treasuryOperations
  );
  return server;
}

/**
 * Registers thin wallet, vault, policy, and Purchase projections.
 *
 * This function is intentionally protocol-blind: it never imports AP2,
 * x402, or Kaspa-x402 types and never advances Purchase state directly.
 */
export function registerSompiTools(
  registrar: McpToolRegistrar,
  runtime: SompiPurchaseRuntime,
  treasuryOperations?: TreasuryOperationModule
): void {
  if (!registrar || typeof registrar.registerTool !== "function") {
    throw new Error("Sompi MCP tool registrar is unavailable");
  }
  if (!runtime || runtime.wallet.networkId !== TESTNET) {
    throw new Error("sompi-mcp supports only testnet-10");
  }
  const { wallet, vault, journal } = runtime;
  const purchases = createPurchaseToolHandlers(runtime.purchase);

  const register = (
    name: string,
    config: {
      description: string;
      inputSchema?: Record<string, z.ZodTypeAny>;
    },
    operation: string,
    handler: (args: any) => Promise<unknown>
  ): void => {
    registrar.registerTool(name, config, (args) => guarded(operation, () => handler(args)));
  };

  register(
    "get_address",
    {
      description:
        "Get this testnet-10 wallet's Kaspa receive address. Share the address to receive tKAS.",
    },
    "ADDRESS_LOOKUP_FAILED",
    async () => ({
      summary: `This wallet receives tKAS on ${TESTNET} at ${wallet.address}.`,
      address: boundedText(wallet.address, "wallet address", 256),
      network: TESTNET,
    })
  );

  register(
    "get_balance",
    {
      description:
        "Get the testnet-10 KAS balance of an address, defaulting to Sompi's wallet.",
      inputSchema: {
        address: ADDRESS.optional().describe("Kaspa address; omit for Sompi's wallet"),
      },
    },
    "BALANCE_LOOKUP_FAILED",
    async ({ address }: { address?: string }) => {
      const target = address ?? wallet.address;
      const amount = await wallet.balanceSompi(target);
      return {
        summary: `${address ? "That address" : "Sompi's wallet"} holds ${kasDisplay(amount)}.`,
        address: target,
        ...amountFields("balance", amount),
        network: TESTNET,
      };
    }
  );

  register(
    "send_payment",
    {
      description:
        "Durably send testnet KAS from Sompi's wallet under the operator policy. Reuse operationKey for every retry.",
      inputSchema: {
        operationKey: TREASURY_OPERATION_KEY.describe("Caller-stable idempotency key"),
        to: ADDRESS.describe("Destination testnet-10 Kaspa address"),
        amountSompi: POSITIVE_ATOMIC.optional().describe("Exact amount in sompi"),
        amountKas: POSITIVE_KAS.optional().describe("Amount in KAS, as an alternative to amountSompi"),
      },
    },
    "WALLET_SEND_FAILED",
    async ({ operationKey, to, amountSompi, amountKas }: AmountInput & { operationKey: string; to: string }) => {
      const amount = exactAmount(amountSompi, amountKas);
      const result = await requireTreasuryOperations(treasuryOperations).execute({
        operationKey,
        kind: "wallet_send",
        destination: to,
        amountAtomic: amount.toString(),
      });
      return publicTreasuryOperation(result);
    }
  );

  register(
    "await_payment",
    {
      description:
        "Wait for a new testnet payment of at least the requested amount, for at most ten minutes.",
      inputSchema: {
        minAmountKas: POSITIVE_KAS.optional().describe("Minimum amount in KAS"),
        minAmountSompi: POSITIVE_ATOMIC.optional().describe("Exact minimum in sompi"),
        address: ADDRESS.optional().describe("Address to watch; omit for Sompi's wallet"),
        timeoutSeconds: z.number().int().min(1).max(600).default(120),
      },
    },
    "PAYMENT_WAIT_FAILED",
    async ({ minAmountKas, minAmountSompi, address, timeoutSeconds }: {
      minAmountKas?: string;
      minAmountSompi?: string;
      address?: string;
      timeoutSeconds?: number;
    }) => {
      const minimum = exactAmount(minAmountSompi, minAmountKas);
      const target = address ?? wallet.address;
      const result = await wallet.awaitPayment(
        target,
        minimum,
        (timeoutSeconds ?? 120) * 1_000
      );
      return {
        summary: `Received ${kasDisplay(result.receivedSompi)} at ${target}.`,
        address: target,
        ...amountFields("received", result.receivedSompi),
        txids: boundedStringList(result.txids, "transaction IDs", 64, 128),
      };
    }
  );

  register(
    "verify_payment",
    {
      description:
        "Check whether a transaction currently has an unspent output paying the requested address.",
      inputSchema: {
        txid: z.string().regex(/^[0-9a-f]{64}$/),
        address: ADDRESS.optional().describe("Receiving address; omit for Sompi's wallet"),
      },
    },
    "PAYMENT_VERIFICATION_FAILED",
    async ({ txid, address }: { txid: string; address?: string }) => {
      const target = address ?? wallet.address;
      const result = await wallet.verifyPayment(txid, target);
      return {
        summary: result.found
          ? `Transaction ${txid} currently pays ${kasDisplay(result.amountSompi)} to ${target}.`
          : `No current output from transaction ${txid} pays ${target}.`,
        found: result.found,
        address: target,
        txid,
        ...amountFields("amount", result.amountSompi),
      };
    }
  );

  register(
    "estimate_fee",
    {
      description:
        "Get bounded testnet fee-rate estimates in sompi per gram from the connected node.",
    },
    "FEE_ESTIMATE_FAILED",
    async () => feeEstimateView(await wallet.feeEstimate())
  );

  register(
    "network_status",
    {
      description:
        "Get the connected testnet-10 node's synchronization, UTXO-index, DAA, and version status.",
    },
    "NETWORK_STATUS_FAILED",
    async () => networkView(await wallet.serverInfo())
  );

  register(
    "payment_status",
    {
      description:
        "Check whether the wallet, covenant vault, policy, journal, and node are ready for a Purchase.",
    },
    "PAYMENT_STATUS_FAILED",
    async () => paymentReadiness(runtime, treasuryOperations)
  );

  register(
    "vault_deposit",
    {
      description:
        "Durably covenant-fund or top up the vault. Reuse operationKey for every retry.",
      inputSchema: {
        operationKey: TREASURY_OPERATION_KEY.describe("Caller-stable idempotency key"),
        amountKas: POSITIVE_KAS.optional().describe("Amount in KAS; omit to deposit available balance minus float"),
        amountSompi: POSITIVE_ATOMIC.optional().describe("Exact amount in sompi"),
        keepFloatKas: NONNEGATIVE_KAS.optional().describe("Wallet float retained when amount is omitted; default 10 KAS"),
        keepFloatSompi: NONNEGATIVE_ATOMIC.optional().describe("Exact retained wallet float in sompi"),
      },
    },
    "VAULT_DEPOSIT_FAILED",
    async ({ operationKey, amountKas, amountSompi, keepFloatKas, keepFloatSompi }: {
      operationKey: string;
      amountKas?: string;
      amountSompi?: string;
      keepFloatKas?: string;
      keepFloatSompi?: string;
    }) => {
      requireConfiguredVault(vault.configured);
      if (
        (amountKas !== undefined || amountSompi !== undefined) &&
        (keepFloatKas !== undefined || keepFloatSompi !== undefined)
      ) {
        throw new McpPublicError(
          "INVALID_AMOUNT",
          "keepFloat applies only when the deposit amount is omitted."
        );
      }
      const amount = amountKas === undefined && amountSompi === undefined
        ? "max" as const
        : exactAmount(amountSompi, amountKas).toString();
      const keepFloat = amount === "max"
        ? keepFloatKas === undefined && keepFloatSompi === undefined
          ? "1000000000"
          : exactNonnegativeAmount(keepFloatSompi, keepFloatKas).toString()
        : undefined;
      const result = await requireTreasuryOperations(treasuryOperations).execute({
        operationKey,
        kind: "vault_deposit",
        destination: vault.config().address,
        amountAtomic: amount,
        ...(keepFloat === undefined ? {} : { keepFloatAtomic: keepFloat }),
      });
      return publicTreasuryOperation(result);
    }
  );

  register(
    "vault_status",
    {
      description:
        "Show the covenant vault's public configuration, rolling state, and on-chain balances.",
    },
    "VAULT_STATUS_FAILED",
    async () => vaultStatus(runtime)
  );

  register(
    "vault_send",
    {
      description:
        "Durably withdraw testnet KAS through the consensus-capped vault. Reuse operationKey for every retry.",
      inputSchema: {
        operationKey: TREASURY_OPERATION_KEY.describe("Caller-stable idempotency key"),
        to: ADDRESS.describe("Destination testnet-10 Kaspa address"),
        amountKas: POSITIVE_KAS.optional(),
        amountSompi: POSITIVE_ATOMIC.optional(),
      },
    },
    "VAULT_SEND_FAILED",
    async ({ operationKey, to, amountKas, amountSompi }: AmountInput & { operationKey: string; to: string }) => {
      requireConfiguredVault(vault.configured);
      if (amountKas !== undefined && amountSompi !== undefined) {
        throw new McpPublicError("INVALID_AMOUNT", "Provide exactly one of amountKas or amountSompi.");
      }
      const requested = amountSompi ?? amountKas;
      if (requested === undefined) {
        throw new McpPublicError("INVALID_AMOUNT", "Provide amountKas or amountSompi.");
      }
      const amount = amountSompi !== undefined
        ? BigInt(amountSompi).toString()
        : parseKasToSompi(amountKas!).toString();
      const result = await requireTreasuryOperations(treasuryOperations).execute({
        operationKey,
        kind: "vault_send",
        destination: to,
        amountAtomic: amount,
      });
      return publicTreasuryOperation(result);
    }
  );

  register(
    "treasury_operation_status",
    {
      description: "Read one durable direct Treasury Movement without performing an external side effect.",
      inputSchema: { operationKey: TREASURY_OPERATION_KEY },
    },
    "TREASURY_OPERATION_STATUS_FAILED",
    async ({ operationKey }: { operationKey: string }) =>
      publicTreasuryOperation(requireTreasuryOperations(treasuryOperations).status(operationKey))
  );

  register(
    "treasury_operation_recover",
    {
      description:
        "Reconcile an interrupted direct Treasury Movement; it resubmits only after exact source inputs prove non-submission.",
      inputSchema: { operationKey: TREASURY_OPERATION_KEY },
    },
    "TREASURY_OPERATION_RECOVERY_FAILED",
    async ({ operationKey }: { operationKey: string }) =>
      publicTreasuryOperation(await requireTreasuryOperations(treasuryOperations).recover(operationKey))
  );

  register(
    "get_policy",
    {
      description:
        "Show the operator-owned spending policy. This tool is read-only and cannot loosen policy.",
    },
    "POLICY_LOOKUP_FAILED",
    async () => policyView(runtime, treasuryOperations)
  );

  register(
    "purchase",
    {
      description:
        "Start or idempotently resume a human-present AP2 Purchase paid through Kaspa-x402 exact on testnet-10.",
      inputSchema: {
        requestKey: PURCHASE_REQUEST_KEY.describe("Caller-stable idempotency key"),
        url: z.string().max(2_048).url(),
        method: HTTP_METHOD,
        bodyBase64: z.string().max(1_398_104).optional(),
        mediaType: z.string().min(1).max(200).optional(),
        expectedMerchantId: z.string().min(1).max(256).optional(),
        expectedMerchantOrigin: z.string().max(2_048).url().optional(),
      },
    },
    "PURCHASE_FAILED",
    async (input) => publicPurchaseView(await purchases.purchase(input))
  );

  register(
    "purchase_status",
    {
      description:
        "Read one durable Purchase without performing an external side effect.",
      inputSchema: { purchaseId: PURCHASE_ID },
    },
    "PURCHASE_STATUS_FAILED",
    async (input) => publicPurchaseView(await purchases.purchaseStatus(input))
  );

  register(
    "purchase_recover",
    {
      description:
        "Reconcile one interrupted Purchase from durable intent and external observations; never blindly resubmit payment.",
      inputSchema: { purchaseId: PURCHASE_ID },
    },
    "PURCHASE_RECOVERY_FAILED",
    async (input) => publicPurchaseView(await purchases.purchaseRecover(input))
  );

  // Assert the journal at registration time without exposing its filename.
  if (!journal || typeof journal.integrityCheck !== "function") {
    throw new Error("Sompi Purchase Journal is unavailable");
  }
}

type AmountInput = {
  amountSompi?: string;
  amountKas?: string;
};

class McpPublicError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpPublicError";
  }
}

async function guarded(
  operation: string,
  handler: () => Promise<unknown>
): Promise<McpToolResult> {
  try {
    return success(await handler());
  } catch (error) {
    if (error instanceof PolicyViolation) {
      return failure("POLICY_DENIED", boundedPublicMessage(error.message, 1_200));
    }
    if (error instanceof McpPublicError) {
      return failure(error.code, boundedPublicMessage(error.message, 1_200));
    }
    // Lower layers may include signed artifacts, request headers, local paths,
    // or key material in an exception. None crosses the MCP trust boundary.
    return failure(
      operation,
      "The operation failed inside Sompi. Ask the operator to inspect the local service; do not retry an interrupted payment blindly."
    );
  }
}

function success(payload: unknown): McpToolResult {
  const text = JSON.stringify(payload, bigintSafe, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_MCP_RESULT_BYTES) {
    return failure(
      "RESULT_TOO_LARGE",
      "The result exceeds Sompi's MCP output limit. Use Purchase status or the durable fulfilment handle instead."
    );
  }
  return { content: [{ type: "text", text }] };
}

function failure(code: string, summary: string): McpToolResult {
  const text = JSON.stringify({ summary, errorCode: code });
  return { content: [{ type: "text", text }], isError: true };
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function exactAmount(amountSompi?: string, amountKas?: string): bigint {
  if ((amountSompi === undefined) === (amountKas === undefined)) {
    throw new McpPublicError(
      "INVALID_AMOUNT",
      "Provide exactly one of the KAS or sompi amount fields."
    );
  }
  const amount = amountSompi === undefined
    ? parseKasToSompi(amountKas!)
    : BigInt(amountSompi);
  if (amount <= 0n) {
    throw new McpPublicError("INVALID_AMOUNT", "The amount must be positive.");
  }
  if (amount > UINT64_MAX) {
    throw new McpPublicError("INVALID_AMOUNT", "The amount exceeds the supported atomic-unit range.");
  }
  return amount;
}

function exactNonnegativeAmount(amountSompi?: string, amountKas?: string): bigint {
  if ((amountSompi === undefined) === (amountKas === undefined)) {
    throw new McpPublicError(
      "INVALID_AMOUNT",
      "Provide exactly one of the KAS or sompi amount fields."
    );
  }
  const amount = amountSompi === undefined
    ? parseKasToSompi(amountKas!)
    : BigInt(amountSompi);
  if (amount < 0n || amount > UINT64_MAX) {
    throw new McpPublicError(
      "INVALID_AMOUNT",
      "The amount is outside the supported atomic-unit range."
    );
  }
  return amount;
}

function kasValue(sompi: bigint | string): string {
  return formatKas(BigInt(sompi));
}

function kasDisplay(sompi: bigint | string): string {
  return `${kasValue(sompi)} tKAS`;
}

function amountFields(prefix: string, sompi: bigint | string): Record<string, string> {
  const value = BigInt(sompi);
  return {
    [`${prefix}Sompi`]: value.toString(),
    [`${prefix}Kas`]: kasValue(value),
    [`${prefix}Display`]: kasDisplay(value),
  };
}

function policyView(
  runtime: SompiPurchaseRuntime,
  treasuryOperations?: TreasuryOperationModule
) {
  const current = runtime.policy.policy;
  const spent = requireTreasuryOperations(treasuryOperations).effectiveCapacityUsed();
  const remaining = current.maxSompiPerHour > spent
    ? current.maxSompiPerHour - spent
    : 0n;
  const allowlist = boundedStringList(
    current.allowlist.slice(0, MAX_POLICY_ALLOWLIST_RESULTS),
    "policy allowlist",
    MAX_POLICY_ALLOWLIST_RESULTS,
    256
  );
  return {
    summary: `Policy allows up to ${kasDisplay(current.maxSompiPerTx)} per payment and ${kasDisplay(current.maxSompiPerHour)} per hour.`,
    ...amountFields("maxPerTx", current.maxSompiPerTx),
    ...amountFields("maxPerHour", current.maxSompiPerHour),
    ...amountFields("spentLastHour", spent),
    ...amountFields("remainingHour", remaining),
    allowlist,
    allowlistTruncated: current.allowlist.length > allowlist.length,
    ...amountFields("requireApprovalAbove", current.requireApprovalAboveSompi),
    requireApprovalAboveDisplay:
      current.requireApprovalAboveSompi === 0n
        ? "disabled"
        : kasDisplay(current.requireApprovalAboveSompi),
  };
}

async function paymentReadiness(
  runtime: SompiPurchaseRuntime,
  treasuryOperations?: TreasuryOperationModule
) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let node: ReturnType<typeof networkView> | undefined;
  try {
    node = networkView(await runtime.wallet.serverInfo());
    if (node.isSynced !== true) blockers.push("The connected Kaspa node is not synced.");
    if (node.hasUtxoIndex !== true) blockers.push("The connected Kaspa node does not have UTXO index enabled.");
  } catch {
    blockers.push("A usable Kaspa testnet-10 node is unavailable.");
  }

  let walletBalance: bigint | undefined;
  try {
    walletBalance = await runtime.wallet.balanceSompi();
  } catch {
    warnings.push("The regular wallet balance could not be read.");
  }

  let policy: ReturnType<typeof policyView> | undefined;
  try {
    policy = policyView(runtime, treasuryOperations);
  } catch {
    blockers.push("The operator-owned spending policy is unavailable or invalid.");
  }

  let vault: VaultReadinessView;
  try {
    vault = await vaultReadiness(runtime);
    if (!vault.configured) blockers.push("The covenant vault has not been configured.");
    else if (!vault.covenantFunded) blockers.push("The covenant vault has not been funded.");
    else if (BigInt(vault.balanceSompi ?? "0") <= 0n) blockers.push("The covenant vault has no spendable balance.");
    if (BigInt(vault.unboundSompi ?? "0") > 0n) {
      warnings.push("The vault address also has funds that are not covenant-bound and require owner recovery.");
    }
  } catch {
    vault = { configured: runtime.vault.configured, covenantFunded: false };
    blockers.push("The covenant vault state could not be verified.");
  }

  let recoverableEffectCount = 0;
  try {
    runtime.journal.integrityCheck();
    recoverableEffectCount = runtime.journal.recoverableEffects().length;
    if (recoverableEffectCount > 0) {
      warnings.push(`${recoverableEffectCount} durable Purchase effect(s) require reconciliation.`);
    }
  } catch {
    blockers.push("The Purchase Journal failed its integrity check.");
  }

  let unresolvedTreasuryOperationCount = 0;
  try {
    const operations = requireTreasuryOperations(treasuryOperations);
    operations.integrityCheck();
    unresolvedTreasuryOperationCount = operations.unresolvedCount();
    if (unresolvedTreasuryOperationCount > 0) {
      warnings.push(
        `${unresolvedTreasuryOperationCount} direct Treasury operation(s) require completion or reconciliation.`
      );
    }
  } catch {
    blockers.push("The Treasury Operation Journal failed its integrity check or is unavailable.");
  }

  const ready = blockers.length === 0;
  return {
    summary: ready
      ? `Ready for human-present testnet Purchases with ${vault.balanceDisplay ?? "an available vault balance"}.`
      : `Not ready for a Purchase: ${blockers[0]}`,
    status: ready ? (warnings.length === 0 ? "ready" : "ready_with_warnings") : "blocked",
    userAction: ready ? "none" : paymentStatusNextStep(blockers[0]),
    blockers,
    warnings,
    network: node,
    wallet: {
      address: runtime.wallet.address,
      ...(walletBalance === undefined ? {} : amountFields("balance", walletBalance)),
    },
    vault,
    policy,
    purchaseJournal: {
      integrity: blockers.includes("The Purchase Journal failed its integrity check.")
        ? "failed"
        : "ok",
      recoverableEffectCount,
    },
    treasuryOperationJournal: {
      integrity: blockers.includes("The Treasury Operation Journal failed its integrity check or is unavailable.")
        ? "failed"
        : "ok",
      unresolvedOperationCount: unresolvedTreasuryOperationCount,
    },
  };
}

function paymentStatusNextStep(blocker?: string): string {
  if (!blocker) return "none";
  if (blocker.includes("not been configured")) {
    return "Ask the operator to provision the vault outside the MCP session with sompi-operator.";
  }
  if (blocker.includes("not been funded") || blocker.includes("no spendable balance")) {
    return "Fund Sompi's wallet, then call vault_deposit with a stable operationKey.";
  }
  if (blocker.includes("node")) {
    return "Configure or restore a synced testnet-10 Kaspa node with UTXO index enabled.";
  }
  if (blocker.includes("Journal")) {
    return "Stop payment attempts and ask the operator to inspect the durable journal named in the blocker.";
  }
  return "Report the blocker to the operator; do not bypass policy, authority, or vault controls.";
}

async function vaultReadiness(runtime: SompiPurchaseRuntime) {
  if (!runtime.vault.configured) {
    return { configured: false, covenantFunded: false } as const;
  }
  const config = runtime.vault.config();
  const balances = await runtime.vault.balanceBreakdown(runtime.wallet);
  return {
    configured: true,
    covenantFunded: Boolean(config.covenantId),
    ...publicVaultConfig(config),
    ...amountFields("balance", balances.spendableSompi),
    ...amountFields("unbound", balances.unboundSompi),
  } as const;
}

interface VaultReadinessView {
  readonly configured: boolean;
  readonly covenantFunded: boolean;
  readonly balanceSompi?: string;
  readonly balanceKas?: string;
  readonly balanceDisplay?: string;
  readonly unboundSompi?: string;
  readonly unboundKas?: string;
  readonly unboundDisplay?: string;
  readonly [key: string]: unknown;
}

async function vaultStatus(runtime: SompiPurchaseRuntime) {
  if (!runtime.vault.configured) {
    return {
      summary: "The covenant vault has not been configured.",
      status: "needs_setup",
      configured: false,
      nextStep: "Ask the operator to provision the vault outside the MCP session with sompi-operator.",
    };
  }
  const config = runtime.vault.config();
  const balances = await runtime.vault.balanceBreakdown(runtime.wallet);
  return {
    summary: config.covenantId
      ? `Vault has ${kasDisplay(balances.spendableSompi)} spendable under a ${kasDisplay(config.maxOutflowSompi)} rolling cap.`
      : "The vault configuration exists but needs its first covenant deposit.",
    status: config.covenantId ? "ready" : "needs_deposit",
    configured: true,
    covenantFunded: Boolean(config.covenantId),
    ...publicVaultConfig(config),
    ...amountFields("balance", balances.spendableSompi),
    ...amountFields("unbound", balances.unboundSompi),
    maxOutflowKas: kasValue(config.maxOutflowSompi),
    maxOutflowDisplay: kasDisplay(config.maxOutflowSompi),
    spentInWindowKas: kasValue(config.spentInWindowSompi),
    spentInWindowDisplay: kasDisplay(config.spentInWindowSompi),
    ...(config.covenantId
      ? {}
      : {
          nextStep: "Fund Sompi's wallet, then call vault_deposit with a stable operationKey.",
        }),
  };
}

function requireTreasuryOperations(
  operations: TreasuryOperationModule | undefined
): TreasuryOperationModule {
  if (!operations) {
    throw new McpPublicError(
      "TREASURY_OPERATIONS_UNAVAILABLE",
      "The durable Treasury Operation module is unavailable. Do not bypass it with direct wallet or vault calls."
    );
  }
  return operations;
}

function publicTreasuryOperation(operation: TreasuryOperationView) {
  return {
    summary: boundedText(operation.summary, "Treasury operation summary", 1_200),
    operationKey: boundedText(operation.operationKey, "Treasury operation key", 160),
    kind: operation.kind,
    state: operation.state,
    destination: boundedText(operation.destination, "Treasury destination", 256),
    requestedAmountAtomic: operation.requestedAmountAtomic,
    ...(operation.amountAtomic === undefined
      ? {}
      : amountFields("amount", operation.amountAtomic)),
    ...(operation.feeAtomic === undefined
      ? {}
      : amountFields("fee", operation.feeAtomic)),
    ...(operation.transactionId === undefined
      ? {}
      : { transactionId: boundedText(operation.transactionId, "Treasury transaction ID", 128) }),
    retryCount: operation.retryCount,
    recoveryRequired: operation.recoveryRequired,
    safeToRetry: operation.safeToRetry,
    network: TESTNET,
  };
}

function publicVaultConfig(config: VaultConfig) {
  return {
    template: boundedText(config.template, "vault template", 100),
    agentPublic: boundedText(config.agentPublic, "vault agent public key", 128),
    ownerPublic: boundedText(config.ownerPublic, "vault owner public key", 128),
    maxOutflowSompi: canonicalAtomic(config.maxOutflowSompi, "vault cap"),
    windowSizeDaa: canonicalAtomic(config.windowSizeDaa, "vault window"),
    windowStartDaa: canonicalAtomic(config.windowStartDaa, "vault window start", true),
    spentInWindowSompi: canonicalAtomic(config.spentInWindowSompi, "vault window spend", true),
    address: boundedText(config.address, "vault address", 256),
    ...(config.covenantId
      ? { covenantId: boundedText(config.covenantId, "covenant ID", 128) }
      : {}),
    ...(config.currentOutpoint
      ? {
          currentOutpoint: {
            txid: boundedText(config.currentOutpoint.txid, "vault outpoint transaction ID", 128),
            index: config.currentOutpoint.index,
          },
        }
      : {}),
  };
}

function networkView(info: any) {
  const daa = String(info?.virtualDaaScore ?? "unknown");
  if (daa !== "unknown" && !/^[0-9]{1,40}$/.test(daa)) {
    throw new Error("Kaspa node returned an invalid DAA score");
  }
  return {
    summary:
      info?.isSynced === true && info?.hasUtxoIndex === true
        ? `Connected to a synced ${TESTNET} node with UTXO index enabled.`
        : `Connected to ${TESTNET}, but the node is not fully ready for payments.`,
    network: TESTNET,
    isSynced: info?.isSynced === true,
    hasUtxoIndex: info?.hasUtxoIndex === true,
    virtualDaaScore: daa,
    serverVersion: boundedUnknownText(info?.serverVersion, "server version", 120),
  };
}

function feeEstimateView(response: any) {
  const estimate = response?.estimate;
  const priority = feeBucket(estimate?.priorityBucket);
  const normal = Array.isArray(estimate?.normalBuckets)
    ? estimate.normalBuckets.slice(0, MAX_FEE_BUCKET_RESULTS).map(feeBucket)
    : [];
  const low = Array.isArray(estimate?.lowBuckets)
    ? estimate.lowBuckets.slice(0, MAX_FEE_BUCKET_RESULTS).map(feeBucket)
    : [];
  return {
    summary: normal[0]
      ? `Current normal fee rate is about ${normal[0].feerateSompiPerGram} sompi per gram.`
      : "The node returned no normal fee-rate bucket.",
    unit: "sompi-per-gram",
    priority,
    normal,
    low,
    truncated:
      (estimate?.normalBuckets?.length ?? 0) > normal.length ||
      (estimate?.lowBuckets?.length ?? 0) > low.length,
  };
}

function feeBucket(value: any) {
  const feerate = Number(value?.feerate);
  const estimatedSeconds = Number(value?.estimatedSeconds);
  if (!Number.isFinite(feerate) || feerate < 0 || !Number.isFinite(estimatedSeconds) || estimatedSeconds < 0) {
    throw new Error("Kaspa node returned an invalid fee bucket");
  }
  return {
    feerateSompiPerGram: feerate,
    estimatedSeconds,
  };
}

function publicPurchaseView(view: PurchaseView) {
  if (view.paymentAttempts.length > 64 || view.receiptEvidence.length > 64) {
    throw new McpPublicError(
      "RESULT_TOO_LARGE",
      "The Purchase has too many inline history entries; inspect its durable journal locally."
    );
  }
  if (view.fulfilmentBody && Buffer.byteLength(view.fulfilmentBody, "utf8") > 8 * 1024) {
    throw new McpPublicError(
      "RESULT_TOO_LARGE",
      "The fulfilment exceeds the inline limit; use its durable fulfilment handle."
    );
  }
  return {
    id: view.id,
    requestKey: view.requestKey,
    state: view.state,
    summary: boundedText(view.summary, "Purchase summary", 512),
    ...(view.userAction
      ? { userAction: boundedText(view.userAction, "Purchase action", 512) }
      : {}),
    resourceFingerprint: view.resourceFingerprint,
    ...(view.terms
      ? {
          terms: {
            merchant: {
              id: boundedText(view.terms.merchant.id, "Merchant ID", 256),
              name: boundedText(view.terms.merchant.name, "Merchant name", 256),
              origin: boundedText(view.terms.merchant.origin, "Merchant origin", 2_048),
            },
            resourceFingerprint: view.terms.resourceFingerprint,
            amountAtomic: canonicalAtomic(view.terms.amountAtomic, "Purchase amount", true),
            asset: boundedText(view.terms.asset, "Purchase asset", 40),
            network: boundedText(view.terms.network, "Purchase network", 100),
            payTo: boundedText(view.terms.payTo, "Purchase payee", 300),
            expiresAt: boundedText(view.terms.expiresAt, "Purchase expiry", 100),
            checkoutDigest: view.terms.checkoutDigest,
          },
        }
      : {}),
    authorization: {
      status: view.authorization.status,
      ...(view.authorization.authorityId
        ? { authorityId: boundedText(view.authorization.authorityId, "authority ID", 256) }
        : {}),
      ...(view.authorization.evidenceDigest
        ? { evidenceDigest: view.authorization.evidenceDigest }
        : {}),
    },
    treasury: {
      status: view.treasury.status,
      ...(view.treasury.amountAtomic !== undefined
        ? { amountAtomic: canonicalAtomic(view.treasury.amountAtomic, "Treasury amount", true) }
        : {}),
      ...(view.treasury.additionalCostCeilingAtomic !== undefined
        ? {
            additionalCostCeilingAtomic: canonicalAtomic(
              view.treasury.additionalCostCeilingAtomic,
              "Treasury additional-cost ceiling",
              true
            ),
          }
        : {}),
      ...(view.treasury.reservationId
        ? { reservationId: boundedText(view.treasury.reservationId, "Treasury reservation", 256) }
        : {}),
      ...(view.treasury.fundingSource
        ? { fundingSource: view.treasury.fundingSource }
        : {}),
    },
    paymentAttempts: view.paymentAttempts.map((attempt) => ({
      attempt: attempt.attempt,
      identifier: attempt.identifier,
      status: attempt.status,
      ...(attempt.transactionId
        ? { transactionId: boundedText(attempt.transactionId, "payment transaction ID", 128) }
        : {}),
      ...(attempt.finality
        ? { finality: boundedText(attempt.finality, "payment finality", 100) }
        : {}),
      evidenceDigests: [...attempt.evidenceDigests],
    })),
    ...(view.settlementEvidence
      ? { settlementEvidence: view.settlementEvidence }
      : {}),
    ...(view.fulfilmentDigest
      ? { fulfilmentDigest: view.fulfilmentDigest }
      : {}),
    receiptEvidence: [...view.receiptEvidence],
    ...(view.fulfilmentBody !== undefined
      ? { fulfilmentBody: view.fulfilmentBody }
      : {}),
    ...(view.fulfilmentHandle
      ? { fulfilmentHandle: boundedText(view.fulfilmentHandle, "fulfilment handle", 240) }
      : {}),
  };
}

function canonicalAtomic(value: string, label: string, allowZero = false): string {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (value.length > 40 || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is not safe for MCP output`);
  }
  return value;
}

function boundedUnknownText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "unknown";
  }
  return boundedText(String(value), label, maximum);
}

function boundedPublicMessage(value: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0) return "The operation was denied safely.";
  const withoutControls = value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    " "
  );
  return withoutControls.length <= maximum
    ? withoutControls
    : `${withoutControls.slice(0, maximum - 1)}…`;
}

function boundedStringList(
  values: readonly string[],
  label: string,
  maximumItems: number,
  maximumCharacters: number
): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new Error(`${label} exceeds the MCP result limit`);
  }
  return values.map((value) => boundedText(value, label, maximumCharacters));
}

function requireConfiguredVault(configured: boolean): void {
  if (!configured) {
    throw new McpPublicError(
      "VAULT_NOT_CONFIGURED",
      "The vault is not configured. Ask the operator to provision it outside the MCP session with sompi-operator."
    );
  }
}
