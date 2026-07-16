export const PURCHASE_STATES = [
  "created",
  "terms_bound",
  "awaiting_authority",
  "authorised",
  "execution_prepared",
  "submitted",
  "settled",
  "fulfilled",
  "receipted",
  "denied",
  "cancelled",
  "expired",
  "failed_recoverable",
  "failed_terminal",
] as const;

export type PurchaseState = (typeof PURCHASE_STATES)[number];

declare const purchaseIdBrand: unique symbol;
declare const requestKeyBrand: unique symbol;
declare const digestBrand: unique symbol;
declare const paymentIdentifierBrand: unique symbol;

export type PurchaseId = string & { readonly [purchaseIdBrand]: true };
export type PurchaseRequestKey = string & { readonly [requestKeyBrand]: true };
export type Sha256Digest = string & { readonly [digestBrand]: true };
export type PaymentIdentifier = string & { readonly [paymentIdentifierBrand]: true };
export type FundingSource = "vault-treasury";

export interface MerchantIdentity {
  id: string;
  name: string;
  origin: string;
}

export interface PurchaseResource {
  url: string;
  method: string;
  body?: Uint8Array;
  mediaType?: string;
}

export interface PurchaseIntent {
  /** Caller-controlled idempotency identity, not an authorization token. */
  requestKey: PurchaseRequestKey;
  resource: PurchaseResource;
  expectedMerchant?: {
    id?: string;
    origin?: string;
  };
}

export interface CheckoutTerms {
  merchant: MerchantIdentity;
  resourceFingerprint: Sha256Digest;
  amountAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  expiresAt: string;
  checkoutDigest: Sha256Digest;
}

export interface PurchaseAuthorizationView {
  status: "not_requested" | "pending" | "approved" | "denied" | "expired";
  authorityId?: string;
  evidenceDigest?: Sha256Digest;
}

export interface TreasuryView {
  status: "unreserved" | "reserved" | "committed" | "released" | "expired";
  amountAtomic?: string;
  additionalCostCeilingAtomic?: string;
  reservationId?: string;
  fundingSource?: FundingSource;
}

export interface PaymentAttemptView {
  attempt: number;
  identifier: PaymentIdentifier;
  status: "planned" | "prepared" | "submitted" | "observed" | "failed";
  transactionId?: string;
  finality?: string;
  evidenceDigests: readonly Sha256Digest[];
}

export interface PurchaseView {
  id: PurchaseId;
  requestKey: PurchaseRequestKey;
  state: PurchaseState;
  summary: string;
  userAction?: string;
  resourceFingerprint: Sha256Digest;
  terms?: CheckoutTerms;
  authorization: PurchaseAuthorizationView;
  treasury: TreasuryView;
  paymentAttempts: readonly PaymentAttemptView[];
  settlementEvidence?: Sha256Digest;
  fulfilmentDigest?: Sha256Digest;
  receiptEvidence: readonly Sha256Digest[];
  /** Bounded content only. Large fulfilments use an implementation-owned handle. */
  fulfilmentBody?: string;
  /** Opaque reference returned instead of oversized or non-text Fulfilment content. */
  fulfilmentHandle?: string;
}

/**
 * The stable external interface of the deep Purchase module.
 *
 * `purchase` is idempotent by `requestKey`. It may return a waiting,
 * recoverable, or terminal state. `recover` observes and reconciles; it never
 * blindly repeats an irreversible effect.
 */
export interface PurchaseModule {
  purchase(intent: PurchaseIntent, signal?: AbortSignal): Promise<PurchaseView>;
  status(id: PurchaseId, signal?: AbortSignal): Promise<PurchaseView>;
  recover(id: PurchaseId, signal?: AbortSignal): Promise<PurchaseView>;
}
