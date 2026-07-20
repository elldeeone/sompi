import type { KasAmountView } from "../amount-display.js";
import type { Sha256Digest } from "../purchase/types.js";

export const POLICY_CHANGE_STATES = [
  "created",
  "awaiting_authority",
  "authorised",
  "applied",
  "denied",
  "expired",
  "failed",
] as const;

export type PolicyChangeState = (typeof POLICY_CHANGE_STATES)[number];

export interface PolicyChangeIntent {
  readonly requestKey: string;
  readonly maximumPerPaymentAtomic: string;
  readonly maximumPerHourAtomic: string;
}

export interface PolicyChangeFacts {
  readonly profile: "sompi.policy-change.1";
  readonly policyChangeId: string;
  readonly requestKey: string;
  readonly expectedPolicyDigest: Sha256Digest;
  readonly expectedPolicyVersion: number;
  readonly expectedPolicyGeneration: number;
  readonly expectedVaultDigest: Sha256Digest;
  readonly previousMaximumPerPaymentAtomic: string;
  readonly previousMaximumPerHourAtomic: string;
  readonly proposedMaximumPerPaymentAtomic: string;
  readonly proposedMaximumPerHourAtomic: string;
  readonly vaultMaximumOutflowAtomic: string;
  readonly everyPaymentRequiresApproval: true;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: Sha256Digest;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface PolicyChangeDecision {
  readonly decision: "approved" | "denied";
  readonly authorityId: string;
  readonly evidence: Uint8Array;
  readonly evidenceDigest: Sha256Digest;
  readonly factsDigest: Sha256Digest;
  readonly decidedAtMs: number;
}

export interface PolicyChangeAuthorityModule {
  request(facts: PolicyChangeFacts): Promise<PolicyChangeDecision>;
}

export interface PolicyChangeRecord {
  readonly id: string;
  readonly requestKey: string;
  readonly state: PolicyChangeState;
  readonly expectedPolicyDigest: Sha256Digest;
  readonly expectedPolicyGeneration: number;
  readonly expectedVaultDigest: Sha256Digest;
  readonly previousMaximumPerPaymentAtomic: string;
  readonly previousMaximumPerHourAtomic: string;
  readonly proposedMaximumPerPaymentAtomic: string;
  readonly proposedMaximumPerHourAtomic: string;
  readonly vaultMaximumOutflowAtomic: string;
  readonly manifestRevision: number;
  readonly manifestDigest: Sha256Digest;
  readonly expiresAtMs: number;
  readonly authorityId?: string;
  readonly authorityEvidenceDigest?: Sha256Digest;
  readonly appliedPolicyDigest?: Sha256Digest;
  readonly appliedPolicyVersion?: number;
  readonly failureCode?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface PolicyChangeView {
  readonly id: string;
  readonly requestKey: string;
  readonly state: PolicyChangeState;
  readonly summary: string;
  readonly userAction?: string;
  readonly previous: Readonly<{
    maximumPerPayment: KasAmountView;
    maximumPerHour: KasAmountView;
  }>;
  readonly proposed: Readonly<{
    maximumPerPayment: KasAmountView;
    maximumPerHour: KasAmountView;
  }>;
  readonly vaultProtectionMaximum: KasAmountView;
  readonly everyPaymentRequiresApproval: true;
  readonly expiresAt: string;
  readonly appliedPolicyDigest?: string;
  readonly appliedPolicyVersion?: number;
}
