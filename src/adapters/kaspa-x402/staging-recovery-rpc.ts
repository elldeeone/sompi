import { createHash } from "node:crypto";

import {
  Transaction,
  type RpcClient,
} from "../../kaspa-wasm.js";
import type { Sha256Digest } from "../../purchase/types.js";
import { serializeScriptPublicKey } from "./address-codec.js";
import {
  ABANDONED_STAGING_RECOVERY_ENCODING,
  type StagingRecoveryCandidateObservation,
  type StagingRecoveryExpectedCandidate,
  type StagingRecoveryOutpointObservation,
  type StagingRecoveryRaceEvidence,
  type StagingRecoveryRaceRequest,
  type StagingRecoveryRaceSource,
  type StagingRecoverySubmissionRequest,
  type StagingRecoveryTransactionSubmitter,
} from "./abandoned-staging-recovery.js";

const NETWORK = "kaspa:testnet-10" as const;
const SDK_NETWORK = "testnet-10";
const HASH32 = /^[a-f0-9]{64}$/;
const FINALITY = Object.freeze({ mempool: 0, accepted: 1, confirmed: 2 } as const);

export interface RpcStagingRecoveryOptions {
  /** KaspaWallet satisfies this interface without exposing its private key. */
  readonly rpc: { client(): Promise<RpcClient> };
  readonly confirmedDaaDepth?: bigint | number;
  readonly now?: () => number;
}

/**
 * Testnet-10-only read source for the two transactions competing for one
 * staging outpoint. It queries both candidate identities and the source UTXO;
 * it never submits, signs, or infers a winner from one candidate alone.
 */
export class RpcStagingRecoveryRaceSource implements StagingRecoveryRaceSource {
  private readonly rpcProvider: { client(): Promise<RpcClient> };
  private readonly confirmedDaaDepth: bigint;
  private readonly now: () => number;

