import { createHash } from "node:crypto";

import type { Sha256Digest } from "../purchase/types.js";
import type { AuthorityAuthenticationProvider } from "./key-provider.js";
import type {
  AuthorityDecisionStore,
  StoredAuthorityDecision,
} from "./decision-store.js";
import {
  AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
  AUTHORITY_MAX_DECISION_EVIDENCE_BYTES,
  AUTHORITY_REPLAY_LEASE_MS,
  DEFAULT_AUTHORITY_FRESHNESS_LIMITS,
  AuthorityProtocolError,
  bindAuthorityApprovalResponse,
  createAuthorityResponseId,
  parseAuthorityApprovalRequest,
  recoverAuthorityApprovalResponse,
  renewAuthorityReplayLease,
  sealAuthorityApprovalResponse,
  type AuthorityApprovalResult,
  type AuthorityDenialCode,
  type AuthorityReplayStore,
  type VerifiedAuthorityApprovalRequest,
} from "./protocol.js";

export type AuthorityServiceErrorCode =
  | "busy"
  | "stale"
  | "decision_invalid"
  | "evidence_unavailable"
  | "unavailable";

const ERROR_MESSAGES: Readonly<Record<AuthorityServiceErrorCode, string>> = Object.freeze({
  busy: "authority request is already being handled",
  stale: "authority request expired during approval",
  decision_invalid: "authority decision is invalid",
  evidence_unavailable: "authority decision evidence is unavailable",
  unavailable: "authority service is unavailable",
});

export class AuthorityServiceError extends Error {
  readonly code: AuthorityServiceErrorCode;

  constructor(code: AuthorityServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AuthorityServiceError";
    this.code = code;
  }
}

export type AuthorityHumanDecision =
  | Readonly<{
      decision: "approved";
      authorityId: string;
      signedEvidence: Uint8Array;
    }>
  | Readonly<{
      decision: "denied";
      authorityId: string;
      denialCode: AuthorityDenialCode;
      signedEvidence: Uint8Array;
    }>;

export interface AuthorityHumanDecisionContext {
  readonly request: VerifiedAuthorityApprovalRequest;
  /** True only when a prior worker died without persisting a decision. */
  readonly recoveryRetry: boolean;
  /** Explicit heartbeat for long-running deterministic UI/signing adapters. */
  renewLease(): void;
  readonly signal: AbortSignal;
}

export interface AuthorityHumanDecisionProvider {
  decide(context: AuthorityHumanDecisionContext): Promise<AuthorityHumanDecision>;
}

export interface AuthorityServiceFaultInjector {
  (point: "after_decision_persisted"): void;
}

export interface AuthorityServiceOptions {
  readonly replayStore: AuthorityReplayStore;
  readonly decisionStore: AuthorityDecisionStore;
  readonly authenticationProvider: AuthorityAuthenticationProvider;
  readonly humanDecision: AuthorityHumanDecisionProvider;
  readonly now?: () => number;
  readonly responseTtlMs?: number;
  readonly leaseHeartbeatMs?: number;
  readonly faultInjector?: AuthorityServiceFaultInjector;
  /** Manifest projection in production; explicit values are used by hermetic tests. */
  readonly admission?: Readonly<{ authorityPrompts: number }>;
  readonly maxHumanDecisionMs?: number;
}

export interface AuthorityServiceDecisionResponse {
  readonly responseWire: string;
  readonly decisionEvidence: Uint8Array;
}

/**
 * Deterministic authority orchestration. UI and signing remain injected.
 * Signed evidence is durably persisted and read back before response sealing;
 * completed request retries only reissue fresh authenticated transport.
 */
export class AuthorityService {
  private readonly now: () => number;
  private readonly responseTtlMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly promptCapacity: number;
  private readonly maxHumanDecisionMs: number;
  private readonly shutdownController = new AbortController();
  private activePrompts = 0;

