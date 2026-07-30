import type {
  CanonicalPurchaseExecutionPlan,
  PurchaseExecutionAssurance,
  PurchaseExecutionMechanism,
  PurchaseExecutionPlan,
} from "./execution-plan.js";
import type { StoreEvidenceInput } from "../journal/contracts.js";
import type {
  CheckoutTerms,
  FundingSource,
  PaymentIdentifier,
  PurchaseId,
  PurchaseRequestKey,
  PurchaseState,
  Sha256Digest,
} from "./types.js";

const PAYMENT_ATTEMPT_STATES = [
  "planned",
  "prepared",
  "submitted",
  "observed",
  "failed",
] as const;

type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

export const PURCHASE_RECEIPT_PROFILE =
  "urn:sompi:receipt:purchase:1" as const;

export interface JournalAdmissionStatus {
  readonly prevalidationPurchases: Readonly<{
    used: number;
    budget: number;
    saturated: boolean;
  }>;
  readonly evidenceBytes: Readonly<{
    used: number;
    reserved: number;
    budget: number;
    saturated: boolean;
  }>;
}

export interface CreatePurchaseInput {
  id: PurchaseId;
  requestKey: PurchaseRequestKey;
  resourceUrl: string;
  method: string;
  resourceFingerprint: Sha256Digest;
  expectedMerchantId?: string;
  expectedMerchantOrigin?: string;
}

