import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { canonicalRequestUrl, assertPurchaseId } from "../../purchase/identity.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import { Ap2AdapterError } from "./errors.js";
import {
  assertCompactJwt,
  assertExactKeys,
  assertShortLivedWindow,
  assertSigningIdentity,
  decodeBase64url,
  importSigningKey,
  requireBase64urlDigest,
  requireBoundedText,
  requireCanonicalDecimal,
  requireRecord,
  requireSafeEpoch,
  requireSha256Digest,
  resolveTrustedPublicKey,
  sha256Base64url,
  strictProtectedHeader,
  verificationClock,
} from "./crypto.js";
import {
  KASPA_TESTNET_NETWORK,
  KAS_ASSET,
  SOMPI_MERCHANT_CHECKOUT_PROFILE,
  type Ap2PublicKeyResolver,
  type Ap2SigningIdentity,
  type Ap2VerificationClock,
  type MerchantCheckoutClaims,
  type VerifiedMerchantCheckout,
} from "./types.js";

const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;

export interface VerifyMerchantCheckoutOptions extends Ap2VerificationClock {
  readonly trust: Ap2PublicKeyResolver;
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly expectedPurchaseId?: PurchaseId;
  readonly expectedResourceFingerprint?: Sha256Digest;
  readonly expectedPaymentRequirementsDigest?: Sha256Digest;
}

export async function issueMerchantCheckout(
  claims: MerchantCheckoutClaims,
  signer: Ap2SigningIdentity,
  clock: Ap2VerificationClock = {}
): Promise<string> {
  assertSigningIdentity(signer, "merchant-checkout");
  const validated = validateMerchantCheckoutClaims(claims, {
    ...clock,
    expectedIssuer: signer.issuer,
    expectedAudience: claims.aud,
    expectedKid: signer.kid,
  });
  const key = await importSigningKey(signer);
  try {
    return await new SignJWT(validated as unknown as JWTPayload)
      .setProtectedHeader({ alg: "ES256", kid: signer.kid, typ: "JWT" })
      .sign(key);
  } catch {
    throw new Ap2AdapterError("Merchant Checkout signing failed", "signature_invalid");
  }
}