  constructor(private readonly options: AuthorityServiceOptions) {
    if (
      !options.replayStore ||
      !options.decisionStore ||
      !options.authenticationProvider ||
      !options.humanDecision ||
      typeof options.humanDecision.decide !== "function"
    ) {
      throw new AuthorityServiceError("unavailable");
    }
    this.now = options.now ?? Date.now;
    this.responseTtlMs = options.responseTtlMs ?? 20_000;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? 5_000;
    this.promptCapacity = requirePromptCapacity(options.admission?.authorityPrompts ?? 4);
    this.maxHumanDecisionMs = requireHumanDecisionTimeout(options.maxHumanDecisionMs ?? 120_000);
    if (
      !Number.isSafeInteger(this.responseTtlMs) ||
      this.responseTtlMs <= 0 ||
      this.responseTtlMs > DEFAULT_AUTHORITY_FRESHNESS_LIMITS.maxResponseLifetimeMs ||
      !Number.isSafeInteger(this.leaseHeartbeatMs) ||
      this.leaseHeartbeatMs <= 0 ||
      this.leaseHeartbeatMs >= AUTHORITY_REPLAY_LEASE_MS
    ) {
      throw new AuthorityServiceError("unavailable");
    }
  }

  async handle(authenticatedRequestWire: string): Promise<string> {
    return (await this.handleDecision(authenticatedRequestWire)).responseWire;
  }

  close(): void {
    this.shutdownController.abort();
  }

  admissionStatus(): Readonly<{ activePrompts: number; budget: number; saturated: boolean }> {
    return Object.freeze({
      activePrompts: this.activePrompts,
      budget: this.promptCapacity,
      saturated: this.activePrompts >= this.promptCapacity,
    });
  }

  async handleDecision(
    authenticatedRequestWire: string,
    transportSignal?: AbortSignal,
  ): Promise<AuthorityServiceDecisionResponse> {
    try {
      return await this.options.authenticationProvider.withAuthentication(async (authentication) => {
        // Reserve the bounded human-work slot before parsing can acquire any
        // durable replay rows. A saturated authenticated flood therefore has
        // no durable replay side effect.
        if (this.activePrompts >= this.promptCapacity) {
          throw new AuthorityServiceError("busy");
        }
        this.activePrompts += 1;
        try {
          const request = parseAuthorityApprovalRequest(authenticatedRequestWire, {
            ...authentication,
            replayStore: this.options.replayStore,
            now: this.now,
          });

          if (request.replay.status === "in_progress") {
            throw new AuthorityServiceError("busy");
          }
          if (request.replay.status === "completed") {
            const persisted = this.requirePersistedDecision(request);
            const now = this.timestamp();
            const response = recoverAuthorityApprovalResponse(
              request,
              {
                responseId: createAuthorityResponseId(),
                respondedAtMs: now,
                expiresAtMs: responseExpiry(now, request.message.expiresAtMs, this.responseTtlMs),
              },
              authentication
            );
            assertResponseMatchesDecision(response.message.result, persisted);
            return decisionResponse(response.wire, persisted);
          }

          let persisted = this.options.decisionStore.find(request.requestDigest);
          if (persisted) {
            assertDecisionMatchesRequest(persisted, request);
          } else {
            const human = await this.collectHumanDecision(request, transportSignal);
            this.assertTransportActive(request, transportSignal);
            const now = this.timestamp();
            persisted = this.options.decisionStore.persist(
              storedDecisionFromHuman(request, human, now)
            );
            if (this.isTransportAborted(transportSignal)) {
              this.options.decisionStore.discard?.(request.requestDigest);
              this.assertTransportActive(request, transportSignal);
            }
            assertDecisionMatchesRequest(persisted, request);
            this.options.faultInjector?.("after_decision_persisted");
          }

          this.assertTransportActive(request, transportSignal);
          const respondedAtMs = this.timestamp();
          const response = bindAuthorityApprovalResponse(request, {
            responseId: createAuthorityResponseId(),
            respondedAtMs,
            expiresAtMs: responseExpiry(
              respondedAtMs,
              request.message.expiresAtMs,
              this.responseTtlMs
            ),
            result: resultFromStoredDecision(persisted),
          });
          this.assertTransportActive(request, transportSignal);
          const sealed = sealAuthorityApprovalResponse(response, request, authentication).wire;
          this.assertTransportActive(request, transportSignal);
          return decisionResponse(sealed, persisted);
        } finally {
          this.activePrompts -= 1;
        }
      });
    } catch (error) {
      if (error instanceof AuthorityServiceError || error instanceof AuthorityProtocolError) {
        throw error;
      }
      throw new AuthorityServiceError("unavailable");
    }
  }

