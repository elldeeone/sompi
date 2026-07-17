import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ChainEvidenceModule } from "../../chain-evidence/module.js";
import { CHAIN_EVIDENCE_PROFILE, type ChainEvidenceRecord } from "../../chain-evidence/types.js";
import { evidenceDigest } from "../../purchase/identity.js";
import { PurchaseJournal, type JournalFaultPoint } from "../../purchase/journal.js";
import type { TreasuryOperationRecord } from "../../treasury/operation-journal.js";
import type {
  TreasuryOperationRequest,
  TreasuryOperationView,
} from "../../treasury/operations.js";
import type { KaspaWallet } from "../../wallet.js";
import { KaspaX402BatchCapitalModule } from "./batch-capital-module.js";
import { SecureBatchChannelSigner } from "./batch-channel-signer.js";
import {
  BatchRefundTreasuryOperationAdapter,
  KaspaX402BatchRefundModule,
} from "./batch-refund.js";
import type { BatchClaimRaceSource } from "./batch-race-source.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const DEPOSIT_TXID = "55".repeat(32);

test("batch refund is prepared from public alpha.8 covenant primitives only after strict DAA unlock", async () => {
  const fixture = await channelFixture();
  try {
    const movementId = `batch-refund:${fixture.channelId}`;
    fixture.journal.planBatchTreasuryMovement({
      movementId,
      channelId: fixture.channelId,
      kind: "refund",
      requestDigest: evidenceDigest("batch-refund-test"),
      activeOutpointBefore: { txid: DEPOSIT_TXID, index: 0 },
    });
    const submitted: string[] = [];
    const wallet = {
      networkId: "testnet-10",
      client: async () => ({
        submitTransaction: async ({ transaction }: { transaction: { finalize(): string } }) => {
          const transactionId = String(transaction.finalize()).toLowerCase();
          submitted.push(transactionId);
          return { transactionId };
        },
      }),
    } as unknown as KaspaWallet;
    const adapter = new BatchRefundTreasuryOperationAdapter(
      fixture.journal,
      wallet,
      { getVirtualDaaScore: async () => "500000001", getUtxos: async () => [] },
      fixture.signer,
      {} as ChainEvidenceModule,
      "accepted",
      "100000",
      unspentRace(),
    );
    const intent = refundIntent(fixture.channelId);
    const prepared = await adapter.prepare(intent);
    assert.equal(prepared.amountAtomic, "1000000");
    assert.equal(prepared.feeAtomic, "100000");
    assert.match(prepared.transactionId, /^[a-f0-9]{64}$/);
    assert.equal((await adapter.submit(intent, prepared.bytes)).transactionId, prepared.transactionId);
    assert.deepEqual(submitted, [prepared.transactionId]);
    assert.equal(fixture.journal.requireBatchTreasuryMovement(movementId).state, "submitted");

    const locked = new BatchRefundTreasuryOperationAdapter(
      fixture.journal,
      wallet,
      { getVirtualDaaScore: async () => "500000000", getUtxos: async () => [] },
      fixture.signer,
      {} as ChainEvidenceModule,
      "accepted",
      "100000",
      unspentRace(),
    );
    await assert.rejects(locked.prepare(intent), /not independently unlocked/);

    const uncorroborated = new BatchRefundTreasuryOperationAdapter(
      fixture.journal,
      wallet,
      { getVirtualDaaScore: async () => "500000001", getUtxos: async () => [] },
      fixture.signer,
      {} as ChainEvidenceModule,
      "accepted",
      "100000",
      {
        getVirtualDaaScore: async () => "500000000",
        observeClaimWinner: async () => ({
          status: "unknown" as const,
          detailDigest: evidenceDigest("not-observed"),
        }),
      },
    );
    await assert.rejects(uncorroborated.prepare(intent), /not independently unlocked/);

    const refundEvidence = evidenceDigest("accepted-refund");
    recordAcceptedEvidence(fixture.journal, prepared.transactionId, refundEvidence);
    await adapter.commit(intent, prepared.bytes, {
      transactionId: prepared.transactionId,
      chainEvidenceDigest: refundEvidence,
    });
    assert.equal(fixture.journal.requireBatchTreasuryMovement(movementId).state, "accepted");
    assert.equal(fixture.journal.requireBatchChannel(fixture.channelId).status, "refunded");
  } finally {
    fixture.close();
  }
});

