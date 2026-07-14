import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ExactTransactionPaymentRequest } from "@kaspa-x402/client";
import {
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import { PrivateKey, Transaction } from "../../kaspa-wasm.js";
import {
  assertPurchaseId,
  createPaymentIdentifier,
} from "../../purchase/identity.js";
import type { Sha256Digest } from "../../purchase/types.js";
import {
  ABANDONED_STAGING_RECOVERY_ENCODING,
  ABANDONED_STAGING_RECOVERY_FEE_POLICY,
  AbandonedStagingRecovery,
  decodeAbandonedStagingRecoveryEnvelope,
  type AbandonedStagingRecoveryEnvelope,
  type StagingRecoveryCandidateObservation,
  type StagingRecoveryExpectedCandidate,
  type StagingRecoveryOutpointObservation,
  type StagingRecoveryRaceEvidence,
  type StagingRecoveryRaceRequest,
} from "./abandoned-staging-recovery.js";
import { Kip10ExactTransactionBuilder } from "./exact-transaction-builder.js";
import { RpcStagingRecoveryTransactionSubmitter } from "./staging-recovery-rpc.js";
import { StagingKeyStore } from "./staging-key-store.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const STAGING_PRIVATE_KEY = "01".padStart(64, "0");
const RECOVERY_PRIVATE_KEY = "03".padStart(64, "0");
const OWNER_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const MERCHANT_ADDRESS =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const BORROW_TXID = "22".repeat(32);
const STAGING_TXID = "33".repeat(32);
const STAGING_AMOUNT = "32000000";
const RECOVERY_AMOUNT = "31000000";

test("preparation has a stable identity, canonical secret-free bytes, and exact value conservation", async () => {
  await withFixture(async (fixture) => {
    const first = await fixture.prepare();
    const repeated = await fixture.prepare();
    // Schnorr auxiliary randomness may change the signature bytes, while the
    // Kaspa transaction identity and every value-bearing fact remain stable.
    // The first returned bytes become immutable once the journal persists them.
    assert.equal(repeated.transactionId, first.transactionId);
    assert.equal(repeated.exactPaymentTransactionId, first.exactPaymentTransactionId);
    assert.equal(repeated.recoveryAmountAtomic, first.recoveryAmountAtomic);
    assert.equal(repeated.feeAtomic, first.feeAtomic);
    assert.match(first.transactionId, /^[a-f0-9]{64}$/);
    assert.equal(first.exactPaymentTransactionId, fixture.exact.transactionId);
    assert.equal(first.recoveryAmountAtomic, RECOVERY_AMOUNT);
    assert.equal(first.feeAtomic, ABANDONED_STAGING_RECOVERY_FEE_POLICY.feeAtomic);

    const text = Buffer.from(first.preparedBytes).toString("utf8");
    assert.equal(text.includes("privateKey"), false);
    assert.equal(text.includes(STAGING_PRIVATE_KEY), false);
    const envelope = decodeAbandonedStagingRecoveryEnvelope(first.preparedBytes);
    assert.equal(envelope.network, "kaspa:testnet-10");
    assert.equal(envelope.purchaseId, PURCHASE_ID);
    assert.equal(envelope.paymentIdentifier, PAYMENT_IDENTIFIER);
    assert.equal(envelope.keyReference, fixture.key.keyReference);
    assert.equal(envelope.staging.outpoint, `${STAGING_TXID}:1`);
    assert.equal(envelope.exactPayment?.transactionArtifactDigest, digest(fixture.exact.transaction));
    assert.equal(envelope.recovery.outputAddress, fixture.recoveryAddress);
    assert.equal(envelope.recovery.outputOutpoint, `${first.transactionId}:0`);
    assert.equal(envelope.recovery.outputAmountAtomic, RECOVERY_AMOUNT);
    assert.equal(envelope.recovery.feeAtomic, "1000000");

    const transaction = JSON.parse(envelope.recovery.transaction) as {
      id: string;
      inputs: Array<Record<string, unknown>>;
      outputs: Array<Record<string, unknown>>;
    };
    assert.equal(transaction.id, first.transactionId);
    assert.equal(transaction.inputs.length, 1);
    assert.equal(transaction.outputs.length, 1);
    assert.equal(transaction.inputs[0].transactionId, STAGING_TXID);
    assert.equal(transaction.inputs[0].index, 1);
    assert.equal((transaction.inputs[0].utxo as Record<string, unknown>).amount, STAGING_AMOUNT);
    assert.match(String(transaction.inputs[0].signatureScript), /^[a-f0-9]{132}$/);
    assert.deepEqual(transaction.outputs[0], {
      value: RECOVERY_AMOUNT,
      scriptPublicKey: envelope.recovery.outputScriptPublicKey,
      covenant: null,
    });

    assert.equal(
      (
        await fixture.prepare({
          expectedRecoveryTransactionId: first.transactionId,
        })
      ).transactionId,
      first.transactionId
    );
    await assert.rejects(
      fixture.prepare({ expectedRecoveryTransactionId: "99".repeat(32) }),
      /changed from its journalled identity/
    );
  });
});

test("typed no-exact-candidate recovery persists null, survives restart, and cannot be rebound", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare({
      exactPayment: { mode: "no_exact_candidate" },
    });
    assert.equal(prepared.exactPaymentTransactionId, undefined);
    const envelope = decode(prepared);
    assert.equal(envelope.exactPayment, null);

    fixture.observeWith((request) => {
      assert.equal(request.exactPayment, null);
      return safeEvidence(request);
    });
    const ready = await fixture.module.observe(prepared.preparedBytes);
    if (ready.status !== "safe_to_submit") throw new Error("expected readiness");
    assert.equal(ready.readiness.exactPaymentTransactionId, null);
    assert.equal(
      (await fixture.module.submit(prepared.preparedBytes, ready.readiness)).status,
      "accepted"
    );

    fixture.observeWith((request) => ({
      ...winnerEvidence(request, "recovery"),
      exactPayment: null,
    }));
    const restarted = fixture.newModule();
    const observed = await restarted.observe(prepared.preparedBytes);
    assert.equal(observed.status, "recovery_won");
    assert.equal(fixture.submissionCalls.length, 1);

    const parsed = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
    parsed.exactPayment = {
      transactionId: fixture.exact.transactionId,
    };
    await assert.rejects(
      restarted.observe(Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8")),
      /candidate|artifact|field|malformed/i
    );
  });
});

