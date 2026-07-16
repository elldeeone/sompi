import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "../kaspa-wasm.js";
import { ChainEvidenceModule } from "./module.js";
import { HttpsAcceptedChainWitness, WrpcOperatorChainObserver } from "./sources.js";
import type { ChainEvidenceRecord, ChainEvidenceRequest } from "./types.js";

test("HTTPS accepted history and operator wRPC corroborate the exact transaction and anchor", async () => {
  const { request, transaction } = fixture();
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
            transactions: includeTransactions ? [transaction] : [],
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
function memoryStore() {
  const records: ChainEvidenceRecord[] = [];
  return {
    findAccepted: (transactionId: string) => records.find((record) => record.transactionId === transactionId && record.status === "present" && record.level !== "provisional"),
    record: (record: ChainEvidenceRecord) => (records.push(record), record),
  };
}
