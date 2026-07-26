import { randomBytes } from "node:crypto";
import { SompiOperationFailure } from "../operation-failure.js";
import type { ChainEvidenceFinalitySelector } from "../chain-evidence/types.js";
import {
  assertVerifiedAuthorityDecision,
  type VerifiedAuthorityDecision,
} from "../authority/protocol.js";
import {
  authorizationFacts,
  authorizationFactsDigest,
  checkoutTermsFactsDigest,
  PURCHASE_AUTHORIZATION_REQUEST_PROFILE,
  validateAuthorizationDecision,
  validateCheckoutTerms,
  validatePreparedPayment,
  type PreparedPurchasePayment,
  type PurchaseAuthorizationDecision,
  type PurchaseAuthorizationRequest,
} from "./contracts.js";
import {
  EgressPolicyError,
  EgressPolicy,
  type EgressResponseGuard,
  type EgressRequestInput,
  type RedirectRequestOverride,
  type SafeTransportHop,
} from "./egress-policy.js";
import {
  createPaymentIdentifier,
  createPurchaseId,
  canonicalRequestUrl,
  canonicalMediaType,
  evidenceDigest,
  requestFingerprint,
} from "./identity.js";
import { paymentFinalityMeets } from "./finality.js";
import {
  canonicalPurchaseExecutionPlan,
  channelEpochDigest,
  type CanonicalPurchaseExecutionPlan,
  type PurchaseExecutionPlan,
} from "./execution-plan.js";
import {
  EvidenceAdmissionError,
  JournalNotFoundError,
  JournalEffectBusyError,
  JournalRequestConflictError,
  PurchaseAdmissionError,
  PurchaseJournal,
  TREASURY_STAGING_EFFECT_KIND,
  TREASURY_STAGING_EVIDENCE_KIND,
  TREASURY_STAGING_RECOVERY_EFFECT_KIND,
  type EffectClaim,
  type EffectRecord,
  type PurchaseRecord,
  type RecordPurchaseSettlementInput,
  type RecordObservedTreasuryStagingInput,
  type RecordTreasuryStagingRecoveryObservationInput,
  type TreasuryStagingObservationRecord,
  type TreasuryStagingRecoveryJournalContext,
} from "./journal.js";
import { projectPurchaseView, type PurchaseProjectionSnapshot } from "./projection.js";
import {
  PurchaseReconciler,
  type ReconciliationObservation,
  type ReconciliationSummary,
} from "./reconciliation.js";
import type {
  CheckoutTerms,
  PaymentAttemptView,
  PaymentIdentifier,
  PurchaseId,
  PurchaseIntent,
  PurchaseModule,
  PurchaseRequestKey,
  PurchaseView,
  Sha256Digest,
} from "./types.js";
import {
  TreasuryCapacityError,
  type PurchaseTreasuryCapacity,
  type TreasuryQuote,
} from "../treasury/purchase-capacity.js";

const PAYMENT_EFFECT_KIND = "kaspa-x402-payment";
const PURCHASE_COORDINATION_TTL_MS = 60_000;
const RECOVERY_TTL_MS = 30_000;
const DEFAULT_EXECUTION_RESERVE_MS = 30_000;
const REQUEST_BODY_PROFILE = "urn:sompi:purchase-request-body:1";

export interface VerifiedArtifact {
  bytes: Uint8Array;
  mediaType: string;
  profile: string;
  issuer?: string;
  declaredDigest?: Sha256Digest;
  verification: {
    verifierId: string;
    profile: string;
    detailDigest: Sha256Digest;
  };
}

declare const verifiedCheckoutDiscoveryBrand: unique symbol;

export interface VerifiedCheckoutDiscovery {
  readonly [verifiedCheckoutDiscoveryBrand]: true;
  terms: CheckoutTerms;
  checkoutEvidence: VerifiedArtifact;
  paymentRequirements: VerifiedArtifact;
  executionPlan: CanonicalPurchaseExecutionPlan;
}

const VERIFIED_CHECKOUT_DISCOVERIES = new WeakSet<object>();

/**
 * Adapter TCB boundary. Call only after signature/schema verification has
 * extracted `terms` from these exact Checkout bytes.
 */
export function certifyVerifiedCheckoutDiscovery(input: {
  terms: CheckoutTerms;
  checkoutEvidence: VerifiedArtifact;
  paymentRequirements: VerifiedArtifact;
  executionPlan: PurchaseExecutionPlan;
}): VerifiedCheckoutDiscovery {
  const checkoutDigest = evidenceDigest(input.checkoutEvidence.bytes);
  const requirementsDigest = evidenceDigest(input.paymentRequirements.bytes);
  const executionPlan = canonicalPurchaseExecutionPlan(input.executionPlan);
  if (
    input.checkoutEvidence.declaredDigest !== checkoutDigest ||
    input.terms.checkoutDigest !== checkoutDigest ||
    input.checkoutEvidence.issuer !== input.terms.merchant.id ||
    input.checkoutEvidence.profile !== input.checkoutEvidence.verification.profile ||
    input.checkoutEvidence.verification.detailDigest !== checkoutTermsFactsDigest(input.terms) ||
    input.paymentRequirements.declaredDigest !== requirementsDigest ||
    input.paymentRequirements.issuer !== input.terms.merchant.id ||
    input.paymentRequirements.profile !== input.paymentRequirements.verification.profile ||
    executionPlan.requirementsDigest !== requirementsDigest ||
    executionPlan.maximumChargeAtomic !== input.terms.amountAtomic
  ) {
    throw new PurchaseCoordinatorError(
      "verified Checkout result is not derived from its exact Merchant evidence",
      "checkout_verification_mismatch"
    );
  }
  const verified = Object.freeze({
    terms: canonicalTermsCopy(input.terms),
    checkoutEvidence: freezeVerifiedArtifact(input.checkoutEvidence),
    paymentRequirements: freezeVerifiedArtifact(input.paymentRequirements),
    executionPlan,
  }) as VerifiedCheckoutDiscovery;
  VERIFIED_CHECKOUT_DISCOVERIES.add(verified);
  return verified;
}

export interface PurchaseEgressSession {
  readonly request: SafeTransportHop;
  /** Validates an additional Merchant protocol request under the same egress policy. */
  requestFor(input: EgressRequestInput): Promise<SafeTransportHop>;
  redirect(
    previous: SafeTransportHop,
    location: string,
    override?: RedirectRequestOverride
  ): Promise<SafeTransportHop>;
  responseGuard(hop: SafeTransportHop, abort: (reason: EgressPolicyError) => void): EgressResponseGuard;
}

/** Merchant/AP2-facing seam. It returns verified canonical terms, never SDK objects. */
export interface CheckoutTermsModule {
  discover(input: {
    purchaseId: PurchaseId;
    resourceFingerprint: Sha256Digest;
    egress: PurchaseEgressSession;
  }): Promise<VerifiedCheckoutDiscovery>;
}

export type AuthorityResult =
  | { status: "pending" }
  | {
      status: "decision";
      decision: VerifiedAuthorityDecision;
      decisionEvidenceBytes: Uint8Array;
      decisionEvidenceMediaType: string;
      decisionEvidenceIssuer?: string;
      supportingEvidence?: readonly VerifiedArtifact[];
    };

/** Trusted-Authority seam. The implementation must live outside the MCP process. */
export interface AuthorityModule {
  request(input: {
    request: PurchaseAuthorizationRequest;
    checkoutEvidence: Readonly<{
      bytes: Uint8Array;
      digest: Sha256Digest;
      mediaType: string;
      profile: string;
      issuer?: string;
    }>;
  }): Promise<AuthorityResult>;
}

/**
 * Deep Purchase Treasury seam. It owns readiness, capacity policy, vault
 * staging, and abandoned-stage recovery. The Purchase module chooses when a
 * movement is required; it never calls the vault or recovery adapters itself.
 */
