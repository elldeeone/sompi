import * as assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { assertPurchaseRequestKey, createPurchaseId, evidenceDigest } from "../purchase/identity.js";
import type { PurchaseModule, PurchaseView } from "../purchase/types.js";
import type { SompiPurchaseRuntime } from "../runtime/purchase-runtime.js";
import type { TreasuryOperationModule, TreasuryOperationView } from "../treasury/operations.js";
import {
  createSompiMcpServer,
  registerSompiTools,
  type McpToolRegistrar,
  type McpToolResult,
} from "./server.js";

const EXPECTED_TOOLS = [
  "await_payment",
  "estimate_fee",
  "get_address",
  "get_balance",
  "get_policy",
  "network_status",
  "payment_status",
  "purchase",
  "purchase_admission_status",
  "purchase_recover",
  "purchase_status",
  "send_payment",
  "treasury_operation_cancel",
  "treasury_operation_recover",
  "treasury_operation_status",
  "vault_deposit",
  "vault_send",
  "vault_status",
  "verify_payment",
] as const;

test("MCP registration exposes only direct treasury and stable Purchase tools", () => {
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, fakeRuntime(), fakeTreasuryOperations());

  assert.deepEqual([...registrar.tools.keys()].sort(), EXPECTED_TOOLS);
  assert.equal(registrar.tools.has("paid_fetch"), false);
  assert.equal(registrar.tools.has("escrow_status"), false);
  assert.equal(registrar.tools.has("escrow_refund"), false);
  assert.equal(registrar.tools.has("vault_create"), false);
});

test("MCP registration fails closed outside testnet-10", () => {
  const runtime = fakeRuntime();
  Object.defineProperty(runtime.wallet, "networkId", { value: "mainnet" });
  assert.throws(
    () => registerSompiTools(new CapturingRegistrar(), runtime, fakeTreasuryOperations()),
    /only testnet-10/
  );
});

test("real MCP transport lists and calls the cutover surface", async () => {
  const server = createSompiMcpServer(fakeRuntime(), "test", fakeTreasuryOperations());
  const client = new Client({ name: "sompi-mcp-test", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      EXPECTED_TOOLS
    );
    const called = await client.callTool({ name: "get_address", arguments: {} });
    const content = (called as { content?: unknown }).content;
    assert.ok(Array.isArray(content));
    const block = content[0] as { type?: unknown; text?: unknown } | undefined;
    assert.equal(block?.type, "text");
    assert.equal(
      JSON.parse(block?.type === "text" && typeof block.text === "string" ? block.text : "{}").network,
      "testnet-10"
    );
    const mainnetDenied = await client.callTool({
      name: "get_balance",
      arguments: { address: `kaspa:${"q".repeat(61)}` },
    });
    assert.equal(mainnetDenied.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Purchase MCP handler calls the stable module and whitelists public fields", async () => {
  const calls: unknown[] = [];
  const expected = fakePurchaseView() as PurchaseView & { authorityPrivateKey: string };
  expected.authorityPrivateKey = "must-never-cross-mcp";
  const runtime = fakeRuntime({
    purchase: {
      async purchase(intent) {
        calls.push(intent);
        return expected;
      },
      async status() {
        return expected;
      },
      async recover() {
        return expected;
      },
    },
  });
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, runtime, fakeTreasuryOperations());

  const result = await registrar.call("purchase", {
    requestKey: "mcp:purchase:one",
    url: "https://merchant.example/resource",
    method: "GET",
  });
  const payload = parseResult(result);
  assert.equal(result.isError, undefined);
  assert.equal(payload.id, expected.id);
  assert.equal(payload.authorityPrivateKey, undefined);
  assert.equal(result.content[0].text.includes("must-never-cross-mcp"), false);
  assert.equal(calls.length, 1);
});

test("unexpected lower-layer errors are bounded and secret-free", async () => {
  const runtime = fakeRuntime();
  (runtime.wallet as any).balanceSompi = async () => {
    throw new Error(`private-key=${"a".repeat(5_000)}`);
  };
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, runtime, fakeTreasuryOperations());

  const result = await registrar.call("get_balance", {});
  const payload = parseResult(result);
  assert.equal(result.isError, true);
  assert.equal(payload.errorCode, "BALANCE_LOOKUP_FAILED");
  assert.equal(result.content[0].text.includes("private-key"), false);
  assert.ok(Buffer.byteLength(result.content[0].text) < 1_000);
});

