import {
  PAYMENT_REQUIRED_HEADER,
  parsePaymentRequiredHeaderValue,
  type ChannelStore,
  type DirectModeChannel,
} from "@kaspa-x402/client";
import type { BatchPaymentRequirements } from "@kaspa-x402/core";

import type { PaymentRequirementsArtifactVerifier } from "../../purchase/checkout-terms-module.js";
import type { VerifiedArtifact } from "../../purchase/coordinator.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { CheckoutTerms, Sha256Digest } from "../../purchase/types.js";

export const KASPA_X402_PAYMENT_REQUIRED_PROFILE =
  "kaspa-x402-0.1.0-alpha.8-payment-required" as const;

const TESTNET = "kaspa:testnet-10";
const MAX_REQUIREMENTS_BYTES = 32 * 1024;
const SERIALIZED_V0_SCRIPT = /^0000(?:[0-9a-f]{2})+$/;
const HEX_BYTES = /^(?:[0-9a-f]{2})+$/;
const HASH32 = /^[0-9a-f]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export interface KaspaX402PaymentRequirementsVerifierOptions {
  readonly channelStore?: ChannelStore;
  readonly claimFeeReserveAtomic?: string;
}

/** Verifies only the two clean-cut kaspa-exact-v2 profiles. */
export class KaspaX402PaymentRequirementsVerifier
implements PaymentRequirementsArtifactVerifier {
  private readonly channelStore?: ChannelStore;
  private readonly claimFeeReserveAtomic: string;

  constructor(options: KaspaX402PaymentRequirementsVerifierOptions = {}) {
    this.channelStore = options.channelStore;
    this.claimFeeReserveAtomic = atomic(
      options.claimFeeReserveAtomic ?? "1",
      "claim-fee reserve",
      true
    );
  }

  readonly artifactHeader = Object.freeze({
    name: PAYMENT_REQUIRED_HEADER,
    maximumBytes: MAX_REQUIREMENTS_BYTES,
  });

  async verify(
    input: Parameters<PaymentRequirementsArtifactVerifier["verify"]>[0]
  ): ReturnType<PaymentRequirementsArtifactVerifier["verify"]> {
    const nowMs = requireNow(input.nowMs);
    const bytes = copyArtifact(input.artifact);
    const digest = evidenceDigest(bytes);
    if (digest !== input.expectedDigest) {
      throw new Error("PAYMENT-REQUIRED digest does not match the Merchant Checkout");
    }
    const parsed = parsePaymentRequiredHeaderValue(Buffer.from(bytes).toString("ascii"), {
      supportedNetworks: [TESTNET],
      supportedSchemes: ["exact", "batch-settlement"],
    });
    const executionPlan = parsed.accepted.scheme === "exact"
      ? assertExactPaymentRequired(parsed, input.terms, input.finalHop.url, nowMs, digest)
      : await this.assertBatchPaymentRequired(
          parsed.accepted as BatchPaymentRequirements,
          parsed.paymentRequired.resource.url,
          input.terms,
          input.finalHop.url,
          nowMs,
          digest
        );
    return Object.freeze({
      artifact: verifiedArtifact(bytes, input.terms.merchant.id, digest),
      executionPlan,
    });
  }

  private async assertBatchPaymentRequired(
    accepted: BatchPaymentRequirements,
    resourceUrl: string,
    terms: CheckoutTerms,
    finalUrl: string,
    nowMs: number,
    requirementsDigest: Sha256Digest
  ) {
    const extra = accepted.extra;
    if (
      resourceUrl !== finalUrl ||
      accepted.network !== TESTNET ||
      accepted.asset !== "KAS" ||
      accepted.amount !== terms.amountAtomic ||
      accepted.payTo !== terms.payTo ||
      extra.binding !== "kaspa-escrow-v1" ||
      extra.templateId !== "kaspa-x402-escrow-v1" ||
      !HASH32.test(String(extra.serverPublicKey ?? "")) ||
      atomic(extra.minDepositSompi, "minimum deposit", true) !== extra.minDepositSompi ||
      BigInt(extra.minDepositSompi) < BigInt(accepted.amount) ||
      atomic(extra.refundTimeoutDaa, "refund timeout", true) !== extra.refundTimeoutDaa ||
      BigInt(extra.refundTimeoutDaa) >= 500000000000n
    ) {
      throw new Error("batch PAYMENT-REQUIRED does not match the signed Checkout Terms");
    }
    if (!this.channelStore) {
      throw new Error("batch PAYMENT-REQUIRED requires a durable ChannelStore");
    }
    const state = extra.channelState;
    if (!state || !HASH32.test(state.channelId) || !HASH32.test(state.activeOutpoint?.txid ?? "")) {
      throw new Error("batch Purchase requires an already accepted channel epoch");
    }
    const candidates = await this.channelStore.loadChannels({
      origin: terms.merchant.origin,
      resourceUrl: finalUrl,
      network: TESTNET,
      status: "active",
    });
    const channel = candidates.find((candidate) => candidate.id === state.channelId);
    assertChannelMatchesOffer(channel, accepted, finalUrl, nowMs);
    if (
      state.activeOutpoint.txid !== channel.activeOutpoint.txid ||
      state.activeOutpoint.index !== channel.activeOutpoint.index ||
      state.activeScriptPublicKey.toLowerCase() !== channel.activeScriptPublicKey.toLowerCase() ||
      state.fundingAmount !== channel.fundingAmount ||
      state.chargedCumulativeAmount !== channel.chargedCumulativeAmount ||
      state.claimedCumulativeAmount !== channel.claimedCumulativeAmount ||
      state.signedMaxClaimable !== channel.signedCumulativeAmount
    ) {
      throw new Error("batch PAYMENT-REQUIRED channel epoch does not match durable state");
    }
    const activeCharged = BigInt(channel.chargedCumulativeAmount) - BigInt(channel.claimedCumulativeAmount);
    if (activeCharged < 0n || activeCharged + BigInt(accepted.amount) + BigInt(this.claimFeeReserveAtomic) > BigInt(channel.fundingAmount)) {
      throw new Error("batch channel cannot cover the authorized charge and claim-fee reserve");
    }
    return Object.freeze({
      mechanism: "channel-voucher" as const,
      profile: "kaspa-escrow-v1:batch-settlement",
      requirementsDigest,
      maximumChargeAtomic: accepted.amount,
      settlementAssurance: "channel-commitment" as const,
      claimFeeReserveAtomic: this.claimFeeReserveAtomic,
      channelEpoch: Object.freeze({
        channelId: channel.id,
        activeOutpoint: Object.freeze({ ...channel.activeOutpoint }),
        activeScriptPublicKey: channel.activeScriptPublicKey,
        fundingAmountAtomic: channel.fundingAmount,
        refundTimeoutDaa: channel.refundTimeoutDaa,
      }),
    });
  }
}