test("preparation rejects network, exact artifact, staging, key, and recovery-address substitutions", async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      fixture.prepare({
        staging: { ...fixture.staging, network: "kaspa:mainnet" as never },
      }),
      /only kaspa:testnet-10/
    );
    await assert.rejects(
      fixture.prepare({
        staging: { ...fixture.staging, amountAtomic: "032000000" },
      }),
      /canonical unsigned decimal/
    );
    await assert.rejects(
      fixture.prepare({
        staging: { ...fixture.staging, scriptPublicKey: `0000${"aa".repeat(34)}` },
      }),
      /address and script differ/
    );
    await assert.rejects(
      fixture.prepare({
        staging: { ...fixture.staging, keyReference: `stg_v1_${"A".repeat(43)}` },
      }),
      /unavailable or misbound/
    );
    await assert.rejects(
      fixture.prepare({
        exactPayment: {
          mode: "exact_candidate",
          candidate: { ...fixture.exact, transactionId: "44".repeat(32) },
        },
      }),
      /non-canonical or ID-mismatched/
    );
    await assert.rejects(
      fixture.prepare({
        exactPayment: {
          mode: "exact_candidate",
          candidate: { ...fixture.exact, merchantOutputIndex: 0 as never },
        },
      }),
      /output index must be 1/
    );
    assert.throws(
      () => fixture.newModule({ recoveryAddress: MERCHANT_ADDRESS.replace("kaspatest", "kaspa") }),
      /invalid for testnet-10/
    );
  });
});

