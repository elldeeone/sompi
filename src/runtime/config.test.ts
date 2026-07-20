import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { publishOperatorManifestForTests } from "../operator/manifest.js";
import { VaultManager, generateOwnerKey, vaultStaticConfigurationDigest } from "../vault.js";
import {
  SompiRuntimeConfigError,
  assertSompiPurchaseRuntimeConfig,
  purchaseRuntimeConfigFromEnv,
  secureRuntimeDirectory,
} from "./config.js";

test("runtime environment accepts only deployment locators and exact Operator Manifest projections", () => {
  const fixture = runtimeFixture();
  try {
    const config = purchaseRuntimeConfigFromEnv(
      fixture.environment,
      fixture.root,
      { allowSameUserOperatorManifestForTests: true }
    );

    assert.equal(config.networkId, "testnet-10");
    assert.equal(config.x402Network, "kaspa:testnet-10");
    assert.equal(config.dataDirectory, fixture.dataDirectory);
    assert.equal(config.nodeUrl, "ws://10.0.3.26:17210/");
    assert.equal(config.witnessBaseUrl, "https://api-tn10.kaspa.org/");
    assert.equal(config.depthConfirmationDaa, "10");
    assert.equal(config.finalityFloors.settlement, "depth-confirmed");
    assert.equal(config.policy.maxSompiPerTx, 100_000_000n);
    assert.deepEqual(config.egressAllowRules, [
      { hostname: "merchant.example", ports: [443, 8443] },
    ]);
    assert.equal(Object.hasOwn(config, "egressProtocols"), false);
    assert.equal(Object.hasOwn(config, "policyPath"), false);
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.operatorManifest.manifest), true);
    assert.equal(fs.statSync(config.dataDirectory).mode & 0o777, 0o700);
    assert.doesNotThrow(() => assertSompiPurchaseRuntimeConfig(config));
  } finally {
    fixture.close();
  }
});

test("removed operator environment fails before creating wallet or journal state", () => {
  const removed = [
    "SOMPI_DATA_DIR",
    "SOMPI_POLICY",
    "SOMPI_NODE_URL",
    "SOMPI_EGRESS_ALLOW",
    "SOMPI_EGRESS_PROTOCOLS",
    "SOMPI_PURCHASE_ADDITIONAL_COST_CEILING",
    "SOMPI_TREASURY_OPERATION_FEE_CEILING",
  ];
  for (const name of removed) {
    const fixture = runtimeFixture();
    try {
      assert.throws(
        () => purchaseRuntimeConfigFromEnv(
          { ...fixture.environment, [name]: "attacker-controlled" },
          fixture.root,
          { allowSameUserOperatorManifestForTests: true }
        ),
        /were removed/
      );
      assert.equal(fs.existsSync(path.join(fixture.dataDirectory, "purchase.sqlite")), false);
      assert.equal(fs.existsSync(path.join(fixture.dataDirectory, "wallet-key")), false);
    } finally {
      fixture.close();
    }
  }
});

test("production configuration rejects a manifest replaceable by the MCP user", () => {
  const fixture = runtimeFixture();
  try {
    assert.throws(
      () => purchaseRuntimeConfigFromEnv(fixture.environment, fixture.root),
      /owner must differ/
    );
  } finally {
    fixture.close();
  }
});

test("programmatic runtime configuration rejects manifest projection drift and unknown fields", () => {
  const fixture = runtimeFixture();
  try {
    const config = purchaseRuntimeConfigFromEnv(
      fixture.environment,
      fixture.root,
      { allowSameUserOperatorManifestForTests: true }
    );
    for (const changed of [
      { ...config, journalDatabase: path.join(fixture.root, "escaped.sqlite") },
      { ...config, unexpected: true },
      { ...config, nodeUrl: "wss://other.example/ws" },
      { ...config, policy: { ...config.policy, maxSompiPerTx: 1n } },
      { ...config, finalityFloors: { ...config.finalityFloors, settlement: "accepted" } },
    ]) {
      assert.throws(() => assertSompiPurchaseRuntimeConfig(changed), SompiRuntimeConfigError);
    }
  } finally {
    fixture.close();
  }
});

test("secure runtime directory rejects a symbolic-link target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-runtime-config-link-"));
  try {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link, "dir");
    assert.throws(() => secureRuntimeDirectory(link), SompiRuntimeConfigError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-runtime-manifest-"));
  fs.chmodSync(root, 0o700);
  const dataDirectory = path.join(root, "data");
  const vault = new VaultManager(dataDirectory, "testnet-10");
  const config = vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
  const configDigest = vaultStaticConfigurationDigest(config);
  const manifestPath = path.join(root, "operator", "manifest.json");
  publishOperatorManifestForTests(manifestPath, {
    schema: "sompi-operator-manifest-v2",
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
      additionalCostCeilingAtomic: "25000000",
      operationFeeCeilingAtomic: "25000000",
    },
    merchant: {
      allowRules: [{ hostname: "merchant.example", ports: [443, 8443] }],
    },
    batch: { claimFeeReserveAtomic: "100000" },
    authority: { provider: "terminal", telegram: null },
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
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return {
    root,
    dataDirectory,
    environment: {
      SOMPI_OPERATOR_MANIFEST: manifestPath,
      SOMPI_OPERATOR_UID: String(uid),
      SOMPI_RUNTIME_GID: String(gid),
      SOMPI_AUTHORITY_SOCKET_UID: String(Math.min(uid + 1, 0x7fffffff)),
      SOMPI_AUTHORITY_SOCKET_GID: String(gid),
    } satisfies NodeJS.ProcessEnv,
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
