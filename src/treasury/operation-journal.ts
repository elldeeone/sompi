export type TreasuryOperationKind = "wallet_send" | "vault_send" | "vault_deposit";
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
  readonly resolvedAmountAtomic?: string;
  readonly feeAtomic?: string;
  readonly transactionId?: string;
  readonly preparedDigest?: string;
  readonly preparedByteLength?: number;
  readonly policyDigest?: string;
  readonly state: TreasuryOperationState;
  readonly retryCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs?: number;
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
  | "pending";

/**
 * Direct Treasury operations use the Purchase Journal implementation of this
 * interface. It is intentionally not a second store: Purchase and direct
 * capacity reservations must share one SQLite transaction and policy snapshot.
 */
export interface TreasuryOperationJournal {
  installPolicy(definition: {
    readonly maxPerPaymentAtomic: string;
    readonly maxPerHourAtomic: string;
    readonly approvalAboveAtomic: string;
    readonly allowlist: readonly string[];
  }): { readonly digest: string };
  claimTreasuryOperationIntent(input: TreasuryOperationIntent): TreasuryOperationRecord;
  recordPreparedTreasuryOperation(
    operationKey: string,
    prepared: PreparedTreasuryOperation
  ): TreasuryOperationRecord;
  recordTreasuryPreparationRetry(
    operationKey: string,
    reasonCode: string
  ): TreasuryOperationRecord;
  failTreasuryOperationPreparation(
    operationKey: string,
    reasonCode: string
  ): TreasuryOperationRecord;
  cancelTreasuryOperation(operationKey: string): TreasuryOperationRecord;
  readPreparedTreasuryOperation(operationKey: string): Buffer;
  readObservedTreasuryOperationDetail(
    operationKey: string
  ): Readonly<Record<string, unknown>>;
  planTreasuryOperationSubmission(operationKey: string): boolean;
  recordTreasuryOperationSubmissionAccepted(
    operationKey: string,
    transactionId: string
  ): TreasuryOperationRecord;
  recordTreasuryOperationObservation(
    operationKey: string,
    status: TreasuryOperationObservationStatus,
    detail: Readonly<Record<string, unknown>>
  ): TreasuryOperationRecord;
  completeTreasuryOperation(operationKey: string): TreasuryOperationRecord;
  requireTreasuryOperation(operationKey: string): TreasuryOperationRecord;
  treasuryOperationSpentLastHour(): bigint;
  treasuryPolicyCapacityUsed(): bigint;
  unresolvedTreasuryOperationCount(): number;
  integrityCheck(): true;
}