test("submit requires one fresh observation proof and cross-checks the returned identity", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    const observed = await fixture.module.observe(prepared.preparedBytes);
    assert.equal(observed.status, "safe_to_submit");
    if (observed.status !== "safe_to_submit") throw new Error("expected readiness");

    await assert.rejects(
      fixture.module.submit(prepared.preparedBytes, undefined as never),
      /observation is required/
    );
    const accepted = await fixture.module.submit(prepared.preparedBytes, observed.readiness);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.transactionId, prepared.transactionId);
    assert.equal(fixture.submissionCalls.length, 1);
    assert.equal(fixture.submissionCalls[0].transaction, decode(prepared).recovery.transaction);
    assert.equal("privateKey" in fixture.submissionCalls[0], false);

    await assert.rejects(
      fixture.module.submit(prepared.preparedBytes, observed.readiness),
      /already consumed/
    );
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("readiness issued by another adapter instance cannot authorize recovery submission", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    const observed = await fixture.module.observe(prepared.preparedBytes);
    if (observed.status !== "safe_to_submit") throw new Error("expected readiness");

    const unobservedAdapter = fixture.newModule();
    await assert.rejects(
      unobservedAdapter.submit(prepared.preparedBytes, observed.readiness),
      /was not issued by this staging recovery observer/
    );
    assert.equal(fixture.submissionCalls.length, 0);

    const reobserved = await unobservedAdapter.observe(prepared.preparedBytes);
    if (reobserved.status !== "safe_to_submit") throw new Error("expected fresh readiness");
    const accepted = await unobservedAdapter.submit(
      prepared.preparedBytes,
      reobserved.readiness
    );
    assert.equal(accepted.status, "accepted");
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("ambiguous submit consumes readiness; a new proof is required before a proof-backed retry", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    fixture.submitWith(async () => {
      throw new Error("response lost after node acceptance");
    });
    const firstObservation = await fixture.module.observe(prepared.preparedBytes);
    if (firstObservation.status !== "safe_to_submit") throw new Error("expected readiness");
    const ambiguous = await fixture.module.submit(
      prepared.preparedBytes,
      firstObservation.readiness
    );
    assert.equal(ambiguous.status, "ambiguous");
    await assert.rejects(
      fixture.module.submit(prepared.preparedBytes, firstObservation.readiness),
      /already consumed/
    );

    fixture.nowMs += 1;
    fixture.submitWith(async (request) => ({ transactionId: request.transactionId }));
    const reconciled = await fixture.module.observe(prepared.preparedBytes);
    if (reconciled.status !== "safe_to_submit") throw new Error("expected proof-backed retry");
    assert.notEqual(reconciled.readiness.proofDigest, firstObservation.readiness.proofDigest);
    const accepted = await fixture.module.submit(prepared.preparedBytes, reconciled.readiness);
    assert.equal(accepted.status, "accepted");
    assert.equal(fixture.submissionCalls.length, 2);
  });
});

test("a same-millisecond observation cannot reissue a consumed readiness proof", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    fixture.submitWith(async () => {
      throw new Error("response lost after node acceptance");
    });
    const firstObservation = await fixture.module.observe(prepared.preparedBytes);
    if (firstObservation.status !== "safe_to_submit") throw new Error("expected readiness");
    assert.equal(
      (await fixture.module.submit(prepared.preparedBytes, firstObservation.readiness)).status,
      "ambiguous"
    );

    fixture.submitWith(async (request) => ({ transactionId: request.transactionId }));
    const secondObservation = await fixture.module.observe(prepared.preparedBytes);
    if (secondObservation.status !== "safe_to_submit") throw new Error("expected fresh readiness");
    assert.notEqual(
      secondObservation.readiness.proofDigest,
      firstObservation.readiness.proofDigest
    );
    await assert.rejects(
      fixture.module.submit(prepared.preparedBytes, firstObservation.readiness),
      /already consumed/
    );
    assert.equal(
      (await fixture.module.submit(prepared.preparedBytes, secondObservation.readiness)).status,
      "accepted"
    );
    assert.equal(fixture.submissionCalls.length, 2);
  });
});

