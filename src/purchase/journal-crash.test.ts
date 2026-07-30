import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JournalNotFoundError } from "../journal/contracts.js";
import type { PreparePaymentAttemptInput } from "./journal-contracts.js";
import {
  PurchaseJournal,
  type JournalFaultPoint,
} from "./journal.js";
import type {
  PolicyReservationInput,
  PolicySnapshotRecord,
} from "../treasury/operation-journal.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "./identity.js";
import { PurchaseReconciler } from "./reconciliation.js";
import { authorizationFactsDigest } from "./contracts.js";
import type { PurchaseId } from "./types.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const JOURNAL_MODULE = pathToFileURL(
  path.join(REPOSITORY_ROOT, "dist", "purchase", "journal.js")
).href;

test("SIGKILL during a Purchase transition leaves state and history atomic", () => {
  withCrashJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const purchase = createPurchase(journal, 31);
    journal.close();
    const child = runKilled(
      `
        const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
        const journal = new PurchaseJournal(process.env.DB, {
          now: () => Number(process.env.NOW),
          evidenceDirectory: process.env.EVIDENCE,
          faultInjector(point) {
            if (point === "purchase_transition.after_state_update") process.kill(process.pid, "SIGKILL");
          }
        });
        journal.transitionPurchase(process.env.PURCHASE_ID, "created", "cancelled", "purchase_cancelled");
      `,
      {
        DB: filename,
        EVIDENCE: evidenceDirectory,
        NOW: String(clock.value),
        PURCHASE_ID: purchase.id,
      }
    );
    assert.equal(child.signal, "SIGKILL");
    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.requirePurchase(purchase.id).state, "created");
    assert.equal(recovered.transitions(purchase.id).length, 1);
    assert.equal(recovered.integrityCheck(), true);
    recovered.close();
  });
});

test("SIGKILL before and after preparation commit distinguishes planned from prepared", () => {
  withCrashJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const setup = preparedSetup(journal, 32, clock.value);
    journal.close();
    const preparationJson = JSON.stringify(setup.preparation);

    const beforeCommit = runKilled(
      `
        const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
        const journal = new PurchaseJournal(process.env.DB, {
          now: () => Number(process.env.NOW),
          evidenceDirectory: process.env.EVIDENCE,
          faultInjector(point) {
            if (point === "payment_preparation.after_insert") process.kill(process.pid, "SIGKILL");
          }
        });
        const preparation = JSON.parse(process.env.PREPARATION);
        preparation.preparedBytes = Buffer.from(preparation.preparedBytes.data);
        journal.preparePaymentAttempt(preparation);
      `,
      {
        DB: filename,
        EVIDENCE: evidenceDirectory,
        NOW: String(clock.value),
        PREPARATION: preparationJson,
      }
    );
    assert.equal(beforeCommit.signal, "SIGKILL");
    let recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.requirePaymentAttempt(setup.purchaseId, 1).state, "planned");
    assert.throws(() => recovered.requirePaymentPreparation(setup.purchaseId, 1), JournalNotFoundError);
    recovered.close();

    const afterCommit = runKilled(
      `
        const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
        const journal = new PurchaseJournal(process.env.DB, {
          now: () => Number(process.env.NOW),
          evidenceDirectory: process.env.EVIDENCE
        });
        const preparation = JSON.parse(process.env.PREPARATION);
        preparation.preparedBytes = Buffer.from(preparation.preparedBytes.data);
        journal.preparePaymentAttempt(preparation);
        process.kill(process.pid, "SIGKILL");
      `,
      {
        DB: filename,
        EVIDENCE: evidenceDirectory,
        NOW: String(clock.value),
        PREPARATION: preparationJson,
      }
    );
    assert.equal(afterCommit.signal, "SIGKILL");
    recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.requirePaymentAttempt(setup.purchaseId, 1).state, "prepared");
    assert.equal(
      recovered.requirePaymentPreparation(setup.purchaseId, 1).payloadDigest,
      setup.preparation.payloadDigest
    );
    recovered.close();
  });
});

