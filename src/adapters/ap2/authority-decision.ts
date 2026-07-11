import { createHash } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";

import {
  AUTHORITY_MAX_DECISION_EVIDENCE_BYTES,
  type AuthorityDecisionEvidenceVerificationInput,
  type AuthorityDecisionEvidenceVerifier,
  type AuthorityDenialCode,
  type AuthorityApprovalFacts,
  type IndependentlyVerifiedDecisionEvidence,
  type VerifiedAuthorityApprovalRequest,
} from "../../authority/protocol.js";
import type { Sha256Digest } from "../../purchase/types.js";
import { Ap2AdapterError } from "./errors.js";
import {
  assertExactKeys,
  assertSigningIdentity,
  importSigningKey,
  requireBoundedText,
  requireRecord,
  requireSafeEpoch,
  resolveTrustedPublicKey,
  strictProtectedHeader,
  verificationClock,
} from "./crypto.js";
import {
  issueHumanPresentMandates,
  verifyHumanPresentMandates,
} from "./mandates.js";
import { verifyMerchantCheckout } from "./merchant-checkout.js";
import {
  AP2_HUMAN_PRESENT_PROFILE,
  SOMPI_MERCHANT_CHECKOUT_PROFILE,
  type Ap2PublicKeyResolver,
  type Ap2SigningIdentity,
  type Ap2VerificationClock,
  type VerifiedHumanPresentMandates,
  type VerifiedMerchantCheckout,
} from "./types.js";

export const SOMPI_AP2_AUTHORITY_DECISION_PROFILE =
  "urn:sompi:authority-decision:ap2-v0.2-human-present:1" as const;
export const SOMPI_AP2_AUTHORITY_AUDIENCE =
  "urn:sompi:purchase-authority-verifier" as const;

const MAX_INSTRUMENT_ID_BYTES = 160;
const MAX_EVIDENCE_TEXT_BYTES = AUTHORITY_MAX_DECISION_EVIDENCE_BYTES;
const DENIAL_CODES = new Set<AuthorityDenialCode>(["user_denied", "terms_expired"]);

export type Ap2AuthorityDecisionChoice =
  | Readonly<{ decision: "approved"; instrumentId: string }>
  | Readonly<{ decision: "denied"; denialCode: AuthorityDenialCode }>;

export interface IssueAp2AuthorityDecisionEvidenceOptions {
  readonly request: VerifiedAuthorityApprovalRequest;
  readonly checkout: VerifiedMerchantCheckout;
  readonly choice: Ap2AuthorityDecisionChoice;
  readonly issuedAtSec: number;
  readonly expiresAtSec?: number;
  readonly audience?: string;
}

export interface Ap2AuthorityDecisionEvidenceVerifierOptions extends Ap2VerificationClock {
  readonly trust: Ap2PublicKeyResolver;
  readonly expectedAuthorityIssuer: string;
  readonly expectedAudience?: string;
  readonly expectedInstrumentId: string;
  /** Production clock read at verification time; fixed nowSec remains for vectors. */
  readonly now?: () => number;
}

export interface VerifiedAp2AuthorityDecisionEvidence {
  readonly evidence: IndependentlyVerifiedDecisionEvidence;
  readonly issuer: string;
  readonly kid: string;
  readonly checkout: VerifiedMerchantCheckout;
  readonly mandates?: VerifiedHumanPresentMandates;
  readonly denialCode?: AuthorityDenialCode;
}

/**
 * Creates the local, authority-signed proof that joins the exact authenticated
 * Sompi request to the AP2 mandate pair. This artifact is evidence only; it is
 * never placed on the x402 wire and does not extend AP2 or x402.
 */
