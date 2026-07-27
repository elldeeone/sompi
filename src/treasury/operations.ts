import { createHash, randomBytes } from "node:crypto";
import { PolicyEngine } from "../policy.js";
import { paymentFinalityMeets } from "../purchase/finality.js";
import { evidenceDigest } from "../purchase/identity.js";
import {
  JournalFencingError,
  JournalNotFoundError,
  type EffectClaim,
  type EffectObservation,
  type EffectRecord,
  type LeaseToken,
  type RecordTreasuryStagingRecoveryObservationInput,
  type TreasuryStagingRecoveryJournalContext,
} from "../purchase/journal.js";
import {
  TreasuryPreparationError,
  type TreasuryOperationAdapter,
} from "./operation-adapters.js";
import {
  type TreasuryOperationJournal,
  type TreasuryOperationKind,
  type TreasuryOperationRecord,
  type TreasuryDriverLease,
  type TreasurySubmissionOutcome,
} from "./operation-journal.js";
import {
  TreasuryCapacityError,
  type PurchaseTreasuryCapacity,
  type ReservePurchaseCapacityInput,
  type ReservePurchaseCapacityResult,
  type TreasuryPolicy,
  type TreasuryQuote,
} from "./purchase-capacity.js";
import {
  TreasuryStagingPreparationError,
  treasuryStagingPreparationLeaseName,
  type ExecutePurchaseStagingInput,
  type PreparePurchaseStagingInput,
  type PreparedTreasuryStaging,
  type PurchaseTreasuryStagingExecution,
  type PurchaseTreasuryStagingPreparation,
  type TreasuryStagingAdapter,
  type TreasuryStagingAdapterContext,
  type TreasuryStagingExecutionResult,
  type TreasuryStagingPreparationLease,
  type TreasuryStagingPreparationResult,
  type TreasuryStagingRecoveryObservation,
  type TreasuryStagingResult,
} from "./purchase-staging.js";
import {
  type PreparedStagingRecovery,
  type PurchaseStagingRecoveryResult,
  type PurchaseTreasuryStagingRecovery,
  type RecoverPurchaseStagingInput,
  type StagingRecoveryObservation,
  type StagingRecoveryPreparationContext,
  type TreasuryStagingRecoveryAdapter,
} from "./staging-recovery.js";

const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const ADDRESS = /^kaspatest:[a-z0-9]+$/;
const ATOMIC = /^[1-9][0-9]*$/;
const TESTNET = "kaspa:testnet-10";
const PURCHASE_PAYMENT_EFFECT_KIND = "kaspa-x402-payment";
const MAX_RECONCILED_RETRIES = 8;
const DRIVER_LEASE_TTL_MS = 60_000;
const STAGING_PREPARATION_LEASE_TTL_MS = 60_000;
const STAGING_EXECUTION_LEASE_TTL_MS = 60_000;
const STAGING_RECONCILIATION_LEASE_TTL_MS = 30_000;
const DRIVER_WAIT_MS = 10;
const DRIVER_WAIT_ATTEMPTS = 600;

export interface TreasuryOperationRequest {
  readonly operationKey: string;
  readonly kind: TreasuryOperationKind;
  readonly destination: string;
  readonly amountAtomic: string | "max";
  readonly keepFloatAtomic?: string;
}

export interface TreasuryOperationView {
  readonly operationKey: string;
  readonly kind: TreasuryOperationKind;
  readonly state: TreasuryOperationRecord["state"];
  readonly summary: string;
  readonly destination: string;
  readonly requestedAmountAtomic: string | "max";
  readonly keepFloatAtomic?: string;
  readonly feeCeilingAtomic: string;
  readonly amountAtomic?: string;
  readonly feeAtomic?: string;
  readonly transactionId?: string;
  readonly retryCount: number;
  readonly recoveryRequired: boolean;
  readonly safeToRetry: boolean;
  readonly cancellationRequested: boolean;
  readonly preparationFenced: boolean;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

export interface TreasuryPurchaseOptions {
  readonly vault: {
    readonly configured: boolean;
    config(): {
      readonly configured?: boolean;
      readonly covenantId?: string;
    };
  };
  readonly additionalCostCeilingAtomic: string;
  readonly reservationTtlMs?: number;
  readonly stagingExecutionLeaseTtlMs?: number;
  readonly stagingReconciliationLeaseTtlMs?: number;
  readonly staging: TreasuryStagingAdapter;
  readonly stagingRecovery: TreasuryStagingRecoveryAdapter;
  readonly now?: () => number;
}

export interface TreasuryOperationModuleOptions {
  readonly journal: TreasuryOperationJournal;
  readonly policy: Pick<PolicyEngine, "activate" | "authorize" | "policy">;
  readonly adapters: readonly TreasuryOperationAdapter[];
  readonly feeCeilingAtomic: string;
  /** Manifest projection in production; default is only for hermetic fixtures. */
  readonly directTreasuryRetries?: number;
  /** Required when this implementation is used by Purchase. */
  readonly purchase?: TreasuryPurchaseOptions;
}

export interface TreasuryAuthorizedExecution {
  readonly expectedPolicyDigest?: string;
  readonly authorizationEvidenceDigest?: string;
}

export class TreasuryOperationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TreasuryOperationError";
  }
}

export class TreasuryOperationNotFoundError extends TreasuryOperationError {
  constructor() {
    super("Treasury operation does not exist");
    this.name = "TreasuryOperationNotFoundError";
  }
}

/**
 * Deep Treasury module for Purchase staging and direct Treasury Movements.
 *
 * Its small interface owns idempotency, durable preparation, policy capacity,
 * submission ordering, ambiguity, reconciliation, and local commit. MCP does
 * not call wallet/vault mutation methods directly.
 */
