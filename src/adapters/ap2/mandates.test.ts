import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SDJwtInstance } from "@sd-jwt/core";
import { Ap2AdapterError } from "./errors.js";
import {
  decodeBase64urlJson,
  randomSalt,
  sdJwtSigner,
  sha256Hasher,
} from "./crypto.js";
import {
  issueClosedCheckoutMandate,
  issueClosedPaymentMandate,
  issueHumanPresentMandates,
  verifyClosedCheckoutMandate,
  verifyClosedPaymentMandate,
  verifyHumanPresentMandates,
} from "./mandates.js";
import {
  AUTHORITY_SIGNER,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_NOW,
  fixedTrustStore,
  fixedVerifiedCheckout,
} from "./test-fixtures.js";
import type {
  ClosedCheckoutMandateContent,
  ClosedPaymentMandateContent,
  VerifiedMerchantCheckout,
} from "./types.js";

test("fixed authority key issues and verifies the pinned direct root AP2 pair", async () => {
  const checkout = await fixedVerifiedCheckout();
  const artifacts = await issueHumanPresentMandates({
    checkout,
    instrumentId: FIXED_INSTRUMENT_ID,
    issuedAtSec: FIXED_NOW + 10,
    expiresAtSec: FIXED_NOW + 300,
  }, AUTHORITY_SIGNER);
  const verified = await verifyHumanPresentMandates(artifacts, verificationOptions(checkout));

  assert.equal(verified.checkout.content.checkout_jwt, checkout.artifact);
  assert.equal(verified.checkout.content.checkout_hash, checkout.checkoutHash);
  assert.equal(verified.payment.content.transaction_id, checkout.checkoutHash);
  assert.equal(verified.payment.amountAtomic, checkout.terms.amountAtomic);
  assert.equal(verified.payment.content.payment_instrument.type,
    "urn:sompi:ap2:payment-instrument:kaspa-x402:1");
  assert.equal(verified.payment.content.payment_instrument.network, "kaspa:testnet-10");

  // Pinned direct form: root issuer JWT + fully presented disclosures + trailing '~'.
  assert.equal(artifacts.checkoutMandate.split("~").length, 4);
  assert.equal(artifacts.paymentMandate.split("~").length, 3);
  assert.ok(artifacts.checkoutMandate.endsWith("~"));
  assert.ok(artifacts.paymentMandate.endsWith("~"));
  assert.ok(!artifacts.checkoutMandate.includes("~~"));
  assert.ok(!artifacts.paymentMandate.includes("~~"));

  const checkoutIssuerJwt = artifacts.checkoutMandate.split("~", 1)[0];
  const rawPayload = decodeBase64urlJson(checkoutIssuerJwt.split(".")[1], "test payload") as {
    delegate_payload: unknown[];
    _sd_alg: string;
  };
  assert.equal(rawPayload._sd_alg, "sha-256");
  assert.deepEqual(Object.keys(rawPayload).sort(), ["_sd_alg", "delegate_payload"]);
  assert.equal(
    verified.checkout.issuerJwtReference,
    createHash("sha256").update(Buffer.from(checkoutIssuerJwt, "ascii")).digest("base64url")
  );
});

test("closed mandates reject tampered signatures, chains, KB forms, and unknown root headers", async () => {
  const checkout = await fixedVerifiedCheckout();
  const artifact = await issueClosedCheckoutMandate({
    checkout,
    issuedAtSec: FIXED_NOW + 10,
    expiresAtSec: FIXED_NOW + 300,
  }, AUTHORITY_SIGNER);

  await assertRejectCode(
    () => verifyClosedCheckoutMandate(tamperIssuerSignature(artifact), verificationOptions(checkout)),
    "signature_invalid"
  );
  await assertRejectCode(
    () => verifyClosedCheckoutMandate(`${artifact.slice(0, -1)}~~${artifact}`, verificationOptions(checkout)),
    "artifact_malformed"
  );

  const content: ClosedCheckoutMandateContent = {
    vct: "mandate.checkout.1",
    checkout_jwt: checkout.artifact,
    checkout_hash: checkout.checkoutHash,
    iat: FIXED_NOW + 10,
    exp: FIXED_NOW + 300,
  };
  const unknownHeader = await issueRawRoot(content, "checkout", { crit: ["sompi"] });
  await assertRejectCode(
    () => verifyClosedCheckoutMandate(unknownHeader, verificationOptions(checkout)),
    "profile_mismatch"
  );
});

