#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PolicyEngine, PolicyViolation } from "./policy";
import { KaspaWallet, formatKas, parseKasToSompi } from "./wallet";
import { VaultManager } from "./vault";
import { X402Client } from "./x402/client";

// Operator-side CLI: `npx @elldeeone/sompi gen-wallet-key [network]` — generate
// the agent's wallet key yourself so you control and can back it up, and know
// the address to fund before wiring up the agent. Import it via SOMPI_PRIVATE_KEY.
if (process.argv[2] === "gen-wallet-key") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateWalletKey } = require("./wallet") as typeof import("./wallet");
  const net = process.argv[3] ?? process.env.SOMPI_NETWORK ?? "testnet-10";
  const key = generateWalletKey(net);
  console.log(`Agent wallet keypair (${net}) — generated locally, back up the private line:`);
  console.log(`private: ${key.privateKey}`);
  console.log(`address: ${key.address}`);
  console.log(
    `\nFund the address, then give the agent this key via env:\n` +
      `  SOMPI_PRIVATE_KEY=${key.privateKey}\n` +
      `(set it in the MCP server's env block; never share the private line otherwise).`
  );
  process.exit(0);
}

// Operator-side CLI: `npx @elldeeone/sompi gen-owner-key` — run on the
// HUMAN's machine, before any MCP plumbing starts.
if (process.argv[2] === "gen-owner-key") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateOwnerKey } = require("./vault") as typeof import("./vault");
  const key = generateOwnerKey();
  console.log("Vault owner (recovery) keypair — generated locally, never share the private line:");
  console.log(`private: ${key.privateKey}`);
  console.log(`public:  ${key.publicKey}`);
  console.log("\nGive your agent the `public:` line and your chosen cap; store the private line safely.");
  process.exit(0);
}

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);
const NODE_URL = process.env.SOMPI_NODE_URL;
const POLICY_PATH = process.env.SOMPI_POLICY;

const wallet = new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: NODE_URL });
const policy = new PolicyEngine(DATA_DIR, POLICY_PATH);

const server = new McpServer({ name: "sompi", version: packageVersion() });

// The SDK's registerTool generics overflow tsc's instantiation depth with
// zod 3.25 shapes, so registrations go through this loosely-typed wrapper.
const registerTool = (
  name: string,
  config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> },
  handler: (args: any) => Promise<unknown>
): void => {
  (server as any).registerTool(name, config, handler);
};

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, bigintSafe, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ summary: message, error: message }) }], isError: true };
}

function bigintSafe(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function packageVersion(): string {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version?: unknown };
  if (typeof raw.version !== "string" || raw.version.length === 0) throw new Error("package.json has no version");
  return raw.version;
}

function kasUnit(): "KAS" | "tKAS" {
  return NETWORK.startsWith("testnet") ? "tKAS" : "KAS";
}

function kasValue(sompi: bigint | string): string {
  return formatKas(BigInt(sompi));
}

function kasDisplay(sompi: bigint | string): string {
  return `${kasValue(sompi)} ${kasUnit()}`;
}

function amountFields(prefix: string, sompi: bigint | string): Record<string, string> {
  const value = BigInt(sompi);
  return {
    [`${prefix}Sompi`]: value.toString(),
    [`${prefix}Kas`]: kasValue(value),
    [`${prefix}Display`]: kasDisplay(value),
  };
}

function paidFetchDepositView(deposit: { txid: string; amountSompi: string; payTo: string; source: string; feeSompi?: string }) {
  return {
    ...deposit,
    amountKas: kasValue(deposit.amountSompi),
    amountDisplay: kasDisplay(deposit.amountSompi),
    feeKas: deposit.feeSompi ? kasValue(deposit.feeSompi) : undefined,
    feeDisplay: deposit.feeSompi ? kasDisplay(deposit.feeSompi) : undefined,
  };
}