export interface TreasuryModule extends PurchaseTreasuryCapacity {
  prepareStaging(input: {
    execution: KaspaPreparedExecutionContext["execution"];
    request: KaspaRequestContext;
    paymentRequirements: Uint8Array;
    additionalCostCeilingAtomic: string;
  }): Promise<PreparedTreasuryStaging>;
  submitStaging(input: {
    context: KaspaTreasuryStagingContext;
    effect: EffectRecord;
    signal: AbortSignal;
  }): Promise<TreasuryStagingSubmissionResult>;
  observeStaging(input: {
    context: KaspaTreasuryStagingContext;
    effect: EffectRecord;
  }): Promise<TreasuryStagingRecoveryObservation>;
  prepareStagingRecovery(
    input: Readonly<StagingRecoveryPreparationContext>
  ): Promise<Readonly<PreparedStagingRecovery>>;
  observeStagingRecovery(input: {
    preparedBytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<Readonly<StagingRecoveryObservation>>;
  submitStagingRecovery(input: {
    preparedBytes: Uint8Array;
    readiness: Readonly<StagingRecoveryReadiness>;
    signal: AbortSignal;
  }): Promise<Readonly<StagingRecoverySubmission>>;
}

export interface PreparedKaspaPayment extends PreparedPurchasePayment {
  preparedBytes: Uint8Array;
  requirementsDigest: Sha256Digest;
  mechanism: "single-transaction" | "channel-voucher";
  profile: string;
  transactionId?: string;
  requiredAssurance: "accepted" | "confirmed" | "channel-commitment";
}

export interface PreparedTreasuryStaging {
  preparedBytes: Uint8Array;
  preparedDigest: Sha256Digest;
  transactionId: string;
  expectedOutpoint: string;
  stagingAmountAtomic: string;
  fundingSource: "vault-treasury";
}

export interface TreasuryStagingResult {
  evidence: VerifiedArtifact;
  transactionId: string;
  outpoint: string;
  stagingAmountAtomic: string;
  fundingSource: "vault-treasury";
}

export type TreasuryStagingSubmissionResult =
  | { status: "submitted"; submissionDigest: Sha256Digest }
  | {
      status: "staged";
      submissionDigest: Sha256Digest;
      staging: TreasuryStagingResult;
    };

export type TreasuryStagingRecoveryObservation =
  | Exclude<
      ReconciliationObservation,
      { status: "spend_observed" | "treasury_staging_observed" }
    >
  | { status: "staged"; staging: TreasuryStagingResult };

export interface SettlementResult {
  evidence: VerifiedArtifact;
  executionId: string;
  mechanism: "single-transaction" | "channel-voucher";
  profile: string;
  transactionId?: string;
  commitmentId?: string;
  outpoint?: string;
  amountAtomic: string;
  additionalCostAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  settlementAssurance: "accepted" | "confirmed" | "channel-commitment";
  fundingSource: "vault-treasury";
}

export type PaymentSubmissionResult =
  | { status: "submitted"; submissionDigest: Sha256Digest }
  | {
      status: "settled";
      submissionDigest: Sha256Digest;
      settlement: SettlementResult;
      paidResponse?: Extract<FulfilmentResult, { status: "fulfilled" }>;
    };

export type PaymentRecoveryObservation =
  | ReconciliationObservation
  | { status: "settled"; settlement: SettlementResult };

/** The only payment seam. Its concrete implementation is the pinned Kaspa-x402 adapter. */
export interface KaspaRequestContext {
  url: string;
  method: string;
  mediaType?: string;
  body: Uint8Array;
  requestFingerprint: Sha256Digest;
}

export interface KaspaPreparedExecutionContext {
  execution: {
    purchaseId: PurchaseId;
    terms: CheckoutTerms;
    authorizationRequest: PurchaseAuthorizationRequest;
    authorization: PurchaseAuthorizationDecision;
    paymentIdentifier: PaymentIdentifier;
  };
  request: KaspaRequestContext;
  paymentRequirements: Uint8Array;
  staging?: {
    transactionId: string;
    outpoint: string;
    amountAtomic: string;
    evidenceDigest: Sha256Digest;
    fundingSource: "vault-treasury";
  };
  preparation: {
    preparedBytes: Uint8Array;
    preparedDigest: Sha256Digest;
    executionId: string;
    mechanism: "single-transaction" | "channel-voucher";
    profile: string;
    transactionId?: string;
    requiredAssurance: "accepted" | "confirmed" | "channel-commitment";
    fundingSource: "vault-treasury";
  };
}

export interface KaspaTreasuryStagingContext {
  execution: KaspaPreparedExecutionContext["execution"];
  request: KaspaRequestContext;
  paymentRequirements: Uint8Array;
  staging: {
    preparedBytes: Uint8Array;
    preparedDigest: Sha256Digest;
    transactionId: string;
    expectedOutpoint: string;
    amountAtomic: string;
    fundingSource: "vault-treasury";
  };
}

export interface KaspaPaymentModule {
  prepare(input: {
    execution: {
      purchaseId: PurchaseId;
      terms: CheckoutTerms;
      authorizationRequest: PurchaseAuthorizationRequest;
      authorization: PurchaseAuthorizationDecision;
      paymentIdentifier: PaymentIdentifier;
    };
    request: KaspaRequestContext;
    paymentRequirements: Uint8Array;
    staging?: KaspaPreparedExecutionContext["staging"];
    additionalCostCeilingAtomic: string;
  }): Promise<PreparedKaspaPayment>;
  submit(input: {
    context: KaspaPreparedExecutionContext;
    effect: EffectRecord;
    egress: PurchaseEgressSession;
    signal: AbortSignal;
  }): Promise<PaymentSubmissionResult>;
  observe(input: {
    context: KaspaPreparedExecutionContext;
    effect: EffectRecord;
    egress: PurchaseEgressSession;
  }): Promise<PaymentRecoveryObservation>;
  /** Replays only the same immutable paid request after an observed Settlement. */
  recoverFulfilment?(input: {
    context: KaspaPreparedExecutionContext;
    egress: PurchaseEgressSession;
  }): Promise<FulfilmentResult>;
}

export interface StagingRecoveryPreparationContext {
  purchaseId: PurchaseId;
  paymentIdentifier: PaymentIdentifier;
  terms: CheckoutTerms;
  paymentRequirements: Uint8Array;
  stagingEvidenceDigest: Sha256Digest;
  exactPayment?: {
    preparedBytes: Uint8Array;
    preparedDigest: Sha256Digest;
    transactionId: string;
    requiredFinality: string;
  };
  authorizedAdditionalCostCeilingAtomic: string;
}

export interface PreparedStagingRecovery {
  preparedBytes: Uint8Array;
  preparedDigest: Sha256Digest;
  exactTransactionId?: string;
  recoveryTransactionId: string;
  recoveryOutpoint: string;
  recoveryAmountAtomic: string;
  stagingFeeAtomic: string;
  recoveryFeeAtomic: string;
  requiredFinality: string;
}

export interface StagingRecoveryReadiness {
  proofDigest: Sha256Digest;
  observedAtMs: number;
  expiresAtMs: number;
  /** Adapter-owned, in-memory token. Only the persisted proof facts are canonical. */
  token: unknown;
}

export type StagingRecoveryObservation =
  | {
      status: "safe_to_submit";
      evidenceDigest: Sha256Digest;
      readiness: StagingRecoveryReadiness;
    }
  | { status: "pending"; evidenceDigest: Sha256Digest }
  | {
      status: "exact_payment_won";
      transactionId: string;
      finality: string;
      evidenceDigest: Sha256Digest;
    }
  | {
      status: "recovery_won";
      transactionId: string;
      recoveryOutpoint: string;
      recoveryAmountAtomic: string;
      finality: string;
      evidenceDigest: Sha256Digest;
    }
  | {
      status: "conflict";
      reason: string;
      evidenceDigest: Sha256Digest;
    };

export type StagingRecoverySubmission =
  | { status: "accepted"; transactionId: string; submissionDigest: Sha256Digest }
  | { status: "ambiguous"; transactionId: string; submissionDigest: Sha256Digest }
  | { status: "conflict"; transactionId: string; submissionDigest: Sha256Digest };

/** Kaspa-specific recovery remains behind this Purchase-owned internal seam. */
export interface TreasuryStagingRecoveryModule {
  prepare(
    input: Readonly<StagingRecoveryPreparationContext>
  ): Promise<Readonly<PreparedStagingRecovery>>;
  observe(input: {
    preparedBytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<Readonly<StagingRecoveryObservation>>;
  submit(input: {
    preparedBytes: Uint8Array;
    readiness: Readonly<StagingRecoveryReadiness>;
    signal: AbortSignal;
  }): Promise<Readonly<StagingRecoverySubmission>>;
}

export interface PurchaseReceiptResult {
  checkoutDigest: Sha256Digest;
  authorizationEvidenceDigest: Sha256Digest;
  settlementEvidenceDigest: Sha256Digest;
  fulfilmentDigest: Sha256Digest;
  evidence: VerifiedArtifact;
}

export type FulfilmentResult =
  | { status: "pending" }
  | {
      status: "fulfilled";
      httpStatus: number;
      body: Uint8Array;
      mediaType: string;
      resourceFingerprint: Sha256Digest;
      merchantEvidence: VerifiedArtifact;
      receipt: PurchaseReceiptResult;
    };

/** Merchant fulfilment seam; payment success is deliberately not Fulfilment. */
export interface FulfilmentModule {
  obtain(input: {
    purchaseId: PurchaseId;
    egress: PurchaseEgressSession;
    terms: CheckoutTerms;
    paymentIdentifier: PaymentIdentifier;
    authorizationEvidenceDigest: Sha256Digest;
    settlementEvidenceDigest: Sha256Digest;
  }): Promise<FulfilmentResult>;
}

export interface PurchaseCoordinatorOptions {
  now?: () => number;
  entropy?: (bytes: number) => Uint8Array;
  workerId?: string;
  effectLeaseTtlMs?: number;
  /** Time reserved after approval for staging and the first Merchant submission. */
  executionReserveMs?: number;
  finality: ChainEvidenceFinalitySelector;
}

export class PurchaseCoordinatorError extends Error {
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PurchaseCoordinatorError";
  }
}

/**
 * Deep Purchase module. Protocol objects terminate at the injected seams; all
 * durable state is canonical Sompi state plus immutable evidence bytes.
 */
export class PurchaseCoordinator implements PurchaseModule {
  private readonly now: () => number;
  private readonly entropy: (bytes: number) => Uint8Array;
  private readonly workerId: string;
  private readonly effectLeaseTtlMs: number;
  private readonly executionReserveMs: number;
  private readonly finality: ChainEvidenceFinalitySelector;

  constructor(
    private readonly journal: PurchaseJournal,
    private readonly egress: EgressPolicy,
    private readonly checkout: CheckoutTermsModule,
    private readonly authority: AuthorityModule,
    private readonly treasury: TreasuryModule,
    private readonly payment: KaspaPaymentModule,
    private readonly fulfilment: FulfilmentModule,
    options: PurchaseCoordinatorOptions
  ) {
    this.now = options.now ?? Date.now;
    this.entropy = options.entropy ?? randomBytes;
    this.workerId = options.workerId ?? `coordinator-${process.pid}-${randomBytes(8).toString("hex")}`;
    this.effectLeaseTtlMs = options.effectLeaseTtlMs ?? PURCHASE_COORDINATION_TTL_MS;
    this.executionReserveMs = options.executionReserveMs ?? DEFAULT_EXECUTION_RESERVE_MS;
    if (typeof options.finality?.selectFinality !== "function") {
      throw new PurchaseCoordinatorError(
        "Chain Evidence finality selector is required",
        "invalid_configuration"
      );
    }
    this.finality = options.finality;
    if (!Number.isSafeInteger(this.effectLeaseTtlMs) || this.effectLeaseTtlMs <= 0) {
      throw new PurchaseCoordinatorError("effect lease TTL must be a positive safe integer", "invalid_configuration");
    }
    if (!Number.isSafeInteger(this.executionReserveMs) || this.executionReserveMs < 0) {
      throw new PurchaseCoordinatorError(
        "execution reserve must be a non-negative safe integer",
        "invalid_configuration"
      );
    }
  }

  async purchase(intent: PurchaseIntent, signal?: AbortSignal): Promise<PurchaseView> {
    try {
      return await this.coordinatePurchase(intent, signal);
    } catch (cause) {
      if (cause instanceof JournalRequestConflictError) {
        throw new SompiOperationFailure("PURCHASE_CONFLICT", { cause });
      }
      if (cause instanceof PurchaseAdmissionError || cause instanceof EvidenceAdmissionError) {
        throw new SompiOperationFailure("PURCHASE_ADMISSION_SATURATED", { cause });
      }
      throw cause;
    }
  }

  private async coordinatePurchase(
    intent: PurchaseIntent,
    signal?: AbortSignal,
  ): Promise<PurchaseView> {
    signal?.throwIfAborted();
    const canonicalIntent = canonicalIntentCopy(intent);
    // Egress policy is reversible local admission. It must run before the
    // Journal creates immutable Purchase or request-body evidence state.
    const initialEgress = await this.createEgressSession(canonicalIntent);
    const fingerprint = requestFingerprint(canonicalIntent.resource);
    const purchase = this.journal.createPurchaseWithEvidence({
      purchase: {
        id: createPurchaseId(this.entropy(16)),
        requestKey: canonicalIntent.requestKey,
        resourceUrl: canonicalIntent.resource.url,
        method: canonicalIntent.resource.method,
        resourceFingerprint: fingerprint,
        expectedMerchantId: canonicalIntent.expectedMerchant?.id,
        expectedMerchantOrigin: canonicalIntent.expectedMerchant?.origin,
      },
      evidence: {
        bytes: canonicalIntent.resource.body ?? new Uint8Array(),
        mediaType: canonicalIntent.resource.mediaType ?? "application/octet-stream",
        profile: REQUEST_BODY_PROFILE,
        issuer: "purchase-intent",
        kind: "purchase-request-body",
      },
    });

    const lease = this.journal.acquireLease(
      `purchase-coordinate:${purchase.id}`,
      this.workerId,
      PURCHASE_COORDINATION_TTL_MS
    );
    if (!lease) return this.status(purchase.id);
    try {
      for (let step = 0; step < 16; step++) {
        signal?.throwIfAborted();
        const current = this.journal.requirePurchase(purchase.id);
        switch (current.state) {
          case "created":
            await this.bindTerms(current, canonicalIntent, initialEgress);
            continue;
          case "terms_bound":
            if (!(await this.createAuthorizationRequest(current, canonicalIntent))) return this.status(current.id);
            continue;
          case "awaiting_authority":
            if (!(await this.requestAuthorization(current))) return this.status(current.id);
            continue;
          case "authorised":
            if (!(await this.prepareExecution(current))) return this.status(current.id);
            continue;
          case "execution_prepared":
            if (!(await this.submitExecution(current))) return this.status(current.id);
            continue;
          case "submitted":
            return this.status(current.id);
          case "settled":
          case "fulfilled":
            if (!(await this.obtainFulfilment(current, canonicalIntent))) return this.status(current.id);
            continue;
          case "receipted":
          case "denied":
          case "cancelled":
          case "expired":
          case "failed_terminal":
            return this.status(current.id);
          case "failed_recoverable":
            if (!this.resumeProofBackedState(current)) return this.status(current.id);
            continue;
        }
      }
      throw new PurchaseCoordinatorError("Purchase lifecycle exceeded its deterministic step bound", "step_bound");
    } catch (error) {
      if (
        signal?.aborted &&
        (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
      ) {
        try {
          this.journal.cancelPurchaseBeforeExternalEffect(purchase.id);
        } catch (cancelError) {
          if (!(cancelError instanceof JournalEffectBusyError)) throw cancelError;
          // Once an external effect is possible, cancellation is only a caller
          // concern. Durable state remains fenced for normal reconciliation.
        }
      }
      throw error;
    } finally {
      this.journal.releaseLease(lease);
    }
  }

  async status(id: PurchaseId, signal?: AbortSignal): Promise<PurchaseView> {
    signal?.throwIfAborted();
    const purchase = this.journal.findPurchase(id);
    if (!purchase) throw new SompiOperationFailure("PURCHASE_NOT_FOUND");
    return projectPurchaseView(this.snapshot(purchase));
  }

  async recover(id: PurchaseId, signal?: AbortSignal): Promise<PurchaseView> {
    try {
      return await this.recoverPurchase(id, signal);
    } catch (cause) {
      if (cause instanceof JournalRequestConflictError) {
        throw new SompiOperationFailure("PURCHASE_CONFLICT", { cause });
      }
      if (cause instanceof PurchaseAdmissionError || cause instanceof EvidenceAdmissionError) {
        throw new SompiOperationFailure("PURCHASE_ADMISSION_SATURATED", { cause });
      }
      throw cause;
    }
  }

  private async recoverPurchase(
    id: PurchaseId,
    signal?: AbortSignal,
  ): Promise<PurchaseView> {
    signal?.throwIfAborted();
    if (!this.journal.findPurchase(id)) {
      throw new SompiOperationFailure("PURCHASE_NOT_FOUND");
    }
    const reconciler = new PurchaseReconciler(
      this.journal,
      new Map([
        [PAYMENT_EFFECT_KIND, { observe: (effect) => this.observePaymentEffect(effect) }],
        [
          TREASURY_STAGING_EFFECT_KIND,
          { observe: (effect) => this.observeTreasuryStagingEffect(effect) },
        ],
      ])
    );
    const summary = await reconciler.reconcile(`${this.workerId}-recovery`, RECOVERY_TTL_MS, id);
    this.applyRecoverySummary(id, summary);
    const intent = this.persistedIntent(id);
    for (let step = 0; step < 8; step++) {
      signal?.throwIfAborted();
      const current = this.journal.requirePurchase(id);
      if (current.state === "failed_recoverable") {
        if (!this.resumeProofBackedState(current)) break;
        continue;
      }
      if (current.state === "authorised") {
        if (!(await this.prepareExecution(current))) break;
        continue;
      }
      if (current.state === "execution_prepared") {
        if (!(await this.submitExecution(current))) break;
        continue;
      }
      if (current.state === "settled" || current.state === "fulfilled") {
        if (!intent || !(await this.obtainFulfilment(current, intent))) break;
        continue;
      }
      break;
    }
    const stagingRecovery = await this.recoverAbandonedStaging(id);
    if (stagingRecovery === "exact_payment_won") {
      const exactSummary = await reconciler.reconcile(
        `${this.workerId}-exact-winner`,
        RECOVERY_TTL_MS,
        id
      );
      this.applyRecoverySummary(id, exactSummary);
    }
    return this.status(id);
  }

  private async bindTerms(
    purchase: PurchaseRecord,
    intent: PurchaseIntent,
    initialEgress?: PurchaseEgressSession,
  ): Promise<void> {
    const discovered = await this.checkout.discover({
      purchaseId: purchase.id,
      resourceFingerprint: purchase.resourceFingerprint,
      egress: initialEgress ?? await this.createEgressSession(intent),
    });
    if (
      !VERIFIED_CHECKOUT_DISCOVERIES.has(discovered) ||
      evidenceDigest(discovered.checkoutEvidence.bytes) !== discovered.terms.checkoutDigest ||
      discovered.checkoutEvidence.verification.detailDigest !== checkoutTermsFactsDigest(discovered.terms)
    ) {
      throw new PurchaseCoordinatorError(
        "Checkout adapter did not return a runtime-verified semantic result",
        "checkout_verification_mismatch"
      );
    }
    const terms = validateCheckoutTerms(
      {
        purchaseId: purchase.id,
        resourceFingerprint: purchase.resourceFingerprint,
        expectedMerchant: intent.expectedMerchant,
      },
      discovered.terms,
      this.now
    );
    const checkoutEvidence = this.storeVerifiedArtifact(purchase.id, "checkout-terms", discovered.checkoutEvidence);
    const requirements = this.storeVerifiedArtifact(
      purchase.id,
      "payment-requirements",
      discovered.paymentRequirements
    );
    const executionPlanEvidence = this.journal.storeExecutionPlanEvidence(
      purchase.id,
      discovered.executionPlan
    );
    this.journal.bindCheckoutTerms(purchase.id, {
      terms: canonicalTermsCopy(terms),
      checkoutEvidenceDigest: checkoutEvidence,
      checkoutVerificationProfile: discovered.checkoutEvidence.verification.profile,
      checkoutVerifierId: discovered.checkoutEvidence.verification.verifierId,
      paymentRequirementsDigest: requirements,
      paymentRequirementsVerificationProfile: discovered.paymentRequirements.verification.profile,
      paymentRequirementsVerifierId: discovered.paymentRequirements.verification.verifierId,
      executionPlan: executionPlanEvidence.plan,
      executionPlanEvidenceDigest: executionPlanEvidence.evidenceDigest,
    });
  }

  private async createAuthorizationRequest(
    purchase: PurchaseRecord,
    intent: PurchaseIntent
  ): Promise<boolean> {
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    const executionPlan = this.journal.requireExecutionPlan(purchase.id);
    if (terms.expiresAtMs <= this.now()) {
      this.journal.transitionPurchase(
        purchase.id,
        "terms_bound",
        "expired",
        "checkout_terms_expired_before_authorization",
        terms.checkoutDigest
      );
      return true;
    }
    const selectedFinality = this.finality.selectFinality(
      "settlement",
      executionPlan.settlementAssurance === "confirmed" ? "confirmed" : "accepted"
    );
    if (
      executionPlan.mechanism === "channel-voucher" &&
      selectedFinality.effectiveFloor === "depth-confirmed"
    ) {
      throw new PurchaseCoordinatorError(
        "channel-voucher execution cannot satisfy a depth-confirmed Purchase Settlement floor",
        "unsupported_finality"
      );
    }
    const executionDeadlineMs = terms.expiresAtMs - (
      executionPlan.mechanism === "single-transaction"
        ? this.executionReserveMs
        : 0
    );
    if (executionDeadlineMs <= this.now()) {
      this.journal.transitionPurchase(
        purchase.id,
        "terms_bound",
        "expired",
        "checkout_execution_window_too_short",
        terms.checkoutDigest
      );
      return true;
    }
    const quote = await this.executionQuote(purchase.id, terms, executionPlan);
    if (!quote.ready) return false;
    if (executionDeadlineMs <= this.now()) {
      this.journal.transitionPurchase(
        purchase.id,
        "terms_bound",
        "expired",
        "checkout_execution_window_elapsed",
        terms.checkoutDigest
      );
      return true;
    }
    requireAtomicDecimal(quote.additionalCostCeilingAtomic, true, "Treasury additional-cost ceiling");
    const nonce = Buffer.from(this.entropy(32));
    if (nonce.byteLength !== 32) {
      throw new PurchaseCoordinatorError("authority nonce entropy must be exactly 32 bytes", "invalid_entropy");
    }
    const nonceDigest = evidenceDigest(nonce);
    const requestMediaType = canonicalMediaType(intent.resource.mediaType) ?? "";
    const requestBodyDigest = evidenceDigest(intent.resource.body ?? new Uint8Array());
    const envelopeWithoutDigest = {
      profile: PURCHASE_AUTHORIZATION_REQUEST_PROFILE,
      purchaseId: purchase.id,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      terms: canonicalTermsCopy(terms),
      nonce: nonce.toString("base64url"),
      nonceDigest,
      requestMediaType,
      requestBodyDigest,
      additionalCostCeilingAtomic: quote.additionalCostCeilingAtomic,
      operatorFinalityFloor: selectedFinality.operatorFloor,
      effectiveFinalityFloor: selectedFinality.effectiveFloor,
      depthConfirmationDaa: selectedFinality.depthConfirmationDaa,
      executionPlanDigest: executionPlan.digest,
      executionMechanism: executionPlan.mechanism,
      executionProfile: executionPlan.profile,
      settlementAssurance: executionPlan.settlementAssurance,
      maximumAuthorizedChargeAtomic: executionPlan.maximumChargeAtomic,
      ...(executionPlan.channelEpoch === undefined
        ? {}
        : {
            channelId: executionPlan.channelEpoch.channelId,
            channelEpochDigest: channelEpochDigest(executionPlan),
          }),
      expiresAtMs: executionDeadlineMs,
    };
    const bytes = Buffer.from(JSON.stringify(envelopeWithoutDigest), "utf8");
    const artifact = this.journal.storeEvidence(purchase.id, {
      bytes,
      mediaType: "application/json",
      profile: PURCHASE_AUTHORIZATION_REQUEST_PROFILE,
      issuer: "sompi-purchase-module",
      kind: "authorization-request",
    });
    this.journal.recordAuthorizationRequest(purchase.id, {
      checkoutDigest: terms.checkoutDigest,
      requestDigest: artifact.digest,
      nonceDigest,
      requestMediaType,
      requestBodyDigest,
      additionalCostCeilingAtomic: quote.additionalCostCeilingAtomic,
      effectiveFinalityFloor: selectedFinality.effectiveFloor,
      expiresAtMs: executionDeadlineMs,
    });
    return true;
  }

  private async executionQuote(
    purchaseId: PurchaseId,
    terms: CheckoutTerms,
    executionPlan: CanonicalPurchaseExecutionPlan
  ): Promise<TreasuryQuote> {
    return this.treasury.quote({
      purchaseId,
      fundingMode: executionPlan.mechanism === "channel-voucher"
        ? "precapitalized-channel"
        : "staged-payment",
      terms,
    });
  }

  private async requestAuthorization(purchase: PurchaseRecord): Promise<boolean> {
    const request = this.authorizationRequest(purchase);
    if (request.expiresAtMs <= this.now()) {
      this.journal.transitionPurchase(
        purchase.id,
        "awaiting_authority",
        "expired",
        "authorization_request_expired",
        request.requestDigest
      );
      return true;
    }
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    const checkoutArtifact = this.journal.requireEvidenceAttachment(
      purchase.id,
      terms.checkoutEvidenceDigest,
      "checkout-terms"
    );
    let response: AuthorityResult;
    try {
      response = await this.authority.request({
        request,
        checkoutEvidence: {
          bytes: this.journal.readEvidence(terms.checkoutEvidenceDigest),
          digest: terms.checkoutEvidenceDigest,
          mediaType: checkoutArtifact.mediaType,
          profile: checkoutArtifact.profile,
          issuer: checkoutArtifact.issuer,
        },
      });
    } catch (error) {
      // A human-present Authority can time out while this call is in flight.
      // Once the durable request deadline has elapsed, no Authority response
      // can authorize this Purchase, so project the terminal fact immediately
      // instead of leaking an adapter error and requiring a second API call.
      if (request.expiresAtMs <= this.now()) {
        this.journal.transitionPurchase(
          purchase.id,
          "awaiting_authority",
          "expired",
          "authorization_request_expired_during_prompt",
          request.requestDigest
        );
        return true;
      }
      throw error;
    }
    if (response.status === "pending") return false;
    const verified = assertVerifiedAuthorityDecision(response.decision);
    const signed = verified.evidence;
    const expectedFactsDigest = authorizationFactsDigest(request);
    if (
      signed.purchaseId !== purchase.id ||
      signed.checkoutDigest !== request.terms.checkoutDigest ||
      verified.facts.purchaseAuthorizationRequestDigest !== request.requestDigest ||
      verified.facts.purchaseAuthorizationNonceDigest !== request.nonceDigest ||
      verified.facts.purchaseAuthorizationFactsDigest !== expectedFactsDigest ||
      evidenceDigest(response.decisionEvidenceBytes) !== signed.evidenceDigest
    ) {
      throw new PurchaseCoordinatorError(
        "independently verified authority evidence does not bind the exact Purchase",
        "authorization_mismatch"
      );
    }
    const storedDecision = this.journal.storeEvidence(purchase.id, {
      bytes: response.decisionEvidenceBytes,
      mediaType: response.decisionEvidenceMediaType,
      profile: signed.verificationProfile,
      issuer: response.decisionEvidenceIssuer ?? signed.authorityId,
      kind: "purchase-authorization",
    });
    this.journal.recordEvidenceVerification(storedDecision.digest, {
      verifierId: signed.verifierId,
      profile: signed.verificationProfile,
      detailDigest: signed.factsDigest,
    });
    for (const supporting of response.supportingEvidence ?? []) {
      this.storeVerifiedArtifact(purchase.id, "authorization-supporting-evidence", supporting);
    }
    const decision = validateAuthorizationDecision(request, {
      purchaseId: purchase.id,
      checkoutDigest: request.terms.checkoutDigest,
      decision: signed.decision,
      authorityId: signed.authorityId,
      evidenceDigest: storedDecision.digest,
      facts: authorizationFacts(request),
    });
    this.journal.recordAuthorizationDecision(purchase.id, {
      decision: decision.decision,
      authorityId: decision.authorityId,
      checkoutDigest: decision.checkoutDigest,
      approvedFactsDigest: expectedFactsDigest,
      evidenceDigest: decision.evidenceDigest,
      verificationProfile: signed.verificationProfile,
      verifierId: signed.verifierId,
      requestDigest: request.requestDigest,
      nonceDigest: request.nonceDigest,
      expiresAtMs: request.expiresAtMs,
    });
    return true;
  }

  private async prepareExecution(purchase: PurchaseRecord): Promise<boolean> {
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    if (this.executionAuthorizationExpired(purchase.id)) {
      try {
        this.journal.expirePurchaseBeforeTreasury(purchase.id);
        return true;
      } catch (error) {
        if (error instanceof JournalEffectBusyError) return false;
        throw error;
      }
    }
    const authorization = this.journal.requireAuthorization(purchase.id);
    if (authorization.decision !== "approved") {
      throw new PurchaseCoordinatorError("authorized state has no approved authority fact", "authorization_invariant");
    }
    const approvedRequest = this.journal.requireAuthorizationRequest(purchase.id);
    const attemptNumber = 1;
    const identifier = createPaymentIdentifier(purchase.id, attemptNumber);
    const reservationId = `reservation:${identifier}`;
    const executionPlan = this.journal.requireExecutionPlan(purchase.id);
    let capacity;
    try {
      capacity = await this.treasury.reservePurchaseCapacity({
        reservationId,
        purchaseId: purchase.id,
        fundingMode: executionPlan.mechanism === "channel-voucher"
          ? "precapitalized-channel"
          : "staged-payment",
        terms,
        termsExpiresAtMs: terms.expiresAtMs,
        authorizedAdditionalCostCeilingAtomic:
          approvedRequest.additionalCostCeilingAtomic,
        authorization: {
          evidenceDigest: authorization.evidenceDigest,
          verificationProfile: authorization.verificationProfile,
          verifierId: authorization.verifierId,
          expiresAtMs: authorization.expiresAtMs,
        },
      });
    } catch (error) {
      if (error instanceof TreasuryCapacityError) {
        throw new PurchaseCoordinatorError(error.message, error.code, {
          cause: error,
        });
      }
      throw error;
    }
    if (capacity.status === "not_ready") return false;
    const reservation = capacity.reservation;
    if (reservation.state === "expired") {
      this.journal.transitionPurchase(
        purchase.id,
        "authorised",
        "expired",
        "treasury_reservation_expired",
        reservation.policyDigest
      );
      return true;
    }
    const existingAttempt = this.journal.paymentAttempts(purchase.id).at(-1);
    const stagedRecovery = existingAttempt
      ? this.journal.treasuryStagingRecoveryContext(
          purchase.id,
          existingAttempt.attempt,
        )
      : undefined;
    const stagedInFlight =
      reservation.state === "in_flight" &&
      stagedRecovery?.reservation.id === reservation.id &&
      stagedRecovery.plan.reservationId === reservation.id;
    if (reservation.state !== "active" && !stagedInFlight) {
      throw new PurchaseCoordinatorError(
        `authorized Purchase has unusable Treasury Reservation state ${reservation.state}`,
        "treasury_reservation_invariant"
      );
    }
    const attempt = this.journal.createPaymentAttempt({ purchaseId: purchase.id, attempt: attemptNumber, identifier });
    if (executionPlan.mechanism === "channel-voucher") {
      const preparation = await this.preparePaymentExecution(
        purchase,
        attemptNumber
      );
      this.journal.transitionPurchase(
        purchase.id,
        "authorised",
        "execution_prepared",
        "batch_voucher_prepared",
        preparation.payloadDigest
      );
      return true;
    }
    const existingStaging = this.journal.treasuryStagingRecoveryContext(
      purchase.id,
      attemptNumber
    );
    if (existingStaging) {
      this.journal.transitionPurchase(
        purchase.id,
        "authorised",
        "execution_prepared",
        "treasury_staging_recovered",
        existingStaging.plan.payloadDigest
      );
      return true;
    }
    if (attempt.state !== "planned") {
      throw new PurchaseCoordinatorError(
        `treasury staging requires a planned Payment Attempt, found ${attempt.state}`,
        "payment_invariant"
      );
    }
    const execution = this.purchaseExecutionContext(purchase.id, attemptNumber);
    const preparedCandidate = await this.treasury.prepareStaging({
      execution: execution.execution,
      request: execution.request,
      paymentRequirements: execution.paymentRequirements,
      additionalCostCeilingAtomic: reservation.additionalCostCeilingAtomic,
    });
    const preparedBytes = Uint8Array.from(preparedCandidate.preparedBytes);
    validatePreparedTreasuryStaging(
      preparedCandidate,
      preparedBytes,
      BigInt(terms.amountAtomic) + BigInt(reservation.additionalCostCeilingAtomic)
    );
    const staging = this.journal.planTreasuryStaging({
      purchaseId: purchase.id,
      attempt: attemptNumber,
      reservationId: reservation.id,
      idempotencyKey: `treasury-staging:${identifier}`,
      payloadDigest: preparedCandidate.preparedDigest,
      preparedBytes,
      plannedTransactionId: preparedCandidate.transactionId,
      expectedOutpoint: preparedCandidate.expectedOutpoint,
      stagingAmountAtomic: preparedCandidate.stagingAmountAtomic,
      fundingSource: preparedCandidate.fundingSource,
    });
    this.journal.transitionPurchase(
      purchase.id,
      "authorised",
      "execution_prepared",
      "treasury_staging_prepared",
      staging.payloadDigest
    );
    return true;
  }

  private async submitExecution(purchase: PurchaseRecord): Promise<boolean> {
    const attempt = this.journal.paymentAttempts(purchase.id).at(-1);
    if (!attempt) throw new PurchaseCoordinatorError("prepared Purchase has no Payment Attempt", "payment_invariant");
    const executionPlan = this.journal.requireExecutionPlan(purchase.id);
    if (executionPlan.mechanism === "channel-voucher") {
      this.journal.requirePaymentPreparation(purchase.id, attempt.attempt);
      return this.submitPreparedPayment(purchase, attempt.attempt);
    }
    const staging = this.journal.treasuryStagingRecoveryContext(purchase.id, attempt.attempt);
    if (!staging) {
      throw new PurchaseCoordinatorError(
        "prepared Purchase has no durable Treasury staging plan",
        "treasury_staging_invariant"
      );
    }
    this.journal.expireReservations();
    let reservation = this.journal.requireReservation(staging.plan.reservationId);
    if (
      reservation.state === "expired" &&
      staging.effect.state === "planned" &&
      !staging.observation
    ) {
      this.journal.abandonExpiredTreasuryStaging(staging.effect.id, reservation.id);
      return true;
    }
    if (!staging.observation) {
      return this.submitTreasuryStaging(purchase, staging.effect.id, attempt.attempt);
    }

    const terms = this.journal.requireCheckoutTerms(purchase.id);
    if (this.executionAuthorizationExpired(purchase.id) && attempt.state === "planned") {
      this.journal.blockExpiredStagedPurchase(purchase.id);
      return false;
    }

    await this.preparePaymentExecution(
      purchase,
      attempt.attempt,
      staging.observation
    );
    return this.submitPreparedPayment(purchase, attempt.attempt);
  }

  private async submitPreparedPayment(
    purchase: PurchaseRecord,
    attemptNumber: number
  ): Promise<boolean> {
    const preparation = this.journal.requirePaymentPreparation(
      purchase.id,
      attemptNumber
    );
    this.journal.expireReservations();
    const reservation = this.journal.requireReservation(preparation.reservationId);
    const effect = this.paymentEffect(purchase.id)!;
    const executionPlan = this.journal.requireExecutionPlan(purchase.id);
    const preparedAttempt = this.journal.requirePaymentAttempt(
      purchase.id,
      attemptNumber
    );
    if (
      this.executionAuthorizationExpired(purchase.id) &&
      preparedAttempt.state === "prepared" &&
      (effect.state === "planned" || effect.state === "retryable")
    ) {
      if (executionPlan.mechanism === "single-transaction") {
        this.journal.blockExpiredStagedPurchase(purchase.id);
      } else if (effect.state === "planned" && reservation.state === "expired") {
        this.journal.abandonExpiredPreparedPayment(effect.id, reservation.id);
      }
      return false;
    }
    if (
      effect.state !== "retryable" && (
        ["submitted", "observed", "failed"].includes(preparedAttempt.state) ||
        ["executing", "submitted", "ambiguous", "observed", "failed_terminal"].includes(effect.state)
      )
    ) {
      this.journal.transitionPurchase(
        purchase.id,
        "execution_prepared",
        "submitted",
        "payment_submission_recovered",
        effect.submissionDigest ?? effect.payloadDigest
      );
      const spend = this.journal.findSettlementForPurchase(purchase.id);
      if (spend) {
        this.journal.transitionPurchase(
          purchase.id,
          "submitted",
          "settled",
          "recovered_settlement_fact",
          spend.evidenceDigest
        );
      } else if (effect.state === "failed_terminal") {
        this.journal.transitionPurchase(
          purchase.id,
          "submitted",
          "failed_recoverable",
          "terminal_payment_observation_requires_accounting_resolution",
          effect.resultDigest ?? effect.payloadDigest
        );
      }
      return false;
    }
    const claim = this.journal.beginPaymentSubmission(
      effect.id,
      reservation.id,
      `${this.workerId}-payment`,
      this.effectLeaseTtlMs
    );
    if (!claim) return false;
    this.journal.transitionPurchase(
      purchase.id,
      "execution_prepared",
      "submitted",
      "payment_submission_claimed",
      preparation.payloadDigest
    );
    let lease = claim.lease;
    let leaseLost: unknown;
    let verifiedPaidResponse: Extract<FulfilmentResult, { status: "fulfilled" }> | undefined;
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        lease = this.journal.renewLease(lease, this.effectLeaseTtlMs);
      } catch (error) {
        leaseLost = error;
        abortController.abort();
      }
    }, Math.max(10, Math.floor(this.effectLeaseTtlMs / 3)));
    heartbeat.unref();
    try {
      const result = await this.payment.submit({
        context: this.preparedPaymentContext(purchase.id, attemptNumber),
        effect: claim.effect,
        egress: await this.createEgressSession(this.persistedIntent(purchase.id)!),
        signal: abortController.signal,
      });
      if (leaseLost) throw leaseLost;
      const activeClaim: EffectClaim = { effect: claim.effect, lease };
      this.journal.markEffectSubmitted(activeClaim, result.submissionDigest);
      if (result.status === "settled") {
        this.recordSettlement(purchase, activeClaim, result.settlement);
        verifiedPaidResponse = result.paidResponse;
      }
    } catch (error) {
      const detail = safeErrorDigest("payment-submit", error);
      try {
        if (!leaseLost) this.journal.markEffectAmbiguous({ effect: claim.effect, lease }, detail);
      } finally {
        const current = this.journal.requirePurchase(purchase.id);
        if (current.state === "submitted") {
          this.journal.transitionPurchase(
            purchase.id,
            "submitted",
            "failed_recoverable",
            "payment_submission_ambiguous",
            detail
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (!leaseLost) this.journal.releaseLease(lease);
    }
    // Settlement has already been durably observed at this point. Fulfilment
    // persistence is a later lifecycle step and must never relabel the payment
    // Effect ambiguous if its own atomic transaction is interrupted.
    if (verifiedPaidResponse) {
      this.persistFulfilmentResult(
        this.journal.requirePurchase(purchase.id),
        verifiedPaidResponse
      );
    }
    return true;
  }

  private async submitTreasuryStaging(
    purchase: PurchaseRecord,
    effectId: string,
    attemptNumber: number
  ): Promise<boolean> {
    const recovery = this.journal.treasuryStagingRecoveryContext(
      purchase.id,
      attemptNumber
    );
    if (!recovery || recovery.effect.id !== effectId) {
      throw new PurchaseCoordinatorError(
        "Treasury staging recovery facts are inconsistent",
        "treasury_staging_invariant"
      );
    }
    if (recovery.observation) return true;
    if (
      ["executing", "submitted", "ambiguous", "failed_terminal"].includes(
        recovery.effect.state
      )
    ) {
      if (purchase.state === "execution_prepared") {
        this.journal.transitionPurchase(
          purchase.id,
          "execution_prepared",
          "failed_recoverable",
          "treasury_staging_requires_reconciliation",
          recovery.effect.submissionDigest ??
            recovery.effect.resultDigest ??
            recovery.effect.payloadDigest
        );
      }
      return false;
    }
    const claim = this.journal.beginTreasuryStaging(
      recovery.effect.id,
      recovery.plan.reservationId,
      `${this.workerId}-treasury-staging`,
      this.effectLeaseTtlMs
    );
    if (!claim) return false;
    let lease = claim.lease;
    let leaseLost: unknown;
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        lease = this.journal.renewLease(lease, this.effectLeaseTtlMs);
      } catch (error) {
        leaseLost = error;
        abortController.abort();
      }
    }, Math.max(10, Math.floor(this.effectLeaseTtlMs / 3)));
    heartbeat.unref();
    try {
      const result = await this.treasury.submitStaging({
        context: this.treasuryStagingContext(purchase.id, attemptNumber),
        effect: claim.effect,
        signal: abortController.signal,
      });
      if (leaseLost) throw leaseLost;
      const activeClaim: EffectClaim = { effect: claim.effect, lease };
      this.journal.markEffectSubmitted(activeClaim, result.submissionDigest);
      if (result.status === "staged") {
        this.recordTreasuryStaging(purchase.id, attemptNumber, activeClaim, result.staging);
        return true;
      }
      this.journal.transitionPurchase(
        purchase.id,
        "execution_prepared",
        "failed_recoverable",
        "treasury_staging_submitted_unobserved",
        result.submissionDigest
      );
      return false;
    } catch (error) {
      const detail = safeErrorDigest("treasury-staging-submit", error);
      try {
        if (!leaseLost) this.journal.markEffectAmbiguous({ effect: claim.effect, lease }, detail);
      } finally {
        const current = this.journal.requirePurchase(purchase.id);
        if (current.state === "execution_prepared") {
          this.journal.transitionPurchase(
            purchase.id,
            "execution_prepared",
            "failed_recoverable",
            "treasury_staging_submission_ambiguous",
            detail
          );
        }
      }
      return false;
    } finally {
      clearInterval(heartbeat);
      if (!leaseLost) this.journal.releaseLease(lease);
    }
  }

  private async preparePaymentExecution(
    purchase: PurchaseRecord,
    attemptNumber: number,
    staging?: TreasuryStagingObservationRecord
  ) {
    let existing;
    try {
      existing = this.journal.requirePaymentPreparation(purchase.id, attemptNumber);
    } catch (error) {
      if (!(error instanceof JournalNotFoundError)) throw error;
    }
    const attempt = this.journal.requirePaymentAttempt(purchase.id, attemptNumber);
    if (existing) {
      const existingBytes = this.journal.readPreparedPayment(purchase.id, attemptNumber);
      this.journal.planEffect({
        purchaseId: purchase.id,
        attempt: attemptNumber,
        kind: PAYMENT_EFFECT_KIND,
        idempotencyKey: `payment:${attempt.identifier}`,
        payloadDigest: existing.payloadDigest,
        preparedBytes: existingBytes,
      });
      return existing;
    }
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    const reservation = this.journal.findReservationForPurchase(purchase.id);
    if (!reservation) {
      throw new PurchaseCoordinatorError(
        "Purchase execution has no durable Treasury reservation",
        "treasury_reservation_invariant"
      );
    }
    const executionPlan = this.journal.requireExecutionPlan(purchase.id);
    if (executionPlan.mechanism === "single-transaction" && !staging) {
      throw new PurchaseCoordinatorError(
        "single-transaction execution has no observed Treasury staging output",
        "treasury_staging_invariant"
      );
    }
    if (executionPlan.mechanism === "channel-voucher" && staging) {
      throw new PurchaseCoordinatorError(
        "channel voucher execution cannot consume per-Purchase Treasury staging",
        "treasury_staging_invariant"
      );
    }
    const execution = this.purchaseExecutionContext(purchase.id, attemptNumber);
    const stagedOutput = staging ? stagingOutput(staging) : undefined;
    const preparedCandidate = await this.payment.prepare({
      execution: execution.execution,
      request: execution.request,
      paymentRequirements: execution.paymentRequirements,
      ...(stagedOutput === undefined ? {} : { staging: stagedOutput }),
      additionalCostCeilingAtomic: reservation.additionalCostCeilingAtomic,
    });
    const prepared = validatePreparedPayment(
      execution.execution,
      preparedCandidate,
      this.now
    );
    const preparedBytes = Uint8Array.from(preparedCandidate.preparedBytes);
    if (preparedBytes.byteLength === 0 || evidenceDigest(preparedBytes) !== prepared.preparedDigest) {
      throw new PurchaseCoordinatorError(
        "prepared payment bytes do not match their declared digest",
        "preparation_mismatch"
      );
    }
    if (preparedCandidate.requirementsDigest !== terms.paymentRequirementsDigest) {
      throw new PurchaseCoordinatorError(
        "prepared payment is bound to different payment requirements",
        "preparation_mismatch"
      );
    }
    if (
      preparedCandidate.mechanism !== executionPlan.mechanism ||
      preparedCandidate.profile !== executionPlan.profile ||
      preparedCandidate.requiredAssurance !== executionPlan.settlementAssurance
    ) {
      throw new PurchaseCoordinatorError(
        "prepared execution does not match the authorized Purchase execution plan",
        "preparation_mismatch"
      );
    }
    if (preparedCandidate.fundingSource !== "vault-treasury") {
      throw new PurchaseCoordinatorError(
        "prepared payment used an unauthorized funding source",
        "preparation_mismatch"
      );
    }
    const preparation = this.journal.preparePaymentAttempt({
      purchaseId: purchase.id,
      attempt: attemptNumber,
      reservationId: reservation.id,
      requirementsDigest: terms.paymentRequirementsDigest,
      payloadDigest: prepared.preparedDigest,
      preparedBytes,
      executionId: preparedCandidate.executionId,
      mechanism: preparedCandidate.mechanism,
      profile: preparedCandidate.profile,
      transactionId: preparedCandidate.transactionId,
      amountAtomic: terms.amountAtomic,
      asset: terms.asset,
      network: terms.network,
      payee: terms.payTo,
      requiredAssurance: preparedCandidate.requiredAssurance,
      fundingSource: preparedCandidate.fundingSource,
    });
    this.journal.planEffect({
      purchaseId: purchase.id,
      attempt: attemptNumber,
      kind: PAYMENT_EFFECT_KIND,
      idempotencyKey: `payment:${attempt.identifier}`,
      payloadDigest: preparation.payloadDigest,
      preparedBytes,
    });
    return preparation;
  }

  private recordTreasuryStaging(
    purchaseId: PurchaseId,
    attemptNumber: number,
    claim: EffectClaim,
    staging: TreasuryStagingResult
  ): void {
    const input = this.validatedTreasuryStagingInput(
      purchaseId,
      attemptNumber,
      claim.effect.id,
      staging
    );
    this.journal.recordObservedTreasuryStaging(claim.lease, input);
  }

  private recordSettlement(purchase: PurchaseRecord, claim: EffectClaim, settlement: SettlementResult): void {
    const input = this.validatedSettlementInput(purchase, claim.effect.id, settlement);
    this.journal.recordPurchaseSettlement(claim.lease, input);
    const digest = input.evidenceDigest;
    const current = this.journal.requirePurchase(purchase.id);
    if (current.state === "submitted" || current.state === "failed_recoverable") {
      this.journal.transitionPurchase(
        purchase.id,
        current.state,
        "settled",
        "kaspa_settlement_verified",
        digest
      );
    }
  }

  private validatedSettlementInput(
    purchase: PurchaseRecord,
    effectId: string,
    settlement: SettlementResult
  ): RecordPurchaseSettlementInput {
    const effect = this.journal.requireEffect(effectId);
    if (effect.attempt === undefined) throw new PurchaseCoordinatorError("Settlement has no Payment Attempt", "settlement_invariant");
    const preparation = this.journal.requirePaymentPreparation(purchase.id, effect.attempt);
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    const exact: ReadonlyArray<[string, string | undefined, string | undefined]> = [
      ["execution", settlement.executionId, preparation.executionId],
      ["mechanism", settlement.mechanism, preparation.mechanism],
      ["profile", settlement.profile, preparation.profile],
      ["transaction", settlement.transactionId, preparation.transactionId],
      ["asset", settlement.asset, terms.asset],
      ["network", settlement.network, terms.network],
      ["payee", settlement.payTo, terms.payTo],
      ["funding source", settlement.fundingSource, preparation.fundingSource],
    ];
    for (const [field, actual, expected] of exact) {
      if (actual !== expected) {
        throw new PurchaseCoordinatorError(`Settlement ${field} does not match immutable preparation`, "settlement_mismatch");
      }
    }
    const actualAmount = requireAtomicDecimal(
      settlement.amountAtomic,
      false,
      "Settlement amount"
    );
    const maximumAmount = requireAtomicDecimal(
      terms.amountAtomic,
      false,
      "authorized Purchase amount"
    );
    if (
      (settlement.mechanism === "single-transaction" && actualAmount !== maximumAmount) ||
      (settlement.mechanism === "channel-voucher" && actualAmount > maximumAmount)
    ) {
      throw new PurchaseCoordinatorError(
        "Settlement charge exceeds or changes the authorized execution amount",
        "settlement_mismatch"
      );
    }
    if (
      (settlement.mechanism === "single-transaction" &&
        (settlement.transactionId === undefined || settlement.commitmentId !== undefined)) ||
      (settlement.mechanism === "channel-voucher" &&
        (settlement.transactionId !== undefined || settlement.commitmentId === undefined))
    ) {
      throw new PurchaseCoordinatorError(
        "Settlement confirmation identity does not match its execution mechanism",
        "settlement_mismatch"
      );
    }
    if (!executionAssuranceMeets(settlement.settlementAssurance, preparation.requiredAssurance)) {
      throw new PurchaseCoordinatorError(
        "Settlement assurance does not meet immutable preparation",
        "settlement_mismatch"
      );
    }
    requireAtomicDecimal(settlement.additionalCostAtomic, true, "Settlement additional cost");
    if (
      settlement.mechanism === "channel-voucher" &&
      settlement.additionalCostAtomic !== "0"
    ) {
      throw new PurchaseCoordinatorError(
        "channel voucher Purchase cannot charge a per-Purchase network fee",
        "settlement_mismatch"
      );
    }
    const digest = this.storeVerifiedArtifact(
      purchase.id,
      "kaspa-settlement",
      settlement.evidence,
      effect.attempt
    );
    return {
      effectId: effect.id,
      reservationId: preparation.reservationId,
      executionId: settlement.executionId,
      mechanism: settlement.mechanism,
      profile: settlement.profile,
      transactionId: settlement.transactionId,
      commitmentId: settlement.commitmentId,
      outpoint: settlement.outpoint,
      actualAmountAtomic: settlement.amountAtomic,
      actualAdditionalCostAtomic: settlement.additionalCostAtomic,
      asset: settlement.asset,
      payee: settlement.payTo,
      network: settlement.network,
      settlementAssurance: settlement.settlementAssurance,
      fundingSource: settlement.fundingSource,
      evidenceDigest: digest,
      evidenceVerificationProfile: settlement.evidence.verification.profile,
      evidenceVerifierId: settlement.evidence.verification.verifierId,
    };
  }

  private validatedTreasuryStagingInput(
    purchaseId: PurchaseId,
    attemptNumber: number,
    effectId: string,
    staging: TreasuryStagingResult
  ): RecordObservedTreasuryStagingInput {
    const recovery = this.journal.treasuryStagingRecoveryContext(
      purchaseId,
      attemptNumber
    );
    if (!recovery || recovery.effect.id !== effectId) {
      throw new PurchaseCoordinatorError(
        "Treasury staging result has no matching immutable plan",
        "treasury_staging_mismatch"
      );
    }
    const exact: ReadonlyArray<[string, string, string]> = [
      ["transaction", staging.transactionId, recovery.plan.plannedTransactionId],
      ["outpoint", staging.outpoint, recovery.plan.expectedOutpoint],
      ["amount", staging.stagingAmountAtomic, recovery.plan.stagingAmountAtomic],
      ["funding source", staging.fundingSource, recovery.plan.fundingSource],
    ];
    for (const [field, actual, expected] of exact) {
      if (actual !== expected) {
        throw new PurchaseCoordinatorError(
          `Treasury staging ${field} does not match its immutable plan`,
          "treasury_staging_mismatch"
        );
      }
    }
    const digest = this.storeVerifiedArtifact(
      purchaseId,
      TREASURY_STAGING_EVIDENCE_KIND,
      staging.evidence,
      attemptNumber
    );
    return {
      effectId,
      reservationId: recovery.plan.reservationId,
      transactionId: staging.transactionId,
      outpoint: staging.outpoint,
      stagingAmountAtomic: staging.stagingAmountAtomic,
      fundingSource: staging.fundingSource,
      evidenceDigest: digest,
      evidenceVerificationProfile: staging.evidence.verification.profile,
      evidenceVerifierId: staging.evidence.verification.verifierId,
    };
  }

  private async observePaymentEffect(effect: EffectRecord): Promise<ReconciliationObservation> {
    if (effect.attempt === undefined) {
      throw new PurchaseCoordinatorError("payment Effect has no Payment Attempt", "payment_invariant");
    }
    const intent = this.persistedIntent(effect.purchaseId);
    if (!intent) throw new PurchaseCoordinatorError("payment recovery lost its persisted request", "request_invariant");
    const observation = await this.payment.observe({
      context: this.preparedPaymentContext(effect.purchaseId, effect.attempt),
      effect,
      egress: await this.createEgressSession(intent),
    });
    if (observation.status !== "settled") return observation;
    const purchase = this.journal.requirePurchase(effect.purchaseId);
    const spend = this.validatedSettlementInput(purchase, effect.id, observation.settlement);
    return { status: "spend_observed", spend: omitEffectId(spend) };
  }

  private async observeTreasuryStagingEffect(
    effect: EffectRecord
  ): Promise<ReconciliationObservation> {
    if (effect.attempt === undefined) {
      throw new PurchaseCoordinatorError(
        "Treasury staging Effect has no Payment Attempt",
        "treasury_staging_invariant"
      );
    }
    const observation = await this.treasury.observeStaging({
      context: this.treasuryStagingContext(effect.purchaseId, effect.attempt),
      effect,
    });
    if (observation.status !== "staged") return observation;
    const staging = this.validatedTreasuryStagingInput(
      effect.purchaseId,
      effect.attempt,
      effect.id,
      observation.staging
    );
    return {
      status: "treasury_staging_observed",
      staging: omitEffectId(staging),
    };
  }

  private async obtainFulfilment(purchase: PurchaseRecord, intent: PurchaseIntent): Promise<boolean> {
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    const attempt = this.journal.paymentAttempts(purchase.id).at(-1);
    const spend = this.journal.findSettlementForPurchase(purchase.id);
    if (!attempt || !spend) throw new PurchaseCoordinatorError("settled Purchase lacks payment facts", "settlement_invariant");
    const egress = await this.createEgressSession(intent);
    const replayed = this.payment.recoverFulfilment
      ? await this.payment.recoverFulfilment({
          context: this.preparedPaymentContext(purchase.id, attempt.attempt),
          egress,
        })
      : { status: "pending" as const };
    const result = replayed.status === "fulfilled" ? replayed : await this.fulfilment.obtain({
      purchaseId: purchase.id,
      egress,
      terms,
      paymentIdentifier: attempt.identifier,
      authorizationEvidenceDigest: this.journal.requireAuthorization(purchase.id).evidenceDigest,
      settlementEvidenceDigest: spend.evidenceDigest,
    });
    if (result.status === "pending") return false;
    return this.persistFulfilmentResult(purchase, result);
  }

  private persistFulfilmentResult(
    purchase: PurchaseRecord,
    result: Extract<FulfilmentResult, { status: "fulfilled" }>
  ): boolean {
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    const attempt = this.journal.paymentAttempts(purchase.id).at(-1);
    const spend = this.journal.findSettlementForPurchase(purchase.id);
    if (!attempt || !spend) {
      throw new PurchaseCoordinatorError("settled Purchase lacks payment facts", "settlement_invariant");
    }
    if (result.resourceFingerprint !== terms.resourceFingerprint) {
      throw new PurchaseCoordinatorError("Fulfilment resource does not match the Purchase", "fulfilment_mismatch");
    }
    const body = this.journal.storeEvidence(purchase.id, {
      bytes: result.body,
      mediaType: result.mediaType,
      profile: "urn:sompi:fulfilment-body:1",
      issuer: terms.merchant.id,
      kind: "fulfilment-body",
      attempt: attempt.attempt,
    });
    const merchantEvidence = this.storeVerifiedArtifact(
      purchase.id,
      "merchant-fulfilment",
      result.merchantEvidence,
      attempt.attempt
    );
    const receipt = result.receipt;
    if (
      receipt.checkoutDigest !== terms.checkoutDigest ||
      receipt.authorizationEvidenceDigest !== this.journal.requireAuthorization(purchase.id).evidenceDigest ||
      receipt.settlementEvidenceDigest !== spend.evidenceDigest ||
      receipt.fulfilmentDigest !== body.digest
    ) {
      throw new PurchaseCoordinatorError("Receipt does not join exact Purchase evidence", "receipt_mismatch");
    }
    const receiptEvidence = this.storeVerifiedArtifact(
      purchase.id,
      "purchase-receipt",
      receipt.evidence
    );
    this.journal.recordFulfilment(
      purchase.id,
      {
        attempt: attempt.attempt,
        httpStatus: result.httpStatus,
        resourceFingerprint: result.resourceFingerprint,
        bodyDigest: body.digest,
        bodyByteLength: body.byteLength,
        mediaType: result.mediaType,
        merchantEvidenceDigest: merchantEvidence,
        merchantVerificationProfile: result.merchantEvidence.verification.profile,
        merchantVerifierId: result.merchantEvidence.verification.verifierId,
      },
      [{
        evidenceDigest: receiptEvidence,
        profile: receipt.evidence.verification.profile,
        issuer: receipt.evidence.issuer,
        verifierId: receipt.evidence.verification.verifierId,
        checkoutDigest: receipt.checkoutDigest,
        authorizationEvidenceDigest: receipt.authorizationEvidenceDigest,
        settlementEvidenceDigest: receipt.settlementEvidenceDigest,
        fulfilmentDigest: receipt.fulfilmentDigest,
      }]
    );
    return this.journal.requirePurchase(purchase.id).state === "receipted";
  }

  private async recoverAbandonedStaging(
    purchaseId: PurchaseId
  ): Promise<"none" | "pending" | "exact_payment_won" | "recovery_won" | "conflict"> {
    const attempts = this.journal.paymentAttempts(purchaseId);
    if (attempts.length !== 1) return "none";
    const attempt = attempts[0];
    let recovery = this.journal.treasuryStagingRecoveryJournalContext(
      purchaseId,
      attempt.attempt
    );
    // A settlement normally means no recovery race is needed. If a race was
    // already durably planned, however, it must still observe the exact winner
    // and close its Effect; otherwise a completed Purchase is projected as
    // requiring recovery forever.
    if (this.journal.findSettlementForPurchase(purchaseId) && !recovery) {
      return "none";
    }
    const staged = this.journal.treasuryStagingRecoveryContext(
      purchaseId,
      attempt.attempt
    );
    if (
      !staged?.observation ||
      (!recovery && staged.reservation.state !== "in_flight")
    ) {
      return "none";
    }
    if (!recovery) {
      const purchase = this.journal.requirePurchase(purchaseId);
      const paymentEffect = this.paymentEffect(purchaseId, false);
      const terminalPayment = Boolean(
        paymentEffect && ["failed_terminal", "abandoned"].includes(paymentEffect.state)
      );
      if (
        purchase.state !== "failed_recoverable" ||
        (!this.executionAuthorizationExpired(purchaseId) && !terminalPayment)
      ) {
        return "none";
      }
      const planningLease = this.journal.acquireLease(
        `treasury-staging-recovery-plan:${purchaseId}`,
        `${this.workerId}-staging-recovery-plan`,
        this.effectLeaseTtlMs
      );
      if (!planningLease) return "pending";
      try {
        recovery = this.journal.treasuryStagingRecoveryJournalContext(
          purchaseId,
          attempt.attempt
        );
        if (!recovery) {
          let exactPayment:
            | StagingRecoveryPreparationContext["exactPayment"]
            | undefined;
          try {
            const preparation = this.journal.requirePaymentPreparation(
              purchaseId,
              attempt.attempt
            );
            if (preparation.mechanism === "single-transaction" && preparation.transactionId) {
              exactPayment = {
                preparedBytes: this.journal.readPreparedPayment(
                  purchaseId,
                  attempt.attempt
                ),
                preparedDigest: preparation.payloadDigest,
                transactionId: preparation.transactionId,
                requiredFinality: preparation.requiredAssurance,
              };
            }
          } catch (error) {
            if (!(error instanceof JournalNotFoundError)) throw error;
          }
          const terms = this.journal.requireCheckoutTerms(purchaseId);
          const prepared = await this.treasury.prepareStagingRecovery({
            purchaseId,
            paymentIdentifier: attempt.identifier,
            terms: canonicalTermsCopy(terms),
            paymentRequirements: this.journal.readEvidence(
              terms.paymentRequirementsDigest
            ),
            stagingEvidenceDigest: staged.observation.evidenceDigest,
            exactPayment,
            authorizedAdditionalCostCeilingAtomic:
              staged.reservation.additionalCostCeilingAtomic,
          });
          validatePreparedStagingRecovery(
            prepared,
            exactPayment?.transactionId,
            staged.observation.stagingAmountAtomic
          );
          this.journal.planTreasuryStagingRecovery({
            purchaseId,
            attempt: attempt.attempt,
            reservationId: staged.reservation.id,
            stagingEffectId: staged.effect.id,
            idempotencyKey: `treasury-staging-recovery:${attempt.identifier}`,
            payloadDigest: prepared.preparedDigest,
            preparedBytes: Uint8Array.from(prepared.preparedBytes),
            exactTransactionId: prepared.exactTransactionId,
            recoveryTransactionId: prepared.recoveryTransactionId,
            recoveryOutpoint: prepared.recoveryOutpoint,
            recoveryAmountAtomic: prepared.recoveryAmountAtomic,
            stagingFeeAtomic: prepared.stagingFeeAtomic,
            recoveryFeeAtomic: prepared.recoveryFeeAtomic,
            requiredFinality: prepared.requiredFinality,
            authorizedAdditionalCostCeilingAtomic:
              staged.reservation.additionalCostCeilingAtomic,
          });
          recovery = this.journal.treasuryStagingRecoveryJournalContext(
            purchaseId,
            attempt.attempt
          );
        }
      } finally {
        this.journal.releaseLease(planningLease);
      }
    }
    if (!recovery) return "pending";
    return this.driveStagingRecovery(recovery);
  }

  private async driveStagingRecovery(
    recovery: TreasuryStagingRecoveryJournalContext
  ): Promise<"pending" | "exact_payment_won" | "recovery_won" | "conflict"> {
    if (recovery.accounting) return "recovery_won";
    if (recovery.effect.state === "observed") return "exact_payment_won";
    if (recovery.effect.state === "failed_terminal") return "conflict";
    if (recovery.effect.state === "planned" || recovery.effect.state === "retryable") {
      const claim = this.journal.beginTreasuryStagingRecovery(
        recovery.effect.id,
        `${this.workerId}-staging-recovery`,
        this.effectLeaseTtlMs
      );
      if (!claim) return "pending";
      let lease = claim.lease;
      let leaseLost: unknown;
      const abortController = new AbortController();
      const heartbeat = setInterval(() => {
        if (leaseLost) return;
        try {
          lease = this.journal.renewLease(lease, this.effectLeaseTtlMs);
        } catch (error) {
          leaseLost = error;
          abortController.abort();
        }
      }, Math.max(10, Math.floor(this.effectLeaseTtlMs / 3)));
      heartbeat.unref();
      try {
        const preparedBytes = this.journal.readPreparedTreasuryStagingRecovery(
          recovery.plan.purchaseId,
          recovery.plan.attempt
        );
        const observed = await this.treasury.observeStagingRecovery({
          preparedBytes,
          signal: abortController.signal,
        });
        if (leaseLost) throw leaseLost;
        const outcome = this.recordStagingRecoveryObservation(
          recovery.effect.id,
          lease,
          observed
        );
        if (observed.status !== "safe_to_submit") return outcome;
        // The readiness was observed and durably recorded under this exact
        // live Effect fence. The adapter token is intentionally never stored.
        const submitted = await this.treasury.submitStagingRecovery({
          preparedBytes,
          readiness: observed.readiness,
          signal: abortController.signal,
        });
        if (leaseLost) throw leaseLost;
        const activeClaim: EffectClaim = { effect: claim.effect, lease };
        if (submitted.status === "accepted") {
          this.journal.markEffectSubmitted(activeClaim, submitted.submissionDigest);
        } else {
          this.journal.markEffectAmbiguous(activeClaim, submitted.submissionDigest);
        }
        return "pending";
      } catch (error) {
        if (!leaseLost) {
          const current = this.journal.requireEffect(recovery.effect.id);
          if (current.state === "executing" || current.state === "submitted") {
            this.journal.markEffectAmbiguous(
              { effect: claim.effect, lease },
              safeErrorDigest("staging-recovery-submit", error)
            );
          }
        }
        return "pending";
      } finally {
        clearInterval(heartbeat);
        if (!leaseLost) this.journal.releaseLease(lease);
      }
    }

    const reconcileLease = this.journal.acquireLease(
      `purchase-reconciliation:${recovery.plan.purchaseId}`,
      `${this.workerId}-staging-recovery-observer`,
      RECOVERY_TTL_MS
    );
    if (!reconcileLease) return "pending";
    try {
      if (this.journal.effectClaimActive(recovery.effect.id)) return "pending";
      const observed = await this.treasury.observeStagingRecovery({
        preparedBytes: this.journal.readPreparedTreasuryStagingRecovery(
          recovery.plan.purchaseId,
          recovery.plan.attempt
        ),
      });
      const outcome = this.recordStagingRecoveryObservation(
        recovery.effect.id,
        reconcileLease,
        observed
      );
      if (observed.status === "safe_to_submit") {
        const refreshed = this.journal.treasuryStagingRecoveryJournalContext(
          recovery.plan.purchaseId,
          recovery.plan.attempt
        )!;
        this.journal.releaseLease(reconcileLease);
        return this.driveStagingRecovery(refreshed);
      }
      return outcome;
    } catch (error) {
      if (error instanceof JournalEffectBusyError) return "pending";
      throw error;
    } finally {
      // A safe-to-submit observation releases before claiming the Effect.
      try {
        this.journal.releaseLease(reconcileLease);
      } catch {
        // Already released before the fresh fenced observation.
      }
    }
  }

  private recordStagingRecoveryObservation(
    effectId: string,
    lease: Parameters<PurchaseJournal["recordTreasuryStagingRecoveryObservation"]>[1],
    observed: Readonly<StagingRecoveryObservation>
  ): "pending" | "exact_payment_won" | "recovery_won" | "conflict" {
    this.journal.recordTreasuryStagingRecoveryObservation(
      effectId,
      lease,
      stagingRecoveryJournalObservation(observed)
    );
    switch (observed.status) {
      case "safe_to_submit":
      case "pending":
        return "pending";
      case "exact_payment_won":
        return "exact_payment_won";
      case "recovery_won":
        return "recovery_won";
      case "conflict":
        return "conflict";
    }
  }

  private resumeProofBackedState(purchase: PurchaseRecord): boolean {
    const spend = this.journal.findSettlementForPurchase(purchase.id);
    if (spend) {
      this.journal.transitionPurchase(
        purchase.id,
        "failed_recoverable",
        "settled",
        "recovery_settlement_already_observed",
        spend.evidenceDigest
      );
      return true;
    }
    const effect = this.paymentEffect(purchase.id, false);
    if (effect?.state === "retryable") {
      if (this.executionAuthorizationExpired(purchase.id)) {
        // A proof-backed retry is still a new Merchant payment submission.
        // Once authority expires, only resolution of the already-staged funds
        // may continue; the dedicated staging-recovery race owns that path.
        return false;
      }
      const proof = this.journal.effectObservations(effect.id).at(-1)?.detailDigest;
      if (!proof) throw new PurchaseCoordinatorError("retryable Effect has no observation proof", "recovery_invariant");
      this.journal.transitionPurchase(
        purchase.id,
        "failed_recoverable",
        "execution_prepared",
        "proof_backed_payment_retry",
        proof
      );
      return true;
    }
    const attempt = this.journal.paymentAttempts(purchase.id).at(-1);
    if (
      attempt?.state === "failed" &&
      attempt.failureCode === "checkout_expired_after_staging"
    ) {
      return false;
    }
    const staging = attempt
      ? this.journal.treasuryStagingRecoveryContext(purchase.id, attempt.attempt)
      : undefined;
    if (
      !effect &&
      (staging?.observation || staging?.effect.state === "retryable")
    ) {
      const proof =
        staging.observation?.evidenceDigest ??
        this.journal.effectObservations(staging.effect.id).at(-1)?.detailDigest;
      if (!proof) {
        throw new PurchaseCoordinatorError(
          "recoverable Treasury staging has no observation proof",
          "recovery_invariant"
        );
      }
      this.journal.transitionPurchase(
        purchase.id,
        "failed_recoverable",
        "execution_prepared",
        staging.observation
          ? "treasury_staging_observed"
          : "proof_backed_treasury_staging_retry",
        proof
      );
      return true;
    }
    return false;
  }

  private applyRecoverySummary(id: PurchaseId, summary: ReconciliationSummary): void {
    if (!summary.acquired || summary.leaseLost) return;
    let purchase = this.journal.requirePurchase(id);
    const effect = this.paymentEffect(id, false);
    if (
      purchase.state === "execution_prepared" &&
      this.journal.paymentAttempts(id).some((attempt) => attempt.state === "submitted" || attempt.state === "observed")
    ) {
      purchase = this.journal.transitionPurchase(
        id,
        "execution_prepared",
        "submitted",
        "recovery_submission_fact",
        effect?.submissionDigest
      );
    }
    const spend = this.journal.findSettlementForPurchase(id);
    if (
      spend &&
      ["execution_prepared", "submitted", "failed_recoverable"].includes(purchase.state)
    ) {
      if (purchase.state === "execution_prepared") {
        purchase = this.journal.transitionPurchase(
          id,
          "execution_prepared",
          "submitted",
          "recovery_submission_fact",
          effect?.submissionDigest ?? spend.evidenceDigest
        );
      }
      this.journal.transitionPurchase(id, purchase.state, "settled", "recovery_settlement_observed", spend.evidenceDigest);
      return;
    }
    const needsRecovery = summary.results.some((result) =>
      ["pending", "retryable", "conflict", "failed_terminal", "observer_error", "unsupported"].includes(result.status)
    ) || Boolean(effect && ["ambiguous", "retryable", "failed_terminal"].includes(effect.state));
    let current = this.journal.requirePurchase(id);
    if (
      current.state === "execution_prepared" &&
      effect &&
      ["executing", "submitted", "ambiguous", "retryable", "failed_terminal"].includes(effect.state)
    ) {
      current = this.journal.transitionPurchase(
        id,
        "execution_prepared",
        "submitted",
        "recovery_submission_fact",
        effect.submissionDigest ?? effect.resultDigest ?? effect.payloadDigest
      );
    }
    if (needsRecovery && current.state === "submitted") {
      current = this.journal.transitionPurchase(
        id,
        "submitted",
        "failed_recoverable",
        "reconciliation_required",
        summary.results.find((result) => result.detailDigest)?.detailDigest
      );
    }
    if (effect?.state === "failed_terminal" && current.state === "failed_recoverable") {
      const attempt = effect.attempt === undefined
        ? undefined
        : this.journal.requirePaymentAttempt(id, effect.attempt);
      const preparation = effect.attempt === undefined
        ? undefined
        : this.journal.requirePaymentPreparation(id, effect.attempt);
      const reservation = preparation
        ? this.journal.requireReservation(preparation.reservationId)
        : undefined;
      if (attempt?.state !== "failed" || reservation?.state !== "released") return;
      this.journal.transitionPurchase(
        id,
        "failed_recoverable",
        "failed_terminal",
        "reconciliation_terminal_conflict",
        effect.resultDigest ?? summary.results.find((result) => result.detailDigest)?.detailDigest
      );
    }
  }

  private persistedIntent(id: PurchaseId): PurchaseIntent | undefined {
    const purchase = this.journal.requirePurchase(id);
    const request = this.journal.findAuthorizationRequest(id);
    if (!request) return undefined;
    const body = this.journal.readEvidence(request.requestBodyDigest);
    const intent: PurchaseIntent = {
      requestKey: purchase.requestKey,
      resource: {
        url: purchase.resourceUrl,
        method: purchase.method,
        body,
        mediaType: request.requestMediaType || undefined,
      },
      expectedMerchant:
        purchase.expectedMerchantId || purchase.expectedMerchantOrigin
          ? {
              id: purchase.expectedMerchantId,
              origin: purchase.expectedMerchantOrigin,
            }
          : undefined,
    };
    if (requestFingerprint(intent.resource) !== purchase.resourceFingerprint) {
      throw new PurchaseCoordinatorError("persisted Purchase request identity is inconsistent", "request_invariant");
    }
    return intent;
  }

  private purchaseExecutionContext(
    purchaseId: PurchaseId,
    attemptNumber: number
  ): Pick<
    KaspaPreparedExecutionContext,
    "execution" | "request" | "paymentRequirements"
  > {
    const purchase = this.journal.requirePurchase(purchaseId);
    const terms = this.journal.requireCheckoutTerms(purchaseId);
    const request = this.authorizationRequest(purchase);
    const authorization = this.journal.requireAuthorization(purchaseId);
    if (authorization.decision !== "approved") {
      throw new PurchaseCoordinatorError("prepared payment lost its approved authorization", "authorization_invariant");
    }
    const attempt = this.journal.requirePaymentAttempt(purchaseId, attemptNumber);
    const intent = this.persistedIntent(purchaseId);
    if (!intent) {
      throw new PurchaseCoordinatorError(
        "Purchase execution lost its persisted request",
        "request_invariant"
      );
    }
    return {
      execution: {
        purchaseId,
        terms: canonicalTermsCopy(terms),
        authorizationRequest: request,
        authorization: {
          purchaseId,
          checkoutDigest: terms.checkoutDigest,
          decision: "approved",
          authorityId: authorization.authorityId,
          evidenceDigest: authorization.evidenceDigest,
          facts: authorizationFacts(request),
        },
        paymentIdentifier: attempt.identifier,
      },
      request: kaspaRequestContext(intent),
      paymentRequirements: this.journal.readEvidence(terms.paymentRequirementsDigest),
    };
  }

  private executionAuthorizationExpired(purchaseId: PurchaseId): boolean {
    const terms = this.journal.requireCheckoutTerms(purchaseId);
    const authorization = this.journal.requireAuthorization(purchaseId);
    return Math.min(terms.expiresAtMs, authorization.expiresAtMs) <= this.now();
  }

  private treasuryStagingContext(
    purchaseId: PurchaseId,
    attemptNumber: number
  ): KaspaTreasuryStagingContext {
    const execution = this.purchaseExecutionContext(purchaseId, attemptNumber);
    const plan = this.journal.requireTreasuryStagingPlan(purchaseId, attemptNumber);
    return {
      ...execution,
      staging: {
        preparedBytes: this.journal.readPreparedTreasuryStaging(
          purchaseId,
          attemptNumber
        ),
        preparedDigest: plan.payloadDigest,
        transactionId: plan.plannedTransactionId,
        expectedOutpoint: plan.expectedOutpoint,
        amountAtomic: plan.stagingAmountAtomic,
        fundingSource: plan.fundingSource,
      },
    };
  }

  private preparedPaymentContext(
    purchaseId: PurchaseId,
    attemptNumber: number
  ): KaspaPreparedExecutionContext {
    const execution = this.purchaseExecutionContext(purchaseId, attemptNumber);
    const preparation = this.journal.requirePaymentPreparation(purchaseId, attemptNumber);
    const executionPlan = this.journal.requireExecutionPlan(purchaseId);
    const staging = this.journal.findTreasuryStagingObservation(
      purchaseId,
      attemptNumber
    );
    if (executionPlan.mechanism === "single-transaction" && !staging) {
      throw new PurchaseCoordinatorError(
        "prepared payment lost its observed Treasury staging output",
        "treasury_staging_invariant"
      );
    }
    return {
      ...execution,
      ...(staging === undefined ? {} : { staging: stagingOutput(staging) }),
      preparation: {
        preparedBytes: this.journal.readPreparedPayment(purchaseId, attemptNumber),
        preparedDigest: preparation.payloadDigest,
        executionId: preparation.executionId,
        mechanism: preparation.mechanism,
        profile: preparation.profile,
        ...(preparation.transactionId === undefined
          ? {}
          : { transactionId: preparation.transactionId }),
        requiredAssurance: preparation.requiredAssurance,
        fundingSource: "vault-treasury",
      },
    };
  }

  private authorizationRequest(purchase: PurchaseRecord): PurchaseAuthorizationRequest {
    const terms = this.journal.requireCheckoutTerms(purchase.id);
    const record = this.journal.requireAuthorizationRequest(purchase.id);
    const parsed = parseAuthorizationEnvelope(this.journal.readEvidence(record.requestDigest));
    if (
      parsed.profile !== PURCHASE_AUTHORIZATION_REQUEST_PROFILE ||
      parsed.purchaseId !== purchase.id ||
      parsed.resourceUrl !== purchase.resourceUrl ||
      parsed.method !== purchase.method ||
      parsed.nonceDigest !== record.nonceDigest ||
      parsed.requestMediaType !== record.requestMediaType ||
      parsed.requestBodyDigest !== record.requestBodyDigest ||
      parsed.additionalCostCeilingAtomic !== record.additionalCostCeilingAtomic ||
      parsed.effectiveFinalityFloor !== record.effectiveFinalityFloor ||
      parsed.settlementAssurance !== record.settlementAssurance ||
      parsed.executionPlanDigest !== record.executionPlanDigest ||
      parsed.executionMechanism !== record.executionMechanism ||
      parsed.executionProfile !== record.executionProfile ||
      parsed.maximumAuthorizedChargeAtomic !== record.maximumAuthorizedChargeAtomic ||
      parsed.channelId !== record.channelId ||
      parsed.channelEpochDigest !== record.channelEpochDigest ||
      evidenceDigest(Buffer.from(parsed.nonce, "base64url")) !== record.nonceDigest
    ) {
      throw new PurchaseCoordinatorError("authorization request artifact is inconsistent", "authorization_invariant");
    }
    return {
      purchaseId: purchase.id,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      requestMediaType: record.requestMediaType,
      requestBodyDigest: record.requestBodyDigest,
      terms: canonicalTermsCopy(terms),
      requestDigest: record.requestDigest,
      nonceDigest: record.nonceDigest,
      additionalCostCeilingAtomic: record.additionalCostCeilingAtomic,
      operatorFinalityFloor: parsed.operatorFinalityFloor,
      effectiveFinalityFloor: record.effectiveFinalityFloor,
      depthConfirmationDaa: parsed.depthConfirmationDaa,
      executionPlanDigest: record.executionPlanDigest,
      executionMechanism: record.executionMechanism,
      executionProfile: record.executionProfile,
      settlementAssurance: record.settlementAssurance,
      maximumAuthorizedChargeAtomic: record.maximumAuthorizedChargeAtomic,
      ...(record.channelId === undefined ? {} : { channelId: record.channelId }),
      ...(record.channelEpochDigest === undefined
        ? {}
        : { channelEpochDigest: record.channelEpochDigest }),
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    };
  }

  private async createEgressSession(intent: PurchaseIntent): Promise<PurchaseEgressSession> {
    const request = await this.egress.validateRequest({
      url: intent.resource.url,
      method: intent.resource.method,
      body: intent.resource.body,
      mediaType: intent.resource.mediaType,
    });
    return Object.freeze({
      request,
      requestFor: (input: EgressRequestInput) => this.egress.validateRequest(input),
      redirect: async (
        previous: SafeTransportHop,
        location: string,
        override?: RedirectRequestOverride
      ) => {
        const next = await this.egress.validateRedirect(previous, location, override);
        if (next.requestFingerprint !== request.requestFingerprint) {
          throw new EgressPolicyError(
            "redirect_request_invalid",
            "commerce redirects must preserve the exact authorized request identity"
          );
        }
        return next;
      },
      responseGuard: (
        hop: SafeTransportHop,
        abort: (reason: EgressPolicyError) => void
      ) => this.egress.createResponseGuard(hop, abort),
    });
  }

  private storeVerifiedArtifact(
    purchaseId: PurchaseId,
    kind: string,
    artifact: VerifiedArtifact,
    attempt?: number
  ): Sha256Digest {
    const stored = this.journal.storeEvidence(purchaseId, {
      bytes: artifact.bytes,
      mediaType: artifact.mediaType,
      profile: artifact.profile,
      issuer: artifact.issuer,
      kind,
      attempt,
    });
    if (artifact.declaredDigest && artifact.declaredDigest !== stored.digest) {
      throw new PurchaseCoordinatorError(`${kind} evidence does not match its declared digest`, "evidence_mismatch");
    }
    this.journal.recordEvidenceVerification(stored.digest, artifact.verification);
    return stored.digest;
  }

  private paymentEffect(purchaseId: PurchaseId, required = true): EffectRecord | undefined {
    const effect = this.journal.effectsForPurchase(purchaseId).find((entry) => entry.kind === PAYMENT_EFFECT_KIND);
    if (!effect && required) throw new PurchaseCoordinatorError("Purchase has no payment Effect", "payment_invariant");
    return effect;
  }

  private snapshot(purchase: PurchaseRecord): PurchaseProjectionSnapshot {
    const terms = this.journal.findCheckoutTerms(purchase.id);
    const authorization = this.journal.findAuthorization(purchase.id);
    const authorizationRequest = this.journal.findAuthorizationRequest(purchase.id);
    const reservation = this.journal.findReservationForPurchase(purchase.id);
    const links = this.journal.evidenceLinks(purchase.id);
    const spend = this.journal.findSettlementForPurchase(purchase.id);
    const fulfilment = this.journal.findFulfilment(purchase.id);
    const receipts = this.journal.receipts(purchase.id);
    const recoveryRequired = this.journal.effectsForPurchase(purchase.id).some((effect) =>
      ["executing", "submitted", "ambiguous", "failed_terminal"].includes(effect.state)
    ) && !["submitted", "failed_recoverable", "failed_terminal"].includes(purchase.state);
    const paymentAttempts: PaymentAttemptView[] = this.journal.paymentAttempts(purchase.id).map((attempt) => {
      let transactionId: string | undefined;
      let finality: string | undefined;
      try {
        const preparation = this.journal.requirePaymentPreparation(purchase.id, attempt.attempt);
        transactionId = preparation.transactionId;
        finality = preparation.requiredAssurance;
      } catch (error) {
        if (!(error instanceof JournalNotFoundError)) throw error;
      }
      return {
        attempt: attempt.attempt,
        identifier: attempt.identifier,
        status: attempt.state,
        transactionId,
        finality,
        evidenceDigests: [...new Set(
          links
            .filter((link) => link.attempt === attempt.attempt)
            .map((link) => link.digest)
        )],
      };
    });
    const fulfilmentProjection = fulfilment
      ? {
          digest: fulfilment.bodyDigest,
          bodyBytes: this.journal.readEvidence(fulfilment.bodyDigest),
          mediaType: fulfilment.mediaType,
          handle: `evidence/${fulfilment.bodyDigest.slice("sha256:".length)}`,
          byteLength: fulfilment.bodyByteLength,
        }
      : undefined;
    return {
      id: purchase.id,
      requestKey: purchase.requestKey,
      state: purchase.state,
      resourceFingerprint: purchase.resourceFingerprint,
      terms: terms ? canonicalTermsCopy(terms) : undefined,
      authorization: authorization
        ? {
            status: authorization.decision === "approved" ? "approved" : authorization.decision,
            authorityId: authorization.authorityId,
            evidenceDigest: authorization.evidenceDigest,
          }
        : { status: authorizationRequest ? "pending" : "not_requested" },
      treasury: reservation
        ? {
            status: reservationState(reservation.state),
            amountAtomic: reservation.amountAtomic,
            additionalCostCeilingAtomic: reservation.additionalCostCeilingAtomic,
            reservationId: reservation.id,
            fundingSource: reservation.fundingSource,
          }
        : { status: "unreserved" },
      paymentAttempts,
      settlementEvidence: spend?.evidenceDigest,
      fulfilment: fulfilmentProjection,
      receiptEvidence: receipts.map((receipt) => receipt.evidenceDigest),
      recoveryRequired,
    };
  }
}

interface ParsedAuthorizationEnvelope {
  profile: string;
  purchaseId: string;
  resourceUrl: string;
  method: string;
  nonce: string;
  nonceDigest: string;
  requestMediaType: string;
  requestBodyDigest: string;
  additionalCostCeilingAtomic: string;
  operatorFinalityFloor: "accepted" | "depth-confirmed";
  effectiveFinalityFloor: "accepted" | "depth-confirmed";
  depthConfirmationDaa: string;
  executionPlanDigest: string;
  executionMechanism: string;
  executionProfile: string;
  settlementAssurance: string;
  maximumAuthorizedChargeAtomic: string;
  channelId?: string;
  channelEpochDigest?: string;
}

function parseAuthorizationEnvelope(bytes: Uint8Array): ParsedAuthorizationEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new PurchaseCoordinatorError("authorization request artifact is malformed", "authorization_invariant", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PurchaseCoordinatorError("authorization request artifact is malformed", "authorization_invariant");
  }
  const value = parsed as Record<string, unknown>;
  for (const key of [
    "profile",
    "purchaseId",
    "resourceUrl",
    "method",
    "nonce",
    "nonceDigest",
    "requestMediaType",
    "requestBodyDigest",
    "additionalCostCeilingAtomic",
    "operatorFinalityFloor",
    "effectiveFinalityFloor",
    "depthConfirmationDaa",
    "executionPlanDigest",
    "executionMechanism",
    "executionProfile",
    "settlementAssurance",
    "maximumAuthorizedChargeAtomic",
  ]) {
    if (typeof value[key] !== "string") {
      throw new PurchaseCoordinatorError("authorization request artifact is malformed", "authorization_invariant");
    }
  }
  if (
    (value.operatorFinalityFloor !== "accepted" &&
      value.operatorFinalityFloor !== "depth-confirmed") ||
    (value.effectiveFinalityFloor !== "accepted" &&
      value.effectiveFinalityFloor !== "depth-confirmed") ||
    typeof value.depthConfirmationDaa !== "string" ||
    !/^[1-9][0-9]*$/.test(value.depthConfirmationDaa) ||
    value.depthConfirmationDaa.length > 78 ||
    (value.channelId !== undefined && typeof value.channelId !== "string") ||
    (value.channelEpochDigest !== undefined && typeof value.channelEpochDigest !== "string") ||
    ((value.channelId === undefined) !== (value.channelEpochDigest === undefined))
  ) {
    throw new PurchaseCoordinatorError("authorization request artifact is malformed", "authorization_invariant");
  }
  return value as unknown as ParsedAuthorizationEnvelope;
}