test("accepted merchant claim atomically advances the channel and supersedes a competing refund", async () => {
  const fixture = await channelFixture();
  try {
    const current = fixture.journal.requireBatchChannel(fixture.channelId);
    fixture.journal.saveBatchChannel({
      ...current,
      chargedCumulativeAtomic: "100000",
      signedCumulativeAtomic: "250000",
      latestVoucher: { amountAtomic: "250000", signature: "11".repeat(64) },
      version: current.version + 1,
      updatedAtMs: current.updatedAtMs,
    });
    const movementId = `batch-refund:${fixture.channelId}`;
    fixture.journal.planBatchTreasuryMovement({
      movementId,
      channelId: fixture.channelId,
      kind: "refund",
      requestDigest: evidenceDigest("batch-refund-race"),
      activeOutpointBefore: { txid: DEPOSIT_TXID, index: 0 },
    });
    const wallet = {
      networkId: "testnet-10",
      client: async () => ({ submitTransaction: async () => { throw new Error("not used"); } }),
    } as unknown as KaspaWallet;
    const claimTransactionId = "66".repeat(32);
    const claimEvidence = evidenceDigest("accepted-claim");
    recordAcceptedEvidence(fixture.journal, claimTransactionId, claimEvidence);
    const adapter = new BatchRefundTreasuryOperationAdapter(
      fixture.journal,
      wallet,
      { getVirtualDaaScore: async () => "500000001", getUtxos: async () => [] },
      fixture.signer,
      { observe: async () => ({
        status: "unavailable",
        detailDigest: evidenceDigest("refund-not-observed"),
      }) } as unknown as ChainEvidenceModule,
      "accepted",
      "100000",
      {
        getVirtualDaaScore: async () => "500000001",
        observeClaimWinner: async () => ({
          status: "claim",
          transactionId: claimTransactionId,
          finality: "accepted",
          continuationOutpoint: { txid: claimTransactionId, index: 1 },
          continuationScriptPublicKey: current.activeScriptPublicKey,
          continuationFundingAmountAtomic: "900000",
          detailDigest: claimEvidence,
        }),
      },
    );
    const requested = refundIntent(fixture.channelId);
    const capacityBeforeRefund = fixture.journal.treasuryPolicyCapacityUsed();
    const policy = fixture.journal.installPolicy({
      maxPerPaymentAtomic: "10000000",
      maxPerHourAtomic: "10000000",
      approvalAboveAtomic: "0",
      allowlist: [ADDRESS],
    });
    let intent = fixture.journal.claimTreasuryOperationIntent({
      operationKey: requested.operationKey,
      requestDigest: requested.requestDigest,
      kind: requested.kind,
      destination: requested.destination,
      requestedAmountAtomic: requested.requestedAmountAtomic,
      feeCeilingAtomic: requested.feeCeilingAtomic,
      retryLimit: requested.retryLimit,
      policyDigest: policy.digest,
    });
    const driver = fixture.journal.claimTreasuryOperationDriver(
      intent.operationKey,
      "batch-refund-race-test",
      60_000,
    ).lease!;
    const prepared = await adapter.prepare(intent);
    intent = fixture.journal.recordPreparedTreasuryOperation(intent.operationKey, {
      ...prepared,
      policyDigest: policy.digest,
    }, driver);
    assert.equal(fixture.journal.planTreasuryOperationSubmission(intent.operationKey, driver), true);
    assert.equal(fixture.journal.claimTreasuryOperationEffectCapability(intent.operationKey, driver), true);
    intent = fixture.journal.requireTreasuryOperation(intent.operationKey);
    const observed = await adapter.observe(intent, prepared.bytes);
    assert.equal(observed.status, "superseded");
    assert.equal(observed.detail.winningTransactionId, claimTransactionId);
    const channel = fixture.journal.requireBatchChannel(fixture.channelId);
    assert.deepEqual(channel.activeOutpoint, { txid: claimTransactionId, index: 1 });
    assert.equal(channel.fundingAmountAtomic, "900000");
    assert.equal(channel.chargedCumulativeAtomic, "100000");
    assert.equal(channel.claimedCumulativeAtomic, "100000");
    assert.equal(channel.signedCumulativeAtomic, "0");
    assert.equal(channel.latestVoucher, undefined);
    assert.equal(fixture.journal.requireBatchTreasuryMovement(movementId).state, "failed_terminal");
    assert.equal(fixture.journal.requireTreasuryOperation(intent.operationKey).state, "failed_terminal");
    assert.equal(fixture.journal.treasuryPolicyCapacityUsed(), capacityBeforeRefund);
    const claimMovement = fixture.journal.requireBatchTreasuryMovement(
      `batch-claim:${fixture.channelId}:${claimTransactionId}:1`,
    );
    assert.equal(claimMovement.state, "accepted");

    // TreasuryOperationModule records the adapter observation after the
    // adapter's atomic Journal transition. That second write must be an exact
    // idempotent replay, not a conflicting terminal-state transition.
    assert.equal(
      fixture.journal.recordTreasuryOperationObservation(
        intent.operationKey,
        "superseded",
        observed.detail,
        driver,
      ).state,
      "failed_terminal",
    );

    const replayed = await adapter.observe(intent, prepared.bytes);
    assert.equal(replayed.status, "superseded");
    assert.equal(replayed.detail.winningTransactionId, claimTransactionId);
    assert.deepEqual(
      fixture.journal.requireBatchChannel(fixture.channelId).activeOutpoint,
      { txid: claimTransactionId, index: 1 },
    );
  } finally {
    fixture.close();
  }
});

