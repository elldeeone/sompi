import { createHash } from "node:crypto";

import type { ChainEvidenceModule } from "../chain-evidence/module.js";
import type { ChainEvidenceRecord, FinalityFloor } from "../chain-evidence/types.js";
import { Transaction } from "../kaspa-wasm.js";
import {
  recoverVaultWithOwner,
  submitPreparedOwnerRecovery,
  vaultStaticConfigurationDigest,
  type ObservedVaultDeposit,
  type PreparedVaultDeposit,
  type VaultManager,
} from "../vault.js";
import type { KaspaWallet } from "../wallet.js";
import type { Sha256Digest } from "../purchase/types.js";
import type { VaultMigrationExecutionResult, VaultMigrationExecutor, VaultMigrationFacts } from "./types.js";

/** Operator-only executor. The owner key is caller-owned and never crosses the Agent API or MCP seam. */
export class OfflineOwnerVaultMigrationExecutor implements VaultMigrationExecutor {
  constructor(private readonly options: Readonly<{
    vault: VaultManager;
    wallet: KaspaWallet;
    chainEvidence: ChainEvidenceModule;
    ownerPrivateKey: string;
    finalityFloor: FinalityFloor;
    feeCeilingAtomic: string;
    now?: () => number;
  }>) {
    if (!options.vault || !options.wallet || !options.chainEvidence || !/^[a-fA-F0-9]{64}$/.test(options.ownerPrivateKey) || !/^(?:0|[1-9][0-9]*)$/.test(options.feeCeilingAtomic)) {
      throw new Error("offline owner Vault Migration executor is invalid");
    }
  }

  async execute(facts: VaultMigrationFacts, signal?: AbortSignal): Promise<VaultMigrationExecutionResult> {
    signal?.throwIfAborted();
    const current = this.options.vault.config();
    if (vaultStaticConfigurationDigest(current) !== facts.oldVaultDigest) throw new Error("active vault no longer matches the approved migration");
    const recovery = await recoverVaultWithOwner({
      wallet: this.options.wallet, config: current, privateKey: this.options.ownerPrivateKey,
      destination: facts.stableReceiveAddress, broadcast: false,
    });
    if (!recovery.preparedTransaction) throw new Error("owner recovery did not produce durable prepared bytes");
    const recoveryPrepared = {
      transactionId: recovery.txid, transaction: recovery.preparedTransaction,
      amountAtomic: recovery.amountSompi.toString(), feeAtomic: recovery.feeSompi.toString(),
    };
    this.write(facts, "recovery_prepared", { recovery: recoveryPrepared });
    await submitPreparedOwnerRecovery(this.options.wallet, recoveryPrepared.transaction, recoveryPrepared.transactionId);
    this.write(facts, "recovery_submitted", { recovery: recoveryPrepared });
    const recoveryEvidence = await this.observeTransaction(
      facts,
      "recovery",
      recoveryPrepared.transactionId,
      recoveryPrepared.transaction,
      facts.stableReceiveAddress,
      recoveryPrepared.amountAtomic,
      undefined,
      signal,
    );
    requireAccepted(recoveryEvidence, this.options.finalityFloor);

    this.options.vault.activateReplacement(facts.vaultMigrationId, facts.oldVaultDigest, BigInt(facts.newMaximumOutflowAtomic));
    const prepared = await this.options.vault.prepareMigrationDeposit(
      facts.vaultMigrationId, facts.oldVaultDigest, this.options.wallet, "max", 0n, BigInt(this.options.feeCeilingAtomic),
    );
    const storedDeposit = encodeDeposit(prepared);
    this.write(facts, "replacement_prepared", { recovery: recoveryPrepared, replacement: storedDeposit });
    await this.options.vault.submitPreparedDeposit(this.options.wallet, prepared);
    this.write(facts, "replacement_submitted", { recovery: recoveryPrepared, replacement: storedDeposit });
    const replacementEvidence = await this.observeTransaction(
      facts, "replacement", prepared.transactionId, prepared.transaction, prepared.vaultAddress,
      prepared.vaultAmountSompi.toString(), prepared.covenantId, signal,
    );
    this.options.vault.commitObservedDeposit(prepared, observedDeposit(prepared, replacementEvidence));
    return this.finish(facts, recoveryPrepared.transactionId, prepared.transactionId);
  }

