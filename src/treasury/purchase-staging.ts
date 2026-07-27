import type {
  PurchaseAuthorizationDecision,
  PurchaseAuthorizationRequest,
} from "../purchase/contracts.js";
import type {
  CheckoutTerms,
  FundingSource,
  PaymentIdentifier,
  PurchaseId,
  Sha256Digest,
} from "../purchase/types.js";

export interface TreasuryStagingExecution {
  readonly purchaseId: PurchaseId;
  readonly terms: CheckoutTerms;
  readonly authorizationRequest: PurchaseAuthorizationRequest;
  readonly authorization: PurchaseAuthorizationDecision;
  readonly paymentIdentifier: PaymentIdentifier;
}

export interface TreasuryStagingRequest {
  readonly url: string;
  readonly method: string;
  readonly mediaType?: string;
  readonly body: Uint8Array;
  readonly requestFingerprint: Sha256Digest;
}

export interface PreparePurchaseStagingInput {
  readonly purchaseId: PurchaseId;
  readonly attempt: number;
}

export interface TreasuryStagingPreparationContext {
  readonly execution: TreasuryStagingExecution;
  readonly request: TreasuryStagingRequest;
  readonly paymentRequirements: Uint8Array;
}

export interface PrepareTreasuryStagingAdapterInput
  extends TreasuryStagingPreparationContext {
  readonly additionalCostCeilingAtomic: string;
}

export interface PreparedTreasuryStaging {
  readonly preparedBytes: Uint8Array;
  readonly preparedDigest: Sha256Digest;
  readonly transactionId: string;
  readonly expectedOutpoint: string;
  readonly stagingAmountAtomic: string;
  readonly fundingSource: "vault-treasury";
}

export interface PlanTreasuryStagingInput {
  readonly purchaseId: PurchaseId;
  readonly attempt: number;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: Sha256Digest;
  readonly preparedBytes: Uint8Array;
  readonly plannedTransactionId: string;
  readonly expectedOutpoint: string;
  readonly stagingAmountAtomic: string;
  readonly fundingSource: FundingSource;
}

export interface TreasuryStagingPlanRecord
  extends Omit<PlanTreasuryStagingInput, "preparedBytes"> {
  readonly effectId: string;
  readonly preparedRef: string;
  readonly preparedByteLength: number;
  readonly createdAtMs: number;
}

export interface TreasuryStagingPreparationResult {
  readonly payloadDigest: Sha256Digest;
}

export interface TreasuryStagingEffect {
  readonly id: string;
  readonly purchaseId: PurchaseId;
  readonly attempt?: number;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: Sha256Digest;
  readonly state:
    | "planned"
    | "executing"
    | "submitted"
    | "ambiguous"
    | "retryable"
    | "observed"
    | "failed_terminal"
    | "abandoned";
  readonly submissionDigest?: Sha256Digest;
  readonly resultDigest?: Sha256Digest;
}

export interface TreasuryStagingAdapterContext
  extends TreasuryStagingPreparationContext {
  readonly staging: {
    readonly preparedBytes: Uint8Array;
    readonly preparedDigest: Sha256Digest;
    readonly transactionId: string;
    readonly expectedOutpoint: string;
    readonly amountAtomic: string;
    readonly fundingSource: "vault-treasury";
  };
}

export interface TreasuryStagingEvidence {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly profile: string;
  readonly issuer?: string;
  readonly declaredDigest?: Sha256Digest;
  readonly verification: {
    readonly verifierId: string;
    readonly profile: string;
    readonly detailDigest: Sha256Digest;
  };
}

export interface TreasuryStagingResult {
  readonly evidence: TreasuryStagingEvidence;
  readonly transactionId: string;
  readonly outpoint: string;
  readonly stagingAmountAtomic: string;
  readonly fundingSource: "vault-treasury";
}

export type TreasuryStagingSubmissionResult =
  | { readonly status: "submitted"; readonly submissionDigest: Sha256Digest }
  | {
      readonly status: "staged";
      readonly submissionDigest: Sha256Digest;
      readonly staging: TreasuryStagingResult;
    };

export type TreasuryStagingRecoveryObservation =
  | { readonly status: "pending"; readonly detailDigest?: Sha256Digest }
  | {
      readonly status: "not_found";
      readonly safeToRetry: boolean;
      readonly detailDigest: Sha256Digest;
    }
  | { readonly status: "conflict"; readonly detailDigest: Sha256Digest }
  | {
      readonly status: "application_failure";
      readonly errorCode: string;
      readonly detailDigest: Sha256Digest;
    }
  | { readonly status: "staged"; readonly staging: TreasuryStagingResult };

export interface ExecutePurchaseStagingInput {
  readonly purchaseId: PurchaseId;
  readonly attempt: number;
}

export type TreasuryStagingExecutionResult =
  | {
      readonly status: "observed";
      readonly evidenceDigest: Sha256Digest;
    }
  | {
      readonly status: "reconciliation_required";
      readonly detailDigest: Sha256Digest;
    }
  | {
      readonly status: "pending";
      readonly detailDigest?: Sha256Digest;
    };

export interface TreasuryStagingPreparationLease {
  readonly name: string;
  readonly holder: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

/** Purchase-facing Treasury operation. It returns only after durable planning. */
export interface PurchaseTreasuryStagingPreparation {
  preparePurchaseStaging(
    input: Readonly<PreparePurchaseStagingInput>
  ): Promise<Readonly<TreasuryStagingPreparationResult>>;
}

/** Purchase-facing Treasury operation for one already-prepared staging plan. */
export interface PurchaseTreasuryStagingExecution {
  executePurchaseStaging(
    input: Readonly<ExecutePurchaseStagingInput>
  ): Promise<Readonly<TreasuryStagingExecutionResult>>;
}

/** Protocol adapter behind Treasury. It prepares bytes but cannot persist them. */
export interface TreasuryStagingPreparationAdapter {
  prepareStaging(
    input: Readonly<PrepareTreasuryStagingAdapterInput>
  ): Promise<Readonly<PreparedTreasuryStaging>>;
}

/** Protocol adapter behind Treasury. It cannot choose or persist execution. */
export interface TreasuryStagingExecutionAdapter {
  submitStaging(input: {
    readonly context: TreasuryStagingAdapterContext;
    readonly effect: TreasuryStagingEffect;
    readonly signal: AbortSignal;
  }): Promise<Readonly<TreasuryStagingSubmissionResult>>;
  observeStaging(input: {
    readonly context: TreasuryStagingAdapterContext;
    readonly effect: TreasuryStagingEffect;
  }): Promise<Readonly<TreasuryStagingRecoveryObservation>>;
}

export interface TreasuryStagingAdapter
  extends TreasuryStagingPreparationAdapter,
    TreasuryStagingExecutionAdapter {}

export type TreasuryStagingPreparationErrorCode =
  | "payment_invariant"
  | "treasury_reservation_invariant"
  | "treasury_staging_busy"
  | "treasury_staging_mismatch";

export class TreasuryStagingPreparationError extends Error {
  constructor(
    message: string,
    readonly code: TreasuryStagingPreparationErrorCode,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "TreasuryStagingPreparationError";
  }
}

export function treasuryStagingPreparationLeaseName(
  purchaseId: PurchaseId,
  attempt: number,
): string {
  return `treasury-staging-prepare:${purchaseId}:${attempt}`;
}
