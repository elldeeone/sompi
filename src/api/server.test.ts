import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  generateAgentApiCredential,
  generateRecoveryApiCredential,
  type AgentApiCredential,
} from "./credential.js";
import type { SompiApplication } from "./contracts.js";
import {
  startSompiApiServer,
  startSompiRecoveryApiServer,
  type SompiApiServerOptions,
  type RunningSompiApiServer,
} from "./server.js";
import type { PurchaseView } from "../purchase/types.js";
import {
  SOMPI_OPERATION_FAILURES,
  SompiOperationFailure,
  type SompiOperationFailureCode,
} from "../operation-failure.js";
import type { TransferView } from "../transfer/types.js";
import type { WalletView } from "../wallet-view/module.js";

test("authenticated HTTP routes call one canonical Purchase application over the permissioned socket", async () => {
  const credential = generateAgentApiCredential();
  const calls: string[] = [];
  const application = fakeApplication({
    async purchase() { calls.push("purchase"); return fakeView(); },
    async status() { calls.push("status"); return fakeView(); },
    async recover() { calls.push("recover"); return fakeView(); },
  });
  const running = await startTestServer({ application, credential });
  try {
    const unauthorized = await apiRequest(running.socketPath, "GET", `/purchases/${fakeView().id}`);
    assert.equal(unauthorized.status, 401);
    const auth = { authorization: `Bearer ${credential.token}` };
    const created = await apiRequest(running.socketPath, "POST", "/purchases", {
      ...auth, "content-type": "application/json",
    }, JSON.stringify({ requestKey: "api:one", url: "https://merchant.example/" }));
    assert.equal(created.status, 200);
    assert.equal(created.headers["cache-control"], "no-store");
    assert.equal((created.json as any).id, fakeView().id);
    assert.equal((await apiRequest(running.socketPath, "GET", `/purchases/${fakeView().id}`, auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "POST", `/purchases/${fakeView().id}/recover`, auth)).status, 200);
    assert.deepEqual(calls, ["purchase", "status", "recover"]);
    const stat = fs.lstatSync(running.socketPath);
    assert.equal(stat.mode & 0o777, 0o660);
  } finally {
    await running.close();
  }
});

test("HTTP projects every stable operation failure and keeps internal faults internal", async () => {
  const credential = generateAgentApiCredential();
  let outcome: SompiOperationFailureCode | "invalid-response" | "internal" =
    "PURCHASE_NOT_FOUND";
  const application = fakeApplication({
    async status() {
      if (outcome === "invalid-response") return {} as PurchaseView;
      if (outcome === "internal") throw new Error("private storage detail");
      throw new SompiOperationFailure(outcome);
    },
  });
  const running = await startTestServer({ application, credential });
  const auth = { authorization: `Bearer ${credential.token}` };
  const expectedStatus: Readonly<Record<SompiOperationFailureCode, number>> = {
    PURCHASE_CONFLICT: 409,
    PURCHASE_NOT_FOUND: 404,
    PURCHASE_ADMISSION_SATURATED: 429,
    INVALID_TRANSFER: 400,
    TRANSFER_CONFLICT: 409,
    TRANSFER_DENIED: 403,
    TRANSFER_EXPIRED: 410,
    TRANSFER_FAILED: 500,
    TRANSFER_NOT_FOUND: 404,
    INVALID_POLICY_CHANGE: 400,
    POLICY_CHANGE_CONFLICT: 409,
    POLICY_CHANGE_NOT_FOUND: 404,
    INVALID_VAULT_MIGRATION: 400,
    VAULT_MIGRATION_CONFLICT: 409,
    VAULT_MIGRATION_NOT_FOUND: 404,
  };
  try {
    for (const [code, definition] of Object.entries(
      SOMPI_OPERATION_FAILURES,
    ) as [SompiOperationFailureCode, (typeof SOMPI_OPERATION_FAILURES)[SompiOperationFailureCode]][]) {
      outcome = code;
      const response = await apiRequest(
        running.socketPath,
        "GET",
        `/purchases/${fakeView().id}`,
        auth,
      );
      assert.equal(response.status, expectedStatus[code], code);
      assert.deepEqual(response.json, {
        error: {
          code,
          message: definition.message,
          retryable: definition.retryable,
        },
      });
    }

    for (const internal of ["invalid-response", "internal"] as const) {
      outcome = internal;
      const response = await apiRequest(
        running.socketPath,
        "GET",
        `/purchases/${fakeView().id}`,
        auth,
      );
      assert.equal(response.status, 500, internal);
      assert.deepEqual(response.json, {
        error: {
          code: "INTERNAL_ERROR",
          message: "Sompi stopped safely. Ask the operator to check the local service.",
          retryable: false,
        },
      });
    }
  } finally {
    await running.close();
  }
});

