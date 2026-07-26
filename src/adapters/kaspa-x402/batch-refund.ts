import {
  hexToBytes,
  sha256Hex,
  stableStringify,
  type Hash32Hex,
} from "@kaspa-x402/core";
import {
  REFUND_COMPUTE_BUDGET,
  REFUND_SCRIPT_UNITS_ESTIMATE,
  buildEscrowRedeemScript,
  escrowScriptPublicKey,
  vectorBackedBatchTransactionBuilder,
} from "@kaspa-x402/covenant";

import { ChainEvidenceModule } from "../../chain-evidence/module.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { PurchaseJournal } from "../../purchase/journal.js";
import type { Sha256Digest } from "../../purchase/types.js";
import type {
  PreparedTreasuryOperationMaterial,
  TreasuryOperationRecord,
  TreasuryOperationValidationInput,
} from "../../treasury/operation-journal.js";
import type {
  TreasuryOperationAdapter,
  TreasuryOperationProbe,
} from "../../treasury/operation-adapters.js";
import type {
  TreasuryOperationModule,
  TreasuryOperationView,
} from "../../treasury/operations.js";
import { Transaction } from "../../kaspa-wasm.js";
import type { KaspaWallet } from "../../wallet.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import { SecureBatchChannelSigner } from "./batch-channel-signer.js";
import type { BatchActiveUtxoSource } from "./batch-payment-module.js";
import type { BatchClaimRaceSource } from "./batch-race-source.js";
import { sdkBatchTransaction } from "./batch-transaction.js";

const PROFILE = "urn:sompi:batch-refund-prepared:1" as const;
const NATIVE_SUBNETWORK = "00".repeat(20);
const OPERATION_PREFIX = "batch.refund.";
const HASH32 = /^[a-f0-9]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;

interface RefundEnvelope {
  readonly version: 1;
  readonly profile: typeof PROFILE;
  readonly operationKey: string;
  readonly channelId: string;
  readonly movementId: string;
  readonly transactionId: string;
  readonly transaction: string;
  readonly refundAddress: string;
  readonly refundAmountAtomic: string;
  readonly feeAtomic: string;
  readonly activeOutpoint: Readonly<{ txid: string; index: number }>;
  readonly outputScriptPublicKey: string;
}

export class BatchRefundTreasuryOperationAdapter implements TreasuryOperationAdapter {
  readonly kind = "batch_refund" as const;
  private readonly codec = new KaspaTestnet10AddressCodec();

  constructor(
    private readonly journal: PurchaseJournal,
    private readonly wallet: KaspaWallet,
    private readonly chain: BatchActiveUtxoSource,
    private readonly signer: SecureBatchChannelSigner,
    private readonly chainEvidence: ChainEvidenceModule,
    private readonly feeAtomic: string,
    private readonly claimRace: BatchClaimRaceSource,
  ) {
    if (
      !journal || !wallet || wallet.networkId !== "testnet-10" || !chain ||
      !signer || !chainEvidence || typeof claimRace?.observeClaimWinner !== "function" ||
      typeof claimRace?.getVirtualDaaScore !== "function"
    ) {
      throw new Error("batch refund adapter dependencies are incomplete");
    }
    atomic(feeAtomic, "batch refund fee", true);
  }

  validateRequest(input: TreasuryOperationValidationInput): void {
    const channel = this.channelFor(input.operationKey);
    if (
      input.requestedAmountAtomic === "max" || input.requestedAmountAtomic !== channel.fundingAmountAtomic ||
      input.destination !== channel.refundAddress
    ) {
      throw new Error("batch refund request does not match the active channel");
    }
  }

