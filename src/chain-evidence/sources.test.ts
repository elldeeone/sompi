import assert from "node:assert/strict";
import test from "node:test";

import { ChainEvidenceModule } from "./module.js";
import { HttpsAcceptedChainWitness, WrpcOperatorChainObserver } from "./sources.js";
import type { ChainEvidenceRecord, ChainEvidenceRequest } from "./types.js";

test("HTTPS accepted history and operator wRPC corroborate the exact transaction and anchor", async () => {
  const request = fixtureRequest();
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
    getBlock: async () => ({ block: { header: { hash: accepting, daaScore: 100n } } }),
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

test("HTTP 404 plus a generic RPC capability failure is unavailable, never absence", async () => {
  const request = fixtureRequest();
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
  const request = fixtureRequest();
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

function fixtureRequest(): ChainEvidenceRequest {
  return {
    operationId: "settlement:test", operation: "settlement", network: "kaspa:testnet-10",
    transactionId: "11".repeat(32),
    expectedOutputs: [{ index: 1, amountAtomic: "123", scriptPublicKey: `000020${"44".repeat(32)}ac`, address: "kaspatest:qfixture" }],
    expectedInputs: [{ transactionId: "aa".repeat(32), index: 0 }],
    watchedAddresses: ["kaspatest:qfixture"], mechanism: "kip10-script-template",
    protocolFinality: "accepted", operatorFloor: "depth-confirmed",
    signal: new AbortController().signal,
  };
}

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function memoryStore() {
  const records: ChainEvidenceRecord[] = [];
  return {
    findAccepted: (transactionId: string) => records.find((record) => record.transactionId === transactionId && record.status === "present" && record.level !== "provisional"),
    record: (record: ChainEvidenceRecord) => (records.push(record), record),
  };
}
