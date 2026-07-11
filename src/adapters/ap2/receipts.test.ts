import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SignJWT, decodeJwt, type JWTPayload } from "jose";
import { Ap2AdapterError } from "./errors.js";
import { importSigningKey } from "./crypto.js";
import {
  issueCheckoutReceipt,
  issuePaymentReceipt,
  verifyCheckoutReceipt,
  verifyPaymentReceipt,
} from "./receipts.js";
import {
  FIXED_MERCHANT_RECEIPT_ISSUER,
  FIXED_NOW,
  FIXED_PAYMENT_RECEIPT_ISSUER,
  MERCHANT_RECEIPT_SIGNER,
  PAYMENT_RECEIPT_SIGNER,
  fixedTrustStore,
  fixedVerifiedMandates,
} from "./test-fixtures.js";
import type { Ap2SigningIdentity, VerifiedHumanPresentMandates } from "./types.js";

test("fixed role keys issue and verify mapped AP2 Checkout and Payment success Receipts", async () => {
  const mandates = await fixedVerifiedMandates();
  const checkoutArtifact = await issueCheckoutReceipt({
    status: "Success",
    mandate: mandates.checkout,
    orderId: "order:test:1",
    issuedAtSec: FIXED_NOW + 20,
  }, MERCHANT_RECEIPT_SIGNER);
  const paymentArtifact = await issuePaymentReceipt({
    status: "Success",
    mandate: mandates.payment,
    paymentId: "pay_test_1",
    pspConfirmationId: "psp_test_1",
    networkConfirmationId: "tx_test_1",
    issuedAtSec: FIXED_NOW + 20,
  }, PAYMENT_RECEIPT_SIGNER);

  const checkout = await verifyCheckoutReceipt(checkoutArtifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_RECEIPT_ISSUER,
    mandate: mandates.checkout,
    nowSec: FIXED_NOW + 21,
  });
  const payment = await verifyPaymentReceipt(paymentArtifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_PAYMENT_RECEIPT_ISSUER,
    mandate: mandates.payment,
    expectedPaymentId: "pay_test_1",
    nowSec: FIXED_NOW + 21,
  });

  assert.equal(checkout.role, "merchant");
  assert.equal(checkout.profile, "urn:sompi:receipt:merchant:1");
  assert.equal(checkout.orderId, "order:test:1");
  assert.equal(checkout.reference, mandates.checkout.issuerJwtReference);
  assert.equal(payment.role, "payment");
  assert.equal(payment.profile, "urn:sompi:receipt:payment:1");
  assert.equal(payment.paymentId, "pay_test_1");
  assert.equal(payment.networkConfirmationId, "tx_test_1");
  assert.equal(payment.reference, mandates.payment.issuerJwtReference);
});

test("Checkout and Payment Error Receipts enforce their pinned variant fields", async () => {
  const mandates = await fixedVerifiedMandates();
  const checkoutArtifact = await issueCheckoutReceipt({
    status: "Error",
    mandate: mandates.checkout,
    error: "checkout_declined",
    errorDescription: "The checkout could not be completed.",
    issuedAtSec: FIXED_NOW + 20,
  }, MERCHANT_RECEIPT_SIGNER);
  const paymentArtifact = await issuePaymentReceipt({
    status: "Error",
    mandate: mandates.payment,
    paymentId: "pay_test_2",
    error: "settlement_failed",
    errorDescription: "The payment did not settle.",
    issuedAtSec: FIXED_NOW + 20,
  }, PAYMENT_RECEIPT_SIGNER);

  const checkout = await verifyCheckoutReceipt(checkoutArtifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_RECEIPT_ISSUER,
    mandate: mandates.checkout,
    nowSec: FIXED_NOW + 21,
  });
  const payment = await verifyPaymentReceipt(paymentArtifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_PAYMENT_RECEIPT_ISSUER,
    mandate: mandates.payment,
    expectedPaymentId: "pay_test_2",
    nowSec: FIXED_NOW + 21,
  });
  assert.equal(checkout.status, "Error");
  assert.equal(checkout.error, "checkout_declined");
  assert.equal(payment.status, "Error");
  assert.equal(payment.paymentId, "pay_test_2");
  assert.equal(payment.error, "settlement_failed");
});

