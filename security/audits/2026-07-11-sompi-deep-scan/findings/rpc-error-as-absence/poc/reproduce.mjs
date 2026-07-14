#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const AFFECTED_REVISION = "4ebb82d4f82bac46ae3addd112c4752f29630a8a";
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const STAGING_PRIVATE_KEY = "01".padStart(64, "0");
const RECOVERY_PRIVATE_KEY = "03".padStart(64, "0");
const OWNER_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const MERCHANT_ADDRESS =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const BORROW_REDEEM_SCRIPT =
  "632079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac67b9bfb9c388b9c2048096980094b9bea268";
const BORROW_SCRIPT_PUBLIC_KEY =
  "0000aa20017f2ed51106a0b7d68477bbd1f1a65c000eecffc5e9f458501324810fb1944887";
const BORROW_TXID = "22".repeat(32);
const STAGING_TXID = "33".repeat(32);

const target = path.resolve(process.cwd(), process.env.SOMPI_TARGET ?? "../target");
const targetModule = (relativePath) =>
  import(pathToFileURL(path.join(target, relativePath)).href);

const [
  { AbandonedStagingRecovery },
  { RpcStagingRecoveryRaceSource },
  { Kip10ExactTransactionBuilder },
  { StagingKeyStore },
  { PrivateKey },
  { assertPurchaseId, createPaymentIdentifier },
] = await Promise.all([
  targetModule("dist/adapters/kaspa-x402/abandoned-staging-recovery.js"),
  targetModule("dist/adapters/kaspa-x402/staging-recovery-rpc.js"),
  targetModule("dist/adapters/kaspa-x402/exact-transaction-builder.js"),
  targetModule("dist/adapters/kaspa-x402/staging-key-store.js"),
  targetModule("dist/kaspa-wasm.js"),
  targetModule("dist/purchase/identity.js"),
]);

const purchaseId = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-rpc-absence-poc-"));

