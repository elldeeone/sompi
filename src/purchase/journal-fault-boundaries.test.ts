import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type {
  PreparedTreasuryOperation,
  TreasuryDriverLease,
  TreasuryOperationIntent,
} from "../treasury/operation-journal.js";
import { authorizationFactsDigest } from "./contracts.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "./identity.js";
import {
  JOURNAL_FAULT_POINTS,
  PURCHASE_RECEIPT_PROFILE,
  TREASURY_STAGING_EVIDENCE_KIND,
  JournalNotFoundError,
  PurchaseJournal,
  type BindCheckoutTermsInput,
  type BatchChannelJournalRecord,
  type JournalFaultPoint,
  type LeaseToken,
  type PlanTreasuryStagingInput,
  type PlanTreasuryStagingRecoveryInput,
  type PolicyReservationInput,
  type PolicySnapshotRecord,
  type PreparePaymentAttemptInput,
  type RecordAuthorizationDecisionInput,
  type RecordAuthorizationRequestInput,
  type RecordFulfilmentInput,
  type RecordPurchaseSettlementInput,
  type RecordObservedTreasuryStagingInput,
  type RecordReceiptInput,
  type RecordTreasuryStagingRecoveryObservationInput,
} from "./journal.js";
import type { PurchaseId, Sha256Digest } from "./types.js";
import type { TransferAuthorizationFacts, TransferAuthorityDecision, TransferReceipt } from "../transfer/types.js";
import type { TreasuryOperationView } from "../treasury/operations.js";

interface TestClock {
  value: number;
  now(): number;
}

interface FaultBoundaryScenario {
  act(journal: PurchaseJournal): unknown;
  assertRolledBack(journal: PurchaseJournal): void;
  assertCommitted(journal: PurchaseJournal): void;
}

type FaultBoundaryScenarioFactory = (
  journal: PurchaseJournal,
  clock: TestClock
) => FaultBoundaryScenario;

const FAULT_BOUNDARY_SCENARIOS = {
  "purchase.after_insert": purchaseInsertScenario,
  "purchase_transition.after_state_update": purchaseTransitionScenario,
  "evidence.after_metadata_insert": evidenceInsertScenario,
  "policy.after_snapshot_insert": policyInsertScenario,
  "reservation.after_insert": reservationInsertScenario,
  "payment_attempt.after_insert": paymentAttemptInsertScenario,
  "payment_preparation.after_insert": paymentPreparationScenario,
  "treasury_staging_plan.after_insert": treasuryStagingPlanScenario,
  "treasury_staging_observation.after_insert": treasuryStagingObservationScenario,
  "treasury_staging_recovery_plan.after_insert": stagingRecoveryPlanScenario,
  "treasury_staging_recovery_observation.after_insert": stagingRecoveryObservationScenario,
  "treasury_staging_recovery_accounting.after_insert": stagingRecoveryAccountingScenario,
  "effect.after_insert": effectInsertScenario,
  "effect_claim.after_effect_update": effectClaimScenario,
  "settlement.after_insert": spendInsertScenario,
  "checkout_terms.after_insert": checkoutTermsScenario,
  "authorization_request.after_insert": authorizationRequestScenario,
  "authorization_decision.after_insert": authorizationDecisionScenario,
  "fulfilment.after_insert": fulfilmentScenario,
  "receipt.after_insert": receiptScenario,
  "treasury_operation.after_intent_insert": treasuryIntentScenario,
  "treasury_operation.after_prepared_update": treasuryPreparationScenario,
  "treasury_operation.after_submission_plan": treasurySubmissionPlanScenario,
  "treasury_operation.after_observation_insert": treasuryObservationScenario,
  "treasury_operation.after_complete_update": treasuryCompletionScenario,
  "batch_channel.after_insert": batchChannelInsertScenario,
  "batch_channel.after_update": batchChannelUpdateScenario,
  "batch_movement.after_insert": batchMovementInsertScenario,
  "transfer.after_insert": transferInsertScenario,
  "transfer_transition.after_state_update": transferTransitionScenario,
  "transfer_authorization.after_insert": transferAuthorizationScenario,
  "transfer_treasury_bind.after_update": transferTreasuryBindScenario,
  "transfer_treasury_sync.after_update": transferTreasurySyncScenario,
  "transfer_receipt.after_insert": transferReceiptScenario,
} satisfies Readonly<Record<JournalFaultPoint, FaultBoundaryScenarioFactory>>;

test("fault-boundary scenario manifest exactly covers every declared Journal fault point", () => {
  assert.deepEqual(
    Object.keys(FAULT_BOUNDARY_SCENARIOS).sort(),
    [...JOURNAL_FAULT_POINTS].sort()
  );
  assert.equal(JOURNAL_FAULT_POINTS.length, 34);
});

test("every Journal fault point rolls back atomically and its exact action recovers after restart", () => {
  for (const point of JOURNAL_FAULT_POINTS) {
    assertFaultBoundary(point, FAULT_BOUNDARY_SCENARIOS[point]);
  }
});

