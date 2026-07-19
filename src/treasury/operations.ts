import { createHash, randomBytes } from "node:crypto";
import type { PolicyEngine } from "../policy.js";
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

const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const ADDRESS = /^kaspatest:[a-z0-9]+$/;
const ATOMIC = /^[1-9][0-9]*$/;
const MAX_RECONCILED_RETRIES = 8;
const DRIVER_LEASE_TTL_MS = 60_000;
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
}

export interface TreasuryOperationModuleOptions {
  readonly journal: TreasuryOperationJournal;
  readonly policy: Pick<PolicyEngine, "authorize" | "policy">;
  readonly adapters: readonly TreasuryOperationAdapter[];
  readonly feeCeilingAtomic: string;
  /** Manifest projection in production; default is only for hermetic fixtures. */
  readonly directTreasuryRetries?: number;
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

/**
 * Deep module for non-Purchase Treasury Movements.
 *
 * Its small interface owns idempotency, durable preparation, policy capacity,
 * submission ordering, ambiguity, reconciliation, and local commit. MCP does
 * not call wallet/vault mutation methods directly.
 */
export class TreasuryOperationModule {
  private readonly journal: TreasuryOperationJournal;
  private readonly policy: Pick<PolicyEngine, "authorize" | "policy">;
  private readonly adapters: ReadonlyMap<TreasuryOperationKind, TreasuryOperationAdapter>;
  private readonly feeCeilingAtomic: string;
  private readonly directTreasuryRetries: number;
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
    this.installCurrentPolicy();
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

  authorizationContext(): Readonly<{ policyDigest: string; feeCeilingAtomic: string }> {
    return Object.freeze({
      policyDigest: this.installCurrentPolicy().digest,
      feeCeilingAtomic: this.feeCeilingAtomic,
    });
  }

  status(operationKey: string): TreasuryOperationView {
    return view(this.journal.requireTreasuryOperation(requireOperationKey(operationKey)));
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
    const ownCapacity =
      (operation.kind === "vault_deposit" || operation.kind === "batch_refund"
        ? 0n
        : BigInt(operation.resolvedAmountAtomic ?? operation.requestedAmountAtomic)) +
      BigInt(operation.feeCeilingAtomic);
    const total = this.journal.treasuryPolicyCapacityUsed();
    if (ownCapacity > total) {
      throw new TreasuryOperationError("Treasury capacity accounting is inconsistent");
    }
    this.policy.authorize(destination, amount, total - ownCapacity, {
      humanApproved: operation.authorizationEvidenceDigest !== undefined,
    });
  }

  private installCurrentPolicy(): { readonly digest: string } {
    const policy = this.policy.policy;
    return this.journal.installPolicy({
      maxPerPaymentAtomic: policy.maxSompiPerTx.toString(),
      maxPerHourAtomic: policy.maxSompiPerHour.toString(),
      approvalAboveAtomic: policy.requireApprovalAboveSompi.toString(),
      allowlist: Object.freeze([...policy.allowlist]),
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

function requireRetryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 128) {
    throw new TreasuryOperationError("direct Treasury retry budget is invalid");
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
