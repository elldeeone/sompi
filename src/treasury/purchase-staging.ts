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

/** Protocol adapter behind Treasury. It prepares bytes but cannot persist them. */
export interface TreasuryStagingPreparationAdapter {
  prepareStaging(
    input: Readonly<PrepareTreasuryStagingAdapterInput>
  ): Promise<Readonly<PreparedTreasuryStaging>>;
}

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