  async reconcile(facts: VaultMigrationFacts, signal?: AbortSignal): Promise<VaultMigrationExecutionResult> {
    signal?.throwIfAborted();
    const stored = this.options.vault.migrationExecution(facts.vaultMigrationId, facts.oldVaultDigest);
    if (!stored) throw new Error("Vault Migration has no durable execution material");
    const stage = String(stored.stage ?? "");
    const recovery = executionPart(stored.recovery, "recovery");
    let recoveryEvidence = await this.observeTransaction(
      facts, "recovery", recovery.transactionId, recovery.transaction,
      facts.stableReceiveAddress, recovery.amountAtomic, undefined, signal, false,
    );
    if (recoveryEvidence.status === "absent" && stage === "recovery_prepared") {
      await submitPreparedOwnerRecovery(this.options.wallet, recovery.transaction, recovery.transactionId);
      recoveryEvidence = await this.observeTransaction(facts, "recovery", recovery.transactionId, recovery.transaction, facts.stableReceiveAddress, recovery.amountAtomic, undefined, signal);
    }
    requireAccepted(recoveryEvidence, this.options.finalityFloor);

    let replacement = stored.replacement ? decodeDeposit(stored.replacement) : undefined;
    if (!replacement) {
      const config = this.options.vault.config();
      if (vaultStaticConfigurationDigest(config) === facts.oldVaultDigest) {
        this.options.vault.activateReplacement(facts.vaultMigrationId, facts.oldVaultDigest, BigInt(facts.newMaximumOutflowAtomic));
      }
      replacement = await this.options.vault.prepareMigrationDeposit(
        facts.vaultMigrationId, facts.oldVaultDigest, this.options.wallet, "max", 0n, BigInt(this.options.feeCeilingAtomic),
      );
      this.write(facts, "replacement_prepared", { recovery, replacement: encodeDeposit(replacement) });
    }
    let replacementEvidence = await this.observeTransaction(
      facts, "replacement", replacement.transactionId, replacement.transaction,
      replacement.vaultAddress, replacement.vaultAmountSompi.toString(), replacement.covenantId, signal, false,
    );
    if (replacementEvidence.status === "absent") {
      await this.options.vault.submitPreparedDeposit(this.options.wallet, replacement);
      replacementEvidence = await this.observeTransaction(
        facts, "replacement", replacement.transactionId, replacement.transaction,
        replacement.vaultAddress, replacement.vaultAmountSompi.toString(), replacement.covenantId, signal,
      );
    }
    requireAccepted(replacementEvidence, this.options.finalityFloor);
    this.options.vault.commitObservedDeposit(replacement, observedDeposit(replacement, replacementEvidence));
    return this.finish(facts, recovery.transactionId, replacement.transactionId);
  }

  private async observeTransaction(
    facts: VaultMigrationFacts, stage: "recovery" | "replacement", transactionId: string,
    transactionJson: string, address: string, amountAtomic: string, covenantId: string | undefined,
    signal?: AbortSignal, wait = true,
  ): Promise<ChainEvidenceRecord> {
    const outputs = transactionOutputs(transactionJson);
    const request = () => this.options.chainEvidence.observe({
      operationId: `vault-migration:${facts.vaultMigrationId}:${stage}`,
      operation: "vault", network: "kaspa:testnet-10", transactionId,
      expectedOutputs: [{ index: 0, amountAtomic, scriptPublicKey: outputs[0], address, ...(covenantId ? { covenantId } : {}) }],
      watchedAddresses: [address], mechanism: stage === "recovery" ? "ordinary" : "native-covenant",
      protocolFinality: "accepted", operatorFloor: this.options.finalityFloor,
      signal: signal ?? new AbortController().signal,
    });
    let evidence = await request();
    if (!wait) return evidence;
    const deadline = (this.options.now ?? Date.now)() + 120_000;
    while (!accepted(evidence, this.options.finalityFloor)) {
      signal?.throwIfAborted();
      if ((this.options.now ?? Date.now)() >= deadline || evidence.status === "absent") return evidence;
      await delay(1_000, signal);
      evidence = await request();
    }
    return evidence;
  }