  constructor(options: RpcStagingRecoveryOptions) {
    if (typeof options?.rpc?.client !== "function") {
      throw new Error("Kaspa RPC provider is required for staging recovery observation");
    }
    this.rpcProvider = options.rpc;
    this.confirmedDaaDepth = nonNegativeBigInt(
      options.confirmedDaaDepth ?? 10,
      "staging recovery confirmed DAA depth"
    );
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async observeRace(
    request: Readonly<StagingRecoveryRaceRequest>
  ): Promise<Readonly<StagingRecoveryRaceEvidence>> {
    validateRequest(request, readClock(this.now));
    request.signal.throwIfAborted();
    const rpc = await raceSignal(this.rpcProvider.client(), request.signal);
    request.signal.throwIfAborted();
    const info = await raceSignal(rpc.getServerInfo(), request.signal);
    if (
      !info.isSynced ||
      !info.hasUtxoIndex ||
      ![SDK_NETWORK, NETWORK].includes(info.networkId as typeof SDK_NETWORK | typeof NETWORK)
    ) {
      throw new Error("Kaspa RPC node is unsynced, lacks the UTXO index, or is not testnet-10");
    }
    const virtualDaaScore = BigInt(info.virtualDaaScore);
    const addresses = [...new Set([
      request.staging.address,
      ...(request.exactPayment === null
        ? []
        : [request.exactPayment.outputAddress]),
      request.recovery.outputAddress,
    ])];
    const response = await raceSignal(rpc.getUtxosByAddresses(addresses), request.signal);
    const entries = response.entries as unknown[];

    const [exactPayment, recovery] = await Promise.all([
      request.exactPayment === null
        ? Promise.resolve(null)
        : this.observeCandidate(
            rpc,
            entries,
            request.exactPayment,
            virtualDaaScore,
            request.signal
          ),
      this.observeCandidate(rpc, entries, request.recovery, virtualDaaScore, request.signal),
    ]);
    const staging = this.observeStaging(
      entries,
      request,
      observedTransactionId(exactPayment),
      observedTransactionId(recovery)
    );
    return Object.freeze({ staging, exactPayment, recovery });
  }

  private async observeCandidate(
    rpc: RpcClient,
    entries: readonly unknown[],
    expected: Readonly<StagingRecoveryExpectedCandidate>,
    virtualDaaScore: bigint,
    signal: AbortSignal
  ): Promise<StagingRecoveryCandidateObservation> {
    const outputMatches = entries.filter(
      (entry) => rpcOutpoint(entry) === expected.outputOutpoint
    );
    if (outputMatches.length > 1) {
      return partialCandidate(expected, "duplicate-output");
    }
    if (outputMatches.length === 1) {
      const entry = requireRecord(outputMatches[0], "Kaspa candidate UTXO");
      const amount = entryBigInt(entry, "amount", "Kaspa candidate UTXO amount");
      const script = entryScript(entry);
      const blockDaaScore = entryBigInt(entry, "blockDaaScore", "Kaspa candidate UTXO DAA score");
      if (
        amount.toString() !== expected.outputAmountAtomic ||
        script !== expected.outputScriptPublicKey
      ) {
        return partialCandidate(expected, "output-facts-mismatch");
      }
      const depth = virtualDaaScore >= blockDaaScore ? virtualDaaScore - blockDaaScore : 0n;
      const finality: "mempool" | "accepted" | "confirmed" =
        blockDaaScore === 0n
          ? "mempool"
          : depth >= this.confirmedDaaDepth
            ? "confirmed"
            : "accepted";
      return observedCandidate(expected, finality, digest({
        source: "kaspa-wrpc-utxo",
        transactionId: expected.transactionId,
        outputOutpoint: expected.outputOutpoint,
        outputAmountAtomic: amount.toString(),
        outputScriptPublicKey: script,
        blockDaaScore: blockDaaScore.toString(),
        virtualDaaScore: virtualDaaScore.toString(),
        finality,
      }));
    }

    try {
      const response = await raceSignal(
        rpc.getMempoolEntry({
          transactionId: expected.transactionId,
          includeOrphanPool: false,
          filterTransactionPool: false,
        }),
        signal
      );
      if (response.mempoolEntry.isOrphan) {
        return partialCandidate(expected, "orphan-transaction");
      }
      if (!mempoolMatches(response.mempoolEntry.transaction, expected)) {
        return partialCandidate(expected, "mempool-transaction-mismatch");
      }
      return observedCandidate(expected, "mempool", digest({
        source: "kaspa-wrpc-mempool",
        transactionId: expected.transactionId,
        inputOutpoint: expected.inputOutpoint,
        outputOutpoint: expected.outputOutpoint,
        outputAmountAtomic: expected.outputAmountAtomic,
        outputScriptPublicKey: expected.outputScriptPublicKey,
        finality: "mempool",
      }));
    } catch (cause) {
      if (signal.aborted) throw abortError(signal);
      if (!isMempoolNotFound(cause)) throw cause;
      return Object.freeze({
        status: "absent" as const,
        detailDigest: digest({
          source: "kaspa-wrpc",
          status: "not-in-utxo-index-or-mempool",
          transactionId: expected.transactionId,
          outputOutpoint: expected.outputOutpoint,
        }),
      });
    }
  }

  private observeStaging(
    entries: readonly unknown[],
    request: Readonly<StagingRecoveryRaceRequest>,
    exactTransactionId: string | undefined,
    recoveryTransactionId: string | undefined
  ): StagingRecoveryOutpointObservation {
    const matches = entries.filter((entry) => rpcOutpoint(entry) === request.staging.outpoint);
    if (matches.length > 1) {
      return Object.freeze({
        status: "partial" as const,
        detailDigest: digest({
          source: "kaspa-wrpc-utxo",
          status: "duplicate-staging-outpoint",
          outpoint: request.staging.outpoint,
        }),
      });
    }
    if (matches.length === 1) {
      const entry = requireRecord(matches[0], "Kaspa staging UTXO");
      const amount = entryBigInt(entry, "amount", "Kaspa staging UTXO amount").toString();
      const scriptPublicKey = entryScript(entry);
      const blockDaaScore = entryBigInt(
        entry,
        "blockDaaScore",
        "Kaspa staging UTXO DAA score"
      ).toString();
      if (
        amount !== request.staging.amountAtomic ||
        scriptPublicKey !== request.staging.scriptPublicKey ||
        blockDaaScore !== request.staging.blockDaaScore
      ) {
        return Object.freeze({
          status: "partial" as const,
          detailDigest: digest({
            source: "kaspa-wrpc-utxo",
            status: "staging-facts-mismatch",
            outpoint: request.staging.outpoint,
            amountAtomic: amount,
            scriptPublicKey,
            blockDaaScore,
          }),
        });
      }
      return Object.freeze({
        status: "unspent" as const,
        outpoint: request.staging.outpoint,
        amountAtomic: amount,
        scriptPublicKey,
        blockDaaScore,
        detailDigest: digest({
          source: "kaspa-wrpc-utxo",
          status: "unspent",
          outpoint: request.staging.outpoint,
          amountAtomic: amount,
          scriptPublicKey,
          blockDaaScore,
        }),
      });
    }

    const winner =
      exactTransactionId !== undefined && recoveryTransactionId === undefined
        ? exactTransactionId
        : recoveryTransactionId !== undefined && exactTransactionId === undefined
          ? recoveryTransactionId
          : undefined;
    return Object.freeze({
      status: "spent" as const,
      ...(winner === undefined ? {} : { spendingTransactionId: winner }),
      detailDigest: digest({
        source: "kaspa-wrpc-utxo",
        status: "staging-outpoint-absent",
        outpoint: request.staging.outpoint,
        ...(winner === undefined ? {} : { observedSpender: winner }),
      }),
    });
  }
}

/** Submit-only RPC adapter. It rehydrates and rechecks the immutable bytes. */
export class RpcStagingRecoveryTransactionSubmitter
  implements StagingRecoveryTransactionSubmitter
{
  private readonly rpcProvider: { client(): Promise<RpcClient> };
  private readonly now: () => number;

  constructor(options: Pick<RpcStagingRecoveryOptions, "rpc" | "now">) {
    if (typeof options?.rpc?.client !== "function") {
      throw new Error("Kaspa RPC provider is required for staging recovery submission");
    }
    this.rpcProvider = options.rpc;
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async submitRecovery(
    request: Readonly<StagingRecoverySubmissionRequest>
  ): Promise<{ readonly transactionId: string }> {
    if (
      request.network !== NETWORK ||
      request.transactionEncoding !== ABANDONED_STAGING_RECOVERY_ENCODING ||
      !HASH32.test(request.transactionId) ||
      !Number.isSafeInteger(request.deadlineAtMs) ||
      request.deadlineAtMs <= readClock(this.now)
    ) {
      throw new Error("staging recovery submission request is invalid or expired");
    }
    request.signal.throwIfAborted();
    let transaction: Transaction | undefined;
    try {
      transaction = Transaction.deserializeFromSafeJSON(request.transaction);
      if (
        String(transaction.finalize()).toLowerCase() !== request.transactionId ||
        transaction.serializeToSafeJSON() !== request.transaction
      ) {
        throw new Error("staging recovery submission transaction changed");
      }
      const rpc = await raceSignal(this.rpcProvider.client(), request.signal);
      const info = await raceSignal(rpc.getServerInfo(), request.signal);
      if (
        !info.isSynced ||
        ![SDK_NETWORK, NETWORK].includes(info.networkId as typeof SDK_NETWORK | typeof NETWORK)
      ) {
        throw new Error("Kaspa RPC node is unsynced or is not testnet-10");
      }
      const result = await raceSignal(
        rpc.submitTransaction({ transaction, allowOrphan: false }),
        request.signal
      );
      const transactionId = String(result.transactionId).toLowerCase();
      if (!HASH32.test(transactionId)) {
        throw new Error("Kaspa RPC returned an invalid staging recovery transaction ID");
      }
      return Object.freeze({ transactionId });
    } finally {
      transaction?.free();
    }
  }
}

function validateRequest(request: Readonly<StagingRecoveryRaceRequest>, now: number): void {
  if (
    !request ||
    request.network !== NETWORK ||
    !Number.isSafeInteger(request.deadlineAtMs) ||
    request.deadlineAtMs <= now ||
    !request.signal ||
    !HASH32.test(request.recovery.transactionId) ||
    (request.exactPayment !== null &&
      (!HASH32.test(request.exactPayment.transactionId) ||
        request.exactPayment.transactionId === request.recovery.transactionId))
  ) {
    throw new Error("staging recovery observation request is invalid or expired");
  }
}

function observedCandidate(
  expected: Readonly<StagingRecoveryExpectedCandidate>,
  finality: keyof typeof FINALITY,
  detailDigest: Sha256Digest
): StagingRecoveryCandidateObservation {
  return Object.freeze({
    status: "observed" as const,
    transactionId: expected.transactionId,
    inputOutpoint: expected.inputOutpoint,
    outputOutpoint: expected.outputOutpoint,
    outputAmountAtomic: expected.outputAmountAtomic,
    outputScriptPublicKey: expected.outputScriptPublicKey,
    finality,
    detailDigest,
  });
}

function partialCandidate(
  expected: Readonly<StagingRecoveryExpectedCandidate>,
  reason: string
): StagingRecoveryCandidateObservation {
  return Object.freeze({
    status: "partial" as const,
    detailDigest: digest({
      source: "kaspa-wrpc",
      status: "partial-candidate",
      reason,
      transactionId: expected.transactionId,
      inputOutpoint: expected.inputOutpoint,
      outputOutpoint: expected.outputOutpoint,
    }),
  });
}

function observedTransactionId(
  candidate: StagingRecoveryCandidateObservation | null
): string | undefined {
  return candidate?.status === "observed" ? candidate.transactionId : undefined;
}

function mempoolMatches(
  value: unknown,
  expected: Readonly<StagingRecoveryExpectedCandidate>
): boolean {
  let transaction: Transaction | undefined;
  try {
    transaction = new Transaction(value as never);
    if (String(transaction.finalize()).toLowerCase() !== expected.transactionId) return false;
    const inputs = transaction.inputs.filter(
      (input) =>
        `${String(input.previousOutpoint.transactionId).toLowerCase()}:${input.previousOutpoint.index}` ===
        expected.inputOutpoint
    );
    if (inputs.length !== 1) return false;
    const output = transaction.outputs[expected.outputIndex];
    if (!output || BigInt(output.value).toString() !== expected.outputAmountAtomic) return false;
    return scriptFromSdk(output.scriptPublicKey) === expected.outputScriptPublicKey;
  } catch {
    return false;
  } finally {
    transaction?.free();
  }
}

function rpcOutpoint(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const entry = record.entry && typeof record.entry === "object"
    ? record.entry as Record<string, unknown>
    : record;
  const outpointValue = record.outpoint ?? entry.outpoint;
  if (!outpointValue || typeof outpointValue !== "object") return undefined;
  const outpoint = outpointValue as Record<string, unknown>;
  const txid = String(outpoint.transactionId ?? "").toLowerCase();
  const index = Number(outpoint.index);
  return HASH32.test(txid) && Number.isSafeInteger(index) && index >= 0
    ? `${txid}:${index}`
    : undefined;
}

function entryBigInt(
  record: Record<string, unknown>,
  property: string,
  label: string
): bigint {
  const nested = record.entry && typeof record.entry === "object"
    ? record.entry as Record<string, unknown>
    : record;
  const value = record[property] ?? nested[property];
  try {
    const parsed = BigInt(value as string | number | bigint);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch (cause) {
    throw new Error(`${label} is invalid`, { cause });
  }
}

function entryScript(record: Record<string, unknown>): string {
  const nested = record.entry && typeof record.entry === "object"
    ? record.entry as Record<string, unknown>
    : record;
  return scriptFromUnknown(record.scriptPublicKey ?? nested.scriptPublicKey);
}

function scriptFromUnknown(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("Kaspa script public key is invalid");
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.version) || typeof record.script !== "string") {
    throw new Error("Kaspa script public key is invalid");
  }
  return serializeScriptPublicKey(record.version as number, record.script);
}

function scriptFromSdk(value: { version: number; script: string }): string {
  return serializeScriptPublicKey(value.version, value.script);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeBigInt(value: bigint | number, label: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch (cause) {
    throw new Error(`${label} is invalid`, { cause });
  }
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("staging recovery clock is invalid");
  return value;
}

function isMempoolNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|missing|unknown transaction|mempool.*exist/i.test(message);
}

async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(abortError(signal));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("staging recovery was aborted");
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("base64url")}` as Sha256Digest;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical number is invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("canonical value is invalid");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
