import type { PinnedHttpTransport } from "../http/pinned-transport.js";
import {
  certifyVerifiedCheckoutDiscovery,
  type CheckoutTermsModule,
  type PurchaseEgressSession,
  type VerifiedArtifact,
} from "./coordinator.js";
import { evidenceDigest } from "./identity.js";
import type { SafeTransportHop } from "./egress-policy.js";
import type { CheckoutTerms, PurchaseId, Sha256Digest } from "./types.js";
import type { PurchaseExecutionPlan } from "./execution-plan.js";

export interface CheckoutArtifactHeader {
  readonly name: string;
  readonly maximumBytes: number;
}

export interface VerifiedMerchantCheckoutProjection {
  readonly terms: CheckoutTerms;
  readonly checkoutEvidence: VerifiedArtifact;
  /** Digest signed as an opaque binding; the AP2 adapter does not parse these bytes. */
  readonly paymentRequirementsDigest: Sha256Digest;
  readonly additionalCostCeilingAtomic: string;
}

/** AP2-facing seam for one signed Merchant Checkout artifact. */
export interface MerchantCheckoutArtifactVerifier {
  readonly artifactHeader: CheckoutArtifactHeader;
  verify(input: Readonly<{
    artifact: Uint8Array;
    expectedPurchaseId: PurchaseId;
    expectedResourceFingerprint: Sha256Digest;
    expectedPaymentRequirementsDigest: Sha256Digest;
    nowMs: number;
  }>): Promise<VerifiedMerchantCheckoutProjection>;
}

/** Payment-protocol-facing seam for opaque payment-requirements bytes. */
export interface PaymentRequirementsArtifactVerifier {
  readonly artifactHeader: CheckoutArtifactHeader;
  verify(input: Readonly<{
    artifact: Uint8Array;
    expectedDigest: Sha256Digest;
    terms: CheckoutTerms;
    additionalCostCeilingAtomic: string;
    finalHop: SafeTransportHop;
    nowMs: number;
  }>): Promise<Readonly<{
    artifact: VerifiedArtifact;
    executionPlan: PurchaseExecutionPlan;
  }>>;
}

export interface SompiCheckoutTermsModuleOptions {
  readonly transport: PinnedHttpTransport;
  readonly merchantCheckout: MerchantCheckoutArtifactVerifier;
  readonly paymentRequirements: PaymentRequirementsArtifactVerifier;
  readonly now?: () => number;
}

/**
 * Sompi-owned composition of two independent verification adapters.
 *
 * This module alone acquires and bounds HTTP headers. The AP2 verifier sees
 * opaque payment-requirements bytes only through their digest; the payment
 * verifier sees canonical Checkout Terms, never AP2 objects.
 */
export class SompiCheckoutTermsModule implements CheckoutTermsModule {
  private readonly now: () => number;

  constructor(private readonly options: SompiCheckoutTermsModuleOptions) {
    if (
      typeof options?.transport?.send !== "function" ||
      typeof options?.merchantCheckout?.verify !== "function" ||
      typeof options?.paymentRequirements?.verify !== "function"
    ) {
      throw new Error("Checkout Terms composition is incomplete");
    }
    assertHeaderDescriptor(options.merchantCheckout.artifactHeader);
    assertHeaderDescriptor(options.paymentRequirements.artifactHeader);
    if (
      options.merchantCheckout.artifactHeader.name.toLowerCase() ===
      options.paymentRequirements.artifactHeader.name.toLowerCase()
    ) {
      throw new Error("Checkout artifact headers must be distinct");
    }
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async discover(input: Parameters<CheckoutTermsModule["discover"]>[0]) {
    const response = await this.requestCheckout(input.egress);
    if (response.status !== 402) {
      throw new Error("Merchant did not return payment-required Checkout Terms");
    }
    const checkoutDescriptor = this.options.merchantCheckout.artifactHeader;
    const requirementsDescriptor = this.options.paymentRequirements.artifactHeader;
    const checkoutBytes = strictCompactAscii(
      requireOneHeader(response.headers, checkoutDescriptor.name),
      checkoutDescriptor
    );
    const paymentRequirements = strictCompactAscii(
      requireOneHeader(response.headers, requirementsDescriptor.name),
      requirementsDescriptor
    );
    const paymentRequirementsDigest = evidenceDigest(paymentRequirements);
    const nowMs = readClock(this.now);
    const checkout = await this.options.merchantCheckout.verify({
      artifact: checkoutBytes,
      expectedPurchaseId: input.purchaseId,
      expectedResourceFingerprint: input.resourceFingerprint,
      expectedPaymentRequirementsDigest: paymentRequirementsDigest,
      nowMs,
    });
    if (checkout.paymentRequirementsDigest !== paymentRequirementsDigest) {
      throw new Error("Merchant Checkout did not bind the exact payment requirements");
    }
    const verifiedRequirements = await this.options.paymentRequirements.verify({
      artifact: paymentRequirements,
      expectedDigest: paymentRequirementsDigest,
      terms: checkout.terms,
      additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
      finalHop: response.finalHop,
      nowMs,
    });
    if (
      verifiedRequirements.artifact.declaredDigest !== paymentRequirementsDigest ||
      evidenceDigest(verifiedRequirements.artifact.bytes) !== paymentRequirementsDigest
    ) {
      throw new Error("payment-requirements verifier returned substituted evidence");
    }
    return certifyVerifiedCheckoutDiscovery({
      terms: checkout.terms,
      checkoutEvidence: checkout.checkoutEvidence,
      paymentRequirements: verifiedRequirements.artifact,
      executionPlan: verifiedRequirements.executionPlan,
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
      const timeout = setTimeout(
        () => controller.abort(new Error("Checkout discovery deadline exceeded")),
        remaining
      );
      // The deadline is the completion mechanism when an injected transport
      // ignores abort and retains no event-loop handle of its own. Keep it
      // referenced until the request settles, then clear it below.
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
          if (!(chunk instanceof Uint8Array)) {
            throw new Error("Checkout response yielded non-byte data");
          }
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

function assertHeaderDescriptor(value: CheckoutArtifactHeader): void {
  if (
    !value ||
    typeof value.name !== "string" ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.name) ||
    !Number.isSafeInteger(value.maximumBytes) ||
    value.maximumBytes <= 0 ||
    value.maximumBytes > 256 * 1024
  ) {
    throw new Error("Checkout artifact header descriptor is invalid");
  }
}

function strictCompactAscii(value: string, descriptor: CheckoutArtifactHeader): Uint8Array {
  const bytes = Buffer.from(value, "ascii");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > descriptor.maximumBytes ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new Error(`${descriptor.name} is not bounded compact ASCII`);
  }
  return Uint8Array.from(bytes);
}

function normalizeHeaders(
  headers: readonly (readonly [string, string])[]
): readonly (readonly [string, string])[] {
  const normalized: Array<readonly [string, string]> = [];
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error("Checkout response header is malformed");
    }
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
  name: string
): string {
  const values = headers.filter(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  if (values.length !== 1 || values[0][1].length === 0) {
    throw new Error(`Checkout response requires exactly one ${name} header`);
  }
  return values[0][1];
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Checkout clock is unavailable");
  }
  return value;
}