test("an unsupported non-execution claim cannot release an effect-capable Treasury operation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-non-execution-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const clock = testClock();
  let journal: PurchaseJournal | undefined;
  try {
    journal = openJournal(filename, evidenceDirectory, clock);
    const setup = treasuryOperationSetup(journal, 90, "prepared");
    assert.ok(setup.driver);
    assert.equal(
      journal.planTreasuryOperationSubmission(setup.intent.operationKey, setup.driver),
      true,
    );
    assert.equal(
      journal.claimTreasuryOperationEffectCapability(setup.intent.operationKey, setup.driver),
      true,
    );
    assert.throws(
      () => journal!.recordTreasuryOperationObservation(
        setup.intent.operationKey,
        "not_submitted",
        { status: "not_submitted", transactionId: setup.prepared.transactionId },
        setup.driver,
        "proven_not_executed" as never,
      ),
      /submission outcome is invalid/,
    );
    const retained = journal.requireTreasuryOperation(setup.intent.operationKey);
    assert.equal(retained.state, "submission_planned");
    assert.equal(retained.submissionInFlight, true);
    assert.equal(retained.effectCapabilityGeneration, setup.driver.generation);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
    journal.close();

    journal = openJournal(filename, evidenceDirectory, clock);
    const restarted = journal.requireTreasuryOperation(setup.intent.operationKey);
    assert.equal(restarted.state, "submission_planned");
    assert.equal(restarted.submissionInFlight, true);
    assert.equal(restarted.effectCapabilityGeneration, setup.driver.generation);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
  } finally {
    try {
      journal?.close();
    } catch {
      // Preserve the primary regression assertion.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function assertFaultBoundary(
  point: JournalFaultPoint,
  factory: FaultBoundaryScenarioFactory
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-boundary-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const clock = testClock();
  let journal: PurchaseJournal | undefined;
  try {
    journal = openJournal(filename, evidenceDirectory, clock);
    const scenario = factory(journal, clock);
    journal.close();

    let injections = 0;
    journal = openJournal(filename, evidenceDirectory, clock, (candidate) => {
      if (candidate !== point) return;
      injections += 1;
      throw new Error(`fault-boundary:${candidate}`);
    });
    assert.throws(
      () => scenario.act(journal!),
      (error: unknown) =>
        error instanceof Error && error.message === `fault-boundary:${point}`,
      point
    );
    assert.equal(injections, 1, `${point} did not reach its declared injection seam exactly once`);
    assert.equal(journal.integrityCheck(), true, `${point} damaged the open Journal`);
    journal.close();

    journal = openJournal(filename, evidenceDirectory, clock);
    scenario.assertRolledBack(journal);
    assert.equal(journal.integrityCheck(), true, `${point} did not restart cleanly after rollback`);
    scenario.act(journal);
    scenario.assertCommitted(journal);
    assert.equal(journal.integrityCheck(), true, `${point} retry did not commit coherently`);
    journal.close();

    journal = openJournal(filename, evidenceDirectory, clock);
    scenario.assertCommitted(journal);
    assert.equal(journal.integrityCheck(), true, `${point} committed state did not survive restart`);
  } finally {
    try {
      journal?.close();
    } catch {
      // Preserve the primary boundary assertion.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function purchaseInsertScenario(): FaultBoundaryScenario {
  const input = purchaseInput(1);
  return {
    act: (journal) => journal.createPurchase(input),
    assertRolledBack(journal) {
      assert.equal(journal.findPurchase(input.id), undefined);
    },
    assertCommitted(journal) {
      assert.equal(journal.requirePurchase(input.id).state, "created");
      assert.deepEqual(journal.transitions(input.id).map((entry) => entry.toState), ["created"]);
    },
  };
}

const TRANSFER_ID = "trf_0123456789ABCDEFGHIJKL";
const TRANSFER_ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const MANIFEST = Object.freeze({ revision: 1, digest: `sha256:${"M".repeat(43)}` });

function transferInsertScenario(journal: PurchaseJournal, clock: TestClock): FaultBoundaryScenario {
  const input = transferInput(journal, clock);
  return {
    act: (target) => target.claimTransferIntent(input),
    assertRolledBack(target) { assert.equal(target.findTransfer(input.id), undefined); },
    assertCommitted(target) { assert.equal(target.requireTransfer(input.id).state, "created"); },
  };
}

function transferTransitionScenario(journal: PurchaseJournal, clock: TestClock): FaultBoundaryScenario {
  journal.claimTransferIntent(transferInput(journal, clock));
  return {
    act: (target) => target.transitionTransfer(TRANSFER_ID, "awaiting_authority", "authority_requested"),
    assertRolledBack(target) { assert.equal(target.requireTransfer(TRANSFER_ID).state, "created"); },
    assertCommitted(target) { assert.equal(target.requireTransfer(TRANSFER_ID).state, "awaiting_authority"); },
  };
}

function transferAuthorizationScenario(journal: PurchaseJournal, clock: TestClock): FaultBoundaryScenario {
  const setup = awaitingTransfer(journal, clock);
  return {
    act: (target) => target.recordTransferAuthorization(TRANSFER_ID, setup.facts, setup.decision),
    assertRolledBack(target) {
      assert.equal(target.findTransferAuthorization(TRANSFER_ID), undefined);
      assert.equal(target.requireTransfer(TRANSFER_ID).state, "awaiting_authority");
    },
    assertCommitted(target) {
      assert.equal(target.requireTransferAuthorization(TRANSFER_ID).decision, "approved");
      assert.equal(target.requireTransfer(TRANSFER_ID).state, "authorised");
    },
  };
}

function transferTreasuryBindScenario(journal: PurchaseJournal, clock: TestClock): FaultBoundaryScenario {
  approvedTransfer(journal, clock);
  return {
    act: (target) => target.bindTransferTreasuryOperation(TRANSFER_ID, `transfer:${TRANSFER_ID}`),
    assertRolledBack(target) {
      assert.equal(target.requireTransfer(TRANSFER_ID).treasuryOperationKey, undefined);
      assert.equal(target.requireTransfer(TRANSFER_ID).state, "authorised");
    },
    assertCommitted(target) {
      assert.equal(target.requireTransfer(TRANSFER_ID).treasuryOperationKey, `transfer:${TRANSFER_ID}`);
      assert.equal(target.requireTransfer(TRANSFER_ID).state, "funds_reserved");
    },
  };
}

function transferTreasurySyncScenario(journal: PurchaseJournal, clock: TestClock): FaultBoundaryScenario {
  boundTransfer(journal, clock);
  const operation = transferTreasuryView("submitted");
  return {
    act: (target) => target.syncTransferTreasuryOperation(TRANSFER_ID, operation),
    assertRolledBack(target) {
      const transfer = target.requireTransfer(TRANSFER_ID);
      assert.equal(transfer.state, "funds_reserved");
      assert.equal(transfer.transactionId, undefined);
    },
    assertCommitted(target) {
      const transfer = target.requireTransfer(TRANSFER_ID);
      assert.equal(transfer.state, "submitted");
      assert.equal(transfer.transactionId, operation.transactionId);
    },
  };
}

function transferReceiptScenario(journal: PurchaseJournal, clock: TestClock): FaultBoundaryScenario {
  boundTransfer(journal, clock);
  journal.syncTransferTreasuryOperation(TRANSFER_ID, transferTreasuryView("completed"));
  const receipt: TransferReceipt = Object.freeze({
    profile: "urn:sompi:receipt:transfer:1", transferId: TRANSFER_ID, requestKey: "fault:transfer:one",
    destination: TRANSFER_ADDRESS, amountAtomic: "100", feeAtomic: "10", network: "kaspa:testnet-10",
    fundingSource: "vault-treasury", fundingSummary: "Sent securely from your protected Sompi wallet.", transactionId: "ab".repeat(32), finality: "accepted",
    settledAt: new Date(clock.value).toISOString(),
  });
  return {
    act: (target) => target.recordTransferReceipt(TRANSFER_ID, receipt),
    assertRolledBack(target) {
      assert.equal(target.findTransferReceipt(TRANSFER_ID), undefined);
      assert.equal(target.requireTransfer(TRANSFER_ID).state, "settled");
    },
    assertCommitted(target) {
      assert.equal(target.findTransferReceipt(TRANSFER_ID)?.transactionId, receipt.transactionId);
      assert.equal(target.requireTransfer(TRANSFER_ID).state, "receipted");
    },
  };
}

function transferInput(journal: PurchaseJournal, clock: TestClock) {
  const policy = ensurePolicy(journal);
  return {
    id: TRANSFER_ID, requestKey: "fault:transfer:one", requestDigest: evidenceDigest("transfer-intent"),
    destination: TRANSFER_ADDRESS, amountAtomic: "100", sourceVaultAddress: TRANSFER_ADDRESS,
    sourceVaultDigest: evidenceDigest("vault"), feeCeilingAtomic: "10", maximumTotalAtomic: "110",
    expiresAtMs: clock.value + 60_000, policyDigest: policy.digest,
    manifestRevision: MANIFEST.revision, manifestDigest: MANIFEST.digest, finalityFloor: "accepted" as const,
  };
}

function awaitingTransfer(journal: PurchaseJournal, clock: TestClock) {
  const transfer = journal.claimTransferIntent(transferInput(journal, clock));
  journal.transitionTransfer(transfer.id, "awaiting_authority", "authority_requested");
  const facts: TransferAuthorizationFacts = Object.freeze({
    profile: "sompi.transfer.1", transferId: transfer.id, requestKey: transfer.requestKey,
    sourceVaultAddress: transfer.sourceVaultAddress, sourceVaultDigest: transfer.sourceVaultDigest,
    destination: transfer.destination, amountAtomic: transfer.amountAtomic, asset: "KAS", network: "kaspa:testnet-10",
    feeCeilingAtomic: transfer.feeCeilingAtomic, maximumTotalAtomic: transfer.maximumTotalAtomic,
    issuedAt: new Date(transfer.createdAtMs).toISOString(), expiresAt: new Date(transfer.expiresAtMs).toISOString(),
    policyDigest: transfer.policyDigest,
    operatorManifestRevision: transfer.manifestRevision, operatorManifestDigest: transfer.manifestDigest,
    finalityFloor: transfer.finalityFloor,
  });
  const evidence = Uint8Array.from(Buffer.from("transfer-authority-evidence", "utf8"));
  const decision: TransferAuthorityDecision = Object.freeze({
    decision: "approved", authorityId: "fault-authority", evidence,
    evidenceDigest: evidenceDigest(evidence), factsDigest: evidenceDigest(JSON.stringify(facts)),
    verificationProfile: "urn:sompi:authority-decision:transfer:1", verifierId: "fault-verifier",
    decidedAtMs: clock.value,
  });
  return { facts, decision };
}

function approvedTransfer(journal: PurchaseJournal, clock: TestClock): void {
  const setup = awaitingTransfer(journal, clock);
  journal.recordTransferAuthorization(TRANSFER_ID, setup.facts, setup.decision);
}

function boundTransfer(journal: PurchaseJournal, clock: TestClock): void {
  approvedTransfer(journal, clock);
  journal.bindTransferTreasuryOperation(TRANSFER_ID, `transfer:${TRANSFER_ID}`);
}

function transferTreasuryView(state: "submitted" | "completed"): TreasuryOperationView {
  return Object.freeze({
    operationKey: `transfer:${TRANSFER_ID}`, kind: "vault_send", state,
    summary: state, destination: TRANSFER_ADDRESS, requestedAmountAtomic: "100", feeCeilingAtomic: "10",
    amountAtomic: "100", feeAtomic: "10", transactionId: "ab".repeat(32), retryCount: 0,
    recoveryRequired: false, safeToRetry: false, cancellationRequested: false, preparationFenced: true,
  });
}

function purchaseTransitionScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const purchase = createPurchase(journal, 2);
  return {
    act: (target) =>
      target.transitionPurchase(
        purchase.id,
        "created",
        "cancelled",
        "fault_boundary_cancelled"
      ),
    assertRolledBack(target) {
      assert.equal(target.requirePurchase(purchase.id).state, "created");
      assert.deepEqual(target.transitions(purchase.id).map((entry) => entry.toState), ["created"]);
    },
    assertCommitted(target) {
      assert.equal(target.requirePurchase(purchase.id).state, "cancelled");
      assert.deepEqual(target.transitions(purchase.id).map((entry) => entry.toState), [
        "created",
        "cancelled",
      ]);
    },
  };
}

function evidenceInsertScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const purchase = createPurchase(journal, 3);
  const bytes = Buffer.from("fault-boundary-evidence", "utf8");
  const digest = evidenceDigest(bytes);
  return {
    act: (target) =>
      target.storeEvidence(purchase.id, {
        bytes,
        mediaType: "application/octet-stream",
        profile: "test-evidence-v1",
        issuer: "test-issuer",
        kind: "fault-boundary-evidence",
      }),
    assertRolledBack(target) {
      assert.equal(target.findEvidence(digest), undefined);
      assert.deepEqual(target.evidenceLinks(purchase.id), []);
    },
    assertCommitted(target) {
      assert.equal(target.requireEvidence(digest).byteLength, bytes.byteLength);
      assert.deepEqual(target.evidenceLinks(purchase.id).map((entry) => entry.digest), [digest]);
    },
  };
}

function policyInsertScenario(): FaultBoundaryScenario {
  return {
    act: (journal) => journal.installPolicy(policyDefinition()),
    assertRolledBack(journal) {
      assert.throws(() => journal.requireActivePolicy());
      assert.equal(journal.policyCapacityUsed(), 0n);
    },
    assertCommitted(journal) {
      assert.deepEqual(policyFacts(journal.requireActivePolicy()), policyDefinition());
      assert.equal(journal.policyCapacityUsed(), 0n);
    },
  };
}

function reservationInsertScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const purchaseId = authorizePurchase(journal, 5);
  const policy = journal.installPolicy(policyDefinition());
  const input = reservationInput(
    journal,
    purchaseId,
    policy,
    "fault-reservation",
    clock.value
  );
  return {
    act: (target) => target.reservePolicy(input),
    assertRolledBack(target) {
      assert.throws(() => target.requireReservation(input.id), JournalNotFoundError);
      assert.equal(target.policyCapacityUsed(), 0n);
    },
    assertCommitted(target) {
      assert.equal(target.requireReservation(input.id).state, "active");
      assert.equal(target.policyCapacityUsed(), 70n);
    },
  };
}

function paymentAttemptInsertScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const purchaseId = authorizePurchase(journal, 6);
  const input = {
    purchaseId,
    attempt: 1,
    identifier: createPaymentIdentifier(purchaseId, 1),
  } as const;
  return {
    act: (target) => target.createPaymentAttempt(input),
    assertRolledBack(target) {
      assert.throws(() => target.requirePaymentAttempt(purchaseId, 1), JournalNotFoundError);
    },
    assertCommitted(target) {
      assert.equal(target.requirePaymentAttempt(purchaseId, 1).state, "planned");
    },
  };
}

function paymentPreparationScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = paymentPreparationSetup(journal, 7, clock.value);
  return {
    act: (target) => target.preparePaymentAttempt(setup.input),
    assertRolledBack(target) {
      assert.equal(target.requirePaymentAttempt(setup.purchaseId, 1).state, "planned");
      assert.equal(target.requireReservation(setup.reservationId).state, "active");
      assert.throws(
        () => target.requirePaymentPreparation(setup.purchaseId, 1),
        JournalNotFoundError
      );
    },
    assertCommitted(target) {
      assert.equal(target.requirePaymentAttempt(setup.purchaseId, 1).state, "prepared");
      assert.equal(
        target.requirePaymentPreparation(setup.purchaseId, 1).payloadDigest,
        setup.input.payloadDigest
      );
      assert.deepEqual(target.readPreparedPayment(setup.purchaseId, 1), setup.input.preparedBytes);
    },
  };
}

function treasuryStagingPlanScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = treasuryStagingPlanSetup(journal, 8, clock.value);
  return {
    act: (target) => target.planTreasuryStaging(setup.input),
    assertRolledBack(target) {
      assert.equal(target.treasuryStagingRecoveryContext(setup.purchaseId, 1), undefined);
      assert.equal(target.requireReservation(setup.reservationId).state, "active");
      assert.deepEqual(
        target.effectsForPurchase(setup.purchaseId).map((effect) => effect.kind),
        []
      );
    },
    assertCommitted(target) {
      const context = target.treasuryStagingRecoveryContext(setup.purchaseId, 1);
      assert.ok(context);
      assert.equal(context.effect.state, "planned");
      assert.equal(context.reservation.state, "active");
      assert.deepEqual(
        target.readPreparedTreasuryStaging(setup.purchaseId, 1),
        setup.input.preparedBytes
      );
    },
  };
}

function treasuryStagingObservationScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = observedTreasuryStagingSetup(journal, 9, clock.value, false);
  return {
    act: (target) => target.recordObservedTreasuryStaging(setup.lease, setup.observationInput),
    assertRolledBack(target) {
      assert.equal(target.findTreasuryStagingObservation(setup.purchaseId, 1), undefined);
      assert.equal(target.requireEffect(setup.stagingEffectId).state, "executing");
      assert.equal(target.requireReservation(setup.reservationId).state, "in_flight");
      assert.deepEqual(target.effectObservations(setup.stagingEffectId), []);
    },
    assertCommitted(target) {
      assert.equal(
        target.findTreasuryStagingObservation(setup.purchaseId, 1)?.outpoint,
        setup.observationInput.outpoint
      );
      assert.equal(target.requireEffect(setup.stagingEffectId).state, "observed");
      assert.equal(target.requireReservation(setup.reservationId).state, "in_flight");
      assert.equal(target.effectObservations(setup.stagingEffectId).length, 1);
    },
  };
}

function stagingRecoveryPlanScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = stagingRecoveryPlanSetup(journal, 10, clock.value);
  return {
    act: (target) => target.planTreasuryStagingRecovery(setup.input),
    assertRolledBack(target) {
      assert.equal(target.findTreasuryStagingRecoveryPlan(setup.purchaseId, 1), undefined);
      assert.equal(target.requireEffect(setup.stagingEffectId).state, "observed");
      assert.equal(target.requireReservation(setup.reservationId).state, "in_flight");
      assert.equal(target.requirePaymentAttempt(setup.purchaseId, 1).state, "planned");
      assert.equal(target.requirePurchase(setup.purchaseId).state, "failed_recoverable");
      assert.equal(
        target.effectsForPurchase(setup.purchaseId).filter((effect) =>
          effect.kind === "treasury-staging-recovery"
        ).length,
        0
      );
    },
    assertCommitted(target) {
      const plan = target.requireTreasuryStagingRecoveryPlan(setup.purchaseId, 1);
      assert.equal(plan.recoveryTransactionId, setup.input.recoveryTransactionId);
      assert.equal(target.requireEffect(plan.effectId).state, "planned");
      assert.deepEqual(
        target.readPreparedTreasuryStagingRecovery(setup.purchaseId, 1),
        setup.input.preparedBytes
      );
    },
  };
}

function stagingRecoveryObservationScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = stagingRecoveryObservationSetup(journal, 11, clock.value);
  const input: RecordTreasuryStagingRecoveryObservationInput = {
    status: "pending",
    evidenceDigest: evidenceDigest("recovery-pending-11"),
  };
  return {
    act: (target) =>
      target.recordTreasuryStagingRecoveryObservation(
        setup.recoveryEffectId,
        setup.lease,
        input
      ),
    assertRolledBack(target) {
      const context = target.treasuryStagingRecoveryJournalContext(setup.purchaseId, 1);
      assert.ok(context);
      assert.deepEqual(context.observations, []);
      assert.equal(context.effect.state, "executing");
      assert.equal(context.accounting, undefined);
    },
    assertCommitted(target) {
      const context = target.treasuryStagingRecoveryJournalContext(setup.purchaseId, 1);
      assert.ok(context);
      assert.equal(context.observations.length, 1);
      assert.equal(context.observations[0]?.status, "pending");
      assert.equal(context.effect.state, "ambiguous");
      assert.equal(context.accounting, undefined);
    },
  };
}

function stagingRecoveryAccountingScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = stagingRecoveryObservationSetup(journal, 12, clock.value);
  const input: RecordTreasuryStagingRecoveryObservationInput = {
    status: "recovery_won",
    evidenceDigest: evidenceDigest("recovery-finality-12"),
    winningTransactionId: setup.recoveryInput.recoveryTransactionId,
    winningFinality: "accepted",
    recoveryOutpoint: setup.recoveryInput.recoveryOutpoint,
    recoveryAmountAtomic: setup.recoveryInput.recoveryAmountAtomic,
  };
  return {
    act: (target) =>
      target.recordTreasuryStagingRecoveryObservation(
        setup.recoveryEffectId,
        setup.lease,
        input
      ),
    assertRolledBack(target) {
      const context = target.treasuryStagingRecoveryJournalContext(setup.purchaseId, 1);
      assert.ok(context);
      assert.deepEqual(context.observations, []);
      assert.equal(context.accounting, undefined);
      assert.equal(context.effect.state, "executing");
      assert.equal(context.attempt.state, "planned");
      assert.equal(context.reservation.state, "in_flight");
      assert.equal(target.requirePurchase(setup.purchaseId).state, "failed_recoverable");
    },
    assertCommitted(target) {
      const context = target.treasuryStagingRecoveryJournalContext(setup.purchaseId, 1);
      assert.ok(context?.accounting);
      assert.equal(context.accounting.recoveryTransactionId, input.winningTransactionId);
      assert.equal(context.observations.length, 1);
      assert.equal(context.effect.state, "observed");
      assert.equal(context.attempt.state, "failed");
      assert.equal(context.reservation.state, "released");
      assert.equal(target.requirePurchase(setup.purchaseId).state, "failed_terminal");
    },
  };
}

function effectInsertScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const purchaseId = authorizePurchase(journal, 13);
  const preparedBytes = Buffer.from("generic-effect-13", "utf8");
  const input = {
    purchaseId,
    kind: "fault-boundary-effect",
    idempotencyKey: "fault-boundary:effect:13",
    payloadDigest: evidenceDigest(preparedBytes),
    preparedBytes,
  } as const;
  return {
    act: (target) => target.planEffect(input),
    assertRolledBack(target) {
      assert.deepEqual(target.effectsForPurchase(purchaseId), []);
    },
    assertCommitted(target) {
      const effects = target.effectsForPurchase(purchaseId);
      assert.equal(effects.length, 1);
      assert.equal(effects[0]?.state, "planned");
      assert.equal(effects[0]?.payloadDigest, input.payloadDigest);
    },
  };
}

function effectClaimScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const purchaseId = authorizePurchase(journal, 14);
  const bytes = Buffer.from("effect-claim-14", "utf8");
  const effect = journal.planEffect({
    purchaseId,
    kind: "fault-boundary-claim",
    idempotencyKey: "fault-boundary:claim:14",
    payloadDigest: evidenceDigest(bytes),
    preparedBytes: bytes,
  });
  return {
    act: (target) => target.claimEffect(effect.id, "fault-boundary-holder", 60_000),
    assertRolledBack(target) {
      assert.equal(target.requireEffect(effect.id).state, "planned");
      assert.equal(target.effectTransitions(effect.id).length, 1);
    },
    assertCommitted(target) {
      assert.equal(target.requireEffect(effect.id).state, "executing");
      assert.equal(target.effectTransitions(effect.id).length, 2);
    },
  };
}

function spendInsertScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = submittedPaymentSetup(journal, 15, clock.value);
  return {
    act: (target) => target.recordPurchaseSettlement(setup.lease, setup.spendInput),
    assertRolledBack(target) {
      assert.equal(target.findSettlementForPurchase(setup.purchaseId), undefined);
      assert.equal(target.requireEffect(setup.effectId).state, "submitted");
      assert.equal(target.requirePaymentAttempt(setup.purchaseId, 1).state, "submitted");
      assert.equal(target.requireReservation(setup.reservationId).state, "in_flight");
      assert.deepEqual(target.effectObservations(setup.effectId), []);
    },
    assertCommitted(target) {
      assert.equal(
        target.findSettlementForPurchase(setup.purchaseId)?.transactionId,
        setup.spendInput.transactionId
      );
      assert.equal(target.requireEffect(setup.effectId).state, "observed");
      assert.equal(target.requirePaymentAttempt(setup.purchaseId, 1).state, "observed");
      assert.equal(target.requireReservation(setup.reservationId).state, "spent");
      assert.equal(target.effectObservations(setup.effectId).length, 1);
    },
  };
}

function checkoutTermsScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = checkoutTermsSetup(journal, 16);
  return {
    act: (target) => target.bindCheckoutTerms(setup.purchaseId, setup.input),
    assertRolledBack(target) {
      assert.equal(target.findCheckoutTerms(setup.purchaseId), undefined);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "created");
      assert.deepEqual(target.transitions(setup.purchaseId).map((entry) => entry.toState), [
        "created",
      ]);
    },
    assertCommitted(target) {
      assert.equal(target.requireCheckoutTerms(setup.purchaseId).checkoutDigest, setup.checkoutDigest);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "terms_bound");
    },
  };
}

function authorizationRequestScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = authorizationRequestSetup(journal, 17);
  return {
    act: (target) => target.recordAuthorizationRequest(setup.purchaseId, setup.input),
    assertRolledBack(target) {
      assert.equal(target.findAuthorizationRequest(setup.purchaseId), undefined);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "terms_bound");
    },
    assertCommitted(target) {
      assert.equal(
        target.requireAuthorizationRequest(setup.purchaseId).requestDigest,
        setup.input.requestDigest
      );
      assert.equal(target.requirePurchase(setup.purchaseId).state, "awaiting_authority");
    },
  };
}

function authorizationDecisionScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = authorizationDecisionSetup(journal, 18);
  return {
    act: (target) => target.recordAuthorizationDecision(setup.purchaseId, setup.input),
    assertRolledBack(target) {
      assert.equal(target.findAuthorization(setup.purchaseId), undefined);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "awaiting_authority");
    },
    assertCommitted(target) {
      assert.equal(target.requireAuthorization(setup.purchaseId).decision, "approved");
      assert.equal(target.requirePurchase(setup.purchaseId).state, "authorised");
    },
  };
}

function fulfilmentScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = fulfilmentSetup(journal, 19, clock.value, false);
  return {
    act: (target) => target.recordFulfilment(setup.purchaseId, setup.input),
    assertRolledBack(target) {
      assert.equal(target.findFulfilment(setup.purchaseId), undefined);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "settled");
      assert.deepEqual(target.receipts(setup.purchaseId), []);
    },
    assertCommitted(target) {
      assert.equal(target.requireFulfilment(setup.purchaseId).bodyDigest, setup.input.bodyDigest);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "fulfilled");
      assert.deepEqual(target.receipts(setup.purchaseId), []);
    },
  };
}

function receiptScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const setup = fulfilmentSetup(journal, 20, clock.value, true);
  const receipt = receiptInput(journal, setup.purchaseId, 20);
  return {
    act: (target) => target.recordReceipt(setup.purchaseId, receipt),
    assertRolledBack(target) {
      assert.deepEqual(target.receipts(setup.purchaseId), []);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "fulfilled");
    },
    assertCommitted(target) {
      const receipts = target.receipts(setup.purchaseId);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.evidenceDigest, receipt.evidenceDigest);
      assert.equal(target.requirePurchase(setup.purchaseId).state, "receipted");
    },
  };
}

function treasuryIntentScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = treasuryOperationSetup(journal, 21, "policy");
  return {
    act: (target) => target.claimTreasuryOperationIntent(setup.intent),
    assertRolledBack(target) {
      assert.throws(
        () => target.requireTreasuryOperation(setup.intent.operationKey),
        JournalNotFoundError
      );
      assert.equal(target.unresolvedTreasuryOperationCount(), 0);
      assert.equal(target.treasuryPolicyCapacityUsed(), 0n);
    },
    assertCommitted(target) {
      assert.equal(target.requireTreasuryOperation(setup.intent.operationKey).state, "intent");
      assert.equal(target.unresolvedTreasuryOperationCount(), 1);
      assert.equal(target.treasuryPolicyCapacityUsed(), 110n);
    },
  };
}

function treasuryPreparationScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = treasuryOperationSetup(journal, 22, "intent");
  return {
    act: (target) =>
      target.recordPreparedTreasuryOperation(setup.intent.operationKey, setup.prepared, setup.driver),
    assertRolledBack(target) {
      const operation = target.requireTreasuryOperation(setup.intent.operationKey);
      assert.equal(operation.state, "intent");
      assert.equal(operation.preparedDigest, undefined);
      assert.equal(operation.transactionId, undefined);
      assert.throws(() => target.readPreparedTreasuryOperation(setup.intent.operationKey));
    },
    assertCommitted(target) {
      const operation = target.requireTreasuryOperation(setup.intent.operationKey);
      assert.equal(operation.state, "prepared");
      assert.equal(operation.transactionId, setup.prepared.transactionId);
      assert.deepEqual(
        target.readPreparedTreasuryOperation(setup.intent.operationKey),
        setup.prepared.bytes
      );
    },
  };
}

function treasurySubmissionPlanScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = treasuryOperationSetup(journal, 23, "prepared");
  return {
    act: (target) => target.planTreasuryOperationSubmission(setup.intent.operationKey, setup.driver),
    assertRolledBack(target) {
      assert.equal(target.requireTreasuryOperation(setup.intent.operationKey).state, "prepared");
    },
    assertCommitted(target) {
      assert.equal(
        target.requireTreasuryOperation(setup.intent.operationKey).state,
        "submission_planned"
      );
    },
  };
}

function treasuryObservationScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = treasuryOperationSetup(journal, 24, "submitted");
  return {
    act: (target) =>
      target.recordTreasuryOperationObservation(
        setup.intent.operationKey,
        "observed",
        setup.observationDetail,
        setup.driver,
        "accepted",
      ),
    assertRolledBack(target) {
      assert.equal(target.requireTreasuryOperation(setup.intent.operationKey).state, "submitted");
      assert.throws(() => target.readObservedTreasuryOperationDetail(setup.intent.operationKey));
    },
    assertCommitted(target) {
      assert.equal(target.requireTreasuryOperation(setup.intent.operationKey).state, "observed");
      assert.deepEqual(
        target.readObservedTreasuryOperationDetail(setup.intent.operationKey),
        setup.observationDetail
      );
    },
  };
}

function treasuryCompletionScenario(journal: PurchaseJournal): FaultBoundaryScenario {
  const setup = treasuryOperationSetup(journal, 25, "observed");
  return {
    act: (target) => target.completeTreasuryOperation(setup.intent.operationKey, setup.driver),
    assertRolledBack(target) {
      const operation = target.requireTreasuryOperation(setup.intent.operationKey);
      assert.equal(operation.state, "observed");
      assert.equal(operation.completedAtMs, undefined);
      assert.deepEqual(
        target.readObservedTreasuryOperationDetail(setup.intent.operationKey),
        setup.observationDetail
      );
    },
    assertCommitted(target) {
      const operation = target.requireTreasuryOperation(setup.intent.operationKey);
      assert.equal(operation.state, "completed");
      assert.equal(typeof operation.completedAtMs, "number");
      assert.deepEqual(
        target.readObservedTreasuryOperationDetail(setup.intent.operationKey),
        setup.observationDetail
      );
    },
  };
}

function batchChannelInsertScenario(
  _journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const channel = batchChannel(clock, 26);
  return {
    act: (target) => target.saveBatchChannel(channel),
    assertRolledBack(target) {
      assert.throws(() => target.requireBatchChannel(channel.channelId), JournalNotFoundError);
    },
    assertCommitted(target) {
      assert.equal(target.requireBatchChannel(channel.channelId).version, 1);
    },
  };
}

function batchChannelUpdateScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const channel = journal.saveBatchChannel(batchChannel(clock, 27));
  const updated: BatchChannelJournalRecord = {
    ...channel,
    signedCumulativeAtomic: "10",
    latestVoucher: { amountAtomic: "10", signature: byte(27).repeat(64) },
    version: 2,
    updatedAtMs: clock.value + 1,
  };
  return {
    act: (target) => target.saveBatchChannel(updated),
    assertRolledBack(target) {
      assert.equal(target.requireBatchChannel(channel.channelId).signedCumulativeAtomic, "0");
      assert.equal(target.requireBatchChannel(channel.channelId).version, 1);
    },
    assertCommitted(target) {
      assert.equal(target.requireBatchChannel(channel.channelId).signedCumulativeAtomic, "10");
      assert.equal(target.requireBatchChannel(channel.channelId).version, 2);
    },
  };
}

function batchMovementInsertScenario(
  journal: PurchaseJournal,
  clock: TestClock
): FaultBoundaryScenario {
  const channel = journal.saveBatchChannel(batchChannel(clock, 28));
  const input = {
    movementId: `batch-deposit:${channel.channelId}`,
    channelId: channel.channelId,
    kind: "deposit",
    requestDigest: evidenceDigest(Buffer.from(`batch-deposit:${channel.channelId}`, "utf8")),
  } as const;
  return {
    act: (target) => target.planBatchTreasuryMovement(input),
    assertRolledBack(target) {
      assert.throws(() => target.requireBatchTreasuryMovement(input.movementId), JournalNotFoundError);
    },
    assertCommitted(target) {
      assert.equal(target.requireBatchTreasuryMovement(input.movementId).state, "planned");
    },
  };
}

function batchChannel(clock: TestClock, seed: number): BatchChannelJournalRecord {
  const hash = byte(seed).repeat(32);
  return {
    channelId: hash,
    origin: "https://merchant.example",
    resourceUrl: `https://merchant.example/batch/${seed}`,
    network: "kaspa:testnet-10",
    asset: "KAS",
    templateId: "kaspa-x402-escrow-v1",
    clientPublicKey: byte(seed + 1).repeat(32),
    serverPublicKey: byte(seed + 2).repeat(32),
    payTo: `kaspatest:batch-payee-${seed}`,
    refundAddress: `kaspatest:batch-refund-${seed}`,
    refundTimeoutDaa: "500000000",
    salt: byte(seed + 3).repeat(32),
    activeOutpoint: { txid: byte(seed + 4).repeat(32), index: 0 },
    activeScriptPublicKey: `000020${byte(seed + 5).repeat(32)}`,
    escrowAddress: `kaspatest:batch-escrow-${seed}`,
    fundingSource: "vault-treasury",
    fundingAmountAtomic: "1000",
    chargedCumulativeAtomic: "0",
    claimedCumulativeAtomic: "0",
    signedCumulativeAtomic: "0",
    status: "active",
    epoch: 0,
    version: 1,
    createdAtMs: clock.value,
    updatedAtMs: clock.value,
  };
}