export async function issueAp2AuthorityDecisionEvidence(
  options: IssueAp2AuthorityDecisionEvidenceOptions,
  signer: Ap2SigningIdentity,
): Promise<Uint8Array> {
  assertSigningIdentity(signer, "authority");
  assertVerifiedRequest(options.request);
  assertCheckoutMatchesFacts(options.checkout, options.request.message.facts);
  assertCheckoutEvidence(options.checkout, options.request);

  const issuedAtSec = requireSafeEpoch(options.issuedAtSec, "authority decision iat");
  const requestExpirySec = Math.floor(options.request.message.expiresAtMs / 1_000);
  const checkoutExpirySec = options.checkout.expiresAtSec;
  const maximumExpiry = Math.min(requestExpirySec, checkoutExpirySec);
  const expiresAtSec = requireSafeEpoch(
    options.expiresAtSec ?? maximumExpiry,
    "authority decision exp",
  );
  if (expiresAtSec <= issuedAtSec || expiresAtSec > maximumExpiry) {
    throw new Ap2AdapterError(
      "authority decision lifetime exceeds the authenticated Checkout request",
      "time_invalid",
    );
  }

  const audience = requireBoundedText(
    options.audience ?? SOMPI_AP2_AUTHORITY_AUDIENCE,
    "authority decision audience",
    256,
  );
  const common = {
    profile: SOMPI_AP2_AUTHORITY_DECISION_PROFILE,
    iss: signer.issuer,
    aud: audience,
    iat: issuedAtSec,
    exp: expiresAtSec,
    authority_id: signer.issuer,
    purchase_id: options.request.message.facts.purchaseId,
    checkout_digest: options.request.message.facts.checkoutDigest,
    checkout_evidence_digest: options.request.message.checkoutEvidence.digest,
    request_digest: options.request.requestDigest,
    facts_digest: options.request.factsDigest,
    nonce_digest: options.request.nonceDigest,
    facts: canonicalFacts(options.request.message.facts),
  };

  let payload: Record<string, unknown>;
  if (options.choice.decision === "approved") {
    const instrumentId = requireBoundedText(
      options.choice.instrumentId,
      "authority payment instrument ID",
      MAX_INSTRUMENT_ID_BYTES,
    );
    const mandates = await issueHumanPresentMandates({
      checkout: options.checkout,
      instrumentId,
      issuedAtSec,
      expiresAtSec,
    }, signer);
    payload = {
      ...common,
      decision: "approved",
      ap2_profile: AP2_HUMAN_PRESENT_PROFILE,
      instrument_id: instrumentId,
      checkout_mandate: mandates.checkoutMandate,
      payment_mandate: mandates.paymentMandate,
    };
  } else {
    if (!DENIAL_CODES.has(options.choice.denialCode)) {
      throw new Ap2AdapterError("authority denial code is unsupported", "profile_mismatch");
    }
    payload = {
      ...common,
      decision: "denied",
      denial_code: options.choice.denialCode,
    };
  }

  const key = await importSigningKey(signer);
  let artifact: string;
  try {
    artifact = await new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: signer.kid, typ: "JWT" })
      .sign(key);
  } catch {
    throw new Ap2AdapterError("authority decision evidence signing failed", "signature_invalid");
  }
  const bytes = Buffer.from(artifact, "ascii");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EVIDENCE_TEXT_BYTES) {
    throw new Ap2AdapterError("authority decision evidence exceeds its bounded size", "artifact_malformed");
  }
  return Uint8Array.from(bytes);
}