test("SIGKILL after effect claim preserves submitted-attempt ambiguity and in-flight capacity", () => {
  withCrashJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const flow = completePreparedFlow(journal, 33, clock.value);
    journal.close();
    const child = runKilled(
      `
        const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
        const journal = new PurchaseJournal(process.env.DB, {
          now: () => Number(process.env.NOW),
          evidenceDirectory: process.env.EVIDENCE
        });
        journal.beginPaymentSubmission(
          process.env.EFFECT_ID,
          process.env.RESERVATION_ID,
          "crash-executor",
          60000
        );
        process.kill(process.pid, "SIGKILL");
      `,
      {
        DB: filename,
        EVIDENCE: evidenceDirectory,
        NOW: String(clock.value),
        EFFECT_ID: flow.effectId,
        RESERVATION_ID: flow.reservationId,
      }
    );
    assert.equal(child.signal, "SIGKILL");
    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.requireEffect(flow.effectId).state, "executing");
    assert.equal(recovered.requirePaymentAttempt(flow.purchaseId, 1).state, "submitted");
    assert.equal(recovered.requireReservation(flow.reservationId).state, "in_flight");
    clock.value += 120_000;
    recovered.expireReservations();
    assert.equal(recovered.requireReservation(flow.reservationId).state, "in_flight");
    assert.equal(recovered.policyCapacityUsed(), 70n);
    recovered.close();
  });
});

test("external success followed by SIGKILL is observed without executing the effect again", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-external-marker-crash-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const marker = path.join(directory, "external-success.marker");
  const clock = testClock();
  let journal = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
  try {
    const purchase = authorizedPurchase(journal, 35);
    const preparedBytes = Buffer.from("external-marker-request");
    const effect = journal.planEffect({
      purchaseId: purchase,
      kind: "external-marker",
      idempotencyKey: "external:marker:35",
      payloadDigest: evidenceDigest(preparedBytes),
      preparedBytes,
    });
    journal.close();
    const child = runKilled(
      `
        const fs = await import("node:fs");
        const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
        const journal = new PurchaseJournal(process.env.DB, {
          now: () => Number(process.env.NOW),
          evidenceDirectory: process.env.EVIDENCE
        });
        journal.claimEffect(process.env.EFFECT_ID, "marker-executor", 1000);
        fs.writeFileSync(process.env.MARKER, "external-operation-completed", { mode: 0o600 });
        process.kill(process.pid, "SIGKILL");
      `,
      {
        DB: filename,
        EVIDENCE: evidenceDirectory,
        NOW: String(clock.value),
        EFFECT_ID: effect.id,
        MARKER: marker,
      }
    );
    assert.equal(child.signal, "SIGKILL");
    assert.equal(fs.readFileSync(marker, "utf8"), "external-operation-completed");
    clock.value += 1_001;
    journal = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    let observerCalls = 0;
    const reconciler = new PurchaseReconciler(
      journal,
      new Map([
        [
          "external-marker",
          {
            async observe() {
              observerCalls++;
              assert.equal(fs.existsSync(marker), true);
              return { status: "observed" as const, resultDigest: evidenceDigest(fs.readFileSync(marker)) };
            },
          },
        ],
      ])
    );
    const summary = await reconciler.reconcile("marker-recovery", 10_000);
    assert.equal(observerCalls, 1);
    assert.equal(summary.results[0]?.status, "observed");
    assert.equal(journal.requireEffect(effect.id).state, "observed");
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SIGKILL during spend finalization rolls back spend, effect, Attempt, and Reservation together", () => {
  withCrashJournal(({ filename, evidenceDirectory, journal, clock }) => {
    const flow = completePreparedFlow(journal, 34, clock.value);
    const claim = journal.beginPaymentSubmission(flow.effectId, flow.reservationId, "spend-executor", 60_000);
    assert.ok(claim);
    journal.markEffectSubmitted(claim, evidenceDigest("submit-ack"));
    const settlement = verifiedEvidence(journal, flow.purchaseId, "settlement-34", 1);
    const spend = {
      effectId: flow.effectId,
      reservationId: flow.reservationId,
      executionId: flow.transactionId,
      mechanism: "single-transaction",
      profile: "kaspa-exact-v2:standard-native",
      transactionId: flow.transactionId,
      actualAmountAtomic: "60",
      actualAdditionalCostAtomic: "2",
      fundingSource: "vault-treasury",
      asset: "KAS",
      payee: "kaspatest:merchant",
      network: "kaspa:testnet-10",
      settlementAssurance: "confirmed",
      evidenceDigest: settlement,
      evidenceVerificationProfile: "test-v1",
      evidenceVerifierId: "test-verifier",
    };
    journal.close();

    const child = runKilled(
      `
        const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
        const journal = new PurchaseJournal(process.env.DB, {
          now: () => Number(process.env.NOW),
          evidenceDirectory: process.env.EVIDENCE,
          faultInjector(point) {
            if (point === "settlement.after_insert") process.kill(process.pid, "SIGKILL");
          }
        });
        journal.recordPurchaseSettlement(JSON.parse(process.env.LEASE), JSON.parse(process.env.SPEND));
      `,
      {
        DB: filename,
        EVIDENCE: evidenceDirectory,
        NOW: String(clock.value),
        LEASE: JSON.stringify(claim.lease),
        SPEND: JSON.stringify(spend),
      }
    );
    assert.equal(child.signal, "SIGKILL");
    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.throws(() => recovered.requireSettlement(flow.reservationId), JournalNotFoundError);
    assert.equal(recovered.requireReservation(flow.reservationId).state, "in_flight");
    assert.equal(recovered.requirePaymentAttempt(flow.purchaseId, 1).state, "submitted");
    assert.equal(recovered.requireEffect(flow.effectId).state, "submitted");
    assert.equal(recovered.integrityCheck(), true);
    recovered.close();
  });
});