  async prepare(intent: TreasuryOperationRecord): Promise<PreparedTreasuryOperationMaterial> {
    const channel = this.channelFor(intent.operationKey);
    this.validateRequest({
      operationKey: intent.operationKey,
      kind: intent.kind,
      destination: intent.destination,
      requestedAmountAtomic: intent.requestedAmountAtomic,
    });
    if (channel.status !== "active" && channel.status !== "refundable") {
      throw new Error("batch channel is not refundable");
    }
    const [operatorDaa, witnessDaa] = await Promise.all([
      this.chain.getVirtualDaaScore(),
      this.claimRace.getVirtualDaaScore(new AbortController().signal),
    ]);
    const nowDaa = atomic(operatorDaa, "operator current DAA");
    const corroboratedDaa = atomic(witnessDaa, "witness current DAA");
    const timeout = atomic(channel.refundTimeoutDaa, "refund timeout");
    if (nowDaa <= timeout || corroboratedDaa <= timeout) {
      throw new Error("batch refund is not independently unlocked at the strict DAA boundary");
    }
    const active = atomic(channel.fundingAmountAtomic, "batch funding", true);
    const fee = atomic(this.feeAtomic, "batch refund fee", true);
    if (fee >= active) throw new Error("batch refund fee consumes the channel");

    const params = escrowParams(channel, this.codec);
    const redeemScript = buildEscrowRedeemScript(params);
    const refundScript = this.codec.scriptPublicKeyForAddress(channel.refundAddress, "kaspa:testnet-10");
    const base = {
      activeOutpoint: channel.activeOutpoint,
      activeAmount: channel.fundingAmountAtomic,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      redeemScript,
      refundOutputScriptPublicKey: refundScript,
      expectedRefundScriptPublicKeyHash: sha256Hex(hexToBytes(refundScript)),
      fee: fee.toString(),
      timeoutDaa: channel.refundTimeoutDaa,
      lockTimeDaa: channel.refundTimeoutDaa,
      inputSequence: "0",
      computeBudget: REFUND_COMPUTE_BUDGET,
      scriptUnitsEstimate: REFUND_SCRIPT_UNITS_ESTIMATE,
      subnetworkId: NATIVE_SUBNETWORK,
      gas: "0",
      payload: "",
    } as const;
    const draft = vectorBackedBatchTransactionBuilder.buildBatchRefundTxV1({
      ...base,
      clientSignature: "00".repeat(65),
    });
    const signature = `${this.signer.signDigest(channel.clientPublicKey, draft.sighash.digest)}01`;
    const artifact = vectorBackedBatchTransactionBuilder.buildBatchRefundTxV1({
      ...base,
      clientSignature: signature,
    });
    const transaction = sdkBatchTransaction(artifact);
    try {
      const transactionId = String(transaction.finalize()).toLowerCase();
      if (transactionId !== artifact.transactionId) throw new Error("batch refund SDK transaction ID disagrees with the alpha.9 builder");
      const envelope: RefundEnvelope = Object.freeze({
        version: 1,
        profile: PROFILE,
        operationKey: intent.operationKey,
        channelId: channel.channelId,
        movementId: refundMovementId(channel.channelId),
        transactionId,
        transaction: transaction.serializeToSafeJSON(),
        refundAddress: channel.refundAddress,
        refundAmountAtomic: (active - fee).toString(),
        feeAtomic: fee.toString(),
        activeOutpoint: Object.freeze({ ...channel.activeOutpoint }),
        outputScriptPublicKey: refundScript,
      });
      const bytes = Buffer.from(stableStringify(envelope), "utf8");
      return Object.freeze({
        bytes: Uint8Array.from(bytes),
        transactionId,
        amountAtomic: channel.fundingAmountAtomic,
        feeAtomic: fee.toString(),
      });
    } finally {
      transaction.free();
    }
  }

  async submit(intent: TreasuryOperationRecord, preparedBytes: Uint8Array): Promise<{ transactionId: string }> {
    const envelope = decodeEnvelope(preparedBytes, intent);
    const movement = this.journal.requireBatchTreasuryMovement(envelope.movementId);
    if (movement.state === "planned") {
      this.journal.advanceBatchTreasuryMovement({
        movementId: movement.movementId,
        expectedState: "planned",
        state: "submitted",
        transactionId: envelope.transactionId,
      });
    }
    const transaction = Transaction.deserializeFromSafeJSON(envelope.transaction);
    try {
      const rpc = await this.wallet.client();
      const submitted = await rpc.submitTransaction({ transaction, allowOrphan: false });
      if (String(submitted.transactionId).toLowerCase() !== envelope.transactionId) {
        throw new Error("Kaspa node returned a different batch refund transaction ID");
      }
      return Object.freeze({ transactionId: envelope.transactionId });
    } catch (error) {
      const latest = this.journal.requireBatchTreasuryMovement(envelope.movementId);
      if (latest.state === "submitted") {
        this.journal.advanceBatchTreasuryMovement({
          movementId: latest.movementId,
          expectedState: "submitted",
          state: "ambiguous",
          transactionId: envelope.transactionId,
        });
      }
      throw error;
    } finally {
      transaction.free();
    }
  }

