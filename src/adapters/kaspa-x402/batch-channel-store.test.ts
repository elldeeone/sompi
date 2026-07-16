import * as assert from "node:assert/strict";
import test from "node:test";
import type { DirectModeChannel } from "@kaspa-x402/client";
import type { Hash32Hex, SignatureHex } from "@kaspa-x402/core";

import { evidenceDigest } from "../../purchase/identity.js";
import { PurchaseJournal } from "../../purchase/journal.js";
import { JournalBatchChannelStore } from "./batch-channel-store.js";

const HASH = "11".repeat(32) as Hash32Hex;
const CLIENT = "22".repeat(32) as Hash32Hex;
const SERVER = "33".repeat(32) as Hash32Hex;
const SALT = "44".repeat(32) as Hash32Hex;
const TXID = "55".repeat(32) as Hash32Hex;
const SIGNATURE = "66".repeat(64) as SignatureHex;

test("journal ChannelStore persists monotonic channel state without private keys", async () => {
  let now = 1_800_000_000_000;
  const journal = new PurchaseJournal(":memory:", { now: () => now });
  const store = new JournalBatchChannelStore(journal, () => now);
  try {
    const original = channel();
    await store.saveChannel({ ...original, clientPrivateKey: "77".repeat(32) });
    const [loaded] = await store.loadChannels({ origin: original.origin, status: "active" });
    assert.ok(loaded);
    assert.equal("clientPrivateKey" in loaded, false);
    assert.equal(JSON.stringify(journal.requireBatchChannel(HASH)).includes("77".repeat(32)), false);

    now += 1;
    const signed = {
      ...loaded,
      signedCumulativeAmount: "25",
      latestVoucher: { amount: "25", signature: SIGNATURE },
    };
    await store.saveChannel(signed);
    assert.equal(journal.requireBatchChannel(HASH).version, 2);
    assert.equal(journal.requireBatchChannel(HASH).signedCumulativeAtomic, "25");

    await assert.rejects(
      store.saveChannel({ ...loaded, signedCumulativeAmount: "20", latestVoucher: { amount: "20", signature: SIGNATURE } }),
      /moved backward/
    );
  } finally {
    journal.close();
  }
});

test("journal ChannelStore refuses an unverified continuation and keeps strict refund DAA", async () => {
  let now = 1_800_000_000_000;
  const journal = new PurchaseJournal(":memory:", { now: () => now });
  const store = new JournalBatchChannelStore(journal, () => now);
  try {
    await store.saveChannel(channel());
    const [active] = await store.loadChannels({});
    now += 1;
    await assert.rejects(
      store.saveChannel({
        ...active,
        activeOutpoint: { txid: "88".repeat(32) as Hash32Hex, index: 0 },
        fundingAmount: "900",
        claimedCumulativeAmount: "100",
        chargedCumulativeAmount: "100",
        signedCumulativeAmount: "0",
        latestVoucher: undefined,
      }),
      /verified lifecycle transition/,
    );
    assert.equal(journal.requireBatchChannel(HASH).epoch, 0);
    assert.deepEqual(await store.listRefundableChannels("500000000"), []);
    assert.equal((await store.listRefundableChannels("500000001")).length, 1);
  } finally {
    journal.close();
  }
});

test("journal ChannelStore refuses an SDK-supplied top-up successor", async () => {
  const journal = new PurchaseJournal(":memory:");
  const store = new JournalBatchChannelStore(journal);
  try {
    await store.saveChannel(channel());
    const [active] = await store.loadChannels({});
    await assert.rejects(
      store.saveChannel({
        ...active!,
        activeOutpoint: { txid: "aa".repeat(32) as Hash32Hex, index: 0 },
        fundingAmount: "1200",
      }),
      /verified lifecycle transition/,
    );
    assert.deepEqual(journal.requireBatchChannel(HASH).activeOutpoint, {
      txid: TXID,
      index: 0,
    });
  } finally {
    journal.close();
  }
});

test("protocol store absence cannot retire or delete a live refundable channel", async () => {
  const journal = new PurchaseJournal(":memory:");
  const store = new JournalBatchChannelStore(journal);
  try {
    await store.saveChannel(channel());
    await assert.rejects(
      store.retireChannel(HASH, "active outpoint not found"),
      /requires corroborated Chain Evidence/
    );
    await assert.rejects(
      store.deleteChannel(HASH),
      /requires corroborated Chain Evidence/
    );

    assert.equal(journal.requireBatchChannel(HASH).status, "active");
    assert.equal((await store.listRefundableChannels("500000001")).length, 1);
    assert.equal((await store.loadChannels({ status: "active" })).length, 1);
  } finally {
    journal.close();
  }
});

test("accepted batch Movements require mechanism-specific durable evidence", async () => {
  const journal = new PurchaseJournal(":memory:");
  const store = new JournalBatchChannelStore(journal);
  try {
    await store.saveChannel(channel());
    const movement = journal.planBatchTreasuryMovement({
      movementId: `batch-refund:${HASH}`,
      channelId: HASH,
      kind: "refund",
      requestDigest: evidenceDigest("batch-refund-without-evidence"),
      activeOutpointBefore: { txid: TXID, index: 0 },
    });
    assert.throws(
      () => journal.advanceBatchTreasuryMovement({
        movementId: movement.movementId,
        expectedState: "planned",
        state: "accepted",
        transactionId: "88".repeat(32),
      }),
      /durable verified evidence/,
    );
    assert.equal(journal.requireBatchTreasuryMovement(movement.movementId).state, "planned");
  } finally {
    journal.close();
  }
});

function channel(): DirectModeChannel {
  return {
    id: HASH,
    origin: "https://merchant.example",
    resourceUrl: "https://merchant.example/batch",
    config: {
      network: "kaspa:testnet-10",
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v1",
      clientPublicKey: CLIENT,
      serverPublicKey: SERVER,
      payTo: "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzquna3",
      refundAddress: "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzquna3",
      refundTimeoutDaa: "500000000",
      salt: SALT,
    },
    clientPublicKey: CLIENT,
    serverPublicKey: SERVER,
    activeOutpoint: { txid: TXID, index: 0 },
    activeScriptPublicKey: `000020${"99".repeat(32)}`,
    escrowAddress: "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzquna3",
    fundingSource: "vault-treasury",
    fundingAmount: "1000",
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedCumulativeAmount: "0",
    refundTimeoutDaa: "500000000",
    templateId: "kaspa-x402-escrow-v1",
    status: "active",
  };
}
