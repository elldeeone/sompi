import {
  Transaction,
  type RpcClient,
} from "../../kaspa-wasm.js";
import {
  ABANDONED_STAGING_RECOVERY_ENCODING,
  type StagingRecoverySubmissionRequest,
  type StagingRecoveryTransactionSubmitter,
} from "./abandoned-staging-recovery.js";

const NETWORK = "kaspa:testnet-10" as const;
const SDK_NETWORK = "testnet-10";
const HASH32 = /^[a-f0-9]{64}$/;

export interface RpcStagingRecoverySubmissionOptions {
  /** KaspaWallet satisfies this interface without exposing its private key. */
  readonly rpc: { client(): Promise<RpcClient> };
  readonly now?: () => number;
}

/** Submit-only RPC adapter. It rehydrates and rechecks the immutable bytes. */
export class RpcStagingRecoveryTransactionSubmitter
  implements StagingRecoveryTransactionSubmitter
{
  private readonly rpcProvider: { client(): Promise<RpcClient> };
  private readonly now: () => number;

  constructor(options: RpcStagingRecoverySubmissionOptions) {
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

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("staging recovery clock is invalid");
  return value;
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
