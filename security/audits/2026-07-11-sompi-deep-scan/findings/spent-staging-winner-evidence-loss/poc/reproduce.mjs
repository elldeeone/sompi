import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("usage: node reproduce.mjs <built-sompi-checkout>");
  process.exit(2);
}

const rpcModule = await import(
  pathToFileURL(
    path.resolve(target, "dist/adapters/kaspa-x402/staging-recovery-rpc.js")
  ).href
);
const recoveryModule = await import(
  pathToFileURL(
    path.resolve(target, "dist/adapters/kaspa-x402/abandoned-staging-recovery.js")
  ).href
);

const {
  RpcStagingRecoveryRaceSource,
} = rpcModule;
const {
  AbandonedStagingRecovery,
} = recoveryModule;

const now = 1_000;
const txid = (hex) => hex.repeat(64);
const digest = (base64url = "A") => `sha256:${base64url.repeat(43)}`;
const stagingOutpoint = `${txid("a")}:0`;

const expected = (hex, amountAtomic, scriptPublicKey) => ({
  transactionId: txid(hex),
  transactionArtifactDigest: digest(hex.toUpperCase()),
  inputOutpoint: stagingOutpoint,
  outputOutpoint: `${txid(hex)}:0`,
  outputIndex: 0,
  outputAddress: `address-${hex}`,
  outputAmountAtomic: amountAtomic,
  outputScriptPublicKey: scriptPublicKey,
});

const exact = expected("b", "90", "0000bb");
const recovery = expected("c", "80", "0000cc");
const request = {
  network: "kaspa:testnet-10",
  staging: {
    outpoint: stagingOutpoint,
    address: "staging-address",
    amountAtomic: "100",
    scriptPublicKey: "0000aa",
    blockDaaScore: "1",
  },
  exactPayment: exact,
  recovery,
  deadlineAtMs: now + 1_000,
  signal: new AbortController().signal,
};

const utxoEntry = (candidate, blockDaaScore) => ({
  outpoint: {
    transactionId: candidate.transactionId,
    index: candidate.outputIndex,
  },
  amount: BigInt(candidate.outputAmountAtomic),
  scriptPublicKey: {
    version: 0,
    script: candidate.outputScriptPublicKey.slice(4),
  },
  blockDaaScore: BigInt(blockDaaScore),
  isCoinbase: false,
});

const rpc = (entries) => ({
  getServerInfo: async () => ({
    isSynced: true,
    hasUtxoIndex: true,
    networkId: "testnet-10",
    virtualDaaScore: 1_000n,
  }),
  getUtxosByAddresses: async () => ({ entries }),
  getMempoolEntry: async () => {
    throw new Error("transaction not found");
  },
});

const observe = async (entries) => {
  const source = new RpcStagingRecoveryRaceSource({
    rpc: { client: async () => rpc(entries) },
    now: () => now,
  });
  return source.observeRace(request);
};

// Control: while the exact-payment output remains unspent, the current UTXO
// view identifies the exact transaction as the staging spender.
const beforeSecondarySpend = await observe([utxoEntry(exact, 900)]);
assert.equal(beforeSecondarySpend.exactPayment.status, "observed");
assert.equal(beforeSecondarySpend.recovery.status, "absent");
assert.equal(beforeSecondarySpend.staging.status, "spent");
assert.equal(
  beforeSecondarySpend.staging.spendingTransactionId,
  exact.transactionId
);

// Trigger: after the Merchant spends the exact-payment output and the original
// transaction leaves mempool, the observer's two current-state queries lose
// the only fact that distinguished the historical winner.
const afterSecondarySpend = await observe([]);
assert.equal(afterSecondarySpend.exactPayment.status, "absent");
assert.equal(afterSecondarySpend.recovery.status, "absent");
assert.equal(afterSecondarySpend.staging.status, "spent");
assert.equal(afterSecondarySpend.staging.spendingTransactionId, undefined);

// TypeScript's private classifier is emitted as a normal method at this
// revision. Calling that production method lets the probe demonstrate the
// exact fail-closed decision without constructing keys or submitting a
// transaction.
const classify = AbandonedStagingRecovery.prototype.classifyObservation;
assert.equal(typeof classify, "function");
const envelope = {
  staging: request.staging,
  exactPayment: exact,
  recovery: {
    transactionId: recovery.transactionId,
    transactionArtifactDigest: recovery.transactionArtifactDigest,
    outputOutpoint: recovery.outputOutpoint,
    outputIndex: recovery.outputIndex,
    outputAddress: recovery.outputAddress,
    outputAmountAtomic: recovery.outputAmountAtomic,
    outputScriptPublicKey: recovery.outputScriptPublicKey,
  },
};
const preparedDigest = digest("D");
const beforeDecision = classify.call(
  Object.create(null),
  envelope,
  preparedDigest,
  beforeSecondarySpend
);
const afterDecision = classify.call(
  Object.create(null),
  envelope,
  preparedDigest,
  afterSecondarySpend
);

assert.equal(beforeDecision.status, "conflict");
assert.equal(beforeDecision.reason, "exact_payment_won");
assert.equal(beforeDecision.winningTransactionId, exact.transactionId);
assert.equal(afterDecision.status, "conflict");
assert.equal(afterDecision.reason, "unknown_staging_spender");
assert.equal(afterDecision.winningTransactionId, undefined);

console.log("[+] before secondary spend: exact=observed, recovery=absent");
console.log(`[+] attributed staging spender: ${exact.transactionId}`);
console.log("[+] after secondary spend: exact=absent, recovery=absent");
console.log("[+] attributed staging spender: <missing>");
console.log("[+] classifier before: conflict/exact_payment_won");
console.log("[+] classifier after: conflict/unknown_staging_spender");
