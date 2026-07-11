import { createHash } from "node:crypto";

import {
  createAuthorityNonce,
  createAuthorityRequestId,
  parseAuthorityApprovalResponse,
  sealAuthorityApprovalRequest,
  verifyAuthorityDecisionEvidence,
  type AuthorityAuthenticationInput,
  type AuthorityReplayStore,
  type VerifiedAuthorityDecision,
} from "../../authority/protocol.js";
import type { AuthorityAuthenticationProvider } from "../../authority/key-provider.js";
import {
  authorizationFacts,
  authorizationFactsDigest,
  type PurchaseAuthorizationRequest,
} from "../../purchase/contracts.js";
import type {
  AuthorityModule,
  AuthorityResult,
  VerifiedArtifact,
} from "../../purchase/coordinator.js";
import {
  canonicalMediaType,
  evidenceDigest,
} from "../../purchase/identity.js";
import type { Sha256Digest } from "../../purchase/types.js";
import {
  Ap2AuthorityDecisionEvidenceVerifier,
  SOMPI_AP2_AUTHORITY_DECISION_PROFILE,
} from "./authority-decision.js";
import { AP2_HUMAN_PRESENT_PROFILE } from "./types.js";

export const AP2_AUTHORITY_REQUEST_TTL_MS = 120_000;
const CHECKOUT_MEDIA_TYPE = "application/jwt";
const DECISION_MEDIA_TYPE = "application/jwt";
const MANDATE_MEDIA_TYPE = "application/sd-jwt";

export interface AuthorityDecisionTransportResult {
  readonly responseWire: string;
  readonly decisionEvidence: Uint8Array;
}

export interface AuthorityDecisionTransport {
  request(authenticatedRequestWire: string): Promise<AuthorityDecisionTransportResult>;
}

export interface Ap2AuthorityModuleOptions {
  readonly authenticationProvider: AuthorityAuthenticationProvider;
  readonly replayStore: AuthorityReplayStore;
  readonly transport: AuthorityDecisionTransport;
  readonly verifier: Ap2AuthorityDecisionEvidenceVerifier;
  readonly now?: () => number;
  readonly requestTtlMs?: number;
}

/** MCP-side AP2 authorization adapter. It owns no authority signing key. */
export class Ap2AuthorityModule implements AuthorityModule {
  private readonly now: () => number;
  private readonly requestTtlMs: number;

  constructor(private readonly options: Ap2AuthorityModuleOptions) {
    if (
      !options.authenticationProvider ||
      !options.replayStore ||
      !options.transport ||
      typeof options.transport.request !== "function" ||
      !options.verifier
    ) {
      throw new Error("AP2 authority module configuration is incomplete");
    }
    this.now = options.now ?? Date.now;
    this.requestTtlMs = options.requestTtlMs ?? AP2_AUTHORITY_REQUEST_TTL_MS;
    if (!Number.isSafeInteger(this.requestTtlMs) || this.requestTtlMs <= 0) {
      throw new Error("AP2 authority request TTL is invalid");
    }
  }

  async request(input: Parameters<AuthorityModule["request"]>[0]): Promise<AuthorityResult> {
    const nowMs = this.timestamp();
    const issuedAtMs = input.request.createdAtMs;
    const expiresAtMs = Math.min(
      input.request.expiresAtMs,
      issuedAtMs + this.requestTtlMs,
    );
    if (expiresAtMs <= issuedAtMs || expiresAtMs <= nowMs) {
      throw new Error("Checkout Terms expired before authority approval");
    }
    const checkoutEvidence = canonicalCheckoutEvidence(input.checkoutEvidence);
    const facts = authorityFacts(input.request);

    return this.options.authenticationProvider.withAuthentication(async (authentication) => {
      const sealed = sealAuthorityApprovalRequest({
        kind: "approval_request",
        requestId: createAuthorityRequestId(
          deterministicTransportBytes(
            "request-id",
            input.request.requestDigest,
            input.request.nonceDigest,
            16,
          ),
        ),
        nonce: createAuthorityNonce(
          deterministicTransportBytes(
            "nonce",
            input.request.requestDigest,
            input.request.nonceDigest,
            32,
          ),
        ),
        issuedAtMs,
        expiresAtMs,
        facts,
        checkoutEvidence,
      }, authentication);
      const transported = await this.options.transport.request(sealed.wire);
      validateTransportResult(transported);
      const ipc = parseAuthorityApprovalResponse(
        transported.responseWire,
        sealed,
        verification(authentication, this.options.replayStore, this.now),
      );
      const decision = await verifyAuthorityDecisionEvidence(
        ipc,
        sealed,
        transported.decisionEvidence,
        this.options.verifier,
      );
      const supportingEvidence = await supportingAp2Evidence(
        this.options.verifier,
        decision,
        transported.decisionEvidence,
      );
      return Object.freeze({
        status: "decision" as const,
        decision,
        decisionEvidenceBytes: Uint8Array.from(transported.decisionEvidence),
        decisionEvidenceMediaType: DECISION_MEDIA_TYPE,
        decisionEvidenceIssuer: decision.evidence.authorityId,
        ...(supportingEvidence.length > 0 ? { supportingEvidence } : {}),
      });
    });
  }

  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new Error("authority clock is unavailable");
    }
    return now;
  }
}