test("Receipt reference accepts only the pinned issuer-JWT-segment hash", async () => {
  const mandates = await fixedVerifiedMandates();
  const fullPresentationHash = createHash("sha256")
    .update(Buffer.from(mandates.checkout.artifact, "utf8"))
    .digest("base64url");
  assert.notEqual(fullPresentationHash, mandates.checkout.issuerJwtReference);

  const payload = {
    status: "Success",
    iss: FIXED_MERCHANT_RECEIPT_ISSUER,
    iat: FIXED_NOW + 20,
    reference: fullPresentationHash,
    order_id: "order:test:wrong-reference",
  };
  const artifact = await signRawReceipt(payload, MERCHANT_RECEIPT_SIGNER);
  await assertRejectCode(() => verifyCheckoutReceipt(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_RECEIPT_ISSUER,
    mandate: mandates.checkout,
    nowSec: FIXED_NOW + 21,
  }), "binding_mismatch");
});

test("Receipts reject unknown fields, future issuance, wrong payment IDs, and role confusion", async () => {
  const mandates = await fixedVerifiedMandates();
  const valid = await issuePaymentReceipt({
    status: "Success",
    mandate: mandates.payment,
    paymentId: "pay_test_3",
    pspConfirmationId: "psp_test_3",
    networkConfirmationId: "tx_test_3",
    issuedAtSec: FIXED_NOW + 20,
  }, PAYMENT_RECEIPT_SIGNER);
  const payload = decodeJwt(valid) as Record<string, unknown>;
  const unknown = await signRawReceipt({ ...payload, unexpected: true }, PAYMENT_RECEIPT_SIGNER);
  await assertRejectCode(() => verifyPayment(unknown, mandates, "pay_test_3"), "profile_mismatch");
  await assertRejectCode(() => verifyPayment(valid, mandates, "pay_other"), "binding_mismatch");

  const future = await signRawReceipt({ ...payload, iat: FIXED_NOW + 500 }, PAYMENT_RECEIPT_SIGNER);
  await assertRejectCode(() => verifyPayment(future, mandates, "pay_test_3"), "time_invalid");

  await assertRejectCode(() => verifyCheckoutReceipt(valid, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_PAYMENT_RECEIPT_ISSUER,
    mandate: mandates.checkout,
    nowSec: FIXED_NOW + 21,
  }), "untrusted_key");
});

test("Receipt signatures and local issuer trust fail closed", async () => {
  const mandates = await fixedVerifiedMandates();
  const artifact = await issueCheckoutReceipt({
    status: "Success",
    mandate: mandates.checkout,
    orderId: "order:test:4",
    issuedAtSec: FIXED_NOW + 20,
  }, MERCHANT_RECEIPT_SIGNER);
  const parts = artifact.split(".");
  const signature = parts[2];
  parts[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  await assertRejectCode(() => verifyCheckoutReceipt(parts.join("."), {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_RECEIPT_ISSUER,
    mandate: mandates.checkout,
    nowSec: FIXED_NOW + 21,
  }), "signature_invalid");
  await assertRejectCode(() => verifyCheckoutReceipt(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: "https://unknown.example/receipts",
    mandate: mandates.checkout,
    nowSec: FIXED_NOW + 21,
  }), "untrusted_key");
});

async function signRawReceipt(
  payload: Record<string, unknown>,
  signer: Ap2SigningIdentity
): Promise<string> {
  const key = await importSigningKey(signer);
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: "ES256", kid: signer.kid, typ: "JWT" })
    .sign(key);
}

function verifyPayment(
  artifact: string,
  mandates: VerifiedHumanPresentMandates,
  expectedPaymentId: string
) {
  return verifyPaymentReceipt(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_PAYMENT_RECEIPT_ISSUER,
    mandate: mandates.payment,
    expectedPaymentId,
    nowSec: FIXED_NOW + 21,
  });
}

async function assertRejectCode(
  action: () => Promise<unknown>,
  code: Ap2AdapterError["code"]
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Ap2AdapterError);
    assert.equal(error.code, code);
    return true;
  });
}
