import assert from "node:assert/strict";
import test from "node:test";

import {
  encodePaymentRequiredHeader,
  paymentIdentifierExtension,
} from "@kaspa-x402/core";

import { EgressPolicy } from "../../purchase/egress-policy.js";
import { evidenceDigest, requestFingerprint } from "../../purchase/identity.js";
import type { PurchaseEgressSession } from "../../purchase/coordinator.js";
import {
  FIXED_AUDIENCE,
  FIXED_MERCHANT_ISSUER,
  FIXED_NOW,
  MERCHANT_SIGNER,
  fixedMerchantClaims,
  fixedTrustStore,
} from "./test-fixtures.js";
import { issueMerchantCheckout } from "./merchant-checkout.js";
import { Ap2CheckoutTermsModule, SOMPI_CHECKOUT_HEADER } from "./checkout-terms-module.js";

const URL = "https://merchant.example/resource";
const PURCHASE_ID = "pur_AAAAAAAAAAAAAAAAAAAAAA";
const PAY_TO = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";

test("Checkout discovery verifies one Merchant AP2 JWT against one exact PAYMENT-REQUIRED", async () => {
  const fixture = await checkoutFixture();
  const discovered = await fixture.module.discover({
    purchaseId: PURCHASE_ID as never,
    resourceFingerprint: fixture.fingerprint,
    egress: fixture.egress,
  });
  assert.equal(discovered.terms.merchant.id, FIXED_MERCHANT_ISSUER);
  assert.equal(discovered.terms.amountAtomic, "20000000");
  assert.equal(discovered.terms.payTo, PAY_TO);
  assert.equal(discovered.checkoutEvidence.declaredDigest, discovered.terms.checkoutDigest);
  assert.equal(discovered.paymentRequirements.declaredDigest, evidenceDigest(fixture.paymentHeader));
});

test("Checkout discovery rejects duplicated headers and requirements substitution", async () => {
  const duplicate = await checkoutFixture({ duplicateCheckout: true });
  await assert.rejects(
    duplicate.module.discover({
      purchaseId: PURCHASE_ID as never,
      resourceFingerprint: duplicate.fingerprint,
      egress: duplicate.egress,
    }),
    /exactly one SOMPI-CHECKOUT/,
  );

  const substituted = await checkoutFixture({ substituteAmount: true });
  await assert.rejects(
    substituted.module.discover({
      purchaseId: PURCHASE_ID as never,
      resourceFingerprint: substituted.fingerprint,
      egress: substituted.egress,
    }),
    /Payment Requirements digest does not match|does not match the signed AP2 Checkout/,
  );
});

async function checkoutFixture(options: {
  duplicateCheckout?: boolean;
  substituteAmount?: boolean;
} = {}) {
  const fingerprint = requestFingerprint({ url: URL, method: "GET" });
  const paymentRequired = paymentRequiredWire(options.substituteAmount ? "20000001" : "20000000");
  const paymentHeader = encodePaymentRequiredHeader(paymentRequired as never);
  const claims = fixedMerchantClaims();
  const checkoutArtifact = await issueMerchantCheckout({
    ...claims,
    iat: FIXED_NOW,
    exp: FIXED_NOW + 300,
    purchase_id: PURCHASE_ID,
    merchant: {
      ...claims.merchant,
      id: FIXED_MERCHANT_ISSUER,
      origin: FIXED_MERCHANT_ISSUER,
      website: `${FIXED_MERCHANT_ISSUER}/store`,
    },
    resource: {
      url: URL,
      method: "GET",
      request_fingerprint: fingerprint,
    },
    price: { ...claims.price, pay_to: PAY_TO },
    x402: {
      ...claims.x402,
      payment_requirements_digest: evidenceDigest(paymentHeader),
    },
  }, MERCHANT_SIGNER, { nowSec: FIXED_NOW });
  const policy = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => FIXED_NOW * 1_000,
  });
  const request = await policy.validateRequest({ url: URL, method: "GET" });
  const egress: PurchaseEgressSession = Object.freeze({
    request,
    redirect: (
      previous: Parameters<PurchaseEgressSession["redirect"]>[0],
      location: string,
      override?: Parameters<PurchaseEgressSession["redirect"]>[2],
    ) => policy.validateRedirect(previous, location, override),
    responseGuard: (
      hop: Parameters<PurchaseEgressSession["responseGuard"]>[0],
      abort: Parameters<PurchaseEgressSession["responseGuard"]>[1],
    ) => policy.createResponseGuard(hop, abort),
  });
  const headers: Array<readonly [string, string]> = [
    [SOMPI_CHECKOUT_HEADER, checkoutArtifact],
    ["PAYMENT-REQUIRED", paymentHeader],
  ];
  if (options.duplicateCheckout) headers.push([SOMPI_CHECKOUT_HEADER, checkoutArtifact]);
  const module = new Ap2CheckoutTermsModule({
    trust: fixedTrustStore(),
    authorityAudience: FIXED_AUDIENCE,
    now: () => (FIXED_NOW + 1) * 1_000,
    transport: {
      async send() {
        return {
          status: 402,
          headers,
          body: (async function* () { yield Buffer.from("payment required"); })(),
        };
      },
    },
  });
  return { module, egress, fingerprint, paymentHeader };
}

function paymentRequiredWire(amount: string) {
  return {
    x402Version: 2,
    resource: { url: URL, mimeType: "application/octet-stream" },
    accepts: [{
      scheme: "exact",
      network: "kaspa:testnet-10",
      amount,
      asset: "KAS",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: {
        binding: "kaspa-exact-v1",
        finality: "accepted",
        templateId: "kaspa-x402-kip10-additive-v1",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        borrowOutpoint: { txid: "44".repeat(32), index: 0 },
        borrowAmount: "100000000",
        borrowScriptPublicKey: "000051",
        borrowRedeemScript: "51",
        additiveThresholdSompi: "1000000",
        paymentOutputIndex: 1,
        reservationId: "55".repeat(32),
        reservationExpiresAt: "2099-01-01T00:00:00.000Z",
        assetKind: "native",
        assetDecimals: 8,
      },
    }],
    extensions: {
      "payment-identifier": paymentIdentifierExtension({ required: true }),
    },
  };
}
