import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateOwnerKey } from "../vault.js";
import {
  installOperatorCandidate,
  operatorProvisioningStatus,
  parseOperatorProvisioningSpec,
  previewOperatorProvisioning,
  provisionOperatorCandidate,
} from "./provisioning.js";

test("preview is side-effect free and provision/install binds one approved candidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-operator-provision-"));
  fs.chmodSync(root, 0o700);
  const dataDirectory = path.join(root, "runtime-data");
  const manifestPath = path.join(root, "operator", "manifest.json");
  const bundle = path.join(root, "candidate");
  const spec = fixtureSpec(dataDirectory);
  try {
    const preview = previewOperatorProvisioning(spec);
    assert.equal(preview.dataDirectory, dataDirectory);
    assert.equal(fs.existsSync(dataDirectory), false);
    const candidate = provisionOperatorCandidate(spec, bundle);
    assert.match(candidate.digest, /^sha256:/);
    assert.equal(fs.existsSync(dataDirectory), false);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    const installed = installOperatorCandidate(bundle, manifestPath, candidate.digest, {
      operatorUserId: uid,
      runtimeUserId: uid,
      runtimeGroupId: gid,
      allowSameUserForTests: true,
    });
    assert.equal(installed.identity.digest, candidate.digest);
    assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDirectory, "vault", "agent-key")).mode & 0o777, 0o600);
    assert.deepEqual(operatorProvisioningStatus(manifestPath, {
      operatorUserId: uid,
      runtimeGroupId: gid,
      allowSameUserForTests: true,
    }), {
      status: "ready",
      revision: 1,
      digest: candidate.digest,
      networkId: "testnet-10",
      dataDirectory,
      vaultAddress: candidate.vaultAddress,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("install refuses an unapproved digest, static vault drift, and replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-operator-reject-"));
  fs.chmodSync(root, 0o700);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const options = { operatorUserId: uid, runtimeUserId: uid, runtimeGroupId: gid, allowSameUserForTests: true };
  try {
    const firstData = path.join(root, "first-data");
    const firstBundle = path.join(root, "first-bundle");
    const first = provisionOperatorCandidate(fixtureSpec(firstData), firstBundle);
    assert.throws(() => installOperatorCandidate(firstBundle, path.join(root, "operator", "manifest.json"), "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", options), /digest/);
    fs.writeFileSync(path.join(firstBundle, "runtime-data", "vault", "config.json"), "{}", { mode: 0o600 });
    assert.throws(() => installOperatorCandidate(firstBundle, path.join(root, "operator", "manifest.json"), first.digest, options), /candidate|vault|config/i);

    const secondData = path.join(root, "second-data");
    const secondBundle = path.join(root, "second-bundle");
    const second = provisionOperatorCandidate(fixtureSpec(secondData), secondBundle);
    fs.mkdirSync(secondData, { mode: 0o700 });
    assert.throws(() => installOperatorCandidate(secondBundle, path.join(root, "other", "manifest.json"), second.digest, options), /target already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureSpec(dataDirectory: string) {
  return parseOperatorProvisioningSpec({
    schema: "sompi-operator-provisioning-v1",
    revision: 1,
    dataDirectory,
    ownerPublic: generateOwnerKey().publicKey,
    maxOutflowSompi: "500000000",
    windowSizeDaa: "36000",
    treasury: {
      maxSompiPerTx: "100000000", maxSompiPerHour: "500000000", allowlist: [],
      requireApprovalAboveSompi: "0", additionalCostCeilingAtomic: "25000000",
      operationFeeCeilingAtomic: "25000000",
    },
    merchant: {
      allowRules: [{ hostname: "merchant.example", ports: [443] }],
      merchantReceiptIssuer: "receipt:merchant", paymentReceiptIssuer: "receipt:payment",
    },
    chainEvidence: {
      operatorNodeUrl: "ws://10.0.3.26:17210/", witnessBaseUrl: "https://api-tn10.kaspa.org/",
      depthConfirmationDaa: "10",
      finalityFloors: { settlement: "depth-confirmed", directTreasury: "accepted", vault: "accepted", staging: "accepted", recoveryRelease: "depth-confirmed" },
    },
    admission: { authorityPreauthSockets: 32, authorityPrompts: 4, prevalidationPurchases: 128, evidenceBytes: 67108864, directTreasuryRetries: 3 },
  });
}