try {
  const keyStore = new StagingKeyStore({
    directory: path.join(temporaryRoot, "keys"),
    now: () => NOW,
    generatePrivateKey: () => STAGING_PRIVATE_KEY,
  });
  const stagingKey = keyStore.create({ purchaseId, paymentIdentifier });
  const staging = {
    network: "kaspa:testnet-10",
    outpoint: { txid: STAGING_TXID, index: 1 },
    amountAtomic: "32000000",
    scriptPublicKey: stagingKey.scriptPublicKey,
    address: stagingKey.address,
    blockDaaScore: "123",
    keyReference: stagingKey.keyReference,
    evidenceDigest: digest("journal-verified-staging"),
  };

  const exactBuilder = new Kip10ExactTransactionBuilder({
    keyStore,
    now: () => NOW,
  });
  const exactBuilt = await exactBuilder.build({
    purchaseId,
    paymentIdentifier,
    request: {
      network: "kaspa:testnet-10",
      amount: "20000000",
      payTo: MERCHANT_ADDRESS,
      requestHash: "44".repeat(32),
      requiredFinality: "accepted",
      fundingSource: "vault-treasury",
      reservation: {
        templateId: "kaspa-x402-kip10-additive-v1",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        borrowOutpoint: { txid: BORROW_TXID, index: 0 },
        borrowAmount: "100000000",
        borrowScriptPublicKey: BORROW_SCRIPT_PUBLIC_KEY,
        borrowRedeemScript: BORROW_REDEEM_SCRIPT,
        additiveThresholdSompi: "10000000",
        paymentOutputIndex: 1,
        reservationId: "55".repeat(32),
        reservationExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
    staging: {
      outpoint: staging.outpoint,
      amountAtomic: staging.amountAtomic,
      scriptPublicKey: staging.scriptPublicKey,
      address: staging.address,
      blockDaaScore: staging.blockDaaScore,
      keyReference: staging.keyReference,
    },
    additionalCostCeilingAtomic: "12050000",
    stagingTransactionFeeAtomic: "50000",
  });

  const mempoolLookups = [];
  const rpc = {
    getServerInfo: async () => ({
      isSynced: true,
      hasUtxoIndex: true,
      networkId: "testnet-10",
      virtualDaaScore: 1_000n,
    }),
    getUtxosByAddresses: async () => ({
      entries: [utxoEntry(
        `${staging.outpoint.txid}:${staging.outpoint.index}`,
        staging.amountAtomic,
        staging.scriptPublicKey,
        staging.blockDaaScore
      )],
    }),
    getMempoolEntry: async ({ transactionId }) => {
      mempoolLookups.push(transactionId);
      throw new Error("Method not found");
    },
  };

  const rpcSource = new RpcStagingRecoveryRaceSource({
    rpc: { client: async () => rpc },
    now: () => NOW,
  });
  let rawEvidence;
  const submissionCalls = [];
  const recovery = new AbandonedStagingRecovery({
    keyStore,
    recoveryAddress: addressForPrivateKey(RECOVERY_PRIVATE_KEY, PrivateKey),
    observer: {
      observeRace: async (request) => {
        rawEvidence = await rpcSource.observeRace(request);
        return rawEvidence;
      },
    },
    // This is the external-effect boundary. Capturing it locally proves reachability
    // without sending bytes to a node or risking testnet funds.
    submitter: {
      submitRecovery: async (request) => {
        submissionCalls.push(request);
        return { transactionId: request.transactionId };
      },
    },
    now: () => NOW,
  });

  const prepared = await recovery.prepare({
    purchaseId,
    paymentIdentifier,
    staging,
    exactPayment: {
      mode: "exact_candidate",
      candidate: {
        transaction: exactBuilt.transaction,
        transactionEncoding: exactBuilt.transactionEncoding,
        transactionId: exactBuilt.transactionId,
        merchantOutputIndex: 1,
      },
    },
  });
  const observed = await recovery.observe(prepared.preparedBytes);

  assert.equal(mempoolLookups.length, 2);
  assert.equal(rawEvidence.staging.status, "unspent");
  assert.equal(rawEvidence.exactPayment.status, "absent");
  assert.equal(rawEvidence.recovery.status, "absent");
  assert.equal(observed.status, "safe_to_submit");

  const submitted = await recovery.submit(prepared.preparedBytes, observed.readiness);
  assert.equal(submitted.status, "accepted");
  assert.equal(submissionCalls.length, 1);

  let replayRejected = false;
  try {
    await recovery.submit(prepared.preparedBytes, observed.readiness);
  } catch (error) {
    replayRejected = /already consumed/.test(String(error));
  }
  assert.equal(replayRejected, true);
  assert.equal(submissionCalls.length, 1);

  console.log(`[+] affected revision: ${AFFECTED_REVISION}`);
  console.log("[+] injected RPC error: Method not found");
  console.log(`[+] mempool lookups classified: ${mempoolLookups.length}`);
  console.log(`[+] exact payment observation: ${rawEvidence.exactPayment.status}`);
  console.log(`[+] recovery observation: ${rawEvidence.recovery.status}`);
  console.log(`[+] staging observation: ${rawEvidence.staging.status}`);
  console.log(`[+] recovery decision: ${observed.status}`);
  console.log(`[+] external-effect seam calls: ${submissionCalls.length}`);
  console.log(`[+] readiness replay rejected: ${replayRejected}`);
  console.log("[+] no network connection or blockchain submission was performed");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function utxoEntry(outpoint, amountAtomic, scriptPublicKey, blockDaaScore) {
  const [transactionId, index] = outpoint.split(":");
  return {
    outpoint: { transactionId, index: Number(index) },
    amount: BigInt(amountAtomic),
    scriptPublicKey: { version: 0, script: scriptPublicKey.slice(4) },
    blockDaaScore: BigInt(blockDaaScore),
    isCoinbase: false,
  };
}

function addressForPrivateKey(privateKeyHex, PrivateKeyClass) {
  const privateKey = new PrivateKeyClass(privateKeyHex);
  const address = privateKey.toAddress("testnet-10");
  try {
    return address.toString();
  } finally {
    address.free();
    privateKey.free();
  }
}

function digest(value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
}