function assertExactPaymentRequired(
  parsed: ReturnType<typeof parsePaymentRequiredHeaderValue>,
  terms: CheckoutTerms,
  finalUrl: string,
  nowMs: number,
  requirementsDigest: Sha256Digest
) {
  const accepted = parsed.accepted;
  const extra = accepted.extra;
  if (
    parsed.paymentRequired.resource.url !== finalUrl ||
    accepted.scheme !== "exact" ||
    accepted.network !== TESTNET ||
    accepted.asset !== "KAS" ||
    accepted.amount !== terms.amountAtomic ||
    accepted.payTo !== terms.payTo ||
    extra.binding !== "kaspa-exact-v2" ||
    (extra.profile !== "standard-native" && extra.profile !== "additive") ||
    extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    !SERIALIZED_V0_SCRIPT.test(String(extra.payToScriptPublicKey ?? "")) ||
    (extra.finality !== "accepted" && extra.finality !== "confirmed")
  ) {
    throw new Error("PAYMENT-REQUIRED does not match the signed Checkout Terms");
  }
  if (extra.profile === "standard-native") {
    if (extra.paymentOutputIndex !== undefined) {
      throw new Error("standard-native PAYMENT-REQUIRED contains an additive output index");
    }
    for (const key of [
      "headId", "headVersion", "expectedHeadOutpoint", "headAmount",
      "headScriptPublicKey", "headRedeemScript", "challengeId",
      "challengeExpiresAt", "additiveThresholdSompi", "templateId",
    ]) {
      if (extra[key] !== undefined) {
        throw new Error("standard-native PAYMENT-REQUIRED contains additive head facts");
      }
    }
    return Object.freeze({
      mechanism: "single-transaction" as const,
      profile: "kaspa-exact-v2:standard-native",
      requirementsDigest,
      maximumChargeAtomic: accepted.amount,
      settlementAssurance: extra.finality,
    });
  }
  const challengeExpiry = Date.parse(String(extra.challengeExpiresAt ?? ""));
  const outpoint = extra.expectedHeadOutpoint;
  if (
    extra.templateId !== "kaspa-x402-kip10-additive-v1" ||
    extra.paymentOutputIndex !== 0 ||
    !HASH32.test(String(extra.headId ?? "")) ||
    !/^(?:0|[1-9][0-9]*)$/.test(String(extra.headVersion ?? "")) ||
    !outpoint ||
    !HASH32.test(outpoint.txid) ||
    outpoint.index !== 0 ||
    !/^[1-9][0-9]*$/.test(String(extra.headAmount ?? "")) ||
    !SERIALIZED_V0_SCRIPT.test(String(extra.headScriptPublicKey ?? "")) ||
    !HEX_BYTES.test(String(extra.headRedeemScript ?? "")) ||
    !HASH32.test(String(extra.challengeId ?? "")) ||
    !/^[1-9][0-9]*$/.test(String(extra.additiveThresholdSompi ?? "")) ||
    BigInt(String(extra.additiveThresholdSompi)) > BigInt(accepted.amount) ||
    !Number.isFinite(challengeExpiry) ||
    challengeExpiry <= nowMs
  ) {
    throw new Error("additive PAYMENT-REQUIRED head challenge is invalid");
  }
  return Object.freeze({
    mechanism: "single-transaction" as const,
    profile: "kaspa-exact-v2:additive",
    requirementsDigest,
    maximumChargeAtomic: accepted.amount,
    settlementAssurance: extra.finality,
  });
}