function checkoutTermsSetup(journal: PurchaseJournal, seed: number): {
  purchaseId: PurchaseId;
  checkoutDigest: Sha256Digest;
  input: BindCheckoutTermsInput;
} {
  const purchase = createPurchase(journal, seed);
  const checkoutDigest = verifiedLinkedEvidence(
    journal,
    purchase.id,
    `checkout-${seed}`,
    "checkout-terms",
    undefined,
    "test-v1",
    "merchant:test"
  );
  const requirementsDigest = verifiedLinkedEvidence(
    journal,
    purchase.id,
    `requirements-${seed}`,
    "payment-requirements",
    undefined,
    "test-v1",
    "merchant:test"
  );
  const executionPlan = journal.storeExecutionPlanEvidence(purchase.id, {
    mechanism: "single-transaction",
    profile: "kaspa-exact-v2:standard-native",
    requirementsDigest,
    maximumChargeAtomic: "60",
    settlementAssurance: "accepted",
  });
  return {
    purchaseId: purchase.id,
    checkoutDigest,
    input: {
      terms: {
        merchant: {
          id: "merchant:test",
          name: "Test Merchant",
          origin: "https://merchant.example",
        },
        resourceFingerprint: purchase.resourceFingerprint,
        amountAtomic: "60",
        asset: "KAS",
        network: "kaspa:testnet-10",
        payTo: "kaspatest:merchant",
        expiresAt: "2099-01-01T00:00:00.000Z",
        checkoutDigest,
      },
      checkoutEvidenceDigest: checkoutDigest,
      checkoutVerificationProfile: "test-v1",
      checkoutVerifierId: "test-verifier",
      paymentRequirementsDigest: requirementsDigest,
      paymentRequirementsVerificationProfile: "test-v1",
      paymentRequirementsVerifierId: "test-verifier",
      executionPlan: executionPlan.plan,
      executionPlanEvidenceDigest: executionPlan.evidenceDigest,
    },
  };
}

function authorizationRequestSetup(journal: PurchaseJournal, seed: number): {
  purchaseId: PurchaseId;
  input: RecordAuthorizationRequestInput;
} {
  const checkout = checkoutTermsSetup(journal, seed);
  journal.bindCheckoutTerms(checkout.purchaseId, checkout.input);
  const requestDigest = verifiedLinkedEvidence(
    journal,
    checkout.purchaseId,
    `authorization-request-${seed}`,
    "authorization-request"
  );
  const body = new Uint8Array();
  journal.storeEvidence(checkout.purchaseId, {
    bytes: body,
    mediaType: "application/octet-stream",
    profile: "urn:sompi:purchase-request-body:1",
    kind: "purchase-request-body",
  });
  return {
    purchaseId: checkout.purchaseId,
    input: {
      checkoutDigest: checkout.checkoutDigest,
      requestDigest,
      nonceDigest: evidenceDigest(`authorization-nonce-${seed}`),
      requestMediaType: "",
      requestBodyDigest: evidenceDigest(body),
      additionalCostCeilingAtomic: "10",
      effectiveFinalityFloor: "accepted",
      expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
    },
  };
}

function authorizationDecisionSetup(journal: PurchaseJournal, seed: number): {
  purchaseId: PurchaseId;
  input: RecordAuthorizationDecisionInput;
} {
  const request = authorizationRequestSetup(journal, seed);
  journal.recordAuthorizationRequest(request.purchaseId, request.input);
  const evidence = verifiedLinkedEvidence(
    journal,
    request.purchaseId,
    `authorization-${seed}`,
    "purchase-authorization"
  );
  const purchase = journal.requirePurchase(request.purchaseId);
  const terms = journal.requireCheckoutTerms(request.purchaseId);
  const storedRequest = journal.requireAuthorizationRequest(request.purchaseId);
  return {
    purchaseId: request.purchaseId,
    input: {
      decision: "approved",
      authorityId: "authority:test",
      checkoutDigest: terms.checkoutDigest,
      approvedFactsDigest: authorizationFactsDigest({
        purchaseId: request.purchaseId,
        resourceUrl: purchase.resourceUrl,
        method: purchase.method,
        requestMediaType: storedRequest.requestMediaType,
        requestBodyDigest: storedRequest.requestBodyDigest,
        terms,
        requestDigest: storedRequest.requestDigest,
        nonceDigest: storedRequest.nonceDigest,
        additionalCostCeilingAtomic: storedRequest.additionalCostCeilingAtomic,
        effectiveFinalityFloor: storedRequest.effectiveFinalityFloor,
        executionPlanDigest: storedRequest.executionPlanDigest,
        executionMechanism: storedRequest.executionMechanism,
        executionProfile: storedRequest.executionProfile,
        settlementAssurance: storedRequest.settlementAssurance,
        maximumAuthorizedChargeAtomic: storedRequest.maximumAuthorizedChargeAtomic,
        ...(storedRequest.channelId === undefined ? {} : { channelId: storedRequest.channelId }),
        ...(storedRequest.channelEpochDigest === undefined
          ? {}
          : { channelEpochDigest: storedRequest.channelEpochDigest }),
        createdAtMs: storedRequest.createdAtMs,
        expiresAtMs: storedRequest.expiresAtMs,
      }),
      evidenceDigest: evidence,
      verificationProfile: "test-v1",
      verifierId: "test-verifier",
      requestDigest: storedRequest.requestDigest,
      nonceDigest: storedRequest.nonceDigest,
      expiresAtMs: storedRequest.expiresAtMs,
    },
  };
}

function authorizePurchase(journal: PurchaseJournal, seed: number): PurchaseId {
  const setup = authorizationDecisionSetup(journal, seed);
  journal.recordAuthorizationDecision(setup.purchaseId, setup.input);
  return setup.purchaseId;
}

function paymentPreparationSetup(
  journal: PurchaseJournal,
  seed: number,
  now: number
): {
  purchaseId: PurchaseId;
  reservationId: string;
  input: PreparePaymentAttemptInput;
} {
  const purchaseId = authorizePurchase(journal, seed);
  const policy = ensurePolicy(journal);
  const reservation = journal.reservePolicy(
    reservationInput(journal, purchaseId, policy, `reservation-${seed}`, now)
  );
  journal.createPaymentAttempt({
    purchaseId,
    attempt: 1,
    identifier: createPaymentIdentifier(purchaseId, 1),
  });
  return {
    purchaseId,
    reservationId: reservation.id,
    input: paymentPreparationInput(purchaseId, reservation.id, seed),
  };
}

function treasuryStagingPlanSetup(
  journal: PurchaseJournal,
  seed: number,
  now: number
): {
  purchaseId: PurchaseId;
  reservationId: string;
  input: PlanTreasuryStagingInput;
} {
  const purchaseId = authorizePurchase(journal, seed);
  const policy = ensurePolicy(journal);
  const reservation = journal.reservePolicy(
    reservationInput(journal, purchaseId, policy, `staging-reservation-${seed}`, now)
  );
  journal.createPaymentAttempt({
    purchaseId,
    attempt: 1,
    identifier: createPaymentIdentifier(purchaseId, 1),
  });
  const preparedBytes = Buffer.from(`treasury-staging-${seed}`, "utf8");
  const transactionId = byte(seed + 32).repeat(32);
  return {
    purchaseId,
    reservationId: reservation.id,
    input: {
      purchaseId,
      attempt: 1,
      reservationId: reservation.id,
      idempotencyKey: `treasury-staging:${createPaymentIdentifier(purchaseId, 1)}`,
      payloadDigest: evidenceDigest(preparedBytes),
      preparedBytes,
      plannedTransactionId: transactionId,
      expectedOutpoint: `${transactionId}:0`,
      stagingAmountAtomic: "70",
      fundingSource: "vault-treasury",
    },
  };
}

