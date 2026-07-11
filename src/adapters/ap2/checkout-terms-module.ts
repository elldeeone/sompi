import {
  PAYMENT_REQUIRED_HEADER,
  parsePaymentRequiredHeaderValue,
} from "@kaspa-x402/client";
import type { PinnedHttpTransport } from "../../http/pinned-transport.js";
import {
  checkoutTermsFactsDigest,
} from "../../purchase/contracts.js";
import {
  certifyVerifiedCheckoutDiscovery,
  type CheckoutTermsModule,
  type PurchaseEgressSession,
  type VerifiedArtifact,
} from "../../purchase/coordinator.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { SafeTransportHop } from "../../purchase/egress-policy.js";
import type { Sha256Digest } from "../../purchase/types.js";
import { verifyMerchantCheckout } from "./merchant-checkout.js";
import {
  AP2_HUMAN_PRESENT_PROFILE,
  SOMPI_MERCHANT_CHECKOUT_PROFILE,
  type Ap2PublicKeyResolver,
} from "./types.js";

export const SOMPI_CHECKOUT_HEADER = "SOMPI-CHECKOUT" as const;
export const KASPA_X402_PAYMENT_REQUIRED_PROFILE =
  "kaspa-x402-0.1.0-alpha.6-exact-payment-required" as const;

const TESTNET = "kaspa:testnet-10";
const MAX_CHECKOUT_BYTES = 20 * 1024;
const MAX_REQUIREMENTS_BYTES = 32 * 1024;

export interface Ap2CheckoutTermsModuleOptions {
  readonly transport: PinnedHttpTransport;
  readonly trust: Ap2PublicKeyResolver;
  readonly authorityAudience: string;
  readonly now?: () => number;
}

/** Discovers one Merchant-signed AP2 checkout joined to standard x402 terms. */
export class Ap2CheckoutTermsModule implements CheckoutTermsModule {
  private readonly now: () => number;

  constructor(private readonly options: Ap2CheckoutTermsModuleOptions) {
    if (!options.transport || typeof options.transport.send !== "function" || !options.trust) {
      throw new Error("AP2 Checkout Terms module configuration is incomplete");
    }
    if (!options.authorityAudience || options.authorityAudience.length > 256) {
      throw new Error("AP2 Checkout authority audience is invalid");
    }
    this.now = options.now ?? Date.now;
  }

  async discover(input: Parameters<CheckoutTermsModule["discover"]>[0]) {
    const response = await this.requestCheckout(input.egress);
    if (response.status !== 402) {
      throw new Error("Merchant did not return payment-required Checkout Terms");
    }
    const checkoutHeader = requireOneHeader(response.headers, SOMPI_CHECKOUT_HEADER);
    const paymentHeader = requireOneHeader(response.headers, PAYMENT_REQUIRED_HEADER);
    const checkoutBytes = strictAscii(checkoutHeader, SOMPI_CHECKOUT_HEADER, MAX_CHECKOUT_BYTES);
    const paymentBytes = strictAscii(paymentHeader, PAYMENT_REQUIRED_HEADER, MAX_REQUIREMENTS_BYTES);
    const paymentDigest = evidenceDigest(paymentBytes);
    const untrustedIssuer = compactJwtIssuer(checkoutHeader);
    const checkout = await verifyMerchantCheckout(checkoutHeader, {
      trust: this.options.trust,
      expectedIssuer: untrustedIssuer,
      expectedAudience: this.options.authorityAudience,
      expectedPurchaseId: input.purchaseId,
      expectedResourceFingerprint: input.resourceFingerprint,
      expectedPaymentRequirementsDigest: paymentDigest,
      nowSec: Math.floor(readClock(this.now) / 1_000),
      clockSkewSec: 0,
    });
    if (checkout.issuer !== checkout.terms.merchant.id) {
      throw new Error(
        "Merchant Checkout signing issuer does not equal its canonical Merchant identity"
      );
    }
    const parsed = parsePaymentRequiredHeaderValue(paymentHeader, {
      supportedNetworks: [TESTNET],
      supportedSchemes: ["exact"],
    });
    assertExactPaymentRequired(parsed, checkout, response.finalHop, this.now);

    const checkoutEvidence = verifiedArtifact({
      bytes: checkoutBytes,
      mediaType: "application/jwt",
      profile: SOMPI_MERCHANT_CHECKOUT_PROFILE,
      issuer: checkout.terms.merchant.id,
      detailDigest: checkoutTermsFactsDigest(checkout.terms),
      verifierId: `ap2-checkout:${checkout.issuer}:${checkout.kid}`,
    });
    const requirementsEvidence = verifiedArtifact({
      bytes: paymentBytes,
      mediaType: "application/x402-payment-required",
      profile: KASPA_X402_PAYMENT_REQUIRED_PROFILE,
      issuer: checkout.terms.merchant.id,
      detailDigest: paymentDigest,
      verifierId: "kaspa-x402:0.1.0-alpha.6:payment-required",
    });
    return certifyVerifiedCheckoutDiscovery({
      terms: checkout.terms,
      checkoutEvidence,
      paymentRequirements: requirementsEvidence,
    });
  }