test("a newer readiness supersedes every sibling proof for the same recovery", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    const firstObservation = await fixture.module.observe(prepared.preparedBytes);
    const secondObservation = await fixture.module.observe(prepared.preparedBytes);
    if (
      firstObservation.status !== "safe_to_submit" ||
      secondObservation.status !== "safe_to_submit"
    ) {
      throw new Error("expected readiness");
    }
    assert.notEqual(
      firstObservation.readiness.proofDigest,
      secondObservation.readiness.proofDigest
    );
    await assert.rejects(
      fixture.module.submit(prepared.preparedBytes, firstObservation.readiness),
      /already consumed/
    );
    assert.equal(
      (await fixture.module.submit(prepared.preparedBytes, secondObservation.readiness)).status,
      "accepted"
    );
    await assert.rejects(
      fixture.module.submit(prepared.preparedBytes, secondObservation.readiness),
      /already consumed/
    );
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("an observation started before submit cannot issue readiness after submit begins", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    const releaseObservations: Array<() => void> = [];
    fixture.observeWith(
      (request) => new Promise<StagingRecoveryRaceEvidence>((resolve) => {
        releaseObservations.push(() => resolve(safeEvidence(request)));
      })
    );
    const firstPending = fixture.module.observe(prepared.preparedBytes);
    const siblingPending = fixture.module.observe(prepared.preparedBytes);
    assert.equal(releaseObservations.length, 2);

    releaseObservations[0]();
    const firstObservation = await firstPending;
    if (firstObservation.status !== "safe_to_submit") throw new Error("expected readiness");

    let releaseSubmission!: () => void;
    fixture.submitWith(
      (request) => new Promise<{ transactionId: string }>((resolve) => {
        releaseSubmission = () => resolve({ transactionId: request.transactionId });
      })
    );
    const submitting = fixture.module.submit(
      prepared.preparedBytes,
      firstObservation.readiness
    );
    assert.equal(fixture.submissionCalls.length, 1);

    releaseObservations[1]();
    const staleSibling = await siblingPending;
    assert.equal(staleSibling.status, "pending");
    assert.equal("readiness" in staleSibling, false);

    releaseSubmission();
    assert.equal((await submitting).status, "accepted");
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("an observation started during submit cannot issue parallel readiness", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    const ready = await fixture.module.observe(prepared.preparedBytes);
    if (ready.status !== "safe_to_submit") throw new Error("expected readiness");

    let releaseSubmission!: () => void;
    fixture.submitWith(
      (request) => new Promise<{ transactionId: string }>((resolve) => {
        releaseSubmission = () => resolve({ transactionId: request.transactionId });
      })
    );
    const submitting = fixture.module.submit(prepared.preparedBytes, ready.readiness);
    assert.equal(fixture.submissionCalls.length, 1);

    let releaseObservation!: () => void;
    fixture.observeWith(
      (request) => new Promise<StagingRecoveryRaceEvidence>((resolve) => {
        releaseObservation = () => resolve(safeEvidence(request));
      })
    );
    const observingDuringSubmit = fixture.module.observe(prepared.preparedBytes);

    releaseSubmission();
    assert.equal((await submitting).status, "accepted");
    releaseObservation();
    const concurrent = await observingDuringSubmit;
    assert.equal(concurrent.status, "pending");
    assert.equal("readiness" in concurrent, false);
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("prepared artifact variants for one recovery share the submission fence", async () => {
  await withFixture(async (fixture) => {
    const exactPrepared = await fixture.prepare();
    const noExactPrepared = await fixture.prepare({
      exactPayment: { mode: "no_exact_candidate" },
    });
    assert.equal(noExactPrepared.transactionId, exactPrepared.transactionId);
    assert.notEqual(noExactPrepared.preparedDigest, exactPrepared.preparedDigest);

    fixture.observeWith((request) => safeEvidence(request));
    const ready = await fixture.module.observe(noExactPrepared.preparedBytes);
    if (ready.status !== "safe_to_submit") throw new Error("expected readiness");

    let releaseSubmission!: () => void;
    fixture.submitWith(
      (request) => new Promise<{ transactionId: string }>((resolve) => {
        releaseSubmission = () => resolve({ transactionId: request.transactionId });
      })
    );
    const submitting = fixture.module.submit(noExactPrepared.preparedBytes, ready.readiness);
    assert.equal(fixture.submissionCalls.length, 1);

    let releaseObservation!: () => void;
    fixture.observeWith(
      (request) => new Promise<StagingRecoveryRaceEvidence>((resolve) => {
        releaseObservation = () => resolve(safeEvidence(request));
      })
    );
    const aliasedObservation = fixture.module.observe(exactPrepared.preparedBytes);

    releaseSubmission();
    assert.equal((await submitting).status, "accepted");
    releaseObservation();
    const aliased = await aliasedObservation;
    assert.equal(aliased.status, "pending");
    assert.equal("readiness" in aliased, false);
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("accepted submission reconciles after a process crash without a second broadcast", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    const ready = await fixture.module.observe(prepared.preparedBytes);
    if (ready.status !== "safe_to_submit") throw new Error("expected readiness");
    assert.equal((await fixture.module.submit(prepared.preparedBytes, ready.readiness)).status, "accepted");
    assert.equal(fixture.submissionCalls.length, 1);

    // Simulate losing local post-submit state: a fresh adapter receives only
    // the journalled immutable bytes and queries both competing transactions.
    fixture.observeWith((request) => winnerEvidence(request, "recovery"));
    const restarted = fixture.newModule();
    const recovered = await restarted.observe(prepared.preparedBytes);
    assert.equal(recovered.status, "recovery_won");
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("staging recovery rejects a handle-free pending observer at its deadline", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith(() => new Promise<never>(() => undefined));
    const bounded = fixture.newModule({ operationTimeoutMs: 5 });
    await assert.rejects(
      bounded.observe(prepared.preparedBytes),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "deadline_exceeded"
    );
  });
});

test("cancellation or a contradictory node response after invocation is ambiguous or conflict, never retry permission", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => safeEvidence(request));
    const ready = await fixture.module.observe(prepared.preparedBytes);
    if (ready.status !== "safe_to_submit") throw new Error("expected readiness");
    fixture.submitWith(async () => ({ transactionId: "88".repeat(32) }));
    const mismatch = await fixture.module.submit(prepared.preparedBytes, ready.readiness);
    assert.equal(mismatch.status, "conflict");

    fixture.nowMs += 1;
    const secondReady = await fixture.module.observe(prepared.preparedBytes);
    if (secondReady.status !== "safe_to_submit") throw new Error("expected new readiness");
    let release!: () => void;
    fixture.submitWith(
      () => new Promise<{ transactionId: string }>((resolve) => {
        release = () => resolve({ transactionId: prepared.transactionId });
      })
    );
    const controller = new AbortController();
    const pending = fixture.module.submit(
      prepared.preparedBytes,
      secondReady.readiness,
      controller.signal
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("caller stopped waiting"));
    const cancelled = await pending;
    assert.equal(cancelled.status, "ambiguous");
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.submissionCalls.length, 2);
  });
});

