import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  assertPurchaseId,
  canonicalMediaType,
  canonicalRequestUrl,
  requestFingerprintFromBodyDigest,
} from "../purchase/identity.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";
import { Address } from "../kaspa-wasm.js";

export const AUTHORITY_IPC_PROTOCOL = "sompi.authority.ipc" as const;
export const AUTHORITY_IPC_VERSION = 1 as const;
export const AUTHORITY_MAC_ALGORITHM = "hmac-sha256" as const;
export const AUTHORITY_MAC_KEY_BYTES = 32;
export const AUTHORITY_NONCE_BYTES = 32;
export const AUTHORITY_MESSAGE_ID_BYTES = 16;
export const AUTHORITY_MAX_WIRE_BYTES = 32 * 1024;
export const AUTHORITY_MAX_REPLAY_RESULT_BYTES = 64 * 1024;
/** Durable replay high-water bounds; cleanup is eager at every acquisition. */
export const AUTHORITY_MAX_REPLAY_MESSAGE_ROWS = 4_096;
export const AUTHORITY_MAX_REPLAY_TOKEN_ROWS = 8_192;
export const AUTHORITY_MAX_REPLAY_RESULT_STORAGE_BYTES = 256 * 1024 * 1024;
export const AUTHORITY_MAX_DECISION_EVIDENCE_BYTES = 256 * 1024;
export const AUTHORITY_MAX_CHECKOUT_EVIDENCE_BYTES = 20 * 1024;
export const AUTHORITY_REPLAY_LEASE_MS = 15_000;
export const AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT =
  "independent-signature-and-exact-facts-required" as const;

export const AUTHORITY_DENIAL_CODES = ["user_denied", "terms_expired"] as const;
export type AuthorityDenialCode = (typeof AUTHORITY_DENIAL_CODES)[number];

declare const authorityRequestIdBrand: unique symbol;
declare const authorityResponseIdBrand: unique symbol;
declare const authorityNonceBrand: unique symbol;

export type AuthorityRequestId = string & { readonly [authorityRequestIdBrand]: true };
export type AuthorityResponseId = string & { readonly [authorityResponseIdBrand]: true };
export type AuthorityNonce = string & { readonly [authorityNonceBrand]: true };

/** Exact, display-ready Purchase and Checkout Terms facts. */
export interface AuthorityApprovalFacts {
  readonly purchaseId: PurchaseId;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantOrigin: string;
  readonly resourceUrl: string;
  readonly method: string;
  /** Canonical Content-Type, or the empty string when the request has none. */
  readonly requestMediaType: string;
  /** SHA-256 of the exact HTTP request body, including the empty body. */
  readonly requestBodyDigest: Sha256Digest;
  readonly resourceFingerprint: Sha256Digest;
  readonly amountAtomic: string;
  readonly asset: string;
  readonly network: string;
  readonly payTo: string;
  readonly termsExpiresAt: string;
  readonly checkoutDigest: Sha256Digest;
  /** Digest of the protocol-neutral Purchase Authorization request evidence. */
  readonly purchaseAuthorizationRequestDigest: Sha256Digest;
  /** Digest of its nonce; distinct from the local IPC envelope nonce. */
  readonly purchaseAuthorizationNonceDigest: Sha256Digest;
  /** Digest of Sompi's protocol-neutral canonical Purchase Authorization facts. */
  readonly purchaseAuthorizationFactsDigest: Sha256Digest;
  /** Maximum non-price treasury outflow, including KIP-10 top-up and transaction fees. */
  readonly additionalCostCeilingAtomic: string;
  /** Stronger of Merchant protocol finality and the operator floor. */
  readonly effectiveFinalityFloor: "accepted" | "depth-confirmed";
}

/** Exact Merchant-signed Checkout bytes needed for independent AP2 verification. */
export interface AuthorityCheckoutEvidence {
  readonly artifact: string;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly profile: string;
  readonly issuer: string;
}

export interface AuthorityApprovalRequest {
  readonly kind: "approval_request";
  readonly requestId: AuthorityRequestId;
  readonly nonce: AuthorityNonce;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly facts: AuthorityApprovalFacts;
  readonly checkoutEvidence: AuthorityCheckoutEvidence;
}

export interface ApprovedAuthorityResult {
  readonly decision: "approved";
  readonly authorityId: string;
  /**
   * The IPC MAC authenticates framing, not Purchase Authorization. Callers
   * must independently load, verify, and exactly match this signed evidence.
   */
  readonly decisionEvidenceDigest: Sha256Digest;
  readonly evidenceVerification: typeof AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT;
}

export interface DeniedAuthorityResult {
  readonly decision: "denied";
  readonly authorityId: string;
  readonly denialCode: AuthorityDenialCode;
  /** Signed decision evidence is mandatory because the symmetric MAC proves no direction. */
  readonly decisionEvidenceDigest: Sha256Digest;
  readonly evidenceVerification: typeof AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT;
}

export type AuthorityApprovalResult = ApprovedAuthorityResult | DeniedAuthorityResult;

export interface AuthorityApprovalResponse {
  readonly kind: "approval_response";
  readonly responseId: AuthorityResponseId;
  readonly requestId: AuthorityRequestId;
  readonly purchaseId: PurchaseId;
  readonly checkoutDigest: Sha256Digest;
  /** Digest of the exact authenticated request wire bytes. */
  readonly requestDigest: Sha256Digest;
  readonly factsDigest: Sha256Digest;
  readonly nonceDigest: Sha256Digest;
  readonly respondedAtMs: number;
  readonly expiresAtMs: number;
  readonly result: AuthorityApprovalResult;
}

export interface AuthenticatedAuthorityApprovalRequest {
  readonly keyId: string;
  readonly message: AuthorityApprovalRequest;
  readonly wire: string;
  readonly requestDigest: Sha256Digest;
  readonly factsDigest: Sha256Digest;
  readonly nonceDigest: Sha256Digest;
}

export interface SealedAuthorityApprovalRequest extends AuthenticatedAuthorityApprovalRequest {}

declare const verifiedAuthorityRequestBrand: unique symbol;

/** Returned only after MAC, freshness, and durable replay acquisition succeed. */
export interface VerifiedAuthorityApprovalRequest extends AuthenticatedAuthorityApprovalRequest {
  readonly [verifiedAuthorityRequestBrand]: true;
  readonly acceptedAtMs: number;
  readonly replay: AuthorityReplayDisposition;
}

export interface AuthenticatedAuthorityApprovalResponse {
  readonly keyId: string;
  readonly message: AuthorityApprovalResponse;
  readonly wire: string;
  readonly responseDigest: Sha256Digest;
}

declare const verifiedAuthorityResponseBrand: unique symbol;

/** Verifies only IPC framing, freshness, binding, and replay state. */
export interface VerifiedAuthorityIpcResponse extends AuthenticatedAuthorityApprovalResponse {
  readonly [verifiedAuthorityResponseBrand]: true;
  readonly replayDigest: Sha256Digest;
  readonly replay: AuthorityReplayDisposition;
}

export interface IndependentlyVerifiedDecisionEvidence {
  readonly decision: "approved" | "denied";
  readonly authorityId: string;
  readonly purchaseId: PurchaseId;
  readonly checkoutDigest: Sha256Digest;
  readonly requestDigest: Sha256Digest;
  readonly factsDigest: Sha256Digest;
  readonly nonceDigest: Sha256Digest;
  readonly evidenceDigest: Sha256Digest;
  readonly verificationProfile: string;
  readonly verifierId: string;
}

export interface AuthorityDecisionEvidenceVerificationInput {
  readonly evidence: Uint8Array;
  readonly expected: Readonly<{
    decision: "approved" | "denied";
    authorityId: string;
    purchaseId: PurchaseId;
    checkoutDigest: Sha256Digest;
    requestDigest: Sha256Digest;
    factsDigest: Sha256Digest;
    nonceDigest: Sha256Digest;
    evidenceDigest: Sha256Digest;
    facts: AuthorityApprovalFacts;
    checkoutEvidence: AuthorityCheckoutEvidence;
  }>;
}