function observedTreasuryStagingSetup(
  journal: PurchaseJournal,
  seed: number,
  now: number,
  recordObservation = true
): {
  purchaseId: PurchaseId;
  reservationId: string;
  stagingEffectId: string;
  lease: LeaseToken;
  stagingInput: PlanTreasuryStagingInput;
  observationInput: RecordObservedTreasuryStagingInput;
} {
  const setup = treasuryStagingPlanSetup(journal, seed, now);
  const plan = journal.planTreasuryStaging(setup.input);
  journal.transitionPurchase(
    setup.purchaseId,
    "authorised",
    "execution_prepared",
    "treasury_staging_prepared"
  );
  const claim = journal.beginTreasuryStaging(
    plan.effectId,
    setup.reservationId,
    `staging-holder-${seed}`,
    60_000
  );
  assert.ok(claim);
  const evidence = verifiedLinkedEvidence(
    journal,
    setup.purchaseId,
    `staging-observation-${seed}`,
    TREASURY_STAGING_EVIDENCE_KIND,
    1
  );
  const observationInput: RecordObservedTreasuryStagingInput = {
    effectId: plan.effectId,
    reservationId: setup.reservationId,
    transactionId: setup.input.plannedTransactionId,
    outpoint: setup.input.expectedOutpoint,
    stagingAmountAtomic: setup.input.stagingAmountAtomic,
    fundingSource: "vault-treasury",
    evidenceDigest: evidence,
    evidenceVerificationProfile: "test-v1",
    evidenceVerifierId: "test-verifier",
  };
  if (recordObservation) {
    journal.recordObservedTreasuryStaging(claim.lease, observationInput);
  }
  return {
    purchaseId: setup.purchaseId,
    reservationId: setup.reservationId,
    stagingEffectId: plan.effectId,
    lease: claim.lease,
    stagingInput: setup.input,
    observationInput,
  };
}

function stagingRecoveryPlanSetup(
  journal: PurchaseJournal,
  seed: number,
  now: number
): {
  purchaseId: PurchaseId;
  reservationId: string;
  stagingEffectId: string;
  input: PlanTreasuryStagingRecoveryInput;
} {
  const staging = observedTreasuryStagingSetup(journal, seed, now);
  journal.transitionPurchase(
    staging.purchaseId,
    "execution_prepared",
    "failed_recoverable",
    "staging_requires_recovery"
  );
  const preparedBytes = Buffer.from(`staging-recovery-${seed}`, "utf8");
  const recoveryTransactionId = byte(seed + 64).repeat(32);
  return {
    purchaseId: staging.purchaseId,
    reservationId: staging.reservationId,
    stagingEffectId: staging.stagingEffectId,
    input: {
      purchaseId: staging.purchaseId,
      attempt: 1,
      reservationId: staging.reservationId,
      stagingEffectId: staging.stagingEffectId,
      idempotencyKey: `treasury-staging-recovery:${createPaymentIdentifier(
        staging.purchaseId,
        1
      )}`,
      payloadDigest: evidenceDigest(preparedBytes),
      preparedBytes,
      recoveryTransactionId,
      recoveryOutpoint: `${recoveryTransactionId}:0`,
      recoveryAmountAtomic: "67",
      stagingFeeAtomic: "2",
      recoveryFeeAtomic: "3",
      requiredFinality: "accepted",
      authorizedAdditionalCostCeilingAtomic: "10",
    },
  };
}

function stagingRecoveryObservationSetup(
  journal: PurchaseJournal,
  seed: number,
  now: number
): {
  purchaseId: PurchaseId;
  recoveryEffectId: string;
  lease: LeaseToken;
  recoveryInput: PlanTreasuryStagingRecoveryInput;
} {
  const setup = stagingRecoveryPlanSetup(journal, seed, now);
  const plan = journal.planTreasuryStagingRecovery(setup.input);
  const claim = journal.beginTreasuryStagingRecovery(
    plan.effectId,
    `staging-recovery-holder-${seed}`,
    60_000
  );
  assert.ok(claim);
  return {
    purchaseId: setup.purchaseId,
    recoveryEffectId: plan.effectId,
    lease: claim.lease,
    recoveryInput: setup.input,
  };
}

function submittedPaymentSetup(
  journal: PurchaseJournal,
  seed: number,
  now: number
): {
  purchaseId: PurchaseId;
  reservationId: string;
  effectId: string;
  lease: LeaseToken;
  spendInput: RecordPurchaseSettlementInput;
} {
  const setup = paymentPreparationSetup(journal, seed, now);
  const preparation = journal.preparePaymentAttempt(setup.input);
  const effect = journal.planEffect({
    purchaseId: setup.purchaseId,
    attempt: 1,
    kind: "kaspa-exact-payment",
    idempotencyKey: `payment:${createPaymentIdentifier(setup.purchaseId, 1)}`,
    payloadDigest: preparation.payloadDigest,
    preparedBytes: setup.input.preparedBytes,
  });
  journal.transitionPurchase(
    setup.purchaseId,
    "authorised",
    "execution_prepared",
    "execution_prepared"
  );
  const claim = journal.beginPaymentSubmission(
    effect.id,
    setup.reservationId,
    `payment-holder-${seed}`,
    60_000
  );
  assert.ok(claim);
  journal.transitionPurchase(
    setup.purchaseId,
    "execution_prepared",
    "submitted",
    "payment_submission_claimed"
  );
  journal.markEffectSubmitted(claim, evidenceDigest(`submission-${seed}`));
  const settlement = verifiedLinkedEvidence(
    journal,
    setup.purchaseId,
    `settlement-${seed}`,
    "kaspa-settlement",
    1
  );
  return {
    purchaseId: setup.purchaseId,
    reservationId: setup.reservationId,
    effectId: effect.id,
    lease: claim.lease,
    spendInput: {
      effectId: effect.id,
      reservationId: setup.reservationId,
      executionId: setup.input.executionId,
      mechanism: setup.input.mechanism,
      profile: setup.input.profile,
      transactionId: setup.input.transactionId,
      outpoint: `${setup.input.transactionId}:0`,
      actualAmountAtomic: "60",
      actualAdditionalCostAtomic: "2",
      asset: "KAS",
      payee: "kaspatest:merchant",
      network: "kaspa:testnet-10",
      settlementAssurance: "confirmed",
      fundingSource: "vault-treasury",
      evidenceDigest: settlement,
      evidenceVerificationProfile: "test-v1",
      evidenceVerifierId: "test-verifier",
    },
  };
}

function fulfilmentSetup(
  journal: PurchaseJournal,
  seed: number,
  now: number,
  record: boolean
): { purchaseId: PurchaseId; input: RecordFulfilmentInput } {
  const payment = submittedPaymentSetup(journal, seed, now);
  journal.recordPurchaseSettlement(payment.lease, payment.spendInput);
  journal.transitionPurchase(
    payment.purchaseId,
    "submitted",
    "settled",
    "payment_settled",
    payment.spendInput.evidenceDigest
  );
  const bodyBytes = Buffer.from(`fulfilled-resource-${seed}`, "utf8");
  const bodyDigest = verifiedLinkedEvidence(
    journal,
    payment.purchaseId,
    bodyBytes,
    "fulfilment-body",
    1
  );
  const merchantEvidence = verifiedLinkedEvidence(
    journal,
    payment.purchaseId,
    `merchant-fulfilment-${seed}`,
    "merchant-fulfilment",
    1
  );
  const input: RecordFulfilmentInput = {
    attempt: 1,
    httpStatus: 200,
    resourceFingerprint: journal.requireCheckoutTerms(payment.purchaseId).resourceFingerprint,
    bodyDigest,
    bodyByteLength: bodyBytes.byteLength,
    mediaType: "application/octet-stream",
    merchantEvidenceDigest: merchantEvidence,
    merchantVerificationProfile: "test-v1",
    merchantVerifierId: "test-verifier",
  };
  if (record) journal.recordFulfilment(payment.purchaseId, input);
  return { purchaseId: payment.purchaseId, input };
}

