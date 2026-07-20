import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { OperatorManifestIdentity } from "../operator/manifest.js";
import type { VaultMigrationJournalRecord } from "../purchase/journal.js";
import { generateOwnerKey, VaultManager, vaultStaticConfigurationDigest } from "../vault.js";
import {
  assertVaultConfigurationLineage,
  reconcileAppliedVaultMigrationFence,
} from "./lineage.js";

const IDENTITY: OperatorManifestIdentity = Object.freeze({ revision: 1, digest: `sha256:${"A".repeat(43)}` });

test("runtime vault identity follows only the approved ordered migration lineage", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-lineage-"));
  fs.chmodSync(directory, 0o700);
  try {
    const vault = new VaultManager(directory, "testnet-10");
    const original = vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
    const manifestVault = Object.freeze({
      template: original.template,
      ownerPublic: original.ownerPublic,
      agentPublic: original.agentPublic,
      address: vault.initialAddress(),
      configDigest: vaultStaticConfigurationDigest(original),
      maxOutflowSompi: original.maxOutflowSompi,
      windowSizeDaa: original.windowSizeDaa,
    });
    const records: VaultMigrationJournalRecord[] = [];
    const journal = { vaultMigrationLineage: () => Object.freeze([...records]) };
    assert.doesNotThrow(() => assertVaultConfigurationLineage({ vault, journal, manifestVault, manifestIdentity: IDENTITY }));

    const firstId = "vmg_AAAAAAAAAAAAAAAAAAAAAA";
    const firstOldDigest = vaultStaticConfigurationDigest(vault.config());
    vault.beginMigration(firstId, firstOldDigest);
    vault.activateReplacement(firstId, firstOldDigest, 1_000_000_000n);
    records.push(record(firstId, firstOldDigest, "500000000", "1000000000", "executing", 1));
    assert.doesNotThrow(() => assertVaultConfigurationLineage({ vault, journal, manifestVault, manifestIdentity: IDENTITY }));
    vault.finishMigration(firstId, firstOldDigest);
    records[0] = record(firstId, firstOldDigest, "500000000", "1000000000", "applied", 1);
    assert.doesNotThrow(() => assertVaultConfigurationLineage({ vault, journal, manifestVault, manifestIdentity: IDENTITY }));

    const secondId = "vmg_BBBBBBBBBBBBBBBBBBBBBB";
    const secondOldDigest = vaultStaticConfigurationDigest(vault.config());
    vault.beginMigration(secondId, secondOldDigest);
    vault.activateReplacement(secondId, secondOldDigest, 2_000_000_000n);
    records.push(record(secondId, secondOldDigest, "1000000000", "2000000000", "reconciliation_required", 2));
    assert.doesNotThrow(() => assertVaultConfigurationLineage({ vault, journal, manifestVault, manifestIdentity: IDENTITY }));

    records[1] = { ...records[1]!, oldVaultDigest: `sha256:${"Z".repeat(43)}` as VaultMigrationJournalRecord["oldVaultDigest"] };
    assert.throws(
      () => assertVaultConfigurationLineage({ vault, journal, manifestVault, manifestIdentity: IDENTITY }),
      /lineage/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup closes an active local fence only after the Journal records the migration as applied", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-fence-recovery-"));
  fs.chmodSync(directory, 0o700);
  try {
    const vault = new VaultManager(directory, "testnet-10");
    vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
    const migrationId = "vmg_CCCCCCCCCCCCCCCCCCCCCC";
    const oldDigest = vaultStaticConfigurationDigest(vault.config());
    vault.beginMigration(migrationId, oldDigest);
    vault.activateReplacement(migrationId, oldDigest, 1_000_000_000n);

    const applied = record(migrationId, oldDigest, "500000000", "1000000000", "applied", 1);
    reconcileAppliedVaultMigrationFence({ vault, journal: { vaultMigration: () => applied } });

    assert.equal(vault.migrationFence()?.state, "applied");
    assert.equal(vault.config().maxOutflowSompi, "1000000000");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup keeps sending fenced when the Journal cannot prove the migration was applied", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-fence-closed-"));
  fs.chmodSync(directory, 0o700);
  try {
    const vault = new VaultManager(directory, "testnet-10");
    vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
    const migrationId = "vmg_DDDDDDDDDDDDDDDDDDDDDD";
    const oldDigest = vaultStaticConfigurationDigest(vault.config());
    vault.beginMigration(migrationId, oldDigest);
    vault.activateReplacement(migrationId, oldDigest, 1_000_000_000n);

    const executing = record(migrationId, oldDigest, "500000000", "1000000000", "executing", 1);
    assert.throws(
      () => reconcileAppliedVaultMigrationFence({ vault, journal: { vaultMigration: () => executing } }),
      /requires reconciliation/,
    );
    assert.equal(vault.migrationFence()?.state, "active");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup removes an active fence when the Journal proves execution expired before changing the vault", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-fence-expired-"));
  fs.chmodSync(directory, 0o700);
  try {
    const vault = new VaultManager(directory, "testnet-10");
    vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
    const migrationId = "vmg_EEEEEEEEEEEEEEEEEEEEEE";
    const oldDigest = vaultStaticConfigurationDigest(vault.config());
    vault.beginMigration(migrationId, oldDigest);
    const expired = record(migrationId, oldDigest, "500000000", "1000000000", "expired", 1);

    reconcileAppliedVaultMigrationFence({ vault, journal: { vaultMigration: () => expired } });

    assert.equal(vault.migrationFence(), undefined);
    assert.equal(vault.config().maxOutflowSompi, "500000000");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup removes a fence created before the Journal entered owner execution", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-fence-pre-execution-"));
  fs.chmodSync(directory, 0o700);
  try {
    const vault = new VaultManager(directory, "testnet-10");
    vault.create(500_000_000n, generateOwnerKey().publicKey, 36_000n);
    const migrationId = "vmg_FFFFFFFFFFFFFFFFFFFFFF";
    const oldDigest = vaultStaticConfigurationDigest(vault.config());
    vault.beginMigration(migrationId, oldDigest);
    const awaitingOwner = record(migrationId, oldDigest, "500000000", "1000000000", "awaiting_owner", 1);

    reconcileAppliedVaultMigrationFence({ vault, journal: { vaultMigration: () => awaitingOwner } });

    assert.equal(vault.migrationFence(), undefined);
    assert.equal(vault.config().maxOutflowSompi, "500000000");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function record(
  id: string,
  oldVaultDigest: string,
  oldMaximumOutflowAtomic: string,
  newMaximumOutflowAtomic: string,
  state: VaultMigrationJournalRecord["state"],
  order: number,
): VaultMigrationJournalRecord {
  return Object.freeze({
    id,
    requestKey: `vault:${order}`,
    state,
    oldVaultDigest: oldVaultDigest as VaultMigrationJournalRecord["oldVaultDigest"],
    expectedPolicyDigest: `sha256:${"P".repeat(43)}` as VaultMigrationJournalRecord["expectedPolicyDigest"],
    expectedPolicyGeneration: 1,
    oldMaximumOutflowAtomic,
    newMaximumOutflowAtomic,
    windowSizeDaa: "36000",
    windowStartDaa: "0",
    spentInWindowAtomic: "0",
    stableReceiveAddress: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    manifestRevision: IDENTITY.revision,
    manifestDigest: IDENTITY.digest as VaultMigrationJournalRecord["manifestDigest"],
    expiresAtMs: 2_000_000_000_000,
    authorityId: "owner",
    authorityEvidenceDigest: `sha256:${"B".repeat(43)}` as VaultMigrationJournalRecord["authorityEvidenceDigest"],
    ...(state === "applied" ? {
      recoveryTransactionId: "11".repeat(32),
      replacementTransactionId: "22".repeat(32),
      receiptDigest: `sha256:${"C".repeat(43)}` as VaultMigrationJournalRecord["receiptDigest"],
    } : {}),
    createdAtMs: order,
    updatedAtMs: order,
  });
}
