import { evidenceDigest } from "./identity.js";
import {
  JournalFencingError,
  JournalInvariantError,
  PurchaseJournal,
  type EffectObservation,
  type EffectRecord,
  type LeaseToken,
  type RecordObservedSpendInput,
  type RecordObservedTreasuryStagingInput,
} from "./journal.js";
import type { Sha256Digest } from "./types.js";
import type { PurchaseId } from "./types.js";

export type ReconciliationObservation =
  | EffectObservation
  | {
      status: "spend_observed";
      spend: Omit<RecordObservedSpendInput, "effectId">;
    }
  | {
      status: "treasury_staging_observed";
      staging: Omit<RecordObservedTreasuryStagingInput, "effectId">;
    };

export interface EffectObserver {
  observe(effect: EffectRecord): Promise<ReconciliationObservation>;
}

export interface ReconciliationEffectResult {
  effectId: string;
  status:
    | "ready_to_execute"
    | "executor_active"
    | "retryable"
    | "observed"
    | "pending"
    | "conflict"
    | "failed_terminal"
    | "unsupported"
    | "observer_error";
  detailDigest?: Sha256Digest;
}

export interface ReconciliationSummary {
  acquired: boolean;
  leaseLost: boolean;
  results: ReconciliationEffectResult[];
}

/**
 * Observes ambiguous effects and records typed, fenced recovery facts.
 *
 * It never executes an effect. A `planned` effect is reported as ready for its
 * normal executor, while `executing`, `submitted`, and `ambiguous` effects must
 * be observed before the Purchase module can choose a next action.
 */
export class PurchaseReconciler {
  constructor(
    private readonly journal: PurchaseJournal,
    private readonly observers: ReadonlyMap<string, EffectObserver>
  ) {}

  async reconcile(holder: string, ttlMs = 30_000, purchaseId?: PurchaseId): Promise<ReconciliationSummary> {
    if (!holder.trim()) throw new JournalInvariantError("reconciliation holder is required");
    const leaseName = purchaseId ? `purchase-reconciliation:${purchaseId}` : "purchase-reconciliation";
    let lease = this.journal.acquireLease(leaseName, holder, ttlMs);
    if (!lease) return { acquired: false, leaseLost: false, results: [] };

    let leaseError: JournalFencingError | undefined;
    const heartbeat = setInterval(() => {
      if (leaseError) return;
      try {
        lease = this.journal.renewLease(lease as LeaseToken, ttlMs);
      } catch (error) {
        leaseError = asFencingError(error);
      }
    }, Math.max(10, Math.floor(ttlMs / 3)));
    heartbeat.unref();

    const results: ReconciliationEffectResult[] = [];
    try {
      for (const effect of this.journal.recoverableEffects(purchaseId)) {
        if (leaseError) break;
        lease = this.renewBeforeWrite(lease, ttlMs);
        this.journal.verifyEffectPreparedMaterial(effect.id);

        if (this.journal.effectClaimActive(effect.id)) {
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "executor_active"
          );
          results.push({ effectId: effect.id, status: "executor_active" });
          continue;
        }

        if (effect.state === "planned") {
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "ready_to_execute"
          );
          results.push({ effectId: effect.id, status: "ready_to_execute" });
          continue;
        }
        if (effect.state === "retryable") {
          const proof = lastDetailDigest(this.journal, effect.id);
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "retryable_after_observation",
            proof
          );
          results.push({ effectId: effect.id, status: "retryable", detailDigest: proof });
          continue;
        }
        if (effect.state === "failed_terminal") {
          const proof = lastDetailDigest(this.journal, effect.id) ?? effect.resultDigest;
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "terminal_payment_accounting_resolved",
            proof
          );
          results.push({ effectId: effect.id, status: "failed_terminal", detailDigest: proof });
          continue;
        }

        const observer = this.observers.get(effect.kind);
        if (!observer) {
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "observer_unavailable"
          );
          results.push({ effectId: effect.id, status: "unsupported" });
          continue;
        }

        let observation: ReconciliationObservation;
        try {
          observation = await observer.observe(effect);
        } catch (error) {
          if (leaseError) break;
          lease = this.renewBeforeWrite(lease, ttlMs);
          const digest = errorDigest(error);
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "observer_error",
            digest
          );
          results.push({ effectId: effect.id, status: "observer_error", detailDigest: digest });
          continue;
        }

        if (leaseError) break;
        lease = this.renewBeforeWrite(lease, ttlMs);
        if (observation.status === "spend_observed") {
          const spend = this.journal.recordObservedSpend(lease, {
            effectId: effect.id,
            ...observation.spend,
          });
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "spend_observed",
            spend.evidenceDigest
          );
          results.push({ effectId: effect.id, status: "observed", detailDigest: spend.evidenceDigest });
          continue;
        }
        if (observation.status === "treasury_staging_observed") {
          const staging = this.journal.recordObservedTreasuryStaging(lease, {
            effectId: effect.id,
            ...observation.staging,
          });
          this.journal.recordReconciliation(
            lease,
            effect.purchaseId,
            effect.id,
            "treasury_staging_observed",
            staging.evidenceDigest
          );
          results.push({
            effectId: effect.id,
            status: "observed",
            detailDigest: staging.evidenceDigest,
          });
          continue;
        }

        const updated = this.journal.recordEffectObservation(effect.id, lease, observation);
        const result = resultForObservation(effect.id, observation);
        this.journal.recordReconciliation(
          lease,
          effect.purchaseId,
          effect.id,
          `effect_${result.status}`,
          result.detailDigest ?? updated.resultDigest
        );
        results.push(result);
      }
      return { acquired: true, leaseLost: leaseError !== undefined, results };
    } catch (error) {
      if (error instanceof JournalFencingError) {
        return { acquired: true, leaseLost: true, results };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (!leaseError) this.journal.releaseLease(lease);
    }
  }

  private renewBeforeWrite(lease: LeaseToken, ttlMs: number): LeaseToken {
    return this.journal.renewLease(lease, ttlMs);
  }
}

function resultForObservation(effectId: string, observation: EffectObservation): ReconciliationEffectResult {
  switch (observation.status) {
    case "observed":
      return {
        effectId,
        status: "observed",
        detailDigest: observation.detailDigest ?? observation.resultDigest,
      };
    case "pending":
      return { effectId, status: "pending", detailDigest: observation.detailDigest };
    case "not_found":
      return {
        effectId,
        status: observation.safeToRetry ? "retryable" : "pending",
        detailDigest: observation.detailDigest,
      };
    case "conflict":
      return { effectId, status: "conflict", detailDigest: observation.detailDigest };
    case "application_failure":
      return { effectId, status: "pending", detailDigest: observation.detailDigest };
  }
}

function lastDetailDigest(journal: PurchaseJournal, effectId: string): Sha256Digest | undefined {
  const observations = journal.effectObservations(effectId);
  return observations.at(-1)?.detailDigest;
}

function errorDigest(error: unknown): Sha256Digest {
  const name = error instanceof Error ? error.name : typeof error;
  return evidenceDigest(`reconciliation-error:${name}`);
}

function asFencingError(error: unknown): JournalFencingError {
  return error instanceof JournalFencingError
    ? error
    : new JournalFencingError("reconciliation lease renewal failed");
}
