import { createHash, randomBytes } from "node:crypto";

import type { OperatorManifestIdentity } from "../operator/manifest.js";
import { PurchaseJournal, type VaultMigrationJournalRecord } from "../purchase/journal.js";
import type { Sha256Digest } from "../purchase/types.js";
import type { VaultManager } from "../vault.js";
import { vaultStaticConfigurationDigest } from "../vault.js";
import type { KaspaWallet } from "../wallet.js";
import { kasAmountView } from "../amount-display.js";
import type {
  VaultMigrationAuthorityModule,
  VaultMigrationDecision,
  VaultMigrationExecutor,
  VaultMigrationFacts,
  VaultMigrationIntent,
  VaultMigrationView,
} from "./types.js";

const ID = /^vmg_[A-Za-z0-9_-]{22}$/;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export class VaultMigrationModule {
  private readonly now: () => number;
  private readonly approvalTtlMs: number;

  constructor(private readonly options: Readonly<{
    journal: PurchaseJournal;
    vault: VaultManager;
    wallet: Pick<KaspaWallet, "address">;
    authority: VaultMigrationAuthorityModule;
    everydayMaximumAtomic: () => string;
    manifest: () => OperatorManifestIdentity;
    now?: () => number;
    approvalTtlMs?: number;
  }>) {
    if (!options.journal || !options.vault || !options.wallet || !options.authority || !options.everydayMaximumAtomic || !options.manifest) {
      throw new Error("Vault Migration dependencies are incomplete");
    }
    this.now = options.now ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? 120_000;
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs < 10_000 || this.approvalTtlMs > 600_000) {
      throw new Error("Vault Migration approval lifetime is invalid");
    }
  }

  async propose(intent: VaultMigrationIntent, signal?: AbortSignal): Promise<VaultMigrationView> {
    const normalized = normalizeIntent(intent);
    const existing = this.options.journal.findVaultMigrationByRequestKey(normalized.requestKey);
    if (existing) {
      if (existing.newMaximumOutflowAtomic !== normalized.newMaximumOutflowAtomic) {
        throw new Error("Vault Migration request key is already bound to different protection");
      }
      return this.resume(existing, signal);
    }
    const config = this.options.vault.config();
    const activation = this.options.journal.requireActivePolicyActivation();
    this.assertEverydayLimitsFit(normalized.newMaximumOutflowAtomic);
    const manifest = this.options.manifest();
    const now = timestamp(this.now);
    let record = this.options.journal.createVaultMigration({
      id: `vmg_${randomBytes(16).toString("base64url")}`,
      requestKey: normalized.requestKey,
      oldVaultDigest: vaultStaticConfigurationDigest(config) as Sha256Digest,
      expectedPolicyDigest: activation.policy.digest,
      expectedPolicyGeneration: activation.activationGeneration,
      oldMaximumOutflowAtomic: config.maxOutflowSompi,
      newMaximumOutflowAtomic: normalized.newMaximumOutflowAtomic,
      windowSizeDaa: config.windowSizeDaa,
      windowStartDaa: config.windowStartDaa,
      spentInWindowAtomic: config.spentInWindowSompi,
      stableReceiveAddress: this.options.wallet.address,
      manifestRevision: manifest.revision,
      manifestDigest: manifest.digest as Sha256Digest,
      expiresAtMs: now + this.approvalTtlMs,
    });
    record = this.options.journal.markVaultMigrationAwaitingAuthority(record.id);
    return this.resume(record, signal);
  }

  status(id: string): VaultMigrationView {
    if (!ID.test(id)) throw new Error("Vault Migration identity is invalid");
    return view(this.options.journal.vaultMigration(id));
  }

  async execute(id: string, executor: VaultMigrationExecutor, signal?: AbortSignal): Promise<VaultMigrationView> {
    if (!executor) throw new Error("Vault Migration owner executor is required");
    let record = this.options.journal.vaultMigration(id);
    if (record.state === "applied") return view(record);
    if (record.state !== "awaiting_owner") throw new Error("Vault Migration is not ready for offline-owner execution");
    this.assertCurrentVault(record);
    this.assertEverydayLimitsFit(record.newMaximumOutflowAtomic);
    this.options.journal.assertVaultMigrationExecutionReady(record.id);
    this.options.vault.beginMigration(record.id, record.oldVaultDigest);
    record = this.options.journal.beginVaultMigrationExecution(record.id);
    if (record.state === "expired") {
      this.options.vault.abortMigration(record.id, record.oldVaultDigest);
      throw new Error("Vault Migration approval expired before offline-owner execution");
    }
    try {
      const result = await executor.execute(factsFor(record), signal);
      this.validateResult(record, result);
      const completed = this.options.journal.completeVaultMigration(record.id, result);
      this.options.vault.finishMigration(record.id, record.oldVaultDigest);
      return view(completed);
    } catch (error) {
      if (this.options.journal.vaultMigration(record.id).state === "executing") {
        this.options.journal.requireVaultMigrationReconciliation(record.id, "execution_outcome_unknown");
      }
      throw new Error("Vault Migration outcome needs operator reconciliation", { cause: error });
    }
  }

  async recover(id: string, executor: VaultMigrationExecutor, signal?: AbortSignal): Promise<VaultMigrationView> {
    const record = this.options.journal.vaultMigration(id);
    if (record.state === "applied") return view(record);
    if (record.state !== "reconciliation_required") throw new Error("Vault Migration does not need reconciliation");
    const result = await executor.reconcile(factsFor(record), signal);
    this.validateResult(record, result);
    const completed = this.options.journal.completeVaultMigration(record.id, result);
    this.options.vault.finishMigration(record.id, record.oldVaultDigest);
    return view(completed);
  }

  private async resume(record: VaultMigrationJournalRecord, signal?: AbortSignal): Promise<VaultMigrationView> {
    if (record.state !== "awaiting_authority") return view(record);
    signal?.throwIfAborted();
    const facts = factsFor(record);
    const decision = await this.options.authority.request(facts);
    validateDecision(decision, facts);
    return view(this.options.journal.decideVaultMigration(record.id, decision));
  }

  private assertCurrentVault(record: VaultMigrationJournalRecord): void {
    const config = this.options.vault.config();
    if (
      vaultStaticConfigurationDigest(config) !== record.oldVaultDigest ||
      config.windowSizeDaa !== record.windowSizeDaa ||
      config.windowStartDaa !== record.windowStartDaa ||
      config.spentInWindowSompi !== record.spentInWindowAtomic ||
      this.options.wallet.address !== record.stableReceiveAddress
    ) throw new Error("Vault Migration plan no longer matches the active wallet");
  }

  private assertEverydayLimitsFit(newMaximumOutflowAtomic: string): void {
    const everydayMaximum = this.options.everydayMaximumAtomic();
    if (!/^[1-9][0-9]*$/.test(everydayMaximum) || BigInt(everydayMaximum) > BigInt(newMaximumOutflowAtomic)) {
      throw new Error("lower the everyday hourly limit before lowering vault protection below it");
    }
  }

  private validateResult(record: VaultMigrationJournalRecord, result: Awaited<ReturnType<VaultMigrationExecutor["execute"]>>): void {
    if (
      result.stableReceiveAddress !== record.stableReceiveAddress ||
      result.newMaximumOutflowAtomic !== record.newMaximumOutflowAtomic ||
      result.windowStartDaa !== record.windowStartDaa ||
      result.spentInWindowAtomic !== record.spentInWindowAtomic ||
      !/^[a-f0-9]{64}$/.test(result.recoveryTransactionId) ||
      !/^[a-f0-9]{64}$/.test(result.replacementTransactionId) ||
      !/^sha256:[A-Za-z0-9_-]{43}$/.test(result.receiptDigest)
    ) throw new Error("Vault Migration execution result does not match the approved plan");
  }
}