  async observe(intent: TreasuryOperationRecord, preparedBytes: Uint8Array): Promise<TreasuryOperationProbe> {
    const envelope = decodeEnvelope(preparedBytes, intent);
    const evidence = await this.chainEvidence.observe({
      operationId: intent.operationKey,
      operation: "recovery-release",
      network: "kaspa:testnet-10",
      transactionId: envelope.transactionId,
      expectedInputs: [Object.freeze({ transactionId: envelope.activeOutpoint.txid, index: envelope.activeOutpoint.index })],
      expectedOutputs: [Object.freeze({
        index: 0,
        amountAtomic: envelope.refundAmountAtomic,
        scriptPublicKey: envelope.outputScriptPublicKey,
        address: envelope.refundAddress,
      })],
      watchedAddresses: [envelope.refundAddress],
      mechanism: "native-covenant",
      protocolFinality: "accepted",
      signal: new AbortController().signal,
    });
    const accepted = evidence.interpretation === "accepted";
    const record = evidence.evidence;
    if (!accepted) {
      const channel = this.journal.requireBatchChannel(envelope.channelId);
      const race = await this.claimRace.observeClaimWinner({
        channel,
        refundTransactionId: envelope.transactionId,
        signal: new AbortController().signal,
      });
      if (race.status === "claim") {
        const applied = this.journal.completeBatchClaimRefundRace({
          channelId: channel.channelId,
          treasuryOperationKey: intent.operationKey,
          refundMovementId: envelope.movementId,
          expectedActiveOutpoint: envelope.activeOutpoint,
          refundTransactionId: envelope.transactionId,
          claimTransactionId: race.transactionId,
          finality: race.finality,
          continuationOutpoint: race.continuationOutpoint,
          continuationScriptPublicKey: race.continuationScriptPublicKey,
          continuationFundingAmountAtomic: race.continuationFundingAmountAtomic,
          chainEvidenceDigest: race.detailDigest,
        });
        return Object.freeze({
          status: "superseded" as const,
          detail: applied.treasuryObservationDetail,
        });
      }
      return Object.freeze({
        status: race.status === "unspent" && evidence.interpretation === "absent"
          ? "not_submitted" as const
          : "pending" as const,
        detail: Object.freeze({
          profile: "urn:sompi:batch-refund-observation:1",
          operationKey: intent.operationKey,
          transactionId: envelope.transactionId,
          chainEvidenceDigest: record.detailDigest,
          chainEvidenceLevel: record.level ?? "unknown",
          raceStatus: race.status,
          raceEvidenceDigest: race.detailDigest,
        }),
      });
    }
    return Object.freeze({
      status: "observed",
      detail: Object.freeze({
        profile: "urn:sompi:batch-refund-observation:1",
        operationKey: intent.operationKey,
        transactionId: envelope.transactionId,
        chainEvidenceDigest: record.detailDigest,
        chainEvidenceLevel: record.level ?? "unknown",
      }),
    });
  }

  async commit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array,
    observedDetail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const envelope = decodeEnvelope(preparedBytes, intent);
    if (
      observedDetail.transactionId !== envelope.transactionId ||
      typeof observedDetail.chainEvidenceDigest !== "string"
    ) {
      throw new Error("batch refund observation is not bound to the prepared transaction");
    }
    this.journal.completeBatchChannelRefund({
      channelId: envelope.channelId,
      movementId: envelope.movementId,
      transactionId: envelope.transactionId,
      chainEvidenceDigest: requireDigest(
        observedDetail.chainEvidenceDigest,
        "batch refund Chain Evidence digest",
      ),
    });
  }

  private channelFor(operationKey: string) {
    if (!operationKey.startsWith(OPERATION_PREFIX)) throw new Error("batch refund operation key is invalid");
    const channelId = operationKey.slice(OPERATION_PREFIX.length);
    if (!HASH32.test(channelId)) throw new Error("batch refund channel ID is invalid");
    return this.journal.requireBatchChannel(channelId);
  }
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Sha256Digest;
}

