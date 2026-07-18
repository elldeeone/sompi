import { canonicalEvidenceJson } from "./canonical-json.js";
import {
  validateAuthorizationDecision,
} from "./contracts.js";
import { canonicalMediaType, evidenceDigest } from "./identity.js";
import { paymentFinalityMeets } from "./finality.js";
import type {
  FulfilmentResult,
  PurchaseReceiptResult,
  VerifiedArtifact,
} from "./coordinator.js";
import type { Sha256Digest } from "./types.js";
import type {
  PaidResourceResponse,
  PaidResourceResponseVerifier,
} from "./paid-resource-response.js";

export const GENERIC_X402_FULFILMENT_PROFILE =
  "urn:sompi:fulfilment:generic-x402:1" as const;
export const SOMPI_PURCHASE_RECEIPT_PROFILE =
  "urn:sompi:receipt:purchase:1" as const;

const VERIFIER_ID = "sompi:generic-x402-paid-response:1";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_HEADERS = 256;
const MAX_HEADER_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const PAYMENT_IDENTIFIER_PATTERN = /^pay_[A-Za-z0-9_-]{43}$/;

export type PaidResponseVerificationErrorCode =
  | "binding_mismatch"
  | "fulfilment_invalid";

export class PaidResponseVerificationError extends Error {
  constructor(readonly code: PaidResponseVerificationErrorCode, message: string) {
    super(message);
    this.name = "PaidResponseVerificationError";
  }
}

/**
 * Verifies the bounded paid response against Sompi's canonical authorization
 * and the already verified x402 settlement. The Merchant need not understand
 * Sompi or AP2.
 */
export class SompiPaidResponseVerifier implements PaidResourceResponseVerifier {
  async verify(
    input: Readonly<PaidResourceResponse>
  ): Promise<Extract<FulfilmentResult, { status: "fulfilled" }> | undefined> {
    if (!input || !Number.isSafeInteger(input.status)) {
      throw failure("binding_mismatch", "paid HTTP response status is invalid");
    }
    if (input.status < 200 || input.status > 299) return undefined;

    const body = copyBody(input.body);
    const headers = copyHeaders(input.headers);
    const mediaType = canonicalMediaType(input.mediaType ?? "application/octet-stream")!;
    const context = structuredClone(input.context);
    const settlement = structuredClone(input.settlement);

    validateAuthorizationDecision(context.authorizationRequest, context.authorization);
    assertContext(context);
    assertSettlement(context, settlement);

    const settlementEvidenceDigest = verifiedArtifactDigest(
      settlement.evidence,
      "Settlement evidence"
    );
    const fulfilmentDigest = evidenceDigest(body);
    const headersDigest = evidenceDigest(canonicalEvidenceJson(headers));
    const executionConfirmationId = settlement.transactionId ?? settlement.commitmentId;
    if (!boundedText(executionConfirmationId, 256)) {
      throw failure("binding_mismatch", "Settlement has no bounded execution confirmation");
    }

    const join = Object.freeze({
      purchaseId: context.purchaseId,
      checkoutDigest: context.terms.checkoutDigest,
      authorizationEvidenceDigest: context.authorization.evidenceDigest,
      paymentIdentifier: context.paymentIdentifier,
      settlementEvidenceDigest,
      fulfilmentDigest,
      resourceFingerprint: context.request.requestFingerprint,
      requestDigest: context.authorizationRequest.requestDigest,
      requirementsDigest: evidenceDigest(context.paymentRequirements),
      executionConfirmationId,
      httpStatus: input.status,
      mediaType,
      headersDigest,
    });

    const merchantEvidence = verifiedArtifact({
      bytes: Buffer.from(canonicalEvidenceJson({
        profile: GENERIC_X402_FULFILMENT_PROFILE,
        ...join,
      }), "utf8"),
      mediaType: "application/json",
      profile: GENERIC_X402_FULFILMENT_PROFILE,
      issuer: context.terms.merchant.id,
      detail: { kind: "merchant-fulfilment", ...join },
    });
    const receipt: PurchaseReceiptResult = Object.freeze({
      checkoutDigest: context.terms.checkoutDigest,
      authorizationEvidenceDigest: context.authorization.evidenceDigest,
      settlementEvidenceDigest,
      fulfilmentDigest,
      evidence: verifiedArtifact({
        bytes: Buffer.from(canonicalEvidenceJson({
          profile: SOMPI_PURCHASE_RECEIPT_PROFILE,
          ...join,
        }), "utf8"),
        mediaType: "application/json",
        profile: SOMPI_PURCHASE_RECEIPT_PROFILE,
        issuer: context.authorization.authorityId,
        detail: { kind: "purchase-receipt", ...join },
      }),
    });

    return Object.freeze({
      status: "fulfilled" as const,
      httpStatus: input.status,
      body: Uint8Array.from(body),
      mediaType,
      resourceFingerprint: context.request.requestFingerprint,
      merchantEvidence,
      receipt,
    });
  }
}

