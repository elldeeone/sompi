import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertLiveAdditiveContentionReport,
  liveAdditiveContentionReportDigest,
  type LiveAdditiveContentionReport,
} from "./live-testnet-additive-contention.js";

test("additive contention report binds one winner, one absent loser, and a fresh explicit retry", () => {
  const report = fixture();
  assert.doesNotThrow(() => assertLiveAdditiveContentionReport(report));
  assert.match(liveAdditiveContentionReportDigest(report), /^[a-f0-9]{64}$/);

  const sameTransaction = structuredClone(report);
  (sameTransaction.candidates[1] as any).transactionId = report.candidates[0].transactionId;
  assert.throws(
    () => assertLiveAdditiveContentionReport(sameTransaction),
    /invariants changed/
  );

  const reusedStaging = structuredClone(report);
  (reusedStaging.explicitRetry as any).stagingOutpoint = report.candidates[1].stagingOutpoint;
  assert.throws(
    () => assertLiveAdditiveContentionReport(reusedStaging),
    /invariants changed/
  );

  for (const field of ["purchaseId", "paymentIdentifier", "requestHash"] as const) {
    const reusedAuthorization = structuredClone(report);
    (reusedAuthorization.explicitRetry as any)[field] = report.candidates[0][field];
    assert.throws(
      () => assertLiveAdditiveContentionReport(reusedAuthorization),
      /invariants changed/
    );
  }

  const collidingInitialAuthorization = structuredClone(report);
  (collidingInitialAuthorization.candidates[1] as any).purchaseId = report.candidates[0].purchaseId;
  assert.throws(
    () => assertLiveAdditiveContentionReport(collidingInitialAuthorization),
    /invariants changed/
  );

  const missingAbsence = structuredClone(report);
  (missingAbsence.loser as any).operatorObservation = "unknown";
  assert.throws(
    () => assertLiveAdditiveContentionReport(missingAbsence),
    /invariants changed/
  );

  const malformedStagingOutpoint = structuredClone(report);
  (malformedStagingOutpoint.candidates[0] as any).stagingOutpoint = `not-a-txid:0`;
  assert.throws(
    () => assertLiveAdditiveContentionReport(malformedStagingOutpoint),
    /candidate evidence is invalid/
  );

  const brokenInitialLineage = structuredClone(report);
  (brokenInitialLineage.initialHead as any).outpoint = `${"ab".repeat(32)}:0`;
  assert.throws(
    () => assertLiveAdditiveContentionReport(brokenInitialLineage),
    /invariants changed/
  );

  const invalidInitialAddress = structuredClone(report);
  (invalidInitialAddress.initialHead as any).address = "kaspatest:not-a-real-address";
  assert.throws(
    () => assertLiveAdditiveContentionReport(invalidInitialAddress),
    /initial head evidence is invalid/
  );

  const wrongNetwork = structuredClone(report);
  (wrongNetwork as any).network = "kaspa:mainnet";
  assert.throws(
    () => assertLiveAdditiveContentionReport(wrongNetwork),
    /invariants changed/
  );

  const brokenCandidateLineage = structuredClone(report);
  (brokenCandidateLineage.candidates[1] as any).headVersion = "1";
  assert.throws(
    () => assertLiveAdditiveContentionReport(brokenCandidateLineage),
    /invariants changed/
  );

  const brokenWinnerSuccessor = structuredClone(report);
  (brokenWinnerSuccessor.winner as any).successorOutpoint = `${"ac".repeat(32)}:0`;
  assert.throws(
    () => assertLiveAdditiveContentionReport(brokenWinnerSuccessor),
    /invariants changed/
  );

  const brokenRetryPrior = structuredClone(report);
  (brokenRetryPrior.explicitRetry as any).priorHeadOutpoint = `${"ad".repeat(32)}:0`;
  assert.throws(
    () => assertLiveAdditiveContentionReport(brokenRetryPrior),
    /invariants changed/
  );

  const brokenRetryVersion = structuredClone(report);
  (brokenRetryVersion.explicitRetry as any).headVersion = "2";
  assert.throws(
    () => assertLiveAdditiveContentionReport(brokenRetryVersion),
    /invariants changed/
  );

  const brokenRetryAmount = structuredClone(report);
  (brokenRetryAmount.explicitRetry as any).headAmountAtomic = "120000001";
  assert.throws(
    () => assertLiveAdditiveContentionReport(brokenRetryAmount),
    /invariants changed/
  );

  const brokenRetrySuccessor = structuredClone(report);
  (brokenRetrySuccessor.explicitRetry as any).successorOutpoint = `${"ae".repeat(32)}:0`;
  assert.throws(
    () => assertLiveAdditiveContentionReport(brokenRetrySuccessor),
    /invariants changed/
  );

  const secret = structuredClone(report);
  (secret as any).nodeUrl = "ws://private-node";
  assert.throws(
    () => assertLiveAdditiveContentionReport(secret),
    /private state/
  );
});

