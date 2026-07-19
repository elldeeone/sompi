import { createHash, randomBytes } from "node:crypto";

import { Address } from "../kaspa-wasm.js";
import type { TreasuryOperationModule, TreasuryOperationView } from "../treasury/operations.js";
import type { TransferJournal } from "./journal.js";
import type {
  TransferAuthorizationFacts,
  TransferAuthorityModule,
  TransferIntent,
  TransferReceipt,
  TransferRecord,
  TransferView,
} from "./types.js";

const NETWORK = "kaspa:testnet-10" as const;
const MAX_UINT64 = (1n << 64n) - 1n;
const DEFAULT_AUTHORITY_TTL_MS = 120_000;

export interface TransferModuleOptions {
  readonly journal: TransferJournal;
  readonly authority: TransferAuthorityModule;
  readonly treasury: Pick<
    TreasuryOperationModule,
    "authorizationContext" | "executeUnderPolicy" | "status" | "recover"
  >;
  readonly source: () => Readonly<{ vaultAddress: string; vaultDigest: string }>;
  readonly manifest: () => Readonly<{ revision: number; digest: string }>;
  readonly finalityFloor: "accepted" | "depth-confirmed";
  readonly now?: () => number;
  readonly authorityTtlMs?: number;
}

export class TransferModuleError extends Error {
  constructor(
    readonly code:
      | "INVALID_TRANSFER"
      | "TRANSFER_CONFLICT"
      | "TRANSFER_DENIED"
      | "TRANSFER_EXPIRED"
      | "TRANSFER_FAILED"
      | "TRANSFER_NOT_FOUND",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TransferModuleError";
  }
}

/** Deep module for one human-authorized, vault-backed native KAS send. */
export class TransferModule {
  private readonly now: () => number;
  private readonly authorityTtlMs: number;

  constructor(private readonly options: TransferModuleOptions) {
    if (!options.journal || !options.authority || !options.treasury || !options.source || !options.manifest) {
      throw new TransferModuleError("INVALID_TRANSFER", "Transfer module dependencies are incomplete");
    }
    if (options.finalityFloor !== "accepted" && options.finalityFloor !== "depth-confirmed") {
      throw new TransferModuleError("INVALID_TRANSFER", "Transfer finality floor is invalid");
    }
    this.now = options.now ?? Date.now;
    this.authorityTtlMs = options.authorityTtlMs ?? DEFAULT_AUTHORITY_TTL_MS;
    if (!Number.isSafeInteger(this.authorityTtlMs) || this.authorityTtlMs < 1 || this.authorityTtlMs > 10 * 60_000) {
      throw new TransferModuleError("INVALID_TRANSFER", "Transfer Authority TTL is invalid");
    }
  }

