#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = path.resolve(process.cwd(), process.argv[2] ?? "../../sompi");
const dist = path.join(target, "dist");
for (const file of [
  "kaspa-wasm.js",
  "wallet.js",
  "policy.js",
  "purchase/journal.js",
  "treasury/operation-adapters.js",
  "treasury/operations.js",
]) {
  if (!fs.existsSync(path.join(dist, file))) {
    throw new Error(`missing ${file}; build the target revision and pass its directory as the first argument`);
  }
}

const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { payToAddressScript } = await load("kaspa-wasm.js");
const { KaspaWallet, generateWalletKey } = await load("wallet.js");
const { PolicyEngine } = await load("policy.js");
const { PurchaseJournal } = await load("purchase/journal.js");
const { WalletTreasuryOperationAdapter } = await load("treasury/operation-adapters.js");
const { TreasuryOperationModule } = await load("treasury/operations.js");

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-wallet-finality-poc-"));
fs.chmodSync(runtime, 0o700);

const wallet = new KaspaWallet({
  networkId: "testnet-10",
  dataDir: path.join(runtime, "wallet"),
});
const destination = generateWalletKey("testnet-10").address;
const sourceScript = payToAddressScript(wallet.address);
let mempoolVisible = true;
let mempoolQueries = 0;
let acceptedChainQueries = 0;

const rpc = {
  getBlockDagInfo: async () => ({ sink: "aa".repeat(32) }),
  getUtxosByAddresses: async (addresses) => ({
    entries: addresses.includes(wallet.address)
      ? [{
          outpoint: { transactionId: "77".repeat(32), index: 0 },
          amount: 300_000_000n,
          scriptPublicKey: sourceScript,
          blockDaaScore: 1n,
          isCoinbase: false,
        }]
      : [],
  }),
  getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
  submitTransaction: async ({ transaction }) => ({
    transactionId: String(transaction.finalize()),
  }),
  getMempoolEntry: async () => {
    mempoolQueries += 1;
    if (!mempoolVisible) throw new Error("transaction not found");
    return { mempoolEntry: { isOrphan: false } };
  },
  getVirtualChainFromBlock: async () => {
    acceptedChainQueries += 1;
    return { acceptedTransactionIds: [] };
  },
};
wallet.client = async () => rpc;

const policyPath = path.join(runtime, "policy.json");
fs.writeFileSync(policyPath, JSON.stringify({
  maxSompiPerTx: "500000000",
  maxSompiPerHour: "1000000000",
  allowlist: [destination],
  requireApprovalAboveSompi: "0",
}), { mode: 0o600 });

const inert = (kind) => ({
  kind,
  prepare: async () => { throw new Error("unused adapter"); },
  submit: async () => { throw new Error("unused adapter"); },
  observe: async () => { throw new Error("unused adapter"); },
  commit: async () => { throw new Error("unused adapter"); },
});

const adapters = [
  new WalletTreasuryOperationAdapter(wallet),
  inert("vault_send"),
  inert("vault_deposit"),
];
const journalPath = path.join(runtime, "purchase.sqlite");
let journal = new PurchaseJournal(journalPath, { now: () => 1_900_000_000_000 });
const policy = new PolicyEngine(runtime, policyPath);
let treasury = new TreasuryOperationModule({
  journal,
  policy,
  adapters,
  feeCeilingAtomic: "20000000",
});

try {
  const completed = await treasury.execute({
    operationKey: "poc:provisional-wallet-finality",
    kind: "wallet_send",
    destination,
    amountAtomic: "100000000",
  });
  assert.equal(completed.state, "completed");
  assert.equal(mempoolQueries, 1);
  assert.equal(acceptedChainQueries, 0);

  mempoolVisible = false;
  journal.close();
  journal = new PurchaseJournal(journalPath, { now: () => 1_900_000_000_000 });
  treasury = new TreasuryOperationModule({
    journal,
    policy,
    adapters,
    feeCeilingAtomic: "20000000",
  });

  const afterRestart = await treasury.recover("poc:provisional-wallet-finality");
  assert.equal(afterRestart.state, "completed");
  assert.equal(mempoolQueries, 1, "terminal recovery unexpectedly queried the vanished mempool entry");
  assert.equal(acceptedChainQueries, 0);

  console.log(JSON.stringify({
    provisionalObservationCompleted: true,
    stateBeforeEviction: completed.state,
    stateAfterEvictionAndRestart: afterRestart.state,
    mempoolQueriesBeforeEviction: 1,
    mempoolQueriesAfterRestart: mempoolQueries,
    acceptedChainQueries,
    independentAcceptedChainEvidence: false,
  }));
} finally {
  journal.close();
  sourceScript.free();
  fs.rmSync(runtime, { recursive: true, force: true });
}