function canonicalIntentCopy(intent: PurchaseIntent): PurchaseIntent {
  const resource = {
    url: canonicalRequestUrl(intent.resource.url),
    method: intent.resource.method.trim().toUpperCase(),
    body: intent.resource.body === undefined ? undefined : Uint8Array.from(intent.resource.body),
    mediaType: canonicalMediaType(intent.resource.mediaType),
  };
  // requestFingerprint supplies the strict URL/method validation.
  requestFingerprint(resource);
  const expectedMerchant = intent.expectedMerchant
    ? {
        id: intent.expectedMerchant.id,
        origin: intent.expectedMerchant.origin === undefined ? undefined : new URL(intent.expectedMerchant.origin).origin,
      }
    : undefined;
  return { requestKey: intent.requestKey as PurchaseRequestKey, resource, expectedMerchant };
}

function kaspaRequestContext(intent: PurchaseIntent): KaspaRequestContext {
  return {
    url: intent.resource.url,
    method: intent.resource.method,
    mediaType: intent.resource.mediaType,
    body: Uint8Array.from(intent.resource.body ?? new Uint8Array()),
    requestFingerprint: requestFingerprint(intent.resource),
  };
}

function canonicalTermsCopy(terms: CheckoutTerms): CheckoutTerms {
  return {
    merchant: { id: terms.merchant.id, name: terms.merchant.name, origin: terms.merchant.origin },
    resourceFingerprint: terms.resourceFingerprint,
    amountAtomic: terms.amountAtomic,
    asset: terms.asset,
    network: terms.network,
    payTo: terms.payTo,
    expiresAt: terms.expiresAt,
    checkoutDigest: terms.checkoutDigest,
  };
}

