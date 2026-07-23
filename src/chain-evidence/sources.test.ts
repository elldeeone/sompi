import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "../kaspa-wasm.js";
import { ChainEvidenceModule, meets } from "./module.js";
import { HttpsAcceptedChainWitness, WrpcOperatorChainObserver } from "./sources.js";
import type {
  AcceptedChainEvidenceQuery,
  ChainEvidenceRecord,
  ChainEvidenceRequest,
} from "./types.js";

test("HTTPS accepted history and operator wRPC corroborate the exact transaction and anchor", async () => {
  const { request, transaction } = fixture();
  const acceptedBlockTransaction = {
    ...transaction,
    outputs: transaction.outputs.map((output: {
      value: bigint;
      scriptPublicKey: { version: number; script: string };
    }) => ({
      ...output,
      scriptPublicKey: `${Number(output.scriptPublicKey.version).toString(16).padStart(4, "0")}${output.scriptPublicKey.script}`,
    })),
  };
  const accepting = "33".repeat(32);
  const containing = "22".repeat(32);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/transactions/")) return json({
      transaction_id: request.transactionId,
      is_accepted: true,
      block_hash: [containing],
      accepting_block_hash: accepting,
      inputs: [{ previous_outpoint_hash: "aa".repeat(32), previous_outpoint_index: "0" }],
      outputs: [{ index: 1, amount: 123, script_public_key: request.expectedOutputs[0].scriptPublicKey.slice(4), covenant_id: null }],
    });
    if (url.pathname === `/blocks/${accepting}`) return json({ header: { daaScore: "100" } });
    if (url.pathname === "/info/blockdag") return json({ virtualDaaScore: "120" });
    throw new Error(`unexpected URL ${url}`);
  };
  const rpc = {
    getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
    getVirtualChainFromBlock: async ({ startHash }: any) => {
      assert.equal(startHash, containing);
      return { acceptedTransactionIds: [{ acceptingBlockHash: accepting, acceptedTransactionIds: [request.transactionId] }] };
    },
    getBlock: async ({ hash, includeTransactions }: any) => hash === accepting
      ? ({ block: { header: { hash: accepting, daaScore: 100n } } })
      : ({
          block: {
            header: { hash: containing, daaScore: 99n },
            // Rusty Kaspa serializes ScriptPublicKey as canonical hex in
            // accepted block transaction bodies, unlike current-UTXO views.
            transactions: includeTransactions ? [acceptedBlockTransaction] : [],
          },
        }),
  };
  const store = memoryStore();
  const module = new ChainEvidenceModule(
    new WrpcOperatorChainObserver({ rpc: { client: async () => rpc as any }, depthConfirmationDaa: 10, now: () => 1_800_000_000_000 }),
    new HttpsAcceptedChainWitness({ baseUrl: "https://witness.example/", depthConfirmationDaa: 10, fetch: fetcher, now: () => 1_800_000_000_000 }),
    store,
    () => 1_800_000_000_000
  );
  const evidence = await module.observe(request);
  assert.equal(evidence.status, "present");
  assert.equal(evidence.level, "depth-confirmed");
  assert.equal(evidence.blockHash, containing);
  assert.equal(evidence.acceptingBlockHash, accepting);
});

