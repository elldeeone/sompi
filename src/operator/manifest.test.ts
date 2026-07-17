import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { VaultManager, generateOwnerKey, vaultStaticConfigurationDigest } from "../vault.js";
import {
  OperatorManifestError,
  canonicalOperatorManifestBytes,
  loadOperatorManifest,
  operatorManifestIdentity,
  operatorPolicy,
  parseOperatorManifest,
  publishOperatorManifestForTests,
} from "./manifest.js";

test("Operator Manifest is exact, canonical, immutable, and projects one policy", () => {
  const fixture = manifestFixture();
  try {
    const manifest = parseOperatorManifest(fixture.value);
    const identity = operatorManifestIdentity(manifest);
    assert.equal(identity.revision, 1);
    assert.match(identity.digest, /^sha256:[A-Za-z0-9_-]{43}$/);
    assert.equal(Object.isFrozen(manifest), true);
    assert.equal(Object.isFrozen(manifest.chainEvidence.finalityFloors), true);
    assert.equal(canonicalOperatorManifestBytes(manifest).toString("utf8"), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(operatorPolicy(manifest), {
      maxSompiPerTx: 100_000_000n,
      maxSompiPerHour: 500_000_000n,
      allowlist: [],
      requireApprovalAboveSompi: 0n,
    });
  } finally {
    fixture.close();
  }
});

test("Operator Manifest rejects authority, transport, finality, key, and shape substitutions", () => {
  const fixture = manifestFixture();
  try {
    const cases: Array<[string, unknown, RegExp]> = [
      ["unknown field", { ...fixture.value, legacy: true }, /unknown or missing/],
      ["zero owner key", { ...fixture.value, vault: { ...fixture.value.vault, ownerPublic: "00".repeat(32) } }, /owner public key is invalid/],
      ["bad Agent key", { ...fixture.value, vault: { ...fixture.value.vault, agentPublic: "ff".repeat(32) } }, /Agent public key is invalid/],
      ["cleartext witness", { ...fixture.value, chainEvidence: { ...fixture.value.chainEvidence, witnessBaseUrl: "http://witness.example/" } }, /unsafe scheme/],
      ["credentialed node", { ...fixture.value, chainEvidence: { ...fixture.value.chainEvidence, operatorNodeUrl: "wss://user:secret@node.example/ws" } }, /unsafe scheme/],
      ["mempool floor", { ...fixture.value, chainEvidence: { ...fixture.value.chainEvidence, finalityFloors: { ...fixture.value.chainEvidence.finalityFloors, settlement: "mempool" } } }, /unsupported/],
      ["HTTP Merchant port shape", { ...fixture.value, merchant: { ...fixture.value.merchant, allowRules: [{ hostname: "merchant.example", ports: [8443, 443] }] } }, /not canonical/],
      ["policy inversion", { ...fixture.value, treasury: { ...fixture.value.treasury, maxSompiPerTx: "600000000" } }, /exceeds hourly/],
      ["same receipt issuer", { ...fixture.value, merchant: { ...fixture.value.merchant, paymentReceiptIssuer: fixture.value.merchant.merchantReceiptIssuer } }, /must be distinct/],
    ];
    for (const [name, value, pattern] of cases) {
      assert.throws(() => parseOperatorManifest(value), pattern, name);
    }
  } finally {
    fixture.close();
  }
});

test("runtime manifest loading pins the exact regular file and fails closed on filesystem substitution", () => {
  const fixture = manifestFixture();
  const manifestPath = path.join(fixture.root, "operator", "manifest.json");
  try {
    const loaded = publishOperatorManifestForTests(manifestPath, fixture.value);
    assert.equal(loaded.filename, manifestPath);
    assert.deepEqual(loaded.identity, operatorManifestIdentity(loaded.manifest));

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    assert.throws(
      () => loadOperatorManifest(manifestPath, { expectedOperatorUserId: uid, runtimeGroupId: gid }),
      /owner must differ/
    );

    assert.equal(
      loadOperatorManifest(manifestPath, {
        expectedOperatorUserId: uid,
        runtimeGroupId: gid,
        allowSameUserForTests: true,
        readerRole: "operator",
      }).identity.digest,
      loaded.identity.digest
    );

    fs.chmodSync(manifestPath, 0o640);
    assert.throws(() => testLoad(manifestPath), /ownership, mode/);
    fs.chmodSync(manifestPath, 0o600);

    const alias = path.join(fixture.root, "manifest-alias");
    fs.linkSync(manifestPath, alias);
    assert.throws(() => testLoad(manifestPath), /link count/);
    fs.unlinkSync(alias);

    const original = fs.readFileSync(manifestPath);
    fs.writeFileSync(manifestPath, `${original.toString("utf8").trim()}\n\n`, { mode: 0o600 });
    assert.throws(() => testLoad(manifestPath), /not canonical/);
    fs.writeFileSync(manifestPath, original, { mode: 0o600 });

    const outside = path.join(fixture.root, "outside-manifest");
    fs.renameSync(manifestPath, outside);
    fs.symlinkSync(outside, manifestPath);
    assert.throws(() => testLoad(manifestPath), OperatorManifestError);
  } finally {
    fixture.close();
  }
});

function testLoad(filename: string) {
  return loadOperatorManifest(filename, {
    expectedOperatorUserId: typeof process.getuid === "function" ? process.getuid() : 0,
    runtimeGroupId: typeof process.getgid === "function" ? process.getgid() : 0,
    allowSameUserForTests: true,
  });
}

function manifestFixture(): {
  root: string;
  value: ReturnType<typeof buildManifestValue>;
  close(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-operator-manifest-"));
  fs.chmodSync(root, 0o700);
  const dataDirectory = path.join(root, "data");
  const vault = new VaultManager(dataDirectory, "testnet-10");
  const config = vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
  const configDigest = vaultStaticConfigurationDigest(config);
  return {
    root,
    value: buildManifestValue(dataDirectory, config, configDigest),
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function buildManifestValue(
  dataDirectory: string,
  config: ReturnType<VaultManager["create"]>,
  configDigest: string
) {
  return {
    schema: "sompi-operator-manifest-v1",
    revision: 1,
    networkId: "testnet-10",
    x402Network: "kaspa:testnet-10",
    dataDirectory,
    vault: {
      template: config.template,
      ownerPublic: config.ownerPublic,
      agentPublic: config.agentPublic,
      address: config.address,
      configDigest,
      maxOutflowSompi: config.maxOutflowSompi,
      windowSizeDaa: config.windowSizeDaa,
    },
    treasury: {
      maxSompiPerTx: "100000000",
      maxSompiPerHour: "500000000",
      allowlist: [],
      requireApprovalAboveSompi: "0",
      additionalCostCeilingAtomic: "25000000",
      operationFeeCeilingAtomic: "25000000",
    },
    merchant: {
      allowRules: [{ hostname: "merchant.example", ports: [443, 8443] }],
      merchantReceiptIssuer: "receipt:merchant",
      paymentReceiptIssuer: "receipt:payment",
    },
    batch: { claimFeeReserveAtomic: "100000" },
    chainEvidence: {
      operatorNodeUrl: "ws://10.0.3.26:17210/",
      witnessBaseUrl: "https://api-tn10.kaspa.org/",
      depthConfirmationDaa: "10",
      finalityFloors: {
        settlement: "depth-confirmed",
        directTreasury: "accepted",
        vault: "accepted",
        staging: "accepted",
        recoveryRelease: "depth-confirmed",
      },
    },
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
  } as const;
}