function freezeVerifiedArtifact(artifact: VerifiedArtifact): VerifiedArtifact {
  return Object.freeze({
    bytes: Uint8Array.from(artifact.bytes),
    mediaType: artifact.mediaType,
    profile: artifact.profile,
    issuer: artifact.issuer,
    declaredDigest: artifact.declaredDigest,
    verification: Object.freeze({ ...artifact.verification }),
  });
}

function validatePreparedTreasuryStaging(
  prepared: PreparedTreasuryStaging,
  bytes: Uint8Array,
  reservedGrossAtomic: bigint
): void {
  if (
    bytes.byteLength === 0 ||
    prepared.preparedDigest !== evidenceDigest(bytes)
  ) {
    throw new PurchaseCoordinatorError(
      "prepared Treasury staging bytes do not match their declared digest",
      "treasury_staging_mismatch"
    );
  }
  if (!/^[a-f0-9]{64}$/.test(prepared.transactionId)) {
    throw new PurchaseCoordinatorError(
      "prepared Treasury staging has no canonical transaction identity",
      "treasury_staging_mismatch"
    );
  }
  const outpoint = new RegExp(
    `^${prepared.transactionId}:(0|[1-9][0-9]*)$`
  ).exec(prepared.expectedOutpoint);
  if (!outpoint || BigInt(outpoint[1]) > 0xffff_ffffn) {
    throw new PurchaseCoordinatorError(
      "prepared Treasury staging has no canonical expected outpoint",
      "treasury_staging_mismatch"
    );
  }
  const amount = requireAtomicDecimal(
    prepared.stagingAmountAtomic,
    false,
    "Treasury staging amount"
  );
  if (amount > reservedGrossAtomic) {
    throw new PurchaseCoordinatorError(
      "Treasury staging amount exceeds its exact reserved gross outflow",
      "treasury_staging_mismatch"
    );
  }
  if (prepared.fundingSource !== "vault-treasury") {
    throw new PurchaseCoordinatorError(
      "Treasury staging used an unauthorized funding source",
      "treasury_staging_mismatch"
    );
  }
}

