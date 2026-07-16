import {
  parsePaymentRequiredHeaderValue,
} from "@kaspa-x402/client";
import {
  stableStringify,
  validatePaymentPayload,
  validatePaymentRequired,
  validatePaymentRetry,
} from "@kaspa-x402/core";

import type {
  PreparedStagingRecovery,
  StagingRecoveryObservation,
  StagingRecoveryPreparationContext,
  StagingRecoveryReadiness,
  StagingRecoverySubmission,
  TreasuryStagingRecoveryModule,
} from "../../purchase/coordinator.js";
import type { Sha256Digest } from "../../purchase/types.js";
import type {
  JournalObservedStagingSource,
} from "./exact-attempt-funding-bridge.js";
import {
  ABANDONED_STAGING_RECOVERY_ENCODING,
  AbandonedStagingRecovery,
  type ImmutableExactPaymentCandidate,
  type ImmutableExactPaymentSelection,
  type StagingRecoveryReadiness as AdapterReadiness,
} from "./abandoned-staging-recovery.js";
import type { TreasuryStagingMetadataSource } from "./vault-treasury-staging.js";

const NETWORK = "kaspa:testnet-10" as const;
const ASSET = "KAS" as const;
const SCHEME = "exact" as const;
const MAX_ARTIFACT_BYTES = 2_000_000;
const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;

export interface KaspaStagingRecoveryModuleOptions {
  readonly recovery: AbandonedStagingRecovery;
  readonly metadata: TreasuryStagingMetadataSource;
  readonly observedStaging: JournalObservedStagingSource;
  readonly finalityFloor: "accepted" | "depth-confirmed";
}

/**
 * Joins journal-verified staging facts to the low-level sweep adapter. x402
 * parsing and Kaspa transaction extraction remain on this adapter side of the
 * Purchase seam.
 */
