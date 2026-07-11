import type {
  ExactTransactionPaymentRequest,
  ExactTransactionPaymentResult,
  FundingProvider,
  FundingProviderUtxo,
} from "@kaspa-x402/client";
import { stableStringify } from "@kaspa-x402/core";

import { assertPurchaseId } from "../../purchase/identity.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import type {
  ExactAttemptFundingBridge,
  ExactAttemptFundingContext,
} from "./exact-payment-module.js";
import {
  Kip10ExactTransactionBuilder,
  SOMPI_EXACT_FEE_POLICY,
  type ObservedStagingOutput,
} from "./exact-transaction-builder.js";
import { stagingKeyReference } from "./staging-key-store.js";
import {
  TreasuryStagingMetadataSource,
  type TreasuryStagingMetadata,
} from "./vault-treasury-staging.js";
import { VaultTreasuryFundingProvider } from "./vault-treasury-funding-provider.js";

const NETWORK = "kaspa:testnet-10" as const;
const FUNDING_SOURCE = "vault-treasury" as const;
const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const PAYMENT_IDENTIFIER = /^pay_[A-Za-z0-9_-]{43}$/;
const SERIALIZED_V0_SCRIPT = /^0000(?:[a-f0-9]{2})+$/;
const UINT64_MAX = (1n << 64n) - 1n;

export interface JournalObservedStagingQuery {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly evidenceDigest: Sha256Digest;
}

/**
 * Public facts from the Purchase Journal's verified Treasury-staging evidence.
 * Implementations must not perform wallet UTXO selection or return an
 * unjournaled chain candidate.
 */
export interface JournalObservedStaging {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly transactionId: string;
  readonly outpoint: string;
  readonly amountAtomic: string;
  readonly address: string;
  readonly scriptPublicKey: string;
  readonly blockDaaScore: string;
  readonly evidenceDigest: Sha256Digest;
}

export interface JournalObservedStagingSource {
  read(
    query: Readonly<JournalObservedStagingQuery>
  ): JournalObservedStaging | Promise<JournalObservedStaging>;
}

export interface VaultExactAttemptFundingBridgeOptions {
  readonly metadataSource: TreasuryStagingMetadataSource;
  readonly observedStagingSource: JournalObservedStagingSource;
  readonly builder: Kip10ExactTransactionBuilder;
}

export class ExactAttemptFundingBridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExactAttemptFundingBridgeError";
  }
}

/**
 * Creates one context-bound alpha.6 provider for one exact preparation.
 * Submission and recovery never call this bridge and therefore receive no
 * route to the attempt-scoped staging key.
 */
export class VaultExactAttemptFundingBridge implements ExactAttemptFundingBridge {
  private readonly metadataSource: TreasuryStagingMetadataSource;
  private readonly observedStagingSource: JournalObservedStagingSource;
  private readonly builder: Kip10ExactTransactionBuilder;

  constructor(options: VaultExactAttemptFundingBridgeOptions) {
    if (
      !options?.metadataSource ||
      typeof options.metadataSource.read !== "function" ||
      !options.observedStagingSource ||
      typeof options.observedStagingSource.read !== "function" ||
      !options.builder ||
      typeof options.builder.build !== "function"
    ) {
      throw new ExactAttemptFundingBridgeError(
        "staging metadata, observed staging, and exact builder dependencies are required"
      );
    }
    this.metadataSource = options.metadataSource;
    this.observedStagingSource = options.observedStagingSource;
    this.builder = options.builder;
  }

