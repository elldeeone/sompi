import * as assert from "node:assert/strict";
import test from "node:test";

import type { PurchaseApplication } from "../api/contracts.js";
import type { PurchaseView } from "../purchase/types.js";
import { createPurchaseToolHandlers } from "./purchase-tools.js";

test("Purchase compatibility handlers delegate without owning protocol behavior", async () => {
  const calls: string[] = [];
  const expected = fakeView();
  const application: PurchaseApplication = {
    async purchase() { calls.push("purchase"); return expected; },
    async status() { calls.push("status"); return expected; },
    async recover() { calls.push("recover"); return expected; },
  };
  const handlers = createPurchaseToolHandlers(application);
  assert.equal(await handlers.purchase({ requestKey: "mcp:one", url: "https://merchant.example/" }), expected);
  assert.equal(await handlers.purchaseStatus({ purchaseId: expected.id }), expected);
  assert.equal(await handlers.purchaseRecover({ purchaseId: expected.id }), expected);
  assert.deepEqual(calls, ["purchase", "status", "recover"]);
});

function fakeView(): PurchaseView {
  return {
    id: "pur_0123456789ABCDEFGHIJKL" as PurchaseView["id"],
    requestKey: "mcp:one" as PurchaseView["requestKey"],
    state: "created",
    summary: "Purchase created.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "not_requested" },
    treasury: { status: "unreserved" },
    paymentAttempts: [],
    receiptEvidence: [],
  };
}