test("a crash during claim adoption rolls back channel, Movement, recovery, and Treasury state", async () => {
  let inject = false;
  const fixture = await channelFixture({
    faultInjector(point) {
      if (inject && point === "batch_channel.after_update") {
        throw new Error("injected batch claim adoption crash");
      }
    },
  });
  try {
    const race = await preparedClaimRace(fixture);
    const channelBefore = fixture.journal.requireBatchChannel(fixture.channelId);
    const movementBefore = fixture.journal.requireBatchTreasuryMovement(race.movementId);
    const operationBefore = fixture.journal.requireTreasuryOperation(race.intent.operationKey);
    const capacityBefore = fixture.journal.treasuryPolicyCapacityUsed();

    inject = true;
    await assert.rejects(
      race.adapter.observe(race.intent, race.prepared.bytes),
      /injected batch claim adoption crash/,
    );
    inject = false;

    assert.deepEqual(fixture.journal.requireBatchChannel(fixture.channelId), channelBefore);
    assert.deepEqual(fixture.journal.requireBatchTreasuryMovement(race.movementId), movementBefore);
    assert.deepEqual(fixture.journal.requireTreasuryOperation(race.intent.operationKey), operationBefore);
    assert.equal(fixture.journal.treasuryPolicyCapacityUsed(), capacityBefore);
    assert.equal(fixture.journal.loadBatchRaceRecovery({
      channelId: fixture.channelId,
      sourceOutpoint: channelBefore.activeOutpoint,
      refundTransactionId: race.prepared.transactionId,
    }), undefined);
    assert.throws(
      () => fixture.journal.requireBatchTreasuryMovement(
        `batch-claim:${fixture.channelId}:${race.claimTransactionId}:1`,
      ),
      /does not exist/,
    );

    const recovered = await race.adapter.observe(race.intent, race.prepared.bytes);
    assert.equal(recovered.status, "superseded");
    assert.deepEqual(
      fixture.journal.requireBatchChannel(fixture.channelId).activeOutpoint,
      { txid: race.claimTransactionId, index: 1 },
    );
    assert.equal(
      fixture.journal.requireTreasuryOperation(race.intent.operationKey).state,
      "failed_terminal",
    );
  } finally {
    fixture.close();
  }
});

test("batch refund module persists a non-Purchase Movement before Treasury execution", async () => {
  const fixture = await channelFixture();
  const calls: unknown[] = [];
  try {
    const module = new KaspaX402BatchRefundModule(fixture.journal, {
      execute: async (request) => {
        calls.push(request);
        return pendingView(request.operationKey, request.destination, request.amountAtomic as string);
      },
    });
    const view = await module.refund(fixture.channelId);
    assert.equal(view.state, "prepared");
    const movement = fixture.journal.requireBatchTreasuryMovement(`batch-refund:${fixture.channelId}`);
    assert.equal(movement.kind, "refund");
    assert.equal(movement.purchaseId, undefined);
    assert.equal(calls.length, 1);
  } finally {
    fixture.close();
  }
});