test("operator history refuses a witness transaction ID without the matching block body", async () => {
  const { request, transaction } = fixture();
  const accepting = "33".repeat(32);
  const containing = "22".repeat(32);
  const conflicting = {
    ...transaction,
    outputs: [{ ...transaction.outputs[0], value: 124n }],
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/transactions/")) return json({
      transaction_id: request.transactionId,
      is_accepted: true,
      block_hash: [containing],
      accepting_block_hash: accepting,
      inputs: [{ previous_outpoint_hash: "aa".repeat(32), previous_outpoint_index: "0" }],
      outputs: [{ index: 1, amount: 123, script_public_key: request.expectedOutputs[0].scriptPublicKey.slice(4), covenant_id: null }],
    });
    if (url.pathname === `/blocks/${accepting}`) return json({ header: { daaScore: "100" } });
    if (url.pathname === "/info/blockdag") return json({ virtualDaaScore: "120" });
    throw new Error(`unexpected URL ${url}`);
  };
  const rpc = {
    getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
    getVirtualChainFromBlock: async () => ({
      acceptedTransactionIds: [{ acceptingBlockHash: accepting, acceptedTransactionIds: [request.transactionId] }],
    }),
    getBlock: async ({ hash, includeTransactions }: any) => hash === accepting
      ? ({ block: { header: { hash: accepting, daaScore: 100n } } })
      : ({
          block: {
            header: { hash: containing, daaScore: 99n },
            transactions: includeTransactions ? [conflicting] : [],
          },
        }),
  };
  const module = new ChainEvidenceModule(
    new WrpcOperatorChainObserver({ rpc: { client: async () => rpc as any }, depthConfirmationDaa: 10, now: () => 1_800_000_000_000 }),
    new HttpsAcceptedChainWitness({ baseUrl: "https://witness.example/", depthConfirmationDaa: 10, fetch: fetcher, now: () => 1_800_000_000_000 }),
    memoryStore(),
    () => 1_800_000_000_000
  );

  const evidence = await module.observe(request);
  assert.equal(evidence.status, "present");
  assert.equal(evidence.level, "provisional");
});

test("HTTP 404 plus a generic RPC capability failure is unavailable, never absence", async () => {
  const { request } = fixture();
  const module = new ChainEvidenceModule(
    new WrpcOperatorChainObserver({
      rpc: { client: async () => ({
        getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
        getUtxosByAddresses: async () => ({ entries: [] }),
        getMempoolEntriesByAddresses: async () => { throw new Error("Method not found"); },
      } as any) },
      depthConfirmationDaa: 10,
      now: () => 1_800_000_000_000,
    }),
    new HttpsAcceptedChainWitness({
      baseUrl: "https://witness.example/", depthConfirmationDaa: 10,
      fetch: async () => new Response('{"detail":"Not Found"}', { status: 404, headers: { "content-type": "application/json" } }),
      now: () => 1_800_000_000_000,
    }),
    memoryStore(),
    () => 1_800_000_000_000
  );
  assert.equal((await module.observe(request)).status, "unavailable");
});

test("a live exact UTXO prevents a lagging 404 witness from becoming absence", async () => {
  const { request } = fixture();
  const module = new ChainEvidenceModule(
    new WrpcOperatorChainObserver({
      rpc: { client: async () => ({
        getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
        getUtxosByAddresses: async () => ({ entries: [{
          outpoint: { transactionId: request.transactionId, index: 1 },
          amount: 123n,
          scriptPublicKey: { version: 0, script: request.expectedOutputs[0].scriptPublicKey.slice(4) },
        }] }),
      } as any) },
      depthConfirmationDaa: 10,
      now: () => 1_800_000_000_000,
    }),
    new HttpsAcceptedChainWitness({
      baseUrl: "https://witness.example/", depthConfirmationDaa: 10,
      fetch: async () => new Response('{"detail":"Not Found"}', { status: 404, headers: { "content-type": "application/json" } }),
      now: () => 1_800_000_000_000,
    }),
    memoryStore(),
    () => 1_800_000_000_000
  );
  const evidence = await module.observe(request);
  assert.equal(evidence.status, "present");
  assert.equal(evidence.level, "provisional");
});

test("empty address-bucket mempool evidence independently proves operator absence", async () => {
  const { request } = fixture();
  const observer = new WrpcOperatorChainObserver({
    rpc: { client: async () => ({
      getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
      getUtxosByAddresses: async () => ({ entries: [] }),
      getMempoolEntriesByAddresses: async () => ({ entries: [{
        address: request.watchedAddresses[0],
        sending: [],
        receiving: [],
      }] }),
    } as any) },
    depthConfirmationDaa: 10,
    now: () => 1_800_000_000_000,
  });
  const evidence = await observer.observe(request, absentWitness());
  assert.equal(evidence.status, "absent");
});