function assertChannelMatchesOffer(
  channel: DirectModeChannel | undefined,
  accepted: BatchPaymentRequirements,
  resourceUrl: string,
  nowMs: number
): asserts channel is DirectModeChannel {
  if (
    !channel || channel.status !== "active" || channel.resourceUrl !== resourceUrl ||
    channel.origin !== new URL(resourceUrl).origin ||
    channel.config.network !== TESTNET || channel.config.asset !== "KAS" ||
    channel.config.templateId !== "kaspa-x402-escrow-v1" ||
    channel.config.serverPublicKey !== accepted.extra.serverPublicKey ||
    channel.config.payTo !== accepted.payTo ||
    channel.config.refundTimeoutDaa !== accepted.extra.refundTimeoutDaa ||
    channel.refundTimeoutDaa !== accepted.extra.refundTimeoutDaa ||
    BigInt(channel.refundTimeoutDaa) <= 0n ||
    !Number.isSafeInteger(nowMs)
  ) {
    throw new Error("batch PAYMENT-REQUIRED has no matching durable channel");
  }
}

function atomic(value: unknown, label: string, positive: boolean): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`batch ${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new Error(`batch ${label} is outside uint64 bounds`);
  }
  return value;
}

function verifiedArtifact(
  bytes: Uint8Array,
  issuer: string,
  digest: Sha256Digest
): VerifiedArtifact {
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    mediaType: "application/x402-payment-required",
    profile: KASPA_X402_PAYMENT_REQUIRED_PROFILE,
    issuer,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId: "kaspa-x402:0.1.0-alpha.8:payment-required",
      profile: KASPA_X402_PAYMENT_REQUIRED_PROFILE,
      detailDigest: digest,
    }),
  });
}

function copyArtifact(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_REQUIREMENTS_BYTES) {
    throw new Error("PAYMENT-REQUIRED is not bounded compact ASCII");
  }
  const bytes = Uint8Array.from(value);
  const text = Buffer.from(bytes).toString("ascii");
  if (/[^\x21-\x7e]/.test(text) || !Buffer.from(text, "ascii").equals(Buffer.from(bytes))) {
    throw new Error("PAYMENT-REQUIRED is not bounded compact ASCII");
  }
  return bytes;
}

function requireNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("verification clock is invalid");
  return value;
}
