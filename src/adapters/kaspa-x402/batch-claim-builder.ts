import {
  hexToBytes,
  sha256Hex,
  type SompiString,
} from "@kaspa-x402/core";
import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  buildEscrowRedeemScript,
  escrowScriptPublicKey,
  vectorBackedBatchTransactionBuilder,
} from "@kaspa-x402/covenant";
import type {
  ClaimTransactionBuilder,
  ClaimTransactionRequest,
  ClaimTransactionResult,
  ServerChannelRecord,
} from "@kaspa-x402/server";

import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import { sdkBatchTransaction } from "./batch-transaction.js";

const NATIVE_SUBNETWORK = "00".repeat(20);
const UINT64_MAX = (1n << 64n) - 1n;

export interface BatchClaimDigestSigner {
  signDigest(publicKey: string, digest: string): string;
}

export interface BatchClaimFeeSource {
  estimateClaimFee(channel: ServerChannelRecord): Promise<SompiString>;
}

/**
 * Merchant-side adapter for the alpha.9 public claim contract. Kaspa-x402 owns
 * claim eligibility, durable attempts, broadcast, continuation verification,
 * and recovery; Sompi supplies only key custody and SDK-safe serialization.
 */
export class KaspaX402BatchClaimBuilder implements ClaimTransactionBuilder {
  private readonly codec = new KaspaTestnet10AddressCodec();

  constructor(
    private readonly signer: BatchClaimDigestSigner,
    private readonly fees: BatchClaimFeeSource,
  ) {
    if (!signer || typeof signer.signDigest !== "function" || !fees || typeof fees.estimateClaimFee !== "function") {
      throw new Error("batch claim builder dependencies are incomplete");
    }
  }

  async buildClaimTransaction(
    request: ClaimTransactionRequest
  ): Promise<ClaimTransactionResult> {
    const channel = validatedChannel(request.channel);
    const claim = atomic(request.claimAmount, "batch claim amount", true);
    const active = atomic(channel.fundingAmount, "batch channel funding", true);
    const voucher = atomic(channel.signedMaxClaimable, "batch signed voucher ceiling", true);
    const fee = atomic(await this.fees.estimateClaimFee(channel), "batch claim fee", true);
    if (!channel.voucherSignature) throw new Error("batch claim requires a signed voucher");
    if (claim > voucher || claim > active || fee >= claim) {
      throw new Error("batch claim amount or fee is outside the signed channel bounds");
    }

    const params = escrowParams(channel, this.codec);
    const redeemScript = buildEscrowRedeemScript(params);
    const serverOutputScriptPublicKey = this.codec.scriptPublicKeyForAddress(
      channel.channelConfig.payTo,
      "kaspa:testnet-10"
    );
    const base = {
      network: "kaspa:testnet-10" as const,
      activeOutpoint: channel.activeOutpoint,
      activeAmount: active.toString(),
      activeScriptPublicKey: channel.activeScriptPublicKey,
      redeemScript,
      serverOutputScriptPublicKey,
      expectedPayoutScriptPublicKeyHash: sha256Hex(hexToBytes(serverOutputScriptPublicKey)),
      claimAmount: claim.toString(),
      voucherAmount: voucher.toString(),
      fee: fee.toString(),
      voucherSignature: channel.voucherSignature,
      computeBudget: CLAIM_COMPUTE_BUDGET,
      scriptUnitsEstimate: CLAIM_SCRIPT_UNITS_ESTIMATE,
      subnetworkId: NATIVE_SUBNETWORK,
      gas: "0",
      payload: "",
    } as const;
    const draft = vectorBackedBatchTransactionBuilder.buildBatchClaimTxV1({
      ...base,
      serverSignature: "00".repeat(65),
    });
    const serverSignature = `${this.signer.signDigest(
      channel.channelConfig.serverPublicKey,
      draft.sighash.digest
    )}01`;
    const artifact = vectorBackedBatchTransactionBuilder.buildBatchClaimTxV1({
      ...base,
      serverSignature,
    });
    const transaction = sdkBatchTransaction(artifact);
    try {
      const transactionId = String(transaction.finalize()).toLowerCase();
      if (transactionId !== artifact.transactionId) {
        throw new Error("batch claim SDK transaction ID disagrees with the alpha.9 builder");
      }
      return Object.freeze({
        transaction: transaction.serializeToSafeJSON(),
        claimAmount: claim.toString(),
        continuationOutpoint: Object.freeze({ txid: transactionId, index: 1 }),
        continuationScriptPublicKey: channel.activeScriptPublicKey,
        continuationFundingAmount: (active - claim).toString(),
      });
    } finally {
      transaction.free();
    }
  }
}

function validatedChannel(channel: ServerChannelRecord): ServerChannelRecord {
  if (
    !channel || channel.status !== "active" ||
    channel.channelConfig.network !== "kaspa:testnet-10" ||
    channel.channelConfig.asset !== "KAS" ||
    channel.channelConfig.templateId !== "kaspa-x402-escrow-v1" ||
    !/^[a-f0-9]{64}$/.test(channel.channelId) ||
    !/^[a-f0-9]{64}$/.test(channel.channelConfig.serverPublicKey) ||
    !/^[a-f0-9]{64}$/.test(channel.channelConfig.clientPublicKey)
  ) {
    throw new Error("batch claim channel is invalid");
  }
  return structuredClone(channel);
}

function escrowParams(channel: ServerChannelRecord, codec: KaspaTestnet10AddressCodec) {
  const payout = codec.scriptPublicKeyForAddress(
    channel.channelConfig.payTo,
    "kaspa:testnet-10"
  );
  const refund = codec.scriptPublicKeyForAddress(
    channel.channelConfig.refundAddress,
    "kaspa:testnet-10"
  );
  const params = Object.freeze({
    clientPublicKey: channel.channelConfig.clientPublicKey,
    serverPublicKey: channel.channelConfig.serverPublicKey,
    network: "kaspa:testnet-10" as const,
    payoutScriptPublicKeyHash: sha256Hex(hexToBytes(payout)),
    refundScriptPublicKeyHash: sha256Hex(hexToBytes(refund)),
    timeoutDaa: channel.channelConfig.refundTimeoutDaa,
  });
  const script = escrowScriptPublicKey(params);
  const serialized = `${script.version.toString(16).padStart(4, "0")}${script.script}`;
  if (serialized !== channel.activeScriptPublicKey) {
    throw new Error("batch claim channel script does not match its immutable config");
  }
  return params;
}

function atomic(value: unknown, label: string, positive = false): bigint {
  if (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
    !/^(?:0|[1-9][0-9]*)$/.test(String(value))
  ) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new Error(`${label} is outside uint64 bounds`);
  }
  return parsed;
}