export class KaspaStagingRecoveryModule
  implements TreasuryStagingRecoveryModule
{
  constructor(private readonly options: KaspaStagingRecoveryModuleOptions) {
    if (
      !options?.recovery ||
      typeof options.recovery.prepare !== "function" ||
      typeof options.metadata?.read !== "function" ||
      typeof options.observedStaging?.read !== "function"
    ) {
      throw new Error("staging recovery dependencies are required");
    }
  }

  async prepare(
    input: Readonly<StagingRecoveryPreparationContext>
  ): Promise<Readonly<PreparedStagingRecovery>> {
    validatePreparationContext(input);
    const query = {
      purchaseId: input.purchaseId,
      paymentIdentifier: input.paymentIdentifier,
    } as const;
    const [metadata, observed] = await Promise.all([
      this.options.metadata.read(query),
      this.options.observedStaging.read({
        ...query,
        evidenceDigest: input.stagingEvidenceDigest,
      }),
    ]);
    const exact: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["staging transaction", observed.transactionId, metadata.transactionId],
      ["staging outpoint", observed.outpoint, metadata.outpoint],
      ["staging amount", observed.amountAtomic, metadata.stagingAmountAtomic],
      ["staging address", observed.address, metadata.address],
      ["staging script", observed.scriptPublicKey, metadata.scriptPublicKey],
      ["staging evidence", observed.evidenceDigest, input.stagingEvidenceDigest],
      ["authorized ceiling", metadata.additionalCostCeilingAtomic,
        input.authorizedAdditionalCostCeilingAtomic],
      ["Merchant price", metadata.priceAtomic, input.terms.amountAtomic],
    ];
    for (const [label, actual, expected] of exact) {
      if (actual !== expected) {
        throw new Error(`${label} differs across staging recovery facts`);
      }
    }
    const requirement = exactRequirement(input, this.options.finalityFloor);
    const selection: ImmutableExactPaymentSelection = input.exactPayment
      ? {
          mode: "exact_candidate",
          candidate: exactCandidate(input),
        }
      : { mode: "no_exact_candidate" };
    const prepared = await this.options.recovery.prepare({
      purchaseId: input.purchaseId,
      paymentIdentifier: input.paymentIdentifier,
      staging: {
        network: NETWORK,
        outpoint: parseOutpoint(observed.outpoint),
        amountAtomic: observed.amountAtomic,
        scriptPublicKey: observed.scriptPublicKey,
        address: observed.address,
        blockDaaScore: observed.blockDaaScore,
        keyReference: metadata.keyReference,
        evidenceDigest: observed.evidenceDigest,
      },
      exactPayment: selection,
    });
    return Object.freeze({
      preparedBytes: Uint8Array.from(prepared.preparedBytes),
      preparedDigest: prepared.preparedDigest,
      ...(prepared.exactPaymentTransactionId === undefined
        ? {}
        : { exactTransactionId: prepared.exactPaymentTransactionId }),
      recoveryTransactionId: prepared.transactionId,
      recoveryOutpoint: `${prepared.transactionId}:0`,
      recoveryAmountAtomic: prepared.recoveryAmountAtomic,
      stagingFeeAtomic: metadata.stagingFeeAtomic,
      recoveryFeeAtomic: prepared.feeAtomic,
      requiredFinality: requirement.requiredFinality,
    });
  }

  async observe(input: {
    preparedBytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<Readonly<StagingRecoveryObservation>> {
    const result = await this.options.recovery.observe(
      Uint8Array.from(input.preparedBytes),
      input.signal
    );
    if (result.status === "safe_to_submit") {
      const readiness: StagingRecoveryReadiness = Object.freeze({
        proofDigest: result.readiness.proofDigest,
        observedAtMs: result.readiness.observedAtMs,
        expiresAtMs: result.readiness.expiresAtMs,
        token: result.readiness,
      });
      return Object.freeze({
        status: "safe_to_submit" as const,
        evidenceDigest: result.evidenceDigest,
        readiness,
      });
    }
    if (result.status === "pending") return Object.freeze({ ...result });
    if (result.status === "recovery_won") {
      return Object.freeze({
        status: "recovery_won" as const,
        transactionId: result.transactionId,
        recoveryOutpoint: result.recoveryOutpoint,
        recoveryAmountAtomic: result.recoveryAmountAtomic,
        finality: result.finality,
        evidenceDigest: result.evidenceDigest,
      });
    }
    if (result.reason === "exact_payment_won") {
      if (!result.winningTransactionId || !result.winningFinality) {
        throw new Error("exact staging-race winner is incomplete");
      }
      return Object.freeze({
        status: "exact_payment_won" as const,
        transactionId: result.winningTransactionId,
        finality: result.winningFinality,
        evidenceDigest: result.evidenceDigest,
      });
    }
    return Object.freeze({
      status: "conflict" as const,
      reason: result.reason,
      evidenceDigest: result.evidenceDigest,
    });
  }

  async submit(input: {
    preparedBytes: Uint8Array;
    readiness: Readonly<StagingRecoveryReadiness>;
    signal: AbortSignal;
  }): Promise<Readonly<StagingRecoverySubmission>> {
    const token = input.readiness.token as AdapterReadiness;
    if (
      !token ||
      token.proofDigest !== input.readiness.proofDigest ||
      token.observedAtMs !== input.readiness.observedAtMs ||
      token.expiresAtMs !== input.readiness.expiresAtMs
    ) {
      throw new Error("staging recovery readiness token changed at the Purchase seam");
    }
    const result = await this.options.recovery.submit(
      Uint8Array.from(input.preparedBytes),
      token,
      input.signal
    );
    return Object.freeze({ ...result });
  }
}

function validatePreparationContext(
  input: Readonly<StagingRecoveryPreparationContext>
): void {
  if (
    !input ||
    input.terms.network !== NETWORK ||
    input.terms.asset !== ASSET ||
    !DIGEST.test(input.stagingEvidenceDigest) ||
    !/^(?:0|[1-9][0-9]*)$/.test(input.authorizedAdditionalCostCeilingAtomic)
  ) {
    throw new Error("staging recovery Purchase context is invalid");
  }
  if (input.exactPayment) {
    if (
      !HASH32.test(input.exactPayment.transactionId) ||
      !DIGEST.test(input.exactPayment.preparedDigest) ||
      input.exactPayment.preparedBytes.byteLength === 0
    ) {
      throw new Error("staging recovery exact candidate context is invalid");
    }
  }
}

function exactRequirement(
  input: Readonly<StagingRecoveryPreparationContext>,
  floor: "accepted" | "depth-confirmed"
): { requiredFinality: "accepted" | "confirmed" } {
  const header = strictAscii(input.paymentRequirements, "PAYMENT-REQUIRED");
  const parsed = parsePaymentRequiredHeaderValue(header, {
    supportedNetworks: [NETWORK],
    supportedSchemes: [SCHEME],
  });
  const accepted = parsed.accepted;
  const requiredFinality = accepted.extra.finality;
  if (
    accepted.scheme !== SCHEME ||
    accepted.network !== NETWORK ||
    accepted.asset !== ASSET ||
    accepted.amount !== input.terms.amountAtomic ||
    accepted.payTo !== input.terms.payTo ||
    accepted.extra.paymentOutputIndex !== 1 ||
    (requiredFinality !== "mempool" &&
      requiredFinality !== "accepted" &&
      requiredFinality !== "confirmed")
  ) {
    throw new Error("staging recovery payment requirements differ from Checkout Terms");
  }
  return {
    requiredFinality:
      floor === "depth-confirmed" || requiredFinality === "confirmed"
        ? "confirmed"
        : "accepted",
  };
}

function exactCandidate(
  input: Readonly<StagingRecoveryPreparationContext>
): ImmutableExactPaymentCandidate {
  const prepared = input.exactPayment;
  if (!prepared) throw new Error("exact payment candidate is unavailable");
  const text = strictUtf8(prepared.preparedBytes, "exact payment envelope");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("exact payment envelope is malformed", { cause });
  }
  if (!isRecord(value) || !exactKeys(value, ["paymentPayload", "paymentRequired", "transactionId"])) {
    throw new Error("exact payment envelope has unknown fields");
  }
  if (stableStringify(value) !== text || value.transactionId !== prepared.transactionId) {
    throw new Error("exact payment envelope changed its immutable transaction identity");
  }
  const required = validatePaymentRequired(value.paymentRequired);
  const payload = validatePaymentPayload(value.paymentPayload);
  if (!required.ok || !payload.ok) {
    throw new Error("exact payment envelope contains invalid x402 artifacts");
  }
  const retry = validatePaymentRetry({
    paymentRequired: required.value,
    paymentPayload: payload.value,
  });
  if (!retry.ok || payload.value.payload.type !== "exact-transaction") {
    throw new Error("exact payment envelope is not a valid immutable retry");
  }
  if (
    payload.value.payload.transactionEncoding !== ABANDONED_STAGING_RECOVERY_ENCODING ||
    payload.value.payload.paymentOutputIndex !== 0
  ) {
    throw new Error("exact payment envelope is outside the pinned transaction profile");
  }
  const profile = payload.value.accepted.extra.profile;
  if (profile !== "standard-native" && profile !== "additive") {
    throw new Error("exact payment envelope has an unsupported alpha.8 profile");
  }
  return Object.freeze({
    profile,
    transaction: payload.value.payload.transaction,
    transactionEncoding: ABANDONED_STAGING_RECOVERY_ENCODING,
    transactionId: prepared.transactionId,
    merchantOutputIndex: 0 as const,
  });
}

function parseOutpoint(value: string): { txid: string; index: number } {
  const match = /^([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(value);
  if (!match || BigInt(match[2]) > 0xffff_ffffn) {
    throw new Error("staging recovery source outpoint is invalid");
  }
  return { txid: match[1], index: Number(match[2]) };
}

function strictAscii(bytes: Uint8Array, label: string): string {
  const text = strictUtf8(bytes, label);
  if (!/^[\x21-\x7e]+$/.test(text)) throw new Error(`${label} is not a strict header artifact`);
  return text;
}

function strictUtf8(bytes: Uint8Array, label: string): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`${label} bytes are invalid`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${label} is not UTF-8`, { cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}