function paidFetchSummary(result: {
  status: number;
  scheme?: string;
  fundingSource?: string;
  authorizedSompi?: string;
  deposit?: { amountSompi: string; source: string };
}): string {
  if (result.scheme !== "kaspa-escrow") {
    return `Fetched the URL without needing payment. HTTP status ${result.status}.`;
  }
  const authorized = result.authorizedSompi ? kasDisplay(result.authorizedSompi) : "an unknown amount";
  if (result.deposit) {
    return (
      `Fetched the paid URL using a new ${result.deposit.source}-funded escrow. ` +
      `The escrow deposit was ${kasDisplay(result.deposit.amountSompi)} and the service is authorized for ${authorized} total.`
    );
  }
  return (
    `Fetched the paid URL using the existing ${result.fundingSource ?? "escrow"} payment channel. ` +
    `No new deposit was needed; the service is authorized for ${authorized} total.`
  );
}

function policyView() {
  const p = policy.policy;
  const spent = policy.spentLastHour();
  return {
    summary: `Day-to-day policy allows up to ${kasDisplay(p.maxSompiPerTx)} per payment and ${kasDisplay(p.maxSompiPerHour)} per hour.`,
    maxSompiPerTx: p.maxSompiPerTx.toString(),
    maxKasPerTx: kasValue(p.maxSompiPerTx),
    maxPerTxDisplay: kasDisplay(p.maxSompiPerTx),
    maxSompiPerHour: p.maxSompiPerHour.toString(),
    maxKasPerHour: kasValue(p.maxSompiPerHour),
    maxPerHourDisplay: kasDisplay(p.maxSompiPerHour),
    spentLastHourSompi: spent.toString(),
    spentLastHourKas: kasValue(spent),
    spentLastHourDisplay: kasDisplay(spent),
    remainingHourSompi: p.maxSompiPerHour > spent ? (p.maxSompiPerHour - spent).toString() : "0",
    remainingHourKas: kasValue(p.maxSompiPerHour > spent ? p.maxSompiPerHour - spent : 0n),
    remainingHourDisplay: kasDisplay(p.maxSompiPerHour > spent ? p.maxSompiPerHour - spent : 0n),
    allowlist: p.allowlist,
    requireApprovalAboveSompi: p.requireApprovalAboveSompi.toString(),
    requireApprovalAboveKas: kasValue(p.requireApprovalAboveSompi),
    requireApprovalAboveDisplay:
      p.requireApprovalAboveSompi > 0n ? kasDisplay(p.requireApprovalAboveSompi) : "disabled",
  };
}

function publicEscrowChannel(channel: any, currentDaa?: bigint) {
  const deposited = BigInt(channel.depositedSompi);
  const authorized = BigInt(channel.authorizedSompi);
  const price = BigInt(channel.pricePerRequestSompi);
  const refundableEstimate = deposited > authorized ? deposited - authorized : 0n;
  const refundTimeout = BigInt(channel.refundTimeout);
  const refundAvailable = currentDaa === undefined ? undefined : currentDaa >= refundTimeout;
  const nextRequestNeedsDeposit = authorized + price >= deposited;
  return {
    origin: channel.origin,
    network: channel.network,
    escrowAddress: channel.escrowAddress,
    fundingSource: channel.fundingSource,
    fundingTxid: channel.fundingTxid,
    fundingIndex: channel.fundingIndex,
    depositedSompi: deposited.toString(),
    depositedKas: kasValue(deposited),
    depositedDisplay: kasDisplay(deposited),
    authorizedSompi: authorized.toString(),
    authorizedKas: kasValue(authorized),
    authorizedDisplay: kasDisplay(authorized),
    pricePerRequestSompi: price.toString(),
    pricePerRequestKas: kasValue(price),
    pricePerRequestDisplay: kasDisplay(price),
    refundableEstimateSompi: refundableEstimate.toString(),
    refundableEstimateKas: kasValue(refundableEstimate),
    refundableEstimateDisplay: kasDisplay(refundableEstimate),
    refundTimeoutDaa: channel.refundTimeout,
    refundAvailable,
    daaUntilRefund: currentDaa === undefined || currentDaa >= refundTimeout ? "0" : (refundTimeout - currentDaa).toString(),
    nextRequest: nextRequestNeedsDeposit ? "opens a new escrow deposit" : "reuses this escrow",
  };
}

