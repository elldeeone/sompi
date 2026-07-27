import type {
  CheckoutTerms,
  PaymentIdentifier,
  PurchaseId,
  Sha256Digest,
} from "../purchase/types.js";

export interface RecoverPurchaseStagingInput {
  readonly purchaseId: PurchaseId;
}

export type PurchaseStagingRecoveryResult = Readonly<{
  status:
    | "none"
    | "pending"
    | "exact_payment_won"
    | "recovery_won"
    | "conflict";
}>;

/** Purchase-facing Treasury operation for abandoned staging recovery. */
export interface PurchaseTreasuryStagingRecovery {
  recoverPurchaseStaging(
    input: Readonly<RecoverPurchaseStagingInput>,
  ): Promise<PurchaseStagingRecoveryResult>;
}

export interface StagingRecoveryPreparationContext {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: PaymentIdentifier;
  readonly terms: CheckoutTerms;
  readonly paymentRequirements: Uint8Array;
  readonly stagingEvidenceDigest: Sha256Digest;
  readonly exactPayment?: {
    readonly preparedBytes: Uint8Array;
    readonly preparedDigest: Sha256Digest;
    readonly transactionId: string;
    readonly requiredFinality: string;
  };
  readonly authorizedAdditionalCostCeilingAtomic: string;
}

export interface PreparedStagingRecovery {
  readonly preparedBytes: Uint8Array;
  readonly preparedDigest: Sha256Digest;
  readonly exactTransactionId?: string;
  readonly recoveryTransactionId: string;
  readonly recoveryOutpoint: string;
  readonly recoveryAmountAtomic: string;
  readonly stagingFeeAtomic: string;
  readonly recoveryFeeAtomic: string;
  readonly requiredFinality: string;
}

export interface StagingRecoveryReadiness {
  readonly proofDigest: Sha256Digest;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  /** Adapter-owned token. Only the persisted proof facts are canonical. */
  readonly token: unknown;
}

export type StagingRecoveryObservation =
  | {
      readonly status: "safe_to_submit";
      readonly evidenceDigest: Sha256Digest;
      readonly readiness: StagingRecoveryReadiness;
    }
  | { readonly status: "pending"; readonly evidenceDigest: Sha256Digest }
  | {
      readonly status: "exact_payment_won";
      readonly transactionId: string;
      readonly finality: string;
      readonly evidenceDigest: Sha256Digest;
    }
  | {
      readonly status: "recovery_won";
      readonly transactionId: string;
      readonly recoveryOutpoint: string;
      readonly recoveryAmountAtomic: string;
      readonly finality: string;
      readonly evidenceDigest: Sha256Digest;
    }
  | {
      readonly status: "conflict";
      readonly reason: string;
      readonly evidenceDigest: Sha256Digest;
    };

export type StagingRecoverySubmission =
  | {
      readonly status: "accepted";
      readonly transactionId: string;
      readonly submissionDigest: Sha256Digest;
    }
  | {
      readonly status: "ambiguous";
      readonly transactionId: string;
      readonly submissionDigest: Sha256Digest;
    }
  | {
      readonly status: "conflict";
      readonly transactionId: string;
      readonly submissionDigest: Sha256Digest;
    };

/** Kaspa-x402 adapter behind Treasury. It cannot choose or persist recovery. */
export interface TreasuryStagingRecoveryAdapter {
  prepare(
    input: Readonly<StagingRecoveryPreparationContext>,
  ): Promise<Readonly<PreparedStagingRecovery>>;
  observe(input: {
    readonly preparedBytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<Readonly<StagingRecoveryObservation>>;
  submit(input: {
    readonly preparedBytes: Uint8Array;
    readonly readiness: Readonly<StagingRecoveryReadiness>;
    readonly signal: AbortSignal;
  }): Promise<Readonly<StagingRecoverySubmission>>;
}