  async transfer(input: Readonly<TransferIntent>, signal?: AbortSignal): Promise<TransferView> {
    signal?.throwIfAborted();
    const intent = canonicalIntent(input);
    const existing = this.options.journal.findTransferByRequestKey(intent.requestKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest(intent)) {
        throw new TransferModuleError("TRANSFER_CONFLICT", "Transfer request key is already bound to different intent");
      }
      return this.drive(existing.id, signal);
    }
    const context = this.options.treasury.authorizationContext();
    const source = canonicalSource(this.options.source());
    const manifest = canonicalManifest(this.options.manifest());
    const now = this.timestamp();
    const expiresAtMs = now + this.authorityTtlMs;
    const amount = BigInt(intent.amountAtomic);
    const fee = atomic(context.feeCeilingAtomic, "Transfer fee ceiling", true);
    if (amount + fee > MAX_UINT64) {
      throw new TransferModuleError("INVALID_TRANSFER", "Transfer maximum total exceeds uint64");
    }
    const record = this.options.journal.claimTransferIntent({
      id: createTransferId(),
      requestKey: intent.requestKey,
      requestDigest: requestDigest(intent),
      destination: intent.destination,
      amountAtomic: intent.amountAtomic,
      sourceVaultAddress: source.vaultAddress,
      sourceVaultDigest: source.vaultDigest,
      feeCeilingAtomic: context.feeCeilingAtomic,
      maximumTotalAtomic: (amount + fee).toString(),
      expiresAtMs,
      policyDigest: context.policyDigest,
      manifestRevision: manifest.revision,
      manifestDigest: manifest.digest,
      finalityFloor: this.options.finalityFloor,
    });
    return this.drive(record.id, signal);
  }

  status(id: string): TransferView {
    return this.view(this.requireTransfer(id));
  }

  async recover(id: string, signal?: AbortSignal): Promise<TransferView> {
    signal?.throwIfAborted();
    const transfer = this.requireTransfer(id);
    if (!transfer.treasuryOperationKey) return this.drive(id, signal);
    let operation: TreasuryOperationView;
    try {
      operation = await this.options.treasury.recover(transfer.treasuryOperationKey, signal);
    } catch (error) {
      this.markRecoverable(id, "treasury_recovery_required");
      throw new TransferModuleError("TRANSFER_FAILED", "Transfer recovery remains unresolved", { cause: error });
    }
    this.options.journal.syncTransferTreasuryOperation(id, operation);
    return this.finishReceipt(id);
  }

  private async drive(id: string, signal?: AbortSignal): Promise<TransferView> {
    let transfer = this.requireTransfer(id);
    if (transfer.state === "created") {
      transfer = this.options.journal.transitionTransfer(id, "awaiting_authority", "authority_requested");
    }
    if (transfer.state === "awaiting_authority") {
      if (this.timestamp() >= transfer.expiresAtMs) {
        this.options.journal.transitionTransfer(id, "failed_terminal", "authority_request_expired");
        throw new TransferModuleError("TRANSFER_EXPIRED", "Transfer approval expired");
      }
      const facts = transferFacts(transfer);
      const decision = await this.options.authority.request(facts, signal);
      this.options.journal.recordTransferAuthorization(id, facts, decision);
      transfer = this.requireTransfer(id);
    }
    if (transfer.state === "denied") {
      throw new TransferModuleError("TRANSFER_DENIED", "Transfer was denied");
    }
    if (transfer.state === "authorised") {
      const operationKey = `transfer:${transfer.id}`;
      transfer = this.options.journal.bindTransferTreasuryOperation(id, operationKey);
    }
    if (transfer.state === "receipted" || transfer.state === "failed_terminal") {
      return this.view(transfer);
    }
    if (!transfer.treasuryOperationKey) {
      throw new TransferModuleError("TRANSFER_FAILED", "Transfer has no durable Treasury operation");
    }
    try {
      const operation = await this.options.treasury.executeUnderPolicy({
        operationKey: transfer.treasuryOperationKey,
        kind: "vault_send",
        destination: transfer.destination,
        amountAtomic: transfer.amountAtomic,
      }, transfer.policyDigest, signal);
      this.options.journal.syncTransferTreasuryOperation(id, operation);
    } catch (error) {
      const latest = this.options.treasury.status(transfer.treasuryOperationKey);
      this.options.journal.syncTransferTreasuryOperation(id, latest);
      if (latest.state !== "failed_terminal") this.markRecoverable(id, "treasury_recovery_required");
      throw new TransferModuleError("TRANSFER_FAILED", "Transfer requires recovery", { cause: error });
    }
    return this.finishReceipt(id);
  }

  private finishReceipt(id: string): TransferView {
    const transfer = this.requireTransfer(id);
    if (transfer.state === "settled") {
      if (!transfer.transactionId || transfer.actualFeeAtomic === undefined) {
        throw new TransferModuleError("TRANSFER_FAILED", "Settled Transfer is missing transaction evidence");
      }
      const receipt: TransferReceipt = Object.freeze({
        profile: "urn:sompi:receipt:transfer:1",
        transferId: transfer.id,
        requestKey: transfer.requestKey,
        destination: transfer.destination,
        amountAtomic: transfer.amountAtomic,
        feeAtomic: transfer.actualFeeAtomic,
        network: NETWORK,
        fundingSource: "vault-treasury",
        transactionId: transfer.transactionId,
        finality: transfer.finalityFloor,
        settledAt: new Date(this.timestamp()).toISOString(),
      });
      this.options.journal.recordTransferReceipt(id, receipt);
    }
    return this.view(this.requireTransfer(id));
  }

  private markRecoverable(id: string, reason: string): void {
    const current = this.requireTransfer(id);
    if (["funds_reserved", "prepared", "submitted", "settled"].includes(current.state)) {
      this.options.journal.transitionTransfer(id, "failed_recoverable", reason);
    }
  }

  private requireTransfer(id: string): TransferRecord {
    try { return this.options.journal.requireTransfer(id); }
    catch (error) { throw new TransferModuleError("TRANSFER_NOT_FOUND", "Transfer does not exist", { cause: error }); }
  }

  private view(record: TransferRecord): TransferView {
    const authorization = this.options.journal.findTransferAuthorization(record.id);
    const receipt = this.options.journal.findTransferReceipt(record.id);
    return Object.freeze({
      ...record,
      ...(authorization ? { authorization } : {}),
      ...(receipt ? { receipt } : {}),
      recoveryRequired: record.state === "failed_recoverable",
      safeToRetry: record.state === "created" || record.state === "awaiting_authority",
      userAction: record.state === "awaiting_authority"
        ? "approve_or_deny"
        : record.state === "failed_recoverable"
          ? "recover"
          : ["funds_reserved", "prepared", "submitted", "settled"].includes(record.state)
            ? "wait"
            : "none",
    });
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TransferModuleError("TRANSFER_FAILED", "Transfer clock is unavailable");
    }
    return value;
  }
}

