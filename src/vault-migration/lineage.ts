import type { OperatorManifest, OperatorManifestIdentity } from "../operator/manifest.js";
import type { PurchaseJournal, VaultMigrationJournalRecord } from "../purchase/journal.js";
import {
  type VaultManager,
  vaultStaticConfigurationDigest,
  vaultStaticConfigurationDigestFromFacts,
} from "../vault.js";

/**
 * Verify the active vault from the immutable Operator Manifest plus every
 * owner-approved Journal migration. This is the only startup exception to the
 * original manifest vault digest.
 */
export function assertVaultConfigurationLineage(input: Readonly<{
  vault: VaultManager;
  journal: Pick<PurchaseJournal, "vaultMigrationLineage">;
  manifestVault: OperatorManifest["vault"];
  manifestIdentity: OperatorManifestIdentity;
}>): void {
  const actual = input.vault.config();
  const manifest = input.manifestVault;
  if (
    actual.template !== manifest.template ||
    actual.ownerPublic !== manifest.ownerPublic ||
    actual.agentPublic !== manifest.agentPublic ||
    actual.windowSizeDaa !== manifest.windowSizeDaa
  ) throw new Error("provisioned vault identity does not match the Operator Manifest");

  let expectedDigest = manifest.configDigest;
  let expectedMaximum = manifest.maxOutflowSompi;
  let active: VaultMigrationJournalRecord | undefined;
  for (const migration of input.journal.vaultMigrationLineage()) {
    if (
      migration.manifestRevision !== input.manifestIdentity.revision ||
      migration.manifestDigest !== input.manifestIdentity.digest ||
      migration.oldVaultDigest !== expectedDigest ||
      migration.oldMaximumOutflowAtomic !== expectedMaximum ||
      migration.windowSizeDaa !== manifest.windowSizeDaa ||
      !migration.authorityId ||
      !migration.authorityEvidenceDigest
    ) throw new Error("Vault Migration lineage is not bound to the installed Operator Manifest");

    const nextDigest = vaultStaticConfigurationDigestFromFacts({
      template: manifest.template,
      agentPublic: manifest.agentPublic,
      ownerPublic: manifest.ownerPublic,
      maxOutflowSompi: migration.newMaximumOutflowAtomic,
      windowSizeDaa: manifest.windowSizeDaa,
    });
    if (migration.state === "applied") {
      if (!migration.receiptDigest || !migration.recoveryTransactionId || !migration.replacementTransactionId) {
        throw new Error("applied Vault Migration has no complete receipt evidence");
      }
      expectedDigest = nextDigest;
      expectedMaximum = migration.newMaximumOutflowAtomic;
      continue;
    }
    if (active) throw new Error("more than one Vault Migration is executing");
    active = migration;
  }

  const actualDigest = vaultStaticConfigurationDigest(actual);
  if (actualDigest === expectedDigest && actual.maxOutflowSompi === expectedMaximum) return;
  if (active) {
    const fence = input.vault.migrationFence();
    const activeDigest = vaultStaticConfigurationDigestFromFacts({
      template: manifest.template,
      agentPublic: manifest.agentPublic,
      ownerPublic: manifest.ownerPublic,
      maxOutflowSompi: active.newMaximumOutflowAtomic,
      windowSizeDaa: manifest.windowSizeDaa,
    });
    if (
      fence?.state === "active" &&
      fence.migrationId === active.id &&
      fence.oldVaultDigest === active.oldVaultDigest &&
      actualDigest === activeDigest &&
      actual.maxOutflowSompi === active.newMaximumOutflowAtomic
    ) return;
  }
  throw new Error("provisioned vault does not match the Operator Manifest and approved Vault Migration lineage");
}

/** Close the local migration fence after an applied Journal commit survived a crash. */
export function reconcileAppliedVaultMigrationFence(input: Readonly<{
  vault: VaultManager;
  journal: Pick<PurchaseJournal, "vaultMigration">;
}>): void {
  const fence = input.vault.migrationFence();
  if (!fence || fence.state === "applied") return;
  const migration = input.journal.vaultMigration(fence.migrationId);
  if (
    (migration.state === "awaiting_owner" || migration.state === "expired") &&
    migration.oldVaultDigest === fence.oldVaultDigest
  ) {
    input.vault.abortMigration(migration.id, migration.oldVaultDigest);
    return;
  }
  if (migration.state !== "applied" || migration.oldVaultDigest !== fence.oldVaultDigest) {
    throw new Error("active Vault Migration fence still requires reconciliation");
  }
  input.vault.finishMigration(migration.id, migration.oldVaultDigest);
}
