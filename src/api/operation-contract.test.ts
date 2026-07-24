import assert from "node:assert/strict";
import test from "node:test";

import {
  POLICY_CHANGE_CREATE_REQUEST_SCHEMA,
  POLICY_CHANGE_VIEW_SCHEMA,
  PURCHASE_CREATE_REQUEST_SCHEMA,
  PURCHASE_VIEW_SCHEMA,
  TRANSFER_CREATE_REQUEST_SCHEMA,
  TRANSFER_VIEW_SCHEMA,
  VAULT_MIGRATION_CREATE_REQUEST_SCHEMA,
  VAULT_MIGRATION_VIEW_SCHEMA,
  WALLET_ACTIVITY_SCHEMA,
  WALLET_TECHNICAL_VIEW_SCHEMA,
  WALLET_VIEW_SCHEMA,
  type SompiApplication,
} from "./contracts.js";
import {
  SOMPI_OPERATIONS,
  buildSompiOperationRequest,
  invokeResolvedSompiOperation,
  resolveSompiOperation,
  sompiArazzoOperationReference,
  type SompiOperationId,
} from "./operation-contract.js";
import type { PurchaseView } from "../purchase/types.js";
import type { TransferView } from "../transfer/types.js";
import type { WalletView } from "../wallet-view/module.js";

const PURCHASE_ID = "pur_0123456789ABCDEFGHIJKL";
const TRANSFER_ID = "trf_0123456789ABCDEFGHIJKL";
const POLICY_CHANGE_ID = "pcg_0123456789ABCDEFGHIJKL";
const VAULT_MIGRATION_ID = "vmg_0123456789ABCDEFGHIJKL";
const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";