function fixture(): LiveAdditiveContentionReport {
  const firstTx = "11".repeat(32);
  const secondTx = "22".repeat(32);
  const retryTx = "33".repeat(32);
  const initialTx = "44".repeat(32);
  const firstStaging = "55".repeat(32);
  const secondStaging = "66".repeat(32);
  const retryStaging = "77".repeat(32);
  const candidate = (
    label: "first" | "second" | "retry",
    transactionId: string,
    stagingTx: string,
    headTx: string,
    headVersion: string,
    headAmountAtomic: string
  ) => Object.freeze({
    label,
    purchaseId: label === "first"
      ? "pur_AAAAAAAAAAAAAAAAAAAAAA"
      : label === "second"
        ? "pur_BBBBBBBBBBBBBBBBBBBBBB"
        : "pur_CCCCCCCCCCCCCCCCCCCCCC",
    paymentIdentifier: `pay_${label === "first" ? "D" : label === "second" ? "E" : "F"}${"a".repeat(42)}`,
    requestHash: label === "first" ? "88".repeat(32) : label === "second" ? "99".repeat(32) : "aa".repeat(32),
    stagingOutpoint: `${stagingTx}:0`,
    transactionId,
    transactionFeeAtomic: "2000000",
    transactionMass: "1282",
    headOutpoint: `${headTx}:0`,
    headVersion,
    headAmountAtomic,
  });
  const first = candidate("first", firstTx, firstStaging, initialTx, "0", "100000000");
  const second = candidate("second", secondTx, secondStaging, initialTx, "0", "100000000");
  const retry = candidate("retry", retryTx, retryStaging, firstTx, "1", "120000000");
  return Object.freeze({
    profile: "urn:sompi:e2e:live-testnet10-additive-contention:1",
    generatedAt: "2026-07-17T00:00:00.000Z",
    network: "kaspa:testnet-10",
    chainProvenance: Object.freeze({
      nodeVersion: "rusty-kaspad 2.0.1",
      nodeNetwork: "testnet-10",
      nodeVirtualDaaScore: "516000000",
      nodeSynced: true,
      nodeUtxoIndex: true,
    }),
    protocol: Object.freeze({
      binding: "kaspa-exact-v2",
      exactProfile: "additive",
      packageVersion: "0.1.0-alpha.9",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    }),
    initialHead: Object.freeze({
      transactionId: initialTx,
      outpoint: `${initialTx}:0`,
      address: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
      amountAtomic: "100000000",
      blockDaaScore: "515999000",
      virtualDaaScore: "516000000",
      finality: "confirmed",
      observationStartHash: "bb".repeat(32),
      acceptingBlockHash: "cc".repeat(32),
      acceptingBlockDaaScore: "515999001",
      headId: "dd".repeat(32),
      version: "0",
    }),
    candidates: Object.freeze([first, second] as const),
    winner: Object.freeze({
      label: "first",
      transactionId: firstTx,
      status: 200,
      successorOutpoint: `${firstTx}:0`,
      successorAmountAtomic: "120000000",
      merchantGainAtomic: "20000000",
      successorBlockDaaScore: "516000010",
      successorVirtualDaaScore: "516000011",
      successorFinality: "accepted",
    }),
    loser: Object.freeze({
      label: "second",
      transactionId: secondTx,
      status: 402,
      correctiveHeadOutpoint: `${firstTx}:0`,
      correctiveHeadVersion: "1",
      operatorObservation: "absent",
      witnessObservation: "absent",
      operatorEvidenceDigest: `sha256:${"A".repeat(43)}`,
      witnessEvidenceDigest: `sha256:${"B".repeat(43)}`,
      stagingOutpointStillUnspent: true,
    }),
    explicitRetry: Object.freeze({
      ...retry,
      status: 200,
      priorHeadOutpoint: `${firstTx}:0`,
      successorOutpoint: `${retryTx}:0`,
      successorAmountAtomic: "140000000",
      successorBlockDaaScore: "516000020",
      successorVirtualDaaScore: "516000021",
      successorFinality: "accepted",
      separatelyAuthorized: true,
    }),
    assertions: Object.freeze({
      bothCandidatesSignedBeforeFirstSubmission: true,
      oneWinner: true,
      loserPaidNothing: true,
      unansweredOffersConsumedNoHead: true,
      correctiveOfferAdvancedHead: true,
      trustedAbsenceBeforeRetry: true,
      retryUsedFreshStagingAndAuthorization: true,
      noAutomaticCorrectiveResigning: true,
    }),
  });
}
