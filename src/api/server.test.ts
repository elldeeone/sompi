import * as assert from "node:assert/strict";
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
  const running = await startPurchaseApiServer({ application, credential, port: 0, maxConcurrency: 1, deadlineMs: 30 });
  const auth = { authorization: `Bearer ${credential.token}` };
  try {
    const bad = await fetch(`${running.baseUrl}/purchases`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(bad.status, 400);
    const first = fetch(`${running.baseUrl}/purchases`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ requestKey: "api:held", url: "https://merchant.example/" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const busy = await fetch(`${running.baseUrl}/purchases/${fakeView().id}`, { headers: auth });
    assert.equal(busy.status, 429);
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