export interface PurchaseRecord extends CreatePurchaseInput {
  state: PurchaseState;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PurchaseTransitionRecord {
  sequence: number;
  purchaseId: PurchaseId;
  fromState?: PurchaseState;
  toState: PurchaseState;
  reasonCode: string;
  detailDigest?: Sha256Digest;
  createdAtMs: number;
}

export interface BindCheckoutTermsInput {
  terms: CheckoutTerms;
  checkoutEvidenceDigest: Sha256Digest;
  checkoutVerificationProfile: string;
  checkoutVerifierId: string;
  paymentRequirementsDigest: Sha256Digest;
  paymentRequirementsVerificationProfile: string;
  paymentRequirementsVerifierId: string;
  executionPlan: PurchaseExecutionPlan;
  executionPlanEvidenceDigest: Sha256Digest;
}

export interface CheckoutTermsRecord extends CheckoutTerms {
  purchaseId: PurchaseId;
  expiresAtMs: number;
  checkoutEvidenceDigest: Sha256Digest;
  checkoutVerificationProfile: string;
  checkoutVerifierId: string;
  paymentRequirementsDigest: Sha256Digest;
  paymentRequirementsVerificationProfile: string;
  paymentRequirementsVerifierId: string;
  createdAtMs: number;
}

export interface PurchaseExecutionPlanRecord
  extends CanonicalPurchaseExecutionPlan {
  purchaseId: PurchaseId;
  evidenceDigest: Sha256Digest;
  createdAtMs: number;
}

export interface RecordAuthorizationRequestInput {
  checkoutDigest: Sha256Digest;
  requestDigest: Sha256Digest;
  nonceDigest: Sha256Digest;
  requestMediaType: string;
  requestBodyDigest: Sha256Digest;
  additionalCostCeilingAtomic: string;
  effectiveFinalityFloor: "accepted" | "depth-confirmed";
  expiresAtMs: number;
}

export interface AuthorizationRequestRecord
  extends RecordAuthorizationRequestInput {
  purchaseId: PurchaseId;
  executionPlanDigest: Sha256Digest;
  executionMechanism: PurchaseExecutionMechanism;
  executionProfile: string;
  settlementAssurance: PurchaseExecutionAssurance;
  maximumAuthorizedChargeAtomic: string;
  channelId?: string;
  channelEpochDigest?: Sha256Digest;
  createdAtMs: number;
}

export interface RecordAuthorizationDecisionInput {
  decision: "approved" | "denied" | "expired";
  authorityId: string;
  checkoutDigest: Sha256Digest;
  approvedFactsDigest: Sha256Digest;
  evidenceDigest: Sha256Digest;
  verificationProfile: string;
  verifierId: string;
  requestDigest: Sha256Digest;
  nonceDigest: Sha256Digest;
  expiresAtMs: number;
}

export interface AuthorizationRecord
  extends RecordAuthorizationDecisionInput {
  purchaseId: PurchaseId;
  decidedAtMs: number;
}

export interface RecordFulfilmentInput {
  attempt: number;
  httpStatus: number;
  resourceFingerprint: Sha256Digest;
  bodyDigest: Sha256Digest;
  bodyByteLength: number;
  mediaType: string;
  merchantEvidenceDigest: Sha256Digest;
  merchantVerificationProfile: string;
  merchantVerifierId: string;
}

export interface FulfilmentRecord extends RecordFulfilmentInput {
  purchaseId: PurchaseId;
  createdAtMs: number;
}

export interface RecordReceiptInput {
  evidenceDigest: Sha256Digest;
  profile: string;
  issuer?: string;
  verifierId: string;
  checkoutDigest: Sha256Digest;
  authorizationEvidenceDigest: Sha256Digest;
  settlementEvidenceDigest: Sha256Digest;
  fulfilmentDigest: Sha256Digest;
}

export interface ReceiptRecord extends RecordReceiptInput {
  purchaseId: PurchaseId;
  canonicalDigest: Sha256Digest;
  createdAtMs: number;
}

export interface EvidenceLinkRecord {
  purchaseId: PurchaseId;
  digest: Sha256Digest;
  kind: string;
  attempt?: number;
  mediaType: string;
  profile: string;
  issuer?: string;
  attachedAtMs: number;
}

export interface CreatePurchaseWithEvidenceInput {
  purchase: CreatePurchaseInput;
  evidence: StoreEvidenceInput;
}

export interface CreatePaymentAttemptInput {
  purchaseId: PurchaseId;
  attempt: number;
  identifier: PaymentIdentifier;
}

export interface PaymentAttemptRecord extends CreatePaymentAttemptInput {
  state: PaymentAttemptState;
  version: number;
  failureCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PreparePaymentAttemptInput {
  purchaseId: PurchaseId;
  attempt: number;
  reservationId: string;
  requirementsDigest: Sha256Digest;
  payloadDigest: Sha256Digest;
  preparedBytes: Uint8Array;
  executionId: string;
  mechanism: PurchaseExecutionMechanism;
  profile: string;
  transactionId?: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payee: string;
  requiredAssurance: PurchaseExecutionAssurance;
  fundingSource: FundingSource;
}

export interface PaymentPreparationRecord
  extends Omit<PreparePaymentAttemptInput, "preparedBytes"> {
  preparedRef: string;
  preparedByteLength: number;
  createdAtMs: number;
}

export interface RecordPurchaseSettlementInput {
  effectId: string;
  reservationId: string;
  executionId: string;
  mechanism: PurchaseExecutionMechanism;
  profile: string;
  transactionId?: string;
  commitmentId?: string;
  outpoint?: string;
  actualAmountAtomic: string;
  actualAdditionalCostAtomic: string;
  asset: string;
  payee: string;
  network: string;
  settlementAssurance: PurchaseExecutionAssurance;
  fundingSource: FundingSource;
  evidenceDigest: Sha256Digest;
  evidenceVerificationProfile: string;
  evidenceVerifierId: string;
}

export interface PurchaseSettlementRecord
  extends RecordPurchaseSettlementInput {
  id: number;
  purchaseId: PurchaseId;
  attempt: number;
  observedAtMs: number;
}

export interface ReconciliationRunRecord {
  id: number;
  purchaseId: PurchaseId;
  effectId?: string;
  outcome: string;
  detailDigest?: Sha256Digest;
  leaseName: string;
  leaseGeneration: number;
  createdAtMs: number;
}

export class PurchaseAdmissionError extends Error {
  readonly code = "purchase_admission_saturated" as const;

  constructor(message = "Purchase admission capacity is saturated") {
    super(message);
    this.name = "PurchaseAdmissionError";
  }
}

export class EvidenceAdmissionError extends Error {
  readonly code = "evidence_admission_saturated" as const;

  constructor(message = "Evidence admission capacity is saturated") {
    super(message);
    this.name = "EvidenceAdmissionError";
  }
}
