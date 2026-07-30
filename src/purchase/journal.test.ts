import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  JournalEffectBusyError,
  JournalFencingError,
  JournalInvariantError,
  JournalNotFoundError,
} from "../journal/contracts.js";
import type {
  PreparePaymentAttemptInput,
  PurchaseRecord,
} from "./journal-contracts.js";
import {
  PolicyReservationError,
  PurchaseJournal,
} from "./journal.js";
import {
  TREASURY_STAGING_EVIDENCE_KIND,
  type PolicyReservationInput,
  type PolicySnapshotRecord,
} from "../treasury/operation-journal.js";
import {
  treasuryStagingPreparationLeaseName,
  type PlanTreasuryStagingInput,
} from "../treasury/purchase-staging.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "./identity.js";
import { PurchaseReconciler } from "./reconciliation.js";
import { authorizationFactsDigest } from "./contracts.js";
import { JOURNAL_SCHEMA_VERSION } from "./journal-schema.js";
import type { PurchaseId, Sha256Digest } from "./types.js";
import {
  CHAIN_EVIDENCE_OPERATOR_PROFILE,
  CHAIN_EVIDENCE_PROFILE,
  CHAIN_EVIDENCE_WITNESS_PROFILE,
  type ChainEvidenceRecord,
} from "../chain-evidence/types.js";

test("journal creates a secure, verified schema and survives restart", () => {
  withJournal(({ filename, journal, reopen }) => {
    assert.equal(journal.schemaVersion(), JOURNAL_SCHEMA_VERSION);
    assert.equal(journal.integrityCheck(), true);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    const purchase = createPurchase(journal, 1);
    journal.close();
    fs.chmodSync(filename, 0o666);
    assert.throws(() => reopen(), JournalInvariantError);
    fs.chmodSync(filename, 0o600);
    const restarted = reopen();
    assert.equal(restarted.requirePurchase(purchase.id).requestKey, purchase.requestKey);
    assert.equal(restarted.transitions(purchase.id).length, 1);
    assert.equal(restarted.integrityCheck(), true);
  });
});

test("Journal leases exclude competitors, renew in place, and fence stale owners", () => {
  withJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const competitor = new PurchaseJournal(filename, {
      now: clock.now,
      evidenceDirectory,
    });
    try {
      const first = journal.acquireLease(
        "phase6-contract-lease",
        "phase6-owner-a",
        10_000,
      );
      assert.ok(first);
      assert.equal(
        competitor.acquireLease(
          "phase6-contract-lease",
          "phase6-owner-b",
          10_000,
        ),
        undefined,
      );

      const renewed = journal.renewLease(first, 20_000);
      assert.equal(renewed.generation, first.generation);
      assert.equal(renewed.expiresAtMs, clock.value + 20_000);

      clock.value = renewed.expiresAtMs;
      const takeover = competitor.acquireLease(
        "phase6-contract-lease",
        "phase6-owner-b",
        30_000,
      );
      assert.ok(takeover);
      assert.equal(takeover.generation, first.generation + 1);
      assert.throws(
        () => journal.renewLease(first, 10_000),
        JournalFencingError,
      );
      assert.equal(journal.releaseLease(first), false);
      assert.equal(competitor.releaseLease(takeover), true);
    } finally {
      competitor.close();
    }
  });
});

test("completed Treasury operation resolves its accepted Chain Evidence through the Journal", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-treasury-evidence-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const identity = {
    revision: 1,
    digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const journal = new PurchaseJournal(filename, {
    operatorManifestIdentity: identity,
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
  });
  try {
    const policy = journal.installPolicy({
      maxPerPaymentAtomic: "1000",
      maxPerHourAtomic: "10000",
      allowlist: ["kaspatest:destination"],
    });
    const transactionId = "11".repeat(32);
    const operationKey = "test:treasury:evidence";
    journal.claimTreasuryOperationIntent({
      operationKey,
      requestDigest: evidenceDigest("treasury-evidence-request"),
      kind: "vault_deposit",
      destination: "kaspatest:destination",
      requestedAmountAtomic: "100",
      feeCeilingAtomic: "10",
      retryLimit: 3,
      policyDigest: policy.digest,
    });
    journal.recordPreparedTreasuryOperation(operationKey, {
      bytes: Buffer.from("prepared-treasury-operation", "utf8"),
      transactionId,
      amountAtomic: "100",
      feeAtomic: "10",
      policyDigest: policy.digest,
    });
    assert.equal(journal.planTreasuryOperationSubmission(operationKey), true);
    const evidence: ChainEvidenceRecord = {
      profile: CHAIN_EVIDENCE_PROFILE,
      operationId: operationKey,
      operation: "vault",
      transactionId,
      status: "present",
      level: "accepted",
      view: "historical",
      mechanism: "native-covenant",
      protocolFinality: "accepted",
      operatorFloor: "accepted",
      effectiveFloor: "accepted",
      primaryProfile: CHAIN_EVIDENCE_OPERATOR_PROFILE,
      witnessProfile: CHAIN_EVIDENCE_WITNESS_PROFILE,
      blockHash: "22".repeat(32),
      acceptingBlockHash: "33".repeat(32),
      acceptingBlockDaaScore: "100",
      virtualDaaScore: "101",
      outputsDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      detailDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      observedAtMs: 1_800_000_000_000,
    };
    journal.recordChainEvidence(evidence);
    journal.recordTreasuryOperationObservation(operationKey, "observed", {
      profile: "urn:sompi:treasury-operation:observation:1",
      kind: "vault_deposit",
      status: "observed",
      operationKey,
      transactionId,
      chainEvidenceDigest: evidence.detailDigest,
      chainEvidenceLevel: evidence.level,
    });
    journal.completeTreasuryOperation(operationKey);

    assert.deepEqual(
      journal.findCompletedTreasuryOperationChainEvidence(operationKey),
      evidence,
    );
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Journal binds one immutable Operator Manifest identity before durable work", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-operator-manifest-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const firstIdentity = {
    revision: 1,
    digest: `sha256:${Buffer.alloc(32, 1).toString("base64url")}`,
  };
  const secondIdentity = {
    revision: 2,
    digest: `sha256:${Buffer.alloc(32, 2).toString("base64url")}`,
  };
  const admission = {
    authorityPreauthSockets: 32,
    authorityPrompts: 4,
    prevalidationPurchases: 128,
    evidenceBytes: 67_108_864,
    directTreasuryRetries: 3,
  } as const;
  try {
    const first = new PurchaseJournal(filename, {
      operatorManifestIdentity: firstIdentity,
      admission,
    });
    assert.deepEqual(first.operatorManifestIdentity(), firstIdentity);
    first.close();

    const same = new PurchaseJournal(filename, {
      operatorManifestIdentity: firstIdentity,
      admission,
    });
    assert.deepEqual(same.operatorManifestIdentity(), firstIdentity);
    same.close();

    assert.throws(
      () => new PurchaseJournal(filename, { operatorManifestIdentity: secondIdentity, admission }),
      /different Operator Manifest/
    );

    const unboundPath = path.join(directory, "unbound.sqlite");
    const unbound = new PurchaseJournal(unboundPath);
    unbound.createPurchase(purchaseInput(91));
    unbound.close();
    assert.throws(
      () => new PurchaseJournal(unboundPath, { operatorManifestIdentity: firstIdentity, admission }),
      /cannot bind an existing development Journal/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Purchase identity is idempotent, runtime-validated, and cannot bypass the lifecycle", () => {
  withJournal(({ journal }) => {
    const input = purchaseInput(2);
    const first = journal.createPurchase(input);
    const retry = journal.createPurchase({
      ...input,
      id: createPurchaseId(new Uint8Array(16).fill(0x7f)),
    });
    assert.equal(retry.id, first.id);
    assert.throws(
      () => journal.createPurchase({ ...input, method: "POST" }),
      JournalInvariantError
    );
    assert.throws(
      () => journal.createPurchase({ ...input, id: "pur_invalid" as PurchaseId }),
      JournalInvariantError
    );
    assert.throws(
      () => journal.transitionPurchase(first.id, "created", "failed_recoverable", "forced_recovery"),
      JournalInvariantError
    );
    assert.throws(
      () =>
        journal.transitionPurchase(
          first.id,
          "created",
          "terms_bound",
          "merchant_terms_verified",
          "privateKey=should-not-persist" as Sha256Digest
        ),
      JournalInvariantError
    );
    const cancelled = journal.transitionPurchase(
      first.id,
      "created",
      "cancelled",
      "purchase_cancelled"
    );
    assert.equal(cancelled.version, 1);
    assert.deepEqual(
      journal.transitions(first.id).map((entry) => [entry.fromState, entry.toState, entry.reasonCode]),
      [
        [undefined, "created", "purchase_created"],
        ["created", "cancelled", "purchase_cancelled"],
      ]
    );
  });
});

test("different Purchases may bind the same verified execution plan", () => {
  withJournal(({ journal }) => {
    const bind = (seed: number) => {
      const purchase = createPurchase(journal, seed);
      const checkoutEvidence = verifiedEvidence(
        journal,
        purchase.id,
        `checkout-${seed}`,
        "checkout-terms",
        undefined,
        "test-profile-v1",
        "merchant:test"
      );
      const requirementsEvidence = verifiedEvidence(
        journal,
        purchase.id,
        "shared-batch-requirements",
        "payment-requirements",
        undefined,
        "test-profile-v1",
        "merchant:test"
      );
      const executionPlan = journal.storeExecutionPlanEvidence(purchase.id, {
        mechanism: "channel-voucher",
        profile: "kaspa-escrow-v1",
        requirementsDigest: requirementsEvidence,
        maximumChargeAtomic: "10000000",
        settlementAssurance: "channel-commitment",
        channelEpoch: {
          channelId: "a".repeat(64),
          activeOutpoint: { txid: "b".repeat(64), index: 0 },
          activeScriptPublicKey: "000020" + "c".repeat(64),
          fundingAmountAtomic: "40000000",
          refundTimeoutDaa: "600000000",
        },
        claimFeeReserveAtomic: "2000000",
      });
      journal.bindCheckoutTerms(purchase.id, {
        terms: {
          merchant: {
            id: "merchant:test",
            name: "Test Merchant",
            origin: "https://merchant.example",
          },
          resourceFingerprint: purchase.resourceFingerprint,
          amountAtomic: "10000000",
          asset: "KAS",
          network: "kaspa:testnet-10",
          payTo: "kaspatest:merchant",
          expiresAt: "2099-01-01T00:00:00.000Z",
          checkoutDigest: checkoutEvidence,
        },
        checkoutEvidenceDigest: checkoutEvidence,
        checkoutVerificationProfile: "test-profile-v1",
        checkoutVerifierId: "test-verifier",
        paymentRequirementsDigest: requirementsEvidence,
        paymentRequirementsVerificationProfile: "test-profile-v1",
        paymentRequirementsVerifierId: "test-verifier",
        executionPlan: executionPlan.plan,
        executionPlanEvidenceDigest: executionPlan.evidenceDigest,
      });
      return journal.requireExecutionPlan(purchase.id);
    };

    const first = bind(95);
    const second = bind(96);
    assert.equal(first.digest, second.digest);
    assert.notEqual(first.purchaseId, second.purchaseId);
  });
});

test("Purchase state update and transition history roll back together", () => {
  withJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const purchase = createPurchase(journal, 3);
    journal.close();
    const faulted = new PurchaseJournal(filename, {
      now: clock.now,
      evidenceDirectory,
      faultInjector(point) {
        if (point === "purchase_transition.after_state_update") throw new Error("injected");
      },
    });
    assert.throws(
      () => faulted.transitionPurchase(purchase.id, "created", "cancelled", "purchase_cancelled"),
      /injected/
    );
    faulted.close();
    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.requirePurchase(purchase.id).state, "created");
    assert.equal(recovered.transitions(purchase.id).length, 1);
    recovered.close();
  });
});

