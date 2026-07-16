import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  PurchaseCoordinator,
  certifyVerifiedCheckoutDiscovery,
  type AuthorityModule,
  type AuthorityResult,
  type CheckoutTermsModule,
  type CommerceAuthorizationModule,
  type FulfilmentModule,
  type KaspaPaymentModule,
  type PaymentRecoveryObservation,
  type PaymentSubmissionResult,
  type PreparedKaspaPayment,
  type PreparedTreasuryStaging,
  type SettlementResult,
  type TreasuryStagingRecoveryObservation,
  type TreasuryStagingSubmissionResult,
  type TreasuryStagingResult,
  type TreasuryStagingRecoveryModule,
  type PreparedStagingRecovery,
  type StagingRecoveryPreparationContext,
  type TreasuryModule,
  type VerifiedArtifact,
} from "./coordinator.js";
import {
  authorizationFacts,
  authorizationFactsDigest,
  checkoutTermsFactsDigest,
  type PurchaseAuthorizationRequest,
} from "./contracts.js";
import {
  AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
  AUTHORITY_MAC_KEY_BYTES,
  bindAuthorityApprovalResponse,
  createAuthorityNonce,
  createAuthorityRequestId,
  createAuthorityResponseId,
  parseAuthorityApprovalRequest,
  parseAuthorityApprovalResponse,
  sealAuthorityApprovalRequest,
  sealAuthorityApprovalResponse,
  verifyAuthorityDecisionEvidence,
  type AuthorityReplayAcquireInput,
  type AuthorityReplayAcquireResult,
  type AuthorityReplayCompleteInput,
  type AuthorityReplayCompletion,
  type AuthorityReplayLookupInput,
  type AuthorityReplayRenewInput,
  type AuthorityReplayStore,
} from "../authority/protocol.js";
import { EgressPolicy } from "./egress-policy.js";
import { evidenceDigest, assertPurchaseRequestKey } from "./identity.js";
import { PurchaseJournal, type JournalFaultPoint } from "./journal.js";
import type { CheckoutTerms, PurchaseId, PurchaseIntent, PurchaseModule } from "./types.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const TESTNET_PAYEE = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";

test("coordinator completes one exact Purchase and idempotently projects linked evidence", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    const completed = await coordinator.purchase(intent);
    assert.equal(completed.state, "receipted");
    assert.equal(completed.authorization.status, "approved");
    assert.equal(completed.treasury.status, "committed");
    assert.equal(completed.paymentAttempts.length, 1);
    assert.equal(completed.paymentAttempts[0].status, "observed");
    assert.equal(completed.fulfilmentBody, "deterministic resource body");
    assert.equal(completed.receiptEvidence.length, 2);
    assert.ok(completed.settlementEvidence);

    const replay = await coordinator.purchase(intent);
    assert.equal(replay.id, completed.id);
    assert.deepEqual(replay, completed);
    assert.deepEqual(dependencies.calls, {
      checkout: 1,
      authority: 1,
      commercePresent: 1,
      commerceObserve: 0,
      policy: 1,
      quote: 2,
      prepareStaging: 1,
      submitStaging: 1,
      observeStaging: 0,
      prepare: 1,
      submit: 1,
      observe: 0,
      fulfilment: 1,
    });
  });
});

test("coordinator completes one separately authorized batch Purchase without per-Purchase staging", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    dependencies.executionMechanism = "channel-voucher";

    const completed = await coordinator.purchase({
      ...intent,
      requestKey: assertPurchaseRequestKey("test:coordinator:batch-purchase"),
    });

    assert.equal(completed.state, "receipted");
    assert.equal(completed.authorization.status, "approved");
    assert.equal(completed.treasury.status, "committed");
    assert.equal(completed.paymentAttempts.length, 1);
    assert.equal(completed.paymentAttempts[0]?.status, "observed");
    assert.equal(dependencies.calls.prepareStaging, 0);
    assert.equal(dependencies.calls.submitStaging, 0);
    assert.equal(dependencies.calls.observeStaging, 0);
    const settlement = journal.findSettlementForPurchase(completed.id);
    assert.equal(settlement?.mechanism, "channel-voucher");
    assert.equal(settlement?.actualAmountAtomic, "40");
    assert.equal(settlement?.actualAdditionalCostAtomic, "0");
    assert.equal(journal.findReservationForPurchase(completed.id)?.amountAtomic, "60");

    const replay = await coordinator.purchase({
      ...intent,
      requestKey: assertPurchaseRequestKey("test:coordinator:batch-purchase"),
    });
    assert.deepEqual(replay, completed);
    assert.equal(dependencies.calls.authority, 1);
    assert.equal(dependencies.calls.prepare, 1);
    assert.equal(dependencies.calls.submit, 1);
  });
});

test("a paid retry response is persisted as Fulfilment without a second Merchant request", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    dependencies.paidResponseAvailable = true;
    const completed = await coordinator.purchase(intent);
    assert.equal(completed.state, "receipted");
    assert.equal(completed.fulfilmentBody, "deterministic resource body");
    assert.equal(dependencies.calls.submit, 1);
    assert.equal(dependencies.calls.fulfilment, 0);
  });
});

test("authority pending and denial stop before treasury or payment execution", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    dependencies.authorityMode = "pending";
    const pending = await coordinator.purchase(intent);
    assert.equal(pending.state, "awaiting_authority");
    assert.equal(pending.authorization.status, "pending");
    assert.equal(dependencies.calls.prepare, 0);

    dependencies.authorityMode = "denied";
    const denied = await coordinator.purchase(intent);
    assert.equal(denied.state, "denied");
    assert.equal(denied.authorization.status, "denied");
    assert.equal(dependencies.calls.policy, 0);
    assert.equal(dependencies.calls.submit, 0);
  });
});

test("caller cancellation before an external Treasury effect atomically releases capacity", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    const cancellation = new AbortController();
    dependencies.onStagingPrepared = () => cancellation.abort();

    await assert.rejects(
      coordinator.purchase(intent, cancellation.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );

    const purchase = journal.findPurchaseByRequestKey(intent.requestKey);
    assert.ok(purchase);
    assert.equal(purchase.state, "cancelled");
    assert.equal(journal.findReservationForPurchase(purchase.id)?.state, "released");
    assert.equal(journal.paymentAttempts(purchase.id)[0]?.state, "failed");
    assert.equal(dependencies.calls.submitStaging, 0);
    assert.equal(
      journal.effectsForPurchase(purchase.id).find((effect) => effect.kind === "treasury-staging")?.state,
      "abandoned"
    );
  });
});

test("caller cancellation after a possible Treasury effect preserves reconciliation state", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    const cancellation = new AbortController();
    dependencies.stagingSubmitMode = "submitted";
    dependencies.onStagingSubmit = () => cancellation.abort();

    const view = await coordinator.purchase(intent, cancellation.signal);
    assert.equal(view.state, "failed_recoverable");
    assert.match(view.summary, /needs recovery/i);
    assert.match(view.userAction ?? "", /recover/i);
    const reservation = journal.findReservationForPurchase(view.id);
    assert.equal(reservation?.state, "in_flight");
    assert.equal(
      journal.effectsForPurchase(view.id).find((effect) => effect.kind === "treasury-staging")?.state,
      "submitted"
    );
  });
});