test("canonical wallet and Transfer routes stay authenticated and recovery-scoped", async () => {
  const credential = generateAgentApiCredential();
  const calls: string[] = [];
  const application = fakeApplication({
    async wallet() { calls.push("wallet"); return fakeWallet(); },
    async activity(limit) { calls.push(`activity:${limit}`); return []; },
    async transfer() { calls.push("transfer"); return fakeTransfer(); },
    async transferStatus() { calls.push("transferStatus"); return fakeTransfer(); },
    async transferRecover() { calls.push("transferRecover"); return fakeTransfer(); },
  });
  const running = await startTestServer({ application, credential });
  try {
    const auth = { authorization: `Bearer ${credential.token}` };
    assert.equal((await apiRequest(running.socketPath, "GET", "/wallet", auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "GET", "/wallet/activity?limit=7", auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "POST", "/transfers", {
      ...auth, "content-type": "application/json",
    }, JSON.stringify({ requestKey: "api:transfer:one", destination: ADDRESS, amountKas: "0.00001" }))).status, 200);
    assert.equal((await apiRequest(running.socketPath, "GET", `/transfers/${fakeTransfer().id}`, auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "POST", `/transfers/${fakeTransfer().id}/recover`, auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "GET", "/wallet/activity?limit=101", auth)).status, 400);
    assert.deepEqual(calls, ["wallet", "activity:7", "transfer", "transferStatus", "transferRecover"]);
  } finally {
    await running.close();
  }
});

test("wallet details, limit changes, and vault protection use the same authenticated API", async () => {
  const credential = generateAgentApiCredential();
  const calls: string[] = [];
  const application = fakeApplication({
    async walletTechnical() { calls.push("walletTechnical"); return fakeWalletTechnical(); },
    async changePolicy() { calls.push("changePolicy"); return fakePolicyChange(); },
    async policyChangeStatus() { calls.push("policyChangeStatus"); return fakePolicyChange(); },
    async policyChangeRecover() { calls.push("policyChangeRecover"); return fakePolicyChange(); },
    async vaultMigration() { calls.push("vaultMigration"); return fakeVaultMigration(); },
    async vaultMigrationStatus() { calls.push("vaultMigrationStatus"); return fakeVaultMigration(); },
  });
  const running = await startTestServer({ application, credential });
  try {
    const auth = { authorization: `Bearer ${credential.token}` };
    const json = { ...auth, "content-type": "application/json" };
    assert.equal((await apiRequest(running.socketPath, "GET", "/wallet/technical", auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "POST", "/policy-changes", json,
      JSON.stringify({ requestKey: "limits:one", maximumPerPaymentKas: "1", maximumPerHourKas: "2" }))).status, 200);
    assert.equal((await apiRequest(running.socketPath, "GET", `/policy-changes/${fakePolicyChange().id}`, auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "POST", `/policy-changes/${fakePolicyChange().id}/recover`, auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "POST", "/vault-migrations", json,
      JSON.stringify({ requestKey: "vault:one", vaultProtectionMaximumKas: "10" }))).status, 200);
    assert.equal((await apiRequest(running.socketPath, "GET", `/vault-migrations/${fakeVaultMigration().id}`, auth)).status, 200);
    assert.deepEqual(calls, ["walletTechnical", "changePolicy", "policyChangeStatus", "policyChangeRecover", "vaultMigration", "vaultMigrationStatus"]);
  } finally {
    await running.close();
  }
});

