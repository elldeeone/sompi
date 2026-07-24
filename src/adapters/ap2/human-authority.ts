import {
  purchaseAuthorityApprovalDisplay,
  type AuthorityApprovalPrompt,
} from "../../authority/approval-ceremony.js";
import type {
  AuthorityCheckoutEvidenceVerifier,
  AuthorityDenialCode,
} from "../../authority/protocol.js";
import type {
  AuthorityHumanDecision,
  AuthorityHumanDecisionContext,
  AuthorityHumanDecisionProvider,
} from "../../authority/service.js";
import {
  issueAp2AuthorityDecisionEvidence,
  type Ap2AuthorityDecisionChoice,
} from "./authority-decision.js";
import type {
  Ap2SigningIdentity,
} from "./types.js";

export interface Ap2HumanAuthorityOptions {
  readonly signer: Ap2SigningIdentity;
  readonly checkoutEvidenceVerifier: AuthorityCheckoutEvidenceVerifier;
  readonly instrumentId: string;
  readonly prompt: AuthorityApprovalPrompt;
  readonly now?: () => number;
}

/** Authority-side deterministic AP2 verifier, consent, and evidence signer. */
export class Ap2HumanAuthorityDecisionProvider implements AuthorityHumanDecisionProvider {
  private readonly now: () => number;

  constructor(private readonly options: Ap2HumanAuthorityOptions) {
    if (
      options.signer?.role !== "authority" ||
      !options.checkoutEvidenceVerifier ||
      !options.prompt ||
      typeof options.prompt.approve !== "function" ||
      typeof options.instrumentId !== "string" ||
      options.instrumentId.length === 0
    ) {
      throw new Error("AP2 human authority configuration is incomplete");
    }
    this.now = options.now ?? Date.now;
  }

  async decide(context: AuthorityHumanDecisionContext): Promise<AuthorityHumanDecision> {
    context.signal.throwIfAborted();
    const nowMs = this.timestamp();
    const message = context.request.message;
    await this.options.checkoutEvidenceVerifier.verify({
      evidence: message.checkoutEvidence,
      facts: message.facts,
      nowMs,
    });

    const termsExpiryMs = Date.parse(message.facts.termsExpiresAt);
    if (termsExpiryMs <= nowMs || message.expiresAtMs <= nowMs) {
      throw new Error("authority request expired before a decision could be signed");
    }
    const display = purchaseAuthorityApprovalDisplay(
      message.facts,
      context.request.requestDigest,
      context.recoveryRetry,
    );
    const approved = await this.options.prompt.approve(display, context.signal);
    context.signal.throwIfAborted();
    context.renewLease();

    const signingTimeMs = this.timestamp();
    if (signingTimeMs >= termsExpiryMs || signingTimeMs >= message.expiresAtMs) {
      throw new Error("authority request expired during human approval");
    }
    const choice: Ap2AuthorityDecisionChoice = approved
      ? { decision: "approved", instrumentId: this.options.instrumentId }
      : { decision: "denied", denialCode: "user_denied" };
    const evidence = await issueAp2AuthorityDecisionEvidence({
      request: context.request,
      choice,
      issuedAtSec: Math.floor(signingTimeMs / 1_000),
      expiresAtSec: Math.floor(Math.min(termsExpiryMs, message.expiresAtMs) / 1_000),
    }, this.options.signer);
    return Object.freeze({
      decision: choice.decision,
      authorityId: this.options.signer.issuer,
      ...(choice.decision === "denied" ? { denialCode: choice.denialCode } : {}),
      signedEvidence: Uint8Array.from(evidence),
    }) as AuthorityHumanDecision;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("authority clock is unavailable");
    }
    return value;
  }
}

export function termsExpiredDenialCode(): AuthorityDenialCode {
  return "terms_expired";
}