test("raw evidence is content-addressed outside SQLite and verification is append-only", () => {
  withJournal(({ directory, filename, evidenceDirectory, journal }) => {
    const purchase = authorizedPurchase(journal, 4);
    const raw = Buffer.from("private-signed-artifact-value", "utf8");
    const artifact = journal.storeEvidence(purchase, {
      bytes: raw,
      mediaType: "application/octet-stream",
      profile: "urn:sompi:test-evidence:1",
      issuer: "authority:test",
      kind: "purchase-authorization",
    });
    journal.recordEvidenceVerification(artifact.digest, {
      verifierId: "sompi-authority-verifier",
      profile: "urn:sompi:test-evidence:1",
      detailDigest: evidenceDigest("verification-fact"),
    });
    assert.deepEqual(journal.readEvidence(artifact.digest), raw);
    assert.equal(path.isAbsolute(artifact.storageRef), false);
    assert.equal(fs.statSync(path.join(evidenceDirectory, artifact.storageRef)).mode & 0o777, 0o600);

    for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
      if (fs.existsSync(candidate)) {
        assert.equal(fs.readFileSync(candidate).includes(raw), false, `${path.basename(candidate)} leaked evidence bytes`);
      }
    }

    fs.writeFileSync(path.join(evidenceDirectory, artifact.storageRef), "tampered", { mode: 0o600 });
    assert.throws(() => journal.readEvidence(artifact.digest));
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
  });
});

test("content blobs deduplicate while Evidence Attachment metadata remains contextual", () => {
  withJournal(({ journal }) => {
    const first = createPurchase(journal, 68);
    const second = createPurchase(journal, 69);
    const empty = new Uint8Array();
    const requestBody = journal.storeEvidence(first.id, {
      bytes: empty,
      mediaType: "application/octet-stream",
      profile: "urn:sompi:purchase-request-body:1",
      issuer: "purchase-intent",
      kind: "purchase-request-body",
    });
    const fulfilmentLike = journal.storeEvidence(second.id, {
      bytes: empty,
      mediaType: "text/plain",
      profile: "urn:test:empty-resource:1",
      issuer: "merchant:test",
      kind: "empty-resource",
    });
    assert.equal(requestBody.digest, fulfilmentLike.digest);
    assert.equal(requestBody.storageRef, fulfilmentLike.storageRef);
    assert.equal(requestBody.profile, "urn:sompi:purchase-request-body:1");
    assert.equal(fulfilmentLike.profile, "urn:test:empty-resource:1");
    assert.equal(
      journal.requireEvidenceAttachment(second.id, fulfilmentLike.digest, "empty-resource").mediaType,
      "text/plain"
    );
  });
});

test("security decisions rehash evidence and require the exact verifier profile and identity", () => {
  withJournal(({ evidenceDirectory, journal, clock }) => {
    const policy = journal.installPolicy({
      maxPerPaymentAtomic: "100",
      maxPerHourAtomic: "500",
      allowlist: ["kaspatest:merchant"],
    });
    const wrongProfilePurchase = authorizedPurchase(journal, 60);
    const wrongProfileEvidence = verifiedEvidence(
      journal,
      wrongProfilePurchase,
      "authority-60",
      "purchase-authorization"
    );
    assert.throws(
      () =>
        journal.reservePolicy({
          ...reservationTerms(wrongProfilePurchase, policy, "wrong-profile", clock.value),
          approvalEvidenceDigest: wrongProfileEvidence,
          approvalVerificationProfile: "unrelated-profile",
          approvalVerifierId: "test-verifier",
        }),
      PolicyReservationError
    );

    const wrongVerifierPurchase = authorizedPurchase(journal, 61);
    const wrongVerifierEvidence = verifiedEvidence(
      journal,
      wrongVerifierPurchase,
      "authority-61",
      "purchase-authorization"
    );
    assert.throws(
      () =>
        journal.reservePolicy({
          ...reservationTerms(wrongVerifierPurchase, policy, "wrong-verifier", clock.value),
          approvalEvidenceDigest: wrongVerifierEvidence,
          approvalVerificationProfile: "test-profile-v1",
          approvalVerifierId: "different-verifier",
        }),
      PolicyReservationError
    );

    const tamperedPurchase = authorizedPurchase(journal, 62);
    const tamperedEvidence = verifiedEvidence(
      journal,
      tamperedPurchase,
      "authority-62",
      "purchase-authorization"
    );
    const artifact = journal.requireEvidence(tamperedEvidence);
    fs.writeFileSync(path.join(evidenceDirectory, artifact.storageRef), "tampered-authority", { mode: 0o600 });
    assert.throws(
      () =>
        journal.reservePolicy({
          ...reservationTerms(tamperedPurchase, policy, "tampered-evidence", clock.value),
          approvalEvidenceDigest: tamperedEvidence,
          approvalVerificationProfile: "test-profile-v1",
          approvalVerifierId: "test-verifier",
        }),
      PolicyReservationError
    );
  });
});

test("policy is one persisted snapshot and approval evidence is bound to the Purchase", () => {
  withJournal(({ journal, clock }) => {
    const purchaseA = authorizedPurchase(journal, 5);
    const purchaseB = authorizedPurchase(journal, 6, "30");
    const policyA = journal.installPolicy({
      maxPerPaymentAtomic: "100",
      maxPerHourAtomic: "150",
      allowlist: ["kaspatest:merchant"],
    });
    assert.equal(journal.installPolicy({
      maxPerPaymentAtomic: "100",
      maxPerHourAtomic: "150",
      allowlist: ["kaspatest:merchant"],
    }).digest, policyA.digest);

    assert.throws(() => journal.reservePolicy({
      ...reservationTerms(purchaseA, policyA, "reservation-a", clock.value),
      additionalCostCeilingAtomic: "5",
    }), PolicyReservationError);
    const authority = verifiedEvidence(journal, purchaseA, "authority-a", "purchase-authorization");
    assert.throws(() => journal.reservePolicy({
      ...reservationTerms(purchaseA, policyA, "reservation-a", clock.value),
      additionalCostCeilingAtomic: "5",
      approvalEvidenceDigest: authority,
      approvalVerificationProfile: "test-profile-v1",
      approvalVerifierId: "test-verifier",
    }), PolicyReservationError);
    const first = reserve(journal, purchaseA, policyA, "reservation-a", clock.value, "60", "5");
    assert.equal(first.state, "active");

    const policyB = journal.installPolicy({
      maxPerPaymentAtomic: "200",
      maxPerHourAtomic: "200",
      allowlist: ["kaspatest:merchant"],
    });
    assert.notEqual(policyB.digest, policyA.digest);
    assert.throws(
      () => reserve(journal, purchaseB, policyA, "reservation-b", clock.value, "30", "5"),
      PolicyReservationError
    );
    const second = reserve(journal, purchaseB, policyB, "reservation-b", clock.value, "30", "5");
    assert.equal(second.policyDigest, policyB.digest);
  });
});

