import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ChainEvidenceModule } from "../../chain-evidence/module.js";
import { evidenceDigest } from "../../purchase/identity.js";
import {
  PurchaseJournal,
  type BatchChannelJournalRecord,
  type BatchRaceRecoveryRecord,
} from "../../purchase/journal.js";
import {
  HttpsBatchClaimRaceSource,
  type BatchRaceRecoveryStore,
} from "./batch-race-source.js";

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
    recoveryStore(),
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

test("a stale positive active UTXO cannot suppress an accepted claim", async () => {
  let fetchCalls = 0;
  let evidenceCalls = 0;
  const stale = new HttpsBatchClaimRaceSource(
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
    {
      observe: async () => {
        evidenceCalls += 1;
        return {
          status: "present",
          level: "accepted",
          detailDigest: evidenceDigest("accepted-claim-despite-stale-utxo"),
        };
      },
    } as unknown as ChainEvidenceModule,
    "accepted",
    recoveryStore(),
    async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify([claimTransaction()]), { status: 200 });
    },
  );
  assert.equal((await stale.observeClaimWinner({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  })).status, "claim");
  assert.equal(fetchCalls, 1);
  assert.equal(evidenceCalls, 1);
});

test("a corroborated unspent channel remains unspent and an invalid spender fails closed", async () => {
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
    recoveryStore(),
    async () => { fetchCalls += 1; return new Response("[]"); },
  );
  assert.equal((await live.observeClaimWinner({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  })).status, "unspent");
  assert.equal(fetchCalls, 1);

  const malformed = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    { observe: async () => { throw new Error("must not corroborate malformed candidate"); } } as unknown as ChainEvidenceModule,
    "accepted",
    recoveryStore(),
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
    recoveryStore(),
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

test("accepted older claim remains recoverable after a stale positive view advanced the local ceiling", async () => {
  const inflated = {
    ...channel(),
    signedCumulativeAtomic: "250000",
    latestVoucher: { amountAtomic: "250000", signature: "88".repeat(64) },
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
          detailDigest: evidenceDigest("accepted-older-claim"),
        };
      },
    } as unknown as ChainEvidenceModule,
    "accepted",
    recoveryStore(),
    async () => new Response(JSON.stringify([claimTransaction()]), { status: 200 }),
  );

  const result = await source.observeClaimWinner({
    channel: inflated,
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
    recoveryStore(),
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
    recoveryStore(),
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

test("batch claim-race discovery follows bounded cursor pages and resumes from durable progress", async () => {
  const recovery = recoveryStore();
  let requests = 0;
  let evidenceCalls = 0;
  const unrelated = Array.from({ length: 500 }, (_, index) => ({
    transaction_id: index.toString(16).padStart(64, "0"),
    is_accepted: true,
    inputs: [],
    outputs: [],
  }));
  const source = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    {
      observe: async () => {
        evidenceCalls += 1;
        return {
          status: "present",
          level: "accepted",
          detailDigest: evidenceDigest("accepted-cursor-claim"),
        };
      },
    } as unknown as ChainEvidenceModule,
    "accepted",
    recovery,
    async (input) => {
      requests += 1;
      const url = new URL(String(input));
      if (url.searchParams.get("before") === null) {
        return new Response(JSON.stringify(unrelated), {
          status: 200,
          headers: { "x-next-page-before": "1700000000000" },
        });
      }
      assert.equal(url.searchParams.get("before"), "1700000000000");
      return new Response(JSON.stringify([claimTransaction()]), { status: 200 });
    },
  );
  const observed = await source.observeClaimWinner({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  });
  assert.equal(observed.status, "claim");
  assert.equal(requests, 2);
  assert.equal(evidenceCalls, 1);
  const checkpoint = recovery.loadBatchRaceRecovery({
    channelId: channel().channelId,
    sourceOutpoint: channel().activeOutpoint,
    refundTransactionId: "77".repeat(32),
  });
  assert.equal(checkpoint?.nextBeforeCursor, "1700000000000");
  assert.equal(checkpoint?.pagesScanned, 1);
});

test("batch claim-race discovery resumes after its per-attempt page budget", async () => {
  const recovery = recoveryStore();
  let requests = 0;
  let evidenceCalls = 0;
  const unrelated = Array.from({ length: 500 }, (_, index) => ({
    transaction_id: index.toString(16).padStart(64, "0"),
    is_accepted: true,
    inputs: [],
    outputs: [],
  }));
  const cursors = ["4000", "3000", "2000", "1000"] as const;
  const source = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    {
      observe: async () => {
        evidenceCalls += 1;
        return {
          status: "present",
          level: "accepted",
          detailDigest: evidenceDigest("accepted-resumed-claim"),
        };
      },
    } as unknown as ChainEvidenceModule,
    "accepted",
    recovery,
    async (input) => {
      requests += 1;
      const before = new URL(String(input)).searchParams.get("before");
      if (before === "1000") {
        return new Response(JSON.stringify([claimTransaction()]), { status: 200 });
      }
      const expectedBefore = requests === 1 ? null : cursors[requests - 2];
      assert.equal(before, expectedBefore);
      return new Response(JSON.stringify(unrelated), {
        status: 200,
        headers: { "x-next-page-before": cursors[requests - 1]! },
      });
    },
  );
  const input = Object.freeze({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  });

  const incomplete = await source.observeClaimWinner(input);
  assert.equal(incomplete.status, "unknown");
  assert.equal(requests, 4);
  assert.equal(evidenceCalls, 0);
  assert.equal(recovery.loadBatchRaceRecovery({
    channelId: input.channel.channelId,
    sourceOutpoint: input.channel.activeOutpoint,
    refundTransactionId: input.refundTransactionId,
  })?.nextBeforeCursor, "1000");

  const resumed = await source.observeClaimWinner(input);
  assert.equal(resumed.status, "claim");
  assert.equal(requests, 5);
  assert.equal(evidenceCalls, 1);
});