  private async collectHumanDecision(
    request: VerifiedAuthorityApprovalRequest,
    transportSignal?: AbortSignal,
  ): Promise<AuthorityHumanDecision> {
    let heartbeatError: AuthorityServiceError | undefined;
    const leaseController = new AbortController();
    const now = this.timestamp();
    const remainingMs = request.message.expiresAtMs - now;
    if (remainingMs <= 0) throw new AuthorityServiceError("stale");
    const decisionTimeoutMs = Math.min(this.maxHumanDecisionMs, remainingMs);
    const expiryTimer = setTimeout(() => leaseController.abort(), decisionTimeoutMs);
    expiryTimer.unref();
    const signal = AbortSignal.any([
      this.shutdownController.signal,
      leaseController.signal,
      ...(transportSignal ? [transportSignal] : []),
    ]);
    const renew = () => {
      if (heartbeatError) throw heartbeatError;
      try {
        renewAuthorityReplayLease(this.options.replayStore, request, this.timestamp());
      } catch {
        heartbeatError = new AuthorityServiceError("unavailable");
        leaseController.abort();
        throw heartbeatError;
      }
    };
    const timer = setInterval(() => {
      try {
        renew();
      } catch {
        // The awaited decision is allowed to finish, but is discarded below.
      }
    }, this.leaseHeartbeatMs);
    timer.unref();
    try {
      const decision = await this.options.humanDecision.decide(
        Object.freeze({
          request,
          recoveryRetry: request.acceptedAtMs > request.message.issuedAtMs + this.leaseHeartbeatMs,
          renewLease: renew,
          signal,
        })
      );
      if (heartbeatError) throw heartbeatError;
      if (signal.aborted) {
        throw new AuthorityServiceError(
          this.timestamp() >= request.message.expiresAtMs ? "stale" : "unavailable"
        );
      }
      validateHumanDecision(decision);
      return Object.freeze({
        ...decision,
        signedEvidence: Uint8Array.from(decision.signedEvidence),
      }) as AuthorityHumanDecision;
    } catch (error) {
      if (signal.aborted) {
        if (heartbeatError) throw heartbeatError;
        throw new AuthorityServiceError(
          this.timestamp() >= request.message.expiresAtMs ? "stale" : "unavailable"
        );
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "busy"
      ) {
        throw new AuthorityServiceError("busy");
      }
      if (error instanceof AuthorityServiceError) throw error;
      throw new AuthorityServiceError("decision_invalid");
    } finally {
      clearInterval(timer);
      clearTimeout(expiryTimer);
    }
  }

  private requirePersistedDecision(
    request: VerifiedAuthorityApprovalRequest
  ): StoredAuthorityDecision {
    const persisted = this.options.decisionStore.find(request.requestDigest);
    if (!persisted) throw new AuthorityServiceError("evidence_unavailable");
    assertDecisionMatchesRequest(persisted, request);
    return persisted;
  }

  private timestamp(): number {
    let value: number;
    try {
      value = this.now();
    } catch {
      throw new AuthorityServiceError("unavailable");
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AuthorityServiceError("unavailable");
    }
    return value;
  }

  private isTransportAborted(transportSignal?: AbortSignal): boolean {
    return this.shutdownController.signal.aborted || transportSignal?.aborted === true;
  }

  private assertTransportActive(
    request: VerifiedAuthorityApprovalRequest,
    transportSignal?: AbortSignal,
  ): void {
    if (!this.isTransportAborted(transportSignal)) return;
    throw new AuthorityServiceError(
      this.timestamp() >= request.message.expiresAtMs ? "stale" : "unavailable"
    );
  }
}