test("API startup refuses an unprovisioned socket directory without changing its permissions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-unprovisioned-"));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  try {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    await assert.rejects(() => startSompiApiServer({
      application: fakeApplication(),
      credential: generateAgentApiCredential(),
      socketPath: path.join(directory, "api.sock"),
      expectedServerUserId: uid,
      runtimeGroupId: gid,
    }), /secure local socket/);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP seam fails closed on bad content, oversized bodies, concurrency, and deadlines", async () => {
  const credential = generateAgentApiCredential();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const application = fakeApplication({
    async purchase(_input, signal) {
      await Promise.race([held, new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      return fakeView();
    },
  });
  const running = await startTestServer({ application, credential, maxMutationConcurrency: 1, deadlineMs: 30 });
  const auth = { authorization: `Bearer ${credential.token}` };
  try {
    const bad = await apiRequest(running.socketPath, "POST", "/purchases", auth, "{}");
    assert.equal(bad.status, 400);
    const first = apiRequest(running.socketPath, "POST", "/purchases", {
      ...auth, "content-type": "application/json",
    }, JSON.stringify({ requestKey: "api:held", url: "https://merchant.example/" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await apiRequest(running.socketPath, "GET", `/purchases/${fakeView().id}`, auth)).status, 200);
    assert.equal((await first).status, 504);
    assert.equal((await apiRequest(running.socketPath, "POST", "/purchases", {
      ...auth, "content-type": "application/json",
    }, "x".repeat(1_500_001))).status, 413);
  } finally {
    release();
    await running.close();
  }
});

test("deadline forcibly ends a partial authenticated body and restores Purchase admission", async () => {
  const credential = generateAgentApiCredential();
  const running = await startTestServer({
    application: fakeApplication(), credential, maxMutationConcurrency: 1, maxControlConcurrency: 1, deadlineMs: 40,
  });
  const socket = net.createConnection(running.socketPath);
  socket.on("error", () => {});
  try {
    socket.write([
      "POST /purchases HTTP/1.1", "Host: sompi.local", `Authorization: Bearer ${credential.token}`,
      "Content-Type: application/json", "Content-Length: 200", "", '{"requestKey":"partial",',
    ].join("\r\n"));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("partial request was not terminated")), 500);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const response = await apiRequest(running.socketPath, "POST", "/purchases", {
      authorization: `Bearer ${credential.token}`, "content-type": "application/json",
    }, JSON.stringify({ requestKey: "api:after-partial", url: "https://merchant.example/" }));
    assert.equal(response.status, 200);
  } finally {
    socket.destroy();
    await running.close();
  }
});

test("non-cooperative Purchase work loses the response lease and remains separately bounded", async () => {
  const credential = generateAgentApiCredential();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = await startTestServer({
    application: fakeApplication({ async purchase() { await held; return fakeView(); } }),
    credential, maxMutationConcurrency: 1, maxControlConcurrency: 1, deadlineMs: 40,
  });
  const auth = { authorization: `Bearer ${credential.token}` };
  const post = (requestKey: string) => apiRequest(running.socketPath, "POST", "/purchases", {
    ...auth, "content-type": "application/json",
  }, JSON.stringify({ requestKey, url: "https://merchant.example/" }));
  try {
    assert.equal((await post("api:non-cooperative")).status, 504);
    assert.equal((await apiRequest(running.socketPath, "GET", `/purchases/${fakeView().id}`, auth)).status, 200);
    const bounded = await post("api:bounded-overdue");
    assert.equal(bounded.status, 503);
    assert.equal((bounded.json as any).error.code, "API_RECOVERY_SATURATED");
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await post("api:after-overdue")).status, 200);
  } finally {
    release();
    await running.close();
  }
});

