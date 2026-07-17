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
import type { PurchaseApplication } from "./contracts.js";
import {
  startPurchaseApiServer,
  startPurchaseRecoveryApiServer,
  type PurchaseApiServerOptions,
  type RunningPurchaseApiServer,
} from "./server.js";
import type { PurchaseView } from "../purchase/types.js";

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

test("API startup refuses an unprovisioned socket directory without changing its permissions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-unprovisioned-"));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  try {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    await assert.rejects(() => startPurchaseApiServer({
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
  const running = await startTestServer({ application, credential, maxPurchaseConcurrency: 1, deadlineMs: 30 });
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
    application: fakeApplication(), credential, maxPurchaseConcurrency: 1, maxControlConcurrency: 1, deadlineMs: 40,
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
    credential, maxPurchaseConcurrency: 1, maxControlConcurrency: 1, deadlineMs: 40,
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
    application: fakeApplication(), credential, maxPurchaseConcurrency: 1, maxControlConcurrency: 1, maxConnections: 2,
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
  const agent = await startPurchaseApiServer({
    application,
    credential: agentCredential,
    socketPath: path.join(directory, "agent.sock"),
    expectedServerUserId: uid,
    runtimeGroupId: gid,
    maxPurchaseConcurrency: 1,
    maxControlConcurrency: 1,
    maxConnections: 2,
  });
  const recovery = await startPurchaseRecoveryApiServer({
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

type TestServer = RunningPurchaseApiServer & { readonly directory: string };

async function startTestServer(
  options: Omit<PurchaseApiServerOptions, "socketPath" | "expectedServerUserId" | "runtimeGroupId">
): Promise<TestServer> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-server-"));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o710);
  const running = await startPurchaseApiServer({
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

function fakeApplication(overrides: Partial<PurchaseApplication> = {}): PurchaseApplication {
  return {
    async purchase() { return fakeView(); }, async status() { return fakeView(); }, async recover() { return fakeView(); }, ...overrides,
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
