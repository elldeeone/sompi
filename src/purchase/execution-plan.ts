import { evidenceDigest } from "./identity.js";
import type { Sha256Digest } from "./types.js";

const UINT64_MAX = (1n << 64n) - 1n;
const HASH32 = /^[a-f0-9]{64}$/;
const SERIALIZED_SCRIPT = /^0000(?:[a-f0-9]{2})+$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export type PurchaseExecutionMechanism = "single-transaction" | "channel-voucher";
export type PurchaseExecutionAssurance = "accepted" | "confirmed" | "channel-commitment";

export interface PurchaseChannelEpoch {
  readonly channelId: string;
  readonly activeOutpoint: Readonly<{ txid: string; index: number }>;
  readonly activeScriptPublicKey: string;
  readonly fundingAmountAtomic: string;
  readonly refundTimeoutDaa: string;
}

/**
 * Protocol-neutral facts the Purchase module must authorize before execution.
 * Raw x402 requirements remain Evidence Attachments owned by the adapter.
 */
export interface PurchaseExecutionPlan {
  readonly mechanism: PurchaseExecutionMechanism;
  readonly profile: string;
  readonly requirementsDigest: Sha256Digest;
  readonly maximumChargeAtomic: string;
  readonly settlementAssurance: PurchaseExecutionAssurance;
  readonly channelEpoch?: PurchaseChannelEpoch;
  readonly claimFeeReserveAtomic?: string;
}

export interface CanonicalPurchaseExecutionPlan extends PurchaseExecutionPlan {
  readonly digest: Sha256Digest;
}

export function canonicalPurchaseExecutionPlan(
  input: PurchaseExecutionPlan
): CanonicalPurchaseExecutionPlan {
  if (!input || typeof input !== "object") throw new Error("Purchase execution plan is invalid");
  if (input.mechanism !== "single-transaction" && input.mechanism !== "channel-voucher") {
    throw new Error("Purchase execution mechanism is invalid");
  }
  if (typeof input.profile !== "string" || !PROFILE.test(input.profile)) {
    throw new Error("Purchase execution profile is invalid");
  }
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(input.requirementsDigest)) {
    throw new Error("Purchase execution requirements digest is invalid");
  }
  const maximumChargeAtomic = atomic(input.maximumChargeAtomic, true, "maximum charge");
  if (
    input.settlementAssurance !== "accepted" &&
    input.settlementAssurance !== "confirmed" &&
    input.settlementAssurance !== "channel-commitment"
  ) {
    throw new Error("Purchase execution settlement assurance is invalid");
  }

  let channelEpoch: PurchaseChannelEpoch | undefined;
  let claimFeeReserveAtomic: string | undefined;
  if (input.mechanism === "single-transaction") {
    if (
      input.channelEpoch !== undefined ||
      input.claimFeeReserveAtomic !== undefined ||
      input.settlementAssurance === "channel-commitment"
    ) {
      throw new Error("single-transaction execution contains channel facts");
    }
  } else {
    if (input.settlementAssurance !== "channel-commitment" || !input.channelEpoch) {
      throw new Error("channel-voucher execution requires a bound channel epoch");
    }
    const epoch = input.channelEpoch;
    if (
      !HASH32.test(epoch.channelId) ||
      !HASH32.test(epoch.activeOutpoint?.txid ?? "") ||
      !Number.isInteger(epoch.activeOutpoint?.index) ||
      epoch.activeOutpoint.index < 0 ||
      epoch.activeOutpoint.index > 0xffff_ffff ||
      !SERIALIZED_SCRIPT.test(epoch.activeScriptPublicKey)
    ) {
      throw new Error("Purchase channel epoch identity is invalid");
    }
    const fundingAmountAtomic = atomic(epoch.fundingAmountAtomic, true, "channel funding");
    const refundTimeoutDaa = atomic(epoch.refundTimeoutDaa, true, "channel refund timeout");
    claimFeeReserveAtomic = atomic(
      input.claimFeeReserveAtomic,
      false,
      "channel claim-fee reserve"
    );
    if (BigInt(maximumChargeAtomic) + BigInt(claimFeeReserveAtomic) > BigInt(fundingAmountAtomic)) {
      throw new Error("Purchase execution exceeds the channel funding and claim-fee reserve");
    }
    channelEpoch = Object.freeze({
      channelId: epoch.channelId,
      activeOutpoint: Object.freeze({ ...epoch.activeOutpoint }),
      activeScriptPublicKey: epoch.activeScriptPublicKey,
      fundingAmountAtomic,
      refundTimeoutDaa,
    });
  }

  const facts = Object.freeze({
    mechanism: input.mechanism,
    profile: input.profile,
    requirementsDigest: input.requirementsDigest,
    maximumChargeAtomic,
    settlementAssurance: input.settlementAssurance,
    ...(channelEpoch === undefined ? {} : { channelEpoch }),
    ...(claimFeeReserveAtomic === undefined ? {} : { claimFeeReserveAtomic }),
  });
  return Object.freeze({
    ...facts,
    digest: evidenceDigest(Buffer.from(JSON.stringify(facts), "utf8")),
  });
}

export function channelEpochDigest(plan: PurchaseExecutionPlan): Sha256Digest | undefined {
  const canonical = canonicalPurchaseExecutionPlan(plan);
  return canonical.channelEpoch
    ? evidenceDigest(Buffer.from(JSON.stringify(canonical.channelEpoch), "utf8"))
    : undefined;
}

function atomic(value: unknown, positive: boolean, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Purchase execution ${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new Error(`Purchase execution ${label} is outside uint64 bounds`);
  }
  return value;
}