test("exact Checkout, authority, preparation, and Settlement substitutions fail closed", async () => {
  const mutations: Array<(dependencies: FakeDependencies) => void> = [
    (deps) => { deps.termsMutation = (terms) => ({ ...terms, resourceFingerprint: evidenceDigest("substituted-resource") }); },
    (deps) => { deps.authorityFactsMutation = (facts) => ({ ...facts, payTo: "kaspatest:attacker" }); },
    (deps) => { deps.preparedMutation = (prepared) => ({ ...prepared, network: "kaspa:testnet-11" }); },
    (deps) => { deps.settlementMutation = (settlement) => ({ ...settlement, amountAtomic: "1" }); },
  ];
  for (const mutate of mutations) {
    await withFixture(async ({ coordinator, dependencies, intent }) => {
      mutate(dependencies);
      try {
        const result = await coordinator.purchase(intent);
        assert.notEqual(result.state, "receipted");
      } catch {
        // A malformed dependency result may fail synchronously before a safe state is projected.
      }
      assert.notEqual((await safeStatus(coordinator, dependencies.lastPurchaseId)).state, "receipted");
    });
  }
});

test("ambiguous submission is observed by recover without resubmission, then fulfilment resumes", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    dependencies.submitMode = "throw";
    const ambiguous = await coordinator.purchase(intent);
    assert.equal(ambiguous.state, "failed_recoverable");
    assert.equal(dependencies.calls.submit, 1);
    assert.equal(dependencies.calls.fulfilment, 0);

    dependencies.observeMode = "settled";
    const recovered = await coordinator.recover(ambiguous.id);
    assert.equal(recovered.state, "receipted");
    assert.equal(dependencies.calls.submit, 1);
    assert.equal(dependencies.calls.observe, 1);
    assert.equal(dependencies.calls.fulfilment, 1);

    const completed = await coordinator.recover(ambiguous.id);
    assert.equal(completed.state, "receipted");
    assert.equal(dependencies.calls.submit, 1);
    assert.equal(dependencies.calls.fulfilment, 1);
  });
});

test("ambiguous Treasury staging is observed before exact preparation and is never blindly resubmitted", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    dependencies.stagingSubmitMode = "throw";
    const ambiguous = await coordinator.purchase(intent);
    assert.equal(ambiguous.state, "failed_recoverable");
    assert.equal(dependencies.calls.prepareStaging, 1);
    assert.equal(dependencies.calls.submitStaging, 1);
    assert.equal(dependencies.calls.prepare, 0);
    assert.equal(dependencies.calls.submit, 0);

    dependencies.stagingObserveMode = "pending";
    assert.equal((await coordinator.recover(ambiguous.id)).state, "failed_recoverable");
    assert.equal(dependencies.calls.submitStaging, 1);
    assert.equal(dependencies.calls.prepare, 0);

    dependencies.stagingObserveMode = "staged";
    const completed = await coordinator.recover(ambiguous.id);
    assert.equal(completed.state, "receipted");
    assert.equal(dependencies.calls.submitStaging, 1);
    assert.equal(dependencies.calls.prepare, 1);
    assert.equal(dependencies.calls.submit, 1);
    assert.deepEqual(
      journal.effectsForPurchase(ambiguous.id)
        .map(({ kind, state }) => ({ kind, state }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
      [
        { kind: "kaspa-x402-payment", state: "observed" },
        { kind: "merchant-authorization", state: "observed" },
        { kind: "treasury-staging", state: "observed" },
      ]
    );
  });
});

test("proof-backed Treasury staging retry reuses one plan and the same prepared bytes", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    dependencies.stagingSubmitMode = "throw";
    const ambiguous = await coordinator.purchase(intent);
    const plan = journal.requireTreasuryStagingPlan(ambiguous.id, 1);
    const prepared = journal.readPreparedTreasuryStaging(ambiguous.id, 1);

    dependencies.stagingObserveMode = "not_found_retryable";
    dependencies.stagingSubmitMode = "staged";
    const completed = await coordinator.recover(ambiguous.id);

    assert.equal(completed.state, "receipted");
    assert.equal(dependencies.calls.prepareStaging, 1);
    assert.equal(dependencies.calls.submitStaging, 2);
    assert.deepEqual(journal.requireTreasuryStagingPlan(ambiguous.id, 1), plan);
    assert.deepEqual(journal.readPreparedTreasuryStaging(ambiguous.id, 1), prepared);
  });
});

test("a conflicting observation stays recoverable and can later settle", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    dependencies.submitMode = "throw";
    const ambiguous = await coordinator.purchase(intent);
    assert.equal(ambiguous.state, "failed_recoverable");

    dependencies.observeMode = "conflict";
    const conflicted = await coordinator.recover(ambiguous.id);
    assert.equal(conflicted.state, "failed_recoverable");
    assert.equal(dependencies.calls.submit, 1);

    dependencies.observeMode = "settled";
    const completed = await coordinator.recover(ambiguous.id);
    assert.equal(completed.state, "receipted");
    assert.equal(dependencies.calls.submit, 1);
  });
});

test("proof-backed retry resubmits the same immutable payment exactly once", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    dependencies.submitMode = "throw";
    const ambiguous = await coordinator.purchase(intent);
    const before = journal.requirePaymentPreparation(ambiguous.id, 1);
    const reservation = journal.findReservationForPurchase(ambiguous.id)!;

    dependencies.observeMode = "not_found_retryable";
    dependencies.submitMode = "settled";
    const completed = await coordinator.recover(ambiguous.id);

    assert.equal(completed.state, "receipted");
    assert.equal(dependencies.calls.prepare, 1);
    assert.equal(dependencies.calls.submit, 2);
    assert.equal(journal.paymentAttempts(ambiguous.id).length, 1);
    assert.equal(journal.findReservationForPurchase(ambiguous.id)?.id, reservation.id);
    assert.deepEqual(journal.requirePaymentPreparation(ambiguous.id, 1), before);
  });
});

test("terminal application failure remains recoverable until non-execution or settlement is proven", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    dependencies.submitMode = "throw";
    const ambiguous = await coordinator.purchase(intent);
    dependencies.observeMode = "application_failure";

    const terminal = await coordinator.recover(ambiguous.id);
    assert.equal(terminal.state, "failed_recoverable");
    assert.equal(journal.findReservationForPurchase(ambiguous.id)?.state, "in_flight");
    assert.equal(journal.requirePaymentAttempt(ambiguous.id, 1).state, "submitted");
    assert.equal(
      journal.effectsForPurchase(ambiguous.id).find((effect) => effect.kind === "kaspa-x402-payment")?.state,
      "ambiguous"
    );

    assert.equal((await coordinator.recover(ambiguous.id)).state, "failed_recoverable");
    assert.equal(dependencies.calls.submit, 1);
    dependencies.observeMode = "settled";
    assert.equal((await coordinator.recover(ambiguous.id)).state, "receipted");
  });
});

test("status is strictly read-only and calls no protocol or treasury dependency", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    dependencies.authorityMode = "pending";
    const waiting = await coordinator.purchase(intent);
    const before = { ...dependencies.calls };
    const status = await coordinator.status(waiting.id);
    assert.equal(status.state, "awaiting_authority");
    assert.deepEqual(dependencies.calls, before);
  });
});