function stagingOutput(
  staging: TreasuryStagingObservationRecord
): KaspaPreparedExecutionContext["staging"] {
  return Object.freeze({
    transactionId: staging.transactionId,
    outpoint: staging.outpoint,
    amountAtomic: staging.stagingAmountAtomic,
    evidenceDigest: staging.evidenceDigest,
    fundingSource: staging.fundingSource,
  });
}

function validatePreparedStagingRecovery(
  prepared: Readonly<PreparedStagingRecovery>,
  exactTransactionId: string | undefined,
  stagingAmountAtomic: string
): void {
  if (
    !(prepared.preparedBytes instanceof Uint8Array) ||
    prepared.preparedBytes.byteLength === 0 ||
    evidenceDigest(prepared.preparedBytes) !== prepared.preparedDigest ||
    prepared.exactTransactionId !== exactTransactionId ||
    !/^[a-f0-9]{64}$/.test(prepared.recoveryTransactionId) ||
    prepared.recoveryOutpoint !== `${prepared.recoveryTransactionId}:0`
  ) {
    throw new PurchaseCoordinatorError(
      "prepared staging recovery changed its immutable identity",
      "staging_recovery_mismatch"
    );
  }
  const returned = requireAtomicDecimal(
    prepared.recoveryAmountAtomic,
    false,
    "staging recovery returned amount"
  );
  const stagingFee = requireAtomicDecimal(
    prepared.stagingFeeAtomic,
    true,
    "staging transaction fee"
  );
  const recoveryFee = requireAtomicDecimal(
    prepared.recoveryFeeAtomic,
    false,
    "staging recovery fee"
  );
  const staged = requireAtomicDecimal(
    stagingAmountAtomic,
    false,
    "observed staging amount"
  );
  if (returned + recoveryFee !== staged || stagingFee < 0n) {
    throw new PurchaseCoordinatorError(
      "prepared staging recovery does not conserve the observed staged value",
      "staging_recovery_mismatch"
    );
  }
  if (!paymentFinalityMeets(prepared.requiredFinality, prepared.requiredFinality)) {
    throw new PurchaseCoordinatorError(
      "prepared staging recovery finality is unsupported",
      "staging_recovery_mismatch"
    );
  }
}

