import type { CanonicalCheckoutTerms } from "../../purchase/contracts.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";

export const AP2_HUMAN_PRESENT_PROFILE = "ap2-v0.2-hp-direct-sd-jwt-es256" as const;
export const AP2_NATIVE_KAS_INSTRUMENT_PROFILE =
  "urn:sompi:ap2:payment-instrument:kaspa-x402:1" as const;
export const SOMPI_MERCHANT_CHECKOUT_PROFILE =
  "urn:sompi:checkout:single-resource:2" as const;
export const SOMPI_MERCHANT_RECEIPT_PROFILE = "urn:sompi:receipt:merchant:1" as const;
export const SOMPI_PAYMENT_RECEIPT_PROFILE = "urn:sompi:receipt:payment:1" as const;
export const AP2_CHECKOUT_MANDATE_VCT = "mandate.checkout.1" as const;
export const AP2_PAYMENT_MANDATE_VCT = "mandate.payment.1" as const;
/** Literal emitted by the exact AP2 v0.2 Python dependency pin. */
export const AP2_ROOT_SD_JWT_TYP = "example+sd-jwt" as const;
export const KASPA_TESTNET_NETWORK = "kaspa:testnet-10" as const;
export const KAS_ASSET = "KAS" as const;
export const KAS_ATOMIC_UNIT = "sompi" as const;
export const KAS_DECIMALS = 8 as const;
export const KASPA_X402_SCHEME = "exact" as const;

export type Ap2SigningRole =
  | "merchant-checkout"
  | "authority"
  | "merchant-receipt"
  | "payment-receipt";

export interface P256PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly alg?: "ES256";
  readonly kid?: string;
  readonly use?: "sig";
  readonly key_ops?: readonly string[];
}

export interface P256PrivateJwk extends P256PublicJwk {
  readonly d: string;
}

export interface Ap2PublicTrustEntry {
  readonly role: Ap2SigningRole;
  readonly issuer: string;
  readonly kid: string;
  readonly publicJwk: P256PublicJwk;
}

export interface Ap2SigningIdentity {
  readonly role: Ap2SigningRole;
  readonly issuer: string;
  readonly kid: string;
  readonly privateJwk: P256PrivateJwk;
}

export interface Ap2PublicKeyResolver {
  resolve(
    role: Ap2SigningRole,
    issuer: string,
    kid: string
  ): P256PublicJwk | undefined | Promise<P256PublicJwk | undefined>;
}

export interface Ap2VerificationClock {
  /** Unix epoch seconds. Defaults to the current system clock. */
  readonly nowSec?: number;
  /** Bounded allowance for clock disagreement. Defaults to 30 seconds. */
  readonly clockSkewSec?: number;
}

export interface MerchantCheckoutClaims {
  readonly profile: typeof SOMPI_MERCHANT_CHECKOUT_PROFILE;
  readonly iss: string;
  readonly aud: string;
  readonly kid: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
  readonly purchase_id: string;
  readonly merchant: {
    readonly id: string;
    readonly name: string;
    readonly website: string;
    readonly origin: string;
  };
  readonly resource: {
    readonly url: string;
    readonly method: string;
    readonly request_fingerprint: string;
  };
  readonly price: {
    readonly amount_atomic: string;
    readonly asset: typeof KAS_ASSET;
    readonly network: typeof KASPA_TESTNET_NETWORK;
    readonly pay_to: string;
  };
  /** Digest of opaque payment-requirements bytes; their protocol is not an AP2 claim. */
  readonly payment_requirements: {
    readonly digest: string;
  };
  readonly treasury: {
    readonly mode: "separately-reserved";
    readonly additional_cost_ceiling_atomic: string;
  };
  readonly fulfilment?: {
    readonly identity: string;
    readonly expected_digest?: string;
  };
}

/** Verified protocol bytes projected into stable Sompi terms and identifiers. */
export interface VerifiedMerchantCheckout {
  readonly artifact: string;
  readonly profile: typeof SOMPI_MERCHANT_CHECKOUT_PROFILE;
  readonly issuer: string;
  readonly kid: string;
  readonly audience: string;
  readonly purchaseId: PurchaseId;
  readonly issuedAtSec: number;
  readonly expiresAtSec: number;
  readonly checkoutHash: string;
  readonly checkoutDigest: Sha256Digest;
  readonly claims: MerchantCheckoutClaims;
  readonly terms: CanonicalCheckoutTerms;
  readonly resourceUrl: string;
  readonly method: string;
  readonly paymentRequirementsDigest: Sha256Digest;
  readonly additionalCostCeilingAtomic: string;
  readonly fulfilment?: {
    readonly identity: string;
    readonly expectedDigest?: Sha256Digest;
  };
}

export interface ClosedCheckoutMandateContent {
  readonly vct: typeof AP2_CHECKOUT_MANDATE_VCT;
  readonly checkout_jwt: string;
  readonly checkout_hash: string;
  readonly iat: number;
  readonly exp: number;
}

export interface ClosedPaymentMandateContent {
  readonly vct: typeof AP2_PAYMENT_MANDATE_VCT;
  readonly transaction_id: string;
  readonly payee: {
    readonly id: string;
    readonly name: string;
    readonly website: string;
  };
  readonly payment_amount: {
    readonly amount: number;
    readonly currency: typeof KAS_ASSET;
  };
  readonly payment_instrument: {
    readonly id: string;
    readonly type: typeof AP2_NATIVE_KAS_INSTRUMENT_PROFILE;
    readonly description: "Native KAS via Kaspa-x402 exact";
    readonly network: typeof KASPA_TESTNET_NETWORK;
    readonly asset: typeof KAS_ASSET;
    readonly atomicUnit: typeof KAS_ATOMIC_UNIT;
    readonly decimals: typeof KAS_DECIMALS;
    readonly scheme: typeof KASPA_X402_SCHEME;
  };
  readonly iat: number;
  readonly exp: number;
}

export interface VerifiedClosedCheckoutMandate {
  readonly artifact: string;
  readonly profile: typeof AP2_HUMAN_PRESENT_PROFILE;
  readonly authorityIssuer: string;
  readonly kid: string;
  readonly issuerJwtReference: string;
  readonly content: ClosedCheckoutMandateContent;
}

export interface VerifiedClosedPaymentMandate {
  readonly artifact: string;
  readonly profile: typeof AP2_HUMAN_PRESENT_PROFILE;
  readonly authorityIssuer: string;
  readonly kid: string;
  readonly issuerJwtReference: string;
  readonly content: ClosedPaymentMandateContent;
  readonly amountAtomic: string;
  readonly network: typeof KASPA_TESTNET_NETWORK;
  readonly asset: typeof KAS_ASSET;
}

export interface VerifiedHumanPresentMandates {
  readonly checkout: VerifiedClosedCheckoutMandate;
  readonly payment: VerifiedClosedPaymentMandate;
}

export type Ap2ReceiptRole = "merchant" | "payment";

export interface VerifiedAp2Receipt {
  readonly artifact: string;
  readonly role: Ap2ReceiptRole;
  readonly profile:
    | typeof SOMPI_MERCHANT_RECEIPT_PROFILE
    | typeof SOMPI_PAYMENT_RECEIPT_PROFILE;
  readonly issuer: string;
  readonly kid: string;
  readonly status: "Success" | "Error";
  readonly issuedAtSec: number;
  readonly reference: string;
  readonly orderId?: string;
  readonly paymentId?: string;
  readonly pspConfirmationId?: string;
  readonly networkConfirmationId?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}