test("known-denied egress is rejected before durable Purchase or evidence admission", async () => {
  await withFixture(async ({ coordinator, journal, intent }) => {
    const denied = {
      ...intent,
      requestKey: assertPurchaseRequestKey("test:coordinator:denied-egress"),
      resource: {
        ...intent.resource,
        url: "https://blocked.invalid/resource",
        body: Buffer.alloc(1024, 0xa5),
      },
    };
    await assert.rejects(
      coordinator.purchase(denied),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "host_denied",
    );
    assert.equal(journal.findPurchaseByRequestKey(denied.requestKey), undefined);
    const evidenceDirectory = `${journal.filename}.evidence`;
    assert.deepEqual(fs.readdirSync(evidenceDirectory), []);
    const status = journal.admissionStatus();
    assert.equal(status?.prevalidationPurchases.used, 0);
    assert.equal(status?.evidenceBytes.used, 0);
  });
});

test("restart after durable preparation reuses exact bytes instead of preparing or signing again", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-coordinator-prepared-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const dependencies = new FakeDependencies();
  let effectInsertions = 0;
  let journal = new PurchaseJournal(filename, {
    now: () => NOW,
    faultInjector(point: JournalFaultPoint) {
      // Merchant authorization and Treasury staging are the first two Effects;
      // crash on the exact payment Effect created after durable preparation.
      if (point === "effect.after_insert" && ++effectInsertions === 3) {
        throw new Error("crash-after-preparation");
      }
    },
  });
  const intent = makeIntent();
  try {
    let coordinator = makeCoordinator(journal, dependencies);
    await assert.rejects(() => coordinator.purchase(intent), /crash-after-preparation/);
    assert.equal(dependencies.calls.prepare, 1);
    const id = dependencies.lastPurchaseId;
    assert.equal(journal.requirePaymentAttempt(id, 1).state, "prepared");
    assert.equal(journal.requirePurchase(id).state, "execution_prepared");
    journal.close();

    dependencies.quoteAdditionalCost = "999";
    dependencies.policyPerPayment = "9999";
    const dynamicCallsBeforeRestart = {
      quote: dependencies.calls.quote,
      policy: dependencies.calls.policy,
    };
    journal = new PurchaseJournal(filename, { now: () => NOW + 1_000 });
    coordinator = makeCoordinator(journal, dependencies, NOW + 1_000);
    const completed = await coordinator.purchase(intent);
    assert.equal(completed.state, "receipted");
    assert.equal(dependencies.calls.prepare, 1);
    assert.equal(dependencies.calls.submit, 1);
    assert.equal(dependencies.calls.quote, dynamicCallsBeforeRestart.quote);
    assert.equal(dependencies.calls.policy, dynamicCallsBeforeRestart.policy);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Fulfilment and all required Receipts commit atomically across a crash", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-coordinator-receipt-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const dependencies = new FakeDependencies();
  let journal = new PurchaseJournal(filename, {
    now: () => NOW,
    faultInjector(point: JournalFaultPoint) {
      if (point === "receipt.after_insert") throw new Error("crash-during-receipt");
    },
  });
  const intent = makeIntent();
  try {
    let coordinator = makeCoordinator(journal, dependencies);
    await assert.rejects(() => coordinator.purchase(intent), /crash-during-receipt/);
    const id = dependencies.lastPurchaseId;
    assert.equal(journal.requirePurchase(id).state, "settled");
    assert.throws(() => journal.requireFulfilment(id));
    assert.equal(journal.receipts(id).length, 0);
    journal.close();

    journal = new PurchaseJournal(filename, { now: () => NOW });
    coordinator = makeCoordinator(journal, dependencies);
    const complete = await coordinator.purchase(intent);
    assert.equal(complete.state, "receipted");
    assert.equal(dependencies.calls.fulfilment, 2);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verified Fulfilment persists while missing Receipts resume without another payment", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    dependencies.receiptsAvailable = false;
    const fulfilled = await coordinator.purchase(intent);
    assert.equal(fulfilled.state, "fulfilled");
    assert.equal(fulfilled.fulfilmentBody, "deterministic resource body");
    assert.equal(dependencies.calls.submit, 1);

    dependencies.receiptsAvailable = true;
    const complete = await coordinator.purchase(intent);
    assert.equal(complete.state, "receipted");
    assert.equal(dependencies.calls.submit, 1);
    assert.equal(dependencies.calls.fulfilment, 2);
  });
});

test("same request key with changed intent conflicts and concurrent callers share one Purchase", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    dependencies.checkoutDelayMs = 20;
    const [first, second] = await Promise.all([coordinator.purchase(intent), coordinator.purchase(intent)]);
    assert.equal(first.id, second.id);
    const final = await coordinator.status(first.id);
    assert.ok(["created", "receipted"].includes(second.state));
    assert.equal(final.state, "receipted");
    await assert.rejects(() => coordinator.purchase({
      ...intent,
      resource: { ...intent.resource, url: "https://merchant.example/other" },
    }));
    await assert.rejects(() => coordinator.purchase({
      ...intent,
      resource: { ...intent.resource, mediaType: "application/json" },
    }));
  });
});