  async createProvider(
    context: Readonly<ExactAttemptFundingContext>
  ): Promise<FundingProvider> {
    const normalized = normalizeContext(context);
    const query = Object.freeze({
      purchaseId: normalized.purchaseId,
      paymentIdentifier: normalized.paymentIdentifier,
    });
    const [metadata, observed] = await Promise.all([
      this.metadataSource.read(query),
      this.observedStagingSource.read({
        ...query,
        evidenceDigest: normalized.staging.evidenceDigest,
      }),
    ]);
    const staging = validateJoinedStaging(normalized, metadata, observed);
    const stagingFee = atomic(
      metadata.stagingFeeAtomic,
      "canonical vault staging fee"
    );
    const ceiling = atomic(
      normalized.additionalCostCeilingAtomic,
      "exact additional-cost ceiling"
    );
    if (metadata.additionalCostCeilingAtomic !== ceiling.toString()) {
      throw new ExactAttemptFundingBridgeError(
        "exact preparation ceiling differs from the canonical staging envelope"
      );
    }
    if (
      metadata.priceAtomic !== normalized.amountAtomic ||
      metadata.exactFeeAtomic !== SOMPI_EXACT_FEE_POLICY.feeSompi
    ) {
      throw new ExactAttemptFundingBridgeError(
        "canonical staging cost facts differ from the exact Payment Attempt"
      );
    }

    let builtRequest: string | undefined;
    let builtResult: ExactTransactionPaymentResult | undefined;
    return new VaultTreasuryFundingProvider({
      getPublicIdentity: async () => ({
        address: metadata.address,
        publicKey: metadata.publicKey,
      }),
      getVirtualDaaScore: async () => staging.blockDaaScore,
      getUtxos: async (addresses) => observedUtxos(addresses, staging),
      estimateFees: async (request) => {
        if (request.network !== NETWORK || request.action !== "exact") {
          throw new ExactAttemptFundingBridgeError(
            "attempt provider only estimates pinned testnet exact fees"
          );
        }
        return { feeSompi: SOMPI_EXACT_FEE_POLICY.feeSompi };
      },
      buildExactTransactionDurably: async (request) => {
        assertRequestContext(request, normalized, metadata, stagingFee, ceiling);
        const canonicalRequest = stableStringify(request);
        if (builtRequest !== undefined) {
          if (builtRequest !== canonicalRequest || !builtResult) {
            throw new ExactAttemptFundingBridgeError(
              "attempt provider cannot be rebound to different exact requirements"
            );
          }
          return structuredClone(builtResult);
        }
        const result = await this.builder.build({
          purchaseId: normalized.purchaseId,
          paymentIdentifier: normalized.paymentIdentifier,
          request,
          staging,
          additionalCostCeilingAtomic: ceiling.toString(),
          stagingTransactionFeeAtomic: stagingFee.toString(),
        });
        builtRequest = canonicalRequest;
        builtResult = structuredClone(result);
        return structuredClone(result);
      },
    });
  }
}

interface NormalizedContext extends ExactAttemptFundingContext {
  readonly additionalCostCeilingAtomic: string;
}

function normalizeContext(
  context: Readonly<ExactAttemptFundingContext>
): NormalizedContext {
  if (!context || typeof context !== "object" || context.purpose !== "prepare") {
    throw new ExactAttemptFundingBridgeError(
      "attempt funding provider may only be created for exact preparation"
    );
  }
  let purchaseId: PurchaseId;
  try {
    purchaseId = assertPurchaseId(context.purchaseId);
  } catch (error) {
    throw new ExactAttemptFundingBridgeError("attempt Purchase identity is invalid", {
      cause: error,
    });
  }
  if (!PAYMENT_IDENTIFIER.test(context.paymentIdentifier)) {
    throw new ExactAttemptFundingBridgeError("attempt Payment identity is invalid");
  }
  if (!HASH32.test(context.requestHash)) {
    throw new ExactAttemptFundingBridgeError("attempt request hash is invalid");
  }
  const amount = atomic(context.amountAtomic, "attempt Merchant price", true);
  if (typeof context.payTo !== "string" || context.payTo.length === 0 || context.payTo.length > 500) {
    throw new ExactAttemptFundingBridgeError("attempt payee is invalid");
  }
  if (context.additionalCostCeilingAtomic === undefined) {
    throw new ExactAttemptFundingBridgeError(
      "exact preparation requires the full authorized additional-cost ceiling"
    );
  }
  const ceiling = atomic(
    context.additionalCostCeilingAtomic,
    "attempt additional-cost ceiling"
  );
  const staging = context.staging;
  if (
    !staging ||
    !HASH32.test(staging.transactionId) ||
    staging.outpoint !== `${staging.transactionId}:0` ||
    atomic(staging.amountAtomic, "journal-observed staging amount", true) <= 0n ||
    !DIGEST.test(staging.evidenceDigest) ||
    staging.fundingSource !== FUNDING_SOURCE
  ) {
    throw new ExactAttemptFundingBridgeError(
      "attempt staging context is not a journal-observed vault output"
    );
  }
  checkedAdd(amount, ceiling, "attempt authorized gross outflow");
  return Object.freeze({
    ...context,
    purchaseId,
    amountAtomic: amount.toString(),
    additionalCostCeilingAtomic: ceiling.toString(),
    staging: Object.freeze({ ...staging }),
  });
}