export class TreasuryOperationModule
  implements
    PurchaseTreasuryStagingPreparation,
    PurchaseTreasuryStagingExecution,
    PurchaseTreasuryStagingRecovery
{
  private readonly journal: TreasuryOperationJournal;
  private readonly policy: Pick<
    PolicyEngine,
    "activate" | "authorize" | "policy"
  >;
  private readonly adapters: ReadonlyMap<TreasuryOperationKind, TreasuryOperationAdapter>;
  private readonly feeCeilingAtomic: string;
  private readonly directTreasuryRetries: number;
  private readonly purchase?: {
    readonly vault: TreasuryPurchaseOptions["vault"];
    readonly additionalCostCeilingAtomic: string;
    readonly reservationTtlMs: number;
    readonly stagingExecutionLeaseTtlMs: number;
    readonly stagingReconciliationLeaseTtlMs: number;
    readonly staging: TreasuryPurchaseOptions["staging"];
    readonly stagingRecovery: TreasuryStagingRecoveryAdapter;
    readonly now: () => number;
  };
  /** Only an optimization; durable Journal driver generations are authoritative. */
  private readonly driverOwner = `treasury-driver:${process.pid}:${randomBytes(8).toString("hex")}`;
  private readonly activeDrivePromises = new Map<string, Promise<TreasuryOperationView>>();

  constructor(options: TreasuryOperationModuleOptions) {
    if (!options?.journal || !options.policy) {
      throw new TreasuryOperationError("Treasury Operation module dependencies are incomplete");
    }
    const adapters = new Map<TreasuryOperationKind, TreasuryOperationAdapter>();
    for (const adapter of options.adapters) {
      if (adapters.has(adapter.kind)) {
        throw new TreasuryOperationError(`Duplicate Treasury operation adapter for ${adapter.kind}`);
      }
      adapters.set(adapter.kind, adapter);
    }
    if (
      !adapters.has("wallet_send") ||
      !adapters.has("vault_send") ||
      !adapters.has("vault_deposit")
    ) {
      throw new TreasuryOperationError(
        "Wallet send, vault send, and vault deposit Treasury operation adapters are required"
      );
    }
    this.feeCeilingAtomic = requireAtomic(options.feeCeilingAtomic, "Treasury fee ceiling");
    this.directTreasuryRetries = requireRetryLimit(
      options.directTreasuryRetries ?? 3
    );
    this.journal = options.journal;
    this.policy = options.policy;
    this.adapters = adapters;
    if (options.purchase) {
      const purchase = options.purchase;
      if (!purchase.vault) {
        throw new TreasuryOperationError("Purchase Treasury requires a vault backend");
      }
      requireMethod(purchase.staging?.prepareStaging, "staging preparation");
      requireMethod(purchase.staging?.submitStaging, "staging submission");
      requireMethod(purchase.staging?.observeStaging, "staging observation");
      requireMethod(purchase.stagingRecovery?.prepare, "staging recovery preparation");
      requireMethod(purchase.stagingRecovery?.observe, "staging recovery observation");
      requireMethod(purchase.stagingRecovery?.submit, "staging recovery submission");
      const reservationTtlMs = purchase.reservationTtlMs ?? 120_000;
      if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
        throw new TreasuryOperationError("Purchase Treasury reservation TTL is invalid");
      }
      const stagingExecutionLeaseTtlMs =
        purchase.stagingExecutionLeaseTtlMs ??
        STAGING_EXECUTION_LEASE_TTL_MS;
      const stagingReconciliationLeaseTtlMs =
        purchase.stagingReconciliationLeaseTtlMs ??
        STAGING_RECONCILIATION_LEASE_TTL_MS;
      if (
        !Number.isSafeInteger(stagingExecutionLeaseTtlMs) ||
        stagingExecutionLeaseTtlMs <= 0 ||
        !Number.isSafeInteger(stagingReconciliationLeaseTtlMs) ||
        stagingReconciliationLeaseTtlMs <= 0
      ) {
        throw new TreasuryOperationError(
          "Purchase Treasury staging lease TTL is invalid",
        );
      }
      this.purchase = Object.freeze({
        vault: purchase.vault,
        additionalCostCeilingAtomic: requireAtomic(
          purchase.additionalCostCeilingAtomic,
          "Purchase Treasury additional-cost ceiling",
          true,
        ),
        reservationTtlMs,
        stagingExecutionLeaseTtlMs,
        stagingReconciliationLeaseTtlMs,
        staging: purchase.staging,
        stagingRecovery: purchase.stagingRecovery,
        now: purchase.now ?? Date.now,
      });
    }
    this.synchronizePolicy();
  }

  async quote(
    input: Parameters<PurchaseTreasuryCapacity["quote"]>[0],
  ): Promise<TreasuryQuote> {
    const purchase = this.requirePurchase();
    if (input.fundingMode === "precapitalized-channel") {
      const remaining = Math.max(
        1,
        Date.parse(input.terms.expiresAt) - requireTimestamp(purchase.now()),
      );
      return Object.freeze({
        additionalCostCeilingAtomic: "0",
        reservationTtlMs: remaining,
        ready: true,
      });
    }
    if (input.terms.asset !== "KAS" || input.terms.network !== TESTNET) {
      return this.quoteResult(false, "unsupported_asset_or_network");
    }
    let configured: ReturnType<typeof purchase.vault.config>;
    try {
      if (!purchase.vault.configured) {
        return this.quoteResult(false, "vault_not_configured");
      }
      configured = purchase.vault.config();
    } catch {
      return this.quoteResult(false, "vault_unavailable");
    }
    if (
      configured.covenantId !== undefined &&
      !/^[a-f0-9]{64}$/.test(configured.covenantId)
    ) {
      return this.quoteResult(false, "vault_unavailable");
    }
    return this.quoteResult(
      Boolean(configured.covenantId),
      configured.covenantId ? undefined : "vault_not_covenant_funded",
    );
  }

  async reservePurchaseCapacity(
    input: Readonly<ReservePurchaseCapacityInput>,
  ): Promise<Readonly<ReservePurchaseCapacityResult>> {
    const purchase = this.requirePurchase();
    this.journal.expireReservations();
    const existing = this.journal.findReservationForPurchase(input.purchaseId);
    if (existing) {
      const reservation = this.journal.requireReservation(existing.id);
      if (
        reservation.state === "active" &&
        this.journal.requireActivePolicy().digest !== reservation.policyDigest
      ) {
        throw new TreasuryCapacityError(
          "active Treasury policy changed after capacity was reserved",
          "treasury_policy_changed",
        );
      }
      return Object.freeze({ status: "reserved", reservation });
    }

    const quote = await this.quote({
      purchaseId: input.purchaseId,
      fundingMode: input.fundingMode,
      terms: input.terms,
    });
    if (!quote.ready) {
      return Object.freeze({ status: "not_ready", quote });
    }
    requireAtomic(
      quote.additionalCostCeilingAtomic,
      "Purchase Treasury additional-cost ceiling",
      true,
    );
    if (
      BigInt(quote.additionalCostCeilingAtomic) >
      BigInt(input.authorizedAdditionalCostCeilingAtomic)
    ) {
      throw new TreasuryCapacityError(
        "Treasury additional-cost quote exceeds the exact authorized ceiling",
        "treasury_quote_increased",
      );
    }
    if (!Number.isSafeInteger(quote.reservationTtlMs) || quote.reservationTtlMs <= 0) {
      throw new TreasuryCapacityError(
        "Treasury reservation TTL is invalid",
        "treasury_quote_invalid",
      );
    }
    const policy = this.journal.installPolicy(this.currentPurchasePolicy());
    const expiresAtMs = Math.min(
      input.termsExpiresAtMs,
      input.authorization.expiresAtMs,
      safeAdd(requireTimestamp(purchase.now()), quote.reservationTtlMs),
    );
    const reservation = this.journal.reservePolicy({
      id: input.reservationId,
      purchaseId: input.purchaseId,
      policyDigest: policy.digest,
      approvalEvidenceDigest: input.authorization.evidenceDigest,
      approvalVerificationProfile: input.authorization.verificationProfile,
      approvalVerifierId: input.authorization.verifierId,
      payee: input.terms.payTo,
      amountAtomic: input.terms.amountAtomic,
      additionalCostCeilingAtomic: quote.additionalCostCeilingAtomic,
      fundingSource: "vault-treasury",
      expiresAtMs,
    });
    return Object.freeze({ status: "reserved", reservation });
  }

  async preparePurchaseStaging(
    input: Readonly<PreparePurchaseStagingInput>,
  ): Promise<Readonly<TreasuryStagingPreparationResult>> {
    const purchase = this.requirePurchase();
    const attempt = this.journal.requirePaymentAttempt(
      input.purchaseId,
      input.attempt,
    );
    const existing = this.journal.findTreasuryStagingPlan(
      input.purchaseId,
      input.attempt,
    );
    if (existing) return stagingPreparationResult(existing.payloadDigest);
    if (attempt.state !== "planned") {
      throw new TreasuryStagingPreparationError(
        `Treasury staging requires a planned Payment Attempt, found ${attempt.state}`,
        "payment_invariant",
      );
    }

    const leaseName = treasuryStagingPreparationLeaseName(
      input.purchaseId,
      input.attempt,
    );
    let lease = this.journal.acquireLease(
      leaseName,
      this.driverOwner,
      STAGING_PREPARATION_LEASE_TTL_MS,
    );
    if (!lease) {
      const winningPlan = this.journal.findTreasuryStagingPlan(
        input.purchaseId,
        input.attempt,
      );
      if (winningPlan) {
        return stagingPreparationResult(winningPlan.payloadDigest);
      }
      throw new TreasuryStagingPreparationError(
        "Treasury staging preparation is already active",
        "treasury_staging_busy",
      );
    }

    let leaseLost: unknown;
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        lease = this.journal.renewLease(
          lease as TreasuryStagingPreparationLease,
          STAGING_PREPARATION_LEASE_TTL_MS,
        );
      } catch (error) {
        leaseLost = error;
      }
    }, Math.max(10, Math.floor(STAGING_PREPARATION_LEASE_TTL_MS / 3)));
    heartbeat.unref();
    try {
      const winningPlan = this.journal.findTreasuryStagingPlan(
        input.purchaseId,
        input.attempt,
      );
      if (winningPlan) {
        return stagingPreparationResult(winningPlan.payloadDigest);
      }
      const context = this.journal.requirePurchaseExecutionContext(
        input.purchaseId,
        input.attempt,
      );
      if (context.execution.paymentIdentifier !== attempt.identifier) {
        throw new TreasuryStagingPreparationError(
          "Treasury staging Payment Attempt does not match its durable execution context",
          "payment_invariant",
        );
      }
      this.journal.expireReservations();
      const reservation = this.journal.findReservationForPurchase(
        input.purchaseId,
      );
      if (
        !reservation ||
        reservation.state !== "active" ||
        reservation.fundingSource !== "vault-treasury"
      ) {
        throw new TreasuryStagingPreparationError(
          "Treasury staging requires this Purchase's active Reservation",
          "treasury_reservation_invariant",
        );
      }
      if (reservation.policyDigest !== this.journal.requireActivePolicy().digest) {
        throw new TreasuryStagingPreparationError(
          "active Treasury policy changed before staging preparation",
          "treasury_reservation_invariant",
        );
      }

      const prepared = await purchase.staging.prepareStaging({
        execution: context.execution,
        request: context.request,
        paymentRequirements: Uint8Array.from(context.paymentRequirements),
        additionalCostCeilingAtomic: reservation.additionalCostCeilingAtomic,
      });
      if (leaseLost) {
        throw new TreasuryStagingPreparationError(
          "Treasury staging preparation lost its exclusive lease",
          "treasury_staging_busy",
          { cause: leaseLost },
        );
      }
      lease = this.journal.renewLease(
        lease,
        STAGING_PREPARATION_LEASE_TTL_MS,
      );
      const preparedBytes = Uint8Array.from(prepared.preparedBytes);
      validatePreparedPurchaseStaging(
        prepared,
        preparedBytes,
        BigInt(reservation.amountAtomic) +
          BigInt(reservation.additionalCostCeilingAtomic),
      );
      const plan = this.journal.commitTreasuryStagingPreparation(lease, {
        purchaseId: input.purchaseId,
        attempt: input.attempt,
        reservationId: reservation.id,
        idempotencyKey: `treasury-staging:${attempt.identifier}`,
        payloadDigest: prepared.preparedDigest,
        preparedBytes,
        plannedTransactionId: prepared.transactionId,
        expectedOutpoint: prepared.expectedOutpoint,
        stagingAmountAtomic: prepared.stagingAmountAtomic,
        fundingSource: prepared.fundingSource,
      });
      return stagingPreparationResult(plan.payloadDigest);
    } finally {
      clearInterval(heartbeat);
      if (!leaseLost) this.journal.releaseLease(lease);
    }
  }

  async executePurchaseStaging(
    input: Readonly<ExecutePurchaseStagingInput>,
  ): Promise<Readonly<TreasuryStagingExecutionResult>> {
    this.requirePurchase();
    for (let step = 0; step < 3; step += 1) {
      const observation = this.journal.findTreasuryStagingObservation(
        input.purchaseId,
        input.attempt,
      );
      if (observation) {
        return Object.freeze({
          status: "observed",
          evidenceDigest: observation.evidenceDigest,
        });
      }

      const plan = this.journal.requireTreasuryStagingPlan(
        input.purchaseId,
        input.attempt,
      );
      const effect = this.journal.requireEffect(plan.effectId);
      if (
        effect.purchaseId !== input.purchaseId ||
        effect.attempt !== input.attempt
      ) {
        throw new TreasuryStagingPreparationError(
          "Treasury staging Effect does not match its durable plan",
          "treasury_staging_mismatch",
        );
      }

      if (effect.state === "planned" || effect.state === "retryable") {
        return this.submitPreparedPurchaseStaging(input, effect);
      }
      if (
        effect.state === "executing" ||
        effect.state === "submitted" ||
        effect.state === "ambiguous"
      ) {
        const reconciled = await this.reconcilePurchaseStaging(input, effect);
        if (reconciled === "retry") continue;
        return reconciled;
      }
      if (effect.state === "observed") {
        throw new TreasuryStagingPreparationError(
          "observed Treasury staging lost its durable output",
          "treasury_staging_mismatch",
        );
      }
      return Object.freeze({
        status: "reconciliation_required",
        detailDigest:
          effect.resultDigest ??
          effect.submissionDigest ??
          effect.payloadDigest,
      });
    }
    throw new TreasuryStagingPreparationError(
      "Treasury staging exceeded its bounded execution steps",
      "treasury_staging_busy",
    );
  }

  private async submitPreparedPurchaseStaging(
    input: Readonly<ExecutePurchaseStagingInput>,
    effect: Readonly<EffectRecord>,
  ): Promise<Readonly<TreasuryStagingExecutionResult>> {
    const purchase = this.requirePurchase();
    const plan = this.journal.requireTreasuryStagingPlan(
      input.purchaseId,
      input.attempt,
    );
    const claim = this.journal.beginTreasuryStaging(
      effect.id,
      plan.reservationId,
      `${this.driverOwner}:staging`,
      purchase.stagingExecutionLeaseTtlMs,
    );
    if (!claim) return Object.freeze({ status: "pending" });

    let lease = claim.lease;
    let leaseLost: unknown;
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        lease = this.journal.renewLease(
          lease,
          purchase.stagingExecutionLeaseTtlMs,
        );
      } catch (error) {
        leaseLost = error;
        abortController.abort();
      }
    }, Math.max(10, Math.floor(purchase.stagingExecutionLeaseTtlMs / 3)));
    heartbeat.unref();

    try {
      let result;
      try {
        result = await purchase.staging.submitStaging({
          context: this.purchaseStagingAdapterContext(input),
          effect: claim.effect,
          signal: abortController.signal,
        });
      } catch (error) {
        const detailDigest = stagingErrorDigest("submit", error);
        if (leaseLost) {
          return Object.freeze({
            status: "reconciliation_required",
            detailDigest,
          });
        }
        const activeClaim: EffectClaim = { effect: claim.effect, lease };
        this.journal.markEffectAmbiguous(activeClaim, detailDigest);
        return Object.freeze({
          status: "reconciliation_required",
          detailDigest,
        });
      }

      if (leaseLost) {
        return Object.freeze({
          status: "reconciliation_required",
          detailDigest: stagingErrorDigest("submit-lease", leaseLost),
        });
      }
      const activeClaim: EffectClaim = { effect: claim.effect, lease };
      this.journal.markEffectSubmitted(activeClaim, result.submissionDigest);
      if (result.status === "submitted") {
        return Object.freeze({
          status: "reconciliation_required",
          detailDigest: result.submissionDigest,
        });
      }
      return this.recordObservedPurchaseStaging(
        input,
        activeClaim.lease,
        result.staging,
      );
    } finally {
      clearInterval(heartbeat);
      if (!leaseLost) this.journal.releaseLease(lease);
    }
  }

  private async reconcilePurchaseStaging(
    input: Readonly<ExecutePurchaseStagingInput>,
    effect: Readonly<EffectRecord>,
  ): Promise<Readonly<TreasuryStagingExecutionResult> | "retry"> {
    const purchase = this.requirePurchase();
    const leaseName = `purchase-reconciliation:${input.purchaseId}`;
    let lease = this.journal.acquireLease(
      leaseName,
      `${this.driverOwner}:staging-reconciliation`,
      purchase.stagingReconciliationLeaseTtlMs,
    );
    if (!lease) return Object.freeze({ status: "pending" });

    let leaseLost: unknown;
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        lease = this.journal.renewLease(
          lease as LeaseToken,
          purchase.stagingReconciliationLeaseTtlMs,
        );
      } catch (error) {
        leaseLost = error;
      }
    }, Math.max(
      10,
      Math.floor(purchase.stagingReconciliationLeaseTtlMs / 3),
    ));
    heartbeat.unref();

    try {
      if (this.journal.effectClaimActive(effect.id)) {
        this.journal.recordReconciliation(
          lease,
          input.purchaseId,
          effect.id,
          "executor_active",
        );
        return Object.freeze({ status: "pending" });
      }
      this.journal.verifyEffectPreparedMaterial(effect.id);

      let observation: TreasuryStagingRecoveryObservation;
      try {
        observation = await purchase.staging.observeStaging({
          context: this.purchaseStagingAdapterContext(input),
          effect: this.journal.requireEffect(effect.id),
        });
      } catch (error) {
        const detailDigest = stagingErrorDigest("observe", error);
        if (leaseLost) {
          return Object.freeze({
            status: "reconciliation_required",
            detailDigest,
          });
        }
        lease = this.journal.renewLease(
          lease,
          purchase.stagingReconciliationLeaseTtlMs,
        );
        this.journal.recordReconciliation(
          lease,
          input.purchaseId,
          effect.id,
          "observer_error",
          detailDigest,
        );
        return Object.freeze({
          status: "reconciliation_required",
          detailDigest,
        });
      }

      if (leaseLost) {
        return Object.freeze({
          status: "reconciliation_required",
          detailDigest: stagingErrorDigest("observe-lease", leaseLost),
        });
      }
      lease = this.journal.renewLease(
        lease,
        purchase.stagingReconciliationLeaseTtlMs,
      );
      if (observation.status === "staged") {
        const observed = this.recordObservedPurchaseStaging(
          input,
          lease,
          observation.staging,
        );
        this.journal.recordReconciliation(
          lease,
          input.purchaseId,
          effect.id,
          "treasury_staging_observed",
          observed.evidenceDigest,
        );
        return observed;
      }

      const updated = this.journal.recordEffectObservation(
        effect.id,
        lease,
        stagingEffectObservation(observation),
      );
      const detailDigest =
        observation.detailDigest ??
        updated.resultDigest ??
        updated.submissionDigest ??
        updated.payloadDigest;
      this.journal.recordReconciliation(
        lease,
        input.purchaseId,
        effect.id,
        updated.state === "retryable"
          ? "retryable_after_observation"
          : `effect_${updated.state}`,
        detailDigest,
      );
      if (updated.state === "retryable") return "retry";
      return Object.freeze({
        status: "reconciliation_required",
        detailDigest,
      });
    } finally {
      clearInterval(heartbeat);
      if (!leaseLost) this.journal.releaseLease(lease);
    }
  }

  private purchaseStagingAdapterContext(
    input: Readonly<ExecutePurchaseStagingInput>,
  ): TreasuryStagingAdapterContext {
    const execution = this.journal.requirePurchaseExecutionContext(
      input.purchaseId,
      input.attempt,
    );
    const plan = this.journal.requireTreasuryStagingPlan(
      input.purchaseId,
      input.attempt,
    );
    return Object.freeze({
      ...execution,
      staging: Object.freeze({
        preparedBytes: this.journal.readPreparedTreasuryStaging(
          input.purchaseId,
          input.attempt,
        ),
        preparedDigest: plan.payloadDigest,
        transactionId: plan.plannedTransactionId,
        expectedOutpoint: plan.expectedOutpoint,
        amountAtomic: plan.stagingAmountAtomic,
        fundingSource: "vault-treasury" as const,
      }),
    });
  }

  private recordObservedPurchaseStaging(
    input: Readonly<ExecutePurchaseStagingInput>,
    lease: LeaseToken,
    staging: Readonly<TreasuryStagingResult>,
  ): Readonly<Extract<TreasuryStagingExecutionResult, { status: "observed" }>> {
    const plan = this.journal.requireTreasuryStagingPlan(
      input.purchaseId,
      input.attempt,
    );
    if (
      staging.transactionId !== plan.plannedTransactionId ||
      staging.outpoint !== plan.expectedOutpoint ||
      staging.stagingAmountAtomic !== plan.stagingAmountAtomic ||
      staging.fundingSource !== plan.fundingSource
    ) {
      throw new TreasuryStagingPreparationError(
        "observed Treasury staging changed its durable plan",
        "treasury_staging_mismatch",
      );
    }
    const artifactDigest = evidenceDigest(staging.evidence.bytes);
    if (
      (staging.evidence.declaredDigest !== undefined &&
        staging.evidence.declaredDigest !== artifactDigest) ||
      staging.evidence.profile !== staging.evidence.verification.profile
    ) {
      throw new TreasuryStagingPreparationError(
        "Treasury staging evidence is not bound to its verified bytes",
        "treasury_staging_mismatch",
      );
    }
    const stored = this.journal.storeEvidence(input.purchaseId, {
      bytes: staging.evidence.bytes,
      mediaType: staging.evidence.mediaType,
      profile: staging.evidence.profile,
      issuer: staging.evidence.issuer,
      kind: "treasury-staging-output",
      attempt: input.attempt,
    });
    this.journal.recordEvidenceVerification(
      stored.digest,
      staging.evidence.verification,
    );
    const observed = this.journal.recordObservedTreasuryStaging(lease, {
      effectId: plan.effectId,
      reservationId: plan.reservationId,
      transactionId: staging.transactionId,
      outpoint: staging.outpoint,
      stagingAmountAtomic: staging.stagingAmountAtomic,
      fundingSource: staging.fundingSource,
      evidenceDigest: stored.digest,
      evidenceVerificationProfile: staging.evidence.verification.profile,
      evidenceVerifierId: staging.evidence.verification.verifierId,
    });
    return Object.freeze({
      status: "observed",
      evidenceDigest: observed.evidenceDigest,
    });
  }

  async recoverPurchaseStaging(
    input: Readonly<RecoverPurchaseStagingInput>,
  ): Promise<PurchaseStagingRecoveryResult> {
    const purchase = this.requirePurchase();
    const attempts = this.journal.paymentAttempts(input.purchaseId);
    if (attempts.length !== 1) return stagingRecoveryResult("none");
    const attempt = attempts[0];
    let recovery = this.journal.treasuryStagingRecoveryJournalContext(
      input.purchaseId,
      attempt.attempt,
    );

    if (
      this.journal.findSettlementForPurchase(input.purchaseId) &&
      !recovery
    ) {
      return stagingRecoveryResult("none");
    }
    const staged = this.journal.treasuryStagingRecoveryContext(
      input.purchaseId,
      attempt.attempt,
    );
    if (
      !staged?.observation ||
      (!recovery && staged.reservation.state !== "in_flight")
    ) {
      return stagingRecoveryResult("none");
    }

    if (!recovery) {
      const purchaseRecord = this.journal.requirePurchase(input.purchaseId);
      const paymentEffect = this.journal
        .effectsForPurchase(input.purchaseId)
        .find((effect) => effect.kind === PURCHASE_PAYMENT_EFFECT_KIND);
      const terminalPayment = Boolean(
        paymentEffect &&
          ["failed_terminal", "abandoned"].includes(paymentEffect.state),
      );
      const execution = this.journal.requirePurchaseExecutionContext(
        input.purchaseId,
        attempt.attempt,
      );
      const authorizationExpired =
        Math.min(
          Date.parse(execution.execution.terms.expiresAt),
          execution.execution.authorizationRequest.expiresAtMs,
        ) <= purchase.now();
      if (
        purchaseRecord.state !== "failed_recoverable" ||
        (!authorizationExpired && !terminalPayment)
      ) {
        return stagingRecoveryResult("none");
      }

      const acquiredPlanningLease = this.journal.acquireLease(
        `treasury-staging-recovery-plan:${input.purchaseId}`,
        `${this.driverOwner}:staging-recovery-plan`,
        purchase.stagingExecutionLeaseTtlMs,
      );
      if (!acquiredPlanningLease) return stagingRecoveryResult("pending");
      let planningLease = acquiredPlanningLease;
      let leaseLost: unknown;
      const heartbeat = setInterval(() => {
        if (leaseLost) return;
        try {
          planningLease = this.journal.renewLease(
            planningLease,
            purchase.stagingExecutionLeaseTtlMs,
          );
        } catch (error) {
          leaseLost = error;
        }
      }, Math.max(
        10,
        Math.floor(purchase.stagingExecutionLeaseTtlMs / 3),
      ));
      heartbeat.unref();
      try {
        recovery = this.journal.treasuryStagingRecoveryJournalContext(
          input.purchaseId,
          attempt.attempt,
        );
        if (!recovery) {
          const exactPayment = this.stagingRecoveryExactPayment(
            input.purchaseId,
            attempt.attempt,
          );
          const prepared = await purchase.stagingRecovery.prepare({
            purchaseId: input.purchaseId,
            paymentIdentifier: attempt.identifier,
            terms: execution.execution.terms,
            paymentRequirements: execution.paymentRequirements,
            stagingEvidenceDigest: staged.observation.evidenceDigest,
            exactPayment,
            authorizedAdditionalCostCeilingAtomic:
              staged.reservation.additionalCostCeilingAtomic,
          });
          validatePreparedStagingRecovery(
            prepared,
            exactPayment?.transactionId,
            staged.observation.stagingAmountAtomic,
          );
          if (leaseLost) return stagingRecoveryResult("pending");
          planningLease = this.journal.renewLease(
            planningLease,
            purchase.stagingExecutionLeaseTtlMs,
          );
          this.journal.planTreasuryStagingRecovery(
            {
              purchaseId: input.purchaseId,
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
            },
            planningLease,
          );
          recovery = this.journal.treasuryStagingRecoveryJournalContext(
            input.purchaseId,
            attempt.attempt,
          );
        }
      } catch (error) {
        if (error instanceof JournalFencingError) {
          return stagingRecoveryResult("pending");
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
        if (!leaseLost) this.journal.releaseLease(planningLease);
      }
    }

    if (!recovery) return stagingRecoveryResult("pending");
    return this.drivePurchaseStagingRecovery(recovery);
  }

  private stagingRecoveryExactPayment(
    purchaseId: RecoverPurchaseStagingInput["purchaseId"],
    attempt: number,
  ): StagingRecoveryPreparationContext["exactPayment"] | undefined {
    try {
      const preparation = this.journal.requirePaymentPreparation(
        purchaseId,
        attempt,
      );
      if (
        preparation.mechanism !== "single-transaction" ||
        !preparation.transactionId
      ) {
        return undefined;
      }
      return Object.freeze({
        preparedBytes: this.journal.readPreparedPayment(purchaseId, attempt),
        preparedDigest: preparation.payloadDigest,
        transactionId: preparation.transactionId,
        requiredFinality: preparation.requiredAssurance,
      });
    } catch (error) {
      if (error instanceof JournalNotFoundError) return undefined;
      throw error;
    }
  }

  private async drivePurchaseStagingRecovery(
    recovery: TreasuryStagingRecoveryJournalContext,
  ): Promise<PurchaseStagingRecoveryResult> {
    if (recovery.accounting) return stagingRecoveryResult("recovery_won");
    if (recovery.effect.state === "observed") {
      return stagingRecoveryResult("exact_payment_won");
    }
    if (recovery.effect.state === "failed_terminal") {
      return stagingRecoveryResult("conflict");
    }
    if (
      recovery.effect.state === "planned" ||
      recovery.effect.state === "retryable"
    ) {
      return this.drivePlannedPurchaseStagingRecovery(recovery);
    }
    return this.reconcilePurchaseStagingRecovery(recovery);
  }

  private async drivePlannedPurchaseStagingRecovery(
    recovery: TreasuryStagingRecoveryJournalContext,
  ): Promise<PurchaseStagingRecoveryResult> {
    const purchase = this.requirePurchase();
    const claim = this.journal.beginTreasuryStagingRecovery(
      recovery.effect.id,
      `${this.driverOwner}:staging-recovery`,
      purchase.stagingExecutionLeaseTtlMs,
    );
    if (!claim) return stagingRecoveryResult("pending");
    let lease = claim.lease;
    let leaseLost: unknown;
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        lease = this.journal.renewLease(
          lease,
          purchase.stagingExecutionLeaseTtlMs,
        );
      } catch (error) {
        leaseLost = error;
        abortController.abort();
      }
    }, Math.max(10, Math.floor(purchase.stagingExecutionLeaseTtlMs / 3)));
    heartbeat.unref();

    try {
      const preparedBytes =
        this.journal.readPreparedTreasuryStagingRecovery(
          recovery.plan.purchaseId,
          recovery.plan.attempt,
        );
      let observed: Readonly<StagingRecoveryObservation>;
      try {
        observed = await purchase.stagingRecovery.observe({
          preparedBytes,
          signal: abortController.signal,
        });
      } catch (error) {
        if (leaseLost) return stagingRecoveryResult("pending");
        this.journal.markEffectAmbiguous(
          { effect: claim.effect, lease },
          stagingErrorDigest("recovery-observe", error),
        );
        return stagingRecoveryResult("pending");
      }
      if (leaseLost) return stagingRecoveryResult("pending");
      const outcome = this.recordStagingRecoveryObservation(
        recovery.effect.id,
        lease,
        observed,
      );
      if (observed.status !== "safe_to_submit") return outcome;

      let submitted;
      try {
        submitted = await purchase.stagingRecovery.submit({
          preparedBytes,
          readiness: observed.readiness,
          signal: abortController.signal,
        });
      } catch (error) {
        if (leaseLost) return stagingRecoveryResult("pending");
        this.journal.markEffectAmbiguous(
          { effect: claim.effect, lease },
          stagingErrorDigest("recovery-submit", error),
        );
        return stagingRecoveryResult("pending");
      }
      if (leaseLost) return stagingRecoveryResult("pending");
      if (submitted.transactionId !== recovery.plan.recoveryTransactionId) {
        this.journal.markEffectAmbiguous(
          { effect: claim.effect, lease },
          evidenceDigest("treasury-staging-recovery:transaction-mismatch"),
        );
        return stagingRecoveryResult("pending");
      }
      const activeClaim: EffectClaim = { effect: claim.effect, lease };
      if (submitted.status === "accepted") {
        this.journal.markEffectSubmitted(
          activeClaim,
          submitted.submissionDigest,
        );
      } else {
        this.journal.markEffectAmbiguous(
          activeClaim,
          submitted.submissionDigest,
        );
      }
      return stagingRecoveryResult("pending");
    } catch (error) {
      if (error instanceof JournalFencingError) {
        return stagingRecoveryResult("pending");
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (!leaseLost) {
        try {
          this.journal.releaseLease(lease);
        } catch (error) {
          if (!(error instanceof JournalFencingError)) throw error;
        }
      }
    }
  }

  private async reconcilePurchaseStagingRecovery(
    recovery: TreasuryStagingRecoveryJournalContext,
  ): Promise<PurchaseStagingRecoveryResult> {
    const purchase = this.requirePurchase();
    const acquiredLease = this.journal.acquireLease(
      `purchase-reconciliation:${recovery.plan.purchaseId}`,
      `${this.driverOwner}:staging-recovery-observer`,
      purchase.stagingReconciliationLeaseTtlMs,
    );
    if (!acquiredLease) return stagingRecoveryResult("pending");
    let lease = acquiredLease;
    let leaseLost: unknown;
    let released = false;
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        lease = this.journal.renewLease(
          lease,
          purchase.stagingReconciliationLeaseTtlMs,
        );
      } catch (error) {
        leaseLost = error;
      }
    }, Math.max(
      10,
      Math.floor(purchase.stagingReconciliationLeaseTtlMs / 3),
    ));
    heartbeat.unref();

    try {
      if (this.journal.effectClaimActive(recovery.effect.id)) {
        return stagingRecoveryResult("pending");
      }
      const observed = await purchase.stagingRecovery.observe({
        preparedBytes: this.journal.readPreparedTreasuryStagingRecovery(
          recovery.plan.purchaseId,
          recovery.plan.attempt,
        ),
      });
      if (leaseLost) return stagingRecoveryResult("pending");
      lease = this.journal.renewLease(
        lease,
        purchase.stagingReconciliationLeaseTtlMs,
      );
      const outcome = this.recordStagingRecoveryObservation(
        recovery.effect.id,
        lease,
        observed,
      );
      if (observed.status !== "safe_to_submit") return outcome;

      const refreshed = this.journal.treasuryStagingRecoveryJournalContext(
        recovery.plan.purchaseId,
        recovery.plan.attempt,
      );
      if (!refreshed) return stagingRecoveryResult("pending");
      this.journal.releaseLease(lease);
      released = true;
      return this.drivePurchaseStagingRecovery(refreshed);
    } catch (error) {
      if (error instanceof JournalFencingError) {
        return stagingRecoveryResult("pending");
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (!released && !leaseLost) {
        try {
          this.journal.releaseLease(lease);
        } catch (error) {
          if (!(error instanceof JournalFencingError)) throw error;
        }
      }
    }
  }

  private recordStagingRecoveryObservation(
    effectId: string,
    lease: LeaseToken,
    observed: Readonly<StagingRecoveryObservation>,
  ): PurchaseStagingRecoveryResult {
    this.journal.recordTreasuryStagingRecoveryObservation(
      effectId,
      lease,
      stagingRecoveryJournalObservation(observed),
    );
    return stagingRecoveryResult(
      observed.status === "safe_to_submit" ? "pending" : observed.status,
    );
  }

  async execute(
    request: Readonly<TreasuryOperationRequest>,
    signal?: AbortSignal,
  ): Promise<TreasuryOperationView> {
    return this.executeUnderPolicy(request, {}, signal);
  }

  async executeUnderPolicy(
    request: Readonly<TreasuryOperationRequest>,
    authorization: Readonly<TreasuryAuthorizedExecution>,
    signal?: AbortSignal,
  ): Promise<TreasuryOperationView> {
    throwIfAborted(signal);
    const normalized = normalizeRequest(request);
    const adapter = this.requireAdapter(normalized.kind);
    adapter.validateRequest?.({
      ...normalized,
      requestedAmountAtomic: normalized.amountAtomic,
    });
    const policy = this.installCurrentPolicy();
    if (
      authorization.expectedPolicyDigest !== undefined &&
      policy.digest !== authorization.expectedPolicyDigest
    ) {
      throw new TreasuryOperationError("Treasury policy changed after human authorization");
    }
    const record = this.journal.claimTreasuryOperationIntent({
      ...normalized,
      requestDigest: requestDigest(normalized),
      requestedAmountAtomic: normalized.amountAtomic,
      keepFloatAtomic: normalized.keepFloatAtomic,
      feeCeilingAtomic: this.feeCeilingAtomic,
      retryLimit: this.directTreasuryRetries,
      policyDigest: policy.digest,
      authorizationEvidenceDigest: authorization.authorizationEvidenceDigest,
    });
    return this.drive(record.operationKey, signal);
  }

  /**
   * Read-only hard-policy and capacity check for an operation that will obtain
   * exact human authorization before execution. The Journal repeats the same
   * check transactionally when the durable intent is claimed.
   */
  preflightHumanAuthorized(
    request: Readonly<TreasuryOperationRequest>,
  ): Readonly<{ policyDigest: string; feeCeilingAtomic: string }> {
    const normalized = normalizeRequest(request);
    if (normalized.amountAtomic === "max") {
      throw new TreasuryOperationError("Human-authorized Treasury preflight requires an exact amount");
    }
    const adapter = this.requireAdapter(normalized.kind);
    adapter.validateRequest?.({
      ...normalized,
      requestedAmountAtomic: normalized.amountAtomic,
    });
    const policy = this.installCurrentPolicy();
    this.journal.preflightTreasuryOperation({
      kind: normalized.kind,
      destination: normalized.destination,
      amountAtomic: normalized.amountAtomic,
      feeCeilingAtomic: this.feeCeilingAtomic,
      policyDigest: policy.digest,
      humanApprovalExpected: true,
    });
    return Object.freeze({
      policyDigest: policy.digest,
      feeCeilingAtomic: this.feeCeilingAtomic,
    });
  }

  authorizationContext(): Readonly<{ policyDigest: string; feeCeilingAtomic: string }> {
    return Object.freeze({
      policyDigest: this.installCurrentPolicy().digest,
      feeCeilingAtomic: this.feeCeilingAtomic,
    });
  }

  status(operationKey: string): TreasuryOperationView {
    const normalizedKey = requireOperationKey(operationKey);
    const operation = this.journal.findTreasuryOperation(normalizedKey);
    if (!operation) throw new TreasuryOperationNotFoundError();
    return view(operation);
  }

  recent(kind: TreasuryOperationKind, limit = 20): readonly TreasuryOperationView[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TreasuryOperationError("Treasury activity limit must be between 1 and 100");
    }
    return Object.freeze(this.journal.listTreasuryOperations(kind, limit).map(view));
  }

  async recover(operationKey: string, signal?: AbortSignal): Promise<TreasuryOperationView> {
    throwIfAborted(signal);
    this.installCurrentPolicy();
    return this.drive(requireOperationKey(operationKey), signal);
  }

  async cancel(operationKey: string): Promise<TreasuryOperationView> {
    const normalizedKey = requireOperationKey(operationKey);
    const current = this.journal.requireTreasuryOperation(normalizedKey);
    if (current.state === "intent" && current.driverOwner !== undefined) {
      return view(this.journal.requestTreasuryOperationCancellation(normalizedKey));
    }
    return view(
      this.journal.cancelTreasuryOperation(normalizedKey)
    );
  }

  spentLastHour(): bigint {
    return this.journal.treasuryOperationSpentLastHour();
  }

  effectiveCapacityUsed(): bigint {
    return this.journal.treasuryPolicyCapacityUsed();
  }

  pendingCapacityUsed(): bigint {
    return this.journal.treasuryPendingCapacityUsed();
  }

  integrityCheck(): true {
    return this.journal.integrityCheck();
  }

  unresolvedCount(): number {
    return this.journal.unresolvedTreasuryOperationCount();
  }

  private async drive(
    operationKey: string,
    signal?: AbortSignal,
  ): Promise<TreasuryOperationView> {
    const existing = this.activeDrivePromises.get(operationKey);
    if (existing) return existing;
    const promise = this.driveUncoordinated(operationKey, signal);
    this.activeDrivePromises.set(operationKey, promise);
    try {
      return await promise;
    } finally {
      if (this.activeDrivePromises.get(operationKey) === promise) {
        this.activeDrivePromises.delete(operationKey);
      }
    }
  }

  private async driveUncoordinated(
    operationKey: string,
    signal?: AbortSignal,
  ): Promise<TreasuryOperationView> {
    const claim = this.journal.claimTreasuryOperationDriver(
      operationKey,
      this.driverOwner,
      DRIVER_LEASE_TTL_MS,
    );
    if (!claim.acquired || !claim.lease) {
      return this.waitForDriver(operationKey, signal);
    }
    return this.driveClaimed(operationKey, claim.lease, signal);
  }

  private async driveClaimed(
    operationKey: string,
    lease: TreasuryDriverLease,
    signal?: AbortSignal,
  ): Promise<TreasuryOperationView> {
    const renewDriver = () => {
      try {
        this.journal.renewTreasuryOperationDriver(lease, operationKey);
      } catch {
        // The Journal generation checks below fence the stale worker. The
        // worker must never attempt a takeover or release a successor's lease.
      }
    };
    const driverHeartbeat = setInterval(renewDriver, Math.floor(DRIVER_LEASE_TTL_MS / 3));
    driverHeartbeat.unref();
    const onAbort = () => {
      try {
        this.journal.requestTreasuryOperationCancellation(operationKey);
      } catch {
        // The owning driver continues to reconcile; cancellation is durable
        // when the Journal accepts it and never releases protected capacity.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      return await this.driveOwned(operationKey, lease);
    } finally {
      clearInterval(driverHeartbeat);
      signal?.removeEventListener("abort", onAbort);
      try {
        this.journal.releaseTreasuryOperationDriver(lease, operationKey);
      } catch {
        // A stale or expired owner must not overwrite a successor's lease.
      }
    }
  }

  private async waitForDriver(
    operationKey: string,
    signal?: AbortSignal,
  ): Promise<TreasuryOperationView> {
    for (let attempt = 0; attempt < DRIVER_WAIT_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        try {
          this.journal.requestTreasuryOperationCancellation(operationKey);
        } catch {
          // Preserve the durable driver's reconciliation responsibility.
        }
        throw new TreasuryOperationError("Treasury operation request was cancelled");
      }
      const current = this.journal.requireTreasuryOperation(operationKey);
      if (current.state === "completed" || current.state === "failed_terminal") return view(current);
      const claim = this.journal.claimTreasuryOperationDriver(
        operationKey,
        this.driverOwner,
        DRIVER_LEASE_TTL_MS,
      );
      if (claim.acquired) {
        if (!claim.lease) {
          throw new TreasuryOperationError("Journal acquired a Treasury driver without its lease");
        }
        return this.driveClaimed(operationKey, claim.lease, signal);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, DRIVER_WAIT_MS));
    }
    return view(this.journal.requireTreasuryOperation(operationKey));
  }

  private async driveOwned(
    operationKey: string,
    driver: TreasuryDriverLease,
  ): Promise<TreasuryOperationView> {
    let record = this.journal.requireTreasuryOperation(operationKey);
    const adapter = this.requireAdapter(record.kind);

    if (record.state === "completed" || record.state === "failed_terminal") return view(record);
    if (record.preparationFenced || (record.cancellationRequested && (record.state === "intent" || record.state === "prepared"))) {
      return view(record);
    }

    if (record.state === "intent") {
      if (record.retryCount >= record.retryLimit) {
        throw new TreasuryOperationError(
          "direct Treasury preparation retry limit was reached; recover or replace the operation"
        );
      }
      let prepared;
      try {
        prepared = await adapter.prepare(record, (destination, amount) => {
          this.authorize(operationKey, destination, amount);
        });
      } catch (error) {
        if (isTerminalPreEffectFailure(error)) {
          return view(this.journal.failTreasuryOperationPreparation(operationKey, error.code, driver));
        }
        if (isTransientPreparationFailure(error)) {
          const updated = this.journal.recordTreasuryPreparationRetry(
            operationKey,
            "transient_preparation_failure",
            driver,
          );
          if (updated.cancellationRequested) {
            return view(this.journal.failTreasuryOperationPreparation(operationKey, "cancelled_before_effect", driver));
          }
          if (updated.retryCount >= updated.retryLimit) {
            // The adapter contract classified this failure as proven
            // no-effect. The final manifest-bounded attempt therefore closes
            // the intent explicitly and releases its exclusive slot instead
            // of leaving an unrecoverable capacity leak.
            return view(this.journal.failTreasuryOperationPreparation(
              operationKey,
              "retry_exhausted",
              driver,
            ));
          }
        } else {
          this.journal.fenceTreasuryOperationPreparation(
            operationKey,
            "unknown_preparation_failure",
            driver,
          );
        }
        throw error;
      }
      if (!record.policyDigest) throw new TreasuryOperationError("Treasury operation has no durable policy snapshot");
      try {
        record = this.journal.recordPreparedTreasuryOperation(
          operationKey,
          { ...prepared, policyDigest: record.policyDigest },
          driver,
        );
      } catch (error) {
        const latest = this.journal.requireTreasuryOperation(operationKey);
        if (
          latest.state === "intent" &&
          latest.cancellationRequested &&
          !latest.preparationFenced
        ) {
          return view(this.journal.failTreasuryOperationPreparation(
            operationKey,
            "cancelled_before_effect",
            driver,
          ));
        }
        throw error;
      }
      if (record.cancellationRequested || record.preparationFenced) return view(record);
    }

    if (record.state === "observed") {
      await adapter.commit(
        record,
        this.journal.readPreparedTreasuryOperation(operationKey),
        this.journal.readObservedTreasuryOperationDetail(operationKey),
      );
      return view(this.journal.completeTreasuryOperation(operationKey, driver));
    }

    if (record.state === "submission_planned" || record.state === "submitted") {
      const submissionOutcome: TreasurySubmissionOutcome = record.state === "submitted"
        ? "accepted"
        : "in_flight";
      record = await this.reconcile(
        record,
        adapter,
        driver,
        submissionOutcome,
      );
      if (record.state === "observed") {
        await adapter.commit(
          record,
          this.journal.readPreparedTreasuryOperation(operationKey),
          this.journal.readObservedTreasuryOperationDetail(operationKey),
        );
        return view(this.journal.completeTreasuryOperation(operationKey, driver));
      }
      if (record.state !== "prepared" || record.cancellationRequested) return view(record);
    }

    if (record.state !== "prepared") return view(record);
    if (record.retryCount > MAX_RECONCILED_RETRIES) {
      throw new TreasuryOperationError("Treasury operation exceeded its bounded proof-backed submission retries");
    }
    if (!record.resolvedAmountAtomic) throw new TreasuryOperationError("Prepared Treasury operation has no resolved amount");
    if (record.kind !== "vault_deposit" && record.kind !== "batch_refund") {
      this.authorize(operationKey, record.destination, BigInt(record.resolvedAmountAtomic));
    }
    if (!this.journal.planTreasuryOperationSubmission(operationKey, driver)) {
      // A cancelled/fenced operation or a successor driver owns the current
      // durable view. Never recurse with a stale generation and risk doing
      // adapter work after ownership has moved.
      return view(this.journal.requireTreasuryOperation(operationKey));
    }
    record = this.journal.requireTreasuryOperation(operationKey);
    if (!this.journal.claimTreasuryOperationEffectCapability(operationKey, driver)) {
      return view(this.journal.requireTreasuryOperation(operationKey));
    }
    record = this.journal.requireTreasuryOperation(operationKey);
    const bytes = this.journal.readPreparedTreasuryOperation(operationKey);
    let submitted: { readonly transactionId: string };
    try {
      submitted = await adapter.submit(record, bytes);
    } catch {
      // Any transport/RPC exception is ambiguous. The exact signed bytes and
      // planned identity remain durable; temporary absence cannot make retry safe.
      record = this.journal.requireTreasuryOperation(operationKey);
      record = await this.reconcile(record, adapter, driver, "ambiguous");
      return view(record);
    }
    // Journal acceptance is deliberately outside the adapter catch. An exact
    // successful result must never be downgraded to an ambiguous failure when
    // cancellation or a stale driver makes the local write reject.
    record = this.journal.recordTreasuryOperationSubmissionAccepted(
      operationKey,
      submitted.transactionId,
      driver,
    );
    record = await this.reconcile(record, adapter, driver, "accepted");
    if (record.state === "observed") {
      await adapter.commit(
        record,
        bytes,
        this.journal.readObservedTreasuryOperationDetail(operationKey),
      );
      record = this.journal.completeTreasuryOperation(operationKey, driver);
    }
    return view(record);
  }

  private async reconcile(
    record: TreasuryOperationRecord,
    adapter: TreasuryOperationAdapter,
    driver?: TreasuryDriverLease,
    submissionOutcome: TreasurySubmissionOutcome = "in_flight",
  ): Promise<TreasuryOperationRecord> {
    if (record.state !== "submission_planned" && record.state !== "submitted") return record;
    const probe = await adapter.observe(
      record,
      this.journal.readPreparedTreasuryOperation(record.operationKey)
    );
    return this.journal.recordTreasuryOperationObservation(
      record.operationKey,
      probe.status,
      probe.detail,
      driver,
      submissionOutcome,
    );
  }

  private authorize(operationKey: string, destination: string, amount: bigint): void {
    const operation = this.journal.requireTreasuryOperation(operationKey);
    if (!operation.policyDigest) {
      throw new TreasuryOperationError("Treasury operation has no durable policy snapshot");
    }
    const ownCapacity =
      (operation.kind === "vault_deposit" || operation.kind === "batch_refund"
        ? 0n
        : BigInt(operation.resolvedAmountAtomic ?? operation.requestedAmountAtomic)) +
      BigInt(operation.feeCeilingAtomic);
    const total = this.journal.treasuryPolicyCapacityUsed();
    if (ownCapacity > total) {
      throw new TreasuryOperationError("Treasury capacity accounting is inconsistent");
    }
    const snapshot = this.journal.requirePolicy(operation.policyDigest);
    new PolicyEngine({
      maxSompiPerTx: BigInt(snapshot.maxPerPaymentAtomic),
      maxSompiPerHour: BigInt(snapshot.maxPerHourAtomic),
      allowlist: [...snapshot.allowlist],
    }).authorize(destination, amount, total - ownCapacity);
  }

  private installCurrentPolicy(): { readonly digest: string } {
    return this.journal.installPolicy(this.currentPurchasePolicy());
  }

  private synchronizePolicy(): void {
    const active =
      this.journal.findActivePolicy() ??
      this.journal.installPolicy(this.currentPurchasePolicy());
    this.policy.activate(Object.freeze({
      maxSompiPerTx: BigInt(active.maxPerPaymentAtomic),
      maxSompiPerHour: BigInt(active.maxPerHourAtomic),
      allowlist: [...active.allowlist],
    }));
  }

  private currentPurchasePolicy(): TreasuryPolicy {
    const policy = this.policy.policy;
    return Object.freeze({
      maxPerPaymentAtomic: policy.maxSompiPerTx.toString(),
      maxPerHourAtomic: policy.maxSompiPerHour.toString(),
      allowlist: Object.freeze([...policy.allowlist]),
    });
  }

  private requirePurchase(): NonNullable<TreasuryOperationModule["purchase"]> {
    if (!this.purchase) {
      throw new TreasuryOperationError(
        "Purchase Treasury dependencies are unavailable",
      );
    }
    return this.purchase;
  }

  private quoteResult(
    ready: boolean,
    blockerCode?: string,
  ): TreasuryQuote {
    const purchase = this.requirePurchase();
    return Object.freeze({
      additionalCostCeilingAtomic: purchase.additionalCostCeilingAtomic,
      reservationTtlMs: purchase.reservationTtlMs,
      ready,
      ...(blockerCode === undefined ? {} : { blockerCode }),
    });
  }

  private requireAdapter(kind: TreasuryOperationKind): TreasuryOperationAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new TreasuryOperationError(`Treasury operation adapter ${kind} is unavailable`);
    return adapter;
  }
}

