import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ChainEvidenceModule } from "../../chain-evidence/module.js";
import { evidenceDigest } from "../../purchase/identity.js";
import { PurchaseJournal } from "../../purchase/journal.js";
import type { TreasuryOperationRecord } from "../../treasury/operation-journal.js";
import type { TreasuryOperationView } from "../../treasury/operations.js";
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

    await adapter.commit(intent, prepared.bytes, {
      transactionId: prepared.transactionId,
      chainEvidenceDigest: evidenceDigest("accepted-refund"),
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
      requestDigest: evidenceDigest("batch-refund-race"),
      activeOutpointBefore: { txid: DEPOSIT_TXID, index: 0 },
    });
    const wallet = {
      networkId: "testnet-10",
      client: async () => ({ submitTransaction: async () => { throw new Error("not used"); } }),
    } as unknown as KaspaWallet;
    const claimTransactionId = "66".repeat(32);
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
          continuationFundingAmountAtomic: "800000",
          detailDigest: evidenceDigest("accepted-claim"),
        }),
      },
    );
    const intent = refundIntent(fixture.channelId);
    const prepared = await adapter.prepare(intent);
    const observed = await adapter.observe(intent, prepared.bytes);
    assert.equal(observed.status, "superseded");
    assert.equal(observed.detail.winningTransactionId, claimTransactionId);
    const channel = fixture.journal.requireBatchChannel(fixture.channelId);
    assert.deepEqual(channel.activeOutpoint, { txid: claimTransactionId, index: 1 });
    assert.equal(channel.fundingAmountAtomic, "800000");
    assert.equal(channel.chargedCumulativeAtomic, "200000");
    assert.equal(channel.claimedCumulativeAtomic, "200000");
    assert.equal(channel.signedCumulativeAtomic, "0");
    assert.equal(channel.latestVoucher, undefined);
    assert.equal(fixture.journal.requireBatchTreasuryMovement(movementId).state, "failed_terminal");
    const claimMovement = fixture.journal.requireBatchTreasuryMovement(
      `batch-claim:${fixture.channelId}:${claimTransactionId}:1`,
    );
    assert.equal(claimMovement.state, "accepted");
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

async function channelFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-refund-"));
  const journal = new PurchaseJournal(":memory:", { now: () => 1_800_000_000_000 });
  const signer = new SecureBatchChannelSigner(
    directory,
    () => 1_800_000_000_000,
    () => Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0),
  );
  const capital = new KaspaX402BatchCapitalModule(journal, {
    execute: async (request) => ({
      operationKey: request.operationKey,
      kind: request.kind,
      state: "completed",
      summary: "completed",
      destination: request.destination,
      requestedAmountAtomic: request.amountAtomic,
      feeCeilingAtomic: "1000",
      amountAtomic: request.amountAtomic as string,
      feeAtomic: "100",
      transactionId: DEPOSIT_TXID,
      retryCount: 0,
      recoveryRequired: false,
      safeToRetry: false,
      cancellationRequested: false,
      preparationFenced: false,
    }),
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
