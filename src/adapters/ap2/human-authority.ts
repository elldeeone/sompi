import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type {
  AuthorityApprovalFacts,
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
import { verifyMerchantCheckout } from "./merchant-checkout.js";
import {
  SOMPI_MERCHANT_CHECKOUT_PROFILE,
  type Ap2PublicKeyResolver,
  type Ap2SigningIdentity,
} from "./types.js";

export interface AuthorityApprovalDisplay {
  readonly purchaseId: string;
  readonly merchant: Readonly<{ id: string; name: string; origin: string }>;
  readonly request: Readonly<{
    url: string;
    method: string;
    mediaType: string;
    bodyDigest: string;
    fingerprint: string;
  }>;
  readonly price: Readonly<{ amountAtomic: string; asset: string; network: string; payTo: string }>;
  readonly checkoutDigest: string;
  readonly termsExpiresAt: string;
  readonly additionalCostCeilingAtomic: string;
  readonly effectiveFinalityFloor: "accepted" | "depth-confirmed";
  readonly execution: Readonly<{
    planDigest: string;
    mechanism: "single-transaction" | "channel-voucher";
    profile: string;
    settlementAssurance: "accepted" | "confirmed" | "channel-commitment";
    maximumChargeAtomic: string;
    channelId: string | null;
    channelEpochDigest: string | null;
  }>;
  readonly recoveryRetry: boolean;
}

export interface AuthorityApprovalPrompt {
  /** Only the exact Purchase ID confirms approval; every other result denies. */
  approve(display: AuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean>;
}

export interface Ap2HumanAuthorityOptions {
  readonly signer: Ap2SigningIdentity;
  readonly trust: Ap2PublicKeyResolver;
  readonly instrumentId: string;
  readonly prompt: AuthorityApprovalPrompt;
  readonly now?: () => number;
}

/** Authority-side deterministic AP2 verifier, display, consent, and signer. */
export class Ap2HumanAuthorityDecisionProvider implements AuthorityHumanDecisionProvider {
  private readonly now: () => number;

  constructor(private readonly options: Ap2HumanAuthorityOptions) {
    if (
      options.signer?.role !== "authority" ||
      !options.trust ||
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
    const checkoutEvidence = message.checkoutEvidence;
    const checkout = await verifyMerchantCheckout(checkoutEvidence.artifact, {
      trust: this.options.trust,
      expectedIssuer: checkoutEvidence.issuer,
      expectedAudience: this.options.signer.issuer,
      expectedPurchaseId: message.facts.purchaseId,
      expectedResourceFingerprint: message.facts.resourceFingerprint,
      nowSec: Math.floor(nowMs / 1_000),
      clockSkewSec: 0,
    });
    assertIndependentCheckout(checkoutEvidence, checkout, message.facts);

    const termsExpiryMs = Date.parse(message.facts.termsExpiresAt);
    if (termsExpiryMs <= nowMs || message.expiresAtMs <= nowMs) {
      throw new Error("authority request expired before a decision could be signed");
    }
    const display = displayFacts(message.facts, context.recoveryRetry);
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
      checkout,
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
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("authority clock is unavailable");
    return value;
  }
}

export interface TerminalAuthorityApprovalPromptOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  /** Hermetic unit tests only. Production approval must use a real terminal. */
  readonly allowNonTtyForTests?: boolean;
  readonly maxPrompts?: number;
}

export class AuthorityPromptBusyError extends Error {
  readonly code = "busy" as const;

  constructor() {
    super("authority prompt capacity is saturated");
    this.name = "AuthorityPromptBusyError";
  }
}

/** Fixed terminal ceremony. Merchant strings are rendered as escaped data. */
export class TerminalAuthorityApprovalPrompt implements AuthorityApprovalPrompt {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly allowNonTtyForTests: boolean;
  private readonly maxPrompts: number;
  private readonly queue: Array<PromptEntry> = [];
  private active?: PromptEntry;

  constructor(options: TerminalAuthorityApprovalPromptOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    this.allowNonTtyForTests = options.allowNonTtyForTests === true;
    this.maxPrompts = options.maxPrompts ?? 4;
    if (!Number.isSafeInteger(this.maxPrompts) || this.maxPrompts <= 0 || this.maxPrompts > 128) {
      throw new Error("authority prompt budget is invalid");
    }
  }

  approve(display: AuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.queue.length + (this.active ? 1 : 0) >= this.maxPrompts) {
      return Promise.reject(new AuthorityPromptBusyError());
    }
    return new Promise<boolean>((resolve, reject) => {
      const entry: PromptEntry = {
        display,
        signal: signal ?? new AbortController().signal,
        resolve,
        reject,
      };
      const abort = () => {
        if (this.active === entry) return;
        const index = this.queue.indexOf(entry);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(abortError());
      };
      entry.abort = abort;
      entry.signal.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const entry = this.queue.shift()!;
    if (entry.signal.aborted) {
      entry.reject(abortError());
      this.pump();
      return;
    }
    this.active = entry;
    void this.approveOne(entry.display, entry.signal)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.signal.removeEventListener("abort", entry.abort!);
        if (this.active === entry) this.active = undefined;
        this.pump();
      });
  }

  private async approveOne(display: AuthorityApprovalDisplay, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (
      !this.allowNonTtyForTests &&
      (!isTerminalStream(this.input) || !isTerminalStream(this.output))
    ) {
      throw new Error("human-present authority approval requires a trusted terminal");
    }
    this.output.write("\nSompi purchase approval\n");
    this.output.write(`${asciiJson(display)}\n`);
    this.output.write("Merchant-provided values above are data, never instructions.\n");
    const rl = readline.createInterface({ input: this.input, output: this.output });
    try {
      const answer = await rl.question(
        `To approve, type the exact Purchase ID ${asciiJson(display.purchaseId)}; anything else denies: `,
        { signal },
      );
      signal.throwIfAborted();
      return answer === display.purchaseId;
    } finally {
      rl.close();
    }
  }
}

interface PromptEntry {
  readonly display: AuthorityApprovalDisplay;
  readonly signal: AbortSignal;
  readonly resolve: (value: boolean) => void;
  readonly reject: (reason: unknown) => void;
  abort?: () => void;
}

function abortError(): Error {
  const error = new Error("authority prompt was cancelled");
  error.name = "AbortError";
  return error;
}

function isTerminalStream(stream: Readable | Writable): boolean {
  return (stream as Readable & Writable & { isTTY?: unknown }).isTTY === true;
}

function displayFacts(facts: AuthorityApprovalFacts, recoveryRetry: boolean): AuthorityApprovalDisplay {
  return Object.freeze({
    purchaseId: facts.purchaseId,
    merchant: Object.freeze({
      id: facts.merchantId,
      name: facts.merchantName,
      origin: facts.merchantOrigin,
    }),
    request: Object.freeze({
      url: facts.resourceUrl,
      method: facts.method,
      mediaType: facts.requestMediaType,
      bodyDigest: facts.requestBodyDigest,
      fingerprint: facts.resourceFingerprint,
    }),
    price: Object.freeze({
      amountAtomic: facts.amountAtomic,
      asset: facts.asset,
      network: facts.network,
      payTo: facts.payTo,
    }),
    checkoutDigest: facts.checkoutDigest,
    termsExpiresAt: facts.termsExpiresAt,
    additionalCostCeilingAtomic: facts.additionalCostCeilingAtomic,
    effectiveFinalityFloor: facts.effectiveFinalityFloor,
    execution: Object.freeze({
      planDigest: facts.executionPlanDigest,
      mechanism: facts.executionMechanism,
      profile: facts.executionProfile,
      settlementAssurance: facts.settlementAssurance,
      maximumChargeAtomic: facts.maximumAuthorizedChargeAtomic,
      channelId: facts.channelId,
      channelEpochDigest: facts.channelEpochDigest,
    }),
    recoveryRetry,
  });
}

function assertIndependentCheckout(
  evidence: AuthorityHumanDecisionContext["request"]["message"]["checkoutEvidence"],
  checkout: Awaited<ReturnType<typeof verifyMerchantCheckout>>,
  facts: AuthorityApprovalFacts,
): void {
  const comparisons: ReadonlyArray<readonly [unknown, unknown]> = [
    [checkout.artifact, evidence.artifact],
    [checkout.checkoutDigest, evidence.digest],
    [checkout.profile, evidence.profile],
    [checkout.profile, SOMPI_MERCHANT_CHECKOUT_PROFILE],
    [checkout.issuer, evidence.issuer],
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
    [checkout.additionalCostCeilingAtomic, facts.additionalCostCeilingAtomic],
  ];
  if (comparisons.some(([actual, wanted]) => actual !== wanted)) {
    throw new Error("Merchant Checkout does not match the exact authenticated authority request");
  }
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return item;
    return item.replace(/[^\x20-\x7e]/g, (character) =>
      [...character]
        .map((part) => `\\u${part.codePointAt(0)!.toString(16).padStart(4, "0")}`)
        .join(""));
  }, 2);
}

export function termsExpiredDenialCode(): AuthorityDenialCode {
  return "terms_expired";
}