function decisionResponse(
  responseWire: string,
  decision: StoredAuthorityDecision
): AuthorityServiceDecisionResponse {
  assertEvidenceDigest(decision);
  return Object.freeze({
    responseWire,
    decisionEvidence: Uint8Array.from(decision.evidence),
  });
}

function assertEvidenceDigest(decision: StoredAuthorityDecision): void {
  if (digestBytes(decision.evidence) !== decision.evidenceDigest) {
    throw new AuthorityServiceError("evidence_unavailable");
  }
}

function storedDecisionFromHuman(
  request: VerifiedAuthorityApprovalRequest,
  human: AuthorityHumanDecision,
  createdAtMs: number
): StoredAuthorityDecision {
  const evidence = Uint8Array.from(human.signedEvidence);
  return Object.freeze({
    requestDigest: request.requestDigest,
    factsDigest: request.factsDigest,
    nonceDigest: request.nonceDigest,
    purchaseId: request.message.facts.purchaseId,
    checkoutDigest: request.message.facts.checkoutDigest,
    decision: human.decision,
    authorityId: human.authorityId,
    ...(human.decision === "denied" ? { denialCode: human.denialCode } : {}),
    evidenceDigest: digestBytes(evidence),
    evidence,
    createdAtMs,
  });
}

function resultFromStoredDecision(decision: StoredAuthorityDecision): AuthorityApprovalResult {
  return decision.decision === "approved"
    ? Object.freeze({
        decision: "approved",
        authorityId: decision.authorityId,
        decisionEvidenceDigest: decision.evidenceDigest,
        evidenceVerification: AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
      })
    : Object.freeze({
        decision: "denied",
        authorityId: decision.authorityId,
        denialCode: decision.denialCode!,
        decisionEvidenceDigest: decision.evidenceDigest,
        evidenceVerification: AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
      });
}

function assertDecisionMatchesRequest(
  decision: StoredAuthorityDecision,
  request: VerifiedAuthorityApprovalRequest
): void {
  if (
    decision.requestDigest !== request.requestDigest ||
    decision.factsDigest !== request.factsDigest ||
    decision.nonceDigest !== request.nonceDigest ||
    decision.purchaseId !== request.message.facts.purchaseId ||
    decision.checkoutDigest !== request.message.facts.checkoutDigest ||
    digestBytes(decision.evidence) !== decision.evidenceDigest
  ) {
    throw new AuthorityServiceError("evidence_unavailable");
  }
}

function assertResponseMatchesDecision(
  result: AuthorityApprovalResult,
  decision: StoredAuthorityDecision
): void {
  if (
    result.decision !== decision.decision ||
    result.authorityId !== decision.authorityId ||
    result.decisionEvidenceDigest !== decision.evidenceDigest ||
    (result.decision === "denied" && result.denialCode !== decision.denialCode)
  ) {
    throw new AuthorityServiceError("evidence_unavailable");
  }
}

function validateHumanDecision(decision: AuthorityHumanDecision): void {
  if (
    !decision ||
    (decision.decision !== "approved" && decision.decision !== "denied") ||
    typeof decision.authorityId !== "string" ||
    decision.authorityId.length === 0 ||
    decision.authorityId.length > 160 ||
    !(decision.signedEvidence instanceof Uint8Array) ||
    decision.signedEvidence.byteLength === 0 ||
    decision.signedEvidence.byteLength > AUTHORITY_MAX_DECISION_EVIDENCE_BYTES ||
    (decision.decision === "denied" &&
      decision.denialCode !== "user_denied" &&
      decision.denialCode !== "terms_expired")
  ) {
    throw new AuthorityServiceError("decision_invalid");
  }
}

function responseExpiry(now: number, requestExpiry: number, ttlMs: number): number {
  const expiresAtMs = Math.min(requestExpiry, now + ttlMs);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
    throw new AuthorityServiceError("stale");
  }
  return expiresAtMs;
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

function requirePromptCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 128) {
    throw new AuthorityServiceError("unavailable");
  }
  return value;
}

function requireHumanDecisionTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 5 * 60_000) {
    throw new AuthorityServiceError("unavailable");
  }
  return value;
}
