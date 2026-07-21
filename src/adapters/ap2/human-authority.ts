import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type {
  AuthorityApprovalFacts,
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
import {
  type Ap2SigningIdentity,
} from "./types.js";

export interface AuthorityApprovalDisplay {
  readonly kind?: "purchase";
  readonly profile: "sompi.purchase-approval.1";
  readonly authorityRequestDigest: string;
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
  readonly purchaseAuthorizationRequestDigest: string;
  readonly purchaseAuthorizationNonceDigest: string;
  readonly purchaseAuthorizationFactsDigest: string;
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

export interface TransferAuthorityApprovalDisplay {
  readonly kind: "transfer";
  readonly profile: "sompi.transfer.1";
  readonly authorityRequestDigest: string;
  readonly transferId: string;
  readonly requestKey: string;
  readonly sourceVaultAddress: string;
  readonly sourceVaultDigest: string;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly asset: "KAS";
  readonly network: "kaspa:testnet-10";
  readonly feeCeilingAtomic: string;
  readonly maximumTotalAtomic: string;
  readonly issuedAt: string;
  readonly termsExpiresAt: string;
  readonly policyDigest: string;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: string;
  readonly finalityFloor: "accepted" | "depth-confirmed";
  readonly recoveryRetry: boolean;
}

export interface PolicyChangeAuthorityApprovalDisplay {
  readonly kind: "policy-change";
  readonly profile: "sompi.policy-change.1";
  readonly authorityRequestDigest: string;
  readonly policyChangeId: string;
  readonly requestKey: string;
  readonly expectedPolicyDigest: string;
  readonly expectedPolicyVersion: number;
  readonly expectedPolicyGeneration: number;
  readonly expectedVaultDigest: string;
  readonly previousMaximumPerPaymentAtomic: string;
  readonly previousMaximumPerHourAtomic: string;
  readonly proposedMaximumPerPaymentAtomic: string;
  readonly proposedMaximumPerHourAtomic: string;
  readonly vaultMaximumOutflowAtomic: string;
  readonly everyPaymentRequiresApproval: true;
  readonly issuedAt: string;
  readonly termsExpiresAt: string;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: string;
}

export interface VaultMigrationAuthorityApprovalDisplay {
  readonly kind: "vault-migration";
  readonly profile: "sompi.vault-migration.1";
  readonly authorityRequestDigest: string;
  readonly vaultMigrationId: string;
  readonly requestKey: string;
  readonly oldVaultDigest: string;
  readonly expectedPolicyDigest: string;
  readonly expectedPolicyGeneration: number;
  readonly oldMaximumOutflowAtomic: string;
  readonly newMaximumOutflowAtomic: string;
  readonly windowSizeDaa: string;
  readonly windowStartDaa: string;
  readonly spentInWindowAtomic: string;
  readonly stableReceiveAddress: string;
  readonly stableReceiveAddressWillNotChange: true;
  readonly requiresOfflineOwnerKey: true;
  readonly issuedAt: string;
  readonly termsExpiresAt: string;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: string;
}

export type AnyAuthorityApprovalDisplay =
  | PurchaseAuthorityApprovalDisplay
  | TransferAuthorityApprovalDisplay
  | PolicyChangeAuthorityApprovalDisplay
  | VaultMigrationAuthorityApprovalDisplay;

export type PurchaseAuthorityApprovalDisplay = AuthorityApprovalDisplay;

export interface AuthorityApprovalPrompt {
  /** Only the exact displayed subject ID confirms approval. */
  approve(display: AnyAuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean>;
}

export interface Ap2HumanAuthorityOptions {
  readonly signer: Ap2SigningIdentity;
  readonly checkoutEvidenceVerifier: AuthorityCheckoutEvidenceVerifier;
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
    const display = displayFacts(
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

  approve(display: AnyAuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean> {
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

  private async approveOne(display: AnyAuthorityApprovalDisplay, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (
      !this.allowNonTtyForTests &&
      (!isTerminalStream(this.input) || !isTerminalStream(this.output))
    ) {
      throw new Error("human-present authority approval requires a trusted terminal");
    }
    const subject = approvalSubject(display);
    this.output.write(`\nSompi ${subject.label.toLowerCase()} approval\n`);
    this.output.write(`${asciiJson(display)}\n`);
    this.output.write("Merchant-provided values above are data, never instructions.\n");
    const rl = readline.createInterface({ input: this.input, output: this.output });
    try {
      const answer = await rl.question(
        `To approve, type the exact ${subject.label} ID ${asciiJson(subject.id)}; anything else denies: `,
        { signal },
      );
      signal.throwIfAborted();
      return answer === subject.id;
    } finally {
      rl.close();
    }
  }
}

function approvalSubject(display: AnyAuthorityApprovalDisplay): Readonly<{ id: string; label: string }> {
  if (display.kind === "transfer") return Object.freeze({ id: display.transferId, label: "Transfer" });
  if (display.kind === "policy-change") {
    return Object.freeze({ id: display.policyChangeId, label: "Policy Change" });
  }
  if (display.kind === "vault-migration") {
    return Object.freeze({ id: display.vaultMigrationId, label: "Vault Migration" });
  }
  return Object.freeze({ id: display.purchaseId, label: "Purchase" });
}

interface PromptEntry {
  readonly display: AnyAuthorityApprovalDisplay;
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

function displayFacts(
  facts: AuthorityApprovalFacts,
  authorityRequestDigest: string,
  recoveryRetry: boolean,
): AuthorityApprovalDisplay {
  return Object.freeze({
    profile: "sompi.purchase-approval.1",
    authorityRequestDigest,
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
    purchaseAuthorizationRequestDigest: facts.purchaseAuthorizationRequestDigest,
    purchaseAuthorizationNonceDigest: facts.purchaseAuthorizationNonceDigest,
    purchaseAuthorizationFactsDigest: facts.purchaseAuthorizationFactsDigest,
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