test("an exact payment observed after ambiguous recovery submission wins without resubmission", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    let phase: "safe" | "exact" = "safe";
    fixture.observeWith((request) =>
      phase === "safe"
        ? safeEvidence(request)
        : winnerEvidence(request, "exactPayment")
    );
    fixture.submitWith(async () => {
      throw new Error("ambiguous");
    });
    const ready = await fixture.module.observe(prepared.preparedBytes);
    if (ready.status !== "safe_to_submit") throw new Error("expected readiness");
    assert.equal((await fixture.module.submit(prepared.preparedBytes, ready.readiness)).status, "ambiguous");
    phase = "exact";
    fixture.nowMs += 1;
    const winner = await fixture.module.observe(prepared.preparedBytes);
    assert.deepEqual(winner, {
      status: "conflict",
      reason: "exact_payment_won",
      winningTransactionId: fixture.exact.transactionId,
      winningFinality: "accepted",
      evidenceDigest: winner.evidenceDigest,
    });
    await assert.rejects(
      fixture.module.submit(prepared.preparedBytes, ready.readiness),
      /already consumed/
    );
    assert.equal(fixture.submissionCalls.length, 1);
  });
});

test("observation identifies the recovery winner only with its exact output facts", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => winnerEvidence(request, "recovery"));
    const winner = await fixture.module.observe(prepared.preparedBytes);
    assert.equal(winner.status, "recovery_won");
    if (winner.status !== "recovery_won") throw new Error("expected recovery winner");
    assert.equal(winner.transactionId, prepared.transactionId);
    assert.equal(winner.recoveryOutpoint, `${prepared.transactionId}:0`);
    assert.equal(winner.recoveryAmountAtomic, RECOVERY_AMOUNT);
    assert.equal(winner.finality, "accepted");
  });
});

test("a mempool candidate is an explicit provisional winner even while the accepted source UTXO remains", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith((request) => ({
      staging: safeEvidence(request).staging,
      exactPayment: absent("exact"),
      recovery: {
        ...observed(request.recovery, "recovery-mempool"),
        finality: "mempool",
      },
    }));
    const recovery = await fixture.module.observe(prepared.preparedBytes);
    assert.equal(recovery.status, "recovery_won");
    if (recovery.status !== "recovery_won") throw new Error("expected recovery winner");
    assert.equal(recovery.finality, "mempool");

    fixture.observeWith((request) => ({
      staging: safeEvidence(request).staging,
      exactPayment: {
        ...observed(request.exactPayment!, "exact-mempool"),
        finality: "mempool",
      },
      recovery: absent("recovery"),
    }));
    const exact = await fixture.module.observe(prepared.preparedBytes);
    assert.equal(exact.status, "conflict");
    if (exact.status !== "conflict") throw new Error("expected exact conflict");
    assert.equal(exact.reason, "exact_payment_won");
    assert.equal(exact.winningFinality, "mempool");
  });
});

