import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ap2SchemaError, loadPinnedAp2Schemas } from "./schemas.js";

test("pinned AP2 v0.2 schemas load with their exact upstream digests", () => {
  const validators = loadPinnedAp2Schemas();
  assert.equal(validators.checkoutMandate({
    vct: "mandate.checkout.1",
    checkout_jwt: "header.payload.signature",
    checkout_hash: "digest",
    iat: 1,
    exp: 2,
  }), true);
  assert.equal(validators.paymentReceipt({
    status: "Success",
    iss: "payment:test",
    iat: 1,
    reference: "digest",
    payment_id: "pay_test",
    psp_confirmation_id: "psp_test",
    network_confirmation_id: "tx_test",
  }), true);
});

test("schema loading fails closed after byte tampering", () => {
  const source = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../vendor/ap2-v0.2-schemas"
  );
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-ap2-schema-"));
  try {
    fs.cpSync(source, temporary, { recursive: true });
    fs.appendFileSync(path.join(temporary, "checkout_mandate.json"), " ");
    assert.throws(() => loadPinnedAp2Schemas(temporary), Ap2SchemaError);
    fs.copyFileSync(
      path.join(source, "checkout_mandate.json"),
      path.join(temporary, "checkout_mandate.json"),
    );
    fs.appendFileSync(path.join(temporary, "types", "merchant.json"), "\n");
    assert.throws(() => loadPinnedAp2Schemas(temporary), Ap2SchemaError);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