test("Purchase protocol failures expose no keys, mandates, payment headers, prepared bytes, or raw exceptions", async () => {
  const forbidden = [
    "AUTHORITY_PRIVATE_JWK_D_VALUE",
    "MANDATE_SD_JWT_ARTIFACT",
    "PAYMENT-REQUIRED: PRIVATE_REQUIREMENTS",
    "PAYMENT-SIGNATURE: PRIVATE_PAYMENT_PAYLOAD",
    "PAYMENT-RESPONSE: PRIVATE_SETTLEMENT",
    "PREPARED_KASPA_TRANSACTION_SAFE_JSON",
    "RAW_PROTOCOL_EXCEPTION_STACK",
  ] as const;
  const protocolFailure = Object.assign(
    new Error(forbidden.join(" | ")),
    {
      authorityPrivateJwk: { d: forbidden[0] },
      mandateArtifact: forbidden[1],
      paymentHeaders: forbidden.slice(2, 5),
      preparedTransaction: Buffer.from(forbidden[5], "utf8"),
      rawProtocolException: forbidden[6],
    },
  );
  protocolFailure.stack = `${forbidden[6]}\n${forbidden.join("\n")}`;
  const failingPurchase: PurchaseModule = {
    async purchase() {
      throw protocolFailure;
    },
    async status() {
      throw protocolFailure;
    },
    async recover() {
      throw protocolFailure;
    },
  };
  const registrar = new CapturingRegistrar();
  registerSompiTools(
    registrar,
    fakeRuntime({ purchase: failingPurchase }),
    fakeTreasuryOperations(),
  );

  const originalConsoleError = console.error;
  const originalStderrWrite = process.stderr.write;
  let logs = "";
  console.error = (...values: unknown[]) => {
    logs += `${values.map(String).join(" ")}\n`;
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  let results: readonly McpToolResult[];
  try {
    const purchaseId = fakePurchaseView().id;
    results = await Promise.all([
      registrar.call("purchase", {
        requestKey: "mcp:purchase:secret-boundary",
        url: "https://merchant.example/resource",
        method: "GET",
      }),
      registrar.call("purchase_status", { purchaseId }),
      registrar.call("purchase_recover", { purchaseId }),
    ]);
  } finally {
    console.error = originalConsoleError;
    process.stderr.write = originalStderrWrite;
  }

  assert.deepEqual(
    results.map((result) => parseResult(result).errorCode),
    ["PURCHASE_FAILED", "PURCHASE_STATUS_FAILED", "PURCHASE_RECOVERY_FAILED"],
  );
  const publicSnapshot = JSON.stringify(results);
  assert.ok(Buffer.byteLength(publicSnapshot, "utf8") < 3_000);
  assert.equal(logs, "", "MCP handlers must not log lower-layer protocol exceptions");
  for (const sentinel of forbidden) {
    assert.equal(publicSnapshot.includes(sentinel), false, `MCP result leaked ${sentinel}`);
    assert.equal(logs.includes(sentinel), false, `MCP logs leaked ${sentinel}`);
  }
});

test("payment_status reports the Purchase Journal and contains no escrow state", async () => {
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, fakeRuntime(), fakeTreasuryOperations());

  const result = await registrar.call("payment_status", {});
  const payload = parseResult(result);
  assert.equal(result.isError, undefined);
  assert.equal(payload.status, "ready");
  assert.equal(payload.purchaseJournal.integrity, "ok");
  assert.equal(payload.purchaseJournal.recoverableEffectCount, 0);
  assert.equal(payload.treasuryOperationJournal.integrity, "ok");
  assert.equal(payload.treasuryOperationJournal.unresolvedOperationCount, 0);
  assert.equal(payload.escrows, undefined);
  assert.equal(result.content[0].text.includes("escrow"), false);
});

