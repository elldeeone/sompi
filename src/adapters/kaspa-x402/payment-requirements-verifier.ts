import {
  PAYMENT_REQUIRED_HEADER,
  parsePaymentRequiredHeaderValue,
} from "@kaspa-x402/client";

import type { PaymentRequirementsArtifactVerifier } from "../../purchase/checkout-terms-module.js";
import type { VerifiedArtifact } from "../../purchase/coordinator.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { CheckoutTerms, Sha256Digest } from "../../purchase/types.js";

export const KASPA_X402_PAYMENT_REQUIRED_PROFILE =
  "kaspa-x402-0.1.0-alpha.6-exact-payment-required" as const;

const TESTNET = "kaspa:testnet-10";
const MAX_REQUIREMENTS_BYTES = 32 * 1024;

/** Verifies only pinned Kaspa-x402 PAYMENT-REQUIRED bytes against Sompi facts. */
export class KaspaX402PaymentRequirementsVerifier
implements PaymentRequirementsArtifactVerifier {
  readonly artifactHeader = Object.freeze({
    name: PAYMENT_REQUIRED_HEADER,
    maximumBytes: MAX_REQUIREMENTS_BYTES,
  });

  async verify(
    input: Parameters<PaymentRequirementsArtifactVerifier["verify"]>[0]
  ): Promise<VerifiedArtifact> {
    const nowMs = requireNow(input.nowMs);
    const bytes = copyArtifact(input.artifact);
    const digest = evidenceDigest(bytes);
    if (digest !== input.expectedDigest) {
      throw new Error("PAYMENT-REQUIRED digest does not match the Merchant Checkout");
    }
    const header = Buffer.from(bytes).toString("ascii");
    const parsed = parsePaymentRequiredHeaderValue(header, {
      supportedNetworks: [TESTNET],
      supportedSchemes: ["exact"],
    });
    assertExactPaymentRequired(
      parsed,
      input.terms,
      input.additionalCostCeilingAtomic,
      input.finalHop.url,
      nowMs
    );
    return verifiedArtifact(bytes, input.terms.merchant.id, digest);
  }
}

function assertExactPaymentRequired(
  parsed: ReturnType<typeof parsePaymentRequiredHeaderValue>,
  terms: CheckoutTerms,
  additionalCostCeilingAtomic: string,
  finalUrl: string,
  nowMs: number
): void {
  const accepted = parsed.accepted;
  const extra = accepted.extra;
  const reservationExpiry = typeof extra.reservationExpiresAt === "string"
    ? Date.parse(extra.reservationExpiresAt)
    : Number.NaN;
  const checkoutExpiry = Date.parse(terms.expiresAt);
  if (
    parsed.paymentRequired.resource.url !== finalUrl ||
    accepted.scheme !== "exact" ||
    accepted.network !== TESTNET ||
    accepted.asset !== "KAS" ||
    accepted.amount !== terms.amountAtomic ||
    accepted.payTo !== terms.payTo ||
    accepted.extra.binding !== "kaspa-exact-v1" ||
    accepted.extra.templateId !== "kaspa-x402-kip10-additive-v1" ||
    accepted.extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    accepted.extra.paymentOutputIndex !== 1 ||
    !accepted.extra.borrowOutpoint ||
    typeof accepted.extra.borrowAmount !== "string" ||
    typeof accepted.extra.borrowScriptPublicKey !== "string" ||
    typeof accepted.extra.borrowRedeemScript !== "string" ||
    typeof accepted.extra.additiveThresholdSompi !== "string" ||
    typeof accepted.extra.reservationId !== "string" ||
    !["mempool", "accepted", "confirmed"].includes(String(accepted.extra.finality)) ||
    !Number.isFinite(checkoutExpiry) ||
    !Number.isFinite(reservationExpiry) ||
    reservationExpiry <= nowMs ||
    reservationExpiry < checkoutExpiry
  ) {
    throw new Error("PAYMENT-REQUIRED does not match the signed Checkout Terms");
  }
  if (
    !/^[1-9][0-9]*$/.test(accepted.extra.borrowAmount) ||
    !/^(?:0|[1-9][0-9]*)$/.test(accepted.extra.additiveThresholdSompi) ||
    !/^(?:0|[1-9][0-9]*)$/.test(additionalCostCeilingAtomic) ||
    BigInt(accepted.extra.additiveThresholdSompi) > BigInt(additionalCostCeilingAtomic)
  ) {
    throw new Error("PAYMENT-REQUIRED exceeds the signed Checkout treasury bound");
  }
}

function verifiedArtifact(
  bytes: Uint8Array,
  issuer: string,
  digest: Sha256Digest
): VerifiedArtifact {
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    mediaType: "application/x402-payment-required",
    profile: KASPA_X402_PAYMENT_REQUIRED_PROFILE,
    issuer,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId: "kaspa-x402:0.1.0-alpha.6:payment-required",
      profile: KASPA_X402_PAYMENT_REQUIRED_PROFILE,
      detailDigest: digest,
    }),
  });
}

function copyArtifact(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_REQUIREMENTS_BYTES) {
    throw new Error("PAYMENT-REQUIRED is not bounded compact ASCII");
  }
  const bytes = Uint8Array.from(value);
  const text = Buffer.from(bytes).toString("ascii");
  if (/[^\x21-\x7e]/.test(text) || !Buffer.from(text, "ascii").equals(Buffer.from(bytes))) {
    throw new Error("PAYMENT-REQUIRED is not bounded compact ASCII");
  }
  return bytes;
}

function requireNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PAYMENT-REQUIRED verification clock is unavailable");
  }
  return value;
}
