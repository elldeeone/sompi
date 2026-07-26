import { createHash, randomBytes } from "node:crypto";

import { SompiOperationFailure } from "../operation-failure.js";
import { Address } from "../kaspa-wasm.js";
import { kasAmountView } from "../amount-display.js";
import type { ChainEvidenceFinalitySelector } from "../chain-evidence/types.js";
import {
  TreasuryOperationError,
  TreasuryOperationNotFoundError,
  type TreasuryOperationModule,
  type TreasuryOperationView,
} from "../treasury/operations.js";
import {
  JournalRequestConflictError,
  PolicyReservationError,
} from "../purchase/journal.js";
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
    "preflightHumanAuthorized" | "executeUnderPolicy" | "status" | "recover"
  >;
  readonly source: () => Readonly<{ vaultAddress: string; vaultDigest: string }>;
  readonly manifest: () => Readonly<{ revision: number; digest: string }>;
  readonly finality: ChainEvidenceFinalitySelector;
  readonly now?: () => number;
  readonly authorityTtlMs?: number;
}

/** Deep module for one human-authorized, vault-backed native KAS send. */
export class TransferModule {
  private readonly now: () => number;
  private readonly authorityTtlMs: number;

  constructor(private readonly options: TransferModuleOptions) {
    if (
      !options.journal ||
      !options.authority ||
      !options.treasury ||
      !options.source ||
      !options.manifest ||
      typeof options.finality?.selectFinality !== "function"
    ) {
      throw new Error("Transfer module dependencies are incomplete");
    }
    this.now = options.now ?? Date.now;
    this.authorityTtlMs = options.authorityTtlMs ?? DEFAULT_AUTHORITY_TTL_MS;
    if (!Number.isSafeInteger(this.authorityTtlMs) || this.authorityTtlMs < 1 || this.authorityTtlMs > 10 * 60_000) {
      throw new Error("Transfer Authority TTL is invalid");
    }
  }