/** Verifies both the local authority signature and the enclosed AP2 evidence. */
export class Ap2AuthorityDecisionEvidenceVerifier
implements AuthorityDecisionEvidenceVerifier {
  constructor(private readonly options: Ap2AuthorityDecisionEvidenceVerifierOptions) {
    requireBoundedText(options.expectedAuthorityIssuer, "expected authority issuer", 256);
    requireBoundedText(options.expectedInstrumentId, "expected payment instrument ID", MAX_INSTRUMENT_ID_BYTES);
    if (options.now !== undefined) {
      const value = options.now();
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Ap2AdapterError("authority verification clock is invalid", "artifact_malformed");
      }
    }
  }

  async verify(
    input: AuthorityDecisionEvidenceVerificationInput,
  ): Promise<IndependentlyVerifiedDecisionEvidence> {
    return (await this.verifyDetailed(input)).evidence;
  }

  async verifyDetailed(
    input: AuthorityDecisionEvidenceVerificationInput,
  ): Promise<VerifiedAp2AuthorityDecisionEvidence> {
    const artifact = strictAsciiEvidence(input.evidence);
    const header = await strictProtectedHeader(artifact, ["alg", "kid", "typ"], "JWT");
    const { key } = await resolveTrustedPublicKey({
      resolver: this.options.trust,
      role: "authority",
      issuer: this.options.expectedAuthorityIssuer,
      kid: header.kid,
    });
    const { nowSec, clockSkewSec } = verificationClock(
      this.options.now
        ? { ...this.options, nowSec: Math.floor(this.options.now() / 1_000) }
        : this.options
    );
    let raw: Record<string, unknown>;
    try {
      const verified = await jwtVerify(artifact, key, {
        algorithms: ["ES256"],
        issuer: this.options.expectedAuthorityIssuer,
        audience: this.options.expectedAudience ?? SOMPI_AP2_AUTHORITY_AUDIENCE,
        currentDate: new Date(nowSec * 1_000),
        clockTolerance: clockSkewSec,
      });
      raw = verified.payload;
    } catch {
      throw new Ap2AdapterError("authority decision evidence signature is invalid", "signature_invalid");
    }

    const payload = validateDecisionPayload(raw, input.expected);
    const checkout = await verifyMerchantCheckout(input.expected.checkoutEvidence.artifact, {
      trust: this.options.trust,
      expectedIssuer: input.expected.checkoutEvidence.issuer,
      expectedAudience: this.options.expectedAuthorityIssuer,
      expectedPurchaseId: input.expected.purchaseId,
      expectedResourceFingerprint: input.expected.facts.resourceFingerprint,
      nowSec,
      clockSkewSec,
    });
    assertCheckoutMatchesFacts(checkout, input.expected.facts);
    if (
      checkout.checkoutDigest !== input.expected.checkoutDigest ||
      checkout.checkoutDigest !== input.expected.checkoutEvidence.digest ||
      checkout.profile !== input.expected.checkoutEvidence.profile ||
      checkout.profile !== SOMPI_MERCHANT_CHECKOUT_PROFILE
    ) {
      throw new Ap2AdapterError("authority decision uses different Checkout evidence", "binding_mismatch");
    }

    let mandates: VerifiedHumanPresentMandates | undefined;
    let denialCode: AuthorityDenialCode | undefined;
    if (payload.decision === "approved") {
      mandates = await verifyHumanPresentMandates({
        checkoutMandate: payload.checkout_mandate,
        paymentMandate: payload.payment_mandate,
      }, {
        trust: this.options.trust,
        expectedAuthorityIssuer: this.options.expectedAuthorityIssuer,
        checkout,
        expectedInstrumentId: this.options.expectedInstrumentId,
        nowSec,
        clockSkewSec,
      });
      if (payload.instrument_id !== this.options.expectedInstrumentId) {
        throw new Ap2AdapterError("authority decision payment instrument was substituted", "binding_mismatch");
      }
    } else {
      denialCode = payload.denial_code;
    }

    const evidenceDigest = digestBytes(input.evidence);
    const evidence = Object.freeze({
      decision: payload.decision,
      authorityId: payload.authority_id,
      purchaseId: input.expected.purchaseId,
      checkoutDigest: input.expected.checkoutDigest,
      requestDigest: input.expected.requestDigest,
      factsDigest: input.expected.factsDigest,
      nonceDigest: input.expected.nonceDigest,
      evidenceDigest,
      verificationProfile: SOMPI_AP2_AUTHORITY_DECISION_PROFILE,
      verifierId: `ap2-authority:${this.options.expectedAuthorityIssuer}:${header.kid}`,
    }) satisfies IndependentlyVerifiedDecisionEvidence;
    return Object.freeze({
      evidence,
      issuer: this.options.expectedAuthorityIssuer,
      kid: header.kid,
      checkout,
      ...(mandates ? { mandates } : {}),
      ...(denialCode ? { denialCode } : {}),
    });
  }
}