export async function verifyMerchantCheckout(
  artifact: string,
  options: VerifyMerchantCheckoutOptions
): Promise<VerifiedMerchantCheckout> {
  assertCompactJwt(artifact);
  const header = await strictProtectedHeader(artifact, ["alg", "kid", "typ"], "JWT");
  const { key } = await resolveTrustedPublicKey({
    resolver: options.trust,
    role: "merchant-checkout",
    issuer: options.expectedIssuer,
    kid: header.kid,
  });
  const { nowSec, clockSkewSec } = verificationClock(options);

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(artifact, key, {
      algorithms: ["ES256"],
      issuer: options.expectedIssuer,
      audience: options.expectedAudience,
      currentDate: new Date(nowSec * 1000),
      clockTolerance: clockSkewSec,
    });
    payload = verified.payload;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ERR_JWT_EXPIRED" || code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      throw new Ap2AdapterError("Merchant Checkout time, issuer, or audience is invalid", "time_invalid");
    }
    throw new Ap2AdapterError("Merchant Checkout signature is invalid", "signature_invalid");
  }

  const claims = validateMerchantCheckoutClaims(payload, {
    ...options,
    expectedKid: header.kid,
  });
  const purchaseId = requirePurchaseId(claims.purchase_id);
  if (options.expectedPurchaseId !== undefined && purchaseId !== options.expectedPurchaseId) {
    throw new Ap2AdapterError("Merchant Checkout is bound to a different Purchase", "binding_mismatch");
  }
  const resourceFingerprint = requireSha256Digest(
    claims.resource.request_fingerprint,
    "Merchant Checkout request fingerprint"
  ) as Sha256Digest;
  if (
    options.expectedResourceFingerprint !== undefined &&
    resourceFingerprint !== options.expectedResourceFingerprint
  ) {
    throw new Ap2AdapterError("Merchant Checkout request fingerprint does not match", "binding_mismatch");
  }
  const paymentRequirementsDigest = requireSha256Digest(
    claims.payment_requirements.digest,
    "Merchant Checkout Payment Requirements digest"
  ) as Sha256Digest;
  if (
    options.expectedPaymentRequirementsDigest !== undefined &&
    paymentRequirementsDigest !== options.expectedPaymentRequirementsDigest
  ) {
    throw new Ap2AdapterError("Merchant Checkout Payment Requirements digest does not match", "binding_mismatch");
  }

  // AP2 hashes the exact received compact bytes; decoding and re-encoding is forbidden here.
  const checkoutHash = sha256Base64url(Buffer.from(artifact, "utf8"));
  const checkoutDigest = `sha256:${checkoutHash}` as Sha256Digest;
  const fulfilment = claims.fulfilment === undefined
    ? undefined
    : {
        identity: claims.fulfilment.identity,
        ...(claims.fulfilment.expected_digest === undefined
          ? {}
          : {
              expectedDigest: requireSha256Digest(
                claims.fulfilment.expected_digest,
                "Merchant Checkout fulfilment digest"
              ) as Sha256Digest,
            }),
      };

  return Object.freeze({
    artifact,
    profile: SOMPI_MERCHANT_CHECKOUT_PROFILE,
    issuer: claims.iss,
    kid: header.kid,
    audience: claims.aud,
    purchaseId,
    issuedAtSec: claims.iat,
    expiresAtSec: claims.exp,
    checkoutHash,
    checkoutDigest,
    claims,
    terms: Object.freeze({
      merchant: Object.freeze({
        id: claims.merchant.id,
        name: claims.merchant.name,
        origin: claims.merchant.origin,
      }),
      resourceFingerprint,
      amountAtomic: claims.price.amount_atomic,
      asset: claims.price.asset,
      network: claims.price.network,
      payTo: claims.price.pay_to,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      checkoutDigest,
    }),
    resourceUrl: claims.resource.url,
    method: claims.resource.method,
    paymentRequirementsDigest,
    additionalCostCeilingAtomic: claims.treasury.additional_cost_ceiling_atomic,
    ...(fulfilment === undefined ? {} : { fulfilment: Object.freeze(fulfilment) }),
  });
}

interface MerchantClaimExpectations extends Ap2VerificationClock {
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly expectedKid: string;
}

