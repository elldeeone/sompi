import * as assert from "node:assert/strict";
import test from "node:test";

import { encodePaymentRequiredHeader } from "@kaspa-x402/core";

import type {
  ChainEvidenceFinalitySelector,
  ChainEvidenceOperation,
  ProtocolFinality,
} from "../../chain-evidence/types.js";
import { evidenceDigest } from "../../purchase/identity.js";
import { KaspaStagingRecoveryModule } from "./staging-recovery-module.js";

const STAGING_TX = "11".repeat(32);
const PAY_TO = "kaspatest:merchant";
const EVIDENCE = evidenceDigest("staging-evidence");
const FINALITY: ChainEvidenceFinalitySelector = Object.freeze({
  selectFinality(
    operation: ChainEvidenceOperation,
    protocolFinality: ProtocolFinality,
  ) {
    return Object.freeze({
      operation,
      protocolFinality,
      operatorFloor: "accepted" as const,
      effectiveFloor: protocolFinality === "confirmed"
        ? "depth-confirmed" as const
        : "accepted" as const,
      depthConfirmationDaa: "10",
    });
  },
});

test("alpha.9 standard-native requirements reach abandoned-staging recovery", async () => {
  let calls = 0;
  const required = paymentRequired("standard-native", "accepted");
  const paymentRequirements = Buffer.from(
    encodePaymentRequiredHeader(required as never),
    "ascii",
  );
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
          paymentRequirementsDigest: evidenceDigest(paymentRequirements),
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
    finality: FINALITY,
  });
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
    paymentRequirements,
    stagingEvidenceDigest: EVIDENCE,
    authorizedAdditionalCostCeilingAtomic: "10",
  });
  assert.equal(calls, 1);
});

test("staging recovery rejects a valid but cross-paired PAYMENT-REQUIRED artifact", async () => {
  const canonical = Buffer.from(
    encodePaymentRequiredHeader(paymentRequired("standard-native", "confirmed") as never),
    "ascii",
  );
  const substituted = Buffer.from(
    encodePaymentRequiredHeader(paymentRequired("additive", "accepted") as never),
    "ascii",
  );
  const module = new KaspaStagingRecoveryModule({
    recovery: { prepare: async () => { throw new Error("must not prepare"); } } as never,
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
          paymentRequirementsDigest: evidenceDigest(canonical),
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
    finality: FINALITY,
  });
  await assert.rejects(
    module.prepare({
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
      paymentRequirements: substituted,
      stagingEvidenceDigest: EVIDENCE,
      authorizedAdditionalCostCeilingAtomic: "10",
    }),
    /signed staging metadata/,
  );
});

function paymentRequired(profile: "standard-native" | "additive", finality: "accepted" | "confirmed") {
  return {
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
        profile,
        finality,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        payToScriptPublicKey: "000051",
        assetKind: "native",
        assetDecimals: 8,
        ...(profile === "additive" ? {
          templateId: "kaspa-x402-kip10-additive-v1",
          headId: "11".repeat(32),
          expectedHeadOutpoint: { txid: "22".repeat(32), index: 0 },
          headAmount: "1000",
          headVersion: "0",
          headScriptPublicKey: "000051",
          headRedeemScript: "51",
          challengeId: "33".repeat(32),
          challengeExpiresAt: "2099-01-01T00:00:00.000Z",
          additiveThresholdSompi: "1",
          paymentOutputIndex: 0,
        } : {}),
      },
    }],
  } as const;
}