test("authorization digest hydration rejects artifact and Journal finality disagreement", () => {
  withJournal(({ journal }) => {
    assert.throws(
      () =>
        authorizedPurchase(journal, 94, "60", {
          effectiveFinalityFloor: "depth-confirmed",
        }),
      /authorization request finality facts differ from the Journal/
    );
    assert.throws(
      () =>
        authorizedPurchase(journal, 95, "60", {
          settlementAssurance: "confirmed",
        }),
      /authorization request finality facts differ from the Journal/
    );
    assert.throws(
      () =>
        authorizedPurchase(journal, 96, "60", {
          profile: "urn:sompi:authorization-request:1",
        }),
      /authorization request finality facts are malformed/
    );
  });
});

test("every Purchase reservation requires independently verified owner approval", () => {
  withJournal(({ journal, clock }) => {
    const purchase = authorizedPurchase(journal, 63);
    const policy = installPolicy(journal, {});
    assert.equal(reserve(journal, purchase, policy, "threshold-disabled", clock.value).state, "active");
  });
});

test("policy reservations serialize capacity across independent database handles", () => {
  withJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const purchaseA = authorizedPurchase(journal, 7);
    const purchaseB = authorizedPurchase(journal, 8, "30");
    const policy = installPolicy(journal, { maxPerHourAtomic: "100" });
    const second = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    const first = reserve(journal, purchaseA, policy, "capacity-a", clock.value, "60", "10");
    assert.equal(first.state, "active");
    assert.equal(second.policyCapacityUsed(), 70n);
    assert.throws(
      () => reserve(second, purchaseB, policy, "capacity-b", clock.value, "30", "10"),
      PolicyReservationError
    );
    journal.releaseActiveReservation(first.id);
    assert.equal(
      reserve(second, purchaseB, policy, "capacity-b", clock.value, "30", "10").state,
      "active"
    );
    second.close();
  });
});

test("payment identifiers are Purchase-bound and preparation is complete and immutable", () => {
  withJournal(({ filename, evidenceDirectory, journal, reopen, clock }) => {
    const purchaseA = authorizedPurchase(journal, 9);
    const purchaseB = authorizedPurchase(journal, 10);
    const policy = installPolicy(journal);
    const reservation = reserve(journal, purchaseA, policy, "prep-reservation", clock.value);
    assert.throws(
      () =>
        journal.createPaymentAttempt({
          purchaseId: purchaseB,
          attempt: 1,
          identifier: createPaymentIdentifier(purchaseA, 1),
        }),
      JournalInvariantError
    );
    journal.createPaymentAttempt({
      purchaseId: purchaseA,
      attempt: 1,
      identifier: createPaymentIdentifier(purchaseA, 1),
    });
    const preparation = paymentPreparation(purchaseA, reservation.id, 9);
    assert.equal(journal.preparePaymentAttempt(preparation).payloadDigest, preparation.payloadDigest);
    assert.equal(journal.preparePaymentAttempt(preparation).transactionId, preparation.transactionId);
    assert.throws(
      () => journal.preparePaymentAttempt({ ...preparation, payloadDigest: evidenceDigest("changed") }),
      JournalInvariantError
    );
    journal.close();
    const restarted = reopen();
    const persisted = restarted.requirePaymentPreparation(purchaseA, 1);
    assert.equal(persisted.payloadDigest, preparation.payloadDigest);
    assert.equal(persisted.transactionId, preparation.transactionId);
    assert.equal(persisted.amountAtomic, "60");
    assert.deepEqual(restarted.readPreparedPayment(purchaseA, 1), preparation.preparedBytes);
    assert.equal(restarted.requirePaymentAttempt(purchaseA, 1).state, "prepared");
    assert.throws(
      () =>
        restarted.preparePaymentAttempt({
          ...preparation,
          preparedBytes: Buffer.from("different-prepared-payment"),
        }),
      JournalInvariantError
    );
    assert.equal(fs.statSync(evidenceDirectory).mode & 0o777, 0o700);
    void filename;
  });
});

test("a preparation fault leaves neither preparation nor state transition", () => {
  withJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const purchase = authorizedPurchase(journal, 11);
    const policy = installPolicy(journal);
    const reservation = reserve(journal, purchase, policy, "fault-prep-reservation", clock.value);
    journal.createPaymentAttempt({
      purchaseId: purchase,
      attempt: 1,
      identifier: createPaymentIdentifier(purchase, 1),
    });
    journal.close();
    const faulted = new PurchaseJournal(filename, {
      now: clock.now,
      evidenceDirectory,
      faultInjector(point) {
        if (point === "payment_preparation.after_insert") throw new Error("injected preparation fault");
      },
    });
    assert.throws(
      () => faulted.preparePaymentAttempt(paymentPreparation(purchase, reservation.id, 11)),
      /injected preparation fault/
    );
    faulted.close();
    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.requirePaymentAttempt(purchase, 1).state, "planned");
    assert.throws(() => recovered.requirePaymentPreparation(purchase, 1), JournalNotFoundError);
    recovered.close();
  });
});

test("treasury staging is durable, idempotent, and gates exact payment preparation", () => {
  withJournal(({ journal, reopen, clock }) => {
    const flow = plannedTreasuryStagingFlow(journal, 91, clock.value);
    const retry = commitTreasuryStaging(journal, flow.input);
    assert.equal(retry.effectId, flow.plan.effectId);
    assert.throws(
      () => commitTreasuryStaging(
        journal,
        { ...flow.input, stagingAmountAtomic: "69" },
      ),
      JournalInvariantError
    );

    journal.transitionPurchase(
      flow.purchaseId,
      "authorised",
      "execution_prepared",
      "treasury_staging_prepared"
    );
    const claim = journal.beginTreasuryStaging(
      flow.plan.effectId,
      flow.reservation.id,
      "staging-executor",
      60_000
    );
    assert.ok(claim);
    assert.equal(journal.requirePaymentAttempt(flow.purchaseId, 1).state, "planned");
    assert.equal(journal.requireReservation(flow.reservation.id).state, "in_flight");
    assert.throws(
      () => journal.preparePaymentAttempt(paymentPreparation(flow.purchaseId, flow.reservation.id, 91)),
      JournalInvariantError
    );

    journal.close();
    const restarted = reopen();
    const recovered = restarted.treasuryStagingRecoveryContext(flow.purchaseId, 1);
    assert.ok(recovered);
    assert.equal(recovered.effect.state, "executing");
    assert.equal(recovered.attempt.state, "planned");
    assert.equal(recovered.reservation.state, "in_flight");
    assert.equal(recovered.observation, undefined);
    assert.deepEqual(restarted.readPreparedTreasuryStaging(flow.purchaseId, 1), flow.input.preparedBytes);

    const evidence = verifiedEvidence(
      restarted,
      flow.purchaseId,
      "staging-output-91",
      TREASURY_STAGING_EVIDENCE_KIND,
      1
    );
    const observation = restarted.recordObservedTreasuryStaging(claim.lease, {
      effectId: flow.plan.effectId,
      reservationId: flow.reservation.id,
      transactionId: flow.input.plannedTransactionId,
      outpoint: flow.input.expectedOutpoint,
      stagingAmountAtomic: flow.input.stagingAmountAtomic,
      fundingSource: "vault-treasury",
      evidenceDigest: evidence,
      evidenceVerificationProfile: "test-profile-v1",
      evidenceVerifierId: "test-verifier",
    });
    assert.equal(observation.outpoint, flow.input.expectedOutpoint);
    assert.equal(restarted.requireEffect(flow.plan.effectId).state, "observed");
    assert.equal(restarted.requirePaymentAttempt(flow.purchaseId, 1).state, "planned");

    restarted.installPolicy({
      maxPerPaymentAtomic: "2000",
      maxPerHourAtomic: "20000",
      allowlist: ["kaspatest:merchant"],
    });

    const exactInput = paymentPreparation(flow.purchaseId, flow.reservation.id, 91);
    const exact = restarted.preparePaymentAttempt(exactInput);
    const paymentEffect = restarted.planEffect({
      purchaseId: flow.purchaseId,
      attempt: 1,
      kind: "kaspa-exact-payment",
      idempotencyKey: `payment:${createPaymentIdentifier(flow.purchaseId, 1)}`,
      payloadDigest: exact.payloadDigest,
      preparedBytes: exactInput.preparedBytes,
    });
    const inFlightAtMs = restarted.requireReservation(flow.reservation.id).inFlightAtMs;
    assert.ok(
      restarted.beginPaymentSubmission(
        paymentEffect.id,
        flow.reservation.id,
        "payment-executor",
        60_000
      )
    );
    assert.equal(restarted.requirePaymentAttempt(flow.purchaseId, 1).state, "submitted");
    assert.equal(restarted.requireReservation(flow.reservation.id).state, "in_flight");
    assert.equal(restarted.requireReservation(flow.reservation.id).inFlightAtMs, inFlightAtMs);
  });
});