export class KaspaX402BatchRefundModule {
  constructor(
    private readonly journal: PurchaseJournal,
    private readonly treasury: Pick<TreasuryOperationModule, "execute">,
  ) {}

  async refund(channelId: string): Promise<TreasuryOperationView> {
    if (!HASH32.test(channelId)) throw new Error("batch refund channel ID is invalid");
    const channel = this.journal.requireBatchChannel(channelId);
    if (channel.status !== "active" && channel.status !== "refundable") {
      throw new Error("batch channel is not refundable");
    }
    const movementId = refundMovementId(channelId);
    this.journal.planBatchTreasuryMovement({
      movementId,
      channelId,
      kind: "refund",
      requestDigest: evidenceDigest(Buffer.from(stableStringify({
        profile: "urn:sompi:batch-refund-intent:1",
        channelId,
        activeOutpoint: channel.activeOutpoint,
        fundingAmountAtomic: channel.fundingAmountAtomic,
        refundAddress: channel.refundAddress,
        refundTimeoutDaa: channel.refundTimeoutDaa,
      }), "utf8")),
      activeOutpointBefore: channel.activeOutpoint,
    });
    return this.treasury.execute({
      operationKey: `${OPERATION_PREFIX}${channelId}`,
      kind: "batch_refund",
      destination: channel.refundAddress,
      amountAtomic: channel.fundingAmountAtomic,
    });
  }
}

function escrowParams(channel: ReturnType<PurchaseJournal["requireBatchChannel"]>, codec: KaspaTestnet10AddressCodec) {
  const payout = codec.scriptPublicKeyForAddress(channel.payTo, "kaspa:testnet-10");
  const refund = codec.scriptPublicKeyForAddress(channel.refundAddress, "kaspa:testnet-10");
  const params = Object.freeze({
    clientPublicKey: channel.clientPublicKey,
    serverPublicKey: channel.serverPublicKey,
    network: "kaspa:testnet-10" as const,
    payoutScriptPublicKeyHash: sha256Hex(hexToBytes(payout)),
    refundScriptPublicKeyHash: sha256Hex(hexToBytes(refund)),
    timeoutDaa: channel.refundTimeoutDaa,
  });
  if (serializedEscrow(params) !== channel.activeScriptPublicKey) {
    throw new Error("batch channel script does not match its immutable config");
  }
  return params;
}

function serializedEscrow(params: Parameters<typeof escrowScriptPublicKey>[0]): string {
  const script = escrowScriptPublicKey(params);
  return `${script.version.toString(16).padStart(4, "0")}${script.script}`;
}

function decodeEnvelope(bytes: Uint8Array, intent: TreasuryOperationRecord): RefundEnvelope {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 1_000_000) {
    throw new Error("prepared batch refund is invalid");
  }
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as RefundEnvelope;
  if (
    parsed.version !== 1 || parsed.profile !== PROFILE || parsed.operationKey !== intent.operationKey ||
    !HASH32.test(parsed.channelId) || !HASH32.test(parsed.transactionId) ||
    parsed.movementId !== refundMovementId(parsed.channelId) ||
    parsed.refundAddress !== intent.destination || parsed.activeOutpoint === undefined
  ) {
    throw new Error("prepared batch refund binding changed");
  }
  const transaction = Transaction.deserializeFromSafeJSON(parsed.transaction);
  try {
    if (String(transaction.finalize()).toLowerCase() !== parsed.transactionId) {
      throw new Error("prepared batch refund transaction ID changed");
    }
  } finally {
    transaction.free();
  }
  return Object.freeze(structuredClone(parsed));
}

function refundMovementId(channelId: string): string {
  return `batch-refund:${channelId}`;
}

function atomic(value: unknown, label: string, positive = false): bigint {
  if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") || !/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) throw new Error(`${label} is outside uint64 bounds`);
  return parsed;
}