const CASES: readonly Readonly<{
  operationId: SompiOperationId;
  applicationMethod: keyof SompiApplication;
  method: "GET" | "POST";
  pathTemplate: string;
  pathname: string;
  audiences: readonly ("agent" | "operator-recovery")[];
  lane: "mutation" | "control";
  requestSchemaName?: string;
  requestSchema?: object;
  responseSchemaName: string;
  responseSchema: object;
  input: unknown;
}>[] = [
  {
    operationId: "createPurchase",
    applicationMethod: "purchase",
    method: "POST",
    pathTemplate: "/purchases",
    pathname: "/purchases",
    audiences: ["agent"],
    lane: "mutation",
    requestSchemaName: "PurchaseCreateRequest",
    requestSchema: PURCHASE_CREATE_REQUEST_SCHEMA,
    responseSchemaName: "PurchaseView",
    responseSchema: PURCHASE_VIEW_SCHEMA,
    input: { requestKey: "catalog:purchase", url: "https://merchant.example/resource" },
  },
  {
    operationId: "getPurchase",
    applicationMethod: "status",
    method: "GET",
    pathTemplate: "/purchases/{purchaseId}",
    pathname: `/purchases/${PURCHASE_ID}`,
    audiences: ["agent", "operator-recovery"],
    lane: "control",
    responseSchemaName: "PurchaseView",
    responseSchema: PURCHASE_VIEW_SCHEMA,
    input: { purchaseId: PURCHASE_ID },
  },
  {
    operationId: "recoverPurchase",
    applicationMethod: "recover",
    method: "POST",
    pathTemplate: "/purchases/{purchaseId}/recover",
    pathname: `/purchases/${PURCHASE_ID}/recover`,
    audiences: ["agent", "operator-recovery"],
    lane: "control",
    responseSchemaName: "PurchaseView",
    responseSchema: PURCHASE_VIEW_SCHEMA,
    input: { purchaseId: PURCHASE_ID },
  },
  {
    operationId: "getWallet",
    applicationMethod: "wallet",
    method: "GET",
    pathTemplate: "/wallet",
    pathname: "/wallet",
    audiences: ["agent"],
    lane: "control",
    responseSchemaName: "WalletView",
    responseSchema: WALLET_VIEW_SCHEMA,
    input: undefined,
  },
  {
    operationId: "listWalletActivity",
    applicationMethod: "activity",
    method: "GET",
    pathTemplate: "/wallet/activity",
    pathname: "/wallet/activity?limit=20",
    audiences: ["agent"],
    lane: "control",
    responseSchemaName: "WalletActivity",
    responseSchema: WALLET_ACTIVITY_SCHEMA,
    input: { limit: 20 },
  },
  {
    operationId: "getWalletTechnical",
    applicationMethod: "walletTechnical",
    method: "GET",
    pathTemplate: "/wallet/technical",
    pathname: "/wallet/technical",
    audiences: ["agent"],
    lane: "control",
    responseSchemaName: "WalletTechnicalView",
    responseSchema: WALLET_TECHNICAL_VIEW_SCHEMA,
    input: undefined,
  },
  {
    operationId: "createTransfer",
    applicationMethod: "transfer",
    method: "POST",
    pathTemplate: "/transfers",
    pathname: "/transfers",
    audiences: ["agent"],
    lane: "mutation",
    requestSchemaName: "TransferCreateRequest",
    requestSchema: TRANSFER_CREATE_REQUEST_SCHEMA,
    responseSchemaName: "TransferView",
    responseSchema: TRANSFER_VIEW_SCHEMA,
    input: { requestKey: "catalog:transfer", destination: ADDRESS, amountKas: "0.00001" },
  },
  {
    operationId: "getTransfer",
    applicationMethod: "transferStatus",
    method: "GET",
    pathTemplate: "/transfers/{transferId}",
    pathname: `/transfers/${TRANSFER_ID}`,
    audiences: ["agent", "operator-recovery"],
    lane: "control",
    responseSchemaName: "TransferView",
    responseSchema: TRANSFER_VIEW_SCHEMA,
    input: { transferId: TRANSFER_ID },
  },
  {
    operationId: "recoverTransfer",
    applicationMethod: "transferRecover",
    method: "POST",
    pathTemplate: "/transfers/{transferId}/recover",
    pathname: `/transfers/${TRANSFER_ID}/recover`,
    audiences: ["agent", "operator-recovery"],
    lane: "control",
    responseSchemaName: "TransferView",
    responseSchema: TRANSFER_VIEW_SCHEMA,
    input: { transferId: TRANSFER_ID },
  },
  {
    operationId: "createPolicyChange",
    applicationMethod: "changePolicy",
    method: "POST",
    pathTemplate: "/policy-changes",
    pathname: "/policy-changes",
    audiences: ["agent"],
    lane: "mutation",
    requestSchemaName: "PolicyChangeCreateRequest",
    requestSchema: POLICY_CHANGE_CREATE_REQUEST_SCHEMA,
    responseSchemaName: "PolicyChangeView",
    responseSchema: POLICY_CHANGE_VIEW_SCHEMA,
    input: {
      requestKey: "catalog:policy",
      maximumPerPaymentKas: "1",
      maximumPerHourKas: "2",
    },
  },
  {
    operationId: "getPolicyChange",
    applicationMethod: "policyChangeStatus",
    method: "GET",
    pathTemplate: "/policy-changes/{policyChangeId}",
    pathname: `/policy-changes/${POLICY_CHANGE_ID}`,
    audiences: ["agent"],
    lane: "control",
    responseSchemaName: "PolicyChangeView",
    responseSchema: POLICY_CHANGE_VIEW_SCHEMA,
    input: { policyChangeId: POLICY_CHANGE_ID },
  },
  {
    operationId: "recoverPolicyChange",
    applicationMethod: "policyChangeRecover",
    method: "POST",
    pathTemplate: "/policy-changes/{policyChangeId}/recover",
    pathname: `/policy-changes/${POLICY_CHANGE_ID}/recover`,
    audiences: ["agent", "operator-recovery"],
    lane: "control",
    responseSchemaName: "PolicyChangeView",
    responseSchema: POLICY_CHANGE_VIEW_SCHEMA,
    input: { policyChangeId: POLICY_CHANGE_ID },
  },
  {
    operationId: "createVaultMigration",
    applicationMethod: "vaultMigration",
    method: "POST",
    pathTemplate: "/vault-migrations",
    pathname: "/vault-migrations",
    audiences: ["agent"],
    lane: "mutation",
    requestSchemaName: "VaultMigrationCreateRequest",
    requestSchema: VAULT_MIGRATION_CREATE_REQUEST_SCHEMA,
    responseSchemaName: "VaultMigrationView",
    responseSchema: VAULT_MIGRATION_VIEW_SCHEMA,
    input: { requestKey: "catalog:vault", vaultProtectionMaximumKas: "10" },
  },
  {
    operationId: "getVaultMigration",
    applicationMethod: "vaultMigrationStatus",
    method: "GET",
    pathTemplate: "/vault-migrations/{vaultMigrationId}",
    pathname: `/vault-migrations/${VAULT_MIGRATION_ID}`,
    audiences: ["agent"],
    lane: "control",
    responseSchemaName: "VaultMigrationView",
    responseSchema: VAULT_MIGRATION_VIEW_SCHEMA,
    input: { vaultMigrationId: VAULT_MIGRATION_ID },
  },
];

