export const TRANSFER_STATES = Object.freeze([
  "created",
  "awaiting_authority",
  "authorised",
  "denied",
  "funds_reserved",
  "prepared",
  "submitted",
  "settled",
  "receipted",
  "failed_recoverable",
  "failed_terminal",
] as const);

export type TransferState = (typeof TRANSFER_STATES)[number];

export interface TransferIntent {
  readonly requestKey: string;
  readonly destination: string;
  readonly amountAtomic: string;
}

export interface TransferAuthorizationFacts {
  readonly profile: "sompi.transfer.1";
  readonly transferId: string;
  readonly requestKey: string;
  readonly sourceVaultAddress: string;
  readonly sourceVaultDigest: string;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly asset: "KAS";
  readonly network: "kaspa:testnet-10";
  readonly feeCeilingAtomic: string;
  readonly maximumTotalAtomic: string;
  readonly expiresAt: string;
  readonly policyDigest: string;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: string;
  readonly finalityFloor: "accepted" | "depth-confirmed";
}

export type TransferAuthorityDecision = Readonly<{
  decision: "approved" | "denied";
  authorityId: string;
  denialCode?: "user_denied" | "terms_expired";
  evidence: Uint8Array;
  evidenceDigest: string;
  factsDigest: string;
  verificationProfile: string;
  verifierId: string;
  decidedAtMs: number;
}>;

export interface TransferAuthorityModule {
  request(facts: TransferAuthorizationFacts, signal?: AbortSignal): Promise<TransferAuthorityDecision>;
}

export interface TransferRecord {
  readonly id: string;
  readonly requestKey: string;
  readonly requestDigest: string;
  readonly state: TransferState;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly asset: "KAS";
  readonly network: "kaspa:testnet-10";
  readonly sourceVaultAddress: string;
  readonly sourceVaultDigest: string;
  readonly feeCeilingAtomic: string;
  readonly maximumTotalAtomic: string;
  readonly expiresAtMs: number;
  readonly policyDigest: string;
  readonly manifestRevision: number;
  readonly manifestDigest: string;
  readonly finalityFloor: "accepted" | "depth-confirmed";
  readonly treasuryOperationKey?: string;
  readonly transactionId?: string;
  readonly actualFeeAtomic?: string;
  readonly failureCode?: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface TransferAuthorizationRecord {
  readonly transferId: string;
  readonly facts: TransferAuthorizationFacts;
  readonly factsDigest: string;
  readonly decision: "approved" | "denied";
  readonly authorityId: string;
  readonly denialCode?: string;
  readonly evidenceDigest: string;
  readonly verificationProfile: string;
  readonly verifierId: string;
  readonly decidedAtMs: number;
  readonly expiresAtMs: number;
}

export interface TransferReceipt {
  readonly profile: "urn:sompi:receipt:transfer:1";
  readonly transferId: string;
  readonly requestKey: string;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly feeAtomic: string;
  readonly network: "kaspa:testnet-10";
  readonly fundingSource: "vault-treasury";
  readonly transactionId: string;
  readonly finality: "accepted" | "depth-confirmed";
  readonly settledAt: string;
}

export interface TransferView extends TransferRecord {
  readonly summary: string;
  readonly display: Readonly<{
    amount: KasAmountView;
    feeCeiling: KasAmountView;
    maximumTotal: KasAmountView;
    actualFee?: KasAmountView;
  }>;
  readonly authorization?: Omit<TransferAuthorizationRecord, "facts"> & {
    readonly facts: TransferAuthorizationFacts;
  };
  readonly receipt?: TransferReceipt;
  readonly recoveryRequired: boolean;
  readonly safeToRetry: boolean;
  readonly userAction: "approve_or_deny" | "wait" | "recover" | "none";
}
import type { KasAmountView } from "../amount-display.js";