  private finish(facts: VaultMigrationFacts, recoveryTransactionId: string, replacementTransactionId: string): VaultMigrationExecutionResult {
    const result = Object.freeze({
      recoveryTransactionId, replacementTransactionId,
      stableReceiveAddress: facts.stableReceiveAddress,
      newMaximumOutflowAtomic: facts.newMaximumOutflowAtomic,
      windowStartDaa: facts.windowStartDaa, spentInWindowAtomic: facts.spentInWindowAtomic,
      receiptDigest: digest({ profile: "sompi.vault-migration-receipt.1", facts, recoveryTransactionId, replacementTransactionId }),
    });
    this.write(facts, "applied", { result });
    return result;
  }

  private write(facts: VaultMigrationFacts, stage: string, data: Readonly<Record<string, unknown>>): void {
    this.options.vault.recordMigrationExecution(facts.vaultMigrationId, facts.oldVaultDigest, { stage, ...data });
  }
}

function transactionOutputs(transactionJson: string): readonly string[] {
  const tx = Transaction.deserializeFromSafeJSON(transactionJson);
  try { return Object.freeze([...tx.outputs].map((output: any) => `${Number(output.scriptPublicKey.version).toString(16).padStart(4, "0")}${output.scriptPublicKey.script}`)); }
  finally { tx.free(); }
}

function encodeDeposit(value: PreparedVaultDeposit): Record<string, unknown> {
  return {
    ...value, depositedSompi: value.depositedSompi.toString(), feeSompi: value.feeSompi.toString(),
    vaultAmountSompi: value.vaultAmountSompi.toString(),
    sourceInputs: value.sourceInputs.map((input) => ({ ...input, amountSompi: input.amountSompi.toString() })),
  };
}

function decodeDeposit(value: unknown): PreparedVaultDeposit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("replacement execution material is invalid");
  const input = value as any;
  return Object.freeze({
    ...input, depositedSompi: BigInt(input.depositedSompi), feeSompi: BigInt(input.feeSompi),
    vaultAmountSompi: BigInt(input.vaultAmountSompi),
    sourceInputs: Object.freeze(input.sourceInputs.map((entry: any) => Object.freeze({ ...entry, amountSompi: BigInt(entry.amountSompi) }))),
  }) as PreparedVaultDeposit;
}

function executionPart(value: unknown, label: string): { transactionId: string; transaction: string; amountAtomic: string } {
  const input = value as any;
  if (!input || !/^[a-f0-9]{64}$/.test(input.transactionId) || typeof input.transaction !== "string" || !/^[1-9][0-9]*$/.test(input.amountAtomic)) {
    throw new Error(`durable ${label} execution material is invalid`);
  }
  return input;
}

function observedDeposit(prepared: PreparedVaultDeposit, evidence: ChainEvidenceRecord): ObservedVaultDeposit {
  requireAccepted(evidence, evidence.operatorFloor);
  return Object.freeze({
    transactionId: prepared.transactionId, vaultOutpoint: prepared.vaultOutpoint,
    vaultAmountSompi: prepared.vaultAmountSompi, covenantId: prepared.covenantId,
    observedAtDaa: BigInt(evidence.acceptingBlockDaaScore!), chainEvidenceDigest: evidence.detailDigest,
    chainEvidenceLevel: evidence.level!,
  }) as ObservedVaultDeposit;
}

function accepted(evidence: ChainEvidenceRecord, floor: FinalityFloor): boolean {
  return evidence.status === "present" && (evidence.level === "depth-confirmed" || (floor === "accepted" && evidence.level === "accepted"));
}
function requireAccepted(evidence: ChainEvidenceRecord, floor: FinalityFloor): void {
  if (!accepted(evidence, floor)) throw new Error("Vault Migration transaction is not independently accepted");
}
function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}` as Sha256Digest;
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
