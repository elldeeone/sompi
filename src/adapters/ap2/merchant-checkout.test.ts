import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SignJWT, type JWTPayload } from "jose";
import { Ap2AdapterError } from "./errors.js";
import { importSigningKey, LocalAp2TrustStore } from "./crypto.js";
import { issueMerchantCheckout, verifyMerchantCheckout } from "./merchant-checkout.js";
import {
  FIXED_AUDIENCE,
  FIXED_MERCHANT_ISSUER,
  FIXED_NOW,
  FIXED_PURCHASE_ID,
  MERCHANT_SIGNER,
  fixedMerchantClaims,
  fixedTrustStore,
} from "./test-fixtures.js";
import type { MerchantCheckoutClaims } from "./types.js";

test("fixed Merchant Checkout key verifies exact bytes into canonical Sompi terms", async () => {
  const claims = fixedMerchantClaims();
  const artifact = await issueMerchantCheckout(claims, MERCHANT_SIGNER, { nowSec: FIXED_NOW });
  const verified = await verifyMerchantCheckout(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_ISSUER,
    expectedAudience: FIXED_AUDIENCE,
    expectedPurchaseId: FIXED_PURCHASE_ID as never,
    expectedResourceFingerprint: claims.resource.request_fingerprint as never,
    expectedPaymentRequirementsDigest: claims.payment_requirements.digest as never,
    nowSec: FIXED_NOW + 1,
  });

  assert.equal(verified.purchaseId, FIXED_PURCHASE_ID);
  assert.equal(verified.terms.amountAtomic, "20000000");
  assert.equal(verified.terms.asset, "KAS");
  assert.equal(verified.terms.network, "kaspa:testnet-10");
  assert.equal(verified.terms.resourceFingerprint, claims.resource.request_fingerprint);
  assert.equal(verified.additionalCostCeilingAtomic, "1500000");
  assert.equal(
    verified.checkoutHash,
    createHash("sha256").update(Buffer.from(artifact, "utf8")).digest("base64url")
  );
  assert.equal(verified.checkoutDigest, `sha256:${verified.checkoutHash}`);
  assert.equal(verified.profile, "urn:sompi:checkout:single-resource:2");
  assert.deepEqual(Object.keys(verified.claims.payment_requirements), ["digest"]);
  assert.equal("x402" in verified.claims, false);
});

test("Merchant Checkout cleanly rejects the replaced protocol-specific profile", async () => {
  const claims = fixedMerchantClaims();
  const key = await importSigningKey(MERCHANT_SIGNER);
  const legacy = {
    ...claims,
    profile: "urn:sompi:checkout:single-resource:1",
    x402: {
      version: 2,
      scheme: "exact",
      binding: "sompi-purchase-and-digest-correlation-v1",
      payment_requirements_digest: claims.payment_requirements.digest,
    },
  } as Record<string, unknown>;
  delete legacy.payment_requirements;
  const artifact = await new SignJWT(legacy as JWTPayload)
    .setProtectedHeader({ alg: "ES256", kid: MERCHANT_SIGNER.kid, typ: "JWT" })
    .sign(key);
  await assertRejectCode(() => verify(artifact), "profile_mismatch");
});

test("Merchant Checkout fails closed on unknown signed fields and protected key sources", async () => {
  const claims = fixedMerchantClaims();
  const key = await importSigningKey(MERCHANT_SIGNER);
  const unknownClaim = await new SignJWT({ ...claims, surprise: true } as unknown as JWTPayload)
    .setProtectedHeader({ alg: "ES256", kid: MERCHANT_SIGNER.kid, typ: "JWT" })
    .sign(key);
  await assertRejectCode(() => verify(unknownClaim), "profile_mismatch");

  const remoteKeyHeader = await new SignJWT(claims as unknown as JWTPayload)
    .setProtectedHeader({
      alg: "ES256",
      kid: MERCHANT_SIGNER.kid,
      typ: "JWT",
      jku: "https://attacker.example/jwks.json",
    })
    .sign(key);
  await assertRejectCode(() => verify(remoteKeyHeader), "profile_mismatch");
});

test("Merchant Checkout rejects untrusted keys, signature tampering, and exact-byte suffixes", async () => {
  const claims = fixedMerchantClaims();
  const artifact = await issueMerchantCheckout(claims, MERCHANT_SIGNER, { nowSec: FIXED_NOW });

  await assertRejectCode(() => verify(artifact, new LocalAp2TrustStore([])), "untrusted_key");
  const parts = artifact.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  const tampered = parts.join(".");
  await assertRejectCode(() => verify(tampered), "signature_invalid");
  await assertRejectCode(() => verify(`${artifact} `), "artifact_malformed");
});

test("Merchant Checkout rejects network, amount, request, and time substitutions before signing", async () => {
  const base = fixedMerchantClaims();
  const cases: MerchantCheckoutClaims[] = [
    { ...base, price: { ...base.price, network: "kaspa:mainnet" as never } },
    { ...base, price: { ...base.price, amount_atomic: "9007199254740992" } },
    { ...base, resource: { ...base.resource, method: "post" } },
    { ...base, exp: base.iat + 301 },
  ];
  for (const candidate of cases) {
    await assert.rejects(
      () => issueMerchantCheckout(candidate, MERCHANT_SIGNER, { nowSec: FIXED_NOW }),
      Ap2AdapterError
    );
  }
});

test("Merchant Checkout verification binds the configured issuer, audience, and Purchase", async () => {
  const artifact = await issueMerchantCheckout(fixedMerchantClaims(), MERCHANT_SIGNER, { nowSec: FIXED_NOW });
  await assertRejectCode(() => verifyMerchantCheckout(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: "https://other.example",
    expectedAudience: FIXED_AUDIENCE,
    nowSec: FIXED_NOW + 1,
  }), "untrusted_key");
  await assertRejectCode(() => verifyMerchantCheckout(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_ISSUER,
    expectedAudience: "urn:other:audience",
    nowSec: FIXED_NOW + 1,
  }), "time_invalid");
  await assertRejectCode(() => verifyMerchantCheckout(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_ISSUER,
    expectedAudience: FIXED_AUDIENCE,
    expectedPurchaseId: "pur_BBBBBBBBBBBBBBBBBBBBBB" as never,
    nowSec: FIXED_NOW + 1,
  }), "binding_mismatch");
});

function verify(artifact: string, trust = fixedTrustStore()) {
  return verifyMerchantCheckout(artifact, {
    trust,
    expectedIssuer: FIXED_MERCHANT_ISSUER,
    expectedAudience: FIXED_AUDIENCE,
    nowSec: FIXED_NOW + 1,
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