function canonicalIntent(input: Readonly<TransferIntent>): TransferIntent {
  if (!input || typeof input.requestKey !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.requestKey)) {
    throw new TransferModuleError("INVALID_TRANSFER", "Transfer request key is invalid");
  }
  const destination = canonicalAddress(input.destination);
  const amountAtomic = atomic(input.amountAtomic, "Transfer amount", false).toString();
  return Object.freeze({ requestKey: input.requestKey, destination, amountAtomic });
}

function canonicalAddress(value: string): string {
  if (typeof value !== "string" || !Address.validate(value)) {
    throw new TransferModuleError("INVALID_TRANSFER", "Transfer destination is invalid");
  }
  const address = new Address(value);
  try {
    if (address.prefix !== "kaspatest" || address.toString() !== value) {
      throw new TransferModuleError("INVALID_TRANSFER", "Transfer destination must be canonical Testnet-10");
    }
    return value;
  } finally {
    address.free();
  }
}

function canonicalSource(value: Readonly<{ vaultAddress: string; vaultDigest: string }>) {
  if (!value || !/^kaspatest:[a-z0-9]+$/.test(value.vaultAddress) || !isDigest(value.vaultDigest)) {
    throw new TransferModuleError("INVALID_TRANSFER", "Transfer source vault is invalid");
  }
  return value;
}

function canonicalManifest(value: Readonly<{ revision: number; digest: string }>) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || !isDigest(value.digest)) {
    throw new TransferModuleError("INVALID_TRANSFER", "Transfer Operator Manifest identity is invalid");
  }
  return value;
}

function requestDigest(intent: TransferIntent): string {
  return digestJson({
    profile: "sompi.transfer.intent.1",
    requestKey: intent.requestKey,
    destination: intent.destination,
    amountAtomic: intent.amountAtomic,
    asset: "KAS",
    network: NETWORK,
  });
}

function transferFacts(transfer: TransferRecord): TransferAuthorizationFacts {
  return Object.freeze({
    profile: "sompi.transfer.1",
    transferId: transfer.id,
    requestKey: transfer.requestKey,
    sourceVaultAddress: transfer.sourceVaultAddress,
    sourceVaultDigest: transfer.sourceVaultDigest,
    destination: transfer.destination,
    amountAtomic: transfer.amountAtomic,
    asset: "KAS",
    network: NETWORK,
    feeCeilingAtomic: transfer.feeCeilingAtomic,
    maximumTotalAtomic: transfer.maximumTotalAtomic,
    expiresAt: new Date(transfer.expiresAtMs).toISOString(),
    policyDigest: transfer.policyDigest,
    operatorManifestRevision: transfer.manifestRevision,
    operatorManifestDigest: transfer.manifestDigest,
    finalityFloor: transfer.finalityFloor,
  });
}

function atomic(value: string, label: string, zeroAllowed: boolean): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TransferModuleError("INVALID_TRANSFER", `${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64 || (!zeroAllowed && parsed === 0n)) {
    throw new TransferModuleError("INVALID_TRANSFER", `${label} is outside uint64 bounds`);
  }
  return parsed;
}

function digestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function isDigest(value: string): boolean {
  return typeof value === "string" && /^sha256:[A-Za-z0-9_-]{43}$/.test(value);
}

function createTransferId(): string {
  return `trf_${randomBytes(16).toString("base64url")}`;
}
