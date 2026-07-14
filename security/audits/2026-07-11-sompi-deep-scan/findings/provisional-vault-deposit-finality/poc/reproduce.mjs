#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = path.resolve(process.cwd(), process.argv[2] ?? "../target");
const dist = path.join(target, "dist");

const expectedSourceHashes = Object.freeze({
  "src/vault.ts": "6fd64bb94ef1cf2dd30b0629add37b7707ce725fa0895132f9755f167876778b",
  "src/treasury/operation-adapters.ts": "4752d20fddbe1ebdf7b2d764ec40e741720266e45adf1867f1607c68ce5fd777",
  "src/treasury/operations.ts": "777392cedfc0dc74f8875ef0e7b235d59643f6e6461e78a8223bd13d804f64a4",
});

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const [relative, expected] of Object.entries(expectedSourceHashes)) {
  const file = path.join(target, relative);
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${relative}; pass a source checkout of the affected revision`);
  }
  assert.equal(sha256(file), expected, `${relative} does not match the affected revision`);
}

for (const relative of [
  "kaspa-wasm.js",
  "wallet.js",
  "vault.js",
  "policy.js",
  "purchase/journal.js",
  "treasury/operation-adapters.js",
  "treasury/operations.js",
]) {
  if (!fs.existsSync(path.join(dist, relative))) {
    throw new Error(`missing dist/${relative}; install dependencies and build the target first`);
  }
}

const load = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
const { Transaction, payToAddressScript } = await load("kaspa-wasm.js");
const { KaspaWallet } = await load("wallet.js");
const { VaultManager, generateOwnerKey } = await load("vault.js");
const { PolicyEngine } = await load("policy.js");
const { PurchaseJournal } = await load("purchase/journal.js");
const { VaultDepositTreasuryOperationAdapter } = await load(
  "treasury/operation-adapters.js",
);
const { TreasuryOperationModule } = await load("treasury/operations.js");

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-deposit-finality-poc-"));
fs.chmodSync(runtime, 0o700);

const wallet = new KaspaWallet({
  networkId: "testnet-10",
  dataDir: path.join(runtime, "wallet"),
});
const vault = new VaultManager(runtime, "testnet-10");
vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);

const sourceScript = payToAddressScript(wallet.address);
const sourceEntry = Object.freeze({
  outpoint: { transactionId: "11".repeat(32), index: 0 },
  amount: 300_000_000n,
  scriptPublicKey: sourceScript,
  blockDaaScore: 1n,
  isCoinbase: false,
});

let submitted;
let outputVisible = false;
let vaultOutputQueries = 0;
let acceptedChainQueries = 0;
let mempoolQueries = 0;

const rpc = {
  getBlockDagInfo: async () => ({ sink: "aa".repeat(32) }),
  getServerInfo: async () => ({ virtualDaaScore: "100" }),
  getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
  getUtxosByAddresses: async (addresses) => {
    if (addresses.includes(wallet.address)) return { entries: [sourceEntry] };
    vaultOutputQueries += 1;
    if (!submitted || !outputVisible) return { entries: [] };
    return {
      entries: [{
        outpoint: { transactionId: String(submitted.finalize()), index: 0 },
        amount: submitted.outputs[0].value,
        scriptPublicKey: submitted.outputs[0].scriptPublicKey,
        blockDaaScore: 0n,
        isCoinbase: false,
        covenantId: submitted.outputs[0].covenant?.covenantId,
      }],
    };
  },
  submitTransaction: async ({ transaction }) => {
    submitted?.free();
    submitted = new Transaction(transaction);
    outputVisible = true;
    return { transactionId: String(submitted.finalize()) };
  },
  getMempoolEntry: async () => {
    mempoolQueries += 1;
    throw new Error("transaction not found");
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
  allowlist: [vault.config().address],
  requireApprovalAboveSompi: "0",
}), { mode: 0o600 });

const inert = (kind) => Object.freeze({
  kind,
  prepare: async () => { throw new Error("unused adapter"); },
  submit: async () => { throw new Error("unused adapter"); },
  observe: async () => { throw new Error("unused adapter"); },
  commit: async () => { throw new Error("unused adapter"); },
});

const operationKey = "poc:provisional-vault-deposit";
const journalPath = path.join(runtime, "purchase.sqlite");
let journal = new PurchaseJournal(journalPath, { now: () => 1_900_000_000_000 });
const policy = new PolicyEngine(runtime, policyPath);
let depositAdapter = new VaultDepositTreasuryOperationAdapter(vault, wallet);
let treasury = new TreasuryOperationModule({
  journal,
  policy,
  adapters: [inert("wallet_send"), inert("vault_send"), depositAdapter],
  feeCeilingAtomic: "20000000",
});

try {
  const completed = await treasury.execute({
    operationKey,
    kind: "vault_deposit",
    destination: vault.config().address,
    amountAtomic: "max",
    keepFloatAtomic: "80000000",
  });
  assert.equal(completed.state, "completed");

  const completedRecord = journal.requireTreasuryOperation(operationKey);
  const preparedBytes = journal.readPreparedTreasuryOperation(operationKey);
  const observedDetail = journal.readObservedTreasuryOperationDetail(operationKey);
  assert.equal(observedDetail.observedAtDaa, "0");

  const committed = vault.config();
  assert.ok(committed.covenantId);
  assert.ok(committed.currentOutpoint);
  assert.equal(committed.currentOutpoint.txid, completed.transactionId);

  outputVisible = false;
  const afterEviction = await depositAdapter.observe(completedRecord, preparedBytes);
  assert.equal(afterEviction.status, "not_submitted");

  journal.close();
  journal = new PurchaseJournal(journalPath, { now: () => 1_900_000_000_000 });
  const restartedVault = new VaultManager(runtime, "testnet-10");
  depositAdapter = new VaultDepositTreasuryOperationAdapter(restartedVault, wallet);
  treasury = new TreasuryOperationModule({
    journal,
    policy,
    adapters: [inert("wallet_send"), inert("vault_send"), depositAdapter],
    feeCeilingAtomic: "20000000",
  });

  const recovered = await treasury.recover(operationKey);
  assert.equal(recovered.state, "completed");
  assert.deepEqual(restartedVault.config().currentOutpoint, committed.currentOutpoint);

  console.log(JSON.stringify({
    affectedRevisionMatched: true,
    acceptedProvisionalDaa: observedDetail.observedAtDaa,
    operationStateBeforeEviction: completed.state,
    chainEvidenceAfterEviction: afterEviction.status,
    operationStateAfterRestart: recovered.state,
    persistedNonexistentOutpoint: true,
    vaultOutputQueries,
    mempoolQueries,
    acceptedChainQueries,
    independentAcceptedChainEvidence: false,
  }));
} finally {
  journal.close();
  submitted?.free();
  sourceScript.free();
  fs.rmSync(runtime, { recursive: true, force: true });
}