test("both candidates, partial evidence, unknown spenders, and mismatched spenders fail closed", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    const cases: Array<{
      evidence: (request: StagingRecoveryRaceRequest) => StagingRecoveryRaceEvidence;
      reason: string;
    }> = [
      {
        evidence: (request) => ({
          staging: spent(undefined, "both"),
          exactPayment: observed(request.exactPayment!, "exact"),
          recovery: observed(request.recovery, "recovery"),
        }),
        reason: "both_candidates_observed",
      },
      {
        evidence: (request) => ({
          ...safeEvidence(request),
          exactPayment: { status: "partial", detailDigest: digest("partial") },
        }),
        reason: "partial_evidence",
      },
      {
        evidence: (request) => ({
          staging: spent(undefined, "unknown"),
          exactPayment: absent("exact"),
          recovery: absent("recovery"),
        }),
        reason: "unknown_staging_spender",
      },
      {
        evidence: (request) => ({
          staging: spent("77".repeat(32), "wrong"),
          exactPayment: observed(request.exactPayment!, "exact"),
          recovery: absent("recovery"),
        }),
        reason: "spending_transaction_mismatch",
      },
      {
        evidence: (request) => ({
          staging: safeEvidence(request).staging,
          exactPayment: observed(request.exactPayment!, "exact"),
          recovery: absent("recovery"),
        }),
        reason: "candidate_observed_while_staging_unspent",
      },
    ];
    for (const candidate of cases) {
      fixture.observeWith(candidate.evidence);
      const result = await fixture.module.observe(prepared.preparedBytes);
      assert.equal(result.status, "conflict");
      if (result.status !== "conflict") throw new Error("expected conflict");
      assert.equal(result.reason, candidate.reason);
    }
  });
});

test("unavailable race evidence stays pending and never produces submission readiness", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    fixture.observeWith(() => ({
      staging: { status: "unknown", detailDigest: digest("staging-unknown") },
      exactPayment: absent("exact"),
      recovery: absent("recovery"),
    }));
    const pending = await fixture.module.observe(prepared.preparedBytes);
    assert.equal(pending.status, "pending");
    assert.equal("readiness" in pending, false);
    assert.equal(fixture.submissionCalls.length, 0);
  });
});

test("prepared envelope and observed candidate tampering are rejected before effects", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    const envelope = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
    envelope.recovery.outputAmountAtomic = "29999999";
    const amountTamper = Buffer.from(`${JSON.stringify(envelope)}\n`);
    await assert.rejects(
      fixture.module.observe(amountTamper),
      /does not conserve value|output facts changed/
    );

    const transactionTamper = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
    const transaction = JSON.parse(transactionTamper.recovery.transaction);
    transaction.outputs[0].value = "29999999";
    transactionTamper.recovery.transaction = JSON.stringify(transaction);
    const bytes = Buffer.from(`${JSON.stringify(transactionTamper)}\n`);
    await assert.rejects(fixture.module.observe(bytes), /non-canonical or ID-mismatched/);

    fixture.observeWith((request) => ({
      ...winnerEvidence(request, "recovery"),
      recovery: {
        ...observed(request.recovery, "recovery"),
        outputAmountAtomic: "29999999",
      },
    }));
    const conflict = await fixture.module.observe(prepared.preparedBytes);
    assert.equal(conflict.status, "conflict");
    if (conflict.status !== "conflict") throw new Error("expected conflict");
    assert.equal(conflict.reason, "partial_evidence");
    assert.equal(fixture.submissionCalls.length, 0);
  });
});

test("RPC submitter rehydrates canonical bytes and cross-checks the node transaction ID", async () => {
  await withFixture(async (fixture) => {
    const prepared = await fixture.prepare();
    const envelope = decode(prepared);
    let submittedArtifact = "";
    const rpc = fakeRpc({
      entries: [],
      submitTransaction: async ({ transaction }: { transaction: Transaction }) => {
        submittedArtifact = transaction.serializeToSafeJSON();
        return { transactionId: envelope.recovery.transactionId };
      },
    });
    const submitter = new RpcStagingRecoveryTransactionSubmitter({
      rpc: { client: async () => rpc as never },
      now: () => NOW,
    });
    assert.deepEqual(
      await submitter.submitRecovery({
        network: "kaspa:testnet-10",
        transactionId: envelope.recovery.transactionId,
        transaction: envelope.recovery.transaction,
        transactionEncoding: ABANDONED_STAGING_RECOVERY_ENCODING,
        deadlineAtMs: NOW + 1_000,
        signal: new AbortController().signal,
      }),
      { transactionId: envelope.recovery.transactionId }
    );
    assert.equal(submittedArtifact, envelope.recovery.transaction);
  });
});