test("treasury staging rejects output substitutions and records one immutable observation", () => {
  withJournal(({ journal, clock }) => {
    const flow = plannedTreasuryStagingFlow(journal, 92, clock.value);
    const claim = journal.beginTreasuryStaging(
      flow.plan.effectId,
      flow.reservation.id,
      "staging-mismatch-executor",
      60_000
    );
    assert.ok(claim);
    const evidence = verifiedEvidence(
      journal,
      flow.purchaseId,
      "staging-output-92",
      TREASURY_STAGING_EVIDENCE_KIND,
      1
    );
    const input = {
      effectId: flow.plan.effectId,
      reservationId: flow.reservation.id,
      transactionId: flow.input.plannedTransactionId,
      outpoint: flow.input.expectedOutpoint,
      stagingAmountAtomic: flow.input.stagingAmountAtomic,
      fundingSource: "vault-treasury" as const,
      evidenceDigest: evidence,
      evidenceVerificationProfile: "test-profile-v1",
      evidenceVerifierId: "test-verifier",
    };
    assert.throws(
      () => journal.recordObservedTreasuryStaging(claim.lease, { ...input, outpoint: `${input.transactionId}:7` }),
      JournalInvariantError
    );
    assert.throws(
      () => journal.recordObservedTreasuryStaging(claim.lease, { ...input, stagingAmountAtomic: "1" }),
      JournalInvariantError
    );
    assert.throws(
      () => journal.recordObservedTreasuryStaging(claim.lease, {
        ...input,
        evidenceVerificationProfile: "wrong-profile",
      }),
      JournalInvariantError
    );
    assert.equal(journal.requireEffect(flow.plan.effectId).state, "executing");
    assert.equal(journal.findTreasuryStagingObservation(flow.purchaseId, 1), undefined);

    const first = journal.recordObservedTreasuryStaging(claim.lease, input);
    assert.equal(journal.recordObservedTreasuryStaging(claim.lease, input).observedAtMs, first.observedAtMs);
    assert.throws(
      () => journal.recordObservedTreasuryStaging(claim.lease, { ...input, outpoint: `${input.transactionId}:9` }),
      JournalInvariantError
    );
  });
});

test("Vault Migration cannot begin while a prepared Purchase effect can still spend the vault", () => {
  withJournal(({ journal, clock }) => {
    installPolicy(journal);
    plannedTreasuryStagingFlow(journal, 94, clock.value);
    const activation = journal.requireActivePolicyActivation();
    const id = "vmg_AAAAAAAAAAAAAAAAAAAAAA";
    journal.createVaultMigration({
      id,
      requestKey: "vault:migration:prepared-purchase",
      oldVaultDigest: evidenceDigest("old-vault"),
      expectedPolicyDigest: activation.policy.digest,
      expectedPolicyGeneration: activation.activationGeneration,
      oldMaximumOutflowAtomic: "10000",
      newMaximumOutflowAtomic: "20000",
      windowSizeDaa: "36000",
      windowStartDaa: "0",
      spentInWindowAtomic: "0",
      stableReceiveAddress: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
      manifestRevision: 1,
      manifestDigest: evidenceDigest("manifest"),
      expiresAtMs: clock.value + 120_000,
    });
    journal.markVaultMigrationAwaitingAuthority(id);
    const evidence = Buffer.from("approved migration", "utf8");
    journal.decideVaultMigration(id, {
      decision: "approved",
      authorityId: "owner",
      evidenceDigest: evidenceDigest(evidence),
      evidence,
    });

    assert.throws(
      () => journal.assertVaultMigrationExecutionReady(id),
      /wait for every unresolved wallet effect/,
    );
    assert.equal(journal.vaultMigration(id).state, "awaiting_owner");
  });
});

test("treasury staging transaction edges roll back cleanly across restart", () => {
  withJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const purchaseId = authorizedPurchase(journal, 93);
    const policy = installPolicy(journal);
    const reservation = reserve(journal, purchaseId, policy, "staging-crash-reservation", clock.value);
    journal.createPaymentAttempt({
      purchaseId,
      attempt: 1,
      identifier: createPaymentIdentifier(purchaseId, 1),
    });
    const input = treasuryStagingInput(purchaseId, reservation.id, 93);
    const preparationLease = journal.acquireLease(
      treasuryStagingPreparationLeaseName(purchaseId, 1),
      "staging-crash-planner",
      60_000,
    );
    assert.ok(preparationLease);
    journal.close();

    const planFault = new PurchaseJournal(filename, {
      now: clock.now,
      evidenceDirectory,
      faultInjector(point) {
        if (point === "treasury_staging_plan.after_insert") throw new Error("staging-plan-crash");
      },
    });
    assert.throws(
      () => planFault.commitTreasuryStagingPreparation(
        preparationLease,
        input,
      ),
      /staging-plan-crash/,
    );
    planFault.close();

    const afterPlanFault = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(afterPlanFault.treasuryStagingRecoveryContext(purchaseId, 1), undefined);
    assert.deepEqual(
      afterPlanFault.effectsForPurchase(purchaseId).map(({ kind, state }) => ({ kind, state })),
      []
    );
    assert.equal(afterPlanFault.requireReservation(reservation.id).state, "active");
    const plan = afterPlanFault.commitTreasuryStagingPreparation(
      preparationLease,
      input,
    );
    afterPlanFault.releaseLease(preparationLease);
    afterPlanFault.transitionPurchase(
      purchaseId,
      "authorised",
      "execution_prepared",
      "treasury_staging_prepared"
    );
    afterPlanFault.close();

    const claimFault = new PurchaseJournal(filename, {
      now: clock.now,
      evidenceDirectory,
      faultInjector(point) {
        if (point === "effect_claim.after_effect_update") throw new Error("staging-claim-crash");
      },
    });
    assert.throws(
      () => claimFault.beginTreasuryStaging(plan.effectId, reservation.id, "claim-fault", 60_000),
      /staging-claim-crash/
    );
    claimFault.close();

    const afterClaimFault = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(afterClaimFault.requireEffect(plan.effectId).state, "planned");
    assert.equal(afterClaimFault.requireReservation(reservation.id).state, "active");
    const claim = afterClaimFault.beginTreasuryStaging(
      plan.effectId,
      reservation.id,
      "staging-crash-executor",
      60_000
    );
    assert.ok(claim);
    const evidence = verifiedEvidence(
      afterClaimFault,
      purchaseId,
      "staging-output-crash",
      TREASURY_STAGING_EVIDENCE_KIND,
      1
    );
    afterClaimFault.close();

    const observationFault = new PurchaseJournal(filename, {
      now: clock.now,
      evidenceDirectory,
      faultInjector(point) {
        if (point === "treasury_staging_observation.after_insert") {
          throw new Error("staging-observation-crash");
        }
      },
    });
    assert.throws(
      () => observationFault.recordObservedTreasuryStaging(claim.lease, {
        effectId: plan.effectId,
        reservationId: reservation.id,
        transactionId: input.plannedTransactionId,
        outpoint: input.expectedOutpoint,
        stagingAmountAtomic: input.stagingAmountAtomic,
        fundingSource: "vault-treasury",
        evidenceDigest: evidence,
        evidenceVerificationProfile: "test-profile-v1",
        evidenceVerifierId: "test-verifier",
      }),
      /staging-observation-crash/
    );
    observationFault.close();

    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    const context = recovered.treasuryStagingRecoveryContext(purchaseId, 1);
    assert.ok(context);
    assert.equal(context.effect.state, "executing");
    assert.equal(context.attempt.state, "planned");
    assert.equal(context.reservation.state, "in_flight");
    assert.equal(context.observation, undefined);
    assert.deepEqual(recovered.effectObservations(plan.effectId), []);
    recovered.close();
  });
});

test("missing or changed prepared bytes prevent payment claim and restart recovery", () => {
  withJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const flow = preparedPaymentFlow(journal, 64, clock.value);
    const preparedDirectory = `${filename}.prepared`;
    fs.writeFileSync(path.join(preparedDirectory, flow.preparation.preparedRef), "tampered-payment", {
      mode: 0o600,
    });
    assert.throws(
      () => journal.beginPaymentSubmission(flow.effect.id, flow.reservation.id, "executor", 10_000)
    );
    journal.close();
    assert.throws(
      () => new PurchaseJournal(filename, { now: clock.now, evidenceDirectory }),
      JournalInvariantError
    );
  });
});