type ApprovedPayload = Readonly<{
  decision: "approved";
  authority_id: string;
  instrument_id: string;
  checkout_mandate: string;
  payment_mandate: string;
}>;
type DeniedPayload = Readonly<{
  decision: "denied";
  authority_id: string;
  denial_code: AuthorityDenialCode;
}>;

function validateDecisionPayload(
  candidate: Record<string, unknown>,
  expected: AuthorityDecisionEvidenceVerificationInput["expected"],
): ApprovedPayload | DeniedPayload {
  const decision = candidate.decision;
  const common = [
    "profile", "iss", "aud", "iat", "exp", "authority_id", "purchase_id",
    "checkout_digest", "checkout_evidence_digest", "request_digest", "facts_digest",
    "nonce_digest", "facts", "decision",
  ];
  const required = decision === "approved"
    ? [...common, "ap2_profile", "instrument_id", "checkout_mandate", "payment_mandate"]
    : [...common, "denial_code"];
  assertExactKeys(candidate, required, required, "authority decision evidence");
  if (candidate.profile !== SOMPI_AP2_AUTHORITY_DECISION_PROFILE) {
    throw new Ap2AdapterError("authority decision evidence profile is unsupported", "profile_mismatch");
  }
  if (candidate.iss !== expected.authorityId || candidate.authority_id !== expected.authorityId) {
    throw new Ap2AdapterError("authority decision evidence issuer does not match", "binding_mismatch");
  }
  const exact: ReadonlyArray<readonly [unknown, string]> = [
    [candidate.purchase_id, expected.purchaseId],
    [candidate.checkout_digest, expected.checkoutDigest],
    [candidate.checkout_evidence_digest, expected.checkoutEvidence.digest],
    [candidate.request_digest, expected.requestDigest],
    [candidate.facts_digest, expected.factsDigest],
    [candidate.nonce_digest, expected.nonceDigest],
  ];
  if (exact.some(([actual, wanted]) => actual !== wanted)) {
    throw new Ap2AdapterError("authority decision evidence is bound to different facts", "binding_mismatch");
  }
  assertExactFacts(candidate.facts, expected.facts);

  if (decision === "approved") {
    if (expected.decision !== "approved" || candidate.ap2_profile !== AP2_HUMAN_PRESENT_PROFILE) {
      throw new Ap2AdapterError("authority approval profile does not match", "binding_mismatch");
    }
    return Object.freeze({
      decision,
      authority_id: expected.authorityId,
      instrument_id: requireBoundedText(candidate.instrument_id, "authority payment instrument ID", MAX_INSTRUMENT_ID_BYTES),
      checkout_mandate: requireBoundedText(candidate.checkout_mandate, "Checkout Mandate", MAX_EVIDENCE_TEXT_BYTES),
      payment_mandate: requireBoundedText(candidate.payment_mandate, "Payment Mandate", MAX_EVIDENCE_TEXT_BYTES),
    });
  }
  if (decision !== "denied" || expected.decision !== "denied" || !DENIAL_CODES.has(candidate.denial_code as AuthorityDenialCode)) {
    throw new Ap2AdapterError("authority denial does not match", "binding_mismatch");
  }
  return Object.freeze({
    decision,
    authority_id: expected.authorityId,
    denial_code: candidate.denial_code as AuthorityDenialCode,
  });
}

function assertVerifiedRequest(request: VerifiedAuthorityApprovalRequest): void {
  if (!request || request.message.kind !== "approval_request" || request.replay.status !== "acquired") {
    throw new Ap2AdapterError("authority decision requires a newly verified request", "binding_mismatch");
  }
}