async function channelFixture(options: Readonly<{
  faultInjector?: (point: JournalFaultPoint) => void;
}> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-refund-"));
  const journal = new PurchaseJournal(":memory:", {
    now: () => 1_800_000_000_000,
    preparedMaterialDirectory: path.join(directory, "prepared"),
    operatorManifestIdentity: {
      revision: 1,
      digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  const signer = new SecureBatchChannelSigner(
    directory,
    () => 1_800_000_000_000,
    () => Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0),
  );
  const capital = new KaspaX402BatchCapitalModule(journal, {
    execute: async (request) => completedTreasury(journal, request, DEPOSIT_TXID),
  }, signer, undefined, () => 1_800_000_000_000);
  const result = await capital.openChannel({
    operationKey: "refund-fixture",
    origin: "https://merchant.example",
    resourceUrl: "https://merchant.example/batch",
    serverPublicKey: "22".repeat(32),
    payTo: ADDRESS,
    refundAddress: ADDRESS,
    refundTimeoutDaa: "500000000",
    amountAtomic: "1000000",
  });
  return {
    journal,
    signer,
    channelId: result.channelId,
    close() {
      journal.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function preparedClaimRace(
  fixture: Awaited<ReturnType<typeof channelFixture>>,
) {
  const current = fixture.journal.requireBatchChannel(fixture.channelId);
  fixture.journal.saveBatchChannel({
    ...current,
    chargedCumulativeAtomic: "0",
    signedCumulativeAtomic: "200000",
    latestVoucher: { amountAtomic: "200000", signature: "11".repeat(64) },
    version: current.version + 1,
    updatedAtMs: current.updatedAtMs,
  });
  const movementId = `batch-refund:${fixture.channelId}`;
  fixture.journal.planBatchTreasuryMovement({
    movementId,
    channelId: fixture.channelId,
    kind: "refund",
    requestDigest: evidenceDigest("batch-refund-race-crash"),
    activeOutpointBefore: { txid: DEPOSIT_TXID, index: 0 },
  });
  const claimTransactionId = "66".repeat(32);
  const claimEvidence = evidenceDigest("accepted-claim-crash");
  recordAcceptedEvidence(fixture.journal, claimTransactionId, claimEvidence);
  const adapter = new BatchRefundTreasuryOperationAdapter(
    fixture.journal,
    {
      networkId: "testnet-10",
      client: async () => ({ submitTransaction: async () => { throw new Error("not used"); } }),
    } as unknown as KaspaWallet,
    { getVirtualDaaScore: async () => "500000001", getUtxos: async () => [] },
    fixture.signer,
    { observe: async () => ({
      status: "unavailable",
      detailDigest: evidenceDigest("refund-not-observed-crash"),
    }) } as unknown as ChainEvidenceModule,
    "accepted",
    "100000",
    {
      getVirtualDaaScore: async () => "500000001",
      observeClaimWinner: async () => ({
        status: "claim" as const,
        transactionId: claimTransactionId,
        finality: "accepted" as const,
        continuationOutpoint: { txid: claimTransactionId, index: 1 },
        continuationScriptPublicKey: current.activeScriptPublicKey,
        continuationFundingAmountAtomic: "800000",
        detailDigest: claimEvidence,
      }),
    },
  );
  const requested = refundIntent(fixture.channelId);
  const policy = fixture.journal.installPolicy({
    maxPerPaymentAtomic: "10000000",
    maxPerHourAtomic: "10000000",
    approvalAboveAtomic: "0",
    allowlist: [ADDRESS],
  });
  let intent = fixture.journal.claimTreasuryOperationIntent({
    operationKey: requested.operationKey,
    requestDigest: requested.requestDigest,
    kind: requested.kind,
    destination: requested.destination,
    requestedAmountAtomic: requested.requestedAmountAtomic,
    feeCeilingAtomic: requested.feeCeilingAtomic,
    retryLimit: requested.retryLimit,
    policyDigest: policy.digest,
  });
  const driver = fixture.journal.claimTreasuryOperationDriver(
    intent.operationKey,
    "batch-refund-race-crash-test",
    60_000,
  ).lease!;
  const prepared = await adapter.prepare(intent);
  intent = fixture.journal.recordPreparedTreasuryOperation(intent.operationKey, {
    ...prepared,
    policyDigest: policy.digest,
  }, driver);
  assert.equal(fixture.journal.planTreasuryOperationSubmission(intent.operationKey, driver), true);
  assert.equal(fixture.journal.claimTreasuryOperationEffectCapability(intent.operationKey, driver), true);
  return Object.freeze({
    adapter,
    claimTransactionId,
    driver,
    intent: fixture.journal.requireTreasuryOperation(intent.operationKey),
    movementId,
    prepared,
  });
}

function completedTreasury(
  journal: PurchaseJournal,
  request: TreasuryOperationRequest,
  transactionId: string,
): TreasuryOperationView {
  const policy = journal.installPolicy({
    maxPerPaymentAtomic: "10000000",
    maxPerHourAtomic: "10000000",
    approvalAboveAtomic: "0",
    allowlist: [request.destination],
  });
  journal.claimTreasuryOperationIntent({
    operationKey: request.operationKey,
    requestDigest: evidenceDigest(JSON.stringify(request)),
    kind: request.kind,
    destination: request.destination,
    requestedAmountAtomic: request.amountAtomic,
    feeCeilingAtomic: "1000",
    retryLimit: 1,
    policyDigest: policy.digest,
  });
  const claim = journal.claimTreasuryOperationDriver(
    request.operationKey,
    "batch-refund-test",
    60_000,
  );
  if (claim.record.state !== "completed") {
    const lease = claim.lease!;
    journal.recordPreparedTreasuryOperation(request.operationKey, {
      bytes: Buffer.from("batch-refund-deposit", "utf8"),
      transactionId,
      amountAtomic: request.amountAtomic as string,
      feeAtomic: "100",
      policyDigest: policy.digest,
    }, lease);
    journal.planTreasuryOperationSubmission(request.operationKey, lease);
    journal.claimTreasuryOperationEffectCapability(request.operationKey, lease);
    journal.recordTreasuryOperationSubmissionAccepted(request.operationKey, transactionId, lease);
    journal.recordTreasuryOperationObservation(request.operationKey, "observed", {
      transactionId,
      amountAtomic: request.amountAtomic,
      feeAtomic: "100",
      finality: "accepted",
    }, lease, "accepted");
    journal.completeTreasuryOperation(request.operationKey, lease);
    journal.releaseTreasuryOperationDriver(lease, request.operationKey);
  }
  return Object.freeze({
    operationKey: request.operationKey,
    kind: request.kind,
    state: "completed",
    summary: "completed",
    destination: request.destination,
    requestedAmountAtomic: request.amountAtomic,
    feeCeilingAtomic: "1000",
    amountAtomic: request.amountAtomic as string,
    feeAtomic: "100",
    transactionId,
    retryCount: 0,
    recoveryRequired: false,
    safeToRetry: false,
    cancellationRequested: false,
    preparationFenced: false,
  });
}

function recordAcceptedEvidence(
  journal: PurchaseJournal,
  transactionId: string,
  detailDigest: ReturnType<typeof evidenceDigest>,
): void {
  const record: ChainEvidenceRecord = {
    profile: CHAIN_EVIDENCE_PROFILE,
    operationId: `recovery:${transactionId}`,
    operation: "recovery-release",
    transactionId,
    status: "present",
    level: "accepted",
    view: "historical",
    mechanism: "native-covenant",
    protocolFinality: "accepted",
    operatorFloor: "accepted",
    effectiveFloor: "accepted",
    primaryProfile: "test-primary",
    witnessProfile: "test-witness",
    blockHash: "77".repeat(32),
    acceptingBlockHash: "88".repeat(32),
    acceptingBlockDaaScore: "500000001",
    virtualDaaScore: "500000002",
    outputsDigest: evidenceDigest(`outputs:${transactionId}`),
    detailDigest,
    observedAtMs: 1_800_000_000_000,
  };
  journal.recordChainEvidence(record);
}

function refundIntent(channelId: string): TreasuryOperationRecord {
  return Object.freeze({
    operationKey: `batch.refund.${channelId}`,
    requestDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    kind: "batch_refund",
    destination: ADDRESS,
    requestedAmountAtomic: "1000000",
    feeCeilingAtomic: "100000",
    retryLimit: 3,
    cancellationRequested: false,
    preparationFenced: false,
    driverGeneration: 0,
    submissionInFlight: false,
    policyDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    state: "intent",
    retryCount: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
}

function pendingView(operationKey: string, destination: string, amount: string): TreasuryOperationView {
  return Object.freeze({
    operationKey,
    kind: "batch_refund",
    state: "prepared",
    summary: "prepared",
    destination,
    requestedAmountAtomic: amount,
    feeCeilingAtomic: "100000",
    amountAtomic: amount,
    feeAtomic: "100000",
    retryCount: 0,
    recoveryRequired: false,
    safeToRetry: true,
    cancellationRequested: false,
    preparationFenced: false,
  });
}

function unspentRace(): BatchClaimRaceSource {
  return {
    getVirtualDaaScore: async () => "500000001",
    observeClaimWinner: async () => ({
      status: "unspent",
      detailDigest: evidenceDigest("active-channel-unspent"),
    }),
  };
}