test("fault hooks roll back every insert-only journal edge", () => {
  const cases: Array<{
    point: JournalFaultPoint;
    setup: (journal: PurchaseJournal, clock: TestClock) => (target: PurchaseJournal) => void;
    verify: (journal: PurchaseJournal) => void;
  }> = [
    {
      point: "purchase.after_insert",
      setup: (journal) => {
        void journal;
        const input = purchaseInput(40);
        return (target) => {
          target.createPurchase(input);
        };
      },
      verify: (journal) => assert.equal(journal.findPurchase(purchaseInput(40).id), undefined),
    },
    {
      point: "policy.after_snapshot_insert",
      setup: (journal) => (target) => {
        void journal;
        target.installPolicy(policyDefinition());
      },
      verify: (journal) => assert.throws(() => journal.requireActivePolicy()),
    },
    {
      point: "reservation.after_insert",
      setup: (journal, clock) => {
        const purchase = authorizedPurchase(journal, 41);
        const policy = journal.installPolicy(policyDefinition());
        const input = reservationInput(journal, purchase, policy, "fault-reservation", clock.value);
        return (target) => {
          target.reservePolicy(input);
        };
      },
      verify: (journal) => {
        assert.throws(() => journal.requireReservation("fault-reservation"), JournalNotFoundError);
        assert.equal(journal.policyCapacityUsed(), 0n);
      },
    },
    {
      point: "payment_attempt.after_insert",
      setup: (journal) => {
        const purchase = authorizedPurchase(journal, 42);
        return (target) => {
          target.createPaymentAttempt({
            purchaseId: purchase,
            attempt: 1,
            identifier: createPaymentIdentifier(purchase, 1),
          });
        };
      },
      verify: (journal) => {
        const purchase = purchaseInput(42).id;
        assert.throws(() => journal.requirePaymentAttempt(purchase, 1), JournalNotFoundError);
      },
    },
    {
      point: "effect.after_insert",
      setup: (journal) => {
        const purchase = authorizedPurchase(journal, 43);
        return (target) => {
          const preparedBytes = Buffer.from("fault-effect");
          target.planEffect({
            purchaseId: purchase,
            kind: "fault-effect",
            idempotencyKey: "fault:effect:43",
            payloadDigest: evidenceDigest(preparedBytes),
            preparedBytes,
          });
        };
      },
      verify: (journal) => assert.deepEqual(journal.recoverableEffects(), []),
    },
    {
      point: "evidence.after_metadata_insert",
      setup: (journal) => {
        const purchase = createPurchase(journal, 44);
        return (target) => {
          target.storeEvidence(purchase.id, {
            bytes: Buffer.from("orphan-safe-evidence"),
            mediaType: "application/octet-stream",
            profile: "test-v1",
            kind: "fault-evidence",
          });
        };
      },
      verify: (journal) => assert.equal(journal.findEvidence(evidenceDigest("orphan-safe-evidence")), undefined),
    },
  ];

  for (const entry of cases) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-fault-edge-"));
    const filename = path.join(directory, "purchase.sqlite");
    const evidenceDirectory = path.join(directory, "evidence");
    const clock = testClock();
    let base = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    try {
      const action = entry.setup(base, clock);
      base.close();
      const faulted = new PurchaseJournal(filename, {
        now: clock.now,
        evidenceDirectory,
        faultInjector(point) {
          if (point === entry.point) throw new Error(`fault:${point}`);
        },
      });
      assert.throws(() => action(faulted), /fault:/);
      faulted.close();
      base = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
      entry.verify(base);
    } finally {
      base.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("two real processes racing at the hourly limit cannot both reserve", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-reservation-race-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const clock = testClock();
  const journal = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
  try {
    const purchaseA = authorizedPurchase(journal, 50);
    const purchaseB = authorizedPurchase(journal, 51);
    const policy = journal.installPolicy({
      ...policyDefinition(),
      maxPerHourAtomic: "100",
    });
    const reservationA = reservationInput(journal, purchaseA, policy, "race-a", clock.value, "60");
    const reservationB = reservationInput(journal, purchaseB, policy, "race-b", clock.value, "60");
    journal.close();
    const startAt = Date.now() + 300;
    const script = `
      const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
      while (Date.now() < Number(process.env.START_AT)) {}
      const journal = new PurchaseJournal(process.env.DB, {
        now: () => Number(process.env.NOW),
        evidenceDirectory: process.env.EVIDENCE
      });
      try {
        journal.reservePolicy(JSON.parse(process.env.RESERVATION));
        process.exit(0);
      } catch (error) {
        process.exit(2);
      }
    `;
    const common = {
      DB: filename,
      EVIDENCE: evidenceDirectory,
      NOW: String(clock.value),
      START_AT: String(startAt),
    };
    const [statusA, statusB] = await Promise.all([
      runChild(script, {
        ...common,
        RESERVATION: JSON.stringify(reservationA),
      }),
      runChild(script, {
        ...common,
        RESERVATION: JSON.stringify(reservationB),
      }),
    ]);
    assert.deepEqual([statusA, statusB].sort(), [0, 2]);
    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.policyCapacityUsed(), 60n);
    recovered.close();
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("two real processes racing to claim one effect yield one execution fence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-effect-race-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const clock = testClock();
  const journal = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
  try {
    const purchase = authorizedPurchase(journal, 52);
    const preparedBytes = Buffer.from("claim-race");
    const effect = journal.planEffect({
      purchaseId: purchase,
      kind: "claim-race",
      idempotencyKey: "claim:race:52",
      payloadDigest: evidenceDigest(preparedBytes),
      preparedBytes,
    });
    journal.close();
    const startAt = Date.now() + 300;
    const script = `
      const { PurchaseJournal } = await import(process.env.JOURNAL_MODULE);
      while (Date.now() < Number(process.env.START_AT)) {}
      const journal = new PurchaseJournal(process.env.DB, {
        now: () => Number(process.env.NOW),
        evidenceDirectory: process.env.EVIDENCE
      });
      try {
        const claim = journal.claimEffect(process.env.EFFECT_ID, process.env.HOLDER, 60000);
        process.exit(claim ? 0 : 2);
      } catch (error) {
        process.exit(2);
      }
    `;
    const common = {
      DB: filename,
      EVIDENCE: evidenceDirectory,
      NOW: String(clock.value),
      START_AT: String(startAt),
      EFFECT_ID: effect.id,
    };
    const [statusA, statusB] = await Promise.all([
      runChild(script, { ...common, HOLDER: "claim-worker-a" }),
      runChild(script, { ...common, HOLDER: "claim-worker-b" }),
    ]);
    assert.deepEqual([statusA, statusB].sort(), [0, 2]);
    const recovered = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
    assert.equal(recovered.requireEffect(effect.id).state, "executing");
    recovered.close();
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function withCrashJournal(
  run: (context: {
    filename: string;
    evidenceDirectory: string;
    journal: PurchaseJournal;
    clock: TestClock;
  }) => void
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-crash-test-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const clock = testClock();
  const journal = new PurchaseJournal(filename, { now: clock.now, evidenceDirectory });
  try {
    run({ filename, evidenceDirectory, journal, clock });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runKilled(script: string, environment: Record<string, string>) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...environment, JOURNAL_MODULE },
    encoding: "utf8",
  });
}

function runChild(script: string, environment: Record<string, string>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ...environment, JOURNAL_MODULE },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
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
    requestKey: assertPurchaseRequestKey(`crash:purchase:${seed}`),
    resourceUrl: resource.url,
    method: resource.method,
    resourceFingerprint: requestFingerprint(resource),
    expectedMerchantId: "merchant:test",
    expectedMerchantOrigin: "https://merchant.example",
  };
}

function createPurchase(journal: PurchaseJournal, seed: number) {
  return journal.createPurchase(purchaseInput(seed));
}

function authorizedPurchase(journal: PurchaseJournal, seed: number): PurchaseId {
  const purchase = createPurchase(journal, seed);
  const checkoutEvidence = verifiedFixtureEvidence(
    journal,
    purchase.id,
    `checkout-${seed}`,
    "checkout-terms",
    "merchant:test"
  );
  const requirementsEvidence = verifiedFixtureEvidence(
    journal,
    purchase.id,
    `requirements-${seed}`,
    "payment-requirements",
    "merchant:test"
  );
  const checkoutDigest = checkoutEvidence;
  const executionPlan = journal.storeExecutionPlanEvidence(purchase.id, {
    mechanism: "single-transaction",
    profile: "kaspa-exact-v2:standard-native",
    requirementsDigest: requirementsEvidence,
    maximumChargeAtomic: "60",
    settlementAssurance: "accepted",
  });
  journal.bindCheckoutTerms(purchase.id, {
    terms: {
      merchant: { id: "merchant:test", name: "Test Merchant", origin: "https://merchant.example" },
      resourceFingerprint: purchase.resourceFingerprint,
      amountAtomic: "60",
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: "kaspatest:merchant",
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest,
    },
    checkoutEvidenceDigest: checkoutEvidence,
    checkoutVerificationProfile: "test-v1",
    checkoutVerifierId: "test-verifier",
    paymentRequirementsDigest: requirementsEvidence,
    paymentRequirementsVerificationProfile: "test-v1",
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
  });
  const requestDigest = evidenceDigest(authorizationRequestArtifact);
  verifiedFixtureEvidence(journal, purchase.id, authorizationRequestArtifact, "authorization-request");
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
  const authorizationEvidence = verifiedFixtureEvidence(
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
    verificationProfile: "test-v1",
    verifierId: "test-verifier",
    requestDigest,
    nonceDigest,
    expiresAtMs,
  });
  return purchase.id;
}

function policyDefinition() {
  return {
    maxPerPaymentAtomic: "1000",
    maxPerHourAtomic: "10000",
    allowlist: ["kaspatest:merchant"],
  };
}

function reservationInput(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  policy: PolicySnapshotRecord,
  id: string,
  now: number,
  amountAtomic = "60"
): PolicyReservationInput {
  const authorization = journal.requireAuthorization(purchaseId);
  return {
    id,
    purchaseId,
    policyDigest: policy.digest,
    payee: "kaspatest:merchant",
    amountAtomic,
    additionalCostCeilingAtomic: "0",
    fundingSource: "vault-treasury",
    expiresAtMs: now + 60_000,
    approvalEvidenceDigest: authorization.evidenceDigest,
    approvalVerificationProfile: authorization.verificationProfile,
    approvalVerifierId: authorization.verifierId,
  };
}

function preparedSetup(journal: PurchaseJournal, seed: number, now: number) {
  const purchaseId = authorizedPurchase(journal, seed);
  const policy = journal.installPolicy(policyDefinition());
  const reservation = journal.reservePolicy({
    ...reservationInput(journal, purchaseId, policy, `reservation-${seed}`, now),
    additionalCostCeilingAtomic: "10",
    fundingSource: "vault-treasury",
  });
  journal.createPaymentAttempt({
    purchaseId,
    attempt: 1,
    identifier: createPaymentIdentifier(purchaseId, 1),
  });
  const preparedBytes = Buffer.from(`payload-${seed}`);
  const transactionId = seed.toString(16).padStart(2, "0").repeat(32);
  const preparation: PreparePaymentAttemptInput = {
    purchaseId,
    attempt: 1,
    reservationId: reservation.id,
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
  return { purchaseId, reservation, preparation };
}

function completePreparedFlow(journal: PurchaseJournal, seed: number, now: number) {
  const setup = preparedSetup(journal, seed, now);
  const preparation = journal.preparePaymentAttempt(setup.preparation);
  const effect = journal.planEffect({
    purchaseId: setup.purchaseId,
    attempt: 1,
    kind: "kaspa-exact-payment",
    idempotencyKey: `payment:${createPaymentIdentifier(setup.purchaseId, 1)}`,
    payloadDigest: preparation.payloadDigest,
    preparedBytes: setup.preparation.preparedBytes,
  });
  return {
    purchaseId: setup.purchaseId,
    reservationId: setup.reservation.id,
    transactionId: preparation.transactionId,
    effectId: effect.id,
  };
}

function verifiedEvidence(journal: PurchaseJournal, purchaseId: PurchaseId, value: string, attempt: number) {
  const artifact = journal.storeEvidence(purchaseId, {
    bytes: Buffer.from(value),
    mediaType: "application/octet-stream",
    profile: "test-v1",
    issuer: "test-issuer",
    kind: "kaspa-settlement",
    attempt,
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "test-verifier",
    profile: "test-v1",
    detailDigest: evidenceDigest(`verified:${value}`),
  });
  return artifact.digest;
}

function verifiedFixtureEvidence(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  value: string,
  kind: string,
  issuer = "test-issuer"
) {
  const artifact = journal.storeEvidence(purchaseId, {
    bytes: Buffer.from(value),
    mediaType: "application/octet-stream",
    profile: "test-v1",
    issuer,
    kind,
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "test-verifier",
    profile: "test-v1",
    detailDigest: evidenceDigest(`verified:${value}`),
  });
  return artifact.digest;
}
