import type {
  CheckoutTerms,
  PurchaseId,
  Sha256Digest,
} from "../purchase/types.js";

export interface TreasuryPolicy {
  readonly maxPerPaymentAtomic: string;
  readonly maxPerHourAtomic: string;
  readonly allowlist: readonly string[];
}

export interface TreasuryQuote {
  readonly additionalCostCeilingAtomic: string;
  readonly reservationTtlMs: number;
  readonly ready: boolean;
  readonly blockerCode?: string;
}

export type TreasuryPurchaseFundingMode =
  | "staged-payment"
  | "precapitalized-channel";

export type TreasuryReservationState =
  | "active"
  | "in_flight"
  | "spent"
  | "released"
  | "expired";

export interface TreasuryPurchaseReservation {
  readonly id: string;
  readonly purchaseId: PurchaseId;
  readonly policyDigest: Sha256Digest;
  readonly approvalEvidenceDigest?: Sha256Digest;
  readonly approvalVerificationProfile?: string;
  readonly approvalVerifierId?: string;
  readonly payee: string;
  readonly amountAtomic: string;
  readonly additionalCostCeilingAtomic: string;
  readonly fundingSource: "vault-treasury";
  readonly state: TreasuryReservationState;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly inFlightAtMs?: number;
  readonly spentAtMs?: number;
  readonly releaseEvidenceDigest?: Sha256Digest;
}

export interface ReservePurchaseCapacityInput {
  readonly reservationId: string;
  readonly purchaseId: PurchaseId;
  readonly fundingMode: TreasuryPurchaseFundingMode;
  readonly terms: CheckoutTerms;
  readonly termsExpiresAtMs: number;
  readonly authorizedAdditionalCostCeilingAtomic: string;
  readonly authorization: {
    readonly evidenceDigest: Sha256Digest;
    readonly verificationProfile: string;
    readonly verifierId: string;
    readonly expiresAtMs: number;
  };
}

export type ReservePurchaseCapacityResult =
  | {
      readonly status: "not_ready";
      readonly quote: TreasuryQuote;
    }
  | {
      readonly status: "reserved";
      readonly reservation: TreasuryPurchaseReservation;
    };

/** Purchase-facing Treasury seam for readiness and durable policy capacity. */
export interface PurchaseTreasuryCapacity {
  quote(input: {
    readonly purchaseId: PurchaseId;
    readonly fundingMode: TreasuryPurchaseFundingMode;
    readonly terms: CheckoutTerms;
  }): Promise<TreasuryQuote>;
  reservePurchaseCapacity(
    input: Readonly<ReservePurchaseCapacityInput>
  ): Promise<Readonly<ReservePurchaseCapacityResult>>;
}

export type TreasuryCapacityErrorCode =
  | "treasury_policy_changed"
  | "treasury_quote_increased"
  | "treasury_quote_invalid";

export class TreasuryCapacityError extends Error {
  constructor(
    message: string,
    readonly code: TreasuryCapacityErrorCode,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "TreasuryCapacityError";
  }
}