test("Checkout Mandate rejects VCT, exact Checkout hash, byte, field, and time substitutions", async () => {
  const checkout = await fixedVerifiedCheckout();
  const base: ClosedCheckoutMandateContent = {
    vct: "mandate.checkout.1",
    checkout_jwt: checkout.artifact,
    checkout_hash: checkout.checkoutHash,
    iat: FIXED_NOW + 10,
    exp: FIXED_NOW + 300,
  };
  const cases: Array<{ content: Record<string, unknown>; code: Ap2AdapterError["code"] }> = [
    { content: { ...base, vct: "mandate.checkout.open.1" }, code: "schema_invalid" },
    { content: { ...base, checkout_hash: "A".repeat(43) }, code: "binding_mismatch" },
    { content: { ...base, checkout_jwt: `${checkout.artifact}x` }, code: "binding_mismatch" },
    { content: { ...base, extra: true }, code: "profile_mismatch" },
    { content: { ...base, exp: FIXED_NOW + 301 }, code: "time_invalid" },
  ];
  for (const candidate of cases) {
    const artifact = await issueRawRoot(candidate.content, "checkout");
    await assertRejectCode(
      () => verifyClosedCheckoutMandate(artifact, verificationOptions(checkout)),
      candidate.code
    );
  }
});

test("Payment Mandate fails closed on amount, network, instrument, payee, and transaction substitutions", async () => {
  const checkout = await fixedVerifiedCheckout();
  const validArtifact = await issueClosedPaymentMandate({
    checkout,
    instrumentId: FIXED_INSTRUMENT_ID,
    issuedAtSec: FIXED_NOW + 10,
    expiresAtSec: FIXED_NOW + 300,
  }, AUTHORITY_SIGNER);
  const valid = await verifyClosedPaymentMandate(validArtifact, verificationOptions(checkout));
  const base = valid.content;
  const cases: Array<{ content: Record<string, unknown>; code: Ap2AdapterError["code"] }> = [
    {
      content: { ...base, payment_amount: { ...base.payment_amount, amount: 9007199254740992 } },
      code: "binding_mismatch",
    },
    {
      content: { ...base, payment_instrument: { ...base.payment_instrument, network: "kaspa:mainnet" } },
      code: "profile_mismatch",
    },
    {
      content: { ...base, payment_instrument: { ...base.payment_instrument, type: "card" } },
      code: "profile_mismatch",
    },
    {
      content: { ...base, payee: { ...base.payee, id: "merchant:other" } },
      code: "binding_mismatch",
    },
    { content: { ...base, transaction_id: "A".repeat(43) }, code: "binding_mismatch" },
    { content: { ...base, pisp: { domain_name: "unexpected.example" } }, code: "profile_mismatch" },
  ];
  for (const candidate of cases) {
    const artifact = await issueRawRoot(candidate.content, "payment");
    await assertRejectCode(
      () => verifyClosedPaymentMandate(artifact, verificationOptions(checkout)),
      candidate.code
    );
  }
});

test("paired verification rejects independently valid mandates from different ceremonies", async () => {
  const checkout = await fixedVerifiedCheckout();
  const checkoutMandate = await issueClosedCheckoutMandate({
    checkout,
    issuedAtSec: FIXED_NOW + 10,
    expiresAtSec: FIXED_NOW + 300,
  }, AUTHORITY_SIGNER);
  const paymentMandate = await issueClosedPaymentMandate({
    checkout,
    instrumentId: FIXED_INSTRUMENT_ID,
    issuedAtSec: FIXED_NOW + 11,
    expiresAtSec: FIXED_NOW + 300,
  }, AUTHORITY_SIGNER);
  await assertRejectCode(
    () => verifyHumanPresentMandates({ checkoutMandate, paymentMandate }, verificationOptions(checkout)),
    "binding_mismatch"
  );
});

async function issueRawRoot(
  content: object,
  kind: "checkout" | "payment",
  extraHeader: Record<string, unknown> = {}
): Promise<string> {
  const instance = new SDJwtInstance<Record<string, unknown>>({
    omitTyp: true,
    hashAlg: "sha-256",
    hasher: sha256Hasher,
    saltGenerator: randomSalt,
    signAlg: "ES256",
    signer: sdJwtSigner(AUTHORITY_SIGNER),
  });
  const payload = { delegate_payload: [content] };
  const frame = kind === "checkout"
    ? { delegate_payload: { _sd: [0], 0: { _sd: ["checkout_jwt"] } } }
    : { delegate_payload: { _sd: [0] } };
  return instance.issue(payload, frame as never, {
    header: { kid: AUTHORITY_SIGNER.kid, ...extraHeader },
  });
}

function verificationOptions(checkout: VerifiedMerchantCheckout) {
  return {
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    checkout,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    nowSec: FIXED_NOW + 11,
  };
}

function tamperIssuerSignature(artifact: string): string {
  const [issuer, ...rest] = artifact.split("~");
  const [header, payload, signature] = issuer.split(".");
  const replacement = signature[0] === "A" ? "B" : "A";
  return `${header}.${payload}.${replacement}${signature.slice(1)}~${rest.join("~")}`;
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