test("closed operation catalog owns all fourteen canonical operation facts", () => {
  assert.equal(SOMPI_OPERATIONS.length, 14);
  assert.equal(new Set(SOMPI_OPERATIONS.map(({ operationId }) => operationId)).size, 14);
  assert.equal(
    new Set(SOMPI_OPERATIONS.map(({ method, pathTemplate }) => `${method} ${pathTemplate}`)).size,
    14,
  );
  assert.deepEqual(
    SOMPI_OPERATIONS.filter(({ requestSchema }) => requestSchema !== undefined)
      .map(({ operationId }) => operationId),
    [
      "createPurchase",
      "createTransfer",
      "createPolicyChange",
      "createVaultMigration",
    ],
  );

  for (const expected of CASES) {
    const operation = SOMPI_OPERATIONS.find(
      ({ operationId }) => operationId === expected.operationId,
    );
    assert.ok(operation);
    assert.equal(operation.applicationMethod, expected.applicationMethod);
    assert.equal(operation.method, expected.method);
    assert.equal(operation.pathTemplate, expected.pathTemplate);
    assert.deepEqual(operation.audiences, expected.audiences);
    assert.equal(operation.lane, expected.lane);
    assert.equal(operation.requestSchemaName, expected.requestSchemaName);
    assert.equal(operation.requestSchema, expected.requestSchema);
    assert.equal(operation.responseSchemaName, expected.responseSchemaName);
    assert.equal(operation.responseSchema, expected.responseSchema);
    assert.equal(
      sompiArazzoOperationReference(expected.operationId),
      `$sourceDescriptions.sompi.${expected.operationId}`,
    );
    const request = buildRequest(expected.operationId, expected.input);
    assert.equal(request.method, expected.method);
    assert.equal(request.pathname, expected.pathname);
    assert.equal(request.body === undefined, operation.requestSchema === undefined);
  }
});

test("the same catalog resolves, invokes, and validates every HTTP operation", async () => {
  const calls: string[] = [];
  const application = fakeApplication(calls);
  for (const expected of CASES) {
    const request = buildRequest(expected.operationId, expected.input);
    const resolution = resolveSompiOperation(
      request.method,
      request.pathname,
      "agent",
    );
    assert.equal(resolution.kind, "operation");
    if (resolution.kind !== "operation") continue;
    assert.equal(resolution.operation.operationId, expected.operationId);
    await invokeResolvedSompiOperation(
      application,
      resolution,
      request.body,
      new AbortController().signal,
    );
  }
  assert.deepEqual(calls, CASES.map(({ applicationMethod }) => applicationMethod));
});

