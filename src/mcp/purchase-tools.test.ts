import * as assert from "node:assert/strict";
import test from "node:test";
import { createPurchaseToolHandlers, toolIntent } from "./purchase-tools.js";
import { assertPurchaseRequestKey, createPurchaseId, evidenceDigest } from "../purchase/identity.js";
import type { PurchaseModule, PurchaseView } from "../purchase/types.js";

test("thin Purchase handlers call only the matching stable module method", async () => {
  const calls: string[] = [];
  const view = fakeView();
  const module: PurchaseModule = {
    async purchase(intent) {
      calls.push(`purchase:${intent.requestKey}:${Buffer.from(intent.resource.body ?? []).toString("utf8")}`);
      return view;
    },
    async status(id) {
      calls.push(`status:${id}`);
      return view;
    },
    async recover(id) {
      calls.push(`recover:${id}`);
      return view;
    },
  };
  const handlers = createPurchaseToolHandlers(module);
  const purchaseInput = {
    requestKey: "mcp:purchase:1",
    url: "https://merchant.example/resource",
    method: "POST",
    bodyBase64: Buffer.from("hello").toString("base64"),
  };
  assert.equal(await handlers.purchase(purchaseInput), view);
  assert.equal(await handlers.purchaseStatus({ purchaseId: view.id }), view);
  assert.equal(await handlers.purchaseRecover({ purchaseId: view.id }), view);
  assert.deepEqual(calls, [
    "purchase:mcp:purchase:1:hello",
    `status:${view.id}`,
    `recover:${view.id}`,
  ]);
});

test("tool input requires caller idempotency and rejects ambiguous base64", () => {
  assert.throws(() => toolIntent({ requestKey: "", url: "https://merchant.example" }));
  assert.throws(() => toolIntent({ requestKey: "ok", url: "https://merchant.example", bodyBase64: "aGVsbG8" }));
  assert.throws(() => toolIntent({ requestKey: "ok", url: "https://merchant.example", bodyBase64: "====" }));
  const intent = toolIntent({
    requestKey: "ok",
    url: "https://merchant.example",
    bodyBase64: "AA==",
    expectedMerchantId: "merchant:test",
  });
  assert.deepEqual(intent.resource.body, new Uint8Array([0]));
  assert.equal(intent.expectedMerchant?.id, "merchant:test");
});

function fakeView(): PurchaseView {
  const id = createPurchaseId(new Uint8Array(16).fill(7));
  return {
    id,
    requestKey: assertPurchaseRequestKey("mcp:purchase:1"),
    state: "created",
    summary: "Purchase request recorded.",
    resourceFingerprint: evidenceDigest("resource"),
    authorization: { status: "not_requested" },
    treasury: { status: "unreserved" },
    paymentAttempts: [],
    receiptEvidence: [],
  };
}