test("direct mutation tools require stable keys and call only the durable Treasury module", async () => {
  const calls: unknown[] = [];
  const operations = fakeTreasuryOperations({
    async execute(request) {
      calls.push(request);
      return fakeTreasuryOperationView(request.operationKey, request.kind);
    },
  });
  const runtime = fakeRuntime();
  (runtime.wallet as any).send = async () => {
    throw new Error("unsafe wallet mutation must not be called");
  };
  (runtime.vault as any).send = async () => {
    throw new Error("unsafe vault mutation must not be called");
  };
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, runtime, operations);

  const wallet = await registrar.call("send_payment", {
    operationKey: "direct:mcp:wallet:1",
    to: "kaspatest:merchant",
    amountSompi: "100",
  });
  const vault = await registrar.call("vault_send", {
    operationKey: "direct:mcp:vault:1",
    to: "kaspatest:merchant",
    amountSompi: "100",
  });
  const deposit = await registrar.call("vault_deposit", {
    operationKey: "direct:mcp:deposit:1",
    amountSompi: "100",
  });
  assert.equal(wallet.isError, undefined);
  assert.equal(vault.isError, undefined);
  assert.equal(deposit.isError, undefined);
  assert.deepEqual(calls, [
    {
      operationKey: "direct:mcp:wallet:1",
      kind: "wallet_send",
      destination: "kaspatest:merchant",
      amountAtomic: "100",
    },
    {
      operationKey: "direct:mcp:vault:1",
      kind: "vault_send",
      destination: "kaspatest:merchant",
      amountAtomic: "100",
    },
    {
      operationKey: "direct:mcp:deposit:1",
      kind: "vault_deposit",
      destination: "kaspatest:qpublicvault",
      amountAtomic: "100",
    },
  ]);
});

test("mutation tools fail closed when durable Treasury composition is absent", async () => {
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, fakeRuntime());
  const result = await registrar.call("send_payment", {
    operationKey: "direct:mcp:missing",
    to: "kaspatest:merchant",
    amountSompi: "1",
  });
  assert.equal(result.isError, true);
  assert.equal(parseResult(result).errorCode, "TREASURY_OPERATIONS_UNAVAILABLE");
});

class CapturingRegistrar implements McpToolRegistrar {
  readonly tools = new Map<
    string,
    {
      readonly config: Parameters<McpToolRegistrar["registerTool"]>[1];
      readonly handler: (args: any) => Promise<McpToolResult>;
    }
  >();

  registerTool(
    name: string,
    config: Parameters<McpToolRegistrar["registerTool"]>[1],
    handler: (args: any) => Promise<McpToolResult>
  ): void {
    assert.equal(this.tools.has(name), false, `duplicate tool ${name}`);
    this.tools.set(name, { config, handler });
  }

  async call(name: string, args: unknown): Promise<McpToolResult> {
    const tool = this.tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.handler(args);
  }
}