function factsFor(record: VaultMigrationJournalRecord): VaultMigrationFacts {
  return Object.freeze({
    profile: "sompi.vault-migration.1",
    vaultMigrationId: record.id,
    requestKey: record.requestKey,
    oldVaultDigest: record.oldVaultDigest,
    expectedPolicyDigest: record.expectedPolicyDigest,
    expectedPolicyGeneration: record.expectedPolicyGeneration,
    oldMaximumOutflowAtomic: record.oldMaximumOutflowAtomic,
    newMaximumOutflowAtomic: record.newMaximumOutflowAtomic,
    windowSizeDaa: record.windowSizeDaa,
    windowStartDaa: record.windowStartDaa,
    spentInWindowAtomic: record.spentInWindowAtomic,
    stableReceiveAddress: record.stableReceiveAddress,
    stableReceiveAddressWillNotChange: true,
    requiresOfflineOwnerKey: true,
    operatorManifestRevision: record.manifestRevision,
    operatorManifestDigest: record.manifestDigest,
    issuedAt: new Date(record.createdAtMs).toISOString(),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  });
}

function normalizeIntent(intent: VaultMigrationIntent): VaultMigrationIntent {
  if (!intent || !REQUEST_KEY.test(intent.requestKey)) throw new Error("Vault Migration request key is invalid");
  if (!/^[1-9][0-9]*$/.test(intent.newMaximumOutflowAtomic) || BigInt(intent.newMaximumOutflowAtomic) > UINT64_MAX) {
    throw new Error("new vault protection maximum must be a positive KAS atomic amount");
  }
  return Object.freeze({ ...intent });
}

