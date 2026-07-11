import { evidenceDigest, requestFingerprint } from "../../purchase/identity.js";
import { issueHumanPresentMandates, verifyHumanPresentMandates } from "./mandates.js";
import { issueMerchantCheckout, verifyMerchantCheckout } from "./merchant-checkout.js";
import { LocalAp2TrustStore } from "./crypto.js";
import {
  KASPA_TESTNET_NETWORK,
  KAS_ASSET,
  SOMPI_MERCHANT_CHECKOUT_PROFILE,
  type Ap2PublicTrustEntry,
  type Ap2SigningIdentity,
  type Ap2SigningRole,
  type MerchantCheckoutClaims,
  type P256PrivateJwk,
  type P256PublicJwk,
  type VerifiedHumanPresentMandates,
  type VerifiedMerchantCheckout,
} from "./types.js";

export const FIXED_NOW = 2_000_000_000;
export const FIXED_PURCHASE_ID = "pur_AAAAAAAAAAAAAAAAAAAAAA";
export const FIXED_INSTRUMENT_ID = "instrument:testnet:v1";
export const FIXED_AUTHORITY_ISSUER = "urn:sompi:authority:test";
export const FIXED_MERCHANT_ISSUER = "https://merchant.example";
export const FIXED_MERCHANT_RECEIPT_ISSUER = "https://merchant.example/receipts";
export const FIXED_PAYMENT_RECEIPT_ISSUER = "https://payments.merchant.example";
export const FIXED_AUDIENCE = "urn:sompi:authority:test";

const MERCHANT_JWK: P256PrivateJwk = Object.freeze({
  kty: "EC", crv: "P-256",
  x: "kIMbwTW167_PbLiNRyWM4UI-AkOwuouOrIRaCRhU1R8",
  y: "LOfu1_5hH162I-YQwVxrPDFIraZpc2SaEvfGWOG-OJI",
  d: "ps9ChESR5dbn_PfA9RpNZ8-36Co6_rxS-DCmRD8H64M",
});
const AUTHORITY_JWK: P256PrivateJwk = Object.freeze({
  kty: "EC", crv: "P-256",
  x: "PjJTTHAk-_jrGUwZx5O1f0ODiA_z6BnhvkPvgjfCYbA",
  y: "B3fBGs9fD4V1SCr33_F1sTp7MlJVq4p7pUTRXDlDDv4",
  d: "ALSko8gD4sNqwoxVFcLcBcwkHVQN8OTH9yj3VYXaF8Q",
});
const MERCHANT_RECEIPT_JWK: P256PrivateJwk = Object.freeze({
  kty: "EC", crv: "P-256",
  x: "xz4jnthRngL7fLJRmKVMMFsE9rIYolV5CztLjB3MdEM",
  y: "_0YBCIux1qb_B68qzYTj0ZRZqDd5qMrSEZ9OjjrHu20",
  d: "gzj5e9-1_jUh03zPxJLdrdjHMvn2SBsnsKD52nASgBk",
});
const PAYMENT_RECEIPT_JWK: P256PrivateJwk = Object.freeze({
  kty: "EC", crv: "P-256",
  x: "epPdGWL-a0GBhvfVP6HxCezdOtVz43KRGT4D4bzUo9Y",
  y: "ZgAbG6YGiIPERWvVnYo2cMdX_sRPLa8n7E2OPIAfj8E",
  d: "usjjEyxZIQHOxahyh6DGtTCPSZ32a3Wl4iBPq0snDd0",
});
export const WRONG_JWK: P256PrivateJwk = Object.freeze({
  kty: "EC", crv: "P-256",
  x: "u5RMStKYMl92F8CAdFvXe9rTFnxWE-ZWGFGYKTxSLik",
  y: "WGSDHjJ_CHxs11a6W03hXvns8xavmP_aP7a8MlETR5M",
  d: "4MWIMtiPiP9QY0_htuw3n3-PerD0eSEdl9MLbIhLyL8",
});

