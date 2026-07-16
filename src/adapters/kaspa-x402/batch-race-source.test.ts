import * as assert from "node:assert/strict";
import test from "node:test";

import type { ChainEvidenceModule } from "../../chain-evidence/module.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { BatchChannelJournalRecord } from "../../purchase/journal.js";
import { HttpsBatchClaimRaceSource } from "./batch-race-source.js";

const ACTIVE_TXID = "55".repeat(32);
const CLAIM_TXID = "66".repeat(32);
const SCRIPT = `0000${"aa".repeat(34)}`;
const ESCROW = "kaspatest:pppppppppppppppppppppppppppppppppppppppppppppppppppppppp6r49vl";
const PAY_TO = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";

test("batch claim-race source discovers a spender but trusts it only after exact shape and Chain Evidence", async () => {
  let evidenceCalls = 0;
  const source = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    {
      observe: async (request: any) => {
        evidenceCalls += 1;
        assert.equal(request.transactionId, CLAIM_TXID);
        assert.deepEqual(request.expectedInputs, [{ transactionId: ACTIVE_TXID, index: 0 }]);
        assert.equal(request.expectedOutputs[1].amountAtomic, "800000");
        assert.equal(request.expectedOutputs[1].scriptPublicKey, SCRIPT);
        return {
          status: "present",
          level: "accepted",
          detailDigest: evidenceDigest("accepted-claim"),
        };
      },
    } as unknown as ChainEvidenceModule,
    "accepted",
    async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(JSON.stringify([claimTransaction()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const observed = await source.observeClaimWinner({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  });
  assert.equal(observed.status, "claim");
  if (observed.status !== "claim") return;
  assert.equal(observed.transactionId, CLAIM_TXID);
  assert.deepEqual(observed.continuationOutpoint, { txid: CLAIM_TXID, index: 1 });
  assert.equal(observed.continuationFundingAmountAtomic, "800000");
  assert.equal(evidenceCalls, 1);
});

test("an unspent active channel avoids history lookup and an invalid spender fails closed", async () => {
  let fetchCalls = 0;
  const live = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    {
      getVirtualDaaScore: async () => "1",
      getUtxos: async () => [{
        outpoint: { txid: ACTIVE_TXID, index: 0 },
        amount: "1000000",
        scriptPublicKey: SCRIPT,
        address: ESCROW,
      }],
    },
    {} as ChainEvidenceModule,
    "accepted",
    async () => { fetchCalls += 1; return new Response("[]"); },
  );
  assert.equal((await live.observeClaimWinner({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  })).status, "unspent");
  assert.equal(fetchCalls, 0);

  const malformed = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    { observe: async () => { throw new Error("must not corroborate malformed candidate"); } } as unknown as ChainEvidenceModule,
    "accepted",
    async () => new Response(JSON.stringify([{ ...claimTransaction(), version: 0 }]), { status: 200 }),
  );
  assert.equal((await malformed.observeClaimWinner({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  })).status, "unknown");
});

test("an accepted claim may reconcile the highest disclosed voucher before response acknowledgement", async () => {
  const pendingAcknowledgement = {
    ...channel(),
    chargedCumulativeAtomic: "0",
    signedCumulativeAtomic: "200000",
  };
  let evidenceCalls = 0;
  const source = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    {
      observe: async () => {
        evidenceCalls += 1;
        return {
          status: "present",
          level: "accepted",
          detailDigest: evidenceDigest("accepted-unacknowledged-claim"),
        };
      },
    } as unknown as ChainEvidenceModule,
    "accepted",
    async () => new Response(JSON.stringify([claimTransaction()]), { status: 200 }),
  );
  const result = await source.observeClaimWinner({
    channel: pendingAcknowledgement,
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "claim");
  assert.equal(evidenceCalls, 1);
});

test("claim history is streamed under a hard byte ceiling", async () => {
  const source = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    {} as ChainEvidenceModule,
    "accepted",
    async () => new Response("[" + " ".repeat(4 * 1024 * 1024) + "]", { status: 200 }),
  );
  await assert.rejects(source.observeClaimWinner({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  }), /oversized/);
});

test("batch refund DAA is independently read from the bounded witness", async () => {
  const source = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    {} as ChainEvidenceModule,
    "accepted",
    async (input) => {
      assert.equal(String(input), "https://history.example/info/blockdag");
      return new Response('{"virtualDaaScore":"500000001"}', { status: 200 });
    },
  );
  assert.equal(
    await source.getVirtualDaaScore(new AbortController().signal),
    "500000001",
  );
});

function claimTransaction(): Record<string, unknown> {
  return {
    transaction_id: CLAIM_TXID,
    version: 1,
    subnetwork_id: "00".repeat(20),
    payload: null,
    is_accepted: true,
    inputs: [{
      previous_outpoint_hash: ACTIVE_TXID,
      previous_outpoint_index: "0",
    }],
    outputs: [
      {
        transaction_id: CLAIM_TXID,
        index: 0,
        amount: "100000",
        script_public_key: "20" + "11".repeat(33) + "ac",
        script_public_key_address: PAY_TO,
      },
      {
        transaction_id: CLAIM_TXID,
        index: 1,
        amount: "800000",
        script_public_key: SCRIPT.slice(4),
        script_public_key_address: ESCROW,
      },
    ],
  };
}

function channel(): BatchChannelJournalRecord {
  return Object.freeze({
    channelId: "44".repeat(32),
    origin: "https://merchant.example",
    resourceUrl: "https://merchant.example/batch",
    network: "kaspa:testnet-10",
    asset: "KAS",
    templateId: "kaspa-x402-escrow-v1",
    clientPublicKey: "11".repeat(32),
    serverPublicKey: "22".repeat(32),
    payTo: PAY_TO,
    refundAddress: PAY_TO,
    refundTimeoutDaa: "500000000",
    salt: "33".repeat(32),
    activeOutpoint: { txid: ACTIVE_TXID, index: 0 },
    activeScriptPublicKey: SCRIPT,
    escrowAddress: ESCROW,
    fundingSource: "vault-treasury",
    fundingAmountAtomic: "1000000",
    chargedCumulativeAtomic: "200000",
    claimedCumulativeAtomic: "0",
    signedCumulativeAtomic: "200000",
    latestVoucher: { amountAtomic: "200000", signature: "99".repeat(64) },
    status: "active",
    epoch: 0,
    version: 2,
    createdAtMs: 1,
    updatedAtMs: 2,
  });
}