test("an exhausted index scan is retried because later indexing can reveal the accepted spender", async () => {
  const recovery = recoveryStore();
  let requests = 0;
  const source = new HttpsBatchClaimRaceSource(
    "https://history.example/",
    { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    {
      observe: async () => ({
        status: "present",
        level: "accepted",
        detailDigest: evidenceDigest("accepted-after-index-lag"),
      }),
    } as unknown as ChainEvidenceModule,
    "accepted",
    recovery,
    async () => {
      requests += 1;
      return new Response(JSON.stringify(requests === 1 ? [] : [claimTransaction()]), {
        status: 200,
      });
    },
  );
  const input = Object.freeze({
    channel: channel(),
    refundTransactionId: "77".repeat(32),
    signal: new AbortController().signal,
  });

  assert.equal((await source.observeClaimWinner(input)).status, "unknown");
  assert.equal(recovery.loadBatchRaceRecovery({
    channelId: input.channel.channelId,
    sourceOutpoint: input.channel.activeOutpoint,
    refundTransactionId: input.refundTransactionId,
  })?.state, "exhausted");
  assert.equal((await source.observeClaimWinner(input)).status, "claim");
  assert.equal(requests, 2);
});

test("batch claim-race cursor progress survives a real Journal restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-race-restart-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const cursors = ["4000", "3000", "2000", "1000"] as const;
  let journal = new PurchaseJournal(filename);
  try {
    journal.saveBatchChannel({ ...channel(), version: 1 });
    let requests = 0;
    const first = new HttpsBatchClaimRaceSource(
      "https://history.example/",
      { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
      {} as ChainEvidenceModule,
      "accepted",
      journal,
      async (input) => {
        const before = new URL(String(input)).searchParams.get("before");
        assert.equal(before, requests === 0 ? null : cursors[requests - 1]);
        const cursor = cursors[requests]!;
        requests += 1;
        return new Response("[]", {
          status: 200,
          headers: { "x-next-page-before": cursor },
        });
      },
    );
    const input = Object.freeze({
      channel: channel(),
      refundTransactionId: "77".repeat(32),
      signal: new AbortController().signal,
    });
    assert.equal((await first.observeClaimWinner(input)).status, "unknown");
    assert.equal(requests, 4);
    assert.throws(
      () => journal.advanceBatchRaceRecovery({
        channelId: input.channel.channelId,
        sourceOutpoint: input.channel.activeOutpoint,
        refundTransactionId: input.refundTransactionId,
        expectedBeforeCursor: "1000",
        expectedPagesScanned: 3,
        nextBeforeCursor: "900",
        rowsScanned: 0,
      }),
      /cursor changed concurrently/,
    );
    journal.close();

    journal = new PurchaseJournal(filename);
    let resumedBefore: string | null = null;
    const resumed = new HttpsBatchClaimRaceSource(
      "https://history.example/",
      { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
      {
        observe: async () => ({
          status: "present",
          level: "accepted",
          detailDigest: evidenceDigest("accepted-after-journal-restart"),
        }),
      } as unknown as ChainEvidenceModule,
      "accepted",
      journal,
      async (input) => {
        resumedBefore = new URL(String(input)).searchParams.get("before");
        return new Response(JSON.stringify([claimTransaction()]), { status: 200 });
      },
    );
    assert.equal((await resumed.observeClaimWinner(input)).status, "claim");
    assert.equal(resumedBefore, "1000");
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

function recoveryStore(): BatchRaceRecoveryStore {
  let stored: BatchRaceRecoveryRecord | undefined;
  return {
    loadBatchRaceRecovery() {
      return stored;
    },
    advanceBatchRaceRecovery(input) {
      if (
        stored &&
        (stored.nextBeforeCursor !== input.expectedBeforeCursor ||
          stored.pagesScanned !== input.expectedPagesScanned)
      ) {
        throw new Error("cursor changed concurrently");
      }
      stored = Object.freeze({
        channelId: input.channelId,
        sourceOutpoint: Object.freeze({ ...input.sourceOutpoint }),
        refundTransactionId: input.refundTransactionId,
        ...(input.nextBeforeCursor === undefined ? {} : { nextBeforeCursor: input.nextBeforeCursor }),
        pagesScanned: (stored?.pagesScanned ?? 0) + 1,
        rowsScanned: (stored?.rowsScanned ?? 0) + input.rowsScanned,
        state: input.nextBeforeCursor === undefined ? "exhausted" : "active",
        updatedAtMs: Date.now(),
      });
      return stored;
    },
  };
}