export const MERCHANT_SIGNER = signer(
  "merchant-checkout", FIXED_MERCHANT_ISSUER, "merchant-checkout-key-1", MERCHANT_JWK
);
export const AUTHORITY_SIGNER = signer(
  "authority", FIXED_AUTHORITY_ISSUER, "authority-key-1", AUTHORITY_JWK
);
export const MERCHANT_RECEIPT_SIGNER = signer(
  "merchant-receipt", FIXED_MERCHANT_RECEIPT_ISSUER, "merchant-receipt-key-1", MERCHANT_RECEIPT_JWK
);
export const PAYMENT_RECEIPT_SIGNER = signer(
  "payment-receipt", FIXED_PAYMENT_RECEIPT_ISSUER, "payment-receipt-key-1", PAYMENT_RECEIPT_JWK
);

export function fixedTrustStore(extra: readonly Ap2PublicTrustEntry[] = []): LocalAp2TrustStore {
  return new LocalAp2TrustStore([
    trust(MERCHANT_SIGNER),
    trust(AUTHORITY_SIGNER),
    trust(MERCHANT_RECEIPT_SIGNER),
    trust(PAYMENT_RECEIPT_SIGNER),
    ...extra,
  ]);
}

export function fixedMerchantClaims(): MerchantCheckoutClaims {
  return {
    profile: SOMPI_MERCHANT_CHECKOUT_PROFILE,
    iss: FIXED_MERCHANT_ISSUER,
    aud: FIXED_AUDIENCE,
    kid: MERCHANT_SIGNER.kid,
    jti: "checkout:test:1",
    iat: FIXED_NOW,
    exp: FIXED_NOW + 300,
    nonce: Buffer.alloc(32, 0x5a).toString("base64url"),
    purchase_id: FIXED_PURCHASE_ID,
    merchant: {
      id: FIXED_MERCHANT_ISSUER,
      name: "Sompi Test Merchant",
      website: "https://merchant.example/store",
      origin: "https://merchant.example",
    },
    resource: {
      url: "https://merchant.example/resource",
      method: "POST",
      request_fingerprint: requestFingerprint({
        url: "https://merchant.example/resource",
        method: "POST",
      }),
    },
    price: {
      amount_atomic: "20000000",
      asset: KAS_ASSET,
      network: KASPA_TESTNET_NETWORK,
      pay_to: "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd",
    },
    payment_requirements: {
      digest: evidenceDigest("fixed-payment-requirements"),
    },
    treasury: {
      mode: "separately-reserved",
      additional_cost_ceiling_atomic: "1500000",
    },
    fulfilment: {
      identity: "resource:test:1",
      expected_digest: evidenceDigest("fixed-resource"),
    },
  };
}

export async function fixedVerifiedCheckout(): Promise<VerifiedMerchantCheckout> {
  const claims = fixedMerchantClaims();
  const artifact = await issueMerchantCheckout(claims, MERCHANT_SIGNER, { nowSec: FIXED_NOW });
  return verifyMerchantCheckout(artifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_ISSUER,
    expectedAudience: FIXED_AUDIENCE,
    expectedPurchaseId: FIXED_PURCHASE_ID as never,
    expectedResourceFingerprint: claims.resource.request_fingerprint as never,
    expectedPaymentRequirementsDigest: claims.payment_requirements.digest as never,
    nowSec: FIXED_NOW + 1,
  });
}

export async function fixedVerifiedMandates(
  checkout?: VerifiedMerchantCheckout
): Promise<VerifiedHumanPresentMandates> {
  const verifiedCheckout = checkout ?? await fixedVerifiedCheckout();
  const artifacts = await issueHumanPresentMandates({
    checkout: verifiedCheckout,
    instrumentId: FIXED_INSTRUMENT_ID,
    issuedAtSec: FIXED_NOW + 10,
    expiresAtSec: FIXED_NOW + 300,
  }, AUTHORITY_SIGNER);
  return verifyHumanPresentMandates(artifacts, {
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    checkout: verifiedCheckout,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    nowSec: FIXED_NOW + 11,
  });
}

function signer(
  role: Ap2SigningRole,
  issuer: string,
  kid: string,
  privateJwk: P256PrivateJwk
): Ap2SigningIdentity {
  return Object.freeze({ role, issuer, kid, privateJwk });
}

function trust(identity: Ap2SigningIdentity): Ap2PublicTrustEntry {
  const { d: _private, ...publicJwk } = identity.privateJwk;
  return Object.freeze({
    role: identity.role,
    issuer: identity.issuer,
    kid: identity.kid,
    publicJwk: Object.freeze(publicJwk) as P256PublicJwk,
  });
}
