import { evidenceDigest, requestFingerprint } from "../../purchase/identity.js";
import type { CanonicalCheckoutTerms } from "../../purchase/contracts.js";
import type { PurchaseId } from "../../purchase/types.js";
import { LocalAp2TrustStore } from "./crypto.js";
import type {
  Ap2PublicTrustEntry,
  Ap2SigningIdentity,
  P256PrivateJwk,
  P256PublicJwk,
} from "./types.js";

export const FIXED_NOW = 2_000_000_000;
export const FIXED_PURCHASE_ID = "pur_AAAAAAAAAAAAAAAAAAAAAA" as PurchaseId;
export const FIXED_INSTRUMENT_ID = "instrument:testnet:v1";
export const FIXED_AUTHORITY_ISSUER = "urn:sompi:authority:test";
export const FIXED_MERCHANT_ORIGIN = "https://merchant.example";
export const FIXED_RESOURCE_URL = `${FIXED_MERCHANT_ORIGIN}/resource`;
export const FIXED_PAY_TO =
  "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
export const FIXED_ADDITIONAL_COST_CEILING_ATOMIC = "1500000";

const AUTHORITY_JWK: P256PrivateJwk = Object.freeze({
  kty: "EC",
  crv: "P-256",
  x: "PjJTTHAk-_jrGUwZx5O1f0ODiA_z6BnhvkPvgjfCYbA",
  y: "B3fBGs9fD4V1SCr33_F1sTp7MlJVq4p7pUTRXDlDDv4",
  d: "ALSko8gD4sNqwoxVFcLcBcwkHVQN8OTH9yj3VYXaF8Q",
});

export const WRONG_JWK: P256PrivateJwk = Object.freeze({
  kty: "EC",
  crv: "P-256",
  x: "u5RMStKYMl92F8CAdFvXe9rTFnxWE-ZWGFGYKTxSLik",
  y: "WGSDHjJ_CHxs11a6W03hXvns8xavmP_aP7a8MlETR5M",
  d: "4MWIMtiPiP9QY0_htuw3n3-PerD0eSEdl9MLbIhLyL8",
});

export const AUTHORITY_SIGNER: Ap2SigningIdentity = Object.freeze({
  role: "authority",
  issuer: FIXED_AUTHORITY_ISSUER,
  kid: "authority-key-1",
  privateJwk: AUTHORITY_JWK,
});

export function fixedTrustStore(
  extra: readonly Ap2PublicTrustEntry[] = [],
): LocalAp2TrustStore {
  return new LocalAp2TrustStore([publicTrust(AUTHORITY_SIGNER), ...extra]);
}

export function fixedGenericCheckout(): Readonly<{
  purchaseId: PurchaseId;
  resourceUrl: string;
  method: "GET";
  terms: CanonicalCheckoutTerms;
  additionalCostCeilingAtomic: string;
}> {
  return Object.freeze({
    purchaseId: FIXED_PURCHASE_ID,
    resourceUrl: FIXED_RESOURCE_URL,
    method: "GET",
    terms: Object.freeze({
      merchant: Object.freeze({
        id: FIXED_MERCHANT_ORIGIN,
        name: "merchant.example",
        origin: FIXED_MERCHANT_ORIGIN,
      }),
      resourceFingerprint: requestFingerprint({
        url: FIXED_RESOURCE_URL,
        method: "GET",
      }),
      amountAtomic: "20000000",
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: FIXED_PAY_TO,
      expiresAt: new Date((FIXED_NOW + 300) * 1_000).toISOString(),
      checkoutDigest: evidenceDigest("generic-x402-payment-required"),
    }),
    additionalCostCeilingAtomic: FIXED_ADDITIONAL_COST_CEILING_ATOMIC,
  });
}

function publicTrust(identity: Ap2SigningIdentity): Ap2PublicTrustEntry {
  const { d: _private, ...publicJwk } = identity.privateJwk;
  return Object.freeze({
    role: identity.role,
    issuer: identity.issuer,
    kid: identity.kid,
    publicJwk: Object.freeze(publicJwk) as P256PublicJwk,
  });
}