  async transfer(input: Readonly<TransferIntent>, signal?: AbortSignal): Promise<TransferView> {
    signal?.throwIfAborted();
    const intent = canonicalIntent(input);
    const existing = this.options.journal.findTransferByRequestKey(intent.requestKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest(intent)) {
        throw new SompiOperationFailure("TRANSFER_CONFLICT");
      }
      return this.drive(existing.id, signal);
    }
    const source = canonicalSource(this.options.source());
    const manifest = canonicalManifest(this.options.manifest());
    const finality = this.options.finality.selectFinality("vault", "accepted");
    const id = createTransferId();
    let context: Readonly<{ policyDigest: string; feeCeilingAtomic: string }>;
    try {
      context = this.options.treasury.preflightHumanAuthorized({
        operationKey: `transfer:${id}`,
        kind: "vault_send",
        destination: intent.destination,
        amountAtomic: intent.amountAtomic,
      });
    } catch (cause) {
      if (
        cause instanceof TreasuryOperationError ||
        cause instanceof PolicyReservationError
      ) {
        throw new SompiOperationFailure("INVALID_TRANSFER", { cause });
      }
      throw cause;
    }
    const now = this.timestamp();
    const expiresAtMs = now + this.authorityTtlMs;
    const amount = BigInt(intent.amountAtomic);
    const fee = atomic(context.feeCeilingAtomic, "Transfer fee ceiling", true);
    if (amount + fee > MAX_UINT64) {
      throw new SompiOperationFailure("INVALID_TRANSFER");
    }
    let record: TransferRecord;
    try {
      record = this.options.journal.claimTransferIntent({
        id,
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
        finalityFloor: finality.effectiveFloor,
      });
    } catch (cause) {
      if (cause instanceof JournalRequestConflictError) {
        throw new SompiOperationFailure("TRANSFER_CONFLICT", { cause });
      }
      throw cause;
    }
    return this.drive(record.id, signal);
  }

  status(id: string): TransferView {
    return this.view(this.requireTransfer(id));
  }

  async recover(id: string, signal?: AbortSignal): Promise<TransferView> {
    signal?.throwIfAborted();
    const transfer = this.requireTransfer(id);
    if (transfer.state === "failed_terminal") return this.view(transfer);
    if (!transfer.treasuryOperationKey) return this.drive(id, signal);
    let operation: TreasuryOperationView;
    try {
      operation = await this.options.treasury.recover(transfer.treasuryOperationKey, signal);
    } catch (error) {
      let latest: TreasuryOperationView;
      try {
        latest = this.options.treasury.status(transfer.treasuryOperationKey);
      } catch (statusError) {
        if (
          statusError instanceof TreasuryOperationNotFoundError &&
          this.requireTransfer(id).state === "funds_reserved"
        ) {
          return this.drive(id, signal);
        }
        throw statusError;
      }
      this.options.journal.syncTransferTreasuryOperation(id, latest);
      if (latest.state === "completed") return this.finishReceipt(id);
      if (latest.state === "failed_terminal") {
        return this.view(this.requireTransfer(id));
      }
      this.markRecoverable(id, "treasury_recovery_required");
      throw new SompiOperationFailure("TRANSFER_FAILED", { cause: error });
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
        throw new SompiOperationFailure("TRANSFER_EXPIRED");
      }
      const facts = transferFacts(transfer);
      const decision = await this.options.authority.request(facts, signal);
      this.options.journal.recordTransferAuthorization(id, facts, decision);
      transfer = this.requireTransfer(id);
    }
    if (transfer.state === "denied") {
      throw new SompiOperationFailure("TRANSFER_DENIED");
    }
    if (transfer.state === "authorised") {
      const operationKey = `transfer:${transfer.id}`;
      transfer = this.options.journal.bindTransferTreasuryOperation(id, operationKey);
    }
    if (transfer.state === "receipted" || transfer.state === "failed_terminal") {
      return this.view(transfer);
    }
    if (!transfer.treasuryOperationKey) {
      throw new Error("Transfer has no durable Treasury operation");
    }
    const authorization = this.options.journal.findTransferAuthorization(id);
    if (!authorization || authorization.decision !== "approved") {
      throw new Error("Transfer has no durable approved Authority evidence");
    }
    try {
      const operation = await this.options.treasury.executeUnderPolicy({
        operationKey: transfer.treasuryOperationKey,
        kind: "vault_send",
        destination: transfer.destination,
        amountAtomic: transfer.amountAtomic,
      }, {
        expectedPolicyDigest: transfer.policyDigest,
        authorizationEvidenceDigest: authorization.evidenceDigest,
      }, signal);
      this.options.journal.syncTransferTreasuryOperation(id, operation);
    } catch (error) {
      let latest: TreasuryOperationView;
      try {
        latest = this.options.treasury.status(transfer.treasuryOperationKey);
      } catch (statusError) {
        if (!(statusError instanceof TreasuryOperationNotFoundError)) {
          throw statusError;
        }
        const current = this.requireTransfer(id);
        if (current.state !== "funds_reserved") {
          throw new Error("Transfer Treasury operation disappeared after execution began", {
            cause: statusError,
          });
        }
        return this.view(this.options.journal.transitionTransfer(
          id,
          "failed_terminal",
          "treasury_intent_rejected",
        ));
      }
      this.options.journal.syncTransferTreasuryOperation(id, latest);
      if (latest.state === "completed") return this.finishReceipt(id);
      if (latest.state === "failed_terminal") {
        return this.view(this.requireTransfer(id));
      }
      this.markRecoverable(id, "treasury_recovery_required");
      throw new SompiOperationFailure("TRANSFER_FAILED", { cause: error });
    }
    return this.finishReceipt(id);
  }

  private finishReceipt(id: string): TransferView {
    const transfer = this.requireTransfer(id);
    if (transfer.state === "settled") {
      if (!transfer.transactionId || transfer.actualFeeAtomic === undefined) {
        throw new Error("Settled Transfer is missing transaction evidence");
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
        fundingSummary: "Sent securely from your protected Sompi wallet.",
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
    if (!/^trf_[A-Za-z0-9_-]{22}$/.test(id)) {
      throw new SompiOperationFailure("INVALID_TRANSFER");
    }
    const transfer = this.options.journal.findTransfer(id);
    if (!transfer) throw new SompiOperationFailure("TRANSFER_NOT_FOUND");
    return transfer;
  }

  private view(record: TransferRecord): TransferView {
    const authorization = this.options.journal.findTransferAuthorization(record.id);
    const receipt = this.options.journal.findTransferReceipt(record.id);
    return Object.freeze({
      ...record,
      summary: transferSummary(record),
      display: Object.freeze({
        amount: kasAmountView(record.amountAtomic),
        feeCeiling: kasAmountView(record.feeCeilingAtomic),
        maximumTotal: kasAmountView(record.maximumTotalAtomic),
        ...(record.actualFeeAtomic === undefined ? {} : { actualFee: kasAmountView(record.actualFeeAtomic) }),
      }),
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
      throw new Error("Transfer clock is unavailable");
    }
    return value;
  }
}

function transferSummary(record: TransferRecord): string {
  const amount = kasAmountView(record.amountAtomic).display;
  switch (record.state) {
    case "created": return `Preparing to send ${amount} to ${record.destination}.`;
    case "awaiting_authority": return `Waiting for approval to send ${amount} to ${record.destination}.`;
    case "authorised": return `Transfer approved for ${amount}. Preparing the send.`;
    case "denied": return `Transfer of ${amount} was denied. No funds were sent.`;
    case "funds_reserved": return `Transfer approved for ${amount}. Preparing the send.`;
    case "prepared": return `Transfer prepared for ${amount}. Sending now.`;
    case "submitted": return `Transfer sent for ${amount}. Waiting for confirmation.`;
    case "settled": return `Transfer confirmed for ${amount}. Finishing the receipt.`;
    case "receipted": return `${amount} sent successfully to ${record.destination}.`;
    case "failed_recoverable": return `Sompi is checking the original ${amount} transfer. Do not send again.`;
    case "failed_terminal": return `Transfer of ${amount} stopped safely. Operator review is required.`;
  }
}

function canonicalIntent(input: Readonly<TransferIntent>): TransferIntent {
  if (!input || typeof input.requestKey !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.requestKey)) {
    throw new SompiOperationFailure("INVALID_TRANSFER");
  }
  const destination = canonicalAddress(input.destination);
  let amountAtomic: string;
  try {
    amountAtomic = atomic(input.amountAtomic, "Transfer amount", false).toString();
  } catch (cause) {
    throw new SompiOperationFailure("INVALID_TRANSFER", { cause });
  }
  return Object.freeze({ requestKey: input.requestKey, destination, amountAtomic });
}

function canonicalAddress(value: string): string {
  if (typeof value !== "string" || !Address.validate(value)) {
    throw new SompiOperationFailure("INVALID_TRANSFER");
  }
  const address = new Address(value);
  try {
    if (address.prefix !== "kaspatest" || address.toString() !== value) {
      throw new SompiOperationFailure("INVALID_TRANSFER");
    }
    return value;
  } finally {
    address.free();
  }
}

function canonicalSource(value: Readonly<{ vaultAddress: string; vaultDigest: string }>) {
  if (!value || !/^kaspatest:[a-z0-9]+$/.test(value.vaultAddress) || !isDigest(value.vaultDigest)) {
    throw new Error("Transfer source vault is invalid");
  }
  return value;
}

function canonicalManifest(value: Readonly<{ revision: number; digest: string }>) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || !isDigest(value.digest)) {
    throw new Error("Transfer Operator Manifest identity is invalid");
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
    issuedAt: new Date(transfer.createdAtMs).toISOString(),
    expiresAt: new Date(transfer.expiresAtMs).toISOString(),
    policyDigest: transfer.policyDigest,
    operatorManifestRevision: transfer.manifestRevision,
    operatorManifestDigest: transfer.manifestDigest,
    finalityFloor: transfer.finalityFloor,
  });
}

function atomic(value: string, label: string, zeroAllowed: boolean): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64 || (!zeroAllowed && parsed === 0n)) {
    throw new Error(`${label} is outside uint64 bounds`);
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