/** Adapter seam that must verify the independent signature and exact signed facts. */
export interface AuthorityDecisionEvidenceVerifier {
  verify(
    input: AuthorityDecisionEvidenceVerificationInput
  ): Promise<IndependentlyVerifiedDecisionEvidence>;
}

declare const verifiedAuthorityDecisionBrand: unique symbol;

/** The only authority result type suitable for a Purchase-authorised transition. */
export interface VerifiedAuthorityDecision {
  readonly [verifiedAuthorityDecisionBrand]: true;
  readonly ipc: VerifiedAuthorityIpcResponse;
  readonly facts: AuthorityApprovalFacts;
  readonly checkoutEvidence: AuthorityCheckoutEvidence;
  readonly evidence: IndependentlyVerifiedDecisionEvidence;
}

/**
 * Authentication implementation at the local IPC seam. Implementations must
 * not retain `keyBytes`; the caller owns and supplies them for each operation.
 */
export interface AuthorityMac {
  readonly algorithm: typeof AUTHORITY_MAC_ALGORITHM;
  sign(canonicalPayload: Uint8Array, keyBytes: Uint8Array): string;
  verify(canonicalPayload: Uint8Array, tag: string, keyBytes: Uint8Array): boolean;
}

export interface AuthorityAuthenticationInput {
  readonly keyId: string;
  readonly keyBytes: Uint8Array;
  readonly mac?: AuthorityMac;
}

export type AuthorityReplayScope = "approval_request" | "approval_response";

export interface AuthorityReplayAcquireInput {
  readonly scope: AuthorityReplayScope;
  readonly messageDigest: Sha256Digest;
  /** Domain-separated digests; raw nonces, IDs, and messages need not be retained. */
  readonly tokenDigests: readonly Sha256Digest[];
  readonly nowMs: number;
  readonly leaseExpiresAtMs: number;
  readonly expiresAtMs: number;
}

export type AuthorityReplayAcquireResult =
  | {
      readonly status: "acquired";
      readonly acquisitionId: string;
      readonly leaseExpiresAtMs: number;
    }
  | { readonly status: "existing"; readonly leaseExpiresAtMs: number }
  | { readonly status: "conflict" };

export interface AuthorityReplayRenewInput {
  readonly scope: AuthorityReplayScope;
  readonly messageDigest: Sha256Digest;
  readonly acquisitionId: string;
  readonly nowMs: number;
  readonly leaseExpiresAtMs: number;
  readonly expiresAtMs: number;
}

export interface AuthorityReplayLookupInput {
  readonly scope: AuthorityReplayScope;
  readonly messageDigest: Sha256Digest;
}

export interface AuthorityReplayCompletion {
  readonly scope: AuthorityReplayScope;
  readonly messageDigest: Sha256Digest;
  readonly resultDigest: Sha256Digest;
  /** Exact, secret-free prior output used to make retries idempotent. */
  readonly result: string;
  readonly expiresAtMs: number;
}

export interface AuthorityReplayCompleteInput extends AuthorityReplayCompletion {
  readonly acquisitionId: string;
}

export type AuthorityReplayDisposition =
  | {
      readonly status: "acquired";
      readonly acquisitionId: string;
      readonly leaseExpiresAtMs: number;
    }
  | { readonly status: "in_progress"; readonly leaseExpiresAtMs: number }
  | {
      readonly status: "completed";
      readonly resultDigest: Sha256Digest;
      readonly result: string;
    };

/**
 * Durable replay store contract.
 *
 * `acquire` atomically persists all tokens bound to `messageDigest` before it
 * returns. An exact retry returns `existing`; any token bound to another
 * message returns `conflict`. `complete` atomically records the exact prior
 * output and is idempotent only for identical input. `lookup` returns that
 * output after a crash. An exact in-progress retry after `leaseExpiresAtMs`
 * must acquire a new, fenced `acquisitionId`; a live approval ceremony must
 * renew its lease. Takeover resumes the exact request and may re-display a
 * clearly identified retry if no completed decision exists. The authority
 * executable must persist signed decision evidence immediately before sealing
 * the response; this codec cannot make a human action and disk write atomic.
 * `renew` and `complete` must reject an expired or superseded acquisition.
 */
export interface AuthorityReplayStore {
  acquire(input: AuthorityReplayAcquireInput): AuthorityReplayAcquireResult;
  renew(input: AuthorityReplayRenewInput): void;
  lookup(input: AuthorityReplayLookupInput): AuthorityReplayCompletion | undefined;
  complete(input: AuthorityReplayCompleteInput): void;
}

export interface AuthorityFreshnessLimits {
  readonly maxClockSkewMs: number;
  readonly maxRequestAgeMs: number;
  readonly maxRequestLifetimeMs: number;
  readonly maxResponseAgeMs: number;
  readonly maxResponseLifetimeMs: number;
}

export const DEFAULT_AUTHORITY_FRESHNESS_LIMITS: AuthorityFreshnessLimits = Object.freeze({
  maxClockSkewMs: 5_000,
  // Matches the bounded human-present request window so a crashed authority
  // can reacquire the same durable request without minting new approval facts.
  maxRequestAgeMs: 120_000,
  maxRequestLifetimeMs: 5 * 60_000,
  maxResponseAgeMs: 30_000,
  maxResponseLifetimeMs: 30_000,
});

export interface AuthorityVerificationInput extends AuthorityAuthenticationInput {
  readonly now: () => number;
  readonly replayStore: AuthorityReplayStore;
  readonly freshness?: Partial<AuthorityFreshnessLimits>;
}

export type AuthorityProtocolErrorCode =
  | "malformed_message"
  | "unsupported_protocol"
  | "authentication_failed"
  | "stale_message"
  | "binding_mismatch"
  | "replayed_message"
  | "replay_cache_unavailable"
  | "evidence_verification_failed"
  | "invalid_configuration";

const ERROR_MESSAGES: Readonly<Record<AuthorityProtocolErrorCode, string>> = Object.freeze({
  malformed_message: "authority message is malformed",
  unsupported_protocol: "authority protocol is unsupported",
  authentication_failed: "authority message authentication failed",
  stale_message: "authority message is outside its freshness window",
  binding_mismatch: "authority response does not match its request",
  replayed_message: "authority message has already been consumed",
  replay_cache_unavailable: "authority replay protection is unavailable",
  evidence_verification_failed: "authority decision evidence verification failed",
  invalid_configuration: "authority protocol configuration is invalid",
});

/** Error messages and enumerable properties never include untrusted bytes or key material. */
export class AuthorityProtocolError extends Error {
  readonly code: AuthorityProtocolErrorCode;

  constructor(code: AuthorityProtocolErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AuthorityProtocolError";
    this.code = code;
  }
}

const MAC_DOMAIN = Buffer.from("sompi:authority-ipc:mac:v1\0", "utf8");
const VERIFIED_REQUESTS = new WeakSet<object>();
const VERIFIED_IPC_RESPONSES = new WeakSet<object>();
const VERIFIED_DECISIONS = new WeakSet<object>();
const COMPLETED_REQUESTS = new WeakSet<object>();
const REQUEST_REPLAY_STORES = new WeakMap<object, AuthorityReplayStore>();