interface Fixture {
  root: string;
  store: StagingKeyStore;
  key: ReturnType<StagingKeyStore["create"]>;
  staging: {
    network: "kaspa:testnet-10";
    outpoint: { txid: string; index: number };
    amountAtomic: string;
    scriptPublicKey: string;
    address: string;
    blockDaaScore: string;
    keyReference: string;
    evidenceDigest: Sha256Digest;
  };
  exact: {
    transaction: string;
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
    transactionId: string;
    merchantOutputIndex: 1;
  };
  recoveryAddress: string;
  module: AbandonedStagingRecovery;
  nowMs: number;
  submissionCalls: Array<Record<string, unknown>>;
  prepare(overrides?: Record<string, unknown>): ReturnType<AbandonedStagingRecovery["prepare"]>;
  observeWith(
    observer: (
      request: StagingRecoveryRaceRequest
    ) => StagingRecoveryRaceEvidence | Promise<StagingRecoveryRaceEvidence>
  ): void;
  submitWith(
    submitter: (request: any) => Promise<{ transactionId: string }>
  ): void;
  newModule(overrides?: {
    recoveryAddress?: string;
    operationTimeoutMs?: number;
  }): AbandonedStagingRecovery;
}

async function withFixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-staging-recovery-"));
  try {
    const store = new StagingKeyStore({
      directory: path.join(root, "keys"),
      now: () => NOW,
      generatePrivateKey: () => STAGING_PRIVATE_KEY,
    });
    const key = store.create({ purchaseId: PURCHASE_ID, paymentIdentifier: PAYMENT_IDENTIFIER });
    const staging = {
      network: "kaspa:testnet-10" as const,
      outpoint: { txid: STAGING_TXID, index: 1 },
      amountAtomic: STAGING_AMOUNT,
      scriptPublicKey: key.scriptPublicKey,
      address: key.address,
      blockDaaScore: "123",
      keyReference: key.keyReference,
      evidenceDigest: digest("journal-verified-staging"),
    };
    const borrowRedeemScript = buildKip10AdditiveRedeemScript({
      ownerPublicKey: OWNER_PUBLIC_KEY,
      amount: "10000000",
    }).toLowerCase();
    const borrowScriptPublicKey = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({
        ownerPublicKey: OWNER_PUBLIC_KEY,
        amount: "10000000",
      })
    ).toLowerCase();
    const request: ExactTransactionPaymentRequest = {
      network: "kaspa:testnet-10",
      amount: "20000000",
      payTo: MERCHANT_ADDRESS,
      requestHash: "44".repeat(32),
      requiredFinality: "accepted",
      fundingSource: "vault-treasury",
      reservation: {
        templateId: "kaspa-x402-kip10-additive-v1",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        borrowOutpoint: { txid: BORROW_TXID, index: 0 },
        borrowAmount: "100000000",
        borrowScriptPublicKey,
        borrowRedeemScript,
        additiveThresholdSompi: "10000000",
        paymentOutputIndex: 1,
        reservationId: "55".repeat(32),
        reservationExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    const exactBuilder = new Kip10ExactTransactionBuilder({ keyStore: store, now: () => NOW });
    const exactBuilt = await exactBuilder.build({
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      request,
      staging: {
        outpoint: staging.outpoint,
        amountAtomic: staging.amountAtomic,
        scriptPublicKey: staging.scriptPublicKey,
        address: staging.address,
        blockDaaScore: staging.blockDaaScore,
        keyReference: staging.keyReference,
      },
      additionalCostCeilingAtomic: "12050000",
      stagingTransactionFeeAtomic: "50000",
    });
    const exact = {
      transaction: exactBuilt.transaction,
      transactionEncoding: exactBuilt.transactionEncoding,
      transactionId: exactBuilt.transactionId,
      merchantOutputIndex: 1 as const,
    };
    const recoveryAddress = addressForPrivateKey(RECOVERY_PRIVATE_KEY);
    let observer: (
      race: StagingRecoveryRaceRequest
    ) => StagingRecoveryRaceEvidence | Promise<StagingRecoveryRaceEvidence> =
      (race) => safeEvidence(race);
    let submitter = async (submission: any) => ({ transactionId: submission.transactionId as string });
    const submissionCalls: Array<Record<string, unknown>> = [];
    const fixture = {
      root,
      store,
      key,
      staging,
      exact,
      recoveryAddress,
      nowMs: NOW,
      submissionCalls,
      observeWith(next: typeof observer) {
        observer = next;
      },
      submitWith(next: typeof submitter) {
        submitter = next;
      },
      newModule(overrides: {
        recoveryAddress?: string;
        operationTimeoutMs?: number;
      } = {}) {
        return new AbandonedStagingRecovery({
          keyStore: store,
          recoveryAddress: overrides.recoveryAddress ?? recoveryAddress,
          observer: { observeRace: async (race) => observer(race) },
          submitter: {
            submitRecovery: async (submission) => {
              submissionCalls.push({ ...submission });
              return submitter(submission);
            },
          },
          ...(overrides.operationTimeoutMs === undefined
            ? {}
            : { operationTimeoutMs: overrides.operationTimeoutMs }),
          now: () => fixture.nowMs,
        });
      },
      prepare(overrides: Record<string, unknown> = {}) {
        return fixture.module.prepare({
          purchaseId: PURCHASE_ID,
          paymentIdentifier: PAYMENT_IDENTIFIER,
          staging,
          exactPayment: { mode: "exact_candidate", candidate: exact },
          ...overrides,
        } as never);
      },
    } as Fixture;
    fixture.module = fixture.newModule();
    await action(fixture);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function safeEvidence(request: StagingRecoveryRaceRequest): StagingRecoveryRaceEvidence {
  return {
    staging: {
      status: "unspent",
      outpoint: request.staging.outpoint,
      amountAtomic: request.staging.amountAtomic,
      scriptPublicKey: request.staging.scriptPublicKey,
      blockDaaScore: request.staging.blockDaaScore,
      detailDigest: digest("staging-unspent"),
    },
    exactPayment: request.exactPayment === null ? null : absent("exact-absent"),
    recovery: absent("recovery-absent"),
  };
}

function winnerEvidence(
  request: StagingRecoveryRaceRequest,
  winner: "exactPayment" | "recovery"
): StagingRecoveryRaceEvidence {
  const expected = request[winner];
  if (expected === null) throw new Error("exact candidate is unavailable");
  return {
    staging: spent(expected.transactionId, `${winner}-spent`),
    exactPayment:
      winner === "exactPayment" ? observed(request.exactPayment!, "exact") : absent("exact"),
    recovery:
      winner === "recovery" ? observed(request.recovery, "recovery") : absent("recovery"),
  };
}

function absent(label: string): StagingRecoveryCandidateObservation {
  return { status: "absent", detailDigest: digest(label) };
}

function observed(
  expected: Readonly<StagingRecoveryExpectedCandidate>,
  label: string
): StagingRecoveryCandidateObservation {
  return {
    status: "observed",
    transactionId: expected.transactionId,
    inputOutpoint: expected.inputOutpoint,
    outputOutpoint: expected.outputOutpoint,
    outputAmountAtomic: expected.outputAmountAtomic,
    outputScriptPublicKey: expected.outputScriptPublicKey,
    finality: "accepted",
    detailDigest: digest(label),
  };
}

function spent(
  transactionId: string | undefined,
  label: string
): StagingRecoveryOutpointObservation {
  return {
    status: "spent",
    ...(transactionId === undefined ? {} : { spendingTransactionId: transactionId }),
    detailDigest: digest(label),
  };
}

function decode(prepared: Awaited<ReturnType<Fixture["prepare"]>>): Readonly<AbandonedStagingRecoveryEnvelope> {
  return decodeAbandonedStagingRecoveryEnvelope(prepared.preparedBytes);
}

function fakeRpc(options: {
  entries: unknown[];
  getMempoolEntry?: (request: any) => Promise<any>;
  submitTransaction?: (request: any) => Promise<any>;
}): Record<string, unknown> {
  return {
    getServerInfo: async () => ({
      isSynced: true,
      hasUtxoIndex: true,
      networkId: "testnet-10",
      virtualDaaScore: 1_000n,
    }),
    getUtxosByAddresses: async () => ({ entries: options.entries }),
    getMempoolEntry:
      options.getMempoolEntry ??
      (async () => {
        throw new Error("transaction not found");
      }),
    submitTransaction:
      options.submitTransaction ??
      (async () => {
        throw new Error("submit disabled");
      }),
  };
}

function addressForPrivateKey(privateKeyHex: string): string {
  const privateKey = new PrivateKey(privateKeyHex);
  const address = privateKey.toAddress("testnet-10");
  try {
    return address.toString();
  } finally {
    address.free();
    privateKey.free();
  }
}

function digest(value: string | Uint8Array): Sha256Digest {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}` as Sha256Digest;
}