function validateMerchantCheckoutClaims(
  candidate: unknown,
  expectations: MerchantClaimExpectations
): MerchantCheckoutClaims {
  const value = requireRecord(candidate, "Merchant Checkout payload");
  assertExactKeys(
    value,
    [
      "profile", "iss", "aud", "kid", "jti", "iat", "exp", "nonce", "purchase_id",
      "merchant", "resource", "price", "payment_requirements", "treasury",
    ],
    [
      "profile", "iss", "aud", "kid", "jti", "iat", "exp", "nonce", "purchase_id",
      "merchant", "resource", "price", "payment_requirements", "treasury", "fulfilment",
    ],
    "Merchant Checkout payload"
  );
  if (value.profile !== SOMPI_MERCHANT_CHECKOUT_PROFILE) {
    throw new Ap2AdapterError("unknown Merchant Checkout profile", "profile_mismatch");
  }
  const iss = requireBoundedText(value.iss, "Merchant Checkout issuer", 256);
  const aud = requireBoundedText(value.aud, "Merchant Checkout audience", 256);
  const kid = requireBoundedText(value.kid, "Merchant Checkout payload kid", 160);
  if (iss !== expectations.expectedIssuer || aud !== expectations.expectedAudience || kid !== expectations.expectedKid) {
    throw new Ap2AdapterError("Merchant Checkout issuer, audience, or key binding does not match", "binding_mismatch");
  }
  const jti = requireIdentity(value.jti, "Merchant Checkout jti");
  const { iat, exp } = assertShortLivedWindow(value.iat, value.exp, expectations);
  const nonce = requireBoundedText(value.nonce, "Merchant Checkout nonce", 64);
  if (decodeBase64url(nonce, "Merchant Checkout nonce").byteLength !== 32) {
    throw new Ap2AdapterError("Merchant Checkout nonce must contain 256 bits", "profile_mismatch");
  }
  const purchaseId = requirePurchaseId(value.purchase_id);

  const merchantValue = requireRecord(value.merchant, "Merchant Checkout merchant");
  assertExactKeys(
    merchantValue,
    ["id", "name", "website", "origin"],
    ["id", "name", "website", "origin"],
    "Merchant Checkout merchant"
  );
  const merchant = {
    id: requireIdentity(merchantValue.id, "Merchant Checkout merchant id"),
    name: requireBoundedText(merchantValue.name, "Merchant Checkout merchant name", 160),
    website: requireCanonicalWebsite(merchantValue.website),
    origin: requireCanonicalOrigin(merchantValue.origin),
  };
  if (new URL(merchant.website).origin !== merchant.origin) {
    throw new Ap2AdapterError("Merchant Checkout website and origin do not match", "binding_mismatch");
  }

  const resourceValue = requireRecord(value.resource, "Merchant Checkout resource");
  assertExactKeys(
    resourceValue,
    ["url", "method", "request_fingerprint"],
    ["url", "method", "request_fingerprint"],
    "Merchant Checkout resource"
  );
  const resource = {
    url: requireCanonicalResourceUrl(resourceValue.url),
    method: requireCanonicalMethod(resourceValue.method),
    request_fingerprint: requireSha256Digest(
      resourceValue.request_fingerprint,
      "Merchant Checkout request fingerprint"
    ),
  };

  const priceValue = requireRecord(value.price, "Merchant Checkout price");
  assertExactKeys(
    priceValue,
    ["amount_atomic", "asset", "network", "pay_to"],
    ["amount_atomic", "asset", "network", "pay_to"],
    "Merchant Checkout price"
  );
  const price = {
    amount_atomic: requireCanonicalDecimal(priceValue.amount_atomic, "Merchant Checkout amount", {
      positive: true,
      safeInteger: true,
    }),
    asset: requireExact(priceValue.asset, KAS_ASSET, "Merchant Checkout asset"),
    network: requireExact(priceValue.network, KASPA_TESTNET_NETWORK, "Merchant Checkout network"),
    pay_to: requireKaspaTestnetAddress(priceValue.pay_to),
  };

  const paymentRequirementsValue = requireRecord(
    value.payment_requirements,
    "Merchant Checkout payment requirements binding"
  );
  assertExactKeys(
    paymentRequirementsValue,
    ["digest"],
    ["digest"],
    "Merchant Checkout payment requirements binding"
  );
  const paymentRequirements = {
    digest: requireSha256Digest(
      paymentRequirementsValue.digest,
      "Merchant Checkout Payment Requirements digest"
    ),
  };

  const treasuryValue = requireRecord(value.treasury, "Merchant Checkout treasury terms");
  assertExactKeys(
    treasuryValue,
    ["mode", "additional_cost_ceiling_atomic"],
    ["mode", "additional_cost_ceiling_atomic"],
    "Merchant Checkout treasury terms"
  );
  if (treasuryValue.mode !== "separately-reserved") {
    throw new Ap2AdapterError("Merchant Checkout treasury-cost mode is unsupported", "profile_mismatch");
  }
  const treasury = {
    mode: "separately-reserved" as const,
    additional_cost_ceiling_atomic: requireCanonicalDecimal(
      treasuryValue.additional_cost_ceiling_atomic,
      "Merchant Checkout additional-cost ceiling",
      { positive: false }
    ),
  };

  let fulfilment: MerchantCheckoutClaims["fulfilment"];
  if (value.fulfilment !== undefined) {
    const fulfilmentValue = requireRecord(value.fulfilment, "Merchant Checkout fulfilment");
    assertExactKeys(
      fulfilmentValue,
      ["identity"],
      ["identity", "expected_digest"],
      "Merchant Checkout fulfilment"
    );
    fulfilment = {
      identity: requireIdentity(fulfilmentValue.identity, "Merchant Checkout fulfilment identity"),
      ...(fulfilmentValue.expected_digest === undefined
        ? {}
        : {
            expected_digest: requireSha256Digest(
              fulfilmentValue.expected_digest,
              "Merchant Checkout fulfilment digest"
            ),
          }),
    };
  }

  // Preserve only validated values; never return the caller's mutable object graph.
  return Object.freeze({
    profile: SOMPI_MERCHANT_CHECKOUT_PROFILE,
    iss,
    aud,
    kid,
    jti,
    iat,
    exp,
    nonce,
    purchase_id: purchaseId,
    merchant: Object.freeze(merchant),
    resource: Object.freeze(resource),
    price: Object.freeze(price),
    payment_requirements: Object.freeze(paymentRequirements),
    treasury: Object.freeze(treasury),
    ...(fulfilment === undefined ? {} : { fulfilment: Object.freeze(fulfilment) }),
  });
}