export const HMAC_SHA256_AUTHORITY_MAC: AuthorityMac = Object.freeze({
  algorithm: AUTHORITY_MAC_ALGORITHM,
  sign(canonicalPayload: Uint8Array, keyBytes: Uint8Array): string {
    requireMacKey(keyBytes);
    const keyCopy = Buffer.from(keyBytes);
    let digest: Buffer | undefined;
    try {
      digest = createHmac("sha256", keyCopy).update(MAC_DOMAIN).update(canonicalPayload).digest();
      return digest.toString("base64url");
    } finally {
      digest?.fill(0);
      keyCopy.fill(0);
    }
  },
  verify(canonicalPayload: Uint8Array, tag: string, keyBytes: Uint8Array): boolean {
    if (!MAC_PATTERN.test(tag)) return false;
    const supplied = Buffer.from(tag, "base64url");
    if (supplied.byteLength !== 32 || supplied.toString("base64url") !== tag) return false;
    const expectedTag = HMAC_SHA256_AUTHORITY_MAC.sign(canonicalPayload, keyBytes);
    const expected = Buffer.from(expectedTag, "base64url");
    try {
      return expected.byteLength === supplied.byteLength && timingSafeEqual(expected, supplied);
    } finally {
      expected.fill(0);
      supplied.fill(0);
    }
  },
});

export function createAuthorityRequestId(
  entropy: Uint8Array = randomBytes(AUTHORITY_MESSAGE_ID_BYTES)
): AuthorityRequestId {
  requireEntropy(entropy, AUTHORITY_MESSAGE_ID_BYTES);
  return requireRequestId(`arq_${Buffer.from(entropy).toString("base64url")}`);
}

export function createAuthorityResponseId(
  entropy: Uint8Array = randomBytes(AUTHORITY_MESSAGE_ID_BYTES)
): AuthorityResponseId {
  requireEntropy(entropy, AUTHORITY_MESSAGE_ID_BYTES);
  return requireResponseId(`ars_${Buffer.from(entropy).toString("base64url")}`);
}

export function createAuthorityNonce(
  entropy: Uint8Array = randomBytes(AUTHORITY_NONCE_BYTES)
): AuthorityNonce {
  requireEntropy(entropy, AUTHORITY_NONCE_BYTES);
  return requireNonce(Buffer.from(entropy).toString("base64url"));
}

export function sealAuthorityApprovalRequest(
  candidate: AuthorityApprovalRequest,
  authentication: AuthorityAuthenticationInput
): SealedAuthorityApprovalRequest {
  const message = canonicalRequest(candidate);
  const sealed = sealEnvelope(message, authentication);
  return freezeAuthenticatedRequest(authentication.keyId, message, sealed.wire);
}

export function parseAuthorityApprovalRequest(
  input: string | Uint8Array,
  verification: AuthorityVerificationInput
): VerifiedAuthorityApprovalRequest {
  const parsed = parseEnvelope(input, "approval_request");
  const message = canonicalRequest(parsed.message as AuthorityApprovalRequest);
  verifyCanonicalEnvelope(parsed, message, verification);
  const authenticated = freezeAuthenticatedRequest(parsed.keyId, message, parsed.wire);
  const freshness = requestFreshness(message, verification);
  const acceptedAtMs = freshness.nowMs;
  const replay = freshness.aged
    ? lookupCompletedReplay(
        verification.replayStore,
        "approval_request",
        authenticated.requestDigest,
        message.expiresAtMs
      )
    : acquireReplay(
        verification.replayStore,
        "approval_request",
        authenticated.requestDigest,
        [
          replayToken("approval_request", "nonce", parsed.keyId, authenticated.nonceDigest),
          replayToken("approval_request", "request-id", parsed.keyId, message.requestId),
        ],
        acceptedAtMs,
        message.expiresAtMs
      );
  if (freshness.aged && replay === undefined) {
    throw new AuthorityProtocolError("stale_message");
  }
  const verified = Object.freeze({
    ...authenticated,
    acceptedAtMs,
    replay: replay as AuthorityReplayDisposition,
  }) as VerifiedAuthorityApprovalRequest;
  VERIFIED_REQUESTS.add(verified);
  REQUEST_REPLAY_STORES.set(verified, verification.replayStore);
  return verified;
}

export interface BindAuthorityApprovalResponseInput {
  readonly responseId: AuthorityResponseId;
  readonly respondedAtMs: number;
  readonly expiresAtMs: number;
  readonly result: AuthorityApprovalResult;
}

/** Derives every response binding rather than accepting caller-supplied joins. */
export function bindAuthorityApprovalResponse(
  request: VerifiedAuthorityApprovalRequest,
  input: BindAuthorityApprovalResponseInput
): AuthorityApprovalResponse {
  const checkedRequest = assertVerifiedRequest(request);
  const response = canonicalResponse(
    {
      kind: "approval_response",
      responseId: input.responseId,
      requestId: checkedRequest.message.requestId,
      purchaseId: checkedRequest.message.facts.purchaseId,
      checkoutDigest: checkedRequest.message.facts.checkoutDigest,
      requestDigest: checkedRequest.requestDigest,
      factsDigest: checkedRequest.factsDigest,
      nonceDigest: checkedRequest.nonceDigest,
      respondedAtMs: input.respondedAtMs,
      expiresAtMs: input.expiresAtMs,
      result: input.result,
    },
    checkedRequest
  );
  if (response.respondedAtMs < checkedRequest.acceptedAtMs) {
    throw new AuthorityProtocolError("binding_mismatch");
  }
  const store = REQUEST_REPLAY_STORES.get(checkedRequest);
  if (!store) throw new AuthorityProtocolError("replay_cache_unavailable");
  renewAuthorityReplayLease(store, checkedRequest, response.respondedAtMs);
  return response;
}

export function sealAuthorityApprovalResponse(
  candidate: AuthorityApprovalResponse,
  request: VerifiedAuthorityApprovalRequest,
  authentication: AuthorityAuthenticationInput
): AuthenticatedAuthorityApprovalResponse {
  const checkedRequest = assertVerifiedRequest(request);
  if (authentication.keyId !== checkedRequest.keyId) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  const message = canonicalResponse(candidate, checkedRequest);
  if (message.respondedAtMs < checkedRequest.acceptedAtMs) {
    throw new AuthorityProtocolError("binding_mismatch");
  }
  const sealed = sealEnvelope(message, authentication);
  const authenticated = freezeAuthenticatedResponse(authentication.keyId, message, sealed.wire);
  const store = REQUEST_REPLAY_STORES.get(checkedRequest);
  if (!store) throw new AuthorityProtocolError("replay_cache_unavailable");
  completeAuthorityReplay(store, checkedRequest, authenticated.wire);
  return authenticated;
}