async function paymentReadiness() {
  const blockers: string[] = [];
  const warnings: string[] = [];

  let node:
    | { network: string; isSynced: unknown; serverVersion: unknown; virtualDaaScore: string; hasUtxoIndex: unknown }
    | undefined;
  let currentDaa: bigint | undefined;
  try {
    const info = await wallet.serverInfo();
    currentDaa = BigInt(info.virtualDaaScore);
    node = {
      network: NETWORK,
      isSynced: info.isSynced,
      serverVersion: info.serverVersion,
      virtualDaaScore: info.virtualDaaScore?.toString?.() ?? String(info.virtualDaaScore),
      hasUtxoIndex: info.hasUtxoIndex,
    };
    if (info.isSynced !== true) blockers.push("The connected node is not synced.");
    if (info.hasUtxoIndex !== true) blockers.push("The connected node does not have UTXO index enabled.");
  } catch (error) {
    blockers.push(`I cannot reach a usable Kaspa node: ${String((error as Error)?.message ?? error)}`);
  }

  let regularWalletBalance: bigint | undefined;
  try {
    regularWalletBalance = await wallet.balanceSompi();
  } catch (error) {
    warnings.push(`I could not read the regular wallet balance: ${String((error as Error)?.message ?? error)}`);
  }

  let policyStatus;
  try {
    policyStatus = policyView();
  } catch (error) {
    blockers.push(`The spending policy is not readable: ${String((error as Error)?.message ?? error)}`);
  }

  let vaultStatus:
    | {
        configured: boolean;
        covenantFunded: boolean;
        balanceSompi?: string;
        balanceKas?: string;
        balanceDisplay?: string;
        unboundSompi?: string;
        unboundKas?: string;
        unboundDisplay?: string;
        maxOutflowSompi?: string;
        maxOutflowKas?: string;
        maxOutflowDisplay?: string;
        spentInWindowSompi?: string;
        spentInWindowKas?: string;
        spentInWindowDisplay?: string;
        currentOutpoint?: { txid: string; index: number };
        address?: string;
        covenantId?: string;
      }
    | undefined;
  if (!vault.configured) {
    blockers.push("The vault has not been set up yet.");
    vaultStatus = { configured: false, covenantFunded: false };
  } else {
    const config = vault.config();
    const covenantFunded = Boolean(config.covenantId);
    if (!covenantFunded) blockers.push("The vault exists but has not been funded with a covenant deposit yet.");
    try {
      const balances = await vault.balanceBreakdown(wallet);
      if (covenantFunded && balances.spendableSompi <= 0n) blockers.push("The vault has no spendable balance.");
      if (balances.unboundSompi > 0n) warnings.push("Some funds were sent directly to the vault address and are owner-recoverable only.");
      vaultStatus = {
        configured: true,
        covenantFunded,
        address: config.address,
        covenantId: config.covenantId,
        currentOutpoint: config.currentOutpoint,
        balanceSompi: balances.spendableSompi.toString(),
        balanceKas: kasValue(balances.spendableSompi),
        balanceDisplay: kasDisplay(balances.spendableSompi),
        unboundSompi: balances.unboundSompi.toString(),
        unboundKas: kasValue(balances.unboundSompi),
        unboundDisplay: kasDisplay(balances.unboundSompi),
        maxOutflowSompi: config.maxOutflowSompi,
        maxOutflowKas: kasValue(config.maxOutflowSompi),
        maxOutflowDisplay: kasDisplay(config.maxOutflowSompi),
        spentInWindowSompi: config.spentInWindowSompi,
        spentInWindowKas: kasValue(config.spentInWindowSompi),
        spentInWindowDisplay: kasDisplay(config.spentInWindowSompi),
      };
    } catch (error) {
      blockers.push(`I could not read the vault balance: ${String((error as Error)?.message ?? error)}`);
      vaultStatus = { configured: true, covenantFunded, address: config.address, covenantId: config.covenantId };
    }
  }

  const channels = x402.escrowChannels();
  const activeEscrows = channels.active.map((channel) => publicEscrowChannel(channel, currentDaa));
  const retiredEscrows = channels.retired.map((channel) => publicEscrowChannel(channel, currentDaa));
  const refundableNow = retiredEscrows.filter((channel) => channel.refundAvailable === true);
  if (refundableNow.length > 0) warnings.push(`${refundableNow.length} retired escrow channel(s) are refundable now.`);

  const ready = blockers.length === 0;
  return {
    summary: ready
      ? `Ready to pay for APIs. Vault balance is ${vaultStatus?.balanceDisplay ?? "unknown"}; ${activeEscrows.length} active escrow channel(s).`
      : `Not ready to pay yet: ${blockers[0]}`,
    status: ready ? (warnings.length > 0 ? "ready_with_warnings" : "ready") : "blocked",
    userAction: ready ? "none" : paymentStatusNextStep(blockers[0]),
    blockers,
    warnings,
    network: node,
    regularWallet: {
      address: wallet.address,
      balanceSompi: regularWalletBalance?.toString(),
      balanceKas: regularWalletBalance === undefined ? undefined : kasValue(regularWalletBalance),
      balanceDisplay: regularWalletBalance === undefined ? undefined : kasDisplay(regularWalletBalance),
    },
    vault: vaultStatus,
    policy: policyStatus,
    escrows: {
      activeCount: activeEscrows.length,
      retiredCount: retiredEscrows.length,
      refundableNowCount: refundableNow.length,
      active: activeEscrows,
      retired: retiredEscrows,
    },
  };
}