test("payment submission atomically fences the effect, Attempt, and treasury capacity", () => {
  withJournal(({ journal, reopen, clock }) => {
    const flow = preparedPaymentFlow(journal, 12, clock.value);
    const claim = journal.beginPaymentSubmission(flow.effect.id, flow.reservation.id, "executor-a", 120_000);
    assert.ok(claim);
    assert.equal(claim.effect.state, "executing");
    assert.equal(journal.requirePaymentAttempt(flow.purchaseId, 1).state, "submitted");
    assert.equal(journal.requireReservation(flow.reservation.id).state, "in_flight");

    clock.value = flow.reservation.expiresAtMs + 1;
    journal.expireReservations();
    assert.equal(journal.requireReservation(flow.reservation.id).state, "in_flight");
    assert.equal(journal.policyCapacityUsed(), 70n);

    journal.close();
    const restarted = reopen();
    assert.equal(restarted.requireEffect(flow.effect.id).state, "executing");
    assert.equal(restarted.requireReservation(flow.reservation.id).state, "in_flight");
    assert.equal(
      restarted.markEffectSubmitted(claim, evidenceDigest("submission-ack")).state,
      "submitted"
    );
  });
});

test("a possible external effect rejects cancellation with the shared busy error", () => {
  withJournal(({ journal, clock }) => {
    const flow = preparedPaymentFlow(journal, 73, clock.value);
    const claim = journal.beginPaymentSubmission(
      flow.effect.id,
      flow.reservation.id,
      "phase6-effect-owner",
      120_000,
    );
    assert.ok(claim);

    assert.throws(
      () => journal.cancelPurchaseBeforeExternalEffect(flow.purchaseId),
      (error: unknown) =>
        error instanceof JournalEffectBusyError &&
        error instanceof JournalFencingError,
    );
    assert.equal(journal.requireEffect(flow.effect.id).state, "executing");
    assert.equal(
      journal.requirePaymentAttempt(flow.purchaseId, 1).state,
      "submitted",
    );
    assert.equal(
      journal.requireReservation(flow.reservation.id).state,
      "in_flight",
    );

    const staleClaim = {
      effect: claim.effect,
      lease: { ...claim.lease, generation: claim.lease.generation + 1 },
    };
    assert.throws(
      () =>
        journal.markEffectSubmitted(
          staleClaim,
          evidenceDigest("phase6-stale-submission"),
        ),
      JournalFencingError,
    );
    assert.equal(journal.requireEffect(flow.effect.id).state, "executing");
  });
});

test("effect observations are fenced, typed, and reject conflicting results", () => {
  withJournal(({ journal }) => {
    const purchase = authorizedPurchase(journal, 13);
    const preparedBytes = Buffer.from("terms-request");
    const effect = journal.planEffect({
      purchaseId: purchase,
      kind: "merchant-terms-read",
      idempotencyKey: "terms:purchase-13",
      payloadDigest: evidenceDigest(preparedBytes),
      preparedBytes,
    });
    const claim = journal.claimEffect(effect.id, "executor-a", 10_000);
    assert.ok(claim);
    const result = evidenceDigest("merchant-response");
    assert.equal(
      journal.recordEffectObservation(effect.id, claim.lease, { status: "observed", resultDigest: result }).state,
      "observed"
    );
    assert.equal(
      journal.recordEffectObservation(effect.id, claim.lease, { status: "observed", resultDigest: result }).resultDigest,
      result
    );
    assert.throws(
      () =>
        journal.recordEffectObservation(effect.id, claim.lease, {
          status: "observed",
          resultDigest: evidenceDigest("conflicting-response"),
        }),
      JournalInvariantError
    );
    assert.equal(journal.effectObservations(effect.id).length, 1);
  });
});

test("recovery skips a live executor and cannot invalidate its submission fence", async () => {
  await withAsyncJournal(async ({ journal }) => {
    const purchase = authorizedPurchase(journal, 65);
    const preparedBytes = Buffer.from("live-executor-request");
    const effect = journal.planEffect({
      purchaseId: purchase,
      kind: "live-executor",
      idempotencyKey: "live:executor:65",
      payloadDigest: evidenceDigest(preparedBytes),
      preparedBytes,
    });
    const claim = journal.claimEffect(effect.id, "live-worker", 60_000);
    assert.ok(claim);
    let observerCalls = 0;
    const reconciler = new PurchaseReconciler(
      journal,
      new Map([
        [
          "live-executor",
          {
            async observe() {
              observerCalls++;
              return {
                status: "not_found" as const,
                safeToRetry: true,
                detailDigest: evidenceDigest("not-found"),
              };
            },
          },
        ],
      ])
    );
    const summary = await reconciler.reconcile("recovery-worker", 1_000);
    assert.equal(observerCalls, 0);
    assert.equal(summary.leaseLost, false);
    assert.equal(summary.results[0]?.status, "executor_active");
    assert.equal(journal.requireEffect(effect.id).state, "executing");
    assert.equal(
      journal.markEffectSubmitted(claim, evidenceDigest("live-submission-ack")).state,
      "submitted"
    );
  });
});

test("submitted Payment Attempts cannot be failed outside proof-backed reconciliation", () => {
  withJournal(({ journal, clock }) => {
    const flow = preparedPaymentFlow(journal, 66, clock.value);
    journal.beginPaymentSubmission(flow.effect.id, flow.reservation.id, "executor", 10_000);
    assert.throws(
      () =>
        journal.failPaymentAttempt(
          flow.purchaseId,
          1,
          "submitted" as "planned",
          "unsafe_manual_failure"
        ),
      JournalInvariantError
    );
    assert.equal(journal.requirePaymentAttempt(flow.purchaseId, 1).state, "submitted");
    assert.equal(journal.requireReservation(flow.reservation.id).state, "in_flight");
  });
});

test("stale recovery workers are rejected by monotonically increasing fencing generations", () => {
  withJournal(({ journal, clock }) => {
    const purchase = createPurchase(journal, 14);
    const workerA = journal.acquireLease("purchase-reconciliation", "worker-a", 100);
    assert.ok(workerA);
    clock.value += 101;
    const workerB = journal.acquireLease("purchase-reconciliation", "worker-b", 100);
    assert.ok(workerB);
    assert.equal(workerB.generation, workerA.generation + 1);
    assert.throws(
      () => journal.recordReconciliation(workerA, purchase.id, undefined, "stale_write"),
      JournalFencingError
    );
    assert.equal(
      journal.recordReconciliation(workerB, purchase.id, undefined, "current_write").leaseGeneration,
      workerB.generation
    );
  });
});

test("a not-found recovery proof can release in-flight capacity without blind retry", () => {
  withJournal(({ journal, clock }) => {
    const flow = preparedPaymentFlow(journal, 15, clock.value);
    journal.beginPaymentSubmission(flow.effect.id, flow.reservation.id, "executor-a", 10_000);
    clock.value += 10_001;
    const recovery = journal.acquireLease("purchase-reconciliation", "recovery-a", 10_000);
    assert.ok(recovery);
    const proof = evidenceDigest("chain-and-merchant-not-found");
    assert.equal(
      journal.recordEffectObservation(flow.effect.id, recovery, {
        status: "not_found",
        safeToRetry: true,
        detailDigest: proof,
      }).state,
      "retryable"
    );
    assert.equal(journal.releaseInFlightReservation(flow.reservation.id, flow.effect.id, recovery, proof).state, "released");
    assert.equal(journal.requirePaymentAttempt(flow.purchaseId, 1).state, "failed");
    assert.equal(journal.requireEffect(flow.effect.id).state, "failed_terminal");
    assert.equal(journal.policyCapacityUsed(), 0n);
  });
});

test("an expired never-claimed preparation is abandoned without an external effect", () => {
  withJournal(({ journal, clock }) => {
    const flow = preparedPaymentFlow(journal, 69, clock.value);
    journal.transitionPurchase(flow.purchaseId, "authorised", "execution_prepared", "payment_execution_prepared");
    clock.value = flow.reservation.expiresAtMs + 1;

    const expired = journal.abandonExpiredPreparedPayment(flow.effect.id, flow.reservation.id);
    assert.equal(expired.state, "expired");
    assert.equal(journal.requireReservation(flow.reservation.id).state, "expired");
    assert.equal(journal.requirePaymentAttempt(flow.purchaseId, 1).state, "failed");
    assert.equal(journal.requireEffect(flow.effect.id).state, "abandoned");
    assert.deepEqual(journal.recoverableEffects(flow.purchaseId), []);
    assert.equal(journal.policyCapacityUsed(), 0n);
  });
});

test("expired never-claimed Treasury staging is abandoned without broadcasting", () => {
  withJournal(({ journal, clock }) => {
    const flow = plannedTreasuryStagingFlow(journal, 97, clock.value);
    journal.transitionPurchase(
      flow.purchaseId,
      "authorised",
      "execution_prepared",
      "treasury_staging_prepared"
    );
    clock.value = flow.reservation.expiresAtMs + 1;

    const expired = journal.abandonExpiredTreasuryStaging(
      flow.plan.effectId,
      flow.reservation.id
    );
    assert.equal(expired.state, "expired");
    assert.equal(journal.requireReservation(flow.reservation.id).state, "expired");
    assert.equal(journal.requirePaymentAttempt(flow.purchaseId, 1).state, "failed");
    assert.equal(journal.requireEffect(flow.plan.effectId).state, "abandoned");
    assert.deepEqual(journal.recoverableEffects(flow.purchaseId), []);
    assert.equal(journal.policyCapacityUsed(), 0n);
  });
});