test("address-bucket mempool evidence deduplicates one matching transaction", async () => {
  const { request, transaction } = fixture();
  const entry = { transaction };
  const observer = new WrpcOperatorChainObserver({
    rpc: { client: async () => ({
      getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
      getUtxosByAddresses: async () => ({ entries: [] }),
      getMempoolEntriesByAddresses: async () => ({ entries: [{
        address: request.watchedAddresses[0],
        sending: [entry],
        receiving: [entry],
      }] }),
    } as any) },
    depthConfirmationDaa: 10,
    now: () => 1_800_000_000_000,
  });
  const evidence = await observer.observe(request, absentWitness());
  assert.equal(evidence.status, "present");
  assert.equal(evidence.level, "provisional");
});

test("accepted-block work budget rejects oversized RPC arrays before WASM finalization", async () => {
  const { request, transaction } = fixture();
  const accepting = "33".repeat(32);
  const containing = "22".repeat(32);
  let finalized = 0;
  const originalFinalize = Transaction.prototype.finalize;
  Transaction.prototype.finalize = function (...args: Parameters<typeof originalFinalize>) {
    finalized += 1;
    return originalFinalize.apply(this, args);
  };
  try {
    const observer = new WrpcOperatorChainObserver({
      rpc: { client: async () => ({
        getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
        getVirtualChainFromBlock: async () => ({
          acceptedTransactionIds: [{ acceptingBlockHash: accepting, acceptedTransactionIds: [request.transactionId] }],
        }),
        getBlock: async ({ hash }: any) => hash === accepting
          ? ({ block: { header: { hash: accepting, daaScore: 100n } } })
          : ({ block: { header: { hash: containing, daaScore: 99n }, transactions: Array.from({ length: 4_097 }, () => transaction) } }),
      } as any) },
      depthConfirmationDaa: 10,
      now: () => 1_800_000_000_000,
    });
    const evidence = await observer.observe(request, acceptedWitness(request, accepting, containing));
    assert.equal(evidence.status, "unavailable");
    assert.equal(finalized, 0);
  } finally {
    Transaction.prototype.finalize = originalFinalize;
  }
});

test("mempool work budget rejects oversized and duplicate buckets before WASM finalization", async () => {
  const { request, transaction } = fixture();
  let finalized = 0;
  const originalFinalize = Transaction.prototype.finalize;
  Transaction.prototype.finalize = function (...args: Parameters<typeof originalFinalize>) {
    finalized += 1;
    return originalFinalize.apply(this, args);
  };
  try {
    for (const entries of [
      [{ address: request.watchedAddresses[0], sending: Array.from({ length: 2_049 }, () => ({ transaction })), receiving: [] }],
      [
        { address: request.watchedAddresses[0], sending: [], receiving: [] },
        { address: request.watchedAddresses[0], sending: [{ transaction }], receiving: [] },
      ],
    ]) {
      const observer = new WrpcOperatorChainObserver({
        rpc: { client: async () => ({
          getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
          getUtxosByAddresses: async () => ({ entries: [] }),
          getMempoolEntriesByAddresses: async () => ({ entries }),
        } as any) },
        depthConfirmationDaa: 10,
        now: () => 1_800_000_000_000,
      });
      assert.equal((await observer.observe(request, absentWitness())).status, "unavailable");
      assert.equal(finalized, 0);
    }
  } finally {
    Transaction.prototype.finalize = originalFinalize;
  }
});

