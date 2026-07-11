import { createHash } from "node:crypto";
import type { PolicyEngine } from "../policy.js";
import type { TreasuryOperationAdapter } from "./operation-adapters.js";
import {
  type TreasuryOperationJournal,
  type TreasuryOperationKind,
  type TreasuryOperationRecord,
} from "./operation-journal.js";

const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const ADDRESS = /^kaspatest:[a-z0-9]+$/;
const ATOMIC = /^[1-9][0-9]*$/;
const MAX_RECONCILED_RETRIES = 8;

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
}

export interface TreasuryOperationModuleOptions {
  readonly journal: TreasuryOperationJournal;
  readonly policy: Pick<PolicyEngine, "authorize" | "policy">;
  readonly adapters: readonly TreasuryOperationAdapter[];
  readonly feeCeilingAtomic: string;
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
    this.journal = options.journal;
    this.policy = options.policy;
    this.adapters = adapters;
    this.installCurrentPolicy();
  }

  async execute(request: Readonly<TreasuryOperationRequest>): Promise<TreasuryOperationView> {
    const normalized = normalizeRequest(request);
    const policy = this.installCurrentPolicy();
    const record = this.journal.claimTreasuryOperationIntent({
      ...normalized,
      requestDigest: requestDigest(normalized),
      requestedAmountAtomic: normalized.amountAtomic,
      keepFloatAtomic: normalized.keepFloatAtomic,
      feeCeilingAtomic: this.feeCeilingAtomic,
      policyDigest: policy.digest,
    });
    return this.drive(record.operationKey);
  }

  status(operationKey: string): TreasuryOperationView {
    return view(this.journal.requireTreasuryOperation(requireOperationKey(operationKey)));
  }

  async recover(operationKey: string): Promise<TreasuryOperationView> {
    this.installCurrentPolicy();
    return this.drive(requireOperationKey(operationKey));
  }

  spentLastHour(): bigint {
    return this.journal.treasuryOperationSpentLastHour();
  }

  effectiveCapacityUsed(): bigint {
    return this.journal.treasuryPolicyCapacityUsed();
  }

  integrityCheck(): true {
    return this.journal.integrityCheck();
  }

  unresolvedCount(): number {
    return this.journal.unresolvedTreasuryOperationCount();
  }

  private async drive(operationKey: string): Promise<TreasuryOperationView> {
    let record = this.journal.requireTreasuryOperation(operationKey);
    const adapter = this.requireAdapter(record.kind);

    if (record.state === "completed" || record.state === "failed_terminal") {
      return view(record);
    }

    if (record.state === "intent") {
      const prepared = await adapter.prepare(record, (destination, amount) => {
        this.authorize(operationKey, destination, amount);
      });
      if (!record.policyDigest) {
        throw new TreasuryOperationError("Treasury operation has no durable policy snapshot");
      }
      record = this.journal.recordPreparedTreasuryOperation(operationKey, {
        ...prepared,
        policyDigest: record.policyDigest,
      });
    }

    if (record.state === "observed") {
      await adapter.commit(
        record,
        this.journal.readPreparedTreasuryOperation(operationKey),
        this.journal.readObservedTreasuryOperationDetail(operationKey)
      );
      return view(this.journal.completeTreasuryOperation(operationKey));
    }

    if (record.state === "submission_planned" || record.state === "submitted") {
      record = await this.reconcile(record, adapter);
      if (record.state === "observed") {
        await adapter.commit(
          record,
          this.journal.readPreparedTreasuryOperation(operationKey),
          this.journal.readObservedTreasuryOperationDetail(operationKey)
        );
        return view(this.journal.completeTreasuryOperation(operationKey));
      }
      if (record.state !== "prepared") return view(record);
    }

    if (record.state !== "prepared") return view(record);
    if (record.retryCount > MAX_RECONCILED_RETRIES) {
      throw new TreasuryOperationError(
        "Treasury operation exceeded its bounded proof-backed submission retries"
      );
    }
    if (!record.resolvedAmountAtomic) {
      throw new TreasuryOperationError("Prepared Treasury operation has no resolved amount");
    }
    if (record.kind !== "vault_deposit") {
      this.authorize(operationKey, record.destination, BigInt(record.resolvedAmountAtomic));
    }
    if (!this.journal.planTreasuryOperationSubmission(operationKey)) {
      return this.drive(operationKey);
    }
    record = this.journal.requireTreasuryOperation(operationKey);
    const bytes = this.journal.readPreparedTreasuryOperation(operationKey);
    try {
      const submitted = await adapter.submit(record, bytes);
      record = this.journal.recordTreasuryOperationSubmissionAccepted(operationKey, submitted.transactionId);
    } catch {
      // Any transport/RPC exception is ambiguous. The exact signed bytes and
      // planned identity are durable; observation below decides whether a
      // later retry is safe.
      record = this.journal.requireTreasuryOperation(operationKey);
    }
    record = await this.reconcile(record, adapter);
    if (record.state === "observed") {
      await adapter.commit(
        record,
        bytes,
        this.journal.readObservedTreasuryOperationDetail(operationKey)
      );
      record = this.journal.completeTreasuryOperation(operationKey);
    }
    return view(record);
  }

  private async reconcile(
    record: TreasuryOperationRecord,
    adapter: TreasuryOperationAdapter
  ): Promise<TreasuryOperationRecord> {
    if (record.state !== "submission_planned" && record.state !== "submitted") return record;
    const probe = await adapter.observe(
      record,
      this.journal.readPreparedTreasuryOperation(record.operationKey)
    );
    return this.journal.recordTreasuryOperationObservation(
      record.operationKey,
      probe.status,
      probe.detail
    );
  }

  private authorize(operationKey: string, destination: string, amount: bigint): void {
    const operation = this.journal.requireTreasuryOperation(operationKey);
    const ownCapacity =
      (operation.kind === "vault_deposit"
        ? 0n
        : BigInt(operation.resolvedAmountAtomic ?? operation.requestedAmountAtomic)) +
      BigInt(operation.feeCeilingAtomic);
    const total = this.journal.treasuryPolicyCapacityUsed();
    if (ownCapacity > total) {
      throw new TreasuryOperationError("Treasury capacity accounting is inconsistent");
    }
    this.policy.authorize(destination, amount, total - ownCapacity);
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
    request.kind !== "vault_deposit"
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
  const recoveryRequired = record.state === "submission_planned" || record.state === "submitted";
  const safeToRetry = record.state === "prepared";
  const summary = record.state === "completed"
    ? `Treasury operation ${record.operationKey} completed with transaction ${record.transactionId}.`
    : recoveryRequired
      ? `Treasury operation ${record.operationKey} has an ambiguous or not-yet-observed submission; reconcile it before retrying.`
      : record.state === "prepared"
        ? `Treasury operation ${record.operationKey} is durably prepared and safe to submit once.`
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
    safeToRetry,
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