function assertContext(context: PaidResourceResponse["context"]): void {
  const request = context.authorizationRequest;
  const facts = context.authorization.facts;
  if (
    context.terms.checkoutDigest !== evidenceDigest(context.paymentRequirements) ||
    context.terms.resourceFingerprint !== context.request.requestFingerprint ||
    request.purchaseId !== context.purchaseId ||
    request.resourceUrl !== context.request.url ||
    request.method !== context.request.method ||
    request.terms.checkoutDigest !== context.terms.checkoutDigest ||
    request.terms.resourceFingerprint !== context.request.requestFingerprint ||
    context.authorization.purchaseId !== context.purchaseId ||
    context.authorization.checkoutDigest !== context.terms.checkoutDigest ||
    facts.resourceFingerprint !== context.request.requestFingerprint ||
    facts.merchantId !== context.terms.merchant.id ||
    facts.merchantOrigin !== context.terms.merchant.origin ||
    facts.payTo !== context.terms.payTo ||
    facts.amountAtomic !== context.terms.amountAtomic ||
    !PAYMENT_IDENTIFIER_PATTERN.test(context.paymentIdentifier)
  ) {
    throw failure("binding_mismatch", "paid response context does not match the authorized Purchase");
  }
}

function assertSettlement(
  context: PaidResourceResponse["context"],
  settlement: PaidResourceResponse["settlement"]
): void {
  const amount = atomic(settlement.amountAtomic, "Settlement amount");
  const maximum = atomic(context.terms.amountAtomic, "authorized amount");
  const amountMatches = settlement.mechanism === "single-transaction"
    ? amount === maximum
    : amount > 0n && amount <= maximum;
  const assuranceMatches = settlement.mechanism === "single-transaction"
    ? paymentFinalityMeets(
        settlement.settlementAssurance,
        context.authorizationRequest.settlementAssurance
      )
    : settlement.settlementAssurance === context.authorizationRequest.settlementAssurance;
  if (
    settlement.executionId !== context.preparedExecutionId ||
    settlement.mechanism !== context.authorizationRequest.executionMechanism ||
    settlement.profile !== context.authorizationRequest.executionProfile ||
    !assuranceMatches ||
    !amountMatches ||
    settlement.asset !== context.terms.asset ||
    settlement.network !== context.terms.network ||
    settlement.payTo !== context.terms.payTo ||
    settlement.fundingSource !== "vault-treasury"
  ) {
    throw failure("binding_mismatch", "Settlement does not match the authorized Purchase");
  }
}

function verifiedArtifact(input: {
  bytes: Uint8Array;
  mediaType: string;
  profile: string;
  issuer: string;
  detail: Record<string, unknown>;
}): VerifiedArtifact {
  const bytes = Uint8Array.from(input.bytes);
  return Object.freeze({
    bytes,
    mediaType: input.mediaType,
    profile: input.profile,
    issuer: input.issuer,
    declaredDigest: evidenceDigest(bytes),
    verification: Object.freeze({
      verifierId: VERIFIER_ID,
      profile: input.profile,
      detailDigest: evidenceDigest(canonicalEvidenceJson(input.detail)),
    }),
  });
}

function verifiedArtifactDigest(artifact: VerifiedArtifact, label: string): Sha256Digest {
  if (!artifact || !(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength === 0) {
    throw failure("binding_mismatch", `${label} is unavailable`);
  }
  const digest = evidenceDigest(artifact.bytes);
  if (artifact.declaredDigest !== undefined && artifact.declaredDigest !== digest) {
    throw failure("binding_mismatch", `${label} declared digest is invalid`);
  }
  return digest;
}

function copyBody(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_BODY_BYTES) {
    throw failure("fulfilment_invalid", "paid HTTP response body is invalid or oversized");
  }
  return Uint8Array.from(value);
}

function copyHeaders(
  value: readonly (readonly [string, string])[]
): readonly (readonly [string, string])[] {
  if (!Array.isArray(value) || value.length > MAX_HEADERS) {
    throw failure("fulfilment_invalid", "paid HTTP response headers are invalid");
  }
  let bytes = 0;
  const result = value.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry[0]) ||
      /[\r\n]/.test(entry[1])
    ) {
      throw failure("fulfilment_invalid", "paid HTTP response header entry is invalid");
    }
    bytes += Buffer.byteLength(entry[0]) + Buffer.byteLength(entry[1]);
    return Object.freeze([entry[0].toLowerCase(), entry[1]] as const);
  });
  if (bytes > MAX_HEADER_BYTES) {
    throw failure("fulfilment_invalid", "paid HTTP response headers are oversized");
  }
  return Object.freeze(result);
}

function atomic(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw failure("binding_mismatch", `${label} is invalid`);
  }
  return BigInt(value);
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximumBytes;
}

function failure(code: PaidResponseVerificationErrorCode, message: string) {
  return new PaidResponseVerificationError(code, message);
}