test("bounded mempool traversal honors cancellation after native work begins", async () => {
  const { request, transaction } = fixture();
  const abort = new AbortController();
  let finalized = 0;
  const originalFinalize = Transaction.prototype.finalize;
  Transaction.prototype.finalize = function (...args: Parameters<typeof originalFinalize>) {
    finalized += 1;
    const result = originalFinalize.apply(this, args);
    abort.abort(new Error("test cancellation"));
    return result;
  };
  try {
    const observer = new WrpcOperatorChainObserver({
      rpc: { client: async () => ({
        getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: true, networkId: "testnet-10", virtualDaaScore: 120n }),
        getUtxosByAddresses: async () => ({ entries: [] }),
        getMempoolEntriesByAddresses: async () => ({ entries: [{
          address: request.watchedAddresses[0],
          sending: Array.from({ length: 10 }, () => ({ transaction })),
          receiving: [],
        }] }),
      } as any) },
      depthConfirmationDaa: 10,
      now: () => 1_800_000_000_000,
    });
    const evidence = await observer.observe({ ...request, signal: abort.signal }, absentWitness());
    assert.equal(evidence.status, "unavailable");
    assert.equal(finalized, 1);
  } finally {
    Transaction.prototype.finalize = originalFinalize;
  }
});

function fixture(): { request: ChainEvidenceRequest; transaction: Record<string, any> } {
  const script = `20${"44".repeat(32)}ac`;
  const transaction = {
    version: 0,
    inputs: [{
      previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
      signatureScript: "",
      sequence: 0n,
      sigOpCount: 1,
      computeBudget: 0n,
    }],
    outputs: [
      { value: 0n, scriptPublicKey: { version: 0, script: "51" } },
      { value: 123n, scriptPublicKey: { version: 0, script } },
    ],
    lockTime: 0n,
    subnetworkId: "00".repeat(20),
    gas: 0n,
    payload: "",
  };
  const snapshot = new Transaction(transaction as never);
  let transactionId: string;
  try {
    transactionId = String(snapshot.finalize()).toLowerCase();
  } finally {
    snapshot.free();
  }
  return { request: {
    operationId: "settlement:test", operation: "settlement", network: "kaspa:testnet-10",
    transactionId,
    expectedOutputs: [{ index: 1, amountAtomic: "123", scriptPublicKey: `0000${script}`, address: "kaspatest:qfixture" }],
    expectedInputs: [{ transactionId: "aa".repeat(32), index: 0 }],
    watchedAddresses: ["kaspatest:qfixture"], mechanism: "kip10-script-template",
    protocolFinality: "accepted", operatorFloor: "depth-confirmed",
    signal: new AbortController().signal,
  }, transaction };
}

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function absentWitness() {
  return Object.freeze({
    status: "absent" as const,
    sourceProfile: "test-witness-v1",
    detailDigest: `sha256:${"A".repeat(43)}`,
    observedAtMs: 1_800_000_000_000,
  });
}
function acceptedWitness(request: ChainEvidenceRequest, acceptingBlockHash: string, blockHash: string) {
  return Object.freeze({
    status: "present" as const,
    level: "accepted" as const,
    view: "historical" as const,
    sourceProfile: "test-witness-v1",
    transactionId: request.transactionId,
    blockHash,
    acceptingBlockHash,
    acceptingBlockDaaScore: "100",
    virtualDaaScore: "120",
    outputsDigest: `sha256:${"A".repeat(43)}`,
    detailDigest: `sha256:${"B".repeat(43)}`,
    observedAtMs: 1_800_000_000_000,
  });
}
function memoryStore() {
  const records: ChainEvidenceRecord[] = [];
  return {
    findAccepted: (query: AcceptedChainEvidenceQuery) => records.find((record) =>
      record.transactionId === query.transactionId &&
      record.outputsDigest === query.outputsDigest &&
      record.mechanism === query.mechanism &&
      record.status === "present" &&
      record.level !== undefined &&
      meets(record.level, query.minimumLevel)
    ),
    record: (record: ChainEvidenceRecord) => (records.push(record), record),
  };
}
