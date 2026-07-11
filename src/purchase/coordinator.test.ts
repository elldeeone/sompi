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
        { kind: "kaspa-x402-exact", state: "observed" },
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
      journal.effectsForPurchase(ambiguous.id).find((effect) => effect.kind === "kaspa-x402-exact")?.state,
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

test("restart after durable preparation reuses exact bytes instead of preparing or signing again", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-coordinator-prepared-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const dependencies = new FakeDependencies();
  let effectInsertions = 0;
  let journal = new PurchaseJournal(filename, {
    now: () => NOW,
    faultInjector(point: JournalFaultPoint) {
      if (point === "effect.after_insert" && ++effectInsertions === 2) {
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
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => NOW });
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
  calls = {
    checkout: 0,
    authority: 0,
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
      return certifyVerifiedCheckoutDiscovery({
        terms: this.termsMutation?.(terms) ?? terms,
        checkoutEvidence,
        paymentRequirements: artifact(`requirements:${purchaseId}`, "test-requirements", "merchant:test"),
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
  };

  readonly payment: KaspaPaymentModule = {
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
      return prepared;
    },
    submitStaging: async ({ context }): Promise<TreasuryStagingSubmissionResult> => {
      this.calls.submitStaging++;
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
      assert.equal(staging.outpoint, this.staged.get(execution.purchaseId)?.expectedOutpoint);
      assert.equal(staging.amountAtomic, this.staged.get(execution.purchaseId)?.stagingAmountAtomic);
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
        transactionId,
        requiredFinality: "accepted",
        fundingSource: "vault-treasury",
      };
      const result = this.preparedMutation?.(prepared) ?? prepared;
      this.prepared.set(execution.purchaseId, result);
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
    const settlement: SettlementResult = {
      evidence: artifact(`settlement:${purchaseId}`, "test-settlement", "merchant:test"),
      transactionId: prepared.transactionId,
      outpoint: `${prepared.transactionId}:1`,
      amountAtomic: prepared.amountAtomic,
      additionalCostAtomic: "2",
      asset: prepared.asset,
      network: prepared.network,
      payTo: prepared.payTo,
      finality: prepared.requiredFinality,
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
    expiresAtMs: NOW + 20_000,
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