test("observed spend is separate, immutable, bounded, and replaces reserved capacity with actual capacity", () => {
  withJournal(({ journal, reopen, clock }) => {
    const flow = preparedPaymentFlow(journal, 16, clock.value);
    const claim = journal.beginPaymentSubmission(flow.effect.id, flow.reservation.id, "executor-a", 10_000);
    assert.ok(claim);
    journal.markEffectSubmitted(claim, evidenceDigest("accepted-submit"));
    const settlement = verifiedEvidence(
      journal,
      flow.purchaseId,
      "settlement-16",
      "kaspa-settlement",
      1
    );
    const spendInput = {
      effectId: flow.effect.id,
      reservationId: flow.reservation.id,
      executionId: flow.preparation.executionId,
      mechanism: flow.preparation.mechanism,
      profile: flow.preparation.profile,
      transactionId: flow.preparation.transactionId,
      outpoint: `${flow.preparation.transactionId}:0`,
      actualAmountAtomic: "60",
      actualAdditionalCostAtomic: "2",
      asset: "KAS",
      payee: "kaspatest:merchant",
      network: "kaspa:testnet-10",
      settlementAssurance: "confirmed",
      fundingSource: "vault-treasury",
      evidenceDigest: settlement,
      evidenceVerificationProfile: "test-profile-v1",
      evidenceVerifierId: "test-verifier",
    } as const;
    assert.throws(() => journal.recordPurchaseSettlement(claim.lease, { ...spendInput, actualAmountAtomic: "1" }));
    assert.throws(() => journal.recordPurchaseSettlement(claim.lease, { ...spendInput, network: "wrong-network" }));
    assert.throws(() => journal.recordPurchaseSettlement(claim.lease, { ...spendInput, settlementAssurance: "channel-commitment" }));
    assert.throws(() => journal.recordPurchaseSettlement(claim.lease, { ...spendInput, asset: "NOT-KAS" }));
    assert.throws(() => journal.recordPurchaseSettlement(claim.lease, { ...spendInput, payee: "kaspatest:attacker" }));
    assert.equal(journal.requireReservation(flow.reservation.id).state, "in_flight");
    const spend = journal.recordPurchaseSettlement(claim.lease, spendInput);
    assert.equal(spend.actualAdditionalCostAtomic, "2");
    assert.equal(journal.requireReservation(flow.reservation.id).state, "spent");
    assert.equal(journal.requirePaymentAttempt(flow.purchaseId, 1).state, "observed");
    assert.equal(journal.requireEffect(flow.effect.id).state, "observed");
    assert.equal(journal.policyCapacityUsed(), 62n);
    assert.equal(journal.recordPurchaseSettlement(claim.lease, spendInput).id, spend.id);
    assert.throws(
      () => journal.recordPurchaseSettlement(claim.lease, { ...spendInput, actualAdditionalCostAtomic: "3" }),
      JournalInvariantError
    );

    journal.close();
    const restarted = reopen();
    assert.equal(restarted.requireSettlement(flow.reservation.id).transactionId, flow.preparation.transactionId);
    assert.equal(restarted.policyCapacityUsed(), 62n);
  });
});

test("startup reconciliation never executes effects and returns durable per-effect decisions", async () => {
  await withAsyncJournal(async ({ journal, clock }) => {
    const purchase = authorizedPurchase(journal, 17);
    const plannedBytes = Buffer.from("planned");
    const planned = journal.planEffect({
      purchaseId: purchase,
      kind: "planned-read",
      idempotencyKey: "planned:17",
      payloadDigest: evidenceDigest(plannedBytes),
      preparedBytes: plannedBytes,
    });
    const observableBytes = Buffer.from("observable");
    const observable = journal.planEffect({
      purchaseId: purchase,
      kind: "merchant-read",
      idempotencyKey: "observable:17",
      payloadDigest: evidenceDigest(observableBytes),
      preparedBytes: observableBytes,
    });
    const observableClaim = journal.claimEffect(observable.id, "executor-a", 10_000);
    assert.ok(observableClaim);
    journal.markEffectSubmitted(observableClaim, evidenceDigest("merchant-accepted"));
    const unknownBytes = Buffer.from("unknown");
    const unsupported = journal.planEffect({
      purchaseId: purchase,
      kind: "unknown-effect",
      idempotencyKey: "unknown:17",
      payloadDigest: evidenceDigest(unknownBytes),
      preparedBytes: unknownBytes,
    });
    const unsupportedClaim = journal.claimEffect(unsupported.id, "executor-b", 10_000);
    assert.ok(unsupportedClaim);
    journal.markEffectSubmitted(unsupportedClaim, evidenceDigest("unknown-accepted"));
    clock.value += 10_001;

    let calls = 0;
    const reconciler = new PurchaseReconciler(
      journal,
      new Map([
        [
          "merchant-read",
          {
            async observe() {
              calls++;
              return { status: "observed" as const, resultDigest: evidenceDigest("merchant-result") };
            },
          },
        ],
      ])
    );
    const summary = await reconciler.reconcile("recovery-worker", 1_000);
    assert.equal(summary.acquired, true);
    assert.equal(summary.leaseLost, false);
    assert.equal(calls, 1);
    const byId = new Map(summary.results.map((result) => [result.effectId, result.status]));
    assert.equal(byId.get(planned.id), "ready_to_execute");
    assert.equal(byId.get(observable.id), "observed");
    assert.equal(byId.get(unsupported.id), "unsupported");
    assert.equal(journal.requireEffect(planned.id).state, "planned");
    assert.equal(journal.requireEffect(observable.id).state, "observed");
    assert.ok(journal.reconciliationRuns(purchase).length >= 3);
  });
});

test("reconciliation renews its fence across a slow observer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-slow-reconcile-"));
  const filename = path.join(directory, "purchase.sqlite");
  const journal = new PurchaseJournal(filename);
  const reconciliationLeaseMs = 1_000;
  try {
    const purchase = authorizedPurchase(journal, 18);
    const preparedBytes = Buffer.from("slow");
    const effect = journal.planEffect({
      purchaseId: purchase,
      kind: "slow-observer",
      idempotencyKey: "slow:18",
      payloadDigest: evidenceDigest(preparedBytes),
      preparedBytes,
    });
    const claim = journal.claimEffect(effect.id, "executor", 30_000);
    assert.ok(claim);
    journal.markEffectSubmitted(claim, evidenceDigest("slow-accepted"));
    assert.equal(journal.releaseLease(claim.lease), true);
    const reconciler = new PurchaseReconciler(
      journal,
      new Map([
        [
          "slow-observer",
          {
            async observe() {
              await new Promise((resolve) => setTimeout(resolve, 2_200));
              return { status: "observed" as const, resultDigest: evidenceDigest("slow-result") };
            },
          },
        ],
      ])
    );
    const summary = await reconciler.reconcile("slow-worker", reconciliationLeaseMs);
    assert.equal(summary.leaseLost, false);
    assert.equal(summary.results[0]?.status, "observed");
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restart distinguishes not-attempted, prepared, submitted, settled, fulfilled, and receipted", () => {
  withJournal(({ journal, reopen, clock }) => {
    const notAttempted = createPurchase(journal, 20);
    const prepared = preparedPaymentFlow(journal, 21, clock.value);
    const submitted = preparedPaymentFlow(journal, 22, clock.value);
    journal.beginPaymentSubmission(submitted.effect.id, submitted.reservation.id, "executor-22", 10_000);

    const settled = advanceLifecycle(journal, 23, clock.value, "settled");
    const fulfilled = advanceLifecycle(journal, 24, clock.value, "fulfilled");
    const receipted = advanceLifecycle(journal, 25, clock.value, "receipted");

    journal.close();
    const restarted = reopen();
    assert.equal(restarted.requirePurchase(notAttempted.id).state, "created");
    assert.equal(restarted.requirePaymentAttempt(prepared.purchaseId, 1).state, "prepared");
    assert.equal(restarted.requirePaymentAttempt(submitted.purchaseId, 1).state, "submitted");
    assert.equal(restarted.requireEffect(submitted.effect.id).state, "executing");
    assert.equal(restarted.requirePurchase(settled).state, "settled");
    assert.equal(restarted.requirePurchase(fulfilled).state, "fulfilled");
    assert.equal(restarted.requirePurchase(receipted).state, "receipted");
  });
});