function assertCheckoutEvidence(
  checkout: VerifiedMerchantCheckout,
  request: VerifiedAuthorityApprovalRequest,
): void {
  const evidence = request.message.checkoutEvidence;
  if (
    checkout.artifact !== evidence.artifact ||
    checkout.checkoutDigest !== evidence.digest ||
    checkout.profile !== evidence.profile ||
    checkout.issuer !== evidence.issuer
  ) {
    throw new Ap2AdapterError("authority request Checkout evidence was substituted", "binding_mismatch");
  }
}

function assertCheckoutMatchesFacts(
  checkout: VerifiedMerchantCheckout,
  facts: AuthorityApprovalFacts,
): void {
  const comparisons: ReadonlyArray<readonly [unknown, unknown]> = [
    [checkout.purchaseId, facts.purchaseId],
    [checkout.terms.merchant.id, facts.merchantId],
    [checkout.terms.merchant.name, facts.merchantName],
    [checkout.terms.merchant.origin, facts.merchantOrigin],
    [checkout.resourceUrl, facts.resourceUrl],
    [checkout.method, facts.method],
    [checkout.terms.resourceFingerprint, facts.resourceFingerprint],
    [checkout.terms.amountAtomic, facts.amountAtomic],
    [checkout.terms.asset, facts.asset],
    [checkout.terms.network, facts.network],
    [checkout.terms.payTo, facts.payTo],
    [checkout.terms.expiresAt, facts.termsExpiresAt],
    [checkout.checkoutDigest, facts.checkoutDigest],
    [checkout.additionalCostCeilingAtomic, facts.additionalCostCeilingAtomic],
  ];
  if (comparisons.some(([actual, wanted]) => actual !== wanted)) {
    throw new Ap2AdapterError("Merchant Checkout does not match the exact authority facts", "binding_mismatch");
  }
}

function canonicalFacts(facts: AuthorityApprovalFacts): AuthorityApprovalFacts {
  return Object.freeze({
    purchaseId: facts.purchaseId,
    merchantId: facts.merchantId,
    merchantName: facts.merchantName,
    merchantOrigin: facts.merchantOrigin,
    resourceUrl: facts.resourceUrl,
    method: facts.method,
    requestMediaType: facts.requestMediaType,
    requestBodyDigest: facts.requestBodyDigest,
    resourceFingerprint: facts.resourceFingerprint,
    amountAtomic: facts.amountAtomic,
    asset: facts.asset,
    network: facts.network,
    payTo: facts.payTo,
    termsExpiresAt: facts.termsExpiresAt,
    checkoutDigest: facts.checkoutDigest,
    purchaseAuthorizationRequestDigest: facts.purchaseAuthorizationRequestDigest,
    purchaseAuthorizationNonceDigest: facts.purchaseAuthorizationNonceDigest,
    purchaseAuthorizationFactsDigest: facts.purchaseAuthorizationFactsDigest,
    additionalCostCeilingAtomic: facts.additionalCostCeilingAtomic,
  });
}

function assertExactFacts(candidate: unknown, expected: AuthorityApprovalFacts): void {
  const record = requireRecord(candidate, "authority decision facts");
  const wanted = canonicalFacts(expected);
  const keys = Object.keys(wanted);
  assertExactKeys(record, keys, keys, "authority decision facts");
  for (const key of keys as Array<keyof AuthorityApprovalFacts>) {
    if (record[key] !== wanted[key]) {
      throw new Ap2AdapterError(`authority decision fact ${key} was substituted`, "binding_mismatch");
    }
  }
}

function strictAsciiEvidence(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_EVIDENCE_TEXT_BYTES) {
    throw new Ap2AdapterError("authority decision evidence is malformed", "artifact_malformed");
  }
  const text = Buffer.from(bytes).toString("ascii");
  if (Buffer.byteLength(text, "ascii") !== bytes.byteLength || /[^\x21-\x7e]/.test(text)) {
    throw new Ap2AdapterError("authority decision evidence is not compact ASCII", "artifact_malformed");
  }
  return text;
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}` as Sha256Digest;
}
