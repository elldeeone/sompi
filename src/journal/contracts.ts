import type {
  PurchaseId,
  Sha256Digest,
} from "../purchase/types.js";

const EFFECT_STATES = [
  "planned",
  "executing",
  "submitted",
  "ambiguous",
  "retryable",
  "observed",
  "failed_terminal",
  "abandoned",
] as const;

export type EffectState = (typeof EFFECT_STATES)[number];

export interface EvidenceArtifactRecord {
  digest: Sha256Digest;
  byteLength: number;
  storageRef: string;
  createdAtMs: number;
}

export interface EvidenceAttachmentRecord extends EvidenceArtifactRecord {
  purchaseId: PurchaseId;
  kind: string;
  attempt?: number;
  mediaType: string;
  profile: string;
  issuer?: string;
  attachedAtMs: number;
}

export interface EvidenceVerificationInput {
  verifierId: string;
  profile: string;
  detailDigest: Sha256Digest;
}

export interface StoreEvidenceInput {
  bytes: Uint8Array;
  mediaType: string;
  profile: string;
  issuer?: string;
  kind: string;
  attempt?: number;
}

export interface PlanEffectInput {
  purchaseId: PurchaseId;
  attempt?: number;
  kind: string;
  idempotencyKey: string;
  payloadDigest: Sha256Digest;
  preparedBytes: Uint8Array;
}

export interface EffectRecord extends Omit<PlanEffectInput, "preparedBytes"> {
  id: string;
  preparedRef: string;
  preparedByteLength: number;
  state: EffectState;
  version: number;
  claimLeaseName?: string;
  claimGeneration?: number;
  submissionDigest?: Sha256Digest;
  resultDigest?: Sha256Digest;
  errorCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
  executingAtMs?: number;
  submittedAtMs?: number;
  observedAtMs?: number;
}

export interface LeaseToken {
  name: string;
  holder: string;
  generation: number;
  expiresAtMs: number;
}

export interface EffectClaim {
  effect: EffectRecord;
  lease: LeaseToken;
}

export type EffectObservation =
  | {
      status: "observed";
      resultDigest: Sha256Digest;
      detailDigest?: Sha256Digest;
    }
  | { status: "pending"; detailDigest?: Sha256Digest }
  | {
      status: "not_found";
      safeToRetry: boolean;
      detailDigest: Sha256Digest;
    }
  | { status: "conflict"; detailDigest: Sha256Digest }
  | {
      status: "application_failure";
      errorCode: string;
      detailDigest: Sha256Digest;
    };

export interface EffectObservationRecord {
  id: number;
  effectId: string;
  status:
    | "observed"
    | "pending"
    | "not_found_retryable"
    | "not_found_ambiguous"
    | "conflict"
    | "application_failure";
  resultDigest?: Sha256Digest;
  detailDigest?: Sha256Digest;
  leaseName: string;
  leaseGeneration: number;
  observedAtMs: number;
}

export interface EffectTransitionRecord {
  sequence: number;
  effectId: string;
  fromState?: EffectState;
  toState: EffectState;
  reasonCode: string;
  detailDigest?: Sha256Digest;
  createdAtMs: number;
}

export class JournalInvariantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JournalInvariantError";
  }
}

export class JournalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalNotFoundError";
  }
}

export class JournalRequestConflictError extends JournalInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "JournalRequestConflictError";
  }
}

export class JournalFencingError extends JournalInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "JournalFencingError";
  }
}

export class JournalEffectBusyError extends JournalFencingError {
  constructor(message: string) {
    super(message);
    this.name = "JournalEffectBusyError";
  }
}
