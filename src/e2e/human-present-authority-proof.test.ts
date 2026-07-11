import assert from "node:assert/strict";
import test from "node:test";

import { LocalAp2TrustStore } from "../adapters/ap2/crypto.js";
import {
  MERCHANT_RECEIPT_SIGNER,
  MERCHANT_SIGNER,
  PAYMENT_RECEIPT_SIGNER,
} from "../adapters/ap2/test-fixtures.js";
import { humanPresentProofMerchantTrustEntries } from "./human-present-authority-proof.js";

test("human-present proof exposes only the development Merchant public trust roles", () => {
  const entries = humanPresentProofMerchantTrustEntries();
  assert.deepEqual(
    entries.map((entry) => entry.role),
    ["merchant-checkout", "merchant-receipt", "payment-receipt"]
  );
  assert.equal(JSON.stringify(entries).includes('"d"'), false);
  const resolver = new LocalAp2TrustStore(entries);
  for (const signer of [
    MERCHANT_SIGNER,
    MERCHANT_RECEIPT_SIGNER,
    PAYMENT_RECEIPT_SIGNER,
  ]) {
    assert.deepEqual(
      resolver.resolve(signer.role, signer.issuer, signer.kid),
      (({ d: _privateValue, ...publicJwk }) => publicJwk)(signer.privateJwk)
    );
  }
  assert.equal(
    entries.some((entry) => entry.role === "authority"),
    false,
    "external proof must trust only the freshly generated authority identity"
  );
});