  private async requestCheckout(egress: PurchaseEgressSession): Promise<{
    status: number;
    headers: readonly (readonly [string, string])[];
    finalHop: SafeTransportHop;
  }> {
    let hop = egress.request;
    for (;;) {
      const controller = new AbortController();
      const remaining = hop.deadlineAtMs - readClock(this.now);
      if (remaining <= 0) throw new Error("Checkout discovery deadline exceeded");
      const timeout = setTimeout(() => controller.abort(new Error("Checkout discovery deadline exceeded")), remaining);
      timeout.unref();
      const guard = egress.responseGuard(hop, (reason) => controller.abort(reason));
      try {
        const headers: Array<readonly [string, string]> = [["accept", "application/json"]];
        const mediaType = hop.requestFingerprintInput.mediaType;
        if (mediaType) headers.push(["content-type", mediaType]);
        const response = await this.options.transport.send({
          hop,
          headers: Object.freeze(headers),
          body: hop.body ?? new Uint8Array(),
          signal: controller.signal,
        });
        const normalized = normalizeHeaders(response.headers);
        guard.acceptHeaders(normalized);
        for await (const chunk of response.body) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Checkout response yielded non-byte data");
          guard.acceptBodyChunk(chunk);
        }
        guard.checkTime();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = requireOneHeader(normalized, "location");
          hop = await egress.redirect(hop, location);
          continue;
        }
        return { status: response.status, headers: normalized, finalHop: hop };
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

function assertExactPaymentRequired(
  parsed: ReturnType<typeof parsePaymentRequiredHeaderValue>,
  checkout: Awaited<ReturnType<typeof verifyMerchantCheckout>>,
  hop: SafeTransportHop,
  now: () => number,
): void {
  const accepted = parsed.accepted;
  const extra = accepted.extra;
  const reservationExpiry = typeof extra.reservationExpiresAt === "string"
    ? Date.parse(extra.reservationExpiresAt)
    : Number.NaN;
  if (
    parsed.paymentRequired.resource.url !== hop.url ||
    accepted.scheme !== "exact" ||
    accepted.network !== TESTNET ||
    accepted.asset !== "KAS" ||
    accepted.amount !== checkout.terms.amountAtomic ||
    accepted.payTo !== checkout.terms.payTo ||
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
    !Number.isFinite(reservationExpiry) ||
    reservationExpiry <= readClock(now) ||
    reservationExpiry < checkout.expiresAtSec * 1_000
  ) {
    throw new Error("PAYMENT-REQUIRED does not match the signed AP2 Checkout Terms");
  }
  if (
    !/^[1-9][0-9]*$/.test(accepted.extra.borrowAmount) ||
    !/^(?:0|[1-9][0-9]*)$/.test(accepted.extra.additiveThresholdSompi) ||
    BigInt(accepted.extra.additiveThresholdSompi) > BigInt(checkout.additionalCostCeilingAtomic)
  ) {
    throw new Error("PAYMENT-REQUIRED exceeds the signed Checkout treasury bound");
  }
}

function verifiedArtifact(input: {
  bytes: Uint8Array;
  mediaType: string;
  profile: string;
  issuer: string;
  detailDigest: Sha256Digest;
  verifierId: string;
}): VerifiedArtifact {
  const digest = evidenceDigest(input.bytes);
  return Object.freeze({
    bytes: Uint8Array.from(input.bytes),
    mediaType: input.mediaType,
    profile: input.profile,
    issuer: input.issuer,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId: input.verifierId,
      profile: input.profile,
      detailDigest: input.detailDigest,
    }),
  });
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as any).iss !== "string") {
    throw new Error("Merchant Checkout issuer is missing");
  }
  return (payload as any).iss;
}

function strictAscii(value: string, label: string, maximum: number): Uint8Array {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.byteLength === 0 || bytes.byteLength > maximum || /[^\x21-\x7e]/.test(value)) {
    throw new Error(`${label} is not bounded compact ASCII`);
  }
  return Uint8Array.from(bytes);
}

function normalizeHeaders(
  headers: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  const normalized: Array<readonly [string, string]> = [];
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Checkout response header is malformed");
    const [name, value] = pair;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new Error("Checkout response header is malformed");
    }
    normalized.push(Object.freeze([name.toLowerCase(), value] as const));
  }
  return Object.freeze(normalized);
}

function requireOneHeader(
  headers: readonly (readonly [string, string])[],
  name: string,
): string {
  const values = headers.filter(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  if (values.length !== 1 || values[0][1].length === 0) {
    throw new Error(`Checkout response requires exactly one ${name} header`);
  }
  return values[0][1];
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Checkout clock is unavailable");
  return value;
}