test("newer, unversioned, tampered, corrupted, and symlinked databases fail closed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-guard-"));
  try {
    const newerPath = path.join(directory, "newer.sqlite");
    const newer = new Database(newerPath);
    newer.pragma("user_version = 99");
    newer.close();
    assert.throws(() => new PurchaseJournal(newerPath), JournalInvariantError);

    const unversionedPath = path.join(directory, "unversioned.sqlite");
    const unversioned = new Database(unversionedPath);
    unversioned.exec("CREATE TABLE foreign_data (id INTEGER)");
    unversioned.close();
    assert.throws(() => new PurchaseJournal(unversionedPath), JournalInvariantError);

    const tamperedPath = path.join(directory, "tampered.sqlite");
    const valid = new PurchaseJournal(tamperedPath);
    valid.close();
    const tampered = new Database(tamperedPath);
    tampered.exec("DROP INDEX one_payment_reservation_per_purchase");
    tampered.close();
    assert.throws(() => new PurchaseJournal(tamperedPath), JournalInvariantError);

    const semanticPath = path.join(directory, "semantic-corruption.sqlite");
    const semantic = new PurchaseJournal(semanticPath);
    const semanticPurchase = authorizedPurchase(semantic, 67);
    semantic.close();
    const semanticRaw = new Database(semanticPath);
    semanticRaw
      .prepare("UPDATE purchases SET state = 'receipted', version = 99 WHERE id = ?")
      .run(semanticPurchase);
    semanticRaw.close();
    assert.throws(() => new PurchaseJournal(semanticPath), JournalInvariantError);

    const effectSemanticPath = path.join(directory, "effect-semantic-corruption.sqlite");
    const effectSemantic = new PurchaseJournal(effectSemanticPath);
    const effectPurchase = authorizedPurchase(effectSemantic, 68);
    const effectBytes = Buffer.from("semantic-effect");
    const semanticEffect = effectSemantic.planEffect({
      purchaseId: effectPurchase,
      kind: "semantic-effect",
      idempotencyKey: "semantic:effect:68",
      payloadDigest: evidenceDigest(effectBytes),
      preparedBytes: effectBytes,
    });
    const semanticClaim = effectSemantic.claimEffect(semanticEffect.id, "semantic-executor", 60_000);
    assert.ok(semanticClaim);
    effectSemantic.markEffectSubmitted(semanticClaim, evidenceDigest("semantic-submit"));
    effectSemantic.close();
    const effectRaw = new Database(effectSemanticPath);
    effectRaw
      .prepare("UPDATE effects SET state = 'retryable', version = version + 1 WHERE id = ?")
      .run(semanticEffect.id);
    effectRaw.close();
    assert.throws(() => new PurchaseJournal(effectSemanticPath), JournalInvariantError);

    const corruptPath = path.join(directory, "corrupt.sqlite");
    const corrupt = new PurchaseJournal(corruptPath);
    corrupt.close();
    const descriptor = fs.openSync(corruptPath, "r+");
    fs.writeSync(descriptor, Buffer.alloc(32, 0xff), 0, 32, 0);
    fs.closeSync(descriptor);
    assert.throws(() => new PurchaseJournal(corruptPath));

    const target = path.join(directory, "target.sqlite");
    fs.writeFileSync(target, "not a database", { mode: 0o600 });
    const link = path.join(directory, "linked.sqlite");
    fs.symlinkSync(target, link);
    assert.throws(() => new PurchaseJournal(link), JournalInvariantError);

    const hardlinkSource = path.join(directory, "hardlink-source.sqlite");
    const hardlinkJournal = new PurchaseJournal(hardlinkSource);
    hardlinkJournal.close();
    const hardlinkAlias = path.join(directory, "hardlink-alias.sqlite");
    fs.linkSync(hardlinkSource, hardlinkAlias);
    assert.throws(() => new PurchaseJournal(hardlinkSource), JournalInvariantError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function withJournal(
  run: (context: {
    directory: string;
    filename: string;
    evidenceDirectory: string;
    journal: PurchaseJournal;
    reopen: () => PurchaseJournal;
    clock: TestClock;
  }) => void
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-test-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const clock = testClock();
  let journal = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
  try {
    run({
      directory,
      filename,
      evidenceDirectory,
      journal,
      reopen: () => {
        journal = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
        return journal;
      },
      clock,
    });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function withAsyncJournal(
  run: (context: { journal: PurchaseJournal; clock: TestClock }) => Promise<void>
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-async-"));
  const clock = testClock();
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: clock.now,
    evidenceDirectory: path.join(directory, "evidence"),
  });
  try {
    await run({ journal, clock });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

interface TestClock {
  value: number;
  now: () => number;
}

function testClock(): TestClock {
  const clock = {
    value: 1_800_000_000_000,
    now() {
      return clock.value;
    },
  };
  return clock;
}

function purchaseInput(seed: number) {
  const id = createPurchaseId(new Uint8Array(16).fill(seed));
  const resource = { url: `https://merchant.example/resource/${seed}`, method: "GET" };
  return {
    id,
    requestKey: assertPurchaseRequestKey(`test:purchase:${seed}`),
    resourceUrl: resource.url,
    method: resource.method,
    resourceFingerprint: requestFingerprint(resource),
    expectedMerchantId: "merchant:test",
    expectedMerchantOrigin: "https://merchant.example",
  };
}

function createPurchase(journal: PurchaseJournal, seed: number): PurchaseRecord {
  return journal.createPurchase(purchaseInput(seed));
}

function authorizedPurchase(
  journal: PurchaseJournal,
  seed: number,
  amountAtomic = "60",
  finalityArtifact: Partial<{
    profile: string;
    operatorFinalityFloor: "accepted" | "depth-confirmed";
    effectiveFinalityFloor: "accepted" | "depth-confirmed";
    depthConfirmationDaa: string;
    settlementAssurance: "accepted" | "confirmed" | "channel-commitment";
  }> = {}
): PurchaseId {
  const purchase = createPurchase(journal, seed);
  const checkoutEvidence = verifiedEvidence(
    journal,
    purchase.id,
    `checkout-${seed}`,
    "checkout-terms",
    undefined,
    "test-profile-v1",
    "merchant:test"
  );
  const requirementsEvidence = verifiedEvidence(
    journal,
    purchase.id,
    `requirements-${seed}`,
    "payment-requirements",
    undefined,
    "test-profile-v1",
    "merchant:test"
  );
  const checkoutDigest = checkoutEvidence;
  const executionPlan = journal.storeExecutionPlanEvidence(purchase.id, {
    mechanism: "single-transaction",
    profile: "kaspa-exact-v2:standard-native",
    requirementsDigest: requirementsEvidence,
    maximumChargeAtomic: amountAtomic,
    settlementAssurance: "accepted",
  });
  journal.bindCheckoutTerms(purchase.id, {
    terms: {
      merchant: { id: "merchant:test", name: "Test Merchant", origin: "https://merchant.example" },
      resourceFingerprint: purchase.resourceFingerprint,
      amountAtomic,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: "kaspatest:merchant",
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest,
    },
    checkoutEvidenceDigest: checkoutEvidence,
    checkoutVerificationProfile: "test-profile-v1",
    checkoutVerifierId: "test-verifier",
    paymentRequirementsDigest: requirementsEvidence,
    paymentRequirementsVerificationProfile: "test-profile-v1",
    paymentRequirementsVerifierId: "test-verifier",
    executionPlan: executionPlan.plan,
    executionPlanEvidenceDigest: executionPlan.evidenceDigest,
  });
  const authorizationRequestArtifact = JSON.stringify({
    profile: "urn:sompi:authorization-request:2",
    seed,
    operatorFinalityFloor: "accepted",
    effectiveFinalityFloor: "accepted",
    depthConfirmationDaa: "10",
    settlementAssurance: "accepted",
    ...finalityArtifact,
  });
  const requestDigest = evidenceDigest(authorizationRequestArtifact);
  verifiedEvidence(journal, purchase.id, authorizationRequestArtifact, "authorization-request");
  journal.storeEvidence(purchase.id, {
    bytes: new Uint8Array(),
    mediaType: "application/octet-stream",
    profile: "urn:sompi:purchase-request-body:1",
    kind: "purchase-request-body",
  });
  const nonceDigest = evidenceDigest(`authorization-nonce-${seed}`);
  const expiresAtMs = Date.parse("2099-01-01T00:00:00.000Z");
  journal.recordAuthorizationRequest(purchase.id, {
    checkoutDigest,
    requestDigest,
    nonceDigest,
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    additionalCostCeilingAtomic: "10",
    effectiveFinalityFloor: "accepted",
    expiresAtMs,
  });
  const storedAuthorizationRequest = journal.requireAuthorizationRequest(purchase.id);
  const authorizationEvidence = verifiedEvidence(
    journal,
    purchase.id,
    `authorization-${seed}`,
    "purchase-authorization"
  );
  const terms = journal.requireCheckoutTerms(purchase.id);
  const approvedFactsDigest = authorizationFactsDigest({
    purchaseId: purchase.id,
    resourceUrl: purchase.resourceUrl,
    method: purchase.method,
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    terms,
    requestDigest,
    nonceDigest,
    additionalCostCeilingAtomic: "10",
    operatorFinalityFloor: "accepted",
    effectiveFinalityFloor: "accepted",
    depthConfirmationDaa: "10",
    executionPlanDigest: storedAuthorizationRequest.executionPlanDigest,
    executionMechanism: storedAuthorizationRequest.executionMechanism,
    executionProfile: storedAuthorizationRequest.executionProfile,
    settlementAssurance: storedAuthorizationRequest.settlementAssurance,
    maximumAuthorizedChargeAtomic: storedAuthorizationRequest.maximumAuthorizedChargeAtomic,
    createdAtMs: storedAuthorizationRequest.createdAtMs,
    expiresAtMs,
  });
  journal.recordAuthorizationDecision(purchase.id, {
    decision: "approved",
    authorityId: "authority:test",
    checkoutDigest,
    approvedFactsDigest,
    evidenceDigest: authorizationEvidence,
    verificationProfile: "test-profile-v1",
    verifierId: "test-verifier",
    requestDigest,
    nonceDigest,
    expiresAtMs,
  });
  return purchase.id;
}

function installPolicy(
  journal: PurchaseJournal,
  overrides: Partial<{ maxPerPaymentAtomic: string; maxPerHourAtomic: string;}> = {}
): PolicySnapshotRecord {
  return journal.installPolicy({
    maxPerPaymentAtomic: overrides.maxPerPaymentAtomic ?? "1000",
    maxPerHourAtomic: overrides.maxPerHourAtomic ?? "10000",
    allowlist: ["kaspatest:merchant"],
  });
}

function reserve(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  policy: PolicySnapshotRecord,
  id: string,
  now: number,
  amountAtomic = "60",
  additionalCostCeilingAtomic = "10",
  approvalEvidenceDigest?: Sha256Digest
) {
  const authorization = journal.requireAuthorization(purchaseId);
  const boundEvidenceDigest = approvalEvidenceDigest ?? authorization.evidenceDigest;
  return journal.reservePolicy({
    id,
    purchaseId,
    policyDigest: policy.digest,
    payee: "kaspatest:merchant",
    amountAtomic,
    additionalCostCeilingAtomic,
    fundingSource: "vault-treasury",
    expiresAtMs: now + 60_000,
    approvalEvidenceDigest: boundEvidenceDigest,
    approvalVerificationProfile: authorization.verificationProfile,
    approvalVerifierId: authorization.verifierId,
  });
}

function reservationTerms(
  purchaseId: PurchaseId,
  policy: PolicySnapshotRecord,
  id: string,
  now: number
): PolicyReservationInput {
  return {
    id,
    purchaseId,
    policyDigest: policy.digest,
    payee: "kaspatest:merchant",
    amountAtomic: "60",
    additionalCostCeilingAtomic: "10",
    fundingSource: "vault-treasury",
    expiresAtMs: now + 60_000,
  };
}

function paymentPreparation(
  purchaseId: PurchaseId,
  reservationId: string,
  seed: number
): PreparePaymentAttemptInput {
  const preparedBytes = Buffer.from(`payload-${seed}`, "utf8");
  const transactionId = seed.toString(16).padStart(2, "0").repeat(32);
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

function treasuryStagingInput(
  purchaseId: PurchaseId,
  reservationId: string,
  seed: number
) {
  const preparedBytes = Buffer.from(`treasury-staging-${seed}`, "utf8");
  const plannedTransactionId = (seed + 32).toString(16).padStart(2, "0").repeat(32);
  return {
    purchaseId,
    attempt: 1,
    reservationId,
    idempotencyKey: `treasury-staging:${createPaymentIdentifier(purchaseId, 1)}`,
    payloadDigest: evidenceDigest(preparedBytes),
    preparedBytes,
    plannedTransactionId,
    expectedOutpoint: `${plannedTransactionId}:0`,
    stagingAmountAtomic: "70",
    fundingSource: "vault-treasury" as const,
  };
}

function plannedTreasuryStagingFlow(journal: PurchaseJournal, seed: number, now: number) {
  const purchaseId = authorizedPurchase(journal, seed);
  let policy: PolicySnapshotRecord;
  try {
    policy = journal.requireActivePolicy();
  } catch {
    policy = installPolicy(journal);
  }
  const reservation = reserve(journal, purchaseId, policy, `staging-reservation-${seed}`, now);
  journal.createPaymentAttempt({
    purchaseId,
    attempt: 1,
    identifier: createPaymentIdentifier(purchaseId, 1),
  });
  const input = treasuryStagingInput(purchaseId, reservation.id, seed);
  const plan = commitTreasuryStaging(journal, input);
  return { purchaseId, policy, reservation, input, plan };
}

function commitTreasuryStaging(
  journal: PurchaseJournal,
  input: PlanTreasuryStagingInput,
) {
  const lease = journal.acquireLease(
    treasuryStagingPreparationLeaseName(input.purchaseId, input.attempt),
    "journal-test-staging-planner",
    60_000,
  );
  assert.ok(lease);
  try {
    return journal.commitTreasuryStagingPreparation(lease, input);
  } finally {
    journal.releaseLease(lease);
  }
}

function preparedPaymentFlow(journal: PurchaseJournal, seed: number, now: number) {
  const purchaseId = authorizedPurchase(journal, seed);
  let policy: PolicySnapshotRecord;
  try {
    policy = journal.requireActivePolicy();
  } catch {
    policy = installPolicy(journal);
  }
  const reservation = reserve(journal, purchaseId, policy, `reservation-${seed}`, now);
  journal.createPaymentAttempt({
    purchaseId,
    attempt: 1,
    identifier: createPaymentIdentifier(purchaseId, 1),
  });
  const input = paymentPreparation(purchaseId, reservation.id, seed);
  const preparation = journal.preparePaymentAttempt(input);
  const effect = journal.planEffect({
    purchaseId,
    attempt: 1,
    kind: "kaspa-exact-payment",
    idempotencyKey: `payment:${createPaymentIdentifier(purchaseId, 1)}`,
    payloadDigest: preparation.payloadDigest,
    preparedBytes: input.preparedBytes,
  });
  return { purchaseId, policy, reservation, preparation, effect };
}

function verifiedEvidence(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  value: string,
  kind: string,
  attempt?: number,
  profile = "test-profile-v1",
  issuer = "test-issuer"
): Sha256Digest {
  const artifact = journal.storeEvidence(purchaseId, {
    bytes: Buffer.from(value, "utf8"),
    mediaType: "application/octet-stream",
    profile,
    issuer,
    kind,
    attempt,
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "test-verifier",
    profile,
    detailDigest: evidenceDigest(`verified:${value}`),
  });
  return artifact.digest;
}

function advanceLifecycle(
  journal: PurchaseJournal,
  seed: number,
  now: number,
  target: "settled" | "fulfilled" | "receipted"
): PurchaseId {
  const flow = preparedPaymentFlow(journal, seed, now);
  const purchaseId = flow.purchaseId;
  journal.transitionPurchase(purchaseId, "authorised", "execution_prepared", "execution_prepared");
  const claim = journal.beginPaymentSubmission(flow.effect.id, flow.reservation.id, `executor-${seed}`, 10_000);
  assert.ok(claim);
  journal.transitionPurchase(purchaseId, "execution_prepared", "submitted", "payment_submitted");
  journal.markEffectSubmitted(claim, evidenceDigest(`submission-${seed}`));
  const settlement = verifiedEvidence(journal, purchaseId, `settlement-${seed}`, "kaspa-settlement", 1);
  journal.recordPurchaseSettlement(claim.lease, {
    effectId: flow.effect.id,
    reservationId: flow.reservation.id,
    executionId: flow.preparation.executionId,
    mechanism: flow.preparation.mechanism,
    profile: flow.preparation.profile,
    transactionId: flow.preparation.transactionId,
    outpoint: `${flow.preparation.transactionId}:0`,
    actualAmountAtomic: "60",
    actualAdditionalCostAtomic: "2",
    fundingSource: "vault-treasury",
    asset: "KAS",
    payee: "kaspatest:merchant",
    network: "kaspa:testnet-10",
    settlementAssurance: "confirmed",
    evidenceDigest: settlement,
    evidenceVerificationProfile: "test-profile-v1",
    evidenceVerifierId: "test-verifier",
  });
  journal.transitionPurchase(purchaseId, "submitted", "settled", "payment_settled");
  if (target === "settled") return purchaseId;
  const body = verifiedEvidence(journal, purchaseId, `body-${seed}`, "fulfilment-body", 1);
  const merchantEvidence = verifiedEvidence(
    journal,
    purchaseId,
    `merchant-fulfilment-${seed}`,
    "merchant-fulfilment",
    1
  );
  journal.recordFulfilment(purchaseId, {
    attempt: 1,
    httpStatus: 200,
    resourceFingerprint: journal.requireCheckoutTerms(purchaseId).resourceFingerprint,
    bodyDigest: body,
    bodyByteLength: Buffer.byteLength(`body-${seed}`),
    mediaType: "application/octet-stream",
    merchantEvidenceDigest: merchantEvidence,
    merchantVerificationProfile: "test-profile-v1",
    merchantVerifierId: "test-verifier",
  });
  if (target === "fulfilled") return purchaseId;
  const authorization = journal.requireAuthorization(purchaseId);
  const joins = {
    checkoutDigest: journal.requireCheckoutTerms(purchaseId).checkoutDigest,
    authorizationEvidenceDigest: authorization.evidenceDigest,
    settlementEvidenceDigest: settlement,
    fulfilmentDigest: body,
  };
  const receiptEvidence = verifiedEvidence(
    journal,
    purchaseId,
    `purchase-receipt-${seed}`,
    "purchase-receipt",
    undefined,
    "urn:sompi:receipt:purchase:1"
  );
  journal.recordReceipt(purchaseId, {
    evidenceDigest: receiptEvidence,
    profile: "urn:sompi:receipt:purchase:1",
    issuer: "test-issuer",
    verifierId: "test-verifier",
    ...joins,
  });
  return purchaseId;
}