function paymentStatusNextStep(blocker?: string): string {
  if (!blocker) return "none";
  if (blocker.includes("vault has not been set up")) {
    return "Ask the operator for a vault owner public key and spending cap, then call vault_create.";
  }
  if (blocker.includes("covenant deposit")) {
    return "Fund the regular wallet, then call vault_deposit to move funds into the safer covenant vault.";
  }
  if (blocker.includes("no spendable balance")) {
    return "Top up the regular wallet, then call vault_deposit.";
  }
  if (blocker.includes("node")) {
    return "Use a synced Kaspa node with UTXO index enabled, or wait for the current node to recover.";
  }
  return "Report the blocker to the operator and do not bypass the policy or vault controls.";
}

async function guarded<T>(fn: () => Promise<T>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof PolicyViolation) return fail(e.message);
    return fail(e instanceof Error ? e.message : String(e));
  }
}

registerTool(
  "get_address",
  {
    description:
      "Get this agent's Kaspa receive address and network. Share this address to receive payments.",
  },
  async () =>
    guarded(async () => ({
      summary: `This agent receives ${kasUnit()} on ${NETWORK} at ${wallet.address}.`,
      address: wallet.address,
      network: NETWORK,
    }))
);

registerTool(
  "get_balance",
  {
    description:
      "Get the KAS balance of an address (defaults to the agent's own wallet). Returns sompi and KAS.",
    inputSchema: { address: z.string().optional().describe("Kaspa address; omit for own wallet") },
  },
  async ({ address }) =>
    guarded(async () => {
      const sompi = await wallet.balanceSompi(address);
      return {
        summary: `${address ? "That address" : "This agent's wallet"} holds ${kasDisplay(sompi)}.`,
        address: address ?? wallet.address,
        balanceSompi: sompi.toString(),
        balanceKas: kasValue(sompi),
        balanceDisplay: kasDisplay(sompi),
        sompi: sompi.toString(),
        kas: kasValue(sompi),
      };
    })
);

