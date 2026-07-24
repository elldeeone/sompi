import { createHash, randomBytes } from "node:crypto";

import { SompiOperationFailure } from "../operation-failure.js";
import type { OperatorManifestIdentity } from "../operator/manifest.js";
import { PolicyEngine, type Policy } from "../policy.js";
import {
  JournalNotFoundError,
  JournalRequestConflictError,
  PolicyReservationError,
  PurchaseJournal,
  type PolicyChangeJournalRecord,
  type PolicySnapshotRecord,
} from "../purchase/journal.js";
import type {
  PolicyChangeAuthorityModule,
  PolicyChangeDecision,
  PolicyChangeFacts,
  PolicyChangeIntent,
  PolicyChangeRecord,
  PolicyChangeView,
} from "./types.js";
import type { Sha256Digest } from "../purchase/types.js";
import { kasAmountView } from "../amount-display.js";

const PROFILE = "sompi.policy-change.1" as const;
const ID = /^pcg_[A-Za-z0-9_-]{22}$/;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export interface PolicyChangeModuleOptions {
  readonly journal: PurchaseJournal;
  readonly policy: PolicyEngine;
  readonly authority: PolicyChangeAuthorityModule;
  readonly manifest: () => OperatorManifestIdentity;
  readonly vaultProtection: () => Readonly<{
    digest: Sha256Digest;
    maximumOutflowAtomic: string;
  }>;
  readonly now?: () => number;
  readonly approvalTtlMs?: number;
}

/** Owns the complete owner-approved everyday-limit lifecycle. */
export class PolicyChangeModule {
  private readonly now: () => number;
  private readonly approvalTtlMs: number;

  constructor(private readonly options: PolicyChangeModuleOptions) {
    if (!options.journal || !options.policy || !options.authority || !options.manifest) {
      throw new Error("Policy Change dependencies are incomplete");
    }
    this.now = options.now ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? 120_000;
    if (!Number.isSafeInteger(this.approvalTtlMs) || this.approvalTtlMs < 10_000 || this.approvalTtlMs > 600_000) {
      throw new Error("Policy Change approval lifetime is invalid");
    }
  }

  async propose(intent: PolicyChangeIntent, signal?: AbortSignal): Promise<PolicyChangeView> {
    const normalized = normalizeIntent(intent);
    signal?.throwIfAborted();
    const existing = this.options.journal.findPolicyChangeByRequestKey(normalized.requestKey);
    if (existing) {
      if (
        existing.proposedMaximumPerPaymentAtomic !== normalized.maximumPerPaymentAtomic ||
        existing.proposedMaximumPerHourAtomic !== normalized.maximumPerHourAtomic
      ) {
        throw new SompiOperationFailure("POLICY_CHANGE_CONFLICT");
      }
      return this.resume(existing, signal);
    }

    const activation = this.options.journal.requireActivePolicyActivation();
    const active = activation.policy;
    const vault = this.options.vaultProtection();
    const vaultMaximumOutflowAtomic = atomic(
      vault.maximumOutflowAtomic,
      "vault protection maximum",
    );
    validateProposedLimits(normalized, vaultMaximumOutflowAtomic);
    const manifest = this.options.manifest();
    const now = timestamp(this.now);
    let record: PolicyChangeJournalRecord;
    try {
      record = this.options.journal.createPolicyChange({
        id: createPolicyChangeId(),
        requestKey: normalized.requestKey,
        expectedPolicyDigest: active.digest,
        expectedPolicyGeneration: activation.activationGeneration,
        expectedVaultDigest: requireDigest(vault.digest, "vault protection digest"),
        previousMaximumPerPaymentAtomic: active.maxPerPaymentAtomic,
        previousMaximumPerHourAtomic: active.maxPerHourAtomic,
        proposedMaximumPerPaymentAtomic: normalized.maximumPerPaymentAtomic,
        proposedMaximumPerHourAtomic: normalized.maximumPerHourAtomic,
        vaultMaximumOutflowAtomic,
        manifestRevision: manifest.revision,
        manifestDigest: requireDigest(manifest.digest, "Operator Manifest digest"),
        expiresAtMs: now + this.approvalTtlMs,
      });
    } catch (cause) {
      if (
        cause instanceof JournalRequestConflictError ||
        cause instanceof PolicyReservationError
      ) {
        throw new SompiOperationFailure("POLICY_CHANGE_CONFLICT", { cause });
      }
      throw cause;
    }
    return this.resume(record, signal);
  }

