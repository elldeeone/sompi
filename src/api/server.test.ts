import * as assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";

import { generateAgentApiCredential } from "./credential.js";
import type { PurchaseApplication } from "./contracts.js";
import { startPurchaseApiServer } from "./server.js";
import type { PurchaseView } from "../purchase/types.js";

test("authenticated HTTP routes call one canonical Purchase application", async () => {
  const credential = generateAgentApiCredential();
  const calls: string[] = [];
  const application = fakeApplication({
    async purchase() { calls.push("purchase"); return fakeView(); },
    async status() { calls.push("status"); return fakeView(); },
    async recover() { calls.push("recover"); return fakeView(); },
  });
  const running = await startPurchaseApiServer({ application, credential, port: 0 });
  try {
    const unauthorized = await fetch(`${running.baseUrl}/purchases/${fakeView().id}`);
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: `Bearer ${credential.token}` };
    const created = await fetch(`${running.baseUrl}/purchases`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestKey: "api:one", url: "https://merchant.example/" }),
    });
    assert.equal(created.status, 200);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal((await created.json() as any).id, fakeView().id);
    assert.equal((await fetch(`${running.baseUrl}/purchases/${fakeView().id}`, { headers })).status, 200);
    assert.equal((await fetch(`${running.baseUrl}/purchases/${fakeView().id}/recover`, { method: "POST", headers })).status, 200);
    assert.deepEqual(calls, ["purchase", "status", "recover"]);
  } finally {
    await running.close();
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
  const running = await startPurchaseApiServer({ application, credential, port: 0, maxPurchaseConcurrency: 1, deadlineMs: 30 });
  const auth = { authorization: `Bearer ${credential.token}` };
  try {
    const bad = await fetch(`${running.baseUrl}/purchases`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(bad.status, 400);
    const first = fetch(`${running.baseUrl}/purchases`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ requestKey: "api:held", url: "https://merchant.example/" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const control = await fetch(`${running.baseUrl}/purchases/${fakeView().id}`, { headers: auth });
    assert.equal(control.status, 200);
    assert.equal((await first).status, 504);
    const oversized = await fetch(`${running.baseUrl}/purchases`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: "x".repeat(1_500_001),
    });
    assert.equal(oversized.status, 413);
  } finally {
    release();
    await running.close();
  }
});

test("deadline forcibly ends a partial authenticated body and restores Purchase admission", async () => {
  const credential = generateAgentApiCredential();
  const running = await startPurchaseApiServer({
    application: fakeApplication(),
    credential,
    port: 0,
    maxPurchaseConcurrency: 1,
    maxControlConcurrency: 1,
    deadlineMs: 40,
  });
  const socket = net.createConnection({ host: running.host, port: running.port });
  socket.on("error", () => {});
  try {
    socket.write([
      "POST /purchases HTTP/1.1",
      `Host: ${running.host}`,
      `Authorization: Bearer ${credential.token}`,
      "Content-Type: application/json",
      "Content-Length: 200",
      "",
      '{"requestKey":"partial",',
    ].join("\r\n"));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("partial request was not terminated")), 500);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
    });

    const response = await fetch(`${running.baseUrl}/purchases`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestKey: "api:after-partial", url: "https://merchant.example/" }),
    });
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
  const application = fakeApplication({
    async purchase() {
      await held;
      return fakeView();
    },
  });
  const running = await startPurchaseApiServer({
    application,
    credential,
    port: 0,
    maxPurchaseConcurrency: 1,
    maxControlConcurrency: 1,
    deadlineMs: 40,
  });
  const headers = { authorization: `Bearer ${credential.token}` };
  try {
    const timedOut = await fetch(`${running.baseUrl}/purchases`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestKey: "api:non-cooperative", url: "https://merchant.example/" }),
    });
    assert.equal(timedOut.status, 504);

    const status = await fetch(`${running.baseUrl}/purchases/${fakeView().id}`, { headers });
    assert.equal(status.status, 200);

    const bounded = await fetch(`${running.baseUrl}/purchases`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestKey: "api:bounded-overdue", url: "https://merchant.example/" }),
    });
    assert.equal(bounded.status, 503);
    assert.equal((await bounded.json() as any).error.code, "API_RECOVERY_SATURATED");

    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const recovered = await fetch(`${running.baseUrl}/purchases`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestKey: "api:after-overdue", url: "https://merchant.example/" }),
    });
    assert.equal(recovered.status, 200);
  } finally {
    release();
    await running.close();
  }
});

test("pre-authentication TCP sockets are bounded separately from request concurrency", async () => {
  const credential = generateAgentApiCredential();
  const running = await startPurchaseApiServer({
    application: fakeApplication(),
    credential,
    port: 0,
    maxPurchaseConcurrency: 1,
    maxControlConcurrency: 1,
    maxConnections: 2,
  });
  const sockets: net.Socket[] = [];
  try {
    assert.equal(running.server.maxConnections, 2);
    for (let index = 0; index < 6; index += 1) {
      const socket = net.createConnection({ host: running.host, port: running.port });
      socket.on("error", () => {});
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
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

function fakeApplication(overrides: Partial<PurchaseApplication> = {}): PurchaseApplication {
  return {
    async purchase() { return fakeView(); },
    async status() { return fakeView(); },
    async recover() { return fakeView(); },
    ...overrides,
  };
}

function fakeView(): PurchaseView {
  return {
    id: "pur_0123456789ABCDEFGHIJKL" as PurchaseView["id"],
    requestKey: "api:one" as PurchaseView["requestKey"],
    state: "created", summary: "Purchase created.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "not_requested" }, treasury: { status: "unreserved" },
    paymentAttempts: [], receiptEvidence: [],
  };
}