function deterministicTransportBytes(
  purpose: "request-id" | "nonce",
  requestDigest: string,
  nonceDigest: string,
  length: 16 | 32,
): Uint8Array {
  const digest = createHash("sha256")
    .update("sompi:authority-transport:v1\0", "utf8")
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(requestDigest, "utf8")
    .update("\0", "utf8")
    .update(nonceDigest, "utf8")
    .digest();
  return Uint8Array.from(digest.subarray(0, length));
}

function authorityFacts(request: PurchaseAuthorizationRequest) {
  const canonical = authorizationFacts(request);
  return Object.freeze({
    purchaseId: canonical.purchaseId,
    merchantId: canonical.merchantId,
    merchantName: request.terms.merchant.name,
    merchantOrigin: canonical.merchantOrigin,
    resourceUrl: canonical.resourceUrl,
    method: canonical.method,
    requestMediaType: canonical.requestMediaType,
    requestBodyDigest: canonical.requestBodyDigest,
    resourceFingerprint: canonical.resourceFingerprint,
    amountAtomic: canonical.amountAtomic,
    asset: canonical.asset,
    network: canonical.network,
    payTo: canonical.payTo,
    termsExpiresAt: canonical.expiresAt,
    checkoutDigest: canonical.checkoutDigest,
    purchaseAuthorizationRequestDigest: canonical.requestDigest,
    purchaseAuthorizationNonceDigest: canonical.nonceDigest,
    purchaseAuthorizationFactsDigest: authorizationFactsDigest(request),
    additionalCostCeilingAtomic: canonical.additionalCostCeilingAtomic,
  });
}

function canonicalCheckoutEvidence(
  evidence: Parameters<AuthorityModule["request"]>[0]["checkoutEvidence"],
) {
  if (
    !(evidence.bytes instanceof Uint8Array) ||
    evidence.bytes.byteLength === 0 ||
    evidence.mediaType !== CHECKOUT_MEDIA_TYPE ||
    !evidence.issuer
  ) {
    throw new Error("authority Checkout evidence is incomplete");
  }
  const artifact = Buffer.from(evidence.bytes).toString("ascii");
  if (
    Buffer.byteLength(artifact, "ascii") !== evidence.bytes.byteLength ||
    /[^\x21-\x7e]/.test(artifact) ||
    evidenceDigest(evidence.bytes) !== evidence.digest
  ) {
    throw new Error("authority Checkout evidence bytes are invalid");
  }
  return Object.freeze({
    artifact,
    digest: evidence.digest,
    mediaType: canonicalMediaType(evidence.mediaType)!,
    profile: evidence.profile,
    issuer: evidence.issuer,
  });
}

function validateTransportResult(result: AuthorityDecisionTransportResult): void {
  if (
    !result ||
    typeof result.responseWire !== "string" ||
    result.responseWire.length === 0 ||
    !(result.decisionEvidence instanceof Uint8Array) ||
    result.decisionEvidence.byteLength === 0
  ) {
    throw new Error("authority transport returned an incomplete decision");
  }
}

function verification(
  authentication: AuthorityAuthenticationInput,
  replayStore: AuthorityReplayStore,
  now: () => number,
) {
  return { ...authentication, replayStore, now };
}

async function supportingAp2Evidence(
  verifier: Ap2AuthorityDecisionEvidenceVerifier,
  decision: VerifiedAuthorityDecision,
  bytes: Uint8Array,
): Promise<readonly VerifiedArtifact[]> {
  const expected = {
    decision: decision.evidence.decision,
    authorityId: decision.evidence.authorityId,
    purchaseId: decision.evidence.purchaseId,
    checkoutDigest: decision.evidence.checkoutDigest,
    requestDigest: decision.evidence.requestDigest,
    factsDigest: decision.evidence.factsDigest,
    nonceDigest: decision.evidence.nonceDigest,
    evidenceDigest: decision.evidence.evidenceDigest,
    facts: decision.facts,
    checkoutEvidence: decision.checkoutEvidence,
  } as const;
  const detailed = await verifier.verifyDetailed({
    evidence: Uint8Array.from(bytes),
    expected,
  });
  if (!detailed.mandates) return Object.freeze([]);
  const verifierId = decision.evidence.verifierId;
  const artifacts = [
    verifiedMandateArtifact(
      detailed.mandates.checkout.artifact,
      detailed.mandates.checkout.content,
      detailed.issuer,
      verifierId,
    ),
    verifiedMandateArtifact(
      detailed.mandates.payment.artifact,
      detailed.mandates.payment.content,
      detailed.issuer,
      verifierId,
    ),
  ];
  return Object.freeze(artifacts);
}

function verifiedMandateArtifact(
  artifact: string,
  content: object,
  issuer: string,
  verifierId: string,
): VerifiedArtifact {
  const bytes = Buffer.from(artifact, "ascii");
  const digest = evidenceDigest(bytes);
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    mediaType: MANDATE_MEDIA_TYPE,
    profile: AP2_HUMAN_PRESENT_PROFILE,
    issuer,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId,
      profile: AP2_HUMAN_PRESENT_PROFILE,
      detailDigest: evidenceDigest(JSON.stringify(content)) as Sha256Digest,
    }),
  });
}

export { SOMPI_AP2_AUTHORITY_DECISION_PROFILE };
