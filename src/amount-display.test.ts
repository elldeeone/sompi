import * as assert from "node:assert/strict";
import test from "node:test";

import { displayKas, displayKasWithAtomic, kasAmountView, parseKasAmount } from "./amount-display.js";

test("KAS projections lead with tKAS while preserving exact atomic evidence", () => {
  assert.deepEqual(kasAmountView("100000000"), {
    atomic: "100000000", kas: "1", unit: "tKAS", display: "1 tKAS",
  });
  assert.equal(displayKas("20000000"), "0.2 tKAS");
  assert.equal(displayKasWithAtomic("20000000"), "0.2 tKAS (20000000 sompi)");
  assert.equal(kasAmountView("1").display, "0.00000001 tKAS");
  assert.equal(kasAmountView("100000000", "kaspa:mainnet").display, "1 KAS");
});

test("KAS projections reject noncanonical atomic values", () => {
  for (const value of ["", "00", "01", "-1", "+1", "1.0", " 1"]) {
    assert.throws(() => kasAmountView(value));
  }
});

test("user KAS input converts to an exact positive atomic amount", () => {
  assert.equal(parseKasAmount("1"), "100000000");
  assert.equal(parseKasAmount("0.00000001"), "1");
  assert.equal(parseKasAmount("1.25"), "125000000");
  assert.throws(() => parseKasAmount("0"), /positive/);
  assert.throws(() => parseKasAmount("1.000000001"), /8 places/);
});