function stagingRecoveryJournalObservation(
  observed: Readonly<StagingRecoveryObservation>
): RecordTreasuryStagingRecoveryObservationInput {
  switch (observed.status) {
    case "safe_to_submit":
      return {
        status: "safe_to_submit",
        evidenceDigest: observed.evidenceDigest,
        readinessProofDigest: observed.readiness.proofDigest,
        readinessObservedAtMs: observed.readiness.observedAtMs,
        readinessExpiresAtMs: observed.readiness.expiresAtMs,
      };
    case "pending":
      return { status: "pending", evidenceDigest: observed.evidenceDigest };
    case "exact_payment_won":
      return {
        status: "exact_payment_won",
        evidenceDigest: observed.evidenceDigest,
        winningTransactionId: observed.transactionId,
        winningFinality: observed.finality,
      };
    case "recovery_won":
      return {
        status: "recovery_won",
        evidenceDigest: observed.evidenceDigest,
        winningTransactionId: observed.transactionId,
        winningFinality: observed.finality,
        recoveryOutpoint: observed.recoveryOutpoint,
        recoveryAmountAtomic: observed.recoveryAmountAtomic,
      };
    case "conflict":
      return {
        status: "conflict",
        evidenceDigest: observed.evidenceDigest,
        conflictReason: observed.reason,
      };
  }
}