test("pre-authentication Unix sockets are bounded separately from request concurrency", async () => {
  const credential = generateAgentApiCredential();
  const running = await startTestServer({
    application: fakeApplication(), credential, maxMutationConcurrency: 1, maxControlConcurrency: 1, maxConnections: 2,
  });
  const sockets: net.Socket[] = [];
  try {
    assert.equal(running.server.maxConnections, 2);
    for (let index = 0; index < 6; index += 1) {
      const socket = net.createConnection(running.socketPath);
      socket.on("error", () => {});
      socket.write("GET / HTTP/1.1\r\nHost: sompi.local\r\n");
      sockets.push(socket);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const retained = await new Promise<number>((resolve, reject) => {
      running.server.getConnections((error, count) => error ? reject(error) : resolve(count));
    });
    assert.ok(retained <= 2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await running.close();
  }
});

test("operator recovery remains available while the lower-trust agent listener is saturated", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-isolated-recovery-"));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o710);
  const application = fakeApplication({
    async transferStatus() { return fakeTransfer(); },
    async transferRecover() { return fakeTransfer(); },
    async policyChangeRecover() { return fakePolicyChange(); },
  });
  const agentCredential = generateAgentApiCredential();
  const recoveryCredential = generateRecoveryApiCredential();
  const agent = await startSompiApiServer({
    application,
    credential: agentCredential,
    socketPath: path.join(directory, "agent.sock"),
    expectedServerUserId: uid,
    runtimeGroupId: gid,
    maxMutationConcurrency: 1,
    maxControlConcurrency: 1,
    maxConnections: 2,
  });
  const recovery = await startSompiRecoveryApiServer({
    application,
    credential: recoveryCredential,
    socketPath: path.join(directory, "recovery.sock"),
    expectedServerUserId: uid,
    runtimeGroupId: gid,
    maxControlConcurrency: 1,
    maxConnections: 2,
  });
  const hostile: net.Socket[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const socket = net.createConnection(agent.socketPath);
      socket.on("error", () => {});
      socket.write("GET / HTTP/1.1\r\nHost: sompi.local\r\n");
      hostile.push(socket);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const auth = { authorization: `Bearer ${recoveryCredential.token}` };
    assert.equal((await apiRequest(recovery.socketPath, "GET", `/purchases/${fakeView().id}`, auth)).status, 200);
    assert.equal((await apiRequest(recovery.socketPath, "POST", `/purchases/${fakeView().id}/recover`, auth)).status, 200);
    assert.equal((await apiRequest(recovery.socketPath, "GET", `/transfers/${fakeTransfer().id}`, auth)).status, 200);
    assert.equal((await apiRequest(recovery.socketPath, "POST", `/transfers/${fakeTransfer().id}/recover`, auth)).status, 200);
    assert.equal((await apiRequest(recovery.socketPath, "POST", `/policy-changes/${fakePolicyChange().id}/recover`, auth)).status, 200);
    assert.equal((await apiRequest(recovery.socketPath, "GET", `/policy-changes/${fakePolicyChange().id}`, auth)).status, 405);
    assert.equal((await apiRequest(recovery.socketPath, "GET", `/vault-migrations/${fakeVaultMigration().id}`, auth)).status, 405);
    assert.equal((await apiRequest(recovery.socketPath, "GET", "/wallet/technical", auth)).status, 405);
    assert.equal((await apiRequest(recovery.socketPath, "POST", "/purchases", {
      ...auth,
      "content-type": "application/json",
    }, JSON.stringify({ requestKey: "forbidden", url: "https://merchant.example/" }))).status, 404);
    assert.equal((await apiRequest(recovery.socketPath, "GET", `/purchases/${fakeView().id}`, {
      authorization: `Bearer ${agentCredential.token}`,
    })).status, 401);
  } finally {
    for (const socket of hostile) socket.destroy();
    await Promise.all([agent.close(), recovery.close()]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

type TestServer = RunningSompiApiServer & { readonly directory: string };

async function startTestServer(
  options: Omit<SompiApiServerOptions, "socketPath" | "expectedServerUserId" | "runtimeGroupId">
): Promise<TestServer> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-server-"));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o710);
  const running = await startSompiApiServer({
    ...options, socketPath: path.join(directory, "api.sock"), expectedServerUserId: uid, runtimeGroupId: gid,
  });
  return {
    ...running,
    directory,
    async close() {
      await running.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function apiRequest(
  socketPath: string,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath, method, path: pathname,
      headers: { host: "sompi.local", ...headers, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, headers: response.headers, json: text ? JSON.parse(text) : undefined });
      });
    });
    request.once("error", reject);
    request.end(body);
  });
}

function fakeApplication(overrides: Partial<SompiApplication> = {}): SompiApplication {
  return {
    async purchase() { return fakeView(); }, async status() { return fakeView(); }, async recover() { return fakeView(); },
    async wallet() { throw new Error("unused"); },
    async walletTechnical() { throw new Error("unused"); },
    async activity() { return []; },
    async transfer() { throw new Error("unused"); },
    async transferStatus() { throw new Error("unused"); },
    async transferRecover() { throw new Error("unused"); },
    async changePolicy() { throw new Error("unused"); },
    async policyChangeStatus() { throw new Error("unused"); },
    async policyChangeRecover() { throw new Error("unused"); },
    async vaultMigration() { throw new Error("unused"); },
    async vaultMigrationStatus() { throw new Error("unused"); },
    ...overrides,
  };
}

