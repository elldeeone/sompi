import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type {
  BatchCommitmentRecord,
  ClaimAttemptRecord,
  ExactHeadRecord,
  ExactPaymentRecord,
  ExactSettlementAttemptRecord,
  PaymentIdentifierRecord,
  ServerChannelRecord,
} from "@kaspa-x402/server";
import {
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import { KaspaTestnet10AddressCodec } from "../adapters/kaspa-x402/address-codec.js";
import { SqliteMerchantServerStateStore } from "./merchant-server-store.js";

const T0 = "2030-01-01T00:00:00.000Z";
const T1 = "2030-01-01T00:00:01.000Z";
const T2 = "2030-01-01T00:00:02.000Z";
const OWNER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const HEAD_ID = "11".repeat(32);
const HEAD_TXID = "22".repeat(32);
const PAYMENT_TXID = "33".repeat(32);

test("unanswered additive offers are read-only and one conflicting settlement wins", async () => {
  await withStore(async (store) => {
    const head = headRecord();
    assert.deepEqual(await store.registerExactHead(head), head);
    const selection = {
      network: "kaspa:testnet-10" as const,
      amount: "20000000",
      payTo: head.payTo,
      payToScriptPublicKey: head.scriptPublicKey,
      minimumAdditiveThresholdSompi: "10000000",
      selectionKey: "44".repeat(32),
    };
    for (let index = 0; index < 1_000; index += 1) {
      assert.deepEqual(await store.selectExactHead(selection), head);
    }
    assert.deepEqual(await store.loadExactHead(HEAD_ID), head);

    const attempt = additiveAttempt();
    assert.equal((await store.claimExactSettlement(attempt)).created, true);
    assert.equal((await store.claimExactSettlement(attempt)).created, false);
    const conflictingTransactionId = "55".repeat(32);
    await assert.rejects(
      store.claimExactSettlement({
        ...attempt,
        transactionId: conflictingTransactionId,
        head: {
          ...attempt.head!,
          successor: {
            ...attempt.head!.successor,
            outpoint: { txid: conflictingTransactionId, index: 0 },
          },
        },
      }),
      /conflict/
    );
    assert.equal((await store.loadExactHead(HEAD_ID))?.status, "claimed");
  });
});

test("accepted additive settlement atomically advances the head and persists handler result", async () => {
  await withStore(async (store) => {
    await store.registerExactHead(headRecord());
    const attempt = additiveAttempt();
    await store.claimExactSettlement(attempt);
    await store.recordExactSettlementBroadcast(PAYMENT_TXID, "accepted", T1);
    await store.acceptExactSettlement(PAYMENT_TXID, "accepted", T1);

    const head = await store.loadExactHead(HEAD_ID);
    assert.equal(head?.status, "available");
    assert.equal(head?.version, "1");
    assert.deepEqual(head?.currentOutpoint, { txid: PAYMENT_TXID, index: 0 });
    assert.equal(head?.currentAmount, "120000000");

    assert.equal(await store.beginExactHandler(PAYMENT_TXID, T1), true);
    assert.equal(await store.beginExactHandler(PAYMENT_TXID, T1), false);
    await store.markExactHandlerRecoveryRequired(PAYMENT_TXID, "worker restarted", T1);
    await store.recordExactHandlerResult(PAYMENT_TXID, { status: 200, body: "resource" }, T2);
    assert.equal((await store.loadExactSettlementAttempt(PAYMENT_TXID))?.recoveryReason, undefined);

    const payment = paymentRecord();
    await store.commitExactPayment({ payment });
    await store.commitExactPayment({ payment });
    assert.deepEqual(await store.loadExactPayment(PAYMENT_TXID), payment);
    assert.equal(store.exactPaymentCount(), 1);
    assert.equal(store.integrityCheck(), true);
  });
});

test("snapshot-guarded unavailability cannot overwrite a newer head", async () => {
  await withStore(async (store) => {
    await store.registerExactHead(headRecord());
    const stale = {
      headId: HEAD_ID,
      expectedVersion: "0",
      expectedOutpoint: { txid: HEAD_TXID, index: 0 },
      expectedAmount: "100000000",
      expectedStatus: "available" as const,
      reason: "unknown lineage",
      observedAt: T1,
    };
    assert.equal((await store.markExactHeadUnavailable(stale)).applied, true);
    assert.equal((await store.markExactHeadUnavailable(stale)).applied, false);
  });
});

test("batch settlement and claim attempts persist atomically across restart", async () => {
  await withStore(async (store) => {
    const original = batchChannel();
    await store.saveChannel(original);
    const next = {
      ...original,
      chargedCumulativeAmount: "200000",
      signedMaxClaimable: "200000",
      voucherSignature: "99".repeat(64),
    } satisfies ServerChannelRecord;
    const settlement = {
      success: true,
      transaction: "aa".repeat(32),
      network: "kaspa:testnet-10",
      amount: "200000",
    } as const;
    const commitment = {
      commitmentId: "aa".repeat(32),
      channelId: original.channelId,
      requestFingerprint: "bb".repeat(32),
      paymentRequirementsHash: "cc".repeat(32),
      activeOutpoint: original.activeOutpoint,
      activeScriptPublicKey: original.activeScriptPublicKey,
      voucher: { amount: "200000", signature: "99".repeat(64) },
      chargedAmount: "200000",
      chargedCumulativeBefore: "0",
      chargedCumulativeAfter: "200000",
      claimedCumulativeAmount: "0",
      settlement,
      response: { status: 200, headers: {}, body: "resource" },
    } satisfies BatchCommitmentRecord;
    const identifier = {
      id: "pay_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".slice(0, 47),
      fingerprint: commitment.requestFingerprint,
      paymentPayloadHash: "dd".repeat(32),
      response: commitment.response,
      settlement,
      paymentScopeId: original.channelId,
      channelId: original.channelId,
    } satisfies PaymentIdentifierRecord;
    await store.commitSettlement({
      channel: next,
      commitment,
      paymentIdentifier: identifier,
      expected: {
        channelId: original.channelId,
        chargedCumulativeAmount: "0",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "0",
        activeOutpoint: original.activeOutpoint,
        activeScriptPublicKey: original.activeScriptPublicKey,
        status: "active",
      },
    });
    assert.deepEqual(await store.loadChannel(original.channelId), next);
    assert.deepEqual(await store.loadCommitment(commitment.commitmentId), commitment);
    assert.deepEqual(await store.loadPaymentIdentifier(identifier.id), identifier);

    const claim = batchClaimAttempt(next);
    await store.saveClaimAttempt(claim);
    await store.saveClaimAttempt({
      ...claim,
      status: "broadcast",
      transactionId: "ee".repeat(32),
      finality: "broadcast",
    });
    const accepted = {
      ...claim,
      status: "accepted" as const,
      transactionId: "ee".repeat(32),
      finality: "accepted" as const,
    };
    await store.saveClaimAttempt(accepted);
    const { voucherSignature: _voucherSignature, ...claimedChannel } = next;
    const continued = {
      ...claimedChannel,
      activeOutpoint: { txid: "ee".repeat(32), index: 1 },
      fundingAmount: "800000",
      claimedCumulativeAmount: "200000",
      signedMaxClaimable: "0",
    } satisfies ServerChannelRecord;
    await store.applyClaimAttempt(continued, accepted);
    assert.deepEqual(await store.loadChannel(original.channelId), continued);
    assert.equal(await store.loadOpenClaimAttempt(original.channelId), undefined);
    assert.equal(store.integrityCheck(), true);
  });
});

test("first batch settlement atomically creates an absent channel and commitment", async () => {
  await withStore(async (store) => {
    const initial = batchChannel();
    const channel = {
      ...initial,
      chargedCumulativeAmount: "12",
      signedMaxClaimable: "20",
      voucherSignature: "99".repeat(64),
    } satisfies ServerChannelRecord;
    const settlement = {
      success: true,
      transaction: "aa".repeat(32),
      network: "kaspa:testnet-10",
      amount: "12",
    } as const;
    const commitment = {
      commitmentId: "aa".repeat(32),
      channelId: channel.channelId,
      requestFingerprint: "bb".repeat(32),
      paymentRequirementsHash: "cc".repeat(32),
      activeOutpoint: channel.activeOutpoint,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      voucher: { amount: "20", signature: channel.voucherSignature },
      chargedAmount: "12",
      chargedCumulativeBefore: "0",
      chargedCumulativeAfter: "12",
      claimedCumulativeAmount: "0",
      settlement,
      response: { status: 200, headers: {}, body: "resource" },
    } satisfies BatchCommitmentRecord;

    await store.commitSettlement({
      channel,
      commitment,
      expected: {
        channelId: channel.channelId,
        chargedCumulativeAmount: "0",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "0",
        activeOutpoint: channel.activeOutpoint,
        activeScriptPublicKey: channel.activeScriptPublicKey,
        status: "active",
      },
    });
    await store.commitSettlement({
      channel,
      commitment,
      expected: {
        channelId: channel.channelId,
        chargedCumulativeAmount: "0",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "0",
        activeOutpoint: channel.activeOutpoint,
        activeScriptPublicKey: channel.activeScriptPublicKey,
        status: "active",
      },
    });

    assert.deepEqual(await store.loadChannel(channel.channelId), channel);
    assert.deepEqual(await store.loadCommitment(commitment.commitmentId), commitment);
    assert.equal(store.integrityCheck(), true);
  });
});

test("a broadcast batch claim cannot be abandoned or replaced", async () => {
  await withStore(async (store) => {
    const channel = batchChannel();
    await store.saveChannel(channel);
    const attempt = batchClaimAttempt(channel);
    await store.saveClaimAttempt(attempt);
    await assert.rejects(
      store.abandonClaimAttempt(attempt.attemptId, "operator retry"),
      /conflict/,
    );
    assert.deepEqual(await store.loadOpenClaimAttempt(channel.channelId), attempt);
    const broadcast = {
      ...attempt,
      status: "broadcast" as const,
      transactionId: "ee".repeat(32),
      finality: "broadcast" as const,
    };
    await store.saveClaimAttempt(broadcast);

    await assert.rejects(
      store.abandonClaimAttempt(attempt.attemptId, "operator retry"),
      /conflict/,
    );
    assert.deepEqual(await store.loadOpenClaimAttempt(channel.channelId), broadcast);
    await assert.rejects(
      store.saveClaimAttempt({ ...attempt, attemptId: "ff".repeat(32) }),
      /conflict/,
    );
  });
});

async function withStore(action: (store: SqliteMerchantServerStateStore) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-exact-store-"));
  const filename = path.join(root, "state.sqlite");
  try {
    const store = new SqliteMerchantServerStateStore(filename);
    try {
      await action(store);
    } finally {
      store.close();
    }
    const restarted = new SqliteMerchantServerStateStore(filename);
    try { assert.equal(restarted.integrityCheck(), true); } finally { restarted.close(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function headRecord(): ExactHeadRecord {
  const redeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey: OWNER,
    amount: "10000000",
  }).toLowerCase();
  const scriptPublicKey = serializedScriptPublicKey(
    kip10AdditiveScriptPublicKey({ ownerPublicKey: OWNER, amount: "10000000" })
  ).toLowerCase();
  const payTo = new KaspaTestnet10AddressCodec().encodeScriptAddress({
    network: "kaspa:testnet-10",
    scriptPublicKey: { version: 0, script: scriptPublicKey.slice(4) },
    serializedScriptPublicKey: scriptPublicKey,
  });
  return {
    headId: HEAD_ID,
    network: "kaspa:testnet-10",
    payTo,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: HEAD_TXID, index: 0 },
    currentAmount: "100000000",
    scriptPublicKey,
    redeemScript,
    additiveThresholdSompi: "10000000",
    version: "0",
    status: "available",
    createdAt: T0,
    updatedAt: T0,
  };
}

function batchChannel(): ServerChannelRecord {
  return {
    channelId: "ab".repeat(32),
    channelConfig: {
      network: "kaspa:testnet-10",
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v1",
      clientPublicKey: "12".repeat(32),
      serverPublicKey: "34".repeat(32),
      payTo: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
      refundAddress: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
      refundTimeoutDaa: "500000000",
      salt: "56".repeat(32),
    },
    escrowAddress: "kaspatest:ppq5m55gc5zys729p6vfypu7aty45e05jk5p2cmhwrk8pgj7u3y2kzwfg9y26",
    activeOutpoint: { txid: "78".repeat(32), index: 0 },
    activeScriptPublicKey: `0000${"aa".repeat(34)}`,
    fundingAmount: "1000000",
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    status: "active",
  };
}

function batchClaimAttempt(channel: ServerChannelRecord): ClaimAttemptRecord {
  return {
    attemptId: "ef".repeat(32),
    channelId: channel.channelId,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    claimAmount: "200000",
    chargedCumulativeAmount: channel.chargedCumulativeAmount,
    claimedCumulativeAmount: channel.claimedCumulativeAmount,
    signedMaxClaimable: channel.signedMaxClaimable,
    ...(channel.voucherSignature ? { voucherSignature: channel.voucherSignature } : {}),
    channelStatus: channel.status,
    transaction: JSON.stringify({ claim: true }),
    continuationOutpoint: { txid: "ee".repeat(32), index: 1 },
    continuationScriptPublicKey: channel.activeScriptPublicKey,
    continuationFundingAmount: "800000",
    status: "pending",
  };
}

function additiveAttempt(): ExactSettlementAttemptRecord {
  const head = headRecord();
  return {
    transactionId: PAYMENT_TXID,
    profile: "additive",
    amount: "20000000",
    paymentOutputIndex: 0,
    requestFingerprint: "66".repeat(32),
    paymentRequirementsHash: "77".repeat(32),
    paymentPayloadHash: "88".repeat(32),
    requestAuthorizationId: "99".repeat(32),
    payToScriptPublicKey: head.scriptPublicKey,
    transaction: JSON.stringify({ id: PAYMENT_TXID }),
    requiredFinality: "accepted",
    status: "pending",
    createdAt: T0,
    updatedAt: T0,
    head: {
      headId: HEAD_ID,
      expectedVersion: "0",
      expectedOutpoint: { txid: HEAD_TXID, index: 0 },
      expectedAmount: "100000000",
      successor: {
        outpoint: { txid: PAYMENT_TXID, index: 0 },
        amount: "120000000",
        scriptPublicKey: head.scriptPublicKey,
      },
    },
  };
}

function paymentRecord(): ExactPaymentRecord {
  return {
    profile: "additive",
    transactionId: PAYMENT_TXID,
    paymentOutputIndex: 0,
    requestFingerprint: "66".repeat(32),
    paymentRequirementsHash: "77".repeat(32),
    paymentPayloadHash: "88".repeat(32),
    requestAuthorizationId: "99".repeat(32),
    amount: "20000000",
    finality: "accepted",
    settlement: {
      success: true,
      transaction: PAYMENT_TXID,
      network: "kaspa:testnet-10",
      amount: "20000000",
      extra: {
        paymentOutputIndex: 0,
        finality: "accepted",
        exactProfile: "additive",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        requestHash: "aa".repeat(32),
        templateId: "kaspa-x402-kip10-additive-v1",
        headId: HEAD_ID,
      },
    },
    response: { status: 200, headers: {}, body: "resource" },
  };
}