export interface RecoverAuthorityApprovalResponseInput {
  readonly responseId: AuthorityResponseId;
  readonly respondedAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * Reissues fresh authenticated transport around a completed, independently
 * signed decision. It never repeats the approval ceremony or changes evidence.
 */
export function recoverAuthorityApprovalResponse(
  request: VerifiedAuthorityApprovalRequest,
  input: RecoverAuthorityApprovalResponseInput,
  authentication: AuthorityAuthenticationInput
): AuthenticatedAuthorityApprovalResponse {
  const checkedRequest = assertVerifiedRequestProvenance(request);
  if (checkedRequest.replay.status !== "completed") {
    throw new AuthorityProtocolError("replayed_message");
  }
  const prior = parseEnvelope(checkedRequest.replay.result, "approval_response");
  const priorMessage = canonicalResponse(
    prior.message as AuthorityApprovalResponse,
    checkedRequest
  );
  verifyEnvelopeAuthentication(prior, priorMessage, authentication);
  if (priorMessage.responseId === input.responseId) {
    throw new AuthorityProtocolError("binding_mismatch");
  }
  const message = canonicalResponse(
    {
      ...priorMessage,
      responseId: input.responseId,
      respondedAtMs: input.respondedAtMs,
      expiresAtMs: input.expiresAtMs,
    },
    checkedRequest
  );
  if (message.respondedAtMs < checkedRequest.acceptedAtMs) {
    throw new AuthorityProtocolError("binding_mismatch");
  }
  const sealed = sealEnvelope(message, authentication);
  return freezeAuthenticatedResponse(authentication.keyId, message, sealed.wire);
}

export function parseAuthorityApprovalResponse(
  input: string | Uint8Array,
  request: AuthenticatedAuthorityApprovalRequest,
  verification: AuthorityVerificationInput
): VerifiedAuthorityIpcResponse {
  const checkedRequest = assertAuthenticatedRequestShape(request);
  if (verification.keyId !== checkedRequest.keyId) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  const parsed = parseEnvelope(input, "approval_response");
  const message = canonicalResponse(parsed.message as AuthorityApprovalResponse, checkedRequest);
  verifyCanonicalEnvelope(parsed, message, verification);
  const acceptedAtMs = assertResponseFreshness(message, checkedRequest.message, verification);
  const authenticated = freezeAuthenticatedResponse(parsed.keyId, message, parsed.wire);
  const decisionReplayDigest = authorityDecisionReplayDigest(message);
  const replay = acquireReplay(
    verification.replayStore,
    "approval_response",
    decisionReplayDigest,
    [
      replayToken("approval_response", "request", parsed.keyId, message.requestDigest),
    ],
    acceptedAtMs,
    message.expiresAtMs
  );
  const verified = Object.freeze({
    ...authenticated,
    replayDigest: decisionReplayDigest,
    replay,
  }) as VerifiedAuthorityIpcResponse;
  VERIFIED_IPC_RESPONSES.add(verified);
  return verified;
}

export async function verifyAuthorityDecisionEvidence(
  ipc: VerifiedAuthorityIpcResponse,
  request: AuthenticatedAuthorityApprovalRequest,
  evidence: Uint8Array,
  verifier: AuthorityDecisionEvidenceVerifier
): Promise<VerifiedAuthorityDecision> {
  if (!ipc || !VERIFIED_IPC_RESPONSES.has(ipc)) {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
  const checkedRequest = assertAuthenticatedRequestShape(request);
  canonicalResponse(ipc.message, checkedRequest);
  if (
    !(evidence instanceof Uint8Array) ||
    evidence.byteLength === 0 ||
    evidence.byteLength > AUTHORITY_MAX_DECISION_EVIDENCE_BYTES ||
    !verifier ||
    typeof verifier.verify !== "function"
  ) {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
  const result = ipc.message.result;
  const evidenceCopy = Uint8Array.from(evidence);
  const evidenceDigest = exactBytesDigest(evidenceCopy);
  if (evidenceDigest !== result.decisionEvidenceDigest) {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
  const expected = Object.freeze({
    decision: result.decision,
    authorityId: result.authorityId,
    purchaseId: ipc.message.purchaseId,
    checkoutDigest: ipc.message.checkoutDigest,
    requestDigest: ipc.message.requestDigest,
    factsDigest: ipc.message.factsDigest,
    nonceDigest: ipc.message.nonceDigest,
    evidenceDigest,
    facts: checkedRequest.message.facts,
    checkoutEvidence: checkedRequest.message.checkoutEvidence,
  });
  let candidate: IndependentlyVerifiedDecisionEvidence;
  try {
    candidate = await verifier.verify(Object.freeze({ evidence: evidenceCopy, expected }));
  } catch {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
  if (exactBytesDigest(evidenceCopy) !== evidenceDigest) {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
  const verifiedEvidence = canonicalVerifiedDecisionEvidence(candidate);
  const comparisons: ReadonlyArray<[string, string]> = [
    [verifiedEvidence.decision, expected.decision],
    [verifiedEvidence.authorityId, expected.authorityId],
    [verifiedEvidence.purchaseId, expected.purchaseId],
    [verifiedEvidence.checkoutDigest, expected.checkoutDigest],
    [verifiedEvidence.requestDigest, expected.requestDigest],
    [verifiedEvidence.factsDigest, expected.factsDigest],
    [verifiedEvidence.nonceDigest, expected.nonceDigest],
    [verifiedEvidence.evidenceDigest, expected.evidenceDigest],
  ];
  if (comparisons.some(([actual, wanted]) => actual !== wanted)) {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
  const decision = Object.freeze({
    ipc,
    facts: checkedRequest.message.facts,
    checkoutEvidence: checkedRequest.message.checkoutEvidence,
    evidence: verifiedEvidence,
  }) as VerifiedAuthorityDecision;
  VERIFIED_DECISIONS.add(decision);
  return decision;
}

export function assertVerifiedAuthorityDecision(candidate: VerifiedAuthorityDecision): VerifiedAuthorityDecision {
  if (
    !candidate ||
    !VERIFIED_DECISIONS.has(candidate) ||
    !VERIFIED_IPC_RESPONSES.has(candidate.ipc)
  ) {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
  return candidate;
}

/**
 * Durably records the exact result of a first-seen message. Call this before
 * returning the result or committing any downstream effect that depends on it.
 */
export function completeAuthorityReplay(
  store: AuthorityReplayStore,
  message: VerifiedAuthorityApprovalRequest | VerifiedAuthorityIpcResponse,
  result: string
): AuthorityReplayCompletion {
  if (message.replay.status !== "acquired") {
    throw new AuthorityProtocolError("replayed_message");
  }
  const scope: AuthorityReplayScope = message.message.kind;
  const messageDigest = "requestDigest" in message ? message.requestDigest : message.replayDigest;
  const expiresAtMs = message.message.expiresAtMs;
  const checkedResult = requireReplayResult(result);
  const completion: AuthorityReplayCompleteInput = Object.freeze({
    scope,
    messageDigest,
    resultDigest: exactDigest(checkedResult),
    result: checkedResult,
    expiresAtMs,
    acquisitionId: message.replay.acquisitionId,
  });
  try {
    store.complete(completion);
    const persisted = store.lookup(Object.freeze({ scope, messageDigest }));
    const checked = requireReplayCompletion(persisted, scope, messageDigest, expiresAtMs);
    if (checked.resultDigest !== completion.resultDigest || checked.result !== completion.result) {
      throw new AuthorityProtocolError("replay_cache_unavailable");
    }
    if (message.message.kind === "approval_request") COMPLETED_REQUESTS.add(message);
    return checked;
  } catch (error) {
    if (error instanceof AuthorityProtocolError) throw error;
    throw new AuthorityProtocolError("replay_cache_unavailable");
  }
}

/** Renews a live fenced acquisition; stale owners must be rejected by the store. */
export function renewAuthorityReplayLease(
  store: AuthorityReplayStore,
  message: VerifiedAuthorityApprovalRequest | VerifiedAuthorityIpcResponse,
  nowMs: number
): number {
  if (message.replay.status !== "acquired") {
    throw new AuthorityProtocolError("replayed_message");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  const scope: AuthorityReplayScope = message.message.kind;
  const messageDigest = "requestDigest" in message ? message.requestDigest : message.replayDigest;
  const expiresAtMs = message.message.expiresAtMs;
  const leaseExpiresAtMs = Math.min(expiresAtMs, nowMs + AUTHORITY_REPLAY_LEASE_MS);
  if (leaseExpiresAtMs <= nowMs) throw new AuthorityProtocolError("stale_message");
  const input: AuthorityReplayRenewInput = Object.freeze({
    scope,
    messageDigest,
    acquisitionId: message.replay.acquisitionId,
    nowMs,
    leaseExpiresAtMs,
    expiresAtMs,
  });
  try {
    store.renew(input);
  } catch {
    throw new AuthorityProtocolError("replay_cache_unavailable");
  }
  return leaseExpiresAtMs;
}

export function authorityFactsDigest(facts: AuthorityApprovalFacts): Sha256Digest {
  return domainDigest("sompi:authority-approval-facts:v1", JSON.stringify(canonicalFacts(facts)));
}

export function authorityNonceDigest(nonce: AuthorityNonce): Sha256Digest {
  const canonical = requireNonce(nonce);
  return domainDigest("sompi:authority-nonce:v1", canonical);
}

interface ParsedEnvelope {
  readonly keyId: string;
  readonly mac: string;
  readonly message: unknown;
  readonly wire: string;
}

function sealEnvelope<T extends AuthorityApprovalRequest | AuthorityApprovalResponse>(
  message: T,
  authentication: AuthorityAuthenticationInput
): { readonly wire: string } {
  const keyId = requireKeyId(authentication.keyId, "invalid_configuration");
  requireMacKey(authentication.keyBytes);
  const mac = requireMac(authentication.mac);
  const payload = canonicalAuthenticatedPayload(keyId, message);
  let tag: string;
  try {
    tag = mac.sign(Buffer.from(payload, "utf8"), authentication.keyBytes);
  } catch (error) {
    if (error instanceof AuthorityProtocolError) throw error;
    throw new AuthorityProtocolError("invalid_configuration");
  }
  if (!MAC_PATTERN.test(tag)) throw new AuthorityProtocolError("invalid_configuration");
  return { wire: canonicalEnvelope(keyId, message, tag) };
}

function parseEnvelope(input: string | Uint8Array, expectedKind: AuthorityReplayScope): ParsedEnvelope {
  const wire = requireWire(input);
  let value: unknown;
  try {
    value = JSON.parse(wire);
  } catch {
    throw new AuthorityProtocolError("malformed_message");
  }
  const record = requireRecord(value);
  requireExactKeys(record, ["protocol", "version", "keyId", "algorithm", "message", "mac"]);
  if (record.protocol !== AUTHORITY_IPC_PROTOCOL || record.version !== AUTHORITY_IPC_VERSION) {
    throw new AuthorityProtocolError("unsupported_protocol");
  }
  if (record.algorithm !== AUTHORITY_MAC_ALGORITHM) {
    throw new AuthorityProtocolError("unsupported_protocol");
  }
  const keyId = requireKeyId(requireString(record.keyId), "malformed_message");
  const mac = requireString(record.mac);
  if (!MAC_PATTERN.test(mac)) throw new AuthorityProtocolError("malformed_message");
  const message = requireRecord(record.message);
  if (message.kind !== expectedKind) throw new AuthorityProtocolError("malformed_message");
  return Object.freeze({ keyId, mac, message, wire });
}

function verifyCanonicalEnvelope<T extends AuthorityApprovalRequest | AuthorityApprovalResponse>(
  parsed: ParsedEnvelope,
  message: T,
  verification: AuthorityVerificationInput
): void {
  requireVerificationConfiguration(verification);
  verifyEnvelopeAuthentication(parsed, message, verification);
}

function verifyEnvelopeAuthentication<T extends AuthorityApprovalRequest | AuthorityApprovalResponse>(
  parsed: ParsedEnvelope,
  message: T,
  authentication: AuthorityAuthenticationInput
): void {
  requireKeyId(authentication.keyId, "invalid_configuration");
  requireMacKey(authentication.keyBytes);
  const authenticator = requireMac(authentication.mac);
  const canonical = canonicalEnvelope(parsed.keyId, message, parsed.mac);
  if (canonical !== parsed.wire) throw new AuthorityProtocolError("malformed_message");
  if (parsed.keyId !== authentication.keyId) {
    throw new AuthorityProtocolError("authentication_failed");
  }
  const payload = Buffer.from(canonicalAuthenticatedPayload(parsed.keyId, message), "utf8");
  let verified: boolean;
  try {
    verified = authenticator.verify(payload, parsed.mac, authentication.keyBytes);
  } catch (error) {
    if (error instanceof AuthorityProtocolError) throw error;
    throw new AuthorityProtocolError("invalid_configuration");
  }
  if (!verified) throw new AuthorityProtocolError("authentication_failed");
}

function canonicalAuthenticatedPayload<T extends AuthorityApprovalRequest | AuthorityApprovalResponse>(
  keyId: string,
  message: T
): string {
  return JSON.stringify({
    protocol: AUTHORITY_IPC_PROTOCOL,
    version: AUTHORITY_IPC_VERSION,
    keyId,
    algorithm: AUTHORITY_MAC_ALGORITHM,
    message,
  });
}

function canonicalEnvelope<T extends AuthorityApprovalRequest | AuthorityApprovalResponse>(
  keyId: string,
  message: T,
  mac: string
): string {
  return JSON.stringify({
    protocol: AUTHORITY_IPC_PROTOCOL,
    version: AUTHORITY_IPC_VERSION,
    keyId,
    algorithm: AUTHORITY_MAC_ALGORITHM,
    message,
    mac,
  });
}

function canonicalRequest(candidate: AuthorityApprovalRequest): AuthorityApprovalRequest {
  const record = requireRecord(candidate);
  requireExactKeys(record, [
    "kind",
    "requestId",
    "nonce",
    "issuedAtMs",
    "expiresAtMs",
    "facts",
    "checkoutEvidence",
  ]);
  if (record.kind !== "approval_request") throw new AuthorityProtocolError("malformed_message");
  const issuedAtMs = requireTimestamp(record.issuedAtMs);
  const expiresAtMs = requireTimestamp(record.expiresAtMs);
  if (expiresAtMs <= issuedAtMs) throw new AuthorityProtocolError("malformed_message");
  const facts = canonicalFacts(record.facts as AuthorityApprovalFacts);
  const checkoutEvidence = canonicalCheckoutEvidence(
    record.checkoutEvidence as AuthorityCheckoutEvidence,
    facts
  );
  if (expiresAtMs > strictRfc3339(facts.termsExpiresAt)) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return Object.freeze({
    kind: "approval_request",
    requestId: requireRequestId(requireString(record.requestId)),
    nonce: requireNonce(requireString(record.nonce)),
    issuedAtMs,
    expiresAtMs,
    facts,
    checkoutEvidence,
  });
}

function canonicalCheckoutEvidence(
  candidate: AuthorityCheckoutEvidence,
  facts: AuthorityApprovalFacts
): AuthorityCheckoutEvidence {
  const record = requireRecord(candidate);
  requireExactKeys(record, ["artifact", "digest", "mediaType", "profile", "issuer"]);
  const artifact = requireString(record.artifact);
  if (
    Buffer.byteLength(artifact, "utf8") === 0 ||
    Buffer.byteLength(artifact, "utf8") > AUTHORITY_MAX_CHECKOUT_EVIDENCE_BYTES ||
    !/^[\x21-\x7e]+$/.test(artifact)
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
  const digest = requireDigest(requireString(record.digest));
  const mediaType = requireString(record.mediaType);
  const profile = requireIdentity(requireString(record.profile), 160);
  const issuer = requireIdentity(requireString(record.issuer), 160);
  if (
    mediaType !== "application/jwt" ||
    digest !== exactDigest(artifact) ||
    digest !== facts.checkoutDigest ||
    issuer !== facts.merchantId
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return Object.freeze({ artifact, digest, mediaType, profile, issuer });
}

function canonicalFacts(candidate: AuthorityApprovalFacts): AuthorityApprovalFacts {
  const record = requireRecord(candidate);
  const keys = [
    "purchaseId",
    "merchantId",
    "merchantName",
    "merchantOrigin",
    "resourceUrl",
    "method",
    "requestMediaType",
    "requestBodyDigest",
    "resourceFingerprint",
    "amountAtomic",
    "asset",
    "network",
    "payTo",
    "termsExpiresAt",
    "checkoutDigest",
    "purchaseAuthorizationRequestDigest",
    "purchaseAuthorizationNonceDigest",
    "purchaseAuthorizationFactsDigest",
    "additionalCostCeilingAtomic",
    "effectiveFinalityFloor",
  ];
  requireExactKeys(record, keys);
  const merchantOrigin = requireCanonicalOrigin(requireString(record.merchantOrigin));
  const resourceUrl = requireCanonicalResourceUrl(requireString(record.resourceUrl));
  const method = requireMethod(requireString(record.method));
  const requestMediaType = requireRequestMediaType(requireString(record.requestMediaType));
  const requestBodyDigest = requireDigest(requireString(record.requestBodyDigest));
  const resourceFingerprint = requireDigest(requireString(record.resourceFingerprint));
  if (
    resourceFingerprint !==
    requestFingerprintFromBodyDigest({
      method,
      url: resourceUrl,
      mediaType: requestMediaType || undefined,
      bodyDigest: requestBodyDigest,
    })
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
  const asset = requireIdentity(requireString(record.asset), 64);
  const network = requireIdentity(requireString(record.network), 128);
  const payTo = requireIdentity(requireString(record.payTo), 256);
  if (
    asset !== "KAS" ||
    network !== SUPPORTED_PROTOCOL_PROFILES.x402.network ||
    !isExactKaspaTestnetAddress(payTo)
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
  const base = {
    purchaseId: requirePurchaseId(requireString(record.purchaseId)),
    merchantId: requireIdentity(requireString(record.merchantId), 160),
    merchantName: requireDisplayText(requireString(record.merchantName), 160),
    merchantOrigin,
    resourceUrl,
    method,
    requestMediaType,
    requestBodyDigest,
    resourceFingerprint,
    amountAtomic: requireSafeAp2KasAmount(requireString(record.amountAtomic)),
    asset,
    network,
    payTo,
    termsExpiresAt: requireStrictRfc3339(requireString(record.termsExpiresAt)),
    checkoutDigest: requireDigest(requireString(record.checkoutDigest)),
    purchaseAuthorizationRequestDigest: requireDigest(
      requireString(record.purchaseAuthorizationRequestDigest)
    ),
    purchaseAuthorizationNonceDigest: requireDigest(
      requireString(record.purchaseAuthorizationNonceDigest)
    ),
    purchaseAuthorizationFactsDigest: requireDigest(
      requireString(record.purchaseAuthorizationFactsDigest)
    ),
    additionalCostCeilingAtomic: requireNonNegativeAtomic(
      requireString(record.additionalCostCeilingAtomic)
    ),
    effectiveFinalityFloor: requireFinalityFloor(record.effectiveFinalityFloor),
  };
  return Object.freeze(base);
}

function requireFinalityFloor(value: unknown): "accepted" | "depth-confirmed" {
  if (value !== "accepted" && value !== "depth-confirmed") throw new AuthorityProtocolError("malformed_message");
  return value;
}

function canonicalResponse(
  candidate: AuthorityApprovalResponse,
  request: AuthenticatedAuthorityApprovalRequest
): AuthorityApprovalResponse {
  const record = requireRecord(candidate);
  requireExactKeys(record, [
    "kind",
    "responseId",
    "requestId",
    "purchaseId",
    "checkoutDigest",
    "requestDigest",
    "factsDigest",
    "nonceDigest",
    "respondedAtMs",
    "expiresAtMs",
    "result",
  ]);
  if (record.kind !== "approval_response") throw new AuthorityProtocolError("malformed_message");
  const response: AuthorityApprovalResponse = Object.freeze({
    kind: "approval_response",
    responseId: requireResponseId(requireString(record.responseId)),
    requestId: requireRequestId(requireString(record.requestId)),
    purchaseId: requirePurchaseId(requireString(record.purchaseId)),
    checkoutDigest: requireDigest(requireString(record.checkoutDigest)),
    requestDigest: requireDigest(requireString(record.requestDigest)),
    factsDigest: requireDigest(requireString(record.factsDigest)),
    nonceDigest: requireDigest(requireString(record.nonceDigest)),
    respondedAtMs: requireTimestamp(record.respondedAtMs),
    expiresAtMs: requireTimestamp(record.expiresAtMs),
    result: canonicalResult(record.result as AuthorityApprovalResult),
  });
  const expected = request.message;
  if (
    response.requestId !== expected.requestId ||
    response.purchaseId !== expected.facts.purchaseId ||
    response.checkoutDigest !== expected.facts.checkoutDigest ||
    response.requestDigest !== request.requestDigest ||
    response.factsDigest !== request.factsDigest ||
    response.nonceDigest !== request.nonceDigest
  ) {
    throw new AuthorityProtocolError("binding_mismatch");
  }
  if (
    response.respondedAtMs >= expected.expiresAtMs ||
    response.expiresAtMs <= response.respondedAtMs ||
    response.expiresAtMs > expected.expiresAtMs
  ) {
    throw new AuthorityProtocolError("binding_mismatch");
  }
  return response;
}

function canonicalResult(candidate: AuthorityApprovalResult): AuthorityApprovalResult {
  const record = requireRecord(candidate);
  if (record.decision === "approved") {
    requireExactKeys(record, [
      "decision",
      "authorityId",
      "decisionEvidenceDigest",
      "evidenceVerification",
    ]);
    if (record.evidenceVerification !== AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT) {
      throw new AuthorityProtocolError("malformed_message");
    }
    return Object.freeze({
      decision: "approved",
      authorityId: requireIdentity(requireString(record.authorityId), 160),
      decisionEvidenceDigest: requireDigest(requireString(record.decisionEvidenceDigest)),
      evidenceVerification: AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
    });
  }
  if (record.decision === "denied") {
    requireExactKeys(record, [
      "decision",
      "authorityId",
      "denialCode",
      "decisionEvidenceDigest",
      "evidenceVerification",
    ]);
    const denialCode = requireString(record.denialCode);
    if (!(AUTHORITY_DENIAL_CODES as readonly string[]).includes(denialCode)) {
      throw new AuthorityProtocolError("malformed_message");
    }
    if (record.evidenceVerification !== AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT) {
      throw new AuthorityProtocolError("malformed_message");
    }
    return Object.freeze({
      decision: "denied",
      authorityId: requireIdentity(requireString(record.authorityId), 160),
      denialCode: denialCode as AuthorityDenialCode,
      decisionEvidenceDigest: requireDigest(requireString(record.decisionEvidenceDigest)),
      evidenceVerification: AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
    });
  }
  throw new AuthorityProtocolError("malformed_message");
}

function canonicalVerifiedDecisionEvidence(
  candidate: IndependentlyVerifiedDecisionEvidence
): IndependentlyVerifiedDecisionEvidence {
  try {
    const record = requireRecord(candidate);
    requireExactKeys(record, [
      "decision",
      "authorityId",
      "purchaseId",
      "checkoutDigest",
      "requestDigest",
      "factsDigest",
      "nonceDigest",
      "evidenceDigest",
      "verificationProfile",
      "verifierId",
    ]);
    if (record.decision !== "approved" && record.decision !== "denied") {
      throw new Error("invalid decision");
    }
    return Object.freeze({
      decision: record.decision,
      authorityId: requireIdentity(requireString(record.authorityId), 160),
      purchaseId: requirePurchaseId(requireString(record.purchaseId)),
      checkoutDigest: requireDigest(requireString(record.checkoutDigest)),
      requestDigest: requireDigest(requireString(record.requestDigest)),
      factsDigest: requireDigest(requireString(record.factsDigest)),
      nonceDigest: requireDigest(requireString(record.nonceDigest)),
      evidenceDigest: requireDigest(requireString(record.evidenceDigest)),
      verificationProfile: requireIdentity(requireString(record.verificationProfile), 160),
      verifierId: requireIdentity(requireString(record.verifierId), 160),
    });
  } catch {
    throw new AuthorityProtocolError("evidence_verification_failed");
  }
}

function freezeAuthenticatedRequest(
  keyId: string,
  message: AuthorityApprovalRequest,
  wire: string
): AuthenticatedAuthorityApprovalRequest {
  return Object.freeze({
    keyId,
    message,
    wire,
    requestDigest: exactDigest(wire),
    factsDigest: authorityFactsDigest(message.facts),
    nonceDigest: authorityNonceDigest(message.nonce),
  });
}

function freezeAuthenticatedResponse(
  keyId: string,
  message: AuthorityApprovalResponse,
  wire: string
): AuthenticatedAuthorityApprovalResponse {
  return Object.freeze({ keyId, message, wire, responseDigest: exactDigest(wire) });
}

function assertVerifiedRequest(
  request: VerifiedAuthorityApprovalRequest
): VerifiedAuthorityApprovalRequest {
  assertVerifiedRequestProvenance(request);
  if (request.replay.status !== "acquired" || COMPLETED_REQUESTS.has(request)) {
    throw new AuthorityProtocolError("replayed_message");
  }
  return request;
}

function assertVerifiedRequestProvenance(
  request: VerifiedAuthorityApprovalRequest
): VerifiedAuthorityApprovalRequest {
  if (!request || !VERIFIED_REQUESTS.has(request)) {
    throw new AuthorityProtocolError("authentication_failed");
  }
  assertAuthenticatedRequestShape(request);
  return request;
}

function assertAuthenticatedRequestShape(
  request: AuthenticatedAuthorityApprovalRequest
): AuthenticatedAuthorityApprovalRequest {
  try {
    const message = canonicalRequest(request.message);
    const parsed = parseEnvelope(request.wire, "approval_request");
    const wireMessage = canonicalRequest(parsed.message as AuthorityApprovalRequest);
    if (
      parsed.keyId !== request.keyId ||
      canonicalEnvelope(parsed.keyId, wireMessage, parsed.mac) !== parsed.wire ||
      JSON.stringify(wireMessage) !== JSON.stringify(message) ||
      request.requestDigest !== exactDigest(request.wire) ||
      request.factsDigest !== authorityFactsDigest(message.facts) ||
      request.nonceDigest !== authorityNonceDigest(message.nonce)
    ) {
      throw new AuthorityProtocolError("binding_mismatch");
    }
  } catch {
    throw new AuthorityProtocolError("binding_mismatch");
  }
  return request;
}

function requestFreshness(
  request: AuthorityApprovalRequest,
  verification: AuthorityVerificationInput
): { readonly nowMs: number; readonly aged: boolean } {
  const now = requireNow(verification.now);
  const limits = freshnessLimits(verification.freshness);
  if (
    request.issuedAtMs > now + limits.maxClockSkewMs ||
    request.expiresAtMs <= now ||
    request.expiresAtMs - request.issuedAtMs > limits.maxRequestLifetimeMs
  ) {
    throw new AuthorityProtocolError("stale_message");
  }
  return Object.freeze({
    nowMs: now,
    aged: request.issuedAtMs < now - limits.maxRequestAgeMs - limits.maxClockSkewMs,
  });
}

function assertResponseFreshness(
  response: AuthorityApprovalResponse,
  request: AuthorityApprovalRequest,
  verification: AuthorityVerificationInput
): number {
  const now = requireNow(verification.now);
  const limits = freshnessLimits(verification.freshness);
  if (
    response.respondedAtMs > now + limits.maxClockSkewMs ||
    response.respondedAtMs < now - limits.maxResponseAgeMs - limits.maxClockSkewMs ||
    response.respondedAtMs < request.issuedAtMs - limits.maxClockSkewMs ||
    response.expiresAtMs <= now ||
    response.expiresAtMs - response.respondedAtMs > limits.maxResponseLifetimeMs
  ) {
    throw new AuthorityProtocolError("stale_message");
  }
  return now;
}

function freshnessLimits(candidate?: Partial<AuthorityFreshnessLimits>): AuthorityFreshnessLimits {
  const merged = { ...DEFAULT_AUTHORITY_FRESHNESS_LIMITS, ...candidate };
  for (const value of Object.values(merged)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AuthorityProtocolError("invalid_configuration");
    }
  }
  if (
    merged.maxRequestAgeMs === 0 ||
    merged.maxRequestLifetimeMs === 0 ||
    merged.maxResponseAgeMs === 0 ||
    merged.maxResponseLifetimeMs === 0
  ) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  return Object.freeze(merged);
}

function requireVerificationConfiguration(verification: AuthorityVerificationInput): void {
  requireKeyId(verification.keyId, "invalid_configuration");
  requireMacKey(verification.keyBytes);
  requireMac(verification.mac);
  if (
    !verification.replayStore ||
    typeof verification.replayStore.acquire !== "function" ||
    typeof verification.replayStore.renew !== "function" ||
    typeof verification.replayStore.lookup !== "function" ||
    typeof verification.replayStore.complete !== "function"
  ) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  if (typeof verification.now !== "function") {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  freshnessLimits(verification.freshness);
}

function acquireReplay(
  store: AuthorityReplayStore,
  scope: AuthorityReplayScope,
  messageDigest: Sha256Digest,
  tokenDigests: readonly Sha256Digest[],
  nowMs: number,
  expiresAtMs: number
): AuthorityReplayDisposition {
  if (tokenDigests.length === 0 || new Set(tokenDigests).size !== tokenDigests.length) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  const leaseExpiresAtMs = Math.min(expiresAtMs, nowMs + AUTHORITY_REPLAY_LEASE_MS);
  if (leaseExpiresAtMs <= nowMs) throw new AuthorityProtocolError("stale_message");
  let acquisition: AuthorityReplayAcquireResult;
  try {
    acquisition = store.acquire(
      Object.freeze({
        scope,
        messageDigest,
        tokenDigests: Object.freeze([...tokenDigests]),
        nowMs,
        leaseExpiresAtMs,
        expiresAtMs,
      })
    );
  } catch {
    throw new AuthorityProtocolError("replay_cache_unavailable");
  }
  if (acquisition?.status === "conflict") {
    throw new AuthorityProtocolError("replayed_message");
  }
  if (acquisition?.status === "acquired") {
    if (acquisition.leaseExpiresAtMs !== leaseExpiresAtMs) {
      throw new AuthorityProtocolError("replay_cache_unavailable");
    }
    return Object.freeze({
      status: "acquired",
      acquisitionId: requireAcquisitionId(acquisition.acquisitionId),
      leaseExpiresAtMs,
    });
  }
  if (acquisition?.status === "existing") {
    let persisted: AuthorityReplayCompletion | undefined;
    try {
      persisted = store.lookup(Object.freeze({ scope, messageDigest }));
    } catch {
      throw new AuthorityProtocolError("replay_cache_unavailable");
    }
    if (persisted !== undefined) {
      const completion = requireReplayCompletion(persisted, scope, messageDigest, expiresAtMs);
      return Object.freeze({
        status: "completed",
        resultDigest: completion.resultDigest,
        result: completion.result,
      });
    }
    if (
      !Number.isSafeInteger(acquisition.leaseExpiresAtMs) ||
      acquisition.leaseExpiresAtMs <= nowMs ||
      acquisition.leaseExpiresAtMs > expiresAtMs
    ) {
      throw new AuthorityProtocolError("replay_cache_unavailable");
    }
    if (persisted === undefined) {
      return Object.freeze({
        status: "in_progress",
        leaseExpiresAtMs: acquisition.leaseExpiresAtMs,
      });
    }
  }
  throw new AuthorityProtocolError("replay_cache_unavailable");
}

function lookupCompletedReplay(
  store: AuthorityReplayStore,
  scope: AuthorityReplayScope,
  messageDigest: Sha256Digest,
  expiresAtMs: number
): AuthorityReplayDisposition | undefined {
  let persisted: AuthorityReplayCompletion | undefined;
  try {
    persisted = store.lookup(Object.freeze({ scope, messageDigest }));
  } catch {
    throw new AuthorityProtocolError("replay_cache_unavailable");
  }
  if (persisted === undefined) return undefined;
  const completion = requireReplayCompletion(persisted, scope, messageDigest, expiresAtMs);
  return Object.freeze({
    status: "completed",
    resultDigest: completion.resultDigest,
    result: completion.result,
  });
}

function requireReplayCompletion(
  candidate: AuthorityReplayCompletion | undefined,
  scope: AuthorityReplayScope,
  messageDigest: Sha256Digest,
  expiresAtMs: number
): AuthorityReplayCompletion {
  try {
    if (!candidate || candidate.scope !== scope || candidate.messageDigest !== messageDigest) {
      throw new Error("invalid replay completion");
    }
    const result = requireReplayResult(candidate.result);
    const resultDigest = requireDigest(candidate.resultDigest);
    if (
      resultDigest !== exactDigest(result) ||
      candidate.expiresAtMs !== expiresAtMs
    ) {
      throw new Error("invalid replay completion");
    }
    return Object.freeze({ scope, messageDigest, resultDigest, result, expiresAtMs });
  } catch {
    throw new AuthorityProtocolError("replay_cache_unavailable");
  }
}

function requireReplayResult(value: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > AUTHORITY_MAX_REPLAY_RESULT_BYTES
  ) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  return value;
}

function requireAcquisitionId(value: string): string {
  if (typeof value !== "string" || !ACQUISITION_ID_PATTERN.test(value)) {
    throw new AuthorityProtocolError("replay_cache_unavailable");
  }
  return value;
}

function replayToken(
  scope: AuthorityReplayScope,
  identity: string,
  keyId: string,
  value: string
): Sha256Digest {
  return domainDigest(`sompi:authority-replay:${scope}:${identity}:v1`, `${keyId}\0${value}`);
}

function requireMac(candidate?: AuthorityMac): AuthorityMac {
  const mac: unknown = candidate === undefined ? HMAC_SHA256_AUTHORITY_MAC : candidate;
  if (
    mac === null ||
    (typeof mac !== "object" && typeof mac !== "function") ||
    (mac as Partial<AuthorityMac>).algorithm !== AUTHORITY_MAC_ALGORITHM ||
    typeof (mac as Partial<AuthorityMac>).sign !== "function" ||
    typeof (mac as Partial<AuthorityMac>).verify !== "function"
  ) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  return mac as AuthorityMac;
}

function requireMacKey(keyBytes: Uint8Array): void {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength !== AUTHORITY_MAC_KEY_BYTES) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
}

function requireEntropy(entropy: Uint8Array, expectedBytes: number): void {
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== expectedBytes) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
}

function requireWire(input: string | Uint8Array): string {
  let bytes: Buffer;
  if (typeof input === "string") bytes = Buffer.from(input, "utf8");
  else if (input instanceof Uint8Array) bytes = Buffer.from(input);
  else throw new AuthorityProtocolError("malformed_message");
  if (bytes.byteLength === 0 || bytes.byteLength > AUTHORITY_MAX_WIRE_BYTES) {
    throw new AuthorityProtocolError("malformed_message");
  }
  const wire = bytes.toString("utf8");
  if (!Buffer.from(wire, "utf8").equals(bytes)) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return wire;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityProtocolError("malformed_message");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Reflect.ownKeys(record);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== "string") ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new AuthorityProtocolError("malformed_message");
  return value;
}

function requireRequestId(value: string): AuthorityRequestId {
  if (!REQUEST_ID_PATTERN.test(value) || !hasCanonicalSuffix(value.slice(4), AUTHORITY_MESSAGE_ID_BYTES)) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value as AuthorityRequestId;
}

function requireResponseId(value: string): AuthorityResponseId {
  if (!RESPONSE_ID_PATTERN.test(value) || !hasCanonicalSuffix(value.slice(4), AUTHORITY_MESSAGE_ID_BYTES)) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value as AuthorityResponseId;
}

function requireNonce(value: string): AuthorityNonce {
  if (!NONCE_PATTERN.test(value) || !hasCanonicalSuffix(value, AUTHORITY_NONCE_BYTES)) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value as AuthorityNonce;
}

function hasCanonicalSuffix(value: string, expectedBytes: number): boolean {
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === expectedBytes && decoded.toString("base64url") === value;
}

function requirePurchaseId(value: string): PurchaseId {
  try {
    return assertPurchaseId(value);
  } catch {
    throw new AuthorityProtocolError("malformed_message");
  }
}

function requireKeyId(value: string, code: AuthorityProtocolErrorCode): string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) throw new AuthorityProtocolError(code);
  return value;
}

function requireIdentity(value: string, maximumLength: number): string {
  if (value.length === 0 || value.length > maximumLength || !IDENTITY_PATTERN.test(value)) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value;
}

function requireDisplayText(value: string, maximumLength: number): string {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    UNSAFE_DISPLAY_PATTERN.test(value)
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value;
}

function requireCanonicalOrigin(value: string): string {
  if (value.length === 0 || value.length > 256) throw new AuthorityProtocolError("malformed_message");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AuthorityProtocolError("malformed_message");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.origin !== value
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value;
}

function requireCanonicalResourceUrl(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new AuthorityProtocolError("malformed_message");
  }
  let canonical: string;
  try {
    canonical = canonicalRequestUrl(value);
  } catch {
    throw new AuthorityProtocolError("malformed_message");
  }
  if (canonical !== value) throw new AuthorityProtocolError("malformed_message");
  return value;
}

function requireMethod(value: string): string {
  if (!METHOD_PATTERN.test(value)) throw new AuthorityProtocolError("malformed_message");
  return value;
}

function requireRequestMediaType(value: string): string {
  if (value === "") return value;
  let canonical: string | undefined;
  try {
    canonical = canonicalMediaType(value);
  } catch {
    throw new AuthorityProtocolError("malformed_message");
  }
  if (canonical !== value) throw new AuthorityProtocolError("malformed_message");
  return value;
}

function requireDigest(value: string): Sha256Digest {
  if (!DIGEST_PATTERN.test(value)) throw new AuthorityProtocolError("malformed_message");
  const encoded = value.slice("sha256:".length);
  if (!hasCanonicalSuffix(encoded, 32)) throw new AuthorityProtocolError("malformed_message");
  return value as Sha256Digest;
}

function requirePositiveAtomic(value: string): string {
  if (!POSITIVE_ATOMIC_PATTERN.test(value) || value.length > 78) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value;
}

function requireSafeAp2KasAmount(value: string): string {
  requirePositiveAtomic(value);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || String(amount) !== value) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value;
}

function isExactKaspaTestnetAddress(value: string): boolean {
  if (!value.startsWith("kaspatest:")) return false;
  try {
    return Address.validate(value);
  } catch {
    return false;
  }
}

function requireNonNegativeAtomic(value: string): string {
  if (!NON_NEGATIVE_ATOMIC_PATTERN.test(value) || value.length > 78) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value;
}

function requireStrictRfc3339(value: string): string {
  const timestamp = strictRfc3339(value);
  if (new Date(timestamp).toISOString() !== value) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value;
}

function strictRfc3339(value: string): number {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) throw new AuthorityProtocolError("malformed_message");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new AuthorityProtocolError("malformed_message");
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return timestamp;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function requireTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AuthorityProtocolError("malformed_message");
  }
  return value as number;
}

function requireNow(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AuthorityProtocolError("invalid_configuration");
  }
  return value;
}

function exactDigest(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}` as Sha256Digest;
}

function exactBytesDigest(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

function authorityDecisionReplayDigest(message: AuthorityApprovalResponse): Sha256Digest {
  return domainDigest(
    "sompi:authority-decision-replay:v1",
    JSON.stringify({
      requestDigest: message.requestDigest,
      factsDigest: message.factsDigest,
      decision: message.result.decision,
      authorityId: message.result.authorityId,
      decisionEvidenceDigest: message.result.decisionEvidenceDigest,
    })
  );
}

function domainDigest(domain: string, value: string): Sha256Digest {
  const hash = createHash("sha256");
  const domainBytes = Buffer.from(domain, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(domainBytes.byteLength);
  hash.update(length).update(domainBytes);
  length.writeUInt32BE(valueBytes.byteLength);
  hash.update(length).update(valueBytes);
  length.fill(0);
  return `sha256:${hash.digest("base64url")}` as Sha256Digest;
}

const REQUEST_ID_PATTERN = /^arq_[A-Za-z0-9_-]{22}$/;
const RESPONSE_ID_PATTERN = /^ars_[A-Za-z0-9_-]{22}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ACQUISITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const POSITIVE_ATOMIC_PATTERN = /^[1-9][0-9]*$/;
const NON_NEGATIVE_ATOMIC_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const UNSAFE_DISPLAY_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