registerTool(
  "send_payment",
  {
    description:
      "Send KAS to a destination address, subject to the local spending policy " +
      "(per-transaction cap, rolling hourly cap, optional allowlist). " +
      "Specify the amount in sompi (1 KAS = 100,000,000 sompi) or as a KAS decimal string.",
    inputSchema: {
      to: z.string().describe("Destination Kaspa address"),
      amountSompi: z.string().optional().describe("Amount in sompi (integer string)"),
      amountKas: z.string().optional().describe("Amount in KAS (decimal string), alternative to amountSompi"),
    },
  },
  async ({ to, amountSompi, amountKas }) =>
    guarded(async () => {
      if (!amountSompi && !amountKas) throw new Error("provide amountSompi or amountKas");
      const amount = amountSompi ? BigInt(amountSompi) : parseKasToSompi(amountKas!);
      policy.authorize(to, amount);
      const { txid, feeSompi } = await wallet.send(to, amount);
      policy.record(amount);
      return {
        summary: `Sent ${kasDisplay(amount)} to ${to}. Network fee was ${kasDisplay(feeSompi)}.`,
        txid,
        to,
        ...amountFields("amount", amount),
        ...amountFields("fee", feeSompi),
        network: NETWORK,
      };
    })
);

registerTool(
  "await_payment",
  {
    description:
      "Wait for an incoming payment of at least the given amount to an address " +
      "(defaults to the agent's own address). Resolves when the payment arrives or the timeout passes.",
    inputSchema: {
      minAmountSompi: z.string().describe("Minimum amount in sompi to wait for"),
      address: z.string().optional().describe("Address to watch; omit for own wallet"),
      timeoutSeconds: z.number().int().min(1).max(600).default(120).describe("How long to wait"),
    },
  },
  async ({ minAmountSompi, address, timeoutSeconds }) =>
    guarded(async () => {
      const result = await wallet.awaitPayment(address ?? wallet.address, BigInt(minAmountSompi), timeoutSeconds * 1000);
      return {
        summary: `Received ${kasDisplay(result.receivedSompi)} at ${address ?? wallet.address}.`,
        ...amountFields("received", result.receivedSompi),
        txids: result.txids,
      };
    })
);

registerTool(
  "verify_payment",
  {
    description:
      "Verify that a transaction paid an address: checks the address's current UTXOs for outputs created by the txid.",
    inputSchema: {
      txid: z.string().describe("Transaction id to verify"),
      address: z.string().optional().describe("Receiving address; omit for own wallet"),
    },
  },
  async ({ txid, address }) =>
    guarded(async () => {
      const result = await wallet.verifyPayment(txid, address ?? wallet.address);
      return {
        summary: result.found
          ? `Transaction ${txid} paid ${kasDisplay(result.amountSompi)} to ${address ?? wallet.address}.`
          : `I could not find a current UTXO from transaction ${txid} paying ${address ?? wallet.address}.`,
        found: result.found,
        ...amountFields("amount", result.amountSompi),
      };
    })
);

registerTool(
  "estimate_fee",
  {
    description: "Get current network fee estimates (feerate buckets in sompi per gram) from the connected node.",
  },
  async () => guarded(async () => wallet.feeEstimate())
);

registerTool(
  "network_status",
  {
    description: "Get connected node status: network, sync state, virtual DAA score, server version.",
  },
  async () =>
    guarded(async () => {
      const info = await wallet.serverInfo();
      return {
        summary:
          info.isSynced === true && info.hasUtxoIndex === true
            ? `Connected to a synced ${NETWORK} node with UTXO index enabled.`
            : `Connected to ${NETWORK}, but the node is not fully ready for payments.`,
        network: NETWORK,
        isSynced: info.isSynced,
        serverVersion: info.serverVersion,
        virtualDaaScore: info.virtualDaaScore?.toString?.() ?? String(info.virtualDaaScore),
        hasUtxoIndex: info.hasUtxoIndex,
      };
    })
);