function receiptInput(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  seed: number
): RecordReceiptInput {
  const evidence = verifiedLinkedEvidence(
    journal,
    purchaseId,
    `purchase-receipt-${seed}`,
    "purchase-receipt",
    undefined,
    PURCHASE_RECEIPT_PROFILE,
    "authority:issuer"
  );
  return {
    evidenceDigest: evidence,
    profile: PURCHASE_RECEIPT_PROFILE,
    issuer: "authority:issuer",
    verifierId: "test-verifier",
    checkoutDigest: journal.requireCheckoutTerms(purchaseId).checkoutDigest,
    authorizationEvidenceDigest: journal.requireAuthorization(purchaseId).evidenceDigest,
    settlementEvidenceDigest: journal.findSettlementForPurchase(purchaseId)!.evidenceDigest,
    fulfilmentDigest: journal.requireFulfilment(purchaseId).bodyDigest,
  };
}

function treasuryOperationSetup(
  journal: PurchaseJournal,
  seed: number,
  target: "policy" | "intent" | "prepared" | "submitted" | "observed"
): {
  intent: TreasuryOperationIntent;
  prepared: PreparedTreasuryOperation;
  observationDetail: Readonly<Record<string, unknown>>;
  driver?: TreasuryDriverLease;
} {
  const policy = journal.installPolicy(policyDefinition());
  const transactionId = byte(seed + 96).repeat(32);
  const intent: TreasuryOperationIntent = {
    operationKey: `fault-boundary:treasury:${seed}`,
    requestDigest: evidenceDigest(`treasury-request-${seed}`),
    kind: "wallet_send",
    destination: "kaspatest:merchant",
    requestedAmountAtomic: "100",
        feeCeilingAtomic: "10",
        retryLimit: 3,
        policyDigest: policy.digest,
  };
  const prepared: PreparedTreasuryOperation = {
    bytes: Buffer.from(`treasury-prepared-${seed}`, "utf8"),
    transactionId,
    amountAtomic: "100",
    feeAtomic: "10",
    policyDigest: policy.digest,
  };
  const observationDetail = Object.freeze({
    transactionId,
    finality: "accepted",
    amountAtomic: "100",
    feeAtomic: "10",
  });
  let driver: TreasuryDriverLease | undefined;
  if (target !== "policy") {
    journal.claimTreasuryOperationIntent(intent);
    driver = journal.claimTreasuryOperationDriver(
      intent.operationKey,
      "fault-boundary-driver",
      60_000,
    ).lease;
    assert.ok(driver);
  }
  if (["prepared", "submitted", "observed"].includes(target)) {
    journal.recordPreparedTreasuryOperation(intent.operationKey, prepared, driver);
  }
  if (["submitted", "observed"].includes(target)) {
    assert.equal(journal.planTreasuryOperationSubmission(intent.operationKey, driver), true);
    assert.equal(journal.claimTreasuryOperationEffectCapability(intent.operationKey, driver!), true);
    journal.recordTreasuryOperationSubmissionAccepted(intent.operationKey, transactionId, driver);
  }
  if (target === "observed") {
    journal.recordTreasuryOperationObservation(
      intent.operationKey,
      "observed",
      observationDetail,
      driver,
      "accepted",
    );
  }
  return { intent, prepared, observationDetail, driver };
}

function verifiedLinkedEvidence(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  value: string | Uint8Array,
  kind: string,
  attempt?: number,
  profile = "test-v1",
  issuer = "test-issuer"
): Sha256Digest {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Uint8Array.from(value);
  const artifact = journal.storeEvidence(purchaseId, {
    bytes,
    mediaType: "application/octet-stream",
    profile,
    issuer,
    kind,
    ...(attempt === undefined ? {} : { attempt }),
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "test-verifier",
    profile,
    detailDigest: evidenceDigest(`verified:${artifact.digest}`),
  });
  return artifact.digest;
}

function paymentPreparationInput(
  purchaseId: PurchaseId,
  reservationId: string,
  seed: number
): PreparePaymentAttemptInput {
  const preparedBytes = Buffer.from(`payment-preparation-${seed}`, "utf8");
  const transactionId = byte(seed).repeat(32);
  return {
    purchaseId,
    attempt: 1,
    reservationId,
    requirementsDigest: evidenceDigest(`requirements-${seed}`),
    payloadDigest: evidenceDigest(preparedBytes),
    preparedBytes,
    executionId: transactionId,
    mechanism: "single-transaction",
    profile: "kaspa-exact-v2:standard-native",
    transactionId,
    amountAtomic: "60",
    asset: "KAS",
    network: "kaspa:testnet-10",
    payee: "kaspatest:merchant",
    requiredAssurance: "accepted",
    fundingSource: "vault-treasury",
  };
}

function reservationInput(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  policy: PolicySnapshotRecord,
  id: string,
  now: number
): PolicyReservationInput {
  const authorization = journal.requireAuthorization(purchaseId);
  return {
    id,
    purchaseId,
    policyDigest: policy.digest,
    payee: "kaspatest:merchant",
    amountAtomic: "60",
    additionalCostCeilingAtomic: "10",
    fundingSource: "vault-treasury",
    expiresAtMs: now + 60_000,
    approvalEvidenceDigest: authorization.evidenceDigest,
    approvalVerificationProfile: authorization.verificationProfile,
    approvalVerifierId: authorization.verifierId,
  };
}

function policyDefinition() {
  return {
    maxPerPaymentAtomic: "1000",
    maxPerHourAtomic: "10000",
    allowlist: ["kaspatest:merchant"],
  };
}

function policyFacts(policy: PolicySnapshotRecord) {
  return {
    maxPerPaymentAtomic: policy.maxPerPaymentAtomic,
    maxPerHourAtomic: policy.maxPerHourAtomic,
    allowlist: [...policy.allowlist],
  };
}

function ensurePolicy(journal: PurchaseJournal): PolicySnapshotRecord {
  try {
    return journal.requireActivePolicy();
  } catch {
    return journal.installPolicy(policyDefinition());
  }
}

function createPurchase(journal: PurchaseJournal, seed: number) {
  return journal.createPurchase(purchaseInput(seed));
}

function purchaseInput(seed: number) {
  const id = createPurchaseId(new Uint8Array(16).fill(seed));
  const resource = {
    url: `https://merchant.example/resource/${seed}`,
    method: "GET",
  };
  return {
    id,
    requestKey: assertPurchaseRequestKey(`fault-boundary:purchase:${seed}`),
    resourceUrl: resource.url,
    method: resource.method,
    resourceFingerprint: requestFingerprint(resource),
    expectedMerchantId: "merchant:test",
    expectedMerchantOrigin: "https://merchant.example",
  };
}

function testClock(): TestClock {
  const clock: TestClock = {
    value: 1_800_000_000_000,
    now() {
      return clock.value;
    },
  };
  return clock;
}

function openJournal(
  filename: string,
  evidenceDirectory: string,
  clock: TestClock,
  faultInjector?: (point: JournalFaultPoint) => void
): PurchaseJournal {
  return new PurchaseJournal(filename, {
    now: clock.now.bind(clock),
    evidenceDirectory,
    operatorManifestIdentity: MANIFEST,
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 32,
      prevalidationPurchases: 100,
      evidenceBytes: 10 * 1024 * 1024,
      directTreasuryRetries: 3,
    },
    ...(faultInjector ? { faultInjector } : {}),
  });
}

function byte(value: number): string {
  return (value % 256).toString(16).padStart(2, "0");
}