function reservationState(
  state: "active" | "in_flight" | "spent" | "released" | "expired"
): "reserved" | "committed" | "released" | "expired" {
  switch (state) {
    case "active":
    case "in_flight":
      return "reserved";
    case "spent":
      return "committed";
    case "released":
      return "released";
    case "expired":
      return "expired";
  }
}

function requireAtomicDecimal(value: string, allowZero: boolean, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new PurchaseCoordinatorError(`${label} must be a canonical atomic-unit integer`, "invalid_amount");
  }
  const amount = BigInt(value);
  if (allowZero ? amount < 0n : amount <= 0n) {
    throw new PurchaseCoordinatorError(`${label} is outside its allowed range`, "invalid_amount");
  }
  return amount;
}

function executionAssuranceMeets(
  actual: "accepted" | "confirmed" | "channel-commitment",
  required: "accepted" | "confirmed" | "channel-commitment"
): boolean {
  if (actual === "channel-commitment" || required === "channel-commitment") {
    return actual === required;
  }
  return paymentFinalityMeets(actual, required);
}

function safeErrorDigest(domain: string, error: unknown): Sha256Digest {
  const name = error instanceof Error ? error.name : typeof error;
  return evidenceDigest(`${domain}:${name}`);
}

function omitEffectId<T extends { effectId: string }>(input: T): Omit<T, "effectId"> {
  const { effectId: _effectId, ...rest } = input;
  return rest;
}