test("terms waiting on a Treasury quote expire before another dynamic quote", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-coordinator-expiry-"));
  fs.chmodSync(directory, 0o700);
  let now = NOW;
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => now });
  const dependencies = new FakeDependencies();
  dependencies.termsExpiresAt = new Date(NOW + 1_000).toISOString();
  dependencies.quoteReady = false;
  const coordinator = makeCoordinator(journal, dependencies, () => now);
  try {
    const waiting = await coordinator.purchase(makeIntent());
    assert.equal(waiting.state, "terms_bound");
    assert.equal(dependencies.calls.quote, 1);

    now = NOW + 1_001;
    const expired = await coordinator.purchase(makeIntent());
    assert.equal(expired.state, "expired");
    assert.equal(dependencies.calls.quote, 1);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("expiry after staging recovers to the Sompi wallet without preparing an exact payment", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-staging-recovery-no-exact-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  let nowMs = NOW;
  let journal = new PurchaseJournal(filename, { now: () => nowMs });
  const dependencies = new FakeDependencies();
  dependencies.termsExpiresAt = new Date(NOW + 1_000).toISOString();
  dependencies.onStagingObserved = () => { nowMs = NOW + 2_000; };
  dependencies.stagingRecoveryObserveMode = "safe_to_submit";
  let coordinator = makeCoordinator(journal, dependencies, () => nowMs);
  try {
    const staged = await coordinator.purchase(makeIntent());
    assert.equal(staged.state, "failed_recoverable");
    assert.equal(dependencies.calls.prepare, 0);

    const submitted = await coordinator.recover(staged.id);
    assert.equal(submitted.state, "failed_recoverable");
    assert.equal(dependencies.recoveryCalls.prepare, 1);
    assert.equal(dependencies.recoveryCalls.submit, 1);
    assert.equal(
      dependencies.recoveryPreparedInputs[0].exactPayment,
      undefined
    );

    journal.close();
    journal = new PurchaseJournal(filename, { now: () => nowMs });
    coordinator = makeCoordinator(journal, dependencies, () => nowMs);
    dependencies.stagingRecoveryObserveMode = "recovery_won";
    const recovered = await coordinator.recover(staged.id);
    assert.equal(recovered.state, "failed_terminal");
    assert.equal(recovered.treasury.status, "released");
    assert.equal(dependencies.recoveryCalls.prepare, 1);
    assert.equal(dependencies.recoveryCalls.submit, 1);
    assert.equal(new Set(dependencies.recoveryObservedBytes).size, 1);
    const context = journal.treasuryStagingRecoveryJournalContext(staged.id, 1)!;
    assert.equal(context.accounting?.returnedAmountAtomic, "69");
    assert.equal(context.accounting?.actualAdditionalCostAtomic, "2");
    assert.equal(context.accounting?.finality, "accepted");
    assert.equal(context.reservation.state, "released");
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("expiry after exact preparation preserves the immutable exact candidate but never submits it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-staging-recovery-prepared-exact-"));
  fs.chmodSync(directory, 0o700);
  let nowMs = NOW;
  let exactPrepared = false;
  let postPreparationClockReads = 0;
  const clock = () => {
    if (exactPrepared && ++postPreparationClockReads >= 2) nowMs = NOW + 2_000;
    return nowMs;
  };
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: clock,
  });
  const dependencies = new FakeDependencies();
  dependencies.termsExpiresAt = new Date(NOW + 1_000).toISOString();
  dependencies.onExactPrepared = () => { exactPrepared = true; };
  dependencies.stagingRecoveryObserveMode = "safe_to_submit";
  const coordinator = makeCoordinator(journal, dependencies, clock);
  try {
    const purchase = await coordinator.purchase(makeIntent());
    assert.equal(
      purchase.state,
      "failed_recoverable",
      `post-preparation clock reads: ${postPreparationClockReads}, now: ${nowMs}`
    );
    assert.equal(dependencies.calls.prepare, 1);
    assert.equal(dependencies.calls.submit, 0);

    await coordinator.recover(purchase.id);
    assert.equal(dependencies.recoveryCalls.prepare, 1);
    assert.equal(
      dependencies.recoveryPreparedInputs[0].exactPayment?.transactionId,
      "ab".repeat(32)
    );
    assert.equal(dependencies.calls.submit, 0);
    assert.equal(
      journal.requireTreasuryStagingRecoveryPlan(purchase.id, 1).exactTransactionId,
      "ab".repeat(32)
    );
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous paid request and recovery sweep reconcile the exact winner without double submit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-staging-recovery-race-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  let nowMs = NOW;
  let journal = new PurchaseJournal(filename, { now: () => nowMs });
  const dependencies = new FakeDependencies();
  dependencies.termsExpiresAt = new Date(NOW + 5_000).toISOString();
  dependencies.submitMode = "throw";
  dependencies.observeMode = "pending";
  const coordinator = makeCoordinator(journal, dependencies, () => nowMs);
  try {
    const purchase = await coordinator.purchase(makeIntent());
    assert.equal(purchase.state, "failed_recoverable");
    nowMs = NOW + 6_000;
    dependencies.stagingRecoveryObserveMode = "safe_to_submit";
    dependencies.stagingRecoverySubmitMode = "ambiguous";
    await coordinator.recover(purchase.id);
    assert.equal(dependencies.recoveryCalls.submit, 1);

    journal.close();
    journal = new PurchaseJournal(filename, { now: () => nowMs });
    const restarted = makeCoordinator(journal, dependencies, () => nowMs);
    dependencies.stagingRecoveryObserveMode = "exact_payment_won";
    dependencies.settleAfterExactRecoveryWinner = true;
    const settled = await restarted.recover(purchase.id);
    assert.equal(settled.state, "settled");
    assert.equal(dependencies.recoveryCalls.submit, 1);
    assert.equal(journal.findSettlementForPurchase(purchase.id)?.transactionId, "ab".repeat(32));
    assert.equal(
      journal.treasuryStagingRecoveryJournalContext(purchase.id, 1)?.accounting,
      undefined
    );
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown staging spender fails closed and over-ceiling recovery remains persisted for manual authority", async () => {
  await withFixture(async ({ coordinator, dependencies, intent, journal }) => {
    dependencies.submitMode = "throw";
    const purchase = await coordinator.purchase(intent);
    dependencies.termsExpiresAt = new Date(NOW - 1).toISOString();
    // The already-authorized journal expiry, not this mutable fixture field,
    // controls qualification. A terminal exact observation also permits only
    // staged-fund resolution.
    dependencies.observeMode = "application_failure";
    await coordinator.recover(purchase.id);
    dependencies.stagingRecoveryObserveMode = "conflict";
    await coordinator.recover(purchase.id);
    const context = journal.treasuryStagingRecoveryJournalContext(purchase.id, 1);
    if (context) {
      assert.equal(context.effect.state, "failed_terminal");
      assert.equal(context.reservation.state, "in_flight");
      assert.equal(dependencies.recoveryCalls.submit, 0);
    }
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-staging-recovery-ceiling-"));
  fs.chmodSync(directory, 0o700);
  let nowMs = NOW;
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: () => nowMs,
  });
  const dependencies = new FakeDependencies();
  dependencies.termsExpiresAt = new Date(NOW + 1_000).toISOString();
  dependencies.onStagingObserved = () => { nowMs = NOW + 2_000; };
  dependencies.stagingRecoveryFeeAtomic = "10";
  dependencies.stagingRecoveryObserveMode = "safe_to_submit";
  const coordinator = makeCoordinator(journal, dependencies, () => nowMs);
  try {
    const purchase = await coordinator.purchase(makeIntent());
    await assert.rejects(
      coordinator.recover(purchase.id),
      /explicit operator authority is required/
    );
    assert.ok(journal.requireTreasuryStagingRecoveryPlan(purchase.id, 1));
    assert.equal(dependencies.recoveryCalls.prepare, 1);
    await assert.rejects(
      coordinator.recover(purchase.id),
      /explicit operator authority is required/
    );
    assert.equal(dependencies.recoveryCalls.prepare, 1);
    assert.equal(dependencies.recoveryCalls.submit, 0);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator requires an address-pinned egress session for direct and redirected commerce", async () => {
  await withFixture(async ({ coordinator, dependencies, intent }) => {
    const unsafe = {
      ...intent,
      requestKey: assertPurchaseRequestKey("test:coordinator:unsafe-direct"),
      resource: { ...intent.resource, url: "https://127.0.0.1/metadata" },
      expectedMerchant: undefined,
    };
    await assert.rejects(() => coordinator.purchase(unsafe));
    assert.equal(dependencies.calls.checkout, 0);

    dependencies.redirectLocation = "http://169.254.169.254/latest/meta-data";
    await assert.rejects(() => coordinator.purchase({
      ...intent,
      requestKey: assertPurchaseRequestKey("test:coordinator:unsafe-redirect"),
    }));
    assert.equal(dependencies.calls.checkout, 1);

    dependencies.redirectLocation = "https://merchant.example/other-resource";
    await assert.rejects(() => coordinator.purchase({
      ...intent,
      requestKey: assertPurchaseRequestKey("test:coordinator:identity-redirect"),
    }));
    assert.equal(dependencies.calls.checkout, 2);
  });
});

async function withFixture(
  run: (fixture: {
    coordinator: PurchaseCoordinator;
    dependencies: FakeDependencies;
    intent: PurchaseIntent;
    journal: PurchaseJournal;
  }) => Promise<void>
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-coordinator-"));
  fs.chmodSync(directory, 0o700);
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: () => NOW,
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
  });
  const dependencies = new FakeDependencies();
  const coordinator = makeCoordinator(journal, dependencies);
  try {
    await run({ coordinator, dependencies, intent: makeIntent(), journal });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function makeCoordinator(
  journal: PurchaseJournal,
  dependencies: FakeDependencies,
  currentTime: number | (() => number) = NOW
): PurchaseCoordinator {
  const now = typeof currentTime === "function" ? currentTime : () => currentTime;
  let entropyCounter = 1;
  const coordinator = new PurchaseCoordinator(
    journal,
    new EgressPolicy({
      allowRules: [{ hostname: "merchant.example", ports: [443] }],
      resolver: async (hostname) => {
        if (hostname !== "merchant.example") throw new Error("unexpected test hostname");
        return [{ address: "93.184.216.34", family: 4 }];
      },
      now,
    }),
    dependencies.checkout,
    dependencies.authority,
    dependencies.commerceAuthorization,
    dependencies.treasury,
    dependencies.payment,
    dependencies.fulfilment,
    {
      now,
      workerId: `test-worker-${dependencies.instance}`,
      entropy(bytes) {
        return new Uint8Array(bytes).fill(entropyCounter++);
      },
    }
  );
  dependencies.module = coordinator;
  return coordinator;
}

let instanceCounter = 0;

class FakeDependencies {
  readonly instance = ++instanceCounter;
  module?: PurchaseModule;
  lastPurchaseId = "" as PurchaseId;
  authorityMode: "approved" | "pending" | "denied" = "approved";
  submitMode: "settled" | "submitted" | "throw" = "settled";
  observeMode: "pending" | "settled" | "conflict" | "application_failure" | "not_found_retryable" = "pending";
  checkoutDelayMs = 0;
  redirectLocation?: string;
  quoteAdditionalCost = "10";
  quoteReady = true;
  executionMechanism: "single-transaction" | "channel-voucher" = "single-transaction";
  policyPerPayment = "1000";
  termsExpiresAt = "2031-01-01T00:00:00.000Z";
  receiptsAvailable = true;
  paidResponseAvailable = false;
  termsMutation?: (terms: CheckoutTerms) => CheckoutTerms;
  authorityFactsMutation?: (facts: ReturnType<typeof authorizationFacts>) => ReturnType<typeof authorizationFacts>;
  preparedMutation?: (prepared: PreparedKaspaPayment) => PreparedKaspaPayment;
  settlementMutation?: (settlement: SettlementResult) => SettlementResult;
  stagingSubmitMode: "staged" | "submitted" | "throw" = "staged";
  stagingObserveMode: "pending" | "staged" | "conflict" | "not_found_retryable" = "pending";
  stagingRecoveryObserveMode:
    | "safe_to_submit"
    | "pending"
    | "exact_payment_won"
    | "recovery_won"
    | "conflict" = "pending";
  stagingRecoverySubmitMode: "accepted" | "ambiguous" | "conflict" = "accepted";
  stagingRecoveryFeeAtomic = "1";
  stagingFeeAtomic = "1";
  onStagingObserved?: () => void;
  onStagingPrepared?: () => void;
  onStagingSubmit?: () => void;
  onExactPrepared?: () => void;
  settleAfterExactRecoveryWinner = false;
  recoveryCalls = { prepare: 0, observe: 0, submit: 0 };
  recoveryPreparedInputs: StagingRecoveryPreparationContext[] = [];
  recoveryObservedBytes: string[] = [];
  calls = {
    checkout: 0,
    authority: 0,
    commercePresent: 0,
    commerceObserve: 0,
    policy: 0,
    quote: 0,
    prepareStaging: 0,
    submitStaging: 0,
    observeStaging: 0,
    prepare: 0,
    submit: 0,
    observe: 0,
    fulfilment: 0,
  };
  private prepared = new Map<string, PreparedKaspaPayment>();
  private staged = new Map<string, PreparedTreasuryStaging>();

  readonly checkout: CheckoutTermsModule = {
    discover: async ({ purchaseId, resourceFingerprint, egress }) => {
      this.calls.checkout++;
      this.lastPurchaseId = purchaseId;
      assert.deepEqual(egress.request.connection.addresses, [{ address: "93.184.216.34", family: 4 }]);
      if (this.redirectLocation) await egress.redirect(egress.request, this.redirectLocation);
      if (this.checkoutDelayMs) await new Promise((resolve) => setTimeout(resolve, this.checkoutDelayMs));
      const terms: CheckoutTerms = {
        merchant: { id: "merchant:test", name: "Test Merchant", origin: "https://merchant.example" },
        resourceFingerprint,
        amountAtomic: "60",
        asset: "KAS",
        network: "kaspa:testnet-10",
        payTo: TESTNET_PAYEE,
        expiresAt: this.termsExpiresAt,
        checkoutDigest: evidenceDigest(`checkout:${purchaseId}`),
      };
      const checkoutEvidence = artifact(
        `checkout:${purchaseId}`,
        "test-checkout",
        "merchant:test",
        checkoutTermsFactsDigest(terms)
      );
      const paymentRequirements = artifact(
        `requirements:${purchaseId}`,
        "test-requirements",
        "merchant:test"
      );
      return certifyVerifiedCheckoutDiscovery({
        terms: this.termsMutation?.(terms) ?? terms,
        checkoutEvidence,
        paymentRequirements,
        executionPlan: {
          mechanism: this.executionMechanism,
          profile: this.executionMechanism === "single-transaction"
            ? "kaspa-exact-v2:standard-native"
            : "kaspa-escrow-v1:batch-settlement",
          requirementsDigest: paymentRequirements.declaredDigest!,
          maximumChargeAtomic: terms.amountAtomic,
          settlementAssurance: this.executionMechanism === "single-transaction"
            ? "accepted"
            : "channel-commitment",
          ...(this.executionMechanism === "channel-voucher"
            ? {
                channelEpoch: {
                  channelId: "11".repeat(32),
                  activeOutpoint: { txid: "22".repeat(32), index: 0 },
                  activeScriptPublicKey: `000020${"33".repeat(32)}`,
                  fundingAmountAtomic: "1000",
                  refundTimeoutDaa: "500000000",
                },
                claimFeeReserveAtomic: "10",
              }
            : {}),
        },
      });
    },
  };

  readonly authority: AuthorityModule = {
    request: async ({ request, checkoutEvidence }): Promise<AuthorityResult> => {
      this.calls.authority++;
      assert.equal(checkoutEvidence.digest, evidenceDigest(checkoutEvidence.bytes));
      if (this.authorityMode === "pending") return { status: "pending" };
      return verifiedAuthorityResult(request, this.authorityMode, this.authorityFactsMutation);
    },
  };

  readonly treasury: TreasuryModule = {
    currentPolicy: async () => {
      this.calls.policy++;
      return {
        maxPerPaymentAtomic: this.policyPerPayment,
        maxPerHourAtomic: "10000",
        approvalAboveAtomic: "1",
        allowlist: [TESTNET_PAYEE],
      };
    },
    quote: async () => {
      this.calls.quote++;
      return {
        ready: this.quoteReady,
        additionalCostCeilingAtomic: this.quoteAdditionalCost,
        reservationTtlMs: 60_000,
      };
    },
    prepareStaging: async (input) => this.payment.prepareStaging(input),
    submitStaging: async (input) => this.payment.submitStaging(input),
    observeStaging: async (input) => this.payment.observeStaging(input),
    prepareStagingRecovery: async (input) => this.stagingRecovery.prepare(input),
    observeStagingRecovery: async (input) => this.stagingRecovery.observe(input),
    submitStagingRecovery: async (input) => this.stagingRecovery.submit(input),
  };

  readonly commerceAuthorization: CommerceAuthorizationModule = {
    present: async ({ context }) => {
      this.calls.commercePresent++;
      const acceptance = artifact(
        `merchant-authorization:${context.purchaseId}:${context.paymentIdentifier}`,
        "test-merchant-authorization",
        "merchant:test"
      );
      return {
        status: "accepted",
        submissionDigest: acceptance.declaredDigest!,
        acceptance,
      };
    },
    observe: async ({ context }) => {
      this.calls.commerceObserve++;
      return {
        status: "accepted",
        acceptance: artifact(
          `merchant-authorization:${context.purchaseId}:${context.paymentIdentifier}`,
          "test-merchant-authorization",
          "merchant:test"
        ),
      };
    },
  };

  readonly payment: KaspaPaymentModule & Pick<
    TreasuryModule,
    "prepareStaging" | "submitStaging" | "observeStaging"
  > = {
    prepareStaging: async ({ execution, paymentRequirements }): Promise<PreparedTreasuryStaging> => {
      this.calls.prepareStaging++;
      assert.equal(evidenceDigest(paymentRequirements), evidenceDigest(`requirements:${execution.purchaseId}`));
      const preparedBytes = Buffer.from(`treasury-staging:${execution.purchaseId}`);
      const transactionId = "cd".repeat(32);
      const prepared: PreparedTreasuryStaging = {
        preparedBytes,
        preparedDigest: evidenceDigest(preparedBytes),
        transactionId,
        expectedOutpoint: `${transactionId}:0`,
        stagingAmountAtomic: "70",
        fundingSource: "vault-treasury",
      };
      this.staged.set(execution.purchaseId, prepared);
      this.onStagingPrepared?.();
      return prepared;
    },
    submitStaging: async ({ context }): Promise<TreasuryStagingSubmissionResult> => {
      this.calls.submitStaging++;
      this.onStagingSubmit?.();
      const purchaseId = context.execution.purchaseId;
      assert.equal(
        evidenceDigest(context.staging.preparedBytes),
        this.staged.get(purchaseId)?.preparedDigest
      );
      if (this.stagingSubmitMode === "throw") {
        throw new Error("simulated Treasury staging transport loss");
      }
      const submissionDigest = evidenceDigest(`treasury-staging-submission:${purchaseId}`);
      if (this.stagingSubmitMode === "submitted") {
        return { status: "submitted", submissionDigest };
      }
      this.onStagingObserved?.();
      return {
        status: "staged",
        submissionDigest,
        staging: this.stagingResult(purchaseId),
      };
    },
    observeStaging: async ({ effect }): Promise<TreasuryStagingRecoveryObservation> => {
      this.calls.observeStaging++;
      if (this.stagingObserveMode === "pending") {
        return { status: "pending", detailDigest: evidenceDigest("treasury-staging-pending") };
      }
      if (this.stagingObserveMode === "conflict") {
        return { status: "conflict", detailDigest: evidenceDigest("treasury-staging-conflict") };
      }
      if (this.stagingObserveMode === "not_found_retryable") {
        return {
          status: "not_found",
          safeToRetry: true,
          detailDigest: evidenceDigest("treasury-staging-not-found"),
        };
      }
      return { status: "staged", staging: this.stagingResult(effect.purchaseId) };
    },
    prepare: async ({ execution, paymentRequirements, staging }): Promise<PreparedKaspaPayment> => {
      this.calls.prepare++;
      assert.equal(evidenceDigest(paymentRequirements), evidenceDigest(`requirements:${execution.purchaseId}`));
      if (this.executionMechanism === "single-transaction") {
        assert.ok(staging);
        assert.equal(staging.outpoint, this.staged.get(execution.purchaseId)?.expectedOutpoint);
        assert.equal(staging.amountAtomic, this.staged.get(execution.purchaseId)?.stagingAmountAtomic);
      } else {
        assert.equal(staging, undefined);
      }
      const preparedBytes = Buffer.from(`prepared:${execution.purchaseId}`);
      const transactionId = "ab".repeat(32);
      const prepared: PreparedKaspaPayment = {
        purchaseId: execution.purchaseId,
        checkoutDigest: execution.terms.checkoutDigest,
        resourceFingerprint: execution.terms.resourceFingerprint,
        amountAtomic: execution.terms.amountAtomic,
        asset: execution.terms.asset,
        network: execution.terms.network,
        payTo: execution.terms.payTo,
        paymentIdentifier: execution.paymentIdentifier,
        executionId: transactionId,
        preparedDigest: evidenceDigest(preparedBytes),
        preparedBytes,
        requirementsDigest: evidenceDigest(paymentRequirements),
        mechanism: this.executionMechanism,
        profile: execution.authorizationRequest.executionProfile,
        ...(this.executionMechanism === "single-transaction" ? { transactionId } : {}),
        requiredAssurance: this.executionMechanism === "single-transaction"
          ? "accepted"
          : "channel-commitment",
        fundingSource: "vault-treasury",
      };
      const result = this.preparedMutation?.(prepared) ?? prepared;
      this.prepared.set(execution.purchaseId, result);
      this.onExactPrepared?.();
      return result;
    },
    submit: async ({ context }): Promise<PaymentSubmissionResult> => {
      this.calls.submit++;
      const purchaseId = context.execution.purchaseId;
      const preparedBytes = context.preparation.preparedBytes;
      assert.equal(evidenceDigest(preparedBytes), this.prepared.get(purchaseId)?.preparedDigest);
      if (this.submitMode === "throw") throw new Error("simulated transport loss");
      if (this.submitMode === "submitted") {
        return { status: "submitted", submissionDigest: evidenceDigest(`submission:${purchaseId}`) };
      }
      const settlement = this.settlement(purchaseId);
      return {
        status: "settled",
        submissionDigest: evidenceDigest(`submission:${purchaseId}`),
        settlement,
        paidResponse: this.paidResponseAvailable
          ? this.fulfilmentResult({
              purchaseId,
              terms: context.execution.terms,
              authorizationEvidenceDigest: context.execution.authorization.evidenceDigest,
              settlementEvidenceDigest: settlement.evidence.declaredDigest!,
            })
          : undefined,
      };
    },
    observe: async ({ effect }): Promise<PaymentRecoveryObservation> => {
      this.calls.observe++;
      if (this.observeMode === "pending") return { status: "pending", detailDigest: evidenceDigest("pending") };
      if (this.observeMode === "conflict") {
        return { status: "conflict", detailDigest: evidenceDigest("conflicting-observation") };
      }
      if (this.observeMode === "not_found_retryable") {
        return {
          status: "not_found",
          safeToRetry: true,
          detailDigest: evidenceDigest("chain-and-merchant-not-found"),
        };
      }
      if (this.observeMode === "application_failure") {
        return {
          status: "application_failure",
          errorCode: "merchant_rejected_payment",
          detailDigest: evidenceDigest("terminal-payment-failure"),
        };
      }
      return { status: "settled", settlement: this.settlement(effect.purchaseId) };
    },
  };

  readonly stagingRecovery: TreasuryStagingRecoveryModule = {
    prepare: async (input) => {
      this.recoveryCalls.prepare++;
      this.recoveryPreparedInputs.push(structuredClone(input));
      const recoveryTransactionId = "ef".repeat(32);
      const preparedBytes = Buffer.from(
        JSON.stringify({
          purchaseId: input.purchaseId,
          exactTransactionId: input.exactPayment?.transactionId ?? null,
          recoveryTransactionId,
        })
      );
      const prepared: PreparedStagingRecovery = {
        preparedBytes,
        preparedDigest: evidenceDigest(preparedBytes),
        exactTransactionId: input.exactPayment?.transactionId,
        recoveryTransactionId,
        recoveryOutpoint: `${recoveryTransactionId}:0`,
        recoveryAmountAtomic: (
          70n - BigInt(this.stagingRecoveryFeeAtomic)
        ).toString(),
        stagingFeeAtomic: this.stagingFeeAtomic,
        recoveryFeeAtomic: this.stagingRecoveryFeeAtomic,
        requiredFinality: "accepted",
      };
      return prepared;
    },
    observe: async ({ preparedBytes }) => {
      this.recoveryCalls.observe++;
      this.recoveryObservedBytes.push(Buffer.from(preparedBytes).toString("base64url"));
      const parsed = JSON.parse(Buffer.from(preparedBytes).toString("utf8")) as {
        exactTransactionId: string | null;
        recoveryTransactionId: string;
      };
      const evidence = evidenceDigest(
        `staging-recovery:${this.stagingRecoveryObserveMode}:${this.recoveryCalls.observe}`
      );
      switch (this.stagingRecoveryObserveMode) {
        case "safe_to_submit":
          return {
            status: "safe_to_submit" as const,
            evidenceDigest: evidence,
            readiness: {
              proofDigest: evidenceDigest(`readiness:${this.recoveryCalls.observe}`),
              observedAtMs: NOW,
              expiresAtMs: NOW + 1_000,
              token: { call: this.recoveryCalls.observe },
            },
          };
        case "pending":
          return { status: "pending" as const, evidenceDigest: evidence };
        case "exact_payment_won":
          if (!parsed.exactTransactionId) throw new Error("no exact candidate");
          if (this.settleAfterExactRecoveryWinner) this.observeMode = "settled";
          return {
            status: "exact_payment_won" as const,
            transactionId: parsed.exactTransactionId,
            finality: "accepted",
            evidenceDigest: evidence,
          };
        case "recovery_won":
          return {
            status: "recovery_won" as const,
            transactionId: parsed.recoveryTransactionId,
            recoveryOutpoint: `${parsed.recoveryTransactionId}:0`,
            recoveryAmountAtomic: (
              70n - BigInt(this.stagingRecoveryFeeAtomic)
            ).toString(),
            finality: "accepted",
            evidenceDigest: evidence,
          };
        case "conflict":
          return {
            status: "conflict" as const,
            reason: "unknown_staging_spender",
            evidenceDigest: evidence,
          };
      }
    },
    submit: async ({ preparedBytes }) => {
      this.recoveryCalls.submit++;
      const parsed = JSON.parse(Buffer.from(preparedBytes).toString("utf8")) as {
        recoveryTransactionId: string;
      };
      return {
        status: this.stagingRecoverySubmitMode,
        transactionId: parsed.recoveryTransactionId,
        submissionDigest: evidenceDigest(
          `staging-recovery-submit:${this.recoveryCalls.submit}`
        ),
      };
    },
  };

  readonly fulfilment: FulfilmentModule = {
    obtain: async (input) => {
      this.calls.fulfilment++;
      return this.fulfilmentResult(input);
    },
  };

  private fulfilmentResult(input: {
    purchaseId: PurchaseId;
    terms: CheckoutTerms;
    authorizationEvidenceDigest: ReturnType<typeof evidenceDigest>;
    settlementEvidenceDigest: ReturnType<typeof evidenceDigest>;
  }) {
    const body = Buffer.from("deterministic resource body");
    const fulfilmentDigest = evidenceDigest(body);
    return {
      status: "fulfilled" as const,
      httpStatus: 200,
      body,
      mediaType: "text/plain; charset=utf-8",
      resourceFingerprint: input.terms.resourceFingerprint,
      merchantEvidence: artifact(`fulfilment:${input.purchaseId}`, "test-fulfilment", "merchant:test"),
      receipts: this.receiptsAvailable ? [
          {
            role: "merchant",
            checkoutDigest: input.terms.checkoutDigest,
            authorizationEvidenceDigest: input.authorizationEvidenceDigest,
            settlementEvidenceDigest: input.settlementEvidenceDigest,
            fulfilmentDigest,
            evidence: artifact(
              `merchant-receipt:${input.purchaseId}`,
              "urn:sompi:receipt:merchant:1",
              "merchant:test"
            ),
          },
          {
            role: "payment",
            checkoutDigest: input.terms.checkoutDigest,
            authorizationEvidenceDigest: input.authorizationEvidenceDigest,
            settlementEvidenceDigest: input.settlementEvidenceDigest,
            fulfilmentDigest,
            evidence: artifact(
              `payment-receipt:${input.purchaseId}`,
              "urn:sompi:receipt:payment:1",
              "payment:test"
            ),
          },
      ] : [],
    };
  }

  private settlement(purchaseId: string): SettlementResult {
    const prepared = this.prepared.get(purchaseId);
    if (!prepared) throw new Error("no fake preparation");
    const transactionId = prepared.transactionId;
    if (prepared.mechanism === "single-transaction") {
      assert.equal(typeof transactionId, "string");
    }
    const settlement: SettlementResult = {
      evidence: artifact(`settlement:${purchaseId}`, "test-settlement", "merchant:test"),
      executionId: prepared.executionId,
      mechanism: prepared.mechanism,
      profile: prepared.profile,
      ...(prepared.mechanism === "single-transaction"
        ? { transactionId: transactionId!, outpoint: `${transactionId}:1` }
        : { commitmentId: "bc".repeat(32) }),
      amountAtomic: prepared.mechanism === "single-transaction" ? prepared.amountAtomic : "40",
      additionalCostAtomic: prepared.mechanism === "single-transaction" ? "2" : "0",
      asset: prepared.asset,
      network: prepared.network,
      payTo: prepared.payTo,
      settlementAssurance: prepared.requiredAssurance,
      fundingSource: "vault-treasury",
    };
    return this.settlementMutation?.(settlement) ?? settlement;
  }

  private stagingResult(purchaseId: string): TreasuryStagingResult {
    const staged = this.staged.get(purchaseId);
    if (!staged) throw new Error("no fake Treasury staging preparation");
    return {
      evidence: artifact(
        `treasury-staging-observation:${purchaseId}`,
        "test-treasury-staging",
        "kaspa-observer:test"
      ),
      transactionId: staged.transactionId,
      outpoint: staged.expectedOutpoint,
      stagingAmountAtomic: staged.stagingAmountAtomic,
      fundingSource: staged.fundingSource,
    };
  }
}

async function verifiedAuthorityResult(
  request: PurchaseAuthorizationRequest,
  decision: "approved" | "denied",
  mutate?: (facts: ReturnType<typeof authorizationFacts>) => ReturnType<typeof authorizationFacts>
): Promise<Exclude<AuthorityResult, { status: "pending" }>> {
  const purchaseFacts = mutate?.(authorizationFacts(request)) ?? authorizationFacts(request);
  const approvalRequest = {
    kind: "approval_request" as const,
    requestId: createAuthorityRequestId(new Uint8Array(16).fill(7)),
    nonce: createAuthorityNonce(new Uint8Array(32).fill(8)),
    issuedAtMs: NOW - 100,
    expiresAtMs: Math.min(request.expiresAtMs, NOW + 120_000),
    facts: {
      purchaseId: purchaseFacts.purchaseId,
      merchantId: purchaseFacts.merchantId,
      merchantName: request.terms.merchant.name,
      merchantOrigin: purchaseFacts.merchantOrigin,
      resourceUrl: purchaseFacts.resourceUrl,
      method: purchaseFacts.method,
      requestMediaType: purchaseFacts.requestMediaType,
      requestBodyDigest: purchaseFacts.requestBodyDigest,
      resourceFingerprint: purchaseFacts.resourceFingerprint,
      amountAtomic: purchaseFacts.amountAtomic,
      asset: purchaseFacts.asset,
      network: purchaseFacts.network,
      payTo: purchaseFacts.payTo,
      termsExpiresAt: purchaseFacts.expiresAt,
      checkoutDigest: purchaseFacts.checkoutDigest,
      purchaseAuthorizationRequestDigest: purchaseFacts.requestDigest,
      purchaseAuthorizationNonceDigest: purchaseFacts.nonceDigest,
      purchaseAuthorizationFactsDigest: evidenceDigest(JSON.stringify(purchaseFacts)),
      additionalCostCeilingAtomic: purchaseFacts.additionalCostCeilingAtomic,
      effectiveFinalityFloor: purchaseFacts.effectiveFinalityFloor,
      executionPlanDigest: purchaseFacts.executionPlanDigest,
      executionMechanism: purchaseFacts.executionMechanism,
      executionProfile: purchaseFacts.executionProfile,
      settlementAssurance: purchaseFacts.settlementAssurance,
      maximumAuthorizedChargeAtomic: purchaseFacts.maximumAuthorizedChargeAtomic,
      channelId: purchaseFacts.channelId ?? null,
      channelEpochDigest: purchaseFacts.channelEpochDigest ?? null,
    },
    checkoutEvidence: {
      artifact: `checkout:${request.purchaseId}`,
      digest: purchaseFacts.checkoutDigest,
      mediaType: "application/jwt",
      profile: "test-checkout",
      issuer: purchaseFacts.merchantId,
    },
  };
  const key = new Uint8Array(AUTHORITY_MAC_KEY_BYTES).fill(0x5a);
  const authentication = { keyId: "authority-ipc:test", keyBytes: key };
  const requestStore = new TestReplayStore();
  const sealedRequest = sealAuthorityApprovalRequest(approvalRequest, authentication);
  const verifiedRequest = parseAuthorityApprovalRequest(sealedRequest.wire, {
    ...authentication,
    now: () => NOW,
    replayStore: requestStore,
  });
  const evidenceBytes = Buffer.from(`authority:${request.purchaseId}:${decision}`, "utf8");
  const response = bindAuthorityApprovalResponse(verifiedRequest, {
    responseId: createAuthorityResponseId(new Uint8Array(16).fill(9)),
    respondedAtMs: NOW + 1,
    expiresAtMs: Math.min(approvalRequest.expiresAtMs, NOW + 20_000),
    result: decision === "approved"
      ? {
          decision,
          authorityId: "authority:test",
          decisionEvidenceDigest: evidenceDigest(evidenceBytes),
          evidenceVerification: AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
        }
      : {
          decision,
          authorityId: "authority:test",
          denialCode: "user_denied" as const,
          decisionEvidenceDigest: evidenceDigest(evidenceBytes),
          evidenceVerification: AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
        },
  });
  const sealedResponse = sealAuthorityApprovalResponse(response, verifiedRequest, authentication);
  const ipc = parseAuthorityApprovalResponse(sealedResponse.wire, verifiedRequest, {
    ...authentication,
    now: () => NOW + 1,
    replayStore: new TestReplayStore(),
  });
  const verifiedDecision = await verifyAuthorityDecisionEvidence(
    ipc,
    verifiedRequest,
    evidenceBytes,
    {
      async verify({ expected }) {
        return {
          decision: expected.decision,
          authorityId: expected.authorityId,
          purchaseId: expected.purchaseId,
          checkoutDigest: expected.checkoutDigest,
          requestDigest: expected.requestDigest,
          factsDigest: expected.factsDigest,
          nonceDigest: expected.nonceDigest,
          evidenceDigest: expected.evidenceDigest,
          verificationProfile: "urn:sompi:authority-decision:test:1",
          verifierId: "authority-verifier:test",
        };
      },
    }
  );
  return {
    status: "decision",
    decision: verifiedDecision,
    decisionEvidenceBytes: evidenceBytes,
    decisionEvidenceMediaType: "application/jose",
    decisionEvidenceIssuer: "authority:test",
  };
}

class TestReplayStore implements AuthorityReplayStore {
  private readonly tokens = new Map<string, string>();
  private readonly leases = new Map<string, { acquisitionId: string; leaseExpiresAtMs: number }>();
  private readonly completions = new Map<string, AuthorityReplayCompletion>();
  private sequence = 0;

  acquire(input: AuthorityReplayAcquireInput): AuthorityReplayAcquireResult {
    const existing = input.tokenDigests.map((token) => this.tokens.get(token));
    if (existing.some((digest) => digest !== undefined)) {
      if (!existing.every((digest) => digest === input.messageDigest)) return { status: "conflict" };
      const lease = this.leases.get(input.messageDigest)!;
      if (!this.completions.has(`${input.scope}:${input.messageDigest}`) && lease.leaseExpiresAtMs <= input.nowMs) {
        const acquisitionId = `test-acquisition:${++this.sequence}`;
        this.leases.set(input.messageDigest, { acquisitionId, leaseExpiresAtMs: input.leaseExpiresAtMs });
        return { status: "acquired", acquisitionId, leaseExpiresAtMs: input.leaseExpiresAtMs };
      }
      return { status: "existing", leaseExpiresAtMs: lease.leaseExpiresAtMs };
    }
    const acquisitionId = `test-acquisition:${++this.sequence}`;
    for (const token of input.tokenDigests) this.tokens.set(token, input.messageDigest);
    this.leases.set(input.messageDigest, { acquisitionId, leaseExpiresAtMs: input.leaseExpiresAtMs });
    return { status: "acquired", acquisitionId, leaseExpiresAtMs: input.leaseExpiresAtMs };
  }

  renew(input: AuthorityReplayRenewInput): void {
    const lease = this.leases.get(input.messageDigest);
    if (!lease || lease.acquisitionId !== input.acquisitionId || lease.leaseExpiresAtMs <= input.nowMs) {
      throw new Error("stale test replay lease");
    }
    lease.leaseExpiresAtMs = input.leaseExpiresAtMs;
  }

  lookup(input: AuthorityReplayLookupInput): AuthorityReplayCompletion | undefined {
    return this.completions.get(`${input.scope}:${input.messageDigest}`);
  }

  complete(input: AuthorityReplayCompleteInput): void {
    if (this.leases.get(input.messageDigest)?.acquisitionId !== input.acquisitionId) {
      throw new Error("stale test replay acquisition");
    }
    this.completions.set(`${input.scope}:${input.messageDigest}`, {
      scope: input.scope,
      messageDigest: input.messageDigest,
      resultDigest: input.resultDigest,
      result: input.result,
      expiresAtMs: input.expiresAtMs,
    });
  }
}

function artifact(
  value: string,
  profile: string,
  issuer: string,
  detailDigest = evidenceDigest(`verified:${value}`)
): VerifiedArtifact {
  const bytes = Buffer.from(value);
  return {
    bytes,
    mediaType: "application/octet-stream",
    profile,
    issuer,
    declaredDigest: evidenceDigest(bytes),
    verification: {
      verifierId: `verifier:${profile}`,
      profile,
      detailDigest,
    },
  };
}

function makeIntent(): PurchaseIntent {
  return {
    requestKey: assertPurchaseRequestKey("test:coordinator:purchase-1"),
    resource: { url: "https://merchant.example/resource", method: "GET" },
    expectedMerchant: { id: "merchant:test", origin: "https://merchant.example" },
  };
}

async function safeStatus(coordinator: PurchaseCoordinator, id: FakeDependencies["lastPurchaseId"]) {
  assert.ok(id);
  return coordinator.status(id);
}