function validateDecision(decision: VaultMigrationDecision, facts: VaultMigrationFacts): void {
  if (!decision || (decision.decision !== "approved" && decision.decision !== "denied") ||
      decision.factsDigest !== digestJson(facts) || !(decision.evidence instanceof Uint8Array) ||
      digestBytes(decision.evidence) !== decision.evidenceDigest) {
    throw new Error("Vault Migration authority decision is invalid");
  }
}

function view(record: VaultMigrationJournalRecord): VaultMigrationView {
  const summaries: Record<VaultMigrationJournalRecord["state"], string> = {
    created: "Vault protection change created.",
    awaiting_authority: "Waiting for your approval.",
    awaiting_owner: "Approved. The operator must complete the secure vault replacement.",
    executing: "Vault protection is being updated. Sending is temporarily paused.",
    reconciliation_required: "The update needs operator reconciliation. Sending remains paused.",
    applied: "Vault protection updated; your receive address has not changed.",
    denied: "Vault protection change denied.",
    expired: "Vault protection approval expired.",
    failed: "Vault protection could not be updated.",
  };
  return Object.freeze({
    id: record.id, requestKey: record.requestKey, state: record.state,
    summary: summaries[record.state],
    ...(record.state === "awaiting_authority" ? { userAction: "Approve or deny the exact vault protection change." } : {}),
    ...(record.state === "awaiting_owner" ? { userAction: "Run the operator vault-migration command with the offline owner key." } : {}),
    previousVaultProtectionMaximum: kasAmountView(record.oldMaximumOutflowAtomic),
    proposedVaultProtectionMaximum: kasAmountView(record.newMaximumOutflowAtomic),
    receiveAddressUnchanged: true,
    requiresOfflineOwnerKey: true,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    ...(record.recoveryTransactionId ? { recoveryTransactionId: record.recoveryTransactionId } : {}),
    ...(record.replacementTransactionId ? { replacementTransactionId: record.replacementTransactionId } : {}),
    ...(record.receiptDigest ? { receiptDigest: record.receiptDigest } : {}),
  });
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Vault Migration clock is unavailable");
  return value;
}

function digestJson(value: unknown): Sha256Digest { return digestBytes(Buffer.from(JSON.stringify(value), "utf8")); }
function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

export const vaultMigrationFactsDigest = digestJson;
