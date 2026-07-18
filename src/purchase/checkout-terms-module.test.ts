import assert from "node:assert/strict";
import test from "node:test";

import {
  encodePaymentRequiredHeader,
  paymentIdentifierExtension,
} from "@kaspa-x402/core";

import {
  FIXED_NOW,
} from "../adapters/ap2/authority-test-fixtures.js";
import { KaspaX402PaymentRequirementsVerifier } from "../adapters/kaspa-x402/payment-requirements-verifier.js";
import type { PurchaseEgressSession } from "./coordinator.js";
import { EgressPolicy } from "./egress-policy.js";
import { evidenceDigest, requestFingerprint } from "./identity.js";
import { SompiCheckoutTermsModule } from "./checkout-terms-module.js";

const URL = "https://merchant.example/resource";
const PURCHASE_ID = "pur_AAAAAAAAAAAAAAAAAAAAAA";
const PAY_TO = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";

test("Sompi derives canonical Checkout Terms from generic Kaspa-x402 requirements", async () => {
  const fixture = await checkoutFixture();
  const discovered = await fixture.module.discover({
    purchaseId: PURCHASE_ID as never,
    resourceFingerprint: fixture.fingerprint,
    egress: fixture.egress,
  });
  assert.equal(discovered.terms.merchant.id, "https://merchant.example");
  assert.equal(discovered.terms.merchant.origin, "https://merchant.example");
  assert.equal(discovered.terms.amountAtomic, "20000000");
  assert.equal(discovered.terms.payTo, PAY_TO);
  assert.equal(discovered.checkoutEvidence.declaredDigest, discovered.terms.checkoutDigest);
  assert.equal(discovered.paymentRequirements.declaredDigest, evidenceDigest(fixture.paymentHeader));
  assert.equal(discovered.checkoutEvidence.declaredDigest, discovered.paymentRequirements.declaredDigest);
});

test("Sompi checkout composition rejects duplicated requirements and resource substitution", async () => {
  const duplicate = await checkoutFixture({ duplicatePaymentRequired: true });
  await assert.rejects(
    duplicate.module.discover({
      purchaseId: PURCHASE_ID as never,
      resourceFingerprint: duplicate.fingerprint,
      egress: duplicate.egress,
    }),
    /exactly one PAYMENT-REQUIRED/
  );

  const substituted = await checkoutFixture({ substituteResource: true });
  await assert.rejects(
    substituted.module.discover({
      purchaseId: PURCHASE_ID as never,
      resourceFingerprint: substituted.fingerprint,
      egress: substituted.egress,
    }),
    /resource does not match/
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
  duplicatePaymentRequired?: boolean;
  substituteResource?: boolean;
  stallTransport?: boolean;
  requestTimeoutMs?: number;
} = {}) {
  const fingerprint = requestFingerprint({ url: URL, method: "GET" });
  const paymentRequired = paymentRequiredWire("20000000", options.substituteResource);
  const paymentHeader = encodePaymentRequiredHeader(paymentRequired as never);
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
    ["PAYMENT-REQUIRED", paymentHeader],
  ];
  if (options.duplicatePaymentRequired) headers.push(["PAYMENT-REQUIRED", paymentHeader]);
  let transportAborted = false;
  const module = new SompiCheckoutTermsModule({
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

function paymentRequiredWire(amount: string, substituteResource = false) {
  return {
    x402Version: 2,
    resource: {
      url: substituteResource ? "https://merchant.example/other" : URL,
      mimeType: "application/octet-stream",
    },
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