  status(id: string): PolicyChangeView {
    return view(this.requirePolicyChange(id));
  }

  recover(id: string, signal?: AbortSignal): Promise<PolicyChangeView> {
    return this.resume(this.requirePolicyChange(id), signal);
  }

  private async resume(record: PolicyChangeJournalRecord, signal?: AbortSignal): Promise<PolicyChangeView> {
    if (record.state === "created") {
      record = this.options.journal.markPolicyChangeAwaitingAuthority(record.id);
    }
    if (record.state !== "awaiting_authority") return view(record);
    signal?.throwIfAborted();
    const facts = factsFor(record, this.options.journal.requireActivePolicyActivation());
    const decision = await this.options.authority.request(facts);
    validateDecision(decision, facts);
    if (decision.decision === "denied") {
      return view(this.options.journal.denyPolicyChange(record.id, decision));
    }
    const currentPolicy = this.options.policy.policy;
    const currentVault = this.options.vaultProtection();
    let applied: PolicyChangeJournalRecord;
    try {
      applied = this.options.journal.authorizeAndActivatePolicyChange(
        record.id,
        decision,
        {
          maxPerPaymentAtomic: record.proposedMaximumPerPaymentAtomic,
          maxPerHourAtomic: record.proposedMaximumPerHourAtomic,
          allowlist: currentPolicy.allowlist,
        },
        {
          expectedPolicyGeneration: record.expectedPolicyGeneration,
          expectedVaultDigest: record.expectedVaultDigest,
          currentVaultDigest: requireDigest(currentVault.digest, "current vault protection digest"),
          currentVaultMaximumOutflowAtomic: atomic(
            currentVault.maximumOutflowAtomic,
            "current vault protection maximum",
          ),
        },
      );
    } catch (cause) {
      if (cause instanceof PolicyReservationError) {
        throw new SompiOperationFailure("POLICY_CHANGE_CONFLICT", { cause });
      }
      throw cause;
    }
    const active = this.options.journal.requireActivePolicy();
    this.options.policy.activate(policyFromSnapshot(active));
    return view(applied);
  }

  private requirePolicyChange(id: string): PolicyChangeJournalRecord {
    if (!ID.test(id)) throw new SompiOperationFailure("INVALID_POLICY_CHANGE");
    try {
      return this.options.journal.policyChange(id);
    } catch (cause) {
      if (cause instanceof JournalNotFoundError) {
        throw new SompiOperationFailure("POLICY_CHANGE_NOT_FOUND", { cause });
      }
      throw cause;
    }
  }
}

function factsFor(
  record: PolicyChangeJournalRecord,
  activation: Readonly<{ policy: PolicySnapshotRecord; activationGeneration: number }>,
): PolicyChangeFacts {
  const active = activation.policy;
  if (active.digest !== record.expectedPolicyDigest) {
    throw new SompiOperationFailure("POLICY_CHANGE_CONFLICT");
  }
  if (activation.activationGeneration !== record.expectedPolicyGeneration) {
    throw new SompiOperationFailure("POLICY_CHANGE_CONFLICT");
  }
  return Object.freeze({
    profile: PROFILE,
    policyChangeId: record.id,
    requestKey: record.requestKey,
    expectedPolicyDigest: record.expectedPolicyDigest,
    expectedPolicyVersion: active.version,
    expectedPolicyGeneration: record.expectedPolicyGeneration,
    expectedVaultDigest: record.expectedVaultDigest,
    previousMaximumPerPaymentAtomic: record.previousMaximumPerPaymentAtomic,
    previousMaximumPerHourAtomic: record.previousMaximumPerHourAtomic,
    proposedMaximumPerPaymentAtomic: record.proposedMaximumPerPaymentAtomic,
    proposedMaximumPerHourAtomic: record.proposedMaximumPerHourAtomic,
    vaultMaximumOutflowAtomic: record.vaultMaximumOutflowAtomic,
    everyPaymentRequiresApproval: true,
    operatorManifestRevision: record.manifestRevision,
    operatorManifestDigest: record.manifestDigest,
    issuedAt: new Date(record.createdAtMs).toISOString(),
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  });
}