const vault = new VaultManager(DATA_DIR, NETWORK);

const x402 = new X402Client(wallet, policy, DATA_DIR, {
  requiredEscrowFundingSource: "vault",
  fundEscrowDeposit: async ({ escrowAddress, amountSompi }) => {
    if (!vault.configured) {
      throw new Error(
        "paid_fetch requires a funded covenant vault treasury. Call vault_create, fund the regular wallet, " +
          "then call vault_deposit before opening paid API escrows."
      );
    }
    const config = vault.config();
    if (!config.covenantId) {
      throw new Error("paid_fetch requires a covenant-funded vault. Call vault_deposit before opening paid API escrows.");
    }
    const result = await vault.send(wallet, escrowAddress, amountSompi);
    return { txid: result.txid, feeSompi: result.feeSompi, source: "vault" };
  },
});

registerTool(
  "payment_status",
  {
    description:
      "Answer whether this agent is ready to pay for APIs. Returns a plain-English summary, wallet/vault/policy status, " +
      "and active escrow visibility using KAS-first amounts.",
  },
  async () => guarded(async () => paymentReadiness())
);

registerTool(
  "escrow_status",
  {
    description:
      "Show active and retired paid API escrow channels. Use this when the user asks whether a future paid request " +
      "will reuse an escrow, open a new deposit, or whether anything is refundable.",
    inputSchema: {
      url: z.string().url().optional().describe("Optional paid URL to check whether its origin already has an active escrow"),
    },
  },
  async ({ url }) =>
    guarded(async () => {
      let currentDaa: bigint | undefined;
      try {
        const info = await wallet.serverInfo();
        currentDaa = BigInt(info.virtualDaaScore);
      } catch {
        currentDaa = undefined;
      }
      const origin = url ? new URL(url).origin : undefined;
      const channels = x402.escrowChannels();
      const active = channels.active.map((channel) => publicEscrowChannel(channel, currentDaa));
      const retired = channels.retired.map((channel) => publicEscrowChannel(channel, currentDaa));
      const matching = origin ? active.find((channel) => channel.origin === origin) : undefined;
      const refundableNow = retired.filter((channel) => channel.refundAvailable === true);
      const summary = origin
        ? matching
          ? `The next paid request to ${origin} will ${matching.nextRequest}.`
          : `There is no active escrow for ${origin}; the next paid request will open a new vault-funded escrow if payment is required.`
        : `${active.length} active escrow channel(s), ${retired.length} retired channel(s), ${refundableNow.length} refundable now.`;
      return {
        summary,
        status: "ok",
        checkedOrigin: origin,
        activeCount: active.length,
        retiredCount: retired.length,
        refundableNowCount: refundableNow.length,
        active,
        retired,
      };
    })
);

registerTool(
  "paid_fetch",
  {
    description:
      "Fetch a URL, automatically paying for it if the server responds with HTTP 402. " +
      "Uses trust-minimized kaspa-escrow when offered, and funds new escrow deposits from " +
      "the configured covenant vault treasury. Call vault_create and vault_deposit first. " +
      "On-chain deposits are subject to the local spending policy; subsequent requests use off-chain authorization.",
    inputSchema: {
      url: z.string().url().describe("URL to fetch"),
      method: z.string().default("GET").describe("HTTP method"),
      body: z.string().optional().describe("Request body"),
    },
  },
  async ({ url, method, body }) =>
    guarded(async () => {
      const result = await x402.paidFetch(url, { method, body });
      const deposit = result.deposit ? paidFetchDepositView(result.deposit) : undefined;
      return {
        summary: paidFetchSummary({ ...result, deposit }),
        status: result.status,
        body: result.body.length > 10_000 ? result.body.slice(0, 10_000) + "…[truncated]" : result.body,
        scheme: result.scheme,
        fundingSource: result.fundingSource,
        authorizedKas: result.authorizedSompi ? kasValue(result.authorizedSompi) : undefined,
        authorizedDisplay: result.authorizedSompi ? kasDisplay(result.authorizedSompi) : undefined,
        authorizedSompi: result.authorizedSompi,
        deposit,
      };
    })
);