function validateJoinedStaging(
  context: NormalizedContext,
  metadata: TreasuryStagingMetadata,
  observed: JournalObservedStaging
): ObservedStagingOutput {
  const deterministicReference = stagingKeyReference({
    purchaseId: context.purchaseId,
    paymentIdentifier: context.paymentIdentifier,
  });
  const exact: ReadonlyArray<[string, unknown, unknown]> = [
    ["metadata Purchase", metadata.purchaseId, context.purchaseId],
    ["metadata Payment", metadata.paymentIdentifier, context.paymentIdentifier],
    ["metadata transaction", metadata.transactionId, context.staging.transactionId],
    ["metadata outpoint", metadata.outpoint, context.staging.outpoint],
    ["metadata amount", metadata.stagingAmountAtomic, context.staging.amountAtomic],
    ["metadata key reference", metadata.keyReference, deterministicReference],
    ["observed Purchase", observed.purchaseId, context.purchaseId],
    ["observed Payment", observed.paymentIdentifier, context.paymentIdentifier],
    ["observed transaction", observed.transactionId, context.staging.transactionId],
    ["observed outpoint", observed.outpoint, context.staging.outpoint],
    ["observed amount", observed.amountAtomic, context.staging.amountAtomic],
    ["observed evidence", observed.evidenceDigest, context.staging.evidenceDigest],
    ["observed address", observed.address, metadata.address],
    ["observed script", observed.scriptPublicKey, metadata.scriptPublicKey],
  ];
  for (const [field, actual, expected] of exact) {
    if (actual !== expected) {
      throw new ExactAttemptFundingBridgeError(
        `${field} differs across the canonical envelope and journal observation`
      );
    }
  }
  if (!DIGEST.test(metadata.envelopeDigest)) {
    throw new ExactAttemptFundingBridgeError("canonical staging envelope digest is invalid");
  }
  if (!SERIALIZED_V0_SCRIPT.test(observed.scriptPublicKey)) {
    throw new ExactAttemptFundingBridgeError(
      "journal-observed staging script is not a canonical version-0 script"
    );
  }
  const outpoint = parseOutpoint(observed.outpoint);
  const amountAtomic = atomic(
    observed.amountAtomic,
    "journal-observed staging amount",
    true
  ).toString();
  const blockDaaScore = atomic(
    observed.blockDaaScore,
    "journal-observed staging DAA score"
  ).toString();
  return Object.freeze({
    outpoint: Object.freeze(outpoint),
    amountAtomic,
    scriptPublicKey: observed.scriptPublicKey,
    address: observed.address,
    blockDaaScore,
    keyReference: deterministicReference,
  });
}

function assertRequestContext(
  request: Readonly<ExactTransactionPaymentRequest>,
  context: NormalizedContext,
  metadata: TreasuryStagingMetadata,
  stagingFee: bigint,
  ceiling: bigint
): void {
  if (
    request.network !== NETWORK ||
    request.fundingSource !== FUNDING_SOURCE ||
    request.amount !== context.amountAtomic ||
    request.payTo !== context.payTo ||
    request.requestHash?.toLowerCase() !== context.requestHash ||
    metadata.additiveThresholdAtomic !== request.reservation.additiveThresholdSompi
  ) {
    throw new ExactAttemptFundingBridgeError(
      "alpha.6 exact request is not bound to the prepared Purchase context"
    );
  }
  const threshold = atomic(
    request.reservation.additiveThresholdSompi,
    "KIP-10 additive threshold"
  );
  const exactFee = atomic(SOMPI_EXACT_FEE_POLICY.feeSompi, "pinned exact fee");
  const actualAdditionalCost = checkedAdd(
    checkedAdd(threshold, exactFee, "threshold and exact fee"),
    stagingFee,
    "complete exact additional cost"
  );
  if (actualAdditionalCost > ceiling) {
    throw new ExactAttemptFundingBridgeError(
      "complete exact additional cost exceeds its Purchase authorization"
    );
  }
}

function observedUtxos(
  addresses: readonly string[],
  staging: ObservedStagingOutput
): FundingProviderUtxo[] {
  if (
    addresses.length !== 1 ||
    addresses[0] !== staging.address
  ) {
    throw new ExactAttemptFundingBridgeError(
      "attempt provider may query only its journal-observed staging address"
    );
  }
  return [
    {
      outpoint: { ...staging.outpoint },
      amount: staging.amountAtomic,
      scriptPublicKey: staging.scriptPublicKey,
      address: staging.address,
    },
  ];
}

function parseOutpoint(value: string): { txid: string; index: number } {
  const match = /^([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(value);
  if (!match) throw new ExactAttemptFundingBridgeError("observed staging outpoint is invalid");
  const index = BigInt(match[2]);
  if (index > 0xffff_ffffn) {
    throw new ExactAttemptFundingBridgeError("observed staging outpoint index exceeds uint32");
  }
  return { txid: match[1], index: Number(index) };
}

function atomic(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ExactAttemptFundingBridgeError(
      `${label} must be a canonical atomic-unit integer`
    );
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new ExactAttemptFundingBridgeError(`${label} is outside uint64`);
  }
  return parsed;
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  const total = left + right;
  if (total > UINT64_MAX) {
    throw new ExactAttemptFundingBridgeError(`${label} exceeds uint64`);
  }
  return total;
}
