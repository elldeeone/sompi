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
    }, JSON.stringify({ requestKey: "api:transfer:one", destination: ADDRESS, amountAtomic: "1000" }))).status, 200);
    assert.equal((await apiRequest(running.socketPath, "GET", `/transfers/${fakeTransfer().id}`, auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "POST", `/transfers/${fakeTransfer().id}/recover`, auth)).status, 200);
    assert.equal((await apiRequest(running.socketPath, "GET", "/wallet/activity?limit=101", auth)).status, 400);
    assert.deepEqual(calls, ["wallet", "activity:7", "transfer", "transferStatus", "transferRecover"]);
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
  const application = fakeApplication();
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
    async activity() { return []; },
    async transfer() { throw new Error("unused"); },
    async transferStatus() { throw new Error("unused"); },
    async transferRecover() { throw new Error("unused"); },
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
    requestDigest: `sha256:${"B".repeat(43)}`, state: "created", destination: ADDRESS,
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
    network: "kaspa:testnet-10", asset: "KAS", fundingAddress: ADDRESS, vaultAddress: ADDRESS,
    balance: { observedAtomic: "10000", unboundAtomic: "0", reservedAtomic: "0", availableAtomic: "10000", provenance: "operator-node-and-local-vault-lineage", observedAt: "2030-01-01T00:00:00.000Z" },
    limits: { maxPerTransferAtomic: "1000", maxPerHourAtomic: "5000", approvalThresholdAtomic: "1", allowlist: [], vaultMaxOutflowAtomic: "5000", vaultWindowSizeDaa: "100", vaultSpentInWindowAtomic: "0" },
    chainStatus: "observed",
  };
}