registerTool(
  "vault_create",
  {
    description:
      "Create a covenant vault config whose agent spending path is capped at maxOutflowSompi " +
      "per rolling window by Kaspa consensus (not by software). The owner/recovery key belongs to your " +
      "HUMAN OPERATOR: before calling this, ask them to run `npx @elldeeone/sompi gen-owner-key` on " +
      "their own machine and give you (1) the public key, (2) the rolling window cap, and optionally " +
      "(3) the window size in DAA. Never generate or ask for the owner private key. After creation, " +
      "use vault_deposit to create the covenant-bound vault UTXO.",
    inputSchema: {
      maxOutflowSompi: z.string().optional().describe("Consensus-enforced cap per rolling window (amount + fee), in sompi — chosen by the operator"),
      windowSizeDaa: z.string().optional().describe("Rolling window size in DAA score units; default 36000, about one hour at 10 BPS"),
      ownerPublicKey: z.string().optional().describe("The operator's 32-byte x-only public key (64 hex chars); its private half stays with them"),
    },
  },
  async ({ maxOutflowSompi, windowSizeDaa, ownerPublicKey }) =>
    guarded(async () => {
      if (!ownerPublicKey || !maxOutflowSompi) {
        const policyCap = policy.policy.maxSompiPerTx;
        throw new Error(
          "Vault setup needs two things from your human operator. Relay BOTH questions clearly: " +
            "(1) Ask them to run `npx -y @elldeeone/sompi gen-owner-key` on THEIR machine and send you the " +
            "`public:` line (64 hex chars — never the private line). " +
            "(2) Ask what the vault's UNCHANGEABLE rolling-window cap should be, in sompi. Explain the two layers " +
            `when you ask: their day-to-day spending policy (currently ${policyCap} sompi per tx) stays in ` +
            "force and can be edited anytime; the vault cap is different — it is enforced by consensus " +
            "over a rolling DAA window. It must be at or above the day-to-day policy cap, and closer to it " +
            "is safer. The default windowSizeDaa is 36000 (about one hour at 10 BPS). " +
            "Then call vault_create again with ownerPublicKey and maxOutflowSompi, then use vault_deposit."
        );
      }
      const created = vault.create(BigInt(maxOutflowSompi), ownerPublicKey, windowSizeDaa ? BigInt(windowSizeDaa) : undefined);
      const policyCap = policy.policy.maxSompiPerTx;
      const cap = BigInt(maxOutflowSompi);
      const alignment =
        cap >= policyCap
          ? cap / policyCap > 10n
            ? `note for your operator: the vault window cap is ${cap / policyCap}x the day-to-day policy cap ` +
              `(${policyCap} sompi). Day-to-day nothing changes, but a key thief could drain in ` +
              `${cap}-sompi windows; keeping the two caps close is safer.`
            : "vault cap and day-to-day policy are reasonably aligned"
          : `warning: the vault cap (${cap} sompi) is BELOW the day-to-day policy cap (${policyCap} sompi) — ` +
            "withdrawals above the vault cap will be rejected by the network regardless of policy";
      return {
        ...created,
        capAlignment: alignment,
        nextStep:
          "fund this agent's regular wallet, then use vault_deposit to create the covenant-bound vault UTXO; " +
          "only the operator's key can drain the vault outside the rolling cap",
      };
    })
);

