#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.join(root, "evidence", "live-testnet10");
const expected = Object.freeze({
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
});

for (const [filename, contract] of Object.entries(expected)) {
  const bytes = fs.readFileSync(path.join(evidence, filename));
  const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const encoded = JSON.stringify(report);
  const digest = createHash("sha256").update(encoded).digest("hex");
  if (
    digest !== contract.digest ||
    report.profile !== contract.profile ||
    report.network !== "kaspa:testnet-10" ||
    /(?:0\.1\.0-alpha\.6|kaspa-exact-v1|borrowInventory|privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) {
    throw new Error(`live Testnet-10 evidence ${filename} is invalid`);
  }
}

const standard = read("standard-native.json");
if (
  standard.exactProfile !== "standard-native" ||
  standard.purchaseIngress !== "http-api" ||
  standard.economics?.merchantGainAtomic !== standard.economics?.advertisedAmountAtomic ||
  standard.economics?.transactionVersion !== 0
) throw new Error("standard-native live evidence invariants changed");

const additive = read("additive.json");
if (
  additive.exactProfile !== "additive" ||
  additive.purchaseIngress !== "mcp-api-compatibility" ||
  additive.economics?.merchantGainAtomic !== additive.economics?.advertisedAmountAtomic ||
  additive.economics?.transactionVersion !== 1 ||
  additive.economics?.outputCount !== 1
) throw new Error("additive live evidence invariants changed");

const batch = read("batch.json");
if (
  batch.claimChannel?.purchases?.length !== 2 ||
  batch.claimChannel?.chargedCumulativeAtomic !== "12000000" ||
  batch.claimChannel?.continuation?.amountAtomic !== "28000000" ||
  batch.refundChannel?.refundOutput?.amountAtomic !== "38000000" ||
  BigInt(batch.refundChannel?.observedAfterBoundaryDaa ?? 0) <=
    BigInt(batch.refundChannel?.refundTimeoutDaa ?? 0)
) throw new Error("batch live evidence invariants changed");

const contention = read("additive-contention.json");
if (
  contention.assertions?.oneWinner !== true ||
  contention.assertions?.loserPaidNothing !== true ||
  contention.assertions?.trustedAbsenceBeforeRetry !== true ||
  contention.assertions?.noAutomaticCorrectiveResigning !== true ||
  contention.explicitRetry?.separatelyAuthorized !== true ||
  contention.winner?.transactionId === contention.explicitRetry?.transactionId
) throw new Error("additive contention live evidence invariants changed");

process.stdout.write("Alpha.8 live Testnet-10 evidence passed.\n");

function read(filename) {
  return JSON.parse(fs.readFileSync(path.join(evidence, filename), "utf8"));
}
