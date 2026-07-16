import assert from "node:assert/strict";
import test from "node:test";

import {
  encodePaymentRequiredHeader,
  paymentIdentifierExtension,
} from "@kaspa-x402/core";

import {
  Ap2MerchantCheckoutVerifier,
  SOMPI_CHECKOUT_HEADER,
} from "../adapters/ap2/merchant-checkout-verifier.js";
import { issueMerchantCheckout } from "../adapters/ap2/merchant-checkout.js";
import {
  FIXED_AUDIENCE,
  FIXED_MERCHANT_ISSUER,
  FIXED_NOW,
  MERCHANT_SIGNER,
  fixedMerchantClaims,
  fixedTrustStore,
} from "../adapters/ap2/test-fixtures.js";
import { KaspaX402PaymentRequirementsVerifier } from "../adapters/kaspa-x402/payment-requirements-verifier.js";
import type { PurchaseEgressSession } from "./coordinator.js";
import { EgressPolicy } from "./egress-policy.js";
import { evidenceDigest, requestFingerprint } from "./identity.js";
import { SompiCheckoutTermsModule } from "./checkout-terms-module.js";

const URL = "https://merchant.example/resource";
const PURCHASE_ID = "pur_AAAAAAAAAAAAAAAAAAAAAA";
const PAY_TO = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";

test("Sompi composes independent AP2 Checkout and Kaspa-x402 requirements verification", async () => {
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

test("Sompi checkout composition rejects duplicated headers and requirements substitution", async () => {
  const duplicate = await checkoutFixture({ duplicateCheckout: true });
  await assert.rejects(
    duplicate.module.discover({
      purchaseId: PURCHASE_ID as never,
      resourceFingerprint: duplicate.fingerprint,
      egress: duplicate.egress,
    }),
    /exactly one SOMPI-CHECKOUT/
  );

  const substituted = await checkoutFixture({ substituteAmount: true });
  await assert.rejects(
    substituted.module.discover({
      purchaseId: PURCHASE_ID as never,
      resourceFingerprint: substituted.fingerprint,
      egress: substituted.egress,
    }),
    /does not match the signed Checkout Terms/
  );
});

test("Checkout discovery aborts a handle-free pending transport at its deadline", async () => {
  const stalled = await checkoutFixture({
    stallTransport: true,
    // The module clock is one second ahead of the fixture policy clock.
    requestTimeoutMs: 1_005,
  });
  await assert.rejects(
    stalled.module.discover({
      purchaseId: PURCHASE_ID as never,
      resourceFingerprint: stalled.fingerprint,
      egress: stalled.egress,
    }),
    /Checkout discovery deadline exceeded/
  );
  assert.equal(stalled.transportWasAborted(), true);
});

async function checkoutFixture(options: {
  duplicateCheckout?: boolean;
  substituteAmount?: boolean;
  stallTransport?: boolean;
  requestTimeoutMs?: number;
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
    payment_requirements: {
      digest: evidenceDigest(paymentHeader),
    },
  }, MERCHANT_SIGNER, { nowSec: FIXED_NOW });
  const policy = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    limits: options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs },
    now: () => FIXED_NOW * 1_000,
  });
  const request = await policy.validateRequest({ url: URL, method: "GET" });
  const egress: PurchaseEgressSession = Object.freeze({
    request,
    requestFor: (
      input: Parameters<PurchaseEgressSession["requestFor"]>[0]
    ) => policy.validateRequest(input),
    redirect: (
      previous: Parameters<PurchaseEgressSession["redirect"]>[0],
      location: string,
      override?: Parameters<PurchaseEgressSession["redirect"]>[2]
    ) => policy.validateRedirect(previous, location, override),
    responseGuard: (
      hop: Parameters<PurchaseEgressSession["responseGuard"]>[0],
      abort: Parameters<PurchaseEgressSession["responseGuard"]>[1]
    ) => policy.createResponseGuard(hop, abort),
  });
  const headers: Array<readonly [string, string]> = [
    [SOMPI_CHECKOUT_HEADER, checkoutArtifact],
    ["PAYMENT-REQUIRED", paymentHeader],
  ];
  if (options.duplicateCheckout) headers.push([SOMPI_CHECKOUT_HEADER, checkoutArtifact]);
  let transportAborted = false;
  const module = new SompiCheckoutTermsModule({
    merchantCheckout: new Ap2MerchantCheckoutVerifier({
      trust: fixedTrustStore(),
      authorityAudience: FIXED_AUDIENCE,
    }),
    paymentRequirements: new KaspaX402PaymentRequirementsVerifier(),
    now: () => (FIXED_NOW + 1) * 1_000,
    transport: {
      async send(request) {
        if (options.stallTransport) {
          return await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              transportAborted = true;
              reject(request.signal.reason);
            }, { once: true });
          });
        }
        return {
          status: 402,
          headers,
          body: (async function* () { yield Buffer.from("payment required"); })(),
        };
      },
    },
  });
  return {
    module,
    egress,
    fingerprint,
    paymentHeader,
    transportWasAborted: () => transportAborted,
  };
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
        binding: "kaspa-exact-v2",
        profile: "standard-native",
        finality: "accepted",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        payToScriptPublicKey: "000051",
        assetKind: "native",
        assetDecimals: 8,
      },
    }],
    extensions: {
      "payment-identifier": paymentIdentifierExtension({ required: true }),
    },
  };
}