function requirePurchaseId(value: unknown): PurchaseId {
  if (typeof value !== "string") {
    throw new Ap2AdapterError("Merchant Checkout Purchase ID is invalid", "binding_mismatch");
  }
  try {
    return assertPurchaseId(value);
  } catch {
    throw new Ap2AdapterError("Merchant Checkout Purchase ID is invalid", "binding_mismatch");
  }
}

function requireIdentity(value: unknown, label: string): string {
  const text = requireBoundedText(value, label, 256);
  if (!ID_PATTERN.test(text)) {
    throw new Ap2AdapterError(`${label} is not a canonical identity`, "profile_mismatch");
  }
  return text;
}

function requireCanonicalResourceUrl(value: unknown): string {
  const text = requireBoundedText(value, "Merchant Checkout resource URL", 2048);
  let canonical: string;
  try {
    canonical = canonicalRequestUrl(text);
  } catch {
    throw new Ap2AdapterError("Merchant Checkout resource URL is invalid", "profile_mismatch");
  }
  if (canonical !== text) {
    throw new Ap2AdapterError("Merchant Checkout resource URL is not canonical", "profile_mismatch");
  }
  return canonical;
}

function requireCanonicalMethod(value: unknown): string {
  if (typeof value !== "string" || !METHOD_PATTERN.test(value)) {
    throw new Ap2AdapterError("Merchant Checkout HTTP method is not canonical", "profile_mismatch");
  }
  return value;
}

function requireCanonicalWebsite(value: unknown): string {
  const text = requireBoundedText(value, "Merchant Checkout website", 2048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Ap2AdapterError("Merchant Checkout website is invalid", "profile_mismatch");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.href !== text
  ) {
    throw new Ap2AdapterError("Merchant Checkout website is not a canonical HTTP URL", "profile_mismatch");
  }
  return text;
}

function requireCanonicalOrigin(value: unknown): string {
  const text = requireBoundedText(value, "Merchant Checkout origin", 256);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Ap2AdapterError("Merchant Checkout origin is invalid", "profile_mismatch");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== text ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Ap2AdapterError("Merchant Checkout origin is not canonical", "profile_mismatch");
  }
  return text;
}

function requireKaspaTestnetAddress(value: unknown): string {
  const address = requireBoundedText(value, "Merchant Checkout payee", 160);
  if (!/^kaspatest:[a-z0-9]{20,140}$/.test(address)) {
    throw new Ap2AdapterError("Merchant Checkout payee is not a Kaspa testnet address", "profile_mismatch");
  }
  return address;
}

function requireExact<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Ap2AdapterError(`${label} is outside the pinned profile`, "profile_mismatch");
  }
  return expected;
}
