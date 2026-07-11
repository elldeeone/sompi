import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  fixedTrustStore,
} from "../adapters/ap2/test-fixtures.js";
import type { JournalObservedStagingSource } from "../adapters/kaspa-x402/exact-attempt-funding-bridge.js";
import type { TreasuryStagingMetadataSource } from "../adapters/kaspa-x402/vault-treasury-staging.js";
import {
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
} from "../purchase/identity.js";
import { PurchaseJournal } from "../purchase/journal.js";
import {
  JournalAp2CommerceEvidenceSource,
  JournalChainTreasuryMetadataSource,
  JournalSourceError,
} from "./journal-sources.js";

test("AP2 source distinguishes absent state from an unavailable journal", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-source-closed-"));
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: () => 1_800_000_000_000,
  });
  const source = new JournalAp2CommerceEvidenceSource({
    journal,
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    now: () => 1_800_000_000_000,
  });
  journal.close();
  try {
    await assert.rejects(
      source.load(createPurchaseId(Buffer.alloc(16, 8))),
      (error: unknown) =>
        error instanceof JournalSourceError &&
        /commerce state is unavailable/.test(error.message)
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("staging fee source rechecks its deadline after asynchronous evidence reads", async () => {
  let now = 1_000;
  const purchaseId = createPurchaseId(Buffer.alloc(16, 9));
  const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
  const transactionId = "44".repeat(32);
  const digest = evidenceDigest("staging-observation");
  const metadata: TreasuryStagingMetadataSource = {
    async read() {
      now = 2_000;
      return {
        purchaseId,
        paymentIdentifier,
        envelopeDigest: evidenceDigest("staging-envelope"),
        paymentRequirementsDigest: evidenceDigest("payment-requirements"),
        priceAtomic: "100",
        additionalCostCeilingAtomic: "20",
        additiveThresholdAtomic: "10",
        exactFeeAtomic: "2",
        transactionId,
        outpoint: `${transactionId}:0`,
        stagingAmountAtomic: "112",
        stagingFeeAtomic: "3",
        keyReference: `stg_v1_${"A".repeat(43)}`,
        address: "kaspatest:staging",
        publicKey: "55".repeat(32),
        scriptPublicKey: `0000${"66".repeat(34)}`,
      };
    },
  };
  const observed: JournalObservedStagingSource = {
    async read() {
      return {
        purchaseId,
        paymentIdentifier,
        transactionId,
        outpoint: `${transactionId}:0`,
        amountAtomic: "112",
        address: "kaspatest:staging",
        scriptPublicKey: `0000${"66".repeat(34)}`,
        blockDaaScore: "1",
        evidenceDigest: digest,
      };
    },
  };
  const source = new JournalChainTreasuryMetadataSource(
    metadata,
    observed,
    () => now
  );
  await assert.rejects(
    source.actualTransactionFeeAtomic({
      purchaseId,
      paymentIdentifier,
      transactionId: transactionId as never,
      outpoint: `${transactionId}:0`,
      amountAtomic: "112",
      evidenceDigest: digest,
      deadlineAtMs: 2_000,
      signal: new AbortController().signal,
    }),
    /deadline expired/
  );
});
