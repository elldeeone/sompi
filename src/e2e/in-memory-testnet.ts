import type {
  ExactTransactionVerificationRequest,
  ExactTransactionVerifier,
} from "@kaspa-x402/server";
import { exactRequestAuthorizationId } from "@kaspa-x402/core";

import { Transaction, type ScriptPublicKey } from "../kaspa-wasm.js";
import type {
  ChainObservation,
  ChainObservationRequest,
  ChainObservationSource,
} from "../adapters/kaspa-x402/chain-verifier.js";
import { serializeScriptPublicKey } from "../adapters/kaspa-x402/address-codec.js";

const NETWORK = "kaspa:testnet-10" as const;

interface ExactRecord {
  readonly transactionId: string;
  readonly transaction: string;
  readonly outputIndex: number;
  readonly amountAtomic: string;
  readonly scriptPublicKey: string;
}

/** Deterministic external Kaspa/RPC fixture; it has no signing authority. */
export class InMemoryKaspaTestnet10
implements ChainObservationSource, ExactTransactionVerifier {
  private submittedStaging?: Transaction;
  private exact?: ExactRecord;
  private stagingVisible = true;
  private readonly initialVaultAddress: string;
  private readonly initialVaultScript: ScriptPublicKey;
  private readonly initialVaultAmount: bigint;
  private readonly initialVaultTransactionId: string;
  private readonly covenantId: string;
  stagingSubmissionCount = 0;
  exactAcceptanceCount = 0;

  constructor(options: {
    initialVaultAddress: string;
    initialVaultScript: ScriptPublicKey;
    initialVaultAmount: bigint;
    initialVaultTransactionId: string;
    covenantId: string;
    stagingVisibleOnSubmit?: boolean;
  }) {
    this.initialVaultAddress = options.initialVaultAddress;
    this.initialVaultScript = options.initialVaultScript;
    this.initialVaultAmount = options.initialVaultAmount;
    this.initialVaultTransactionId = options.initialVaultTransactionId;
    this.covenantId = options.covenantId;
    this.stagingVisible = options.stagingVisibleOnSubmit ?? true;
  }

  walletClient(): object {
    return {
      getUtxosByAddresses: async (addresses: string[]) => {
        if (addresses.length === 1 && addresses[0] === this.initialVaultAddress) {
          return {
            entries: [{
              outpoint: { transactionId: this.initialVaultTransactionId, index: 0 },
              amount: this.initialVaultAmount,
              scriptPublicKey: this.initialVaultScript,
              blockDaaScore: 1n,
              isCoinbase: false,
              covenantId: this.covenantId,
            }],
          };
        }
        if (!this.submittedStaging || !this.stagingVisible) return { entries: [] };
        const transactionId = String(this.submittedStaging.finalize()).toLowerCase();
        return {
          entries: [
            {
              outpoint: { transactionId, index: 0 },
              amount: this.submittedStaging.outputs[0].value,
              scriptPublicKey: this.submittedStaging.outputs[0].scriptPublicKey,
              blockDaaScore: 9n,
              isCoinbase: false,
            },
            {
              outpoint: { transactionId, index: 1 },
              amount: this.submittedStaging.outputs[1].value,
              scriptPublicKey: this.submittedStaging.outputs[1].scriptPublicKey,
              blockDaaScore: 9n,
              isCoinbase: false,
              covenantId: this.covenantId,
            },
          ],
        };
      },
      getFeeEstimate: async () => ({
        estimate: { normalBuckets: [{ feerate: 100 }] },
      }),
      getServerInfo: async () => ({ virtualDaaScore: "100" }),
      submitTransaction: async ({ transaction }: { transaction: Transaction }) => {
        const snapshot = new Transaction(transaction);
        const transactionId = String(snapshot.finalize()).toLowerCase();
        if (this.submittedStaging) {
          const existing = String(this.submittedStaging.finalize()).toLowerCase();
          snapshot.free();
          if (existing !== transactionId) {
            throw new Error("staging submission changed its immutable transaction");
          }
          return { transactionId };
        }
        this.submittedStaging = snapshot;
        this.stagingSubmissionCount += 1;
        return { transactionId };
      },
    };
  }

  makeStagingVisible(): void {
    this.stagingVisible = true;
  }

  verifyExactPayment(request: ExactTransactionVerificationRequest) {
    if (
      request.network !== NETWORK ||
      request.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
      request.paymentOutputIndex !== 0
    ) {
      throw new Error("Merchant exact verifier received an unsupported transaction profile");
    }
    const transaction = Transaction.deserializeFromSafeJSON(request.transaction);
    try {
      const transactionId = String(transaction.finalize()).toLowerCase();
      if (transaction.serializeToSafeJSON() !== request.transaction) {
        throw new Error("Merchant exact transaction is not canonical safe JSON");
      }
      const output = transaction.outputs[request.paymentOutputIndex];
      if (!output) throw new Error("Merchant exact payment output is missing");
      const amountAtomic = BigInt(output.value).toString();
      const scriptPublicKey = serializeScriptPublicKey(
        output.scriptPublicKey.version,
        output.scriptPublicKey.script
      );
      const expectedOutputAmount = request.profile === "additive"
        ? (BigInt(request.head!.headAmount) + BigInt(request.amount)).toString()
        : request.amount;
      if (amountAtomic !== expectedOutputAmount || scriptPublicKey !== request.payToScriptPublicKey) {
        throw new Error("Merchant exact payment output differs from its requirement");
      }
      const record = Object.freeze({
        transactionId,
        transaction: request.transaction,
        outputIndex: request.paymentOutputIndex,
        amountAtomic,
        scriptPublicKey,
      });
      if (this.exact) {
        if (JSON.stringify(this.exact) !== JSON.stringify(record)) {
          throw new Error("Merchant exact transaction replay conflicts");
        }
      } else {
        this.exact = record;
        this.exactAcceptanceCount += 1;
      }
      return {
        transactionId,
        paymentOutput: {
          amount: request.amount,
          scriptPublicKey,
          address: request.payTo,
        },
        finality: "accepted" as const,
        requestAuthorization: {
          authorizationId: exactRequestAuthorizationId(request.authorization),
          digest: request.authorization.digest,
          inputIndex: request.authorization.inputIndex,
          publicKey: payerPublicKey(transaction, request.authorization.inputIndex),
        },
        ...(request.profile === "additive"
          ? {
              continuation: {
                outpoint: { txid: transactionId, index: 0 },
                amount: amountAtomic,
                scriptPublicKey,
              },
            }
          : {}),
      };
    } finally {
      transaction.free();
    }
  }

  async observeExactOutput(
    request: Readonly<ChainObservationRequest>
  ): Promise<ChainObservation> {
    request.signal.throwIfAborted();
    if (!this.exact) return { status: "pending" };
    if (
      request.network !== NETWORK ||
      request.transactionId !== this.exact.transactionId ||
      request.outpoint !== `${this.exact.transactionId}:${this.exact.outputIndex}` ||
      request.outputIndex !== this.exact.outputIndex ||
      request.expectedAmountAtomic !== this.exact.amountAtomic ||
      request.expectedScriptPublicKey !== this.exact.scriptPublicKey
    ) {
      throw new Error("in-memory chain observation request changed exact output facts");
    }
    return Object.freeze({
      status: "observed" as const,
      network: NETWORK,
      transactionId: this.exact.transactionId,
      outpoint: request.outpoint,
      amountAtomic: this.exact.amountAtomic,
      scriptPublicKey: this.exact.scriptPublicKey,
      finality: request.minimumFinality === "confirmed" ? "confirmed" : "accepted",
      observedAtMs: 1_893_456_000_000,
    });
  }

  exactTransactionId(): string | undefined {
    return this.exact?.transactionId;
  }

  stagingTransactionId(): string | undefined {
    return this.submittedStaging
      ? String(this.submittedStaging.finalize()).toLowerCase()
      : undefined;
  }

  close(): void {
    this.submittedStaging?.free();
    this.submittedStaging = undefined;
    this.initialVaultScript.free();
  }
}

function payerPublicKey(transaction: Transaction, inputIndex: number): string {
  const input = transaction.inputs[inputIndex];
  if (!input) throw new Error("request authorization input is missing");
  const serialized = serializeScriptPublicKey(
    input.utxo!.scriptPublicKey.version,
    input.utxo!.scriptPublicKey.script
  );
  const match = /^000020([0-9a-f]{64})ac$/.exec(serialized);
  if (!match) throw new Error("request authorization input is not Schnorr P2PK");
  return match[1]!;
}