test("catalog resolution preserves the recovery audience and route failures", () => {
  const recoveryOperations = new Set<SompiOperationId>([
    "getPurchase",
    "recoverPurchase",
    "getTransfer",
    "recoverTransfer",
    "recoverPolicyChange",
  ]);
  for (const expected of CASES) {
    const request = buildRequest(expected.operationId, expected.input);
    const resolution = resolveSompiOperation(
      request.method,
      request.pathname,
      "operator-recovery",
    );
    assert.equal(
      resolution.kind === "operation",
      recoveryOperations.has(expected.operationId),
      expected.operationId,
    );
  }
  assert.equal(resolveSompiOperation("POST", "/wallet", "agent").kind, "method-not-allowed");
  assert.equal(resolveSompiOperation("GET", "/unknown", "agent").kind, "not-found");
  assert.equal(resolveSompiOperation("GET", "/wallet?extra=1", "agent").kind, "invalid-target");
  assert.equal(resolveSompiOperation("GET", "/wallet/%2e", "agent").kind, "invalid-target");
});

test("catalog request and response validators fail closed", () => {
  assert.throws(
    () => buildRequest("listWalletActivity", { limit: 101 }),
    /between 1 and 100/,
  );
  assert.throws(
    () => buildRequest("getTransfer", { transferId: "trf_invalid" }),
    /Transfer ID is invalid/,
  );
  assert.throws(
    () => buildRequest("createPurchase", {
      requestKey: "catalog:invalid",
      url: "https://user:secret@merchant.example/",
    }),
    /canonical HTTP/,
  );
  const request = buildRequest("getPurchase", { purchaseId: PURCHASE_ID });
  assert.throws(() => request.assertResponse({}), /Purchase response/);
});

function buildRequest(operationId: SompiOperationId, input: unknown) {
  return buildSompiOperationRequest(operationId, input as never);
}

function fakeApplication(calls: string[]): SompiApplication {
  const called = <T>(name: keyof SompiApplication, value: T): T => {
    calls.push(name);
    return value;
  };
  return {
    async purchase() { return called("purchase", fakePurchase()); },
    async status() { return called("status", fakePurchase()); },
    async recover() { return called("recover", fakePurchase()); },
    async wallet() { return called("wallet", fakeWallet()); },
    async walletTechnical() { return called("walletTechnical", fakeWalletTechnical()); },
    async activity() { return called("activity", []); },
    async transfer() { return called("transfer", fakeTransfer()); },
    async transferStatus() { return called("transferStatus", fakeTransfer()); },
    async transferRecover() { return called("transferRecover", fakeTransfer()); },
    async changePolicy() { return called("changePolicy", fakePolicyChange()); },
    async policyChangeStatus() {
      return called("policyChangeStatus", fakePolicyChange());
    },
    async policyChangeRecover() {
      return called("policyChangeRecover", fakePolicyChange());
    },
    async vaultMigration() { return called("vaultMigration", fakeVaultMigration()); },
    async vaultMigrationStatus() {
      return called("vaultMigrationStatus", fakeVaultMigration());
    },
  };
}

function fakePurchase(): PurchaseView {
  return {
    id: PURCHASE_ID as PurchaseView["id"],
    requestKey: "catalog:purchase" as PurchaseView["requestKey"],
    state: "created",
    summary: "Purchase created.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "not_requested" },
    treasury: { status: "unreserved" },
    paymentAttempts: [],
    receiptEvidence: [],
  };
}

