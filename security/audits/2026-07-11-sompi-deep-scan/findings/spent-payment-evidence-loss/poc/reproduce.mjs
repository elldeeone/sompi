#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_CHAIN_VERIFIER_SHA256 =
  "fdcc120c4424b38f87dfac8f1ff90bb7138fc686e5315f7c488ca63a292627f7";

const targetRoot = resolve(process.argv[2] ?? process.env.SOMPI_ROOT ?? "../../sompi");
const chainVerifierPath = resolve(
  targetRoot,
  "dist/adapters/kaspa-x402/chain-verifier.js",
);
const addressCodecPath = resolve(
  targetRoot,
  "dist/adapters/kaspa-x402/address-codec.js",
);

for (const required of [chainVerifierPath, addressCodecPath]) {
  if (!existsSync(required)) {
    throw new Error(
      `Missing ${required}. Build the affected Sompi checkout with npm ci && npm run build.`,
    );
  }
}

const moduleHash = createHash("sha256")
  .update(readFileSync(chainVerifierPath))
  .digest("hex");
assert.equal(
  moduleHash,
  EXPECTED_CHAIN_VERIFIER_SHA256,
  "chain-verifier.js does not match the reviewed affected revision",
);

const [{ RpcChainObservationSource }, { KaspaTestnet10AddressCodec }] =
  await Promise.all([
    import(pathToFileURL(chainVerifierPath).href),
    import(pathToFileURL(addressCodecPath).href),
  ]);

const now = Date.parse("2030-01-01T00:00:00.000Z");
const transactionId = "11".repeat(32);
const merchantAddress =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const expectedScriptPublicKey =
  new KaspaTestnet10AddressCodec().scriptPublicKeyForAddress(
    merchantAddress,
    "kaspa:testnet-10",
  );

// The transaction is a known historical acceptance in the fixture, but its
// Merchant output has since been spent and its parent is no longer in mempool.
const acceptedTransactionIds = new Set([transactionId]);
let historyQueries = 0;
let utxoEntries = -1;
let mempoolContainsTransaction = true;

const rpc = {
  getServerInfo: async () => ({
    isSynced: true,
    hasUtxoIndex: true,
    networkId: "testnet-10",
    virtualDaaScore: 300n,
  }),
  getUtxosByAddresses: async () => {
    const entries = [];
    utxoEntries = entries.length;
    return { entries };
  },
  getMempoolEntry: async () => {
    mempoolContainsTransaction = false;
    throw new Error("transaction not found in mempool");
  },
  getVirtualChainFromBlock: async () => {
    historyQueries += 1;
    return {
      acceptedTransactionIds: [{
        acceptingBlockHash: "aa".repeat(32),
        acceptedTransactionIds: [...acceptedTransactionIds],
      }],
    };
  },
};

const source = new RpcChainObservationSource({
  rpc: { client: async () => rpc },
  now: () => now,
});
const result = await source.observeExactOutput({
  network: "kaspa:testnet-10",
  transactionId,
  outpoint: `${transactionId}:1`,
  outputIndex: 1,
  merchantAddress,
  expectedAmountAtomic: "123",
  expectedScriptPublicKey,
  minimumFinality: "mempool",
  deadlineAtMs: now + 1_000,
  signal: new AbortController().signal,
});

assert.equal(result.status, "pending");
assert.equal(historyQueries, 0);
assert.equal(acceptedTransactionIds.has(transactionId), true);

console.log(`target_module_sha256=${moduleHash}`);
console.log(`current_utxo_entries=${utxoEntries}`);
console.log(`current_mempool_contains_transaction=${mempoolContainsTransaction}`);
console.log(`accepted_history_contains_transaction=${acceptedTransactionIds.has(transactionId)}`);
console.log(`accepted_history_queries=${historyQueries}`);
console.log(`observer_status=${result.status}`);
console.log("result=VULNERABLE");
