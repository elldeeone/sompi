import * as assert from "node:assert/strict";
import test from "node:test";

import { encodePaymentRequiredHeader } from "@kaspa-x402/core";

import { evidenceDigest } from "../../purchase/identity.js";
import { KaspaStagingRecoveryModule } from "./staging-recovery-module.js";

const STAGING_TX = "11".repeat(32);
const PAY_TO = "kaspatest:merchant";
const EVIDENCE = evidenceDigest("staging-evidence");

test("alpha.8 standard-native requirements reach abandoned-staging recovery", async () => {
  let calls = 0;
  const module = new KaspaStagingRecoveryModule({
    recovery: {
      async prepare() {
        calls += 1;
        return {
          preparedBytes: Uint8Array.of(1),
          preparedDigest: evidenceDigest("prepared-recovery"),
          transactionId: "22".repeat(32),
          recoveryAmountAtomic: "109",
          feeAtomic: "1",
        };
      },
    } as never,
    metadata: {
      async read() {
        return {
          transactionId: STAGING_TX,
          outpoint: `${STAGING_TX}:0`,
          stagingAmountAtomic: "110",
          address: "kaspatest:staging",
          scriptPublicKey: "000051",
          additionalCostCeilingAtomic: "10",
          priceAtomic: "100",
          keyReference: "key:test",
          stagingFeeAtomic: "1",
        };
      },
    } as never,
    observedStaging: {
      async read() {
        return {
          transactionId: STAGING_TX,
          outpoint: `${STAGING_TX}:0`,
          amountAtomic: "110",
          address: "kaspatest:staging",
          scriptPublicKey: "000051",
          blockDaaScore: "123",
          evidenceDigest: EVIDENCE,
        };
      },
    } as never,
    finalityFloor: "accepted",
  });
  const required = {
    x402Version: 2,
    resource: { url: "https://merchant.example/resource" },
    accepts: [{
      scheme: "exact",
      network: "kaspa:testnet-10",
      amount: "100",
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
  } as const;
  await module.prepare({
    purchaseId: "pur_AQEBAQEBAQEBAQEBAQEBAQ" as never,
    paymentIdentifier: "pay_test" as never,
    terms: {
      merchant: { id: "merchant:test", name: "Merchant", origin: "https://merchant.example" },
      resourceFingerprint: evidenceDigest("resource"),
      amountAtomic: "100",
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: PAY_TO,
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest: evidenceDigest("checkout"),
    },
    paymentRequirements: Buffer.from(encodePaymentRequiredHeader(required as never), "ascii"),
    stagingEvidenceDigest: EVIDENCE,
    authorizedAdditionalCostCeilingAtomic: "10",
  });
  assert.equal(calls, 1);
});
