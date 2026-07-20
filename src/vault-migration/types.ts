import type { KasAmountView } from "../amount-display.js";
import type { Sha256Digest } from "../purchase/types.js";

export interface VaultMigrationIntent {
  readonly requestKey: string;
  readonly newMaximumOutflowAtomic: string;
}

export interface VaultMigrationFacts {
  readonly profile: "sompi.vault-migration.1";
  readonly vaultMigrationId: string;
  readonly requestKey: string;
  readonly oldVaultDigest: Sha256Digest;
  readonly expectedPolicyDigest: Sha256Digest;
  readonly expectedPolicyGeneration: number;
  readonly oldMaximumOutflowAtomic: string;
  readonly newMaximumOutflowAtomic: string;
  readonly windowSizeDaa: string;
  readonly windowStartDaa: string;
  readonly spentInWindowAtomic: string;
  readonly stableReceiveAddress: string;
  readonly stableReceiveAddressWillNotChange: true;
  readonly requiresOfflineOwnerKey: true;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: Sha256Digest;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface VaultMigrationDecision {
  readonly decision: "approved" | "denied";
  readonly authorityId: string;
  readonly evidence: Uint8Array;
  readonly evidenceDigest: Sha256Digest;
  readonly factsDigest: Sha256Digest;
  readonly decidedAtMs: number;
}

export interface VaultMigrationAuthorityModule {
  request(facts: VaultMigrationFacts): Promise<VaultMigrationDecision>;
}

export interface VaultMigrationExecutionResult {
  readonly recoveryTransactionId: string;
  readonly replacementTransactionId: string;
  readonly stableReceiveAddress: string;
  readonly newMaximumOutflowAtomic: string;
  readonly windowStartDaa: string;
  readonly spentInWindowAtomic: string;
  readonly receiptDigest: Sha256Digest;
}

export interface VaultMigrationExecutor {
  execute(facts: VaultMigrationFacts, signal?: AbortSignal): Promise<VaultMigrationExecutionResult>;
  reconcile(facts: VaultMigrationFacts, signal?: AbortSignal): Promise<VaultMigrationExecutionResult>;
}

export interface VaultMigrationView {
  readonly id: string;
  readonly requestKey: string;
  readonly state: "created" | "awaiting_authority" | "awaiting_owner" | "executing" | "applied" | "denied" | "expired" | "reconciliation_required" | "failed";
  readonly summary: string;
  readonly userAction?: string;
  readonly previousVaultProtectionMaximum: KasAmountView;
  readonly proposedVaultProtectionMaximum: KasAmountView;
  readonly receiveAddressUnchanged: true;
  readonly requiresOfflineOwnerKey: true;
  readonly expiresAt: string;
  readonly recoveryTransactionId?: string;
  readonly replacementTransactionId?: string;
  readonly receiptDigest?: string;
}
