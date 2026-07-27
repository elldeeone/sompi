import type {
  PaymentIdentifier,
  PurchaseId,
  Sha256Digest,
} from "../purchase/types.js";
import type {
  EffectClaim,
  EffectObservation,
  EffectRecord,
  EvidenceAttachmentRecord,
  LeaseToken,
  RecordObservedTreasuryStagingInput,
  TreasuryStagingObservationRecord,
} from "../purchase/journal.js";
import type {
  ReservePurchaseCapacityInput,
  TreasuryPolicy,
  TreasuryPurchaseReservation,
} from "./purchase-capacity.js";
import type {
  PlanTreasuryStagingInput,
  TreasuryStagingPreparationContext,
  TreasuryStagingPreparationLease,
  TreasuryStagingPlanRecord,
} from "./purchase-staging.js";

export type TreasuryOperationKind = "wallet_send" | "vault_send" | "vault_deposit" | "batch_refund";
export type TreasuryOperationState =
  | "intent"
  | "prepared"
  | "submission_planned"
  | "submitted"
  | "observed"
  | "completed"
  | "failed_terminal";

export interface TreasuryOperationRecord {
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly kind: TreasuryOperationKind;
  readonly destination: string;
  readonly requestedAmountAtomic: string | "max";
  readonly keepFloatAtomic?: string;
  readonly feeCeilingAtomic: string;
  readonly retryLimit: number;
  readonly cancellationRequested: boolean;
  readonly preparationFenced: boolean;
  /** Durable single-driver owner, generation, and bounded lease deadline. */
  readonly driverOwner?: string;
  readonly driverGeneration: number;
  readonly driverLeaseExpiresAtMs?: number;
  /** Effect capability issued by the Journal immediately before submit. */
  readonly effectCapabilityGeneration?: number;
  /**
   * Durable effect-possible fence. Once set, an adapter submit may be live or
   * may already have returned, so takeover is observation-only until the
   * Journal records authoritative outcome evidence.
   */
  readonly submissionInFlight: boolean;
  readonly resolvedAmountAtomic?: string;
  readonly feeAtomic?: string;
  readonly transactionId?: string;
  readonly preparedDigest?: string;
  readonly preparedByteLength?: number;
  readonly policyDigest?: string;
  /** Present only when an approved Transfer authorization was durably linked. */
  readonly authorizationEvidenceDigest?: string;
  readonly state: TreasuryOperationState;
  readonly retryCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs?: number;
}