function normalizeRequest(request: Readonly<TreasuryOperationRequest>): {
  operationKey: string;
  kind: TreasuryOperationKind;
  destination: string;
  amountAtomic: string | "max";
  keepFloatAtomic?: string;
} {
  const operationKey = requireOperationKey(request?.operationKey);
  if (
    request.kind !== "wallet_send" &&
    request.kind !== "vault_send" &&
    request.kind !== "vault_deposit" &&
    request.kind !== "batch_refund"
  ) {
    throw new TreasuryOperationError("Treasury operation kind is invalid");
  }
  if (
    typeof request.destination !== "string" ||
    request.destination.length > 256 ||
    !ADDRESS.test(request.destination)
  ) {
    throw new TreasuryOperationError("Treasury operation destination is invalid");
  }
  if (request.amountAtomic !== "max") {
    if (
      typeof request.amountAtomic !== "string" ||
      !ATOMIC.test(request.amountAtomic) ||
      BigInt(request.amountAtomic) > (1n << 64n) - 1n
    ) {
      throw new TreasuryOperationError("Treasury operation amount is invalid");
    }
  }
  if (request.kind !== "vault_deposit" && request.amountAtomic === "max") {
    throw new TreasuryOperationError("Direct send Treasury operations require an exact amount");
  }
  if (request.keepFloatAtomic !== undefined) {
    if (request.kind !== "vault_deposit") {
      throw new TreasuryOperationError("keep-float applies only to vault deposits");
    }
    requireAtomic(request.keepFloatAtomic, "vault deposit keep-float", true);
  }
  return Object.freeze({
    operationKey,
    kind: request.kind,
    destination: request.destination,
    amountAtomic: request.amountAtomic,
    ...(request.keepFloatAtomic === undefined ? {} : { keepFloatAtomic: request.keepFloatAtomic }),
  });
}