function fakeView(): PurchaseView {
  return {
    id: "pur_0123456789ABCDEFGHIJKL" as PurchaseView["id"],
    requestKey: "api:one" as PurchaseView["requestKey"], state: "created", summary: "Purchase created.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "not_requested" }, treasury: { status: "unreserved" },
    paymentAttempts: [], receiptEvidence: [],
  };
}

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";

function fakeTransfer(): TransferView {
  return {
    id: "trf_0123456789ABCDEFGHIJKL", requestKey: "api:transfer:one",
    requestDigest: `sha256:${"B".repeat(43)}`, state: "created", summary: "Transfer request recorded.", display: { amount: amount("1000"), feeCeiling: amount("100"), maximumTotal: amount("1100") }, destination: ADDRESS,
    amountAtomic: "1000", asset: "KAS", network: "kaspa:testnet-10", sourceVaultAddress: ADDRESS,
    sourceVaultDigest: `sha256:${"C".repeat(43)}`, feeCeilingAtomic: "100", maximumTotalAtomic: "1100",
    expiresAtMs: 2_000_000_000_000, policyDigest: `sha256:${"D".repeat(43)}`, manifestRevision: 1,
    manifestDigest: `sha256:${"E".repeat(43)}`, finalityFloor: "accepted", version: 0,
    createdAtMs: 1_900_000_000_000, updatedAtMs: 1_900_000_000_000,
    recoveryRequired: false, safeToRetry: true, userAction: "none",
  };
}

function fakeWallet(): WalletView {
  return {
    network: "kaspa:testnet-10", asset: "KAS",
    receive: { address: ADDRESS, qrPayload: ADDRESS, networkLabel: "Kaspa Testnet-10", warning: "Testnet funds only — do not send mainnet KAS." },
    balance: { total: amount("10000"), available: amount("10000"), incoming: amount("0"), pending: amount("0"), provenance: "operator-node-and-local-vault-lineage", observedAt: "2030-01-01T00:00:00.000Z" },
    securing: { automatic: true, state: "idle", summary: "No incoming funds are waiting to be secured.", userAction: "none", minimumAmount: amount("101") },
    spendingProtection: { maximumPerPayment: amount("1000"), maximumPerHour: amount("5000"), everyPaymentRequiresApproval: true, vaultProtection: { maximumPerWindow: amount("5000"), remainingInWindow: amount("5000"), window: "approximately 1 hour", summary: "Protected." } },
    chainStatus: "observed",
  };
}

function fakeWalletTechnical() {
  return { receiveAddress: ADDRESS, activeVault: { address: ADDRESS, maximumOutflowAtomic: "1000000000", windowSizeDaa: "36000", windowStartDaa: "0", spentInWindowAtomic: "0" }, allowlist: [] } as const;
}

function fakePolicyChange() {
  return { id: "pcg_0123456789ABCDEFGHIJKL", requestKey: "limits:one", state: "applied", summary: "Spending limits updated. Every payment still requires your approval.", previous: { maximumPerPayment: amount("1000"), maximumPerHour: amount("5000") }, proposed: { maximumPerPayment: amount("2000"), maximumPerHour: amount("6000") }, vaultProtectionMaximum: amount("10000"), everyPaymentRequiresApproval: true, expiresAt: "2030-01-01T00:00:00.000Z", appliedPolicyDigest: `sha256:${"F".repeat(43)}`, appliedPolicyVersion: 2 } as const;
}

function fakeVaultMigration() {
  return { id: "vmg_0123456789ABCDEFGHIJKL", requestKey: "vault:one", state: "awaiting_owner", summary: "Vault protection change approved. Finish it with the offline owner key.", userAction: "Ask the operator to finish the protected vault update locally.", previousVaultProtectionMaximum: amount("10000"), proposedVaultProtectionMaximum: amount("20000"), receiveAddressUnchanged: true, requiresOfflineOwnerKey: true, expiresAt: "2030-01-01T00:00:00.000Z" } as const;
}

function amount(atomic: string) {
  const kas = atomic === "0" ? "0" : `0.${atomic.padStart(8, "0").replace(/0+$/, "")}`;
  return { atomic, kas, unit: "tKAS" as const, display: `${kas} tKAS` };
}