export interface TreasuryDriverLease {
  readonly owner: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

export interface TreasuryDriverClaim {
  readonly acquired: boolean;
  readonly record: TreasuryOperationRecord;
  readonly lease?: TreasuryDriverLease;
}

export interface TreasuryOperationIntent {
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly kind: TreasuryOperationKind;
  readonly destination: string;
  readonly requestedAmountAtomic: string | "max";
  readonly keepFloatAtomic?: string;
  readonly feeCeilingAtomic: string;
  readonly retryLimit: number;
  readonly policyDigest: string;
  readonly authorizationEvidenceDigest?: string;
}

export interface TreasuryOperationPreflight {
  readonly kind: TreasuryOperationKind;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly feeCeilingAtomic: string;
  readonly policyDigest: string;
  readonly humanApprovalExpected: boolean;
}

export interface TreasuryOperationValidationInput {
  readonly operationKey: string;
  readonly kind: TreasuryOperationKind;
  readonly destination: string;
  readonly requestedAmountAtomic: string | "max";
  readonly keepFloatAtomic?: string;
}

export interface PreparedTreasuryOperationMaterial {
  readonly bytes: Uint8Array;
  readonly transactionId: string;
  readonly amountAtomic: string;
  readonly feeAtomic: string;
}

export interface PreparedTreasuryOperation extends PreparedTreasuryOperationMaterial {
  readonly policyDigest: string;
}

export type TreasuryOperationObservationStatus =
  | "observed"
  | "not_submitted"
  | "pending"
  /** A mutually exclusive, independently proven chain effect won first. */
  | "superseded";

/**
 * Local submit completion is not itself proof of non-execution. The owning
 * driver must distinguish a still-live call, an ambiguous call that settled
 * without a result, and an exact result durably accepted by the Journal.
 */
export type TreasurySubmissionOutcome =
  | "in_flight"
  | "ambiguous"
  | "accepted";

/**
 * Direct Treasury operations use the Purchase Journal implementation of this
 * interface. It is intentionally not a second store: Purchase and direct
 * capacity reservations must share one SQLite transaction and policy snapshot.
 */
export interface TreasuryOperationJournal {
  installPolicy(
    definition: TreasuryPolicy
  ): Readonly<TreasuryPolicy & { readonly digest: Sha256Digest }>;
  findActivePolicy():
    | Readonly<TreasuryPolicy & { readonly digest: Sha256Digest }>
    | undefined;
  requireActivePolicy(): Readonly<TreasuryPolicy & { readonly digest: Sha256Digest }>;
  requirePolicy(digest: string): Readonly<{
    digest: string;
    maxPerPaymentAtomic: string;
    maxPerHourAtomic: string;
    allowlist: readonly string[];
  }>;
  expireReservations(): number;
  findReservationForPurchase(
    purchaseId: ReservePurchaseCapacityInput["purchaseId"]
  ): TreasuryPurchaseReservation | undefined;
  requireReservation(id: string): TreasuryPurchaseReservation;
  requirePaymentAttempt(
    purchaseId: PurchaseId,
    attempt: number
  ): Readonly<{
    identifier: PaymentIdentifier;
    state: "planned" | "prepared" | "submitted" | "observed" | "failed";
  }>;
  findTreasuryStagingPlan(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingPlanRecord | undefined;
  requireTreasuryStagingPlan(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingPlanRecord;
  requirePurchaseExecutionContext(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingPreparationContext;
  acquireLease(
    name: string,
    holder: string,
    ttlMs: number
  ): TreasuryStagingPreparationLease | undefined;
  renewLease(
    lease: TreasuryStagingPreparationLease,
    ttlMs: number
  ): TreasuryStagingPreparationLease;
  releaseLease(lease: TreasuryStagingPreparationLease): boolean;
  commitTreasuryStagingPreparation(
    lease: TreasuryStagingPreparationLease,
    input: PlanTreasuryStagingInput
  ): TreasuryStagingPlanRecord;
  readPreparedTreasuryStaging(
    purchaseId: PurchaseId,
    attempt: number
  ): Buffer;
  beginTreasuryStaging(
    effectId: string,
    reservationId: string,
    holder: string,
    ttlMs: number
  ): EffectClaim | undefined;
  requireEffect(id: string): EffectRecord;
  effectClaimActive(effectId: string): boolean;
  verifyEffectPreparedMaterial(effectId: string): true;
  markEffectSubmitted(
    claim: EffectClaim,
    submissionDigest: Sha256Digest
  ): EffectRecord;
  markEffectAmbiguous(
    claim: EffectClaim,
    detailDigest?: Sha256Digest
  ): EffectRecord;
  recordEffectObservation(
    effectId: string,
    lease: LeaseToken,
    observation: EffectObservation
  ): EffectRecord;
  findTreasuryStagingObservation(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingObservationRecord | undefined;
  recordObservedTreasuryStaging(
    lease: LeaseToken,
    input: RecordObservedTreasuryStagingInput
  ): TreasuryStagingObservationRecord;
  storeEvidence(
    purchaseId: PurchaseId,
    input: {
      readonly bytes: Uint8Array;
      readonly mediaType: string;
      readonly profile: string;
      readonly issuer?: string;
      readonly kind: string;
      readonly attempt?: number;
    }
  ): EvidenceAttachmentRecord;
  recordEvidenceVerification(
    digest: Sha256Digest,
    input: {
      readonly verifierId: string;
      readonly profile: string;
      readonly detailDigest: Sha256Digest;
    }
  ): void;
  recordReconciliation(
    lease: LeaseToken,
    purchaseId: PurchaseId,
    effectId: string | undefined,
    outcome: string,
    detailDigest?: Sha256Digest
  ): Readonly<{
    readonly purchaseId: PurchaseId;
    readonly effectId?: string;
    readonly outcome: string;
    readonly detailDigest?: Sha256Digest;
  }>;
  reservePolicy(input: {
    readonly id: string;
    readonly purchaseId: ReservePurchaseCapacityInput["purchaseId"];
    readonly policyDigest: Sha256Digest;
    readonly payee: string;
    readonly amountAtomic: string;
    readonly additionalCostCeilingAtomic: string;
    readonly fundingSource: "vault-treasury";
    readonly expiresAtMs: number;
    readonly approvalEvidenceDigest: Sha256Digest;
    readonly approvalVerificationProfile: string;
    readonly approvalVerifierId: string;
  }): TreasuryPurchaseReservation;
  preflightTreasuryOperation(input: TreasuryOperationPreflight): void;
  claimTreasuryOperationIntent(input: TreasuryOperationIntent): TreasuryOperationRecord;
  claimTreasuryOperationDriver(
    operationKey: string,
    owner: string,
    leaseTtlMs: number,
  ): TreasuryDriverClaim;
  renewTreasuryOperationDriver(lease: TreasuryDriverLease, operationKey: string): TreasuryOperationRecord;
  releaseTreasuryOperationDriver(lease: TreasuryDriverLease, operationKey: string): TreasuryOperationRecord;
  recordPreparedTreasuryOperation(
    operationKey: string,
    prepared: PreparedTreasuryOperation,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord;
  recordTreasuryPreparationRetry(
    operationKey: string,
    reasonCode: string,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord;
  failTreasuryOperationPreparation(
    operationKey: string,
    reasonCode: string,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord;
  fenceTreasuryOperationPreparation(
    operationKey: string,
    reasonCode: string,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord;
  requestTreasuryOperationCancellation(operationKey: string): TreasuryOperationRecord;
  cancelTreasuryOperation(operationKey: string): TreasuryOperationRecord;
  readPreparedTreasuryOperation(operationKey: string): Buffer;
  readObservedTreasuryOperationDetail(
    operationKey: string
  ): Readonly<Record<string, unknown>>;
  planTreasuryOperationSubmission(operationKey: string, driver?: TreasuryDriverLease): boolean;
  claimTreasuryOperationEffectCapability(operationKey: string, driver: TreasuryDriverLease): boolean;
  recordTreasuryOperationSubmissionAccepted(
    operationKey: string,
    transactionId: string,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord;
  recordTreasuryOperationObservation(
    operationKey: string,
    status: TreasuryOperationObservationStatus,
    detail: Readonly<Record<string, unknown>>,
    driver?: TreasuryDriverLease,
    submissionOutcome?: TreasurySubmissionOutcome,
  ): TreasuryOperationRecord;
  completeTreasuryOperation(operationKey: string, driver?: TreasuryDriverLease): TreasuryOperationRecord;
  findTreasuryOperation(operationKey: string): TreasuryOperationRecord | undefined;
  requireTreasuryOperation(operationKey: string): TreasuryOperationRecord;
  listTreasuryOperations(kind: TreasuryOperationKind, limit: number): readonly TreasuryOperationRecord[];
  treasuryOperationSpentLastHour(): bigint;
  treasuryPolicyCapacityUsed(): bigint;
  treasuryPendingCapacityUsed(): bigint;
  unresolvedTreasuryOperationCount(): number;
  integrityCheck(): true;
}