function requestDigest(request: ReturnType<typeof normalizeRequest>): string {
  const canonical = JSON.stringify({
    profile: "urn:sompi:treasury-operation:intent:1",
    operationKey: request.operationKey,
    kind: request.kind,
    destination: request.destination,
    amountAtomic: request.amountAtomic,
    keepFloatAtomic: request.keepFloatAtomic ?? null,
    network: "kaspa:testnet-10",
  });
  return `sha256:${createHash("sha256").update(canonical).digest("base64url")}`;
}

function requireOperationKey(value: string): string {
  if (typeof value !== "string" || !OPERATION_KEY.test(value)) {
    throw new TreasuryOperationError(
      "Treasury operation key must be 1-160 characters using letters, digits, '.', '_', ':', or '-'"
    );
  }
  return value;
}

function view(record: TreasuryOperationRecord): TreasuryOperationView {
  const recoveryRequired =
    record.preparationFenced ||
    record.cancellationRequested ||
    record.state === "submission_planned" ||
    record.state === "submitted";
  const safeToRetry = !record.preparationFenced && (
    record.state === "prepared" ||
    (record.state === "intent" && record.retryCount < record.retryLimit)
  );
  const summary = record.state === "completed"
    ? `Treasury operation ${record.operationKey} completed with transaction ${record.transactionId}.`
    : record.preparationFenced
      ? `Treasury operation ${record.operationKey} requires operator reconciliation before preparation can continue.`
    : recoveryRequired
      ? `Treasury operation ${record.operationKey} has an ambiguous or not-yet-observed submission; reconcile it before retrying.`
    : record.state === "prepared"
        ? `Treasury operation ${record.operationKey} is durably prepared and safe to submit once.`
        : record.state === "failed_terminal"
          ? `Treasury operation ${record.operationKey} failed before any external effect.`
        : `Treasury operation ${record.operationKey} is ${record.state}.`;
  return Object.freeze({
    operationKey: record.operationKey,
    kind: record.kind,
    state: record.state,
    summary,
    destination: record.destination,
    requestedAmountAtomic: record.requestedAmountAtomic,
    ...(record.keepFloatAtomic === undefined ? {} : { keepFloatAtomic: record.keepFloatAtomic }),
    feeCeilingAtomic: record.feeCeilingAtomic,
    ...(record.resolvedAmountAtomic ? { amountAtomic: record.resolvedAmountAtomic } : {}),
    ...(record.feeAtomic ? { feeAtomic: record.feeAtomic } : {}),
    ...(record.transactionId ? { transactionId: record.transactionId } : {}),
    retryCount: record.retryCount,
    recoveryRequired,
    safeToRetry: record.cancellationRequested ? false : safeToRetry,
    cancellationRequested: record.cancellationRequested,
    preparationFenced: record.preparationFenced,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  });
}