function fakeTransfer(): TransferView {
  return {
    id: TRANSFER_ID,
    requestKey: "catalog:transfer",
    requestDigest: `sha256:${"B".repeat(43)}`,
    state: "created",
    summary: "Transfer request recorded.",
    display: {
      amount: amount("1000"),
      feeCeiling: amount("100"),
      maximumTotal: amount("1100"),
    },
    destination: ADDRESS,
    amountAtomic: "1000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    sourceVaultAddress: ADDRESS,
    sourceVaultDigest: `sha256:${"C".repeat(43)}`,
    feeCeilingAtomic: "100",
    maximumTotalAtomic: "1100",
    expiresAtMs: 2_000_000_000_000,
    policyDigest: `sha256:${"D".repeat(43)}`,
    manifestRevision: 1,
    manifestDigest: `sha256:${"E".repeat(43)}`,
    finalityFloor: "accepted",
    version: 0,
    createdAtMs: 1_900_000_000_000,
    updatedAtMs: 1_900_000_000_000,
    recoveryRequired: false,
    safeToRetry: true,
    userAction: "none",
  };
}

function fakeWallet(): WalletView {
  return {
    network: "kaspa:testnet-10",
    asset: "KAS",
    receive: {
      address: ADDRESS,
      qrPayload: ADDRESS,
      networkLabel: "Kaspa Testnet-10",
      warning: "Testnet funds only — do not send mainnet KAS.",
    },
    balance: {
      total: amount("10000"),
      available: amount("10000"),
      incoming: amount("0"),
      pending: amount("0"),
      provenance: "operator-node-and-local-vault-lineage",
      observedAt: "2030-01-01T00:00:00.000Z",
    },
    securing: {
      automatic: true,
      state: "idle",
      summary: "No incoming funds are waiting to be secured.",
      userAction: "none",
      minimumAmount: amount("101"),
    },
    spendingProtection: {
      maximumPerPayment: amount("1000"),
      maximumPerHour: amount("5000"),
      everyPaymentRequiresApproval: true,
      vaultProtection: {
        maximumPerWindow: amount("5000"),
        remainingInWindow: amount("5000"),
        window: "approximately 1 hour",
        summary: "Protected.",
      },
    },
    chainStatus: "observed",
  };
}

function fakeWalletTechnical() {
  return {
    receiveAddress: ADDRESS,
    activeVault: {
      address: ADDRESS,
      maximumOutflowAtomic: "1000000000",
      windowSizeDaa: "36000",
      windowStartDaa: "0",
      spentInWindowAtomic: "0",
    },
    allowlist: [],
  } as const;
}

function fakePolicyChange() {
  return {
    id: POLICY_CHANGE_ID,
    requestKey: "catalog:policy",
    state: "applied",
    summary: "Spending limits updated. Every payment still requires your approval.",
    previous: {
      maximumPerPayment: amount("1000"),
      maximumPerHour: amount("5000"),
    },
    proposed: {
      maximumPerPayment: amount("2000"),
      maximumPerHour: amount("6000"),
    },
    vaultProtectionMaximum: amount("10000"),
    everyPaymentRequiresApproval: true,
    expiresAt: "2030-01-01T00:00:00.000Z",
    appliedPolicyDigest: `sha256:${"F".repeat(43)}`,
    appliedPolicyVersion: 2,
  } as const;
}

function fakeVaultMigration() {
  return {
    id: VAULT_MIGRATION_ID,
    requestKey: "catalog:vault",
    state: "awaiting_owner",
    summary: "Vault protection change approved. Finish it with the offline owner key.",
    userAction: "Ask the operator to finish the protected vault update locally.",
    previousVaultProtectionMaximum: amount("10000"),
    proposedVaultProtectionMaximum: amount("20000"),
    receiveAddressUnchanged: true,
    requiresOfflineOwnerKey: true,
    expiresAt: "2030-01-01T00:00:00.000Z",
  } as const;
}

function amount(atomic: string) {
  const kas = atomic === "0" ? "0" : `0.${atomic.padStart(8, "0").replace(/0+$/, "")}`;
  return { atomic, kas, unit: "tKAS" as const, display: `${kas} tKAS` };
}