registerTool(
  "vault_deposit",
  {
    description:
      "Move KAS from this agent's regular wallet INTO its covenant vault. The first deposit creates the " +
      "genesis covenant-bound vault UTXO; later deposits merge through the current singleton vault UTXO. " +
      "Exempt from spending policy because deposits make funds more constrained. Omit amountSompi to " +
      "deposit everything except a working float.",
    inputSchema: {
      amountSompi: z.string().optional().describe("Amount in sompi; omit to deposit all but the float"),
      keepFloatSompi: z.string().default("1000000000").describe("Float to keep in the regular wallet when amountSompi is omitted (default 10 KAS)"),
    },
  },
  async ({ amountSompi, keepFloatSompi }) =>
    guarded(async () => {
      if (!vault.configured) throw new Error("no vault yet — call vault_create first");
      const balance = await wallet.balanceSompi();
      const amount = amountSompi ? BigInt(amountSompi) : "max";
      const keepFloat = BigInt(keepFloatSompi);
      if (amount !== "max" && amount <= 0n) {
        throw new Error(`nothing to deposit: wallet holds ${balance} sompi, float is ${keepFloatSompi}`);
      }
      const result = await vault.deposit(wallet, amount, amount === "max" ? keepFloat : 0n);
      return {
        txid: result.txid,
        vaultAddress: result.vaultAddress,
        covenantId: result.covenantId,
        depositedSompi: result.depositedSompi.toString(),
        depositedKas: formatKas(result.depositedSompi),
        feeSompi: result.feeSompi.toString(),
        remainingWalletFloat: formatKas(balance - result.depositedSompi - result.feeSompi),
      };
    })
);

registerTool(
  "vault_status",
  {
    description: "Show the covenant vault's current address, rolling-window state, consensus spending cap, and on-chain balance.",
  },
  async () =>
    guarded(async () => {
      if (!vault.configured) {
        return {
          configured: false,
          nextStep:
            "no vault yet — call vault_create (it will tell you what to ask your human operator for)",
        };
      }
      const config = vault.config();
      const balances = await vault.balanceBreakdown(wallet);
      return {
        configured: true,
        ...config,
        balanceSompi: balances.spendableSompi.toString(),
        balanceKas: formatKas(balances.spendableSompi),
        unboundSompi: balances.unboundSompi.toString(),
        unboundKas: formatKas(balances.unboundSompi),
        dayToDayPolicyMaxPerTxSompi: policy.policy.maxSompiPerTx.toString(),
        note:
          balances.unboundSompi > 0n
            ? "balanceSompi only counts covenant-bound funds spendable by vault_send; unboundSompi was sent directly to the vault address and is owner-recoverable only"
            : "maxOutflowSompi is the consensus-enforced rolling-window cap; the policy cap governs normal operation and remains editable",
      };
    })
);

registerTool(
  "vault_send",
  {
    description:
      "Withdraw from the covenant vault via the consensus-capped agent path. Also passes through the " +
      "local spending policy (defense in depth). Change advances to the vault's next state/address automatically. " +
      'The fee is estimated from the node; pass amountSompi "max" to send the largest amount the current window allows.',
    inputSchema: {
      to: z.string().describe("Destination Kaspa address"),
      amountSompi: z.string().describe('Amount in sompi, or "max" for the largest cap-compliant amount'),
    },
  },
  async ({ to, amountSompi }) =>
    guarded(async () => {
      const amount = amountSompi === "max" ? ("max" as const) : BigInt(amountSompi);
      const result = await vault.send(wallet, to, amount, (resolved) => policy.authorize(to, resolved));
      policy.record(result.amountSompi);
      return {
        txid: result.txid,
        to,
        amountSompi: result.amountSompi.toString(),
        amountKas: formatKas(result.amountSompi),
        feeSompi: result.feeSompi.toString(),
        enforcement: "consensus (covenant) + local policy",
      };
    })
);

registerTool(
  "get_policy",
  {
    description:
      "Show the active spending policy (read-only): per-transaction cap, hourly cap, current hourly spend, allowlist. " +
      "The policy belongs to your human operator: never edit the policy file or bypass these tools to get around " +
      "a limit — when something is blocked, report it to your operator and let them decide.",
  },
  async () => guarded(async () => policy.describe())
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; all diagnostics go to stderr.
  console.error(`sompi MCP server ready: network=${NETWORK} address=${wallet.address}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
