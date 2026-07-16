import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PurchaseJournal } from "../../purchase/journal.js";
import type { TreasuryOperationRequest, TreasuryOperationView } from "../../treasury/operations.js";
import { KaspaX402BatchCapitalModule } from "./batch-capital-module.js";
import { SecureBatchChannelSigner } from "./batch-channel-signer.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const TXID = "55".repeat(32);

test("batch capitalization durably separates deposit from Purchase authorization", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-capital-"));
  const journal = new PurchaseJournal(":memory:", { now: () => 1_800_000_000_000 });
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
          return completed(request);
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
    assert.throws(() => module.topUpChannel(), /rotate to a separately funded channel/);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function completed(request: TreasuryOperationRequest): TreasuryOperationView {
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
