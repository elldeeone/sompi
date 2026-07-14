import assert from "node:assert/strict";
import test from "node:test";

import { paymentFinalityMeets, requirePaymentFinality } from "./finality.js";

test("payment finality preserves the pinned monotonic order", () => {
  assert.equal(paymentFinalityMeets("mempool", "mempool"), true);
  assert.equal(paymentFinalityMeets("accepted", "mempool"), true);
  assert.equal(paymentFinalityMeets("confirmed", "accepted"), true);
  assert.equal(paymentFinalityMeets("confirmed", "confirmed"), true);
  assert.equal(paymentFinalityMeets("mempool", "accepted"), false);
  assert.equal(paymentFinalityMeets("accepted", "confirmed"), false);
  assert.throws(() => requirePaymentFinality("final"), /unsupported/);
  assert.throws(() => paymentFinalityMeets("unknown", "accepted"), /unsupported/);
});