function fakeRuntime(options: { purchase?: PurchaseModule } = {}): SompiPurchaseRuntime {
  const view = fakePurchaseView();
  const purchase: PurchaseModule = options.purchase ?? {
    async purchase() {
      return view;
    },
    async status() {
      return view;
    },
    async recover() {
      return view;
    },
  };
  return {
    purchase,
    wallet: {
      networkId: "testnet-10",
      address: "kaspatest:qpublicwallet",
      async balanceSompi() {
        return 900_000_000n;
      },
      async send() {
        return { txid: "1".repeat(64), feeSompi: 10_000n };
      },
      async awaitPayment() {
        return { receivedSompi: 1n, txids: ["2".repeat(64)] };
      },
      async verifyPayment() {
        return { found: true, amountSompi: 1n };
      },
      async feeEstimate() {
        return {
          estimate: {
            priorityBucket: { feerate: 3, estimatedSeconds: 1 },
            normalBuckets: [{ feerate: 2, estimatedSeconds: 30 }],
            lowBuckets: [{ feerate: 1, estimatedSeconds: 3_600 }],
          },
        };
      },
      async serverInfo() {
        return {
          isSynced: true,
          hasUtxoIndex: true,
          virtualDaaScore: 12_345n,
          serverVersion: "test-node",
        };
      },
    },
    vault: {
      configured: true,
      config() {
        return {
          template: "sompi-vault-v1",
          agentPublic: "a".repeat(64),
          ownerPublic: "b".repeat(64),
          maxOutflowSompi: "100000000",
          windowSizeDaa: "36000",
          windowStartDaa: "0",
          spentInWindowSompi: "0",
          address: "kaspatest:qpublicvault",
          covenantId: "c".repeat(64),
          currentOutpoint: { txid: "d".repeat(64), index: 1 },
        };
      },
      async balanceBreakdown() {
        return { spendableSompi: 500_000_000n, unboundSompi: 0n };
      },
      create() {
        throw new Error("not used");
      },
      async deposit() {
        throw new Error("not used");
      },
      async send() {
        throw new Error("not used");
      },
    },
    policy: {
      policy: {
        maxSompiPerTx: 100_000_000n,
        maxSompiPerHour: 500_000_000n,
        allowlist: [],
        requireApprovalAboveSompi: 0n,
      },
      spentLastHour() {
        return 0n;
      },
      authorize() {},
      record() {},
    },
    journal: {
      integrityCheck() {
        return true;
      },
      admissionStatus() {
        return {
          prevalidationPurchases: { used: 0, budget: 128, saturated: false },
          evidenceBytes: { used: 0, reserved: 0, budget: 67_108_864, saturated: false },
        };
      },
      recoverableEffects() {
        return [];
      },
    },
    close() {},
  } as unknown as SompiPurchaseRuntime;
}

function fakeTreasuryOperations(
  overrides: Partial<Pick<TreasuryOperationModule, "execute" | "status" | "recover">> = {}
): TreasuryOperationModule {
  return {
    async execute(request: {
      operationKey: string;
      kind: "wallet_send" | "vault_send" | "vault_deposit";
    }) {
      return fakeTreasuryOperationView(request.operationKey, request.kind);
    },
    status(operationKey: string) {
      return fakeTreasuryOperationView(operationKey, "wallet_send");
    },
    async recover(operationKey: string) {
      return fakeTreasuryOperationView(operationKey, "wallet_send");
    },
    async cancel(operationKey: string) {
      return fakeTreasuryOperationView(operationKey, "wallet_send");
    },
    spentLastHour() {
      return 0n;
    },
    effectiveCapacityUsed() {
      return 0n;
    },
    integrityCheck() {
      return true as const;
    },
    unresolvedCount() {
      return 0;
    },
    ...overrides,
  } as unknown as TreasuryOperationModule;
}

function fakeTreasuryOperationView(
  operationKey: string,
  kind: "wallet_send" | "vault_send" | "vault_deposit"
): TreasuryOperationView {
  return {
    operationKey,
    kind,
    state: "completed",
    summary: `Treasury operation ${operationKey} completed.`,
    destination: "kaspatest:merchant",
    requestedAmountAtomic: "100",
    feeCeilingAtomic: "20",
    amountAtomic: "100",
    feeAtomic: "10",
    transactionId: "e".repeat(64),
    retryCount: 0,
    recoveryRequired: false,
    safeToRetry: false,
    cancellationRequested: false,
    preparationFenced: false,
  };
}

function fakePurchaseView(): PurchaseView {
  return {
    id: createPurchaseId(new Uint8Array(16).fill(4)),
    requestKey: assertPurchaseRequestKey("mcp:purchase:one"),
    state: "created",
    summary: "Purchase request recorded.",
    resourceFingerprint: evidenceDigest("resource"),
    authorization: { status: "not_requested" },
    treasury: { status: "unreserved" },
    paymentAttempts: [],
    receiptEvidence: [],
  };
}

function parseResult(result: McpToolResult): any {
  return JSON.parse(result.content[0].text);
}
