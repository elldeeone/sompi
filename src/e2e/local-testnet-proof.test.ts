import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  LOCAL_TESTNET_PROOF_PROFILE,
  runLocalTestnetProof,
  writeLocalTestnetProofReport,
} from "./local-testnet-proof.js";

test("deterministic local Testnet-10 proof joins AP2, x402, Settlement, Fulfilment, and Receipts", async () => {
  const report = await runLocalTestnetProof();
  assert.equal(report.profile, LOCAL_TESTNET_PROOF_PROFILE);
  assert.equal(report.purchase.state, "receipted");
  assert.equal(report.chainMode, "deterministic-in-memory-testnet10");
  assert.equal(report.liveNetworkConformanceClaimed, false);
  assert.equal(report.initiationMode, "direct-purchase-module");
  assert.equal(report.idempotency.stagingSubmissions, 1);
  assert.equal(report.idempotency.exactMerchantAcceptances, 1);
  assert.deepEqual(report.protocolSeparation.paidRequestExtensionKeys, [
    "payment-identifier",
  ]);
  assert.equal(report.protocolSeparation.ap2DataInX402Request, false);
  assert.equal(report.recovery.restartCount, 0);
  assert.match(report.transactions.stagingOutpoint, /^[a-f0-9]{64}:0$/);
  assert.match(report.transactions.merchantOutpoint, /^[a-f0-9]{64}:0$/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-e2e-report-"));
  const filename = path.join(directory, "evidence", "proof.json");
  try {
    writeLocalTestnetProofReport(filename, report);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), report);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    const serialized = fs.readFileSync(filename, "utf8");
    for (const forbidden of ["privateKey", "signedEvidence", "mandateArtifact", "rawCredential"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local proof chain observations use the proof clock", async () => {
  const report = await runLocalTestnetProof({
    now: () => 1_700_000_000_000,
  });
  assert.equal(report.purchase.state, "receipted");
});

test("local vertical can be initiated through the real MCP SDK transport", async () => {
  const report = await runLocalTestnetProof({
    initiationMode: "mcp-sdk-in-memory-transport",
  });
  assert.equal(report.purchase.state, "receipted");
  assert.equal(report.initiationMode, "mcp-sdk-in-memory-transport");
  assert.equal(report.idempotency.duplicatePurchaseReturnedSameId, true);
});

test("real vertical crash points restart without a second staging or Merchant payment", async () => {
  for (const faultPoint of [
    "payment_preparation.after_insert",
    "settlement.after_insert",
    "fulfilment.after_insert",
  ] as const) {
    const report = await runLocalTestnetProof({ faultPoint });
    assert.equal(report.purchase.state, "receipted", faultPoint);
    assert.equal(report.recovery.restartCount, 1, faultPoint);
    assert.equal(report.recovery.injectedFaultPoint, faultPoint);
    assert.equal(report.idempotency.stagingSubmissions, 1, faultPoint);
    assert.equal(report.idempotency.exactMerchantAcceptances, 1, faultPoint);
  }
});

test("submitted staging recovers by observation", async () => {
  const staging = await runLocalTestnetProof({ stagingVisibleOnSubmit: false });
  assert.equal(staging.recovery.restartCount, 1);
  assert.equal(staging.idempotency.stagingSubmissions, 1);
  assert.equal(staging.idempotency.exactMerchantAcceptances, 1);
});
