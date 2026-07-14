import type {
  FulfilmentResult,
  SettlementResult,
} from "./coordinator.js";
import type {
  PurchaseAuthorizationDecision,
  PurchaseAuthorizationRequest,
} from "./contracts.js";
import type {
  CheckoutTerms,
  PaymentIdentifier,
  PurchaseId,
  Sha256Digest,
} from "./types.js";

export interface PaidResourcePurchaseContext {
  readonly purchaseId: PurchaseId;
  readonly terms: CheckoutTerms;
  readonly authorizationRequest: PurchaseAuthorizationRequest;
  readonly authorization: PurchaseAuthorizationDecision;
  readonly paymentIdentifier: PaymentIdentifier;
  readonly request: Readonly<{
    url: string;
    method: string;
    requestFingerprint: Sha256Digest;
  }>;
  readonly paymentRequirements: Uint8Array;
  readonly preparedTransactionId: string;
}

/** Bounded paid HTTP response plus the canonical Purchase facts it must join. */
export interface PaidResourceResponse {
  readonly context: Readonly<PaidResourcePurchaseContext>;
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly mediaType?: string;
  readonly settlement: Readonly<SettlementResult>;
}

/**
 * Sompi-owned fulfilment seam. Protocol adapters may implement or invoke it,
 * but neither adapter owns the other adapter's interface.
 */
export interface PaidResourceResponseVerifier {
  verify(
    input: Readonly<PaidResourceResponse>
  ): Promise<Extract<FulfilmentResult, { status: "fulfilled" }> | undefined>;
}
