import { checkoutTermsFactsDigest } from "../../purchase/contracts.js";
import type {
  MerchantCheckoutArtifactVerifier,
  VerifiedMerchantCheckoutProjection,
} from "../../purchase/checkout-terms-module.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { VerifiedArtifact } from "../../purchase/coordinator.js";
import type { Ap2PublicKeyResolver } from "./types.js";
import { SOMPI_MERCHANT_CHECKOUT_PROFILE } from "./types.js";
import { verifyMerchantCheckout } from "./merchant-checkout.js";

export const SOMPI_CHECKOUT_HEADER = "SOMPI-CHECKOUT" as const;

const MAX_CHECKOUT_BYTES = 20 * 1024;

export interface Ap2MerchantCheckoutVerifierOptions {
  readonly trust: Ap2PublicKeyResolver;
  readonly authorityAudience: string;
}

/** Verifies only the AP2-facing Merchant Checkout and projects Sompi facts. */
export class Ap2MerchantCheckoutVerifier implements MerchantCheckoutArtifactVerifier {
  readonly artifactHeader = Object.freeze({
    name: SOMPI_CHECKOUT_HEADER,
    maximumBytes: MAX_CHECKOUT_BYTES,
  });

  constructor(private readonly options: Ap2MerchantCheckoutVerifierOptions) {
    if (
      typeof options?.trust?.resolve !== "function" ||
      !options.authorityAudience ||
      options.authorityAudience.length > 256
    ) {
      throw new Error("AP2 Merchant Checkout verifier configuration is incomplete");
    }
  }

  async verify(
    input: Parameters<MerchantCheckoutArtifactVerifier["verify"]>[0]
  ): Promise<VerifiedMerchantCheckoutProjection> {
    const artifact = compactAscii(input.artifact, "Merchant Checkout");
    const untrustedIssuer = compactJwtIssuer(artifact);
    const checkout = await verifyMerchantCheckout(artifact, {
      trust: this.options.trust,
      expectedIssuer: untrustedIssuer,
      expectedAudience: this.options.authorityAudience,
      expectedPurchaseId: input.expectedPurchaseId,
      expectedResourceFingerprint: input.expectedResourceFingerprint,
      expectedPaymentRequirementsDigest: input.expectedPaymentRequirementsDigest,
      nowSec: Math.floor(requireNow(input.nowMs) / 1_000),
      clockSkewSec: 0,
    });
    if (checkout.issuer !== checkout.terms.merchant.id) {
      throw new Error(
        "Merchant Checkout signing issuer does not equal its canonical Merchant identity"
      );
    }
    return Object.freeze({
      terms: checkout.terms,
      checkoutEvidence: verifiedArtifact({
        bytes: input.artifact,
        issuer: checkout.terms.merchant.id,
        detailDigest: checkoutTermsFactsDigest(checkout.terms),
        verifierId: `ap2-checkout:${checkout.issuer}:${checkout.kid}`,
      }),
      paymentRequirementsDigest: checkout.paymentRequirementsDigest,
      additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
    });
  }
}

function verifiedArtifact(input: {
  bytes: Uint8Array;
  issuer: string;
  detailDigest: ReturnType<typeof checkoutTermsFactsDigest>;
  verifierId: string;
}): VerifiedArtifact {
  const digest = evidenceDigest(input.bytes);
  return Object.freeze({
    bytes: Uint8Array.from(input.bytes),
    mediaType: "application/jwt",
    profile: SOMPI_MERCHANT_CHECKOUT_PROFILE,
    issuer: input.issuer,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId: input.verifierId,
      profile: SOMPI_MERCHANT_CHECKOUT_PROFILE,
      detailDigest: input.detailDigest,
    }),
  });
}

function compactAscii(bytes: Uint8Array, label: string): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_CHECKOUT_BYTES) {
    throw new Error(`${label} is not bounded compact ASCII`);
  }
  const value = Buffer.from(bytes).toString("ascii");
  if (/[^\x21-\x7e]/.test(value) || !Buffer.from(value, "ascii").equals(Buffer.from(bytes))) {
    throw new Error(`${label} is not bounded compact ASCII`);
  }
  return value;
}

function compactJwtIssuer(artifact: string): string {
  const segments = artifact.split(".");
  if (segments.length !== 3) throw new Error("Merchant Checkout is not a compact JWT");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Merchant Checkout payload is malformed");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>).iss !== "string"
  ) {
    throw new Error("Merchant Checkout issuer is missing");
  }
  const issuer = (payload as Record<string, string>).iss;
  if (issuer.length === 0 || issuer.length > 256) {
    throw new Error("Merchant Checkout issuer is invalid");
  }
  return issuer;
}

function requireNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("AP2 Merchant Checkout clock is unavailable");
  }
  return value;
}
