import assert from "node:assert/strict";
import { test } from "node:test";

import { assertPurchaseId, assertPurchaseRequestKey, evidenceDigest } from "../purchase/identity.js";
import type { PurchaseModule, PurchaseView } from "../purchase/types.js";
import {
  PurchaseApiContractError,
  assertPurchaseApiError,
  assertPurchaseView,
  createPurchaseApplication,
  parsePurchaseCreateRequest,
  purchaseIntent,
} from "./contracts.js";

test("canonical Purchase contract drives input, module calls, and public result", async () => {
  const view = fakeView();
  let called = 0;
  const module: PurchaseModule = {
    async purchase(intent) {
      called += 1;
      assert.equal(intent.requestKey, "agent:request:1");
      assert.equal(intent.resource.url, "https://merchant.example/resource");
      assert.equal(intent.resource.method, "POST");
      assert.deepEqual(intent.resource.body, Uint8Array.from([1, 2, 3]));
      assert.deepEqual(intent.expectedMerchant, {
        id: "merchant:test",
        origin: "https://merchant.example",
      });
      return view;
    },
    async status(id) { assert.equal(id, view.id); return view; },
    async recover(id) { assert.equal(id, view.id); return view; },
  };
  const application = createPurchaseApplication(module);
  const input = {
    requestKey: "agent:request:1",
    url: "https://merchant.example/resource",
    method: "POST",
    bodyBase64: "AQID",
    mediaType: "application/json",
    expectedMerchant: { id: "merchant:test", origin: "https://merchant.example" },
  };
  assert.deepEqual(purchaseIntent(parsePurchaseCreateRequest(input)).resource.body, Uint8Array.from([1, 2, 3]));
  assert.equal(await application.purchase(input), view);
  assert.equal(await application.status(view.id), view);
  assert.equal(await application.recover(view.id), view);
  assert.equal(called, 1);
});

test("canonical Purchase contract rejects unknown, ambiguous, oversized, and secret-shaped data", () => {
  assert.throws(
    () => parsePurchaseCreateRequest({ requestKey: "agent:request:1", url: "https://merchant.example/", unknown: true }),
    PurchaseApiContractError
  );
  assert.throws(
    () => parsePurchaseCreateRequest({ requestKey: "agent:request:1", url: "https://user:secret@merchant.example/" }),
    PurchaseApiContractError
  );
  assert.throws(
    () => parsePurchaseCreateRequest({ requestKey: "agent:request:1", url: "https://merchant.example/", bodyBase64: "AQI" }),
    PurchaseApiContractError
  );
  assert.throws(() => assertPurchaseView({ ...fakeView(), authorityPrivateKey: "secret" }), PurchaseApiContractError);
  assert.throws(
    () => assertPurchaseApiError({ error: { code: "BAD", message: "safe", retryable: false }, raw: "secret" }),
    PurchaseApiContractError
  );
});

function fakeView(): PurchaseView {
  return {
    id: assertPurchaseId("pur_0123456789ABCDEFGHIJKL"),
    requestKey: assertPurchaseRequestKey("agent:request:1"),
    state: "created",
    summary: "Purchase request recorded.",
    userAction: "none",
    resourceFingerprint: evidenceDigest("resource"),
    authorization: { status: "not_requested" },
    treasury: { status: "unreserved" },
    paymentAttempts: [],
    receiptEvidence: [],
  };
}
