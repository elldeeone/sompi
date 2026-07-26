import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { authorizationFactsDigest } from "../purchase/contracts.js";
import {
  assertPurchaseRequestKey,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "../purchase/identity.js";
import {
  PolicyReservationError,
  PurchaseJournal,
  type PolicySnapshotRecord,
} from "../purchase/journal.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { PolicyEngine } from "../policy.js";
import type {
  PreparedTreasuryOperationMaterial,
  TreasuryOperationKind,
  TreasuryOperationRecord,
} from "./operation-journal.js";
import type {
  TreasuryOperationAdapter,
  TreasuryOperationProbe,
} from "./operation-adapters.js";
import { TreasuryPreparationError } from "./operation-adapters.js";
import { TreasuryOperationModule } from "./operations.js";
import {
  TreasuryCapacityError,
  type ReservePurchaseCapacityInput,
} from "./purchase-capacity.js";

const NOW = 1_900_000_000_000;
const DESTINATION = "kaspatest:merchant";

test("direct Treasury execution persists intent and signed bytes before one submission", async () => {
  await withFixture(async ({ journal, module, wallet }) => {
    wallet.onSubmit = (intent) => {
      assert.equal(journal.requireTreasuryOperation(intent.operationKey).state, "submission_planned");
      assert.match(
        journal.readPreparedTreasuryOperation(intent.operationKey).toString("utf8"),
        /immutable/
      );
    };
    wallet.probes.push(observed(wallet.transactionId));
    const completed = await module.execute({
      operationKey: "direct:wallet:one",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(completed.state, "completed");
    assert.equal(wallet.submitCalls, 1);
    assert.equal(wallet.commitCalls, 1);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);

    const replay = await module.execute({
      operationKey: "direct:wallet:one",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(replay.state, "completed");
    assert.equal(wallet.submitCalls, 1);
    await assert.rejects(
      module.execute({
        operationKey: "direct:wallet:one",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "101",
      }),
      /different immutable intent/
    );
  });
});

test("ambiguous submission remains fenced through temporary absence and later completes from acceptance evidence", async () => {
  await withFixture(async ({ journal, module, wallet }) => {
    wallet.submitErrors = 1;
    wallet.probes.push(pending(wallet.transactionId), pending(wallet.transactionId));
    const first = await module.execute({
      operationKey: "direct:wallet:ambiguous",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(first.state, "submission_planned");
    assert.equal(first.recoveryRequired, true);
    assert.equal(wallet.submitCalls, 1);

    const stillPending = await module.recover("direct:wallet:ambiguous");
    assert.equal(stillPending.state, "submission_planned");
    assert.equal(wallet.submitCalls, 1, "pending observation must never rebroadcast");

    wallet.probes.push(notSubmitted(wallet.transactionId), observed(wallet.transactionId));
    const absent = await module.recover("direct:wallet:ambiguous");
    assert.equal(absent.state, "submission_planned");
    assert.equal(absent.retryCount, 0);
    assert.equal(wallet.submitCalls, 1, "temporary absence must not rebroadcast an ambiguous submission");
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);

    const recovered = await module.recover("direct:wallet:ambiguous");
    assert.equal(recovered.state, "completed");
    assert.equal(recovered.retryCount, 0);
    assert.equal(wallet.submitCalls, 1);
  });
});

test("an operation admitted under an older policy snapshot remains recoverable", async () => {
  await withFixture(async ({ journal, policy, module, wallet }) => {
    wallet.typedPrepareErrors.push(
      new TreasuryPreparationError("transient_unavailable", "preparation", "temporary node failure"),
    );
    await assert.rejects(module.execute({
        operationKey: "direct:policy-snapshot:recover",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "100",
      }), TreasuryPreparationError);
    assert.equal(
      journal.requireTreasuryOperation("direct:policy-snapshot:recover").state,
      "intent",
    );
    const originalPolicyDigest = journal.requireTreasuryOperation(
      "direct:policy-snapshot:recover",
    ).policyDigest;

    policy.activate({
      maxSompiPerTx: 500n,
      maxSompiPerHour: 5_000n,
      allowlist: [DESTINATION],
    });
    journal.installPolicy({
      maxPerPaymentAtomic: "500",
      maxPerHourAtomic: "5000",
      allowlist: [DESTINATION],
    });
    assert.notEqual(journal.requireActivePolicy().digest, originalPolicyDigest);

    wallet.probes.push(observed(wallet.transactionId));
    const recovered = await module.recover("direct:policy-snapshot:recover");
    assert.equal(recovered.state, "completed");
    assert.equal(wallet.submitCalls, 1);
    assert.equal(
      journal.requireTreasuryOperation("direct:policy-snapshot:recover").policyDigest,
      originalPolicyDigest,
      "recovery must retain the exact policy snapshot that admitted the operation",
    );
  });
});

test("observed fact survives a local commit crash without observation or submission replay", async () => {
  await withFixture(async ({ journal, module, vault }) => {
    vault.probes.push(observed(vault.transactionId));
    vault.commitErrors = 1;
    await assert.rejects(
      module.execute({
        operationKey: "direct:vault:commit-crash",
        kind: "vault_send",
        destination: DESTINATION,
        amountAtomic: "100",
      }),
      /injected commit crash/
    );
    assert.equal(journal.requireTreasuryOperation("direct:vault:commit-crash").state, "observed");
    assert.equal(vault.submitCalls, 1);
    assert.equal(vault.observeCalls, 1);

    const recovered = await module.recover("direct:vault:commit-crash");
    assert.equal(recovered.state, "completed");
    assert.equal(vault.submitCalls, 1);
    assert.equal(vault.observeCalls, 1);
    assert.equal(vault.commitCalls, 2);
  });
});

test("direct and Purchase reservations share one transactional hourly capacity", async () => {
  await withFixture(
    async ({ directory, journal, policy, wallet, vault, deposit }) => {
      wallet.prepareErrors = 1;
      const module = new TreasuryOperationModule({
        journal,
        policy,
        adapters: [wallet, vault, deposit],
        feeCeilingAtomic: "10",
      });
      await assert.rejects(
        module.execute({
          operationKey: "direct:capacity:first",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "590",
        }),
        /injected prepare crash/
      );
      assert.equal(journal.treasuryPolicyCapacityUsed(), 600n);

      const purchaseId = authorizedPurchase(journal, 71, "390");
      const snapshot = journal.requireActivePolicy();
      reservePurchase(journal, purchaseId, snapshot, "res_combined_exact", "390", "10");
      assert.equal(journal.treasuryPolicyCapacityUsed(), 1_000n);

      const otherHandle = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
        now: () => NOW,
      });
      try {
        const otherPurchase = authorizedPurchase(otherHandle, 72, "1");
        assert.throws(
          () => reservePurchase(otherHandle, otherPurchase, snapshot, "res_combined_over", "1", "0"),
          PolicyReservationError
        );
      } finally {
        otherHandle.close();
      }
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("Treasury owns one Purchase reservation and shares its capacity with direct Movements", async () => {
  await withFixture(
    async ({ journal, module, wallet }) => {
      const purchaseId = authorizedPurchase(journal, 73, "390");
      const capacity = await module.reservePurchaseCapacity(
        purchaseCapacityInput(journal, purchaseId, "res_treasury_owned"),
      );

      assert.equal(capacity.status, "reserved");
      if (capacity.status !== "reserved") return;
      assert.equal(capacity.reservation.state, "active");
      assert.equal(capacity.reservation.amountAtomic, "390");
      assert.equal(capacity.reservation.additionalCostCeilingAtomic, "10");
      assert.equal(module.effectiveCapacityUsed(), 400n);

      wallet.prepareErrors = 1;
      await assert.rejects(
        module.execute({
          operationKey: "direct:after-purchase-capacity",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "590",
        }),
        /injected prepare crash/,
      );
      assert.equal(module.effectiveCapacityUsed(), 1_000n);
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" },
  );
});

test("Treasury capacity is idempotent, policy-bound, and expires through its interface", async () => {
  await withFixture(async ({ journal, module, policy, advanceTime }) => {
    const purchaseId = authorizedPurchase(journal, 74, "100");
    const input = purchaseCapacityInput(
      journal,
      purchaseId,
      "res_treasury_interface",
    );

    const first = await module.reservePurchaseCapacity(input);
    const replay = await module.reservePurchaseCapacity(input);
    assert.equal(first.status, "reserved");
    assert.deepEqual(replay, first);
    assert.equal(module.effectiveCapacityUsed(), 110n);

    policy.activate({
      maxSompiPerTx: 500n,
      maxSompiPerHour: 5_000n,
      allowlist: [DESTINATION],
    });
    journal.installPolicy({
      maxPerPaymentAtomic: "500",
      maxPerHourAtomic: "5000",
      allowlist: [DESTINATION],
    });
    await assert.rejects(
      module.reservePurchaseCapacity(input),
      (error: unknown) =>
        error instanceof TreasuryCapacityError &&
        error.code === "treasury_policy_changed",
    );

    advanceTime(60_001);
    const expired = await module.reservePurchaseCapacity(input);
    assert.equal(expired.status, "reserved");
    if (expired.status !== "reserved") return;
    assert.equal(expired.reservation.state, "expired");
    assert.equal(module.effectiveCapacityUsed(), 0n);
  });
});

test("Treasury rejects a Purchase quote above the authorized ceiling", async () => {
  await withFixture(
    async ({ journal, module }) => {
      const purchaseId = authorizedPurchase(journal, 75, "100");
      await assert.rejects(
        module.reservePurchaseCapacity(
          purchaseCapacityInput(journal, purchaseId, "res_quote_increased"),
        ),
        (error: unknown) =>
          error instanceof TreasuryCapacityError &&
          error.code === "treasury_quote_increased",
      );
      assert.equal(journal.findReservationForPurchase(purchaseId), undefined);
    },
    { purchaseAdditionalCostCeilingAtomic: "11" },
  );
});

test("a durable Treasury driver serializes cross-handle execution and effects", async () => {
  await withFixture(async ({ journal, policy, wallet, vault, deposit, module }) => {
    let releasePreparation!: () => void;
    wallet.prepareGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    wallet.probes.push(observed(wallet.transactionId));
    const secondWallet = new FakeAdapter("wallet_send", "4");
    const secondVault = new FakeAdapter("vault_send", "5");
    const secondDeposit = new FakeAdapter("vault_deposit", "6");
    const secondModule = new TreasuryOperationModule({
      journal,
      policy,
      adapters: [secondWallet, secondVault, secondDeposit],
      feeCeilingAtomic: "10",
    });

    const first = module.execute({
      operationKey: "direct:driver:single-writer",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    for (let attempt = 0; attempt < 100 && wallet.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(wallet.prepareCalls, 1);
    const second = secondModule.execute({
      operationKey: "direct:driver:single-writer",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondWallet.prepareCalls, 0, "a foreign live driver must block adapter work");
    releasePreparation();

    const [firstView, secondView] = await Promise.all([first, second]);
    assert.equal(firstView.state, "completed");
    assert.equal(secondView.state, "completed");
    assert.equal(wallet.prepareCalls, 1);
    assert.equal(wallet.submitCalls, 1);
    assert.equal(wallet.commitCalls, 1);
    assert.equal(secondWallet.prepareCalls, 0);
    assert.equal(secondWallet.submitCalls, 0);
    assert.equal(secondWallet.commitCalls, 0);
  });
});

test("driver takeover preserves an effect capability until authoritative observation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-treasury-driver-takeover-"));
  let now = NOW;
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => now });
  const policy = new PolicyEngine({
    maxSompiPerTx: 1_000n,
    maxSompiPerHour: 10_000n,
    allowlist: [DESTINATION],
  });
  try {
    const wallet = new FakeAdapter("wallet_send", "7");
    const vault = new FakeAdapter("vault_send", "8");
    const deposit = new FakeAdapter("vault_deposit", "9");
    new TreasuryOperationModule({
      journal,
      policy,
      adapters: [wallet, vault, deposit],
      feeCeilingAtomic: "10",
    });
    const snapshot = journal.requireActivePolicy();
    journal.claimTreasuryOperationIntent({
      operationKey: "direct:driver:takeover",
      requestDigest: evidenceDigest("driver-takeover"),
      kind: "wallet_send",
      destination: DESTINATION,
      requestedAmountAtomic: "100",
      feeCeilingAtomic: "10",
      retryLimit: 3,
      policyDigest: snapshot.digest,
    });
    const first = journal.claimTreasuryOperationDriver(
      "direct:driver:takeover",
      "driver:first",
      60_000,
    );
    assert.ok(first.lease);
    journal.recordPreparedTreasuryOperation(
      "direct:driver:takeover",
      {
        bytes: Buffer.from("prepared-before-takeover", "utf8"),
        transactionId: "7".repeat(64),
        amountAtomic: "100",
        feeAtomic: "10",
        policyDigest: snapshot.digest,
      },
      first.lease,
    );
    assert.equal(journal.planTreasuryOperationSubmission("direct:driver:takeover", first.lease), true);
    assert.equal(journal.claimTreasuryOperationEffectCapability("direct:driver:takeover", first.lease), true);
    now += 60_001;
    const successor = journal.claimTreasuryOperationDriver(
      "direct:driver:takeover",
      "driver:successor",
      60_000,
    );
    assert.ok(successor.acquired);
    assert.ok(successor.lease);
    assert.equal(successor.lease.generation, first.lease.generation + 1);
    assert.equal(successor.record.effectCapabilityGeneration, first.lease.generation);
    assert.throws(
      () => journal.recordTreasuryOperationSubmissionAccepted(
        "direct:driver:takeover",
        "7".repeat(64),
        first.lease,
      ),
      /stale|capability/,
    );
    assert.equal(journal.requireTreasuryOperation("direct:driver:takeover").state, "submission_planned");
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an expired predecessor cannot be rebroadcast or release capacity after submit begins", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-treasury-stale-submit-"));
  fs.chmodSync(directory, 0o700);
  let now = NOW;
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => now });
  const policy = new PolicyEngine({
    maxSompiPerTx: 1_000n,
    maxSompiPerHour: 10_000n,
    allowlist: [DESTINATION],
  });
  const predecessor = new FakeAdapter("wallet_send", "a");
  const successor = new FakeAdapter("wallet_send", "a");
  predecessor.setSubmitGate();
  successor.probes.push(notSubmitted(successor.transactionId), observed(successor.transactionId));
  const adapters = (wallet: FakeAdapter) => [
    wallet,
    new FakeAdapter("vault_send", "b"),
    new FakeAdapter("vault_deposit", "c"),
  ];
  const firstModule = new TreasuryOperationModule({
    journal,
    policy,
    adapters: adapters(predecessor),
    feeCeilingAtomic: "10",
  });
  const secondModule = new TreasuryOperationModule({
    journal,
    policy,
    adapters: adapters(successor),
    feeCeilingAtomic: "10",
  });
  try {
    const first = firstModule.execute({
      operationKey: "direct:stale-submit",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    await predecessor.submitEntered;
    const paused = journal.requireTreasuryOperation("direct:stale-submit");
    assert.equal(paused.submissionInFlight, true);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);

    now += 60_001;
    const takeover = await secondModule.recover("direct:stale-submit");
    assert.equal(takeover.state, "submission_planned");
    assert.equal(journal.requireTreasuryOperation("direct:stale-submit").submissionInFlight, true);
    assert.equal(successor.submitCalls, 0);
    assert.equal(journal.unresolvedTreasuryOperationCount(), 1);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);

    predecessor.releaseSubmit();
    await assert.rejects(first, /stale|capability|concurrent/);
    assert.equal(successor.submitCalls, 0);
    assert.equal(journal.requireTreasuryOperation("direct:stale-submit").submissionInFlight, true);

    const completed = await secondModule.recover("direct:stale-submit");
    assert.equal(completed.state, "completed");
    assert.equal(predecessor.submitCalls, 1);
    assert.equal(successor.submitCalls, 0);
    assert.equal(journal.unresolvedTreasuryOperationCount(), 0);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Vault send and deposit takeovers are observation-only while a submit predecessor is live", async () => {
  for (const [kind, amountAtomic, keepFloatAtomic] of [
    ["vault_send", "100", undefined],
    ["vault_deposit", "max", "20"],
  ] as const) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sompi-treasury-${kind}-takeover-`));
    fs.chmodSync(directory, 0o700);
    let now = NOW;
    const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => now });
    const policy = new PolicyEngine({
      maxSompiPerTx: 1_000n,
      maxSompiPerHour: 10_000n,
      allowlist: [DESTINATION],
    });
    const predecessor = new FakeAdapter(kind, "a");
    const successor = new FakeAdapter(kind, "a");
    predecessor.setSubmitGate();
    successor.probes.push(notSubmitted(successor.transactionId));
    const moduleFor = (adapter: FakeAdapter) => new TreasuryOperationModule({
      journal,
      policy,
      adapters: [
        new FakeAdapter("wallet_send", "b"),
        kind === "vault_send" ? adapter : new FakeAdapter("vault_send", "c"),
        kind === "vault_deposit" ? adapter : new FakeAdapter("vault_deposit", "d"),
      ],
      feeCeilingAtomic: "10",
    });
    const firstModule = moduleFor(predecessor);
    const secondModule = moduleFor(successor);
    const operationKey = `direct:${kind}:stale-submit`;
    try {
      const first = firstModule.execute({
        operationKey,
        kind,
        destination: DESTINATION,
        amountAtomic,
        ...(keepFloatAtomic === undefined ? {} : { keepFloatAtomic }),
      });
      await predecessor.submitEntered;
      now += 60_001;
      const takeover = await secondModule.recover(operationKey);
      assert.equal(takeover.state, "submission_planned");
      assert.equal(successor.submitCalls, 0);
      assert.equal(journal.requireTreasuryOperation(operationKey).submissionInFlight, true);
      predecessor.releaseSubmit();
      await assert.rejects(first, /stale|capability|concurrent/);
      assert.equal(successor.submitCalls, 0);
    } finally {
      journal.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("cancellation during a paused submit retains the effect fence until observation resolves", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-treasury-cancelled-submit-"));
  fs.chmodSync(directory, 0o700);
  let now = NOW;
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => now });
  const policy = new PolicyEngine({
    maxSompiPerTx: 1_000n,
    maxSompiPerHour: 10_000n,
    allowlist: [DESTINATION],
  });
  const predecessor = new FakeAdapter("wallet_send", "a");
  const successor = new FakeAdapter("wallet_send", "a");
  predecessor.setSubmitGate();
  successor.probes.push(notSubmitted(successor.transactionId), observed(successor.transactionId));
  const firstModule = new TreasuryOperationModule({
    journal,
    policy,
    adapters: [predecessor, new FakeAdapter("vault_send", "b"), new FakeAdapter("vault_deposit", "c")],
    feeCeilingAtomic: "10",
  });
  const secondModule = new TreasuryOperationModule({
    journal,
    policy,
    adapters: [successor, new FakeAdapter("vault_send", "d"), new FakeAdapter("vault_deposit", "e")],
    feeCeilingAtomic: "10",
  });
  try {
    const first = firstModule.execute({
      operationKey: "direct:cancelled-submit",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    await predecessor.submitEntered;
    assert.equal((await secondModule.cancel("direct:cancelled-submit")).cancellationRequested, true);
    now += 60_001;
    const fenced = await secondModule.recover("direct:cancelled-submit");
    assert.equal(fenced.state, "submission_planned");
    assert.equal(fenced.recoveryRequired, true);
    assert.equal(journal.requireTreasuryOperation("direct:cancelled-submit").submissionInFlight, true);
    assert.equal(journal.unresolvedTreasuryOperationCount(), 1);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
    predecessor.releaseSubmit();
    await assert.rejects(first, /stale|capability|concurrent/);
    const completed = await secondModule.recover("direct:cancelled-submit");
    assert.equal(completed.state, "completed");
    assert.equal(journal.unresolvedTreasuryOperationCount(), 0);
    assert.equal(successor.submitCalls, 0);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation after exact acceptance retains policy through absence and restart for every Treasury adapter", async () => {
  for (const [kind, capacityUsed] of [
    ["wallet_send", 110n],
    ["vault_send", 110n],
    ["vault_deposit", 10n],
  ] as const) {
    await withFixture(
      async ({ directory, journal, policy, module, wallet, vault, deposit }) => {
        const adapter = kind === "wallet_send" ? wallet : kind === "vault_send" ? vault : deposit;
        const operationKey = `direct:${kind}:cancel-after-acceptance`;
        adapter.setSubmitGate();
        adapter.probes.push(
          notSubmitted(adapter.transactionId),
          observed(adapter.transactionId),
        );
        const cancellation = new AbortController();
        const execution = module.execute({
          operationKey,
          kind,
          destination: DESTINATION,
          amountAtomic: "100",
        }, cancellation.signal);
        await adapter.submitEntered;
        cancellation.abort();
        adapter.releaseSubmit();

        const reconciled = await execution;
        assert.equal(reconciled.state, "submitted");
        assert.equal(reconciled.cancellationRequested, true);
        assert.equal(reconciled.recoveryRequired, true);
        assert.equal(journal.unresolvedTreasuryOperationCount(), 1);
        assert.equal(journal.treasuryPolicyCapacityUsed(), capacityUsed);
        assert.throws(
          () => journal.recordTreasuryOperationObservation(
            operationKey,
            "not_submitted",
            { status: "not_submitted", transactionId: adapter.transactionId },
            undefined,
            "proven_not_executed" as never,
          ),
          /submission outcome is invalid/,
          "removed non-execution claims must fail closed at runtime",
        );

        await assert.rejects(
          module.execute({
            operationKey: `direct:${kind}:cancel-after-acceptance-successor`,
            kind: "wallet_send",
            destination: DESTINATION,
            amountAtomic: "100",
          }),
          PolicyReservationError,
        );

        const restartedJournal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
          now: () => NOW,
        });
        try {
          const restartedModule = new TreasuryOperationModule({
            journal: restartedJournal,
            policy,
            adapters: [wallet, vault, deposit],
            feeCeilingAtomic: "10",
          });
          const completed = await restartedModule.recover(operationKey);
          assert.equal(completed.state, "completed");
          assert.equal(adapter.submitCalls, 1);
          assert.equal(restartedJournal.treasuryPolicyCapacityUsed(), capacityUsed);
        } finally {
          restartedJournal.close();
        }
      },
      { maxPerPaymentAtomic: "110", maxPerHourAtomic: "110" },
    );
  }
});

test("an exact submit result is never downgraded when Journal acceptance fails", async () => {
  await withFixture(async ({ journal, module, wallet }) => {
    const original = journal.recordTreasuryOperationSubmissionAccepted.bind(journal);
    (journal as any).recordTreasuryOperationSubmissionAccepted = () => {
      throw new Error("injected Journal acceptance failure");
    };
    await assert.rejects(
      module.execute({
        operationKey: "direct:journal-acceptance-failure",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "100",
      }),
      /injected Journal acceptance failure/,
    );
    const fenced = journal.requireTreasuryOperation("direct:journal-acceptance-failure");
    assert.equal(fenced.state, "submission_planned");
    assert.equal(fenced.submissionInFlight, true);
    assert.equal(wallet.observeCalls, 0);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);

    (journal as any).recordTreasuryOperationSubmissionAccepted = original;
    wallet.probes.push(observed(wallet.transactionId));
    const completed = await module.recover("direct:journal-acceptance-failure");
    assert.equal(completed.state, "completed");
    assert.equal(wallet.submitCalls, 1);
  });
});

test("a waiter takeover drives its acquired generation instead of re-entering the coalescer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-treasury-waiter-takeover-"));
  fs.chmodSync(directory, 0o700);
  let now = NOW;
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => now });
  const policy = new PolicyEngine({
    maxSompiPerTx: 1_000n,
    maxSompiPerHour: 10_000n,
    allowlist: [DESTINATION],
  });
  const wallet = new FakeAdapter("wallet_send", "d");
  wallet.probes.push(observed(wallet.transactionId));
  const module = new TreasuryOperationModule({
    journal,
    policy,
    adapters: [wallet, new FakeAdapter("vault_send", "e"), new FakeAdapter("vault_deposit", "f")],
    feeCeilingAtomic: "10",
  });
  try {
    const snapshot = journal.requireActivePolicy();
    journal.claimTreasuryOperationIntent({
      operationKey: "direct:waiter-takeover",
      requestDigest: evidenceDigest("waiter-takeover"),
      kind: "wallet_send",
      destination: DESTINATION,
      requestedAmountAtomic: "100",
      feeCeilingAtomic: "10",
      retryLimit: 3,
      policyDigest: snapshot.digest,
    });
    journal.claimTreasuryOperationDriver("direct:waiter-takeover", "foreign-driver", 60_000);
    const recovery = module.recover("direct:waiter-takeover");
    await new Promise((resolve) => setTimeout(resolve, 30));
    now += 60_001;
    const completed = await recovery;
    assert.equal(completed.state, "completed");
    assert.equal(wallet.prepareCalls, 1);
    assert.equal(wallet.submitCalls, 1);
    assert.equal(wallet.observeCalls, 1);
    assert.equal(wallet.commitCalls, 1);
    assert.equal(journal.unresolvedTreasuryOperationCount(), 0);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Purchase capacity blocks a direct operation before signing or submission", async () => {
  await withFixture(
    async ({ journal, module, wallet }) => {
      const purchaseId = authorizedPurchase(journal, 73, "600");
      reservePurchase(journal, purchaseId, journal.requireActivePolicy(), "res_purchase_first", "600", "10");
      await assert.rejects(
        module.execute({
          operationKey: "direct:capacity:blocked",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "400",
        }),
        PolicyReservationError
      );
      assert.equal(wallet.prepareCalls, 0);
      assert.equal(wallet.submitCalls, 0);
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("the per-payment limit applies to the recipient amount and reserves the fee separately", async () => {
  await withFixture(
    async ({ journal, module, wallet }) => {
      assert.doesNotThrow(() => module.preflightHumanAuthorized({
        operationKey: "direct:recipient-limit:preflight",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "100",
      }));
      assert.equal(journal.unresolvedTreasuryOperationCount(), 0, "preflight must not create durable intent");
      wallet.probes.push(observed(wallet.transactionId));
      const completed = await module.execute({
        operationKey: "direct:recipient-limit:exact",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "100",
      });
      assert.equal(completed.state, "completed");
      assert.equal(completed.amountAtomic, "100");
      assert.equal(completed.feeAtomic, "10");
      assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
    },
    { maxPerPaymentAtomic: "100", maxPerHourAtomic: "110" }
  );
});

test("an amount above the per-payment limit fails preflight before signing", async () => {
  await withFixture(
    async ({ journal, module, wallet }) => {
      assert.throws(
        () => module.preflightHumanAuthorized({
          operationKey: "direct:recipient-limit:blocked",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "101",
        }),
        /amount 101 exceeds per-payment limit 100/,
      );
      assert.equal(journal.unresolvedTreasuryOperationCount(), 0);
      assert.equal(wallet.prepareCalls, 0);
      assert.equal(wallet.submitCalls, 0);
    },
    { maxPerPaymentAtomic: "100", maxPerHourAtomic: "1000" }
  );
});

test("fee ceiling is reserved against the rolling limit before signing", async () => {
  await withFixture(
    async ({ module, wallet }) => {
      await assert.rejects(
        module.execute({
          operationKey: "direct:fee:blocked",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "100",
        }),
        PolicyReservationError
      );
      assert.equal(wallet.prepareCalls, 0);
      assert.equal(wallet.submitCalls, 0);
    },
    { maxPerPaymentAtomic: "105", maxPerHourAtomic: "105" }
  );
});

test("the full fee ceiling is visible to Purchase reservations before adapter preparation", async () => {
  await withFixture(
    async ({ journal, module, wallet }) => {
      wallet.onPrepare = () => {
        assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
        const purchaseId = authorizedPurchase(journal, 74, "881");
        assert.throws(
          () => reservePurchase(
            journal,
            purchaseId,
            journal.requireActivePolicy(),
            "res_fee_race",
            "881",
            "10"
          ),
          PolicyReservationError
        );
      };
      wallet.probes.push(observed(wallet.transactionId));
      const completed = await module.execute({
        operationKey: "direct:fee:race",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "100",
      });
      assert.equal(completed.state, "completed");
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("vault deposit principal is audited but only its bounded fee consumes spend capacity", async () => {
  await withFixture(
    async ({ journal, module, deposit }) => {
      deposit.probes.push(observed(deposit.transactionId));
      const completed = await module.execute({
        operationKey: "direct:vault:deposit",
        kind: "vault_deposit",
        destination: DESTINATION,
        amountAtomic: "max",
        keepFloatAtomic: "20",
      });
      assert.equal(completed.state, "completed");
      assert.equal(completed.amountAtomic, "100", "moved principal remains an audited fact");
      assert.equal(journal.treasuryPolicyCapacityUsed(), 10n, "only actual deposit fee consumes capacity");

      const purchaseId = authorizedPurchase(journal, 75, "980");
      reservePurchase(
        journal,
        purchaseId,
        journal.requireActivePolicy(),
        "res_after_deposit",
        "980",
        "10"
      );
      assert.equal(journal.treasuryPolicyCapacityUsed(), 1_000n);
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("vault send maximum is rejected before intent or signing", async () => {
  await withFixture(async ({ journal, module, vault }) => {
    await assert.rejects(
      module.execute({
        operationKey: "direct:vault:max-disabled",
        kind: "vault_send",
        destination: DESTINATION,
        amountAtomic: "max",
      }),
      /require an exact amount/
    );
    assert.equal(vault.prepareCalls, 0);
    assert.throws(
      () => journal.requireTreasuryOperation("direct:vault:max-disabled"),
      /does not exist/
    );
  });
});

test("pinned adapter validation rejects an SDK-invalid destination before durable claim", async () => {
  await withFixture(async ({ journal, module, wallet }) => {
    wallet.validationError = new TreasuryPreparationError(
      "invalid_destination",
      "validation",
      "invalid destination",
    );
    await assert.rejects(
      module.execute({
        operationKey: "direct:invalid-address",
        kind: "wallet_send",
        destination: "kaspatest:a",
        amountAtomic: "100",
      }),
      TreasuryPreparationError,
    );
    assert.equal(journal.findTreasuryOperation("direct:invalid-address"), undefined);
    assert.equal(wallet.prepareCalls, 0);
  });
});

test("permanent pre-effect preparation failure terminalizes and releases the shared slot", async () => {
  await withFixture(async ({ journal, module, wallet }) => {
    wallet.typedPrepareErrors.push(new TreasuryPreparationError(
      "invalid_transaction_shape",
      "preparation",
      "permanent shape failure",
    ));
    const failed = await module.execute({
      operationKey: "direct:permanent-pre-effect",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(failed.state, "failed_terminal");
    assert.equal(journal.requireTreasuryOperation("direct:permanent-pre-effect").state, "failed_terminal");
    assert.equal(journal.treasuryPolicyCapacityUsed(), 0n);
    wallet.probes.push(observed(wallet.transactionId));
    const next = await module.execute({
      operationKey: "direct:slot-reuse",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "1",
    });
    assert.equal(next.state, "completed");
  });
});

test("an independently proven mutually exclusive chain winner terminally supersedes without adapter commit", async () => {
  await withFixture(async ({ journal, module, wallet }) => {
    wallet.probes.push({
      status: "superseded",
      detail: {
        profile: "urn:sompi:treasury-operation:observation:1",
        winningEffect: "merchant-claim",
        winningTransactionId: "a".repeat(64),
      },
    });
    const result = await module.execute({
      operationKey: "direct:superseded",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(result.state, "failed_terminal");
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.safeToRetry, false);
    assert.equal(wallet.commitCalls, 0);
    assert.equal(journal.unresolvedTreasuryOperationCount(), 0);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 0n);
  });
});

test("typed transient preparation failures use durable bounded retries across restart", async () => {
  await withFixture(async ({ directory, journal, policy, wallet, vault, deposit }) => {
    wallet.typedPrepareErrors.push(
      new TreasuryPreparationError("transient_unavailable", "preparation", "node unavailable"),
    );
    wallet.probes.push(observed(wallet.transactionId));
    const module = new TreasuryOperationModule({
      journal,
      policy,
      adapters: [wallet, vault, deposit],
      feeCeilingAtomic: "10",
      directTreasuryRetries: 2,
    });
    await assert.rejects(
      module.execute({
        operationKey: "direct:transient-restart",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "100",
      }),
      TreasuryPreparationError,
    );
    assert.equal(journal.requireTreasuryOperation("direct:transient-restart").retryCount, 1);
    journal.close();
    const restarted = new PurchaseJournal(path.join(directory, "purchase.sqlite"), { now: () => NOW });
    try {
      const recovered = new TreasuryOperationModule({
        journal: restarted,
        policy,
        adapters: [wallet, vault, deposit],
        feeCeilingAtomic: "10",
        directTreasuryRetries: 2,
      });
      const completed = await recovered.recover("direct:transient-restart");
      assert.equal(completed.state, "completed");
      assert.equal(completed.retryCount, 1);
    } finally {
      restarted.close();
    }
  });
});

test("retry exhaustion is exact and cancellation never frees prepared or submitted work", async () => {
  await withFixture(async ({ module, journal, wallet }) => {
    wallet.typedPrepareErrors.push(
      new TreasuryPreparationError("transient_unavailable", "preparation", "temporary one"),
      new TreasuryPreparationError("transient_unavailable", "preparation", "temporary two"),
    );
    await assert.rejects(() => module.execute({
      operationKey: "direct:retry-exhaustion",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    }), TreasuryPreparationError);
    const exhausted = await module.recover("direct:retry-exhaustion");
    assert.equal(exhausted.state, "failed_terminal");
    assert.equal(journal.requireTreasuryOperation("direct:retry-exhaustion").retryCount, 2);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 0n);
  }, { directTreasuryRetries: 2 });

  await withFixture(async ({ module, journal, wallet }) => {
    wallet.typedPrepareErrors.push(
      new TreasuryPreparationError("transient_unavailable", "preparation", "temporary"),
    );
    await assert.rejects(() => module.execute({
      operationKey: "direct:cancel-before-effect",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    }), TreasuryPreparationError);
    assert.equal((await module.cancel("direct:cancel-before-effect")).state, "failed_terminal");
    assert.equal(journal.treasuryPolicyCapacityUsed(), 0n);

    wallet.probes.push(pending(wallet.transactionId));
    wallet.submitErrors = 1;
    const ambiguous = await module.execute({
      operationKey: "direct:cancel-after-preparation",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(ambiguous.state, "submission_planned");
    const cancelled = await module.cancel("direct:cancel-after-preparation");
    assert.equal(cancelled.cancellationRequested, true);
    assert.equal(cancelled.recoveryRequired, true);
    const fenced = await module.recover("direct:cancel-after-preparation");
    assert.equal(fenced.state, "submission_planned");
    assert.equal(wallet.submitCalls, 1);
  });
});

test("cancellation during preparation terminalizes only after proving no effect", async () => {
  await withFixture(async ({ module, journal, wallet }) => {
    let releasePreparation!: () => void;
    wallet.prepareGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const execution = module.execute({
      operationKey: "direct:cancel-during-preparation",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    for (let attempt = 0; attempt < 100 && wallet.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(wallet.prepareCalls, 1);
    const requested = await module.cancel("direct:cancel-during-preparation");
    assert.equal(requested.state, "intent");
    assert.equal(requested.cancellationRequested, true);
    releasePreparation();
    const prepared = await execution;
    assert.equal(prepared.state, "failed_terminal");
    assert.equal(prepared.cancellationRequested, true);
    assert.equal(prepared.safeToRetry, false);
    assert.equal(wallet.submitCalls, 0);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 0n);
    assert.equal((await module.recover("direct:cancel-during-preparation")).state, "failed_terminal");
  });
});

test("unknown preparation errors remain durably fenced and do not retry or release capacity", async () => {
  await withFixture(async ({ module, journal, wallet }) => {
    wallet.prepareErrors = 1;
    await assert.rejects(() => module.execute({
      operationKey: "direct:unknown-preparation",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    }), /injected prepare crash/);
    const fenced = journal.requireTreasuryOperation("direct:unknown-preparation");
    assert.equal(fenced.preparationFenced, true);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
    const recovered = await module.recover("direct:unknown-preparation");
    assert.equal(recovered.preparationFenced, true);
    assert.equal(wallet.prepareCalls, 1);
    assert.equal((await module.cancel("direct:unknown-preparation")).state, "intent");
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
  });
});

class FakeAdapter implements TreasuryOperationAdapter {
  readonly transactionId: string;
  prepareCalls = 0;
  submitCalls = 0;
  observeCalls = 0;
  commitCalls = 0;
  prepareErrors = 0;
  prepareGate?: Promise<void>;
  readonly typedPrepareErrors: TreasuryPreparationError[] = [];
  validationError?: TreasuryPreparationError;
  submitErrors = 0;
  commitErrors = 0;
  feeAtomic = "10";
  readonly probes: TreasuryOperationProbe[] = [];
  readonly submittedArtifacts: string[] = [];
  readonly submitEntered: Promise<void>;
  private resolveSubmitEntered!: () => void;
  private submitGate?: Promise<void>;
  private releaseSubmitGate?: () => void;
  onSubmit?: (intent: TreasuryOperationRecord) => void;
  onPrepare?: (intent: TreasuryOperationRecord) => void;

  constructor(readonly kind: TreasuryOperationKind, txByte: string) {
    this.transactionId = txByte.repeat(64);
    this.submitEntered = new Promise<void>((resolve) => {
      this.resolveSubmitEntered = resolve;
    });
  }

  setSubmitGate(): void {
    this.submitGate = new Promise<void>((resolve) => {
      this.releaseSubmitGate = resolve;
    });
  }

  releaseSubmit(): void {
    this.releaseSubmitGate?.();
    this.releaseSubmitGate = undefined;
  }

  validateRequest(): void {
    if (this.validationError) throw this.validationError;
  }

  async prepare(
    intent: TreasuryOperationRecord,
    authorize: (destination: string, amountAtomic: bigint) => void
  ): Promise<PreparedTreasuryOperationMaterial> {
    this.prepareCalls += 1;
    if (this.prepareGate) await this.prepareGate;
    const typedError = this.typedPrepareErrors.shift();
    if (typedError) throw typedError;
    if (this.prepareErrors-- > 0) throw new Error("injected prepare crash");
    this.onPrepare?.(intent);
    const amount = intent.requestedAmountAtomic === "max" ? 100n : BigInt(intent.requestedAmountAtomic);
    if (this.kind !== "vault_deposit") authorize(intent.destination, amount);
    return {
      bytes: Buffer.from(`immutable:${intent.operationKey}:${this.transactionId}`, "utf8"),
      transactionId: this.transactionId,
      amountAtomic: amount.toString(),
      feeAtomic: this.feeAtomic,
    };
  }

  async submit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<{ readonly transactionId: string }> {
    this.submitCalls += 1;
    this.onSubmit?.(intent);
    this.submittedArtifacts.push(Buffer.from(preparedBytes).toString("base64"));
    this.resolveSubmitEntered();
    if (this.submitGate) await this.submitGate;
    if (this.submitErrors-- > 0) throw new Error("injected ambiguous submission");
    return { transactionId: this.transactionId };
  }

  async observe(): Promise<TreasuryOperationProbe> {
    this.observeCalls += 1;
    return this.probes.shift() ?? pending(this.transactionId);
  }

  async commit(): Promise<void> {
    this.commitCalls += 1;
    if (this.commitErrors-- > 0) throw new Error("injected commit crash");
  }
}

function observed(transactionId: string): TreasuryOperationProbe {
  return {
    status: "observed",
    detail: {
      profile: "urn:sompi:treasury-operation:observation:1",
      status: "observed",
      transactionId,
    },
  };
}

function pending(transactionId: string): TreasuryOperationProbe {
  return { status: "pending", detail: { status: "pending", transactionId } };
}

function notSubmitted(transactionId: string): TreasuryOperationProbe {
  return { status: "not_submitted", detail: { status: "not_submitted", transactionId } };
}

async function withFixture(
  run: (fixture: {
    directory: string;
    journal: PurchaseJournal;
    policy: PolicyEngine;
    wallet: FakeAdapter;
    vault: FakeAdapter;
    deposit: FakeAdapter;
    module: TreasuryOperationModule;
    advanceTime(milliseconds: number): void;
  }) => Promise<void>,
  limits: {
    maxPerPaymentAtomic?: string;
    maxPerHourAtomic?: string;
    directTreasuryRetries?: number;
    purchaseAdditionalCostCeilingAtomic?: string;
  } = {}
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-treasury-operation-"));
  fs.chmodSync(directory, 0o700);
  let currentTime = NOW;
  const now = () => currentTime;
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now,
  });
  const policy = new PolicyEngine({
    maxSompiPerTx: BigInt(limits.maxPerPaymentAtomic ?? "1000"),
    maxSompiPerHour: BigInt(limits.maxPerHourAtomic ?? "10000"),
    allowlist: [DESTINATION],
  });
  const wallet = new FakeAdapter("wallet_send", "1");
  const vault = new FakeAdapter("vault_send", "2");
  const deposit = new FakeAdapter("vault_deposit", "3");
  const module = new TreasuryOperationModule({
    journal,
    policy,
    adapters: [wallet, vault, deposit],
    feeCeilingAtomic: "10",
    ...(limits.directTreasuryRetries === undefined
      ? {}
      : { directTreasuryRetries: limits.directTreasuryRetries }),
    purchase: purchaseOptions(
      now,
      limits.purchaseAdditionalCostCeilingAtomic,
    ),
  });
  try {
    await run({
      directory,
      journal,
      policy,
      wallet,
      vault,
      deposit,
      module,
      advanceTime(milliseconds: number) {
        currentTime += milliseconds;
      },
    });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function purchaseOptions(
  now: () => number,
  additionalCostCeilingAtomic = "10",
) {
  const unexpected = async (): Promise<never> => {
    throw new Error("test did not expect Purchase staging");
  };
  return {
    vault: {
      configured: true,
      config: () => ({ covenantId: "aa".repeat(32) }),
    },
    additionalCostCeilingAtomic,
    reservationTtlMs: 60_000,
    staging: {
      prepareStaging: unexpected,
      submitStaging: unexpected,
      observeStaging: unexpected,
    },
    stagingRecovery: {
      prepare: unexpected,
      observe: unexpected,
      submit: unexpected,
    },
    now,
  };
}

function authorizedPurchase(
  journal: PurchaseJournal,
  seed: number,
  amountAtomic: string
): PurchaseId {
  const id = createPurchaseId(new Uint8Array(16).fill(seed));
  const resource = { url: `https://merchant.example/resource/${seed}`, method: "GET" };
  const purchase = journal.createPurchase({
    id,
    requestKey: assertPurchaseRequestKey(`treasury:test:${seed}`),
    resourceUrl: resource.url,
    method: resource.method,
    resourceFingerprint: requestFingerprint(resource),
    expectedMerchantId: "merchant:test",
    expectedMerchantOrigin: "https://merchant.example",
  });
  const checkoutEvidence = verifiedEvidence(
    journal,
    id,
    `checkout-${seed}`,
    "checkout-terms",
    "merchant:test"
  );
  const requirements = verifiedEvidence(
    journal,
    id,
    `requirements-${seed}`,
    "payment-requirements",
    "merchant:test"
  );
  const executionPlan = journal.storeExecutionPlanEvidence(id, {
    mechanism: "single-transaction",
    profile: "kaspa-exact-v2:standard-native",
    requirementsDigest: requirements,
    maximumChargeAtomic: amountAtomic,
    settlementAssurance: "accepted",
  });
  journal.bindCheckoutTerms(id, {
    terms: {
      merchant: { id: "merchant:test", name: "Test", origin: "https://merchant.example" },
      resourceFingerprint: purchase.resourceFingerprint,
      amountAtomic,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: DESTINATION,
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest: checkoutEvidence,
    },
    checkoutEvidenceDigest: checkoutEvidence,
    checkoutVerificationProfile: "test-profile-v1",
    checkoutVerifierId: "test-verifier",
    paymentRequirementsDigest: requirements,
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
  });
  const requestDigest = evidenceDigest(authorizationRequestArtifact);
  const requestBodyDigest = evidenceDigest(new Uint8Array());
  verifiedEvidence(journal, id, authorizationRequestArtifact, "authorization-request");
  journal.storeEvidence(id, {
    bytes: new Uint8Array(),
    mediaType: "application/octet-stream",
    profile: "urn:sompi:purchase-request-body:1",
    kind: "purchase-request-body",
  });
  const nonceDigest = evidenceDigest(`nonce-${seed}`);
  const expiresAtMs = Date.parse("2099-01-01T00:00:00.000Z");
  journal.recordAuthorizationRequest(id, {
    checkoutDigest: checkoutEvidence,
    requestDigest,
    nonceDigest,
    requestMediaType: "",
    requestBodyDigest,
    additionalCostCeilingAtomic: "10",
    effectiveFinalityFloor: "accepted",
    expiresAtMs,
  });
  const storedAuthorizationRequest = journal.requireAuthorizationRequest(id);
  const authEvidence = verifiedEvidence(journal, id, `auth-${seed}`, "purchase-authorization");
  const terms = journal.requireCheckoutTerms(id);
  journal.recordAuthorizationDecision(id, {
    decision: "approved",
    authorityId: "authority:test",
    checkoutDigest: checkoutEvidence,
    approvedFactsDigest: authorizationFactsDigest({
      purchaseId: id,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      requestMediaType: "",
      requestBodyDigest,
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
    }),
    evidenceDigest: authEvidence,
    verificationProfile: "test-profile-v1",
    verifierId: "test-verifier",
    requestDigest,
    nonceDigest,
    expiresAtMs,
  });
  return id;
}

function purchaseCapacityInput(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  reservationId: string,
): ReservePurchaseCapacityInput {
  const terms = journal.requireCheckoutTerms(purchaseId);
  const authorization = journal.requireAuthorization(purchaseId);
  const authorizationRequest = journal.requireAuthorizationRequest(purchaseId);
  return {
    reservationId,
    purchaseId,
    fundingMode: "staged-payment",
    terms,
    termsExpiresAtMs: terms.expiresAtMs,
    authorizedAdditionalCostCeilingAtomic:
      authorizationRequest.additionalCostCeilingAtomic,
    authorization: {
      evidenceDigest: authorization.evidenceDigest,
      verificationProfile: authorization.verificationProfile,
      verifierId: authorization.verifierId,
      expiresAtMs: authorization.expiresAtMs,
    },
  };
}

function reservePurchase(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  policy: PolicySnapshotRecord,
  id: string,
  amountAtomic: string,
  additionalCostCeilingAtomic: string
): void {
  const authorization = journal.requireAuthorization(purchaseId);
  journal.reservePolicy({
    id,
    purchaseId,
    policyDigest: policy.digest,
    payee: DESTINATION,
    amountAtomic,
    additionalCostCeilingAtomic,
    fundingSource: "vault-treasury",
    expiresAtMs: NOW + 60_000,
    approvalEvidenceDigest: authorization.evidenceDigest,
    approvalVerificationProfile: authorization.verificationProfile,
    approvalVerifierId: authorization.verifierId,
  });
}

function verifiedEvidence(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  value: string,
  kind: string,
  issuer = "test-issuer"
): Sha256Digest {
  const artifact = journal.storeEvidence(purchaseId, {
    bytes: Buffer.from(value, "utf8"),
    mediaType: "application/octet-stream",
    profile: "test-profile-v1",
    issuer,
    kind,
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "test-verifier",
    profile: "test-profile-v1",
    detailDigest: evidenceDigest(`verified:${value}`),
  });
  return artifact.digest;
}
