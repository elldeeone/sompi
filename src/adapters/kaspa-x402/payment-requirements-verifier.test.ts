import * as assert from "node:assert/strict";
import test from "node:test";

import { encodePaymentRequiredHeader } from "@kaspa-x402/core";

import { evidenceDigest } from "../../purchase/identity.js";
import { KaspaX402PaymentRequirementsVerifier } from "./payment-requirements-verifier.js";

test("exact PAYMENT-REQUIRED rejects multiple offers before authorization or signing", async () => {
  const url = "https://merchant.example/resource";
  const payTo = "kaspatest:merchant";
  const offer = {
    scheme: "exact",
    network: "kaspa:testnet-10",
    amount: "100",
    asset: "KAS",
    payTo,
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
  } as const;
  const required = {
    x402Version: 2,
    resource: { url },
    accepts: [offer, { ...offer, maxTimeoutSeconds: 61 }],
  } as const;
  const artifact = Buffer.from(encodePaymentRequiredHeader(required as never), "ascii");
  await assert.rejects(new KaspaX402PaymentRequirementsVerifier().verify({
    artifact,
    expectedDigest: evidenceDigest(artifact),
    resourceFingerprint: evidenceDigest("resource"),
    finalHop: {
      url,
      requestFingerprint: evidenceDigest("resource"),
    } as never,
    nowMs: 1_800_000_000_000,
  }), /exactly one/);
});
