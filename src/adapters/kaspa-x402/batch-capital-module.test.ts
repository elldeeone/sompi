import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PurchaseJournal } from "../../purchase/journal.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { TreasuryOperationView } from "../../treasury/operation-journal.js";
import type { TreasuryOperationRequest } from "../../treasury/operations.js";
import { KaspaX402BatchCapitalModule } from "./batch-capital-module.js";
import { SecureBatchChannelSigner } from "./batch-channel-signer.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const TXID = "55".repeat(32);

test("batch capitalization durably separates deposit from Purchase authorization", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-capital-"));
  const filename = path.join(directory, "purchase.sqlite");
  const journalOptions = {
    now: () => 1_800_000_000_000,
    preparedMaterialDirectory: path.join(directory, "prepared"),
  } as const;
  const journal = new PurchaseJournal(filename, journalOptions);
  let journalOpen = true;
  const calls: TreasuryOperationRequest[] = [];
  try {
    const signer = new SecureBatchChannelSigner(
      directory,
      () => 1_800_000_000_000,
      () => Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0),
    );
    const module = new KaspaX402BatchCapitalModule(
      journal,
      {
        execute: async (request) => {
          calls.push(request);
          return completed(journal, request);
        },
      },
      signer,
      undefined,
      () => 1_800_000_000_000,
    );
    const request = {
      operationKey: "demo-channel-1",
      origin: "https://merchant.example",
      resourceUrl: "https://merchant.example/batch",
      serverPublicKey: "22".repeat(32),
      payTo: ADDRESS,
      refundAddress: ADDRESS,
      refundTimeoutDaa: "500000000",
      amountAtomic: "1000000",
    } as const;

    const first = await module.openChannel(request);
    const second = await module.openChannel(request);
    assert.equal(first.state, "active");
    assert.equal(second.channelId, first.channelId);
    assert.equal(second.channel?.activeOutpoint.txid, TXID);
    assert.equal(journal.loadBatchChannels({ status: "active" }).length, 1);
    const movement = journal.requireBatchTreasuryMovement(`batch-deposit:${first.channelId}`);
    assert.equal(movement.state, "accepted");
    assert.equal(movement.purchaseId, undefined);
    assert.equal(calls.length, 2, "Treasury idempotency owns duplicate execute calls");
    assert.match(calls[0]!.operationKey, /^batch\.deposit\.[a-f0-9]{64}$/);
    await assert.rejects(
      module.openChannel({ ...request, serverPublicKey: "33".repeat(32) }),
      /operation binding/
    );
    assert.throws(() => module.topUpChannel(), /rotate to a separately funded channel/);
    journal.close();
    journalOpen = false;
    const restarted = new PurchaseJournal(filename, journalOptions);
    try {
      assert.equal(
        restarted.requireBatchTreasuryMovement(`batch-deposit:${first.channelId}`).evidenceDigest,
        movement.evidenceDigest,
      );
    } finally {
      restarted.close();
    }
  } finally {
    if (journalOpen) journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function completed(
  journal: PurchaseJournal,
  request: TreasuryOperationRequest,
): TreasuryOperationView {
  const policy = journal.installPolicy({
    maxPerPaymentAtomic: "10000000",
    maxPerHourAtomic: "10000000",
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
  const claimed = journal.claimTreasuryOperationDriver(
    request.operationKey,
    "batch-capital-test",
    60_000,
  );
  if (claimed.record.state !== "completed") {
    const lease = claimed.lease!;
    journal.recordPreparedTreasuryOperation(request.operationKey, {
      bytes: Buffer.from("batch-capital-test", "utf8"),
      transactionId: TXID,
      amountAtomic: request.amountAtomic as string,
      feeAtomic: "100",
      policyDigest: policy.digest,
    }, lease);
    journal.planTreasuryOperationSubmission(request.operationKey, lease);
    journal.claimTreasuryOperationEffectCapability(request.operationKey, lease);
    journal.recordTreasuryOperationSubmissionAccepted(request.operationKey, TXID, lease);
    journal.recordTreasuryOperationObservation(request.operationKey, "observed", {
      transactionId: TXID,
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
    amountAtomic: request.amountAtomic === "max" ? undefined : request.amountAtomic,
    feeAtomic: "100",
    transactionId: TXID,
    retryCount: 0,
    recoveryRequired: false,
    safeToRetry: false,
    cancellationRequested: false,
    preparationFenced: false,
  });
}