function validateDecision(decision: PolicyChangeDecision, facts: PolicyChangeFacts): void {
  if (!decision || (decision.decision !== "approved" && decision.decision !== "denied")) {
    throw new Error("Policy Change authority returned an invalid decision");
  }
  const expected = digestJson(facts);
  if (decision.factsDigest !== expected) {
    throw new Error("Policy Change authority decision is not bound to the displayed limits");
  }
  if (!(decision.evidence instanceof Uint8Array) || digestBytes(decision.evidence) !== decision.evidenceDigest) {
    throw new Error("Policy Change authority evidence is invalid");
  }
}

function policyFromSnapshot(snapshot: PolicySnapshotRecord): Policy {
  return Object.freeze({
    maxSompiPerTx: BigInt(snapshot.maxPerPaymentAtomic),
    maxSompiPerHour: BigInt(snapshot.maxPerHourAtomic),
    allowlist: [...snapshot.allowlist],
  });
}

function normalizeIntent(intent: PolicyChangeIntent): PolicyChangeIntent {
  if (!intent || !REQUEST_KEY.test(intent.requestKey)) {
    throw new SompiOperationFailure("INVALID_POLICY_CHANGE");
  }
  try {
    return Object.freeze({
      requestKey: intent.requestKey,
      maximumPerPaymentAtomic: atomic(intent.maximumPerPaymentAtomic, "per-payment limit"),
      maximumPerHourAtomic: atomic(intent.maximumPerHourAtomic, "hourly limit"),
    });
  } catch (cause) {
    throw new SompiOperationFailure("INVALID_POLICY_CHANGE", { cause });
  }
}

function validateProposedLimits(intent: PolicyChangeIntent, vaultMaximumOutflowAtomic: string): void {
  const perPayment = BigInt(intent.maximumPerPaymentAtomic);
  const perHour = BigInt(intent.maximumPerHourAtomic);
  const vaultMaximum = BigInt(vaultMaximumOutflowAtomic);
  if (perPayment > perHour) throw new SompiOperationFailure("INVALID_POLICY_CHANGE");
  if (perPayment > vaultMaximum || perHour > vaultMaximum) {
    throw new SompiOperationFailure("INVALID_POLICY_CHANGE");
  }
}

function view(record: PolicyChangeJournalRecord): PolicyChangeView {
  const applied = record.state === "applied";
  return Object.freeze({
    id: record.id,
    requestKey: record.requestKey,
    state: record.state,
    summary: applied
      ? "Spending limits updated. Every payment still requires your approval."
      : record.state === "awaiting_authority"
        ? "Waiting for your approval."
        : record.state === "denied"
          ? "Spending-limit change denied."
          : record.state === "expired"
            ? "Spending-limit approval expired."
            : `Spending-limit change is ${record.state}.`,
    ...(record.state === "awaiting_authority" ? { userAction: "Approve or deny the exact new limits." } : {}),
    previous: Object.freeze({
      maximumPerPayment: kasAmountView(record.previousMaximumPerPaymentAtomic),
      maximumPerHour: kasAmountView(record.previousMaximumPerHourAtomic),
    }),
    proposed: Object.freeze({
      maximumPerPayment: kasAmountView(record.proposedMaximumPerPaymentAtomic),
      maximumPerHour: kasAmountView(record.proposedMaximumPerHourAtomic),
    }),
    vaultProtectionMaximum: kasAmountView(record.vaultMaximumOutflowAtomic),
    everyPaymentRequiresApproval: true,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    ...(record.appliedPolicyDigest ? { appliedPolicyDigest: record.appliedPolicyDigest } : {}),
    ...(record.appliedPolicyVersion ? { appliedPolicyVersion: record.appliedPolicyVersion } : {}),
  });
}

function createPolicyChangeId(): string {
  return `pcg_${randomBytes(16).toString("base64url")}`;
}

function atomic(value: string, label: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > UINT64_MAX) {
    throw new Error(`${label} must be a positive KAS atomic amount`);
  }
  return value;
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Policy Change clock is unavailable");
  return value;
}

function digestJson(value: unknown): Sha256Digest {
  return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

function requireDigest(value: string, label: string): Sha256Digest {
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(`${label} is invalid`);
  return value as Sha256Digest;
}

export const policyChangeFactsDigest = digestJson;