function requireAtomic(value: string, label: string, allowZero = false): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    (!allowZero && value === "0") ||
    BigInt(value) > (1n << 64n) - 1n
  ) {
    throw new TreasuryOperationError(`${label} is invalid`);
  }
  return value;
}

function validatePreparedPurchaseStaging(
  prepared: Readonly<PreparedTreasuryStaging>,
  bytes: Uint8Array,
  reservedGrossAtomic: bigint,
): void {
  if (
    bytes.byteLength === 0 ||
    prepared.preparedDigest !== evidenceDigest(bytes)
  ) {
    throw new TreasuryStagingPreparationError(
      "prepared Treasury staging bytes do not match their declared digest",
      "treasury_staging_mismatch",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(prepared.transactionId)) {
    throw new TreasuryStagingPreparationError(
      "prepared Treasury staging has no canonical transaction identity",
      "treasury_staging_mismatch",
    );
  }
  const outpoint = new RegExp(
    `^${prepared.transactionId}:(0|[1-9][0-9]*)$`,
  ).exec(prepared.expectedOutpoint);
  if (!outpoint || BigInt(outpoint[1]) > 0xffff_ffffn) {
    throw new TreasuryStagingPreparationError(
      "prepared Treasury staging has no canonical expected outpoint",
      "treasury_staging_mismatch",
    );
  }
  const amount = stagingAtomic(
    prepared.stagingAmountAtomic,
    "Treasury staging amount",
  );
  if (amount > reservedGrossAtomic) {
    throw new TreasuryStagingPreparationError(
      "Treasury staging amount exceeds its exact reserved gross outflow",
      "treasury_staging_mismatch",
    );
  }
  if (prepared.fundingSource !== "vault-treasury") {
    throw new TreasuryStagingPreparationError(
      "Treasury staging used an unauthorized funding source",
      "treasury_staging_mismatch",
    );
  }
}

function stagingPreparationResult(
  payloadDigest: TreasuryStagingPreparationResult["payloadDigest"],
): Readonly<TreasuryStagingPreparationResult> {
  return Object.freeze({ payloadDigest });
}

function validatePreparedStagingRecovery(
  prepared: Readonly<PreparedStagingRecovery>,
  exactTransactionId: string | undefined,
  stagingAmountAtomic: string,
): void {
  if (
    !(prepared.preparedBytes instanceof Uint8Array) ||
    prepared.preparedBytes.byteLength === 0 ||
    evidenceDigest(prepared.preparedBytes) !== prepared.preparedDigest ||
    prepared.exactTransactionId !== exactTransactionId ||
    !/^[a-f0-9]{64}$/.test(prepared.recoveryTransactionId) ||
    prepared.recoveryOutpoint !== `${prepared.recoveryTransactionId}:0`
  ) {
    throw new TreasuryStagingPreparationError(
      "prepared staging recovery changed its immutable identity",
      "treasury_staging_mismatch",
    );
  }
  const returned = stagingRecoveryAtomic(
    prepared.recoveryAmountAtomic,
    "staging recovery returned amount",
  );
  const stagingFee = stagingRecoveryAtomic(
    prepared.stagingFeeAtomic,
    "staging transaction fee",
    true,
  );
  const recoveryFee = stagingRecoveryAtomic(
    prepared.recoveryFeeAtomic,
    "staging recovery fee",
  );
  const staged = stagingRecoveryAtomic(
    stagingAmountAtomic,
    "observed staging amount",
  );
  if (returned + recoveryFee !== staged || stagingFee < 0n) {
    throw new TreasuryStagingPreparationError(
      "prepared staging recovery does not conserve the observed staged value",
      "treasury_staging_mismatch",
    );
  }
  if (
    !paymentFinalityMeets(
      prepared.requiredFinality,
      prepared.requiredFinality,
    )
  ) {
    throw new TreasuryStagingPreparationError(
      "prepared staging recovery finality is unsupported",
      "treasury_staging_mismatch",
    );
  }
}

function stagingRecoveryJournalObservation(
  observed: Readonly<StagingRecoveryObservation>,
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
      return {
        status: "pending",
        evidenceDigest: observed.evidenceDigest,
      };
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

function stagingRecoveryResult(
  status: PurchaseStagingRecoveryResult["status"],
): PurchaseStagingRecoveryResult {
  return Object.freeze({ status });
}

function stagingEffectObservation(
  observation: Exclude<TreasuryStagingRecoveryObservation, { status: "staged" }>,
): EffectObservation {
  return observation;
}

function stagingErrorDigest(domain: string, error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  return evidenceDigest(`treasury-staging-${domain}:${name}`);
}

function stagingAtomic(value: string, label: string): bigint {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  ) {
    throw new TreasuryStagingPreparationError(
      `${label} is invalid`,
      "treasury_staging_mismatch",
    );
  }
  return BigInt(value);
}

function stagingRecoveryAtomic(
  value: string,
  label: string,
  allowZero = false,
): bigint {
  if (
    typeof value !== "string" ||
    !(allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  ) {
    throw new TreasuryStagingPreparationError(
      `${label} is invalid`,
      "treasury_staging_mismatch",
    );
  }
  return BigInt(value);
}

function requireRetryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 128) {
    throw new TreasuryOperationError("direct Treasury retry budget is invalid");
  }
  return value;
}

function requireMethod(
  value: unknown,
  label: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new TreasuryOperationError(
      `Purchase Treasury ${label} adapter is required`,
    );
  }
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TreasuryCapacityError(
      "Treasury reservation expiry is invalid",
      "treasury_quote_invalid",
    );
  }
  return result;
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TreasuryCapacityError(
      "Treasury clock is unavailable",
      "treasury_quote_invalid",
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new TreasuryOperationError("Treasury operation request was cancelled");
}

function isTerminalPreEffectFailure(
  error: unknown,
): error is TreasuryPreparationError {
  return (
    error instanceof TreasuryPreparationError &&
    error.phase === "preparation" &&
    error.effect === "none" &&
    (
      error.code === "invalid_destination" ||
      error.code === "invalid_transaction_shape" ||
      error.code === "insufficient_funds" ||
      error.code === "not_funded" ||
      error.code === "invalid_runtime_state"
    )
  );
}

function isTransientPreparationFailure(error: unknown): boolean {
  return (
    error instanceof TreasuryPreparationError &&
    error.phase === "preparation" &&
    error.effect === "none" &&
    error.code === "transient_unavailable"
  );
}
