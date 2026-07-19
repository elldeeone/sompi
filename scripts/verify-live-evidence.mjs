#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalEvidence = path.join(root, "evidence", "live-testnet10");
const currentEvidence = path.join(root, "evidence", "generic-x402-cutover");
const historicalExpected = Object.freeze({
  "standard-native.json": Object.freeze({
    digest: "b17898cc726f46e8ee35bbad07c800e19117536350996f7600b0006bb688e1a8",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2",
  }),
  "additive.json": Object.freeze({
    digest: "4dd59afa4b64c62d52bf6674783ccd6f2ba9e5a5e521fc78357f1a2efd2202f2",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2",
  }),
  "batch.json": Object.freeze({
    digest: "8736ece032a8c2e517169319edf91c30a50f87de97f89ce47b22868be0fbb7f1",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-batch:1",
  }),
  "additive-contention.json": Object.freeze({
    digest: "5198dadb90fde6249831418d6ac475ce36cb959c0d468f289415f9d8a3a8e42e",
    profile: "urn:sompi:e2e:live-testnet10-additive-contention:1",
  }),
  "human-present-standard-native.json": Object.freeze({
    digest: "d550766dbe1a161566b310500192a81adfe0213bc3e6f561c652600fcf3558bd",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2",
  }),
});

for (const [filename, contract] of Object.entries(historicalExpected)) {
  const bytes = fs.readFileSync(path.join(historicalEvidence, filename));
  const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const encoded = JSON.stringify(report);
  const digest = createHash("sha256").update(encoded).digest("hex");
  if (
    digest !== contract.digest ||
    report.profile !== contract.profile ||
    report.network !== "kaspa:testnet-10" ||
    /(?:0\.1\.0-alpha\.6|kaspa-exact-v1|borrowInventory|privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) {
    throw new Error(`historical live Testnet-10 evidence ${filename} is invalid`);
  }
}

const historicalStandard = readHistorical("standard-native.json");
if (
  historicalStandard.exactProfile !== "standard-native" ||
  historicalStandard.purchaseIngress !== "http-api" ||
  historicalStandard.economics?.merchantGainAtomic !== historicalStandard.economics?.advertisedAmountAtomic ||
  historicalStandard.economics?.transactionVersion !== 0
) throw new Error("standard-native live evidence invariants changed");

const historicalAdditive = readHistorical("additive.json");
if (
  historicalAdditive.exactProfile !== "additive" ||
  historicalAdditive.purchaseIngress !== "mcp-api-compatibility" ||
  historicalAdditive.economics?.merchantGainAtomic !== historicalAdditive.economics?.advertisedAmountAtomic ||
  historicalAdditive.economics?.transactionVersion !== 1 ||
  historicalAdditive.economics?.outputCount !== 1
) throw new Error("additive live evidence invariants changed");

const historicalBatch = readHistorical("batch.json");
if (
  historicalBatch.claimChannel?.purchases?.length !== 2 ||
  historicalBatch.claimChannel?.chargedCumulativeAtomic !== "12000000" ||
  historicalBatch.claimChannel?.continuation?.amountAtomic !== "28000000" ||
  historicalBatch.refundChannel?.refundOutput?.amountAtomic !== "38000000" ||
  BigInt(historicalBatch.refundChannel?.observedAfterBoundaryDaa ?? 0) <=
    BigInt(historicalBatch.refundChannel?.refundTimeoutDaa ?? 0)
) throw new Error("batch live evidence invariants changed");

const contention = readHistorical("additive-contention.json");
if (
  contention.assertions?.oneWinner !== true ||
  contention.assertions?.loserPaidNothing !== true ||
  contention.assertions?.trustedAbsenceBeforeRetry !== true ||
  contention.assertions?.noAutomaticCorrectiveResigning !== true ||
  contention.explicitRetry?.separatelyAuthorized !== true ||
  contention.winner?.transactionId === contention.explicitRetry?.transactionId
) throw new Error("additive contention live evidence invariants changed");

const humanPresent = readHistorical("human-present-standard-native.json");
if (
  humanPresent.exactProfile !== "standard-native" ||
  humanPresent.purchaseIngress !== "http-api" ||
  humanPresent.purchase?.state !== "receipted" ||
  humanPresent.ap2HumanPresentConformanceClaimed !== true ||
  humanPresent.authorityMode !== "separate-process-human-present" ||
  humanPresent.authorityIsolationAppliedToThisRun !== true ||
  humanPresent.separateAuthorityIsolationProofAvailable !== true ||
  humanPresent.economics?.merchantGainAtomic !== humanPresent.economics?.advertisedAmountAtomic ||
  humanPresent.economics?.transactionVersion !== 0
) throw new Error("human-present standard-native live evidence invariants changed");

const currentExpected = Object.freeze({
  "standard-native.json": Object.freeze({
    digest: "219511a816da502555b52d02189c243ef48329637ac29178a308a364a0afa377",
    profile: "urn:sompi:evidence:generic-x402-cutover:1",
  }),
  "additive.json": Object.freeze({
    digest: "54409a9bb062ddbc234bf6efe38a3afbbb883f47c8c88bb97a070f4c9f33b3e3",
    profile: "urn:sompi:evidence:generic-x402-cutover:1",
  }),
  "batch.json": Object.freeze({
    digest: "238a21c0543278835145a782637a56834d4b1d82ff6097d4da2703244943ad68",
    profile: "urn:sompi:evidence:generic-x402-cutover:1",
  }),
  "terah-standard-native-recovery.json": Object.freeze({
    digest: "fdecaed6effa12495f2e8ec5efba1ae7423b959a56b7d4cac70b294e7991ec5b",
    profile: "urn:sompi:evidence:terah-alpha8-canary:1",
  }),
});
for (const [filename, contract] of Object.entries(currentExpected)) {
  const report = readCurrent(filename);
  const encoded = JSON.stringify(report);
  if (
    createHash("sha256").update(encoded).digest("hex") !== contract.digest ||
    report.profile !== contract.profile ||
    report.network !== "kaspa:testnet-10" ||
    report.merchantProfile !== "generic-x402" ||
    report.privateMaterialIncluded !== false ||
    /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) throw new Error(`generic x402 cutover evidence ${filename} is invalid`);
}
const currentStandard = readCurrent("standard-native.json");
const currentAdditive = readCurrent("additive.json");
const currentBatch = readCurrent("batch.json");
const terahRecovery = readCurrent("terah-standard-native-recovery.json");
if (
  currentStandard.exactProfile !== "standard-native" ||
  currentStandard.purchaseIngress !== "http-api" ||
  currentStandard.purchaseState !== "receipted" ||
  currentStandard.merchantGainAtomic !== currentStandard.advertisedAmountAtomic ||
  currentStandard.transactionVersion !== 0 ||
  currentAdditive.exactProfile !== "additive" ||
  currentAdditive.purchaseIngress !== "mcp-api-compatibility" ||
  currentAdditive.purchaseState !== "receipted" ||
  currentAdditive.merchantGainAtomic !== currentAdditive.advertisedAmountAtomic ||
  currentAdditive.transactionVersion !== 1 ||
  currentBatch.paymentScheme !== "batch-settlement" ||
  currentBatch.authorizedCharges !== 2 ||
  currentBatch.strictBoundarySatisfied !== true ||
  BigInt(currentBatch.observedAfterBoundaryDaa ?? 0) <= BigInt(currentBatch.refundTimeoutDaa ?? 0) ||
  terahRecovery.profile !== "urn:sompi:evidence:terah-alpha8-canary:1" ||
  terahRecovery.exactProfile !== "standard-native" ||
  terahRecovery.purchaseIngress !== "hermes-telegram-skill" ||
  terahRecovery.authorityMode !== "separate-process-human-present-telegram" ||
  terahRecovery.purchaseState !== "receipted" ||
  terahRecovery.initialSubmissionOutcome !== "ambiguous" ||
  terahRecovery.recoveryOutcome !== "exact-payment-won" ||
  terahRecovery.checkoutExpiredBeforeRecovery !== true ||
  terahRecovery.sameSignedPaymentReplayed !== true ||
  terahRecovery.paymentTransactionCount !== 1 ||
  terahRecovery.stagingRecoveryBroadcast !== false ||
  terahRecovery.fulfilmentRecovered !== true ||
  terahRecovery.receiptRecorded !== true
) throw new Error("generic x402 cutover evidence invariants changed");

process.stdout.write("Generic x402 cutover and historical TN10 evidence passed.\n");

function readHistorical(filename) {
  return JSON.parse(fs.readFileSync(path.join(historicalEvidence, filename), "utf8"));
}

function readCurrent(filename) {
  return JSON.parse(fs.readFileSync(path.join(currentEvidence, filename), "utf8"));
}
