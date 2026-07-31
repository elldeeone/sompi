import {
  parsePaymentRequiredHeaderValue,
} from "@kaspa-x402/client";
import { stableStringify, type ExactPaymentRequirements } from "@kaspa-x402/core";

import {
  Transaction,
  addressFromScriptPublicKey,
} from "../../kaspa-wasm.js";
import { assertPurchaseId, evidenceDigest } from "../../purchase/identity.js";
import type {
  VerifiedArtifact,
} from "../../purchase/coordinator.js";
import {
  TreasuryStagingCapacityError,
  type PreparedTreasuryStaging,
  type TreasuryStagingCapacityAdapter,
  type TreasuryStagingCapacityInput,
  type TreasuryStagingCapacityQuote,
  type TreasuryStagingAdapterContext,
  type TreasuryStagingRecoveryObservation,
  type TreasuryStagingResult,
  type TreasuryStagingSubmissionResult,
} from "../../treasury/purchase-staging.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import {
  VaultPreparationError,
  type ObservedVaultSpend,
  type PreparedVaultSpend,
  type VaultManager,
} from "../../vault.js";
import type { KaspaWallet } from "../../wallet.js";
import type {
  ChainEvidenceObservation,
  ChainEvidenceRequest,
} from "../../chain-evidence/types.js";
import { serializeScriptPublicKey } from "./address-codec.js";
import type { TreasuryStagingDriver } from "./exact-payment-module.js";
import { SOMPI_EXACT_FEE_POLICY } from "./exact-transaction-builder.js";
import {
  StagingKeyStore,
  stagingKeyReference,
  type StagingKeyRecord,
} from "./staging-key-store.js";

const PROFILE = "urn:sompi:kaspa-x402:treasury-staging:1" as const;
const OBSERVATION_PROFILE = "urn:sompi:kaspa-x402:treasury-staging-observation:1" as const;
const OBSERVATION_MEDIA_TYPE =
  "application/vnd.sompi.kaspa-x402.treasury-staging-observation+json";
const VERIFIER_ID = "sompi:vault-treasury:testnet-10:v1";
const NETWORK = "kaspa:testnet-10" as const;
const FUNDING_SOURCE = "vault-treasury" as const;
const MAX_ENVELOPE_BYTES = 2_000_000;
const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const PAYMENT_IDENTIFIER = /^pay_[A-Za-z0-9_-]{43}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export const TREASURY_STAGING_ENVELOPE_PROFILE = PROFILE;
export const TREASURY_STAGING_OBSERVATION_PROFILE = OBSERVATION_PROFILE;
export const TREASURY_STAGING_OBSERVATION_MEDIA_TYPE = OBSERVATION_MEDIA_TYPE;
export const TREASURY_STAGING_OBSERVATION_VERIFIER_ID = VERIFIER_ID;

type PrepareInput = Parameters<TreasuryStagingDriver["prepare"]>[0];
type SubmitInput = Parameters<TreasuryStagingDriver["submit"]>[0];
type ObserveInput = Parameters<TreasuryStagingDriver["observe"]>[0];

export interface VaultTreasuryStagingEnvelope {
  readonly version: 1;
  readonly profile: typeof PROFILE;
  readonly binding: {
    readonly purchaseId: PurchaseId;
    readonly paymentIdentifier: string;
    readonly checkoutDigest: Sha256Digest;
    readonly authorizationEvidenceDigest: Sha256Digest;
    readonly requestFingerprint: Sha256Digest;
    readonly paymentRequirementsDigest: Sha256Digest;
    readonly merchantId: string;
    readonly resourceFingerprint: Sha256Digest;
    readonly priceAtomic: string;
    readonly asset: "KAS";
    readonly network: typeof NETWORK;
    readonly payTo: string;
    readonly additionalCostCeilingAtomic: string;
    readonly exactProfile: "standard-native" | "additive";
    readonly additiveThresholdAtomic: string;
    readonly exactFeeAtomic: string;
  };
  /** Public recovery metadata only. Secret key material is never journaled. */
  readonly stagingKey: {
    readonly keyReference: string;
    readonly network: typeof NETWORK;
    readonly address: string;
    readonly publicKey: string;
    readonly scriptPublicKey: string;
    readonly createdAt: string;
  };
  readonly spend: {
    readonly transaction: string;
    readonly transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
    readonly transactionId: string;
    readonly destination: string;
    readonly destinationOutpoint: { readonly txid: string; readonly index: 0 };
    readonly amountAtomic: string;
    readonly feeAtomic: string;
    readonly continuationOutpoint: { readonly txid: string; readonly index: 1 };
    readonly continuationAddress: string;
    readonly continuationAmountAtomic: string;
    readonly covenantId: string;
    readonly baseConfigDigest: string;
    readonly configUpdate: {
      readonly windowStartDaa: string;
      readonly spentInWindowSompi: string;
      readonly address: string;
      readonly currentOutpoint: { readonly txid: string; readonly index: 1 };
    };
  };
}

export interface TreasuryStagingMetadataQuery {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
}

/** Public facts independently recovered from the canonical signed envelope. */
export interface TreasuryStagingMetadata extends TreasuryStagingMetadataQuery {
  readonly envelopeDigest: Sha256Digest;
  readonly paymentRequirementsDigest: Sha256Digest;
  readonly priceAtomic: string;
  readonly additionalCostCeilingAtomic: string;
  readonly additiveThresholdAtomic: string;
  readonly exactFeeAtomic: string;
  readonly transactionId: string;
  readonly outpoint: string;
  readonly stagingAmountAtomic: string;
  readonly stagingFeeAtomic: string;
  readonly keyReference: string;
  readonly address: string;
  readonly publicKey: string;
  readonly scriptPublicKey: string;
}

export interface TreasuryStagingMetadataSource {
  read(query: Readonly<TreasuryStagingMetadataQuery>): Promise<TreasuryStagingMetadata>;
}

export interface TreasuryStagingObservationEvidenceFacts
  extends TreasuryStagingMetadataQuery {
  readonly profile: typeof OBSERVATION_PROFILE;
  readonly envelopeDigest: Sha256Digest;
  readonly transactionId: string;
  readonly stagingOutpoint: string;
  readonly stagingAmountAtomic: string;
  readonly stagingFeeAtomic: string;
  readonly stagingAddress: string;
  readonly stagingScriptPublicKey: string;
  readonly keyReference: string;
  readonly continuationOutpoint: string;
  readonly continuationAmountAtomic: string;
  readonly observedAtDaa: string;
  readonly chainEvidenceDigest: Sha256Digest;
  readonly chainEvidenceLevel: "accepted" | "depth-confirmed" | "consensus-final";
  readonly fundingSource: typeof FUNDING_SOURCE;
}

export interface CanonicalTreasuryStagingMetadataSourceOptions {
  readPreparedEnvelope(
    query: Readonly<TreasuryStagingMetadataQuery>
  ): Uint8Array | Promise<Uint8Array>;
}

/**
 * Shared staging-fee/key-reference source for exact preparation and Settlement
 * verification. Its reader may be backed by the Purchase Journal, but raw
 * journal records do not cross this interface.
 */
export class CanonicalTreasuryStagingMetadataSource
  implements TreasuryStagingMetadataSource
{
  private readonly readPreparedEnvelope: CanonicalTreasuryStagingMetadataSourceOptions["readPreparedEnvelope"];

  constructor(options: CanonicalTreasuryStagingMetadataSourceOptions) {
    if (!options || typeof options.readPreparedEnvelope !== "function") {
      throw new VaultTreasuryStagingError("canonical staging envelope reader is required");
    }
    this.readPreparedEnvelope = options.readPreparedEnvelope;
  }

  async read(
    query: Readonly<TreasuryStagingMetadataQuery>
  ): Promise<TreasuryStagingMetadata> {
    const normalized = normalizeQuery(query);
    const bytes = Uint8Array.from(await this.readPreparedEnvelope(normalized));
    const envelope = decodeVaultTreasuryStagingEnvelope(bytes, normalized);
    return metadataFromEnvelope(envelope, bytes);
  }
}

export interface VaultTreasuryStagingOptions {
  readonly vault: VaultManager;
  readonly wallet: KaspaWallet;
  readonly keyStore: StagingKeyStore;
  readonly chainEvidence: StagingChainEvidence;
}

export interface StagingChainEvidence {
  observe(
    request: Readonly<ChainEvidenceRequest>
  ): Promise<ChainEvidenceObservation>;
}

export class VaultTreasuryStagingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultTreasuryStagingError";
  }
}

/** Concrete durable Treasury staging adapter for the exact-only profile. */
export class VaultTreasuryStaging
  implements TreasuryStagingDriver, TreasuryStagingCapacityAdapter
{
  private readonly vault: VaultManager;
  private readonly wallet: KaspaWallet;
  private readonly keyStore: StagingKeyStore;
  private readonly chainEvidence: StagingChainEvidence;

  constructor(options: VaultTreasuryStagingOptions) {
    if (!options?.vault || !options.wallet || !options.keyStore || typeof options.chainEvidence?.observe !== "function") {
      throw new VaultTreasuryStagingError(
        "vault, wallet, and staging key store are required"
      );
    }
    this.vault = options.vault;
    this.wallet = options.wallet;
    this.keyStore = options.keyStore;
    this.chainEvidence = options.chainEvidence;
  }

  async quoteStagingCapacity(
    input: Readonly<TreasuryStagingCapacityInput>,
  ): Promise<TreasuryStagingCapacityQuote> {
    const price = atomic(input.amountAtomic, "Merchant price", true);
    const ceiling = atomic(
      input.additionalCostCeilingAtomic,
      "additional-cost ceiling",
    );
    const exactFee = atomic(
      SOMPI_EXACT_FEE_POLICY.feeSompi,
      "pinned exact fee",
    );
    if (exactFee > ceiling) {
      return Object.freeze({
        ready: false,
        blockerCode: "vault_fee_exceeds_ceiling",
      });
    }
    try {
      await this.vault.quoteSend(
        this.wallet,
        this.wallet.address,
        checkedAdd(price, exactFee, "price and bounded exact fee"),
        ceiling - exactFee,
      );
      return Object.freeze({ ready: true });
    } catch (error) {
      if (error instanceof VaultPreparationError) {
        return Object.freeze({
          ready: false,
          blockerCode: capacityBlockerCode(error),
        });
      }
      return Object.freeze({
        ready: false,
        blockerCode: "vault_unavailable",
      });
    }
  }

  async prepare(input: Readonly<PrepareInput>): Promise<PreparedTreasuryStaging> {
    const facts = preparationFacts(input);
    const key = this.keyStore.create({
      purchaseId: facts.purchaseId,
      paymentIdentifier: facts.paymentIdentifier,
    });
    if (
      key.keyReference !==
      stagingKeyReference({
        purchaseId: facts.purchaseId,
        paymentIdentifier: facts.paymentIdentifier,
      })
    ) {
      throw new VaultTreasuryStagingError(
        "staging key reference is not deterministic for this Payment Attempt"
      );
    }

    let prepared: PreparedVaultSpend;
    try {
      prepared = await this.prepareWithinCeiling(key, facts);
    } catch (error) {
      if (error instanceof VaultPreparationError) {
        try {
          this.keyStore.delete(key);
        } catch (cleanupError) {
          throw new TreasuryStagingCapacityError(
            "Kaspa-x402 staging capacity changed and its unused key could not be removed",
            { cause: cleanupError },
          );
        }
        throw new TreasuryStagingCapacityError(
          "Kaspa-x402 staging capacity changed before preparation",
          { cause: error },
        );
      }
      throw error;
    }
    const envelope = envelopeFromPrepared(facts, key, prepared);
    const preparedBytes = Buffer.from(stableStringify(envelope), "utf8");
    const decoded = decodeVaultTreasuryStagingEnvelope(preparedBytes, {
      purchaseId: facts.purchaseId,
      paymentIdentifier: facts.paymentIdentifier,
    });
    const metadata = metadataFromEnvelope(decoded, preparedBytes);
    if (
      metadata.stagingAmountAtomic !== prepared.amountSompi.toString() ||
      metadata.stagingFeeAtomic !== prepared.feeSompi.toString()
    ) {
      throw new VaultTreasuryStagingError(
        "canonical staging envelope changed the final prepared vault spend"
      );
    }
    return Object.freeze({
      preparedBytes: Uint8Array.from(preparedBytes),
      preparedDigest: metadata.envelopeDigest,
      transactionId: metadata.transactionId,
      expectedOutpoint: metadata.outpoint,
      stagingAmountAtomic: metadata.stagingAmountAtomic,
      fundingSource: FUNDING_SOURCE,
    });
  }

  async submit(
    input: Readonly<SubmitInput>
  ): Promise<TreasuryStagingSubmissionResult> {
    if (input.signal.aborted) throw abortError(input.signal);
    const decoded = decodeForContext(input.context);
    const prepared = preparedVaultSpendFromEnvelope(decoded);

    // An observed immutable transaction is recovery, not permission to submit
    // another transaction. This is also safe after an accepted-but-lost RPC
    // response when the outputs have already entered the UTXO set.
    const existing = await this.acceptedObservation(decoded, prepared, input.signal);
    if (existing) {
      return {
        status: "staged",
        submissionDigest: submissionDigest(prepared.transactionId),
        staging: this.commitAndEvidence(decoded, prepared, existing),
      };
    }
    if (input.signal.aborted) throw abortError(input.signal);
    const submitted = await this.vault.submitPreparedSend(this.wallet, prepared);
    if (submitted.transactionId !== prepared.transactionId) {
      throw new VaultTreasuryStagingError(
        "vault staging submission returned a different transaction identity"
      );
    }
    const observed = await this.acceptedObservation(decoded, prepared, input.signal);
    if (!observed) {
      return {
        status: "submitted",
        submissionDigest: submissionDigest(prepared.transactionId),
      };
    }
    return {
      status: "staged",
      submissionDigest: submissionDigest(prepared.transactionId),
      staging: this.commitAndEvidence(decoded, prepared, observed),
    };
  }

  async observe(
    input: Readonly<ObserveInput>
  ): Promise<TreasuryStagingRecoveryObservation> {
    const decoded = decodeForContext(input.context);
    const prepared = preparedVaultSpendFromEnvelope(decoded);
    const observed = await this.acceptedObservation(decoded, prepared, new AbortController().signal);
    if (!observed) {
      return Object.freeze({
        status: "pending" as const,
        detailDigest: evidenceDigest(
          Buffer.from(
            stableStringify({
              profile: OBSERVATION_PROFILE,
              purchaseId: decoded.binding.purchaseId,
              paymentIdentifier: decoded.binding.paymentIdentifier,
              transactionId: prepared.transactionId,
              state: "not-yet-observed",
            }),
            "utf8"
          )
        ),
      });
    }
    return Object.freeze({
      status: "staged" as const,
      staging: this.commitAndEvidence(decoded, prepared, observed),
    });
  }

  private async acceptedObservation(
    decoded: VaultTreasuryStagingEnvelope,
    prepared: PreparedVaultSpend,
    signal: AbortSignal
  ): Promise<ObservedVaultSpend | undefined> {
    const outputs = transactionOutputs(prepared.transaction);
    const evidence = await this.chainEvidence.observe({
      operationId: `staging:${decoded.binding.paymentIdentifier}`,
      operation: "staging",
      network: "kaspa:testnet-10",
      transactionId: prepared.transactionId,
      expectedOutputs: [
        { index: 0, amountAtomic: prepared.amountSompi.toString(), scriptPublicKey: outputs[0], address: prepared.destination },
        { index: 1, amountAtomic: prepared.continuationAmountSompi.toString(), scriptPublicKey: outputs[1], address: prepared.continuationAddress, covenantId: prepared.covenantId },
      ],
      watchedAddresses: [prepared.destination, prepared.continuationAddress],
      mechanism: "native-covenant",
      protocolFinality: "accepted",
      signal,
    });
    if (evidence.interpretation !== "accepted") return undefined;
    const accepted = evidence.evidence;
    return Object.freeze({
      transactionId: prepared.transactionId,
      destinationOutpoint: prepared.destinationOutpoint,
      continuationOutpoint: prepared.continuationOutpoint,
      amountSompi: prepared.amountSompi,
      continuationAmountSompi: prepared.continuationAmountSompi,
      observedAtDaa: BigInt(accepted.acceptingBlockDaaScore),
      chainEvidenceDigest: accepted.detailDigest,
      chainEvidenceLevel: accepted.level as
        | "accepted"
        | "depth-confirmed"
        | "consensus-final",
    });
  }

  private async prepareWithinCeiling(
    key: StagingKeyRecord,
    facts: PreparationFacts
  ): Promise<PreparedVaultSpend> {
    const minimumExactFunding = checkedAdd(
      facts.price,
      facts.exactFee,
      "price and bounded exact fee"
    );
    const grossBound = checkedAdd(
      facts.price,
      facts.additionalCostCeiling,
      "authorized gross Treasury outflow"
    );
    if (minimumExactFunding > grossBound) {
      throw new VaultTreasuryStagingError(
        "authorized additional-cost ceiling cannot fund the exact fee"
      );
    }

    // `VaultManager.prepareSend` performs its own bounded fee-convergence
    // loop. Stage only the amount required by the immutable alpha.9 exact
    // transaction; an authorization ceiling is a bound, not spare value that
    // should be moved out of the vault into an ephemeral change address.
    const prepared = await this.vault.prepareSend(
      this.wallet,
      key.address,
      minimumExactFunding
    );
    if (
      prepared.destination !== key.address ||
      prepared.amountSompi !== minimumExactFunding ||
      prepared.destinationOutpoint.index !== 0
    ) {
      throw new VaultTreasuryStagingError(
        "vault prepared a staging output different from the exact required amount and public key"
      );
    }
    if (prepared.feeSompi < 0n || prepared.feeSompi > UINT64_MAX) {
      throw new VaultTreasuryStagingError("vault staging fee is invalid");
    }
    if (
      checkedAdd(
        minimumExactFunding,
        prepared.feeSompi,
        "final staging Treasury outflow"
      ) > grossBound
    ) {
      throw new VaultTreasuryStagingError(
        "actual vault staging fee exceeds the authorized additional-cost ceiling"
      );
    }
    return prepared;
  }

  private commitAndEvidence(
    envelope: VaultTreasuryStagingEnvelope,
    prepared: PreparedVaultSpend,
    observed: ObservedVaultSpend
  ): TreasuryStagingResult {
    this.vault.commitObservedSend(prepared, observed);
    const evidence = stagingObservationEvidence(envelope, prepared, observed);
    return Object.freeze({
      evidence,
      transactionId: prepared.transactionId,
      outpoint: `${prepared.transactionId}:0`,
      stagingAmountAtomic: prepared.amountSompi.toString(),
      fundingSource: FUNDING_SOURCE,
    });
  }
}

function capacityBlockerCode(
  error: VaultPreparationError,
): Exclude<TreasuryStagingCapacityQuote["blockerCode"], undefined> {
  switch (error.code) {
    case "insufficient_funds":
      return "vault_insufficient_funds";
    case "fee_exceeds_ceiling":
      return "vault_fee_exceeds_ceiling";
    case "invalid_runtime_state":
      return "vault_policy_capacity_unavailable";
    default:
      return "vault_unavailable";
  }
}

interface PreparationFacts {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly checkoutDigest: Sha256Digest;
  readonly authorizationEvidenceDigest: Sha256Digest;
  readonly requestFingerprint: Sha256Digest;
  readonly paymentRequirementsDigest: Sha256Digest;
  readonly merchantId: string;
  readonly resourceFingerprint: Sha256Digest;
  readonly price: bigint;
  readonly exactProfile: "standard-native" | "additive";
  readonly threshold: bigint;
  readonly exactFee: bigint;
  readonly additionalCostCeiling: bigint;
  readonly asset: "KAS";
  readonly network: typeof NETWORK;
  readonly payTo: string;
}

function preparationFacts(input: Readonly<PrepareInput>): PreparationFacts {
  if (!input || typeof input !== "object") {
    throw new VaultTreasuryStagingError("Treasury staging preparation is invalid");
  }
  const execution = input.execution;
  let purchaseId: PurchaseId;
  try {
    purchaseId = assertPurchaseId(execution.purchaseId);
  } catch (error) {
    throw new VaultTreasuryStagingError("Treasury staging Purchase identity is invalid", {
      cause: error,
    });
  }
  if (!PAYMENT_IDENTIFIER.test(execution.paymentIdentifier)) {
    throw new VaultTreasuryStagingError("Treasury staging Payment identity is invalid");
  }
  if (
    execution.terms.asset !== "KAS" ||
    execution.terms.network !== NETWORK ||
    execution.authorization.decision !== "approved" ||
    execution.authorization.purchaseId !== purchaseId ||
    execution.authorization.checkoutDigest !== execution.terms.checkoutDigest ||
    execution.authorization.facts.purchaseId !== purchaseId ||
    execution.authorization.facts.resourceFingerprint !==
      execution.terms.resourceFingerprint ||
    execution.authorization.facts.amountAtomic !== execution.terms.amountAtomic ||
    execution.authorization.facts.asset !== "KAS" ||
    execution.authorization.facts.network !== NETWORK ||
    execution.authorization.facts.payTo !== execution.terms.payTo ||
    execution.authorizationRequest.purchaseId !== purchaseId ||
    execution.authorizationRequest.terms.checkoutDigest !==
      execution.terms.checkoutDigest ||
    execution.authorizationRequest.additionalCostCeilingAtomic !==
      input.additionalCostCeilingAtomic ||
    input.request.requestFingerprint !== execution.terms.resourceFingerprint
  ) {
    throw new VaultTreasuryStagingError(
      "Treasury staging facts are not bound to the approved Purchase"
    );
  }
  requireDigest(execution.terms.checkoutDigest, "Checkout digest");
  requireDigest(execution.authorization.evidenceDigest, "authorization evidence digest");
  requireDigest(input.request.requestFingerprint, "request fingerprint");
  const price = atomic(execution.terms.amountAtomic, "Merchant price", true);
  const additionalCostCeiling = atomic(
    input.additionalCostCeilingAtomic,
    "additional-cost ceiling"
  );
  const parsed = parseExactRequirement(
    input.paymentRequirements,
    execution.paymentIdentifier
  );
  if (
    parsed.amount !== execution.terms.amountAtomic ||
    parsed.asset !== "KAS" ||
    parsed.network !== NETWORK ||
    parsed.payTo !== execution.terms.payTo
  ) {
    throw new VaultTreasuryStagingError(
      "exact payment requirements do not match approved Checkout Terms"
    );
  }
  const exactProfile = parsed.extra.profile;
  const threshold = exactProfile === "additive"
    ? atomic(parsed.extra.additiveThresholdSompi, "KIP-10 additive threshold")
    : 0n;
  const exactFee = atomic(SOMPI_EXACT_FEE_POLICY.feeSompi, "pinned exact fee");
  return Object.freeze({
    purchaseId,
    paymentIdentifier: execution.paymentIdentifier,
    checkoutDigest: execution.terms.checkoutDigest,
    authorizationEvidenceDigest: execution.authorization.evidenceDigest,
    requestFingerprint: input.request.requestFingerprint,
    paymentRequirementsDigest: evidenceDigest(input.paymentRequirements),
    merchantId: execution.terms.merchant.id,
    resourceFingerprint: execution.terms.resourceFingerprint,
    price,
    exactProfile,
    threshold,
    exactFee,
    additionalCostCeiling,
    asset: "KAS" as const,
    network: NETWORK,
    payTo: execution.terms.payTo,
  });
}

function parseExactRequirement(
  bytes: Uint8Array,
  paymentIdentifier: string
): ExactPaymentRequirements {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 32_768) {
    throw new VaultTreasuryStagingError("PAYMENT-REQUIRED artifact is empty or oversized");
  }
  const text = Buffer.from(bytes).toString("ascii");
  if (!Buffer.from(text, "ascii").equals(Buffer.from(bytes)) || text.trim() !== text) {
    throw new VaultTreasuryStagingError("PAYMENT-REQUIRED artifact is not canonical ASCII");
  }
  let parsed: ReturnType<typeof parsePaymentRequiredHeaderValue>;
  try {
    parsed = parsePaymentRequiredHeaderValue(text, {
      supportedNetworks: [NETWORK],
      supportedSchemes: ["exact"],
    });
  } catch (error) {
    throw new VaultTreasuryStagingError("PAYMENT-REQUIRED exact terms are invalid", {
      cause: error,
    });
  }
  const accepted = parsed.accepted;
  const extension = parsed.paymentRequired.extensions?.["payment-identifier"];
  if (
    accepted.scheme !== "exact" ||
    accepted.network !== NETWORK ||
    accepted.extra.binding !== "kaspa-exact-v2" ||
    (accepted.extra.profile !== "standard-native" && accepted.extra.profile !== "additive") ||
    (accepted.extra.profile === "additive" &&
      accepted.extra.templateId !== "kaspa-x402-kip10-additive-v1") ||
    accepted.extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    (extension !== undefined &&
      (!isRecord(extension) ||
        !isRecord(extension.info) ||
        (extension.info.id !== undefined && extension.info.id !== paymentIdentifier)))
  ) {
    throw new VaultTreasuryStagingError(
      "PAYMENT-REQUIRED is outside the pinned exact testnet profile"
    );
  }
  return accepted as ExactPaymentRequirements;
}

function envelopeFromPrepared(
  facts: PreparationFacts,
  key: StagingKeyRecord,
  prepared: PreparedVaultSpend
): VaultTreasuryStagingEnvelope {
  return Object.freeze({
    version: 1 as const,
    profile: PROFILE,
    binding: Object.freeze({
      purchaseId: facts.purchaseId,
      paymentIdentifier: facts.paymentIdentifier,
      checkoutDigest: facts.checkoutDigest,
      authorizationEvidenceDigest: facts.authorizationEvidenceDigest,
      requestFingerprint: facts.requestFingerprint,
      paymentRequirementsDigest: facts.paymentRequirementsDigest,
      merchantId: facts.merchantId,
      resourceFingerprint: facts.resourceFingerprint,
      priceAtomic: facts.price.toString(),
      asset: "KAS" as const,
      network: NETWORK,
      payTo: facts.payTo,
      additionalCostCeilingAtomic: facts.additionalCostCeiling.toString(),
      exactProfile: facts.exactProfile,
      additiveThresholdAtomic: facts.threshold.toString(),
      exactFeeAtomic: facts.exactFee.toString(),
    }),
    stagingKey: Object.freeze({
      keyReference: key.keyReference,
      network: NETWORK,
      address: key.address,
      publicKey: key.publicKey,
      scriptPublicKey: key.scriptPublicKey,
      createdAt: key.createdAt,
    }),
    spend: Object.freeze({
      transaction: prepared.transaction,
      transactionEncoding: prepared.transactionEncoding,
      transactionId: prepared.transactionId,
      destination: prepared.destination,
      destinationOutpoint: Object.freeze({ ...prepared.destinationOutpoint }),
      amountAtomic: prepared.amountSompi.toString(),
      feeAtomic: prepared.feeSompi.toString(),
      continuationOutpoint: Object.freeze({ ...prepared.continuationOutpoint }),
      continuationAddress: prepared.continuationAddress,
      continuationAmountAtomic: prepared.continuationAmountSompi.toString(),
      covenantId: prepared.covenantId,
      baseConfigDigest: prepared.baseConfigDigest,
      configUpdate: Object.freeze({
        ...prepared.configUpdate,
        currentOutpoint: Object.freeze({ ...prepared.configUpdate.currentOutpoint }),
      }),
    }),
  });
}

export function decodeVaultTreasuryStagingEnvelope(
  bytes: Uint8Array,
  expected?: Readonly<TreasuryStagingMetadataQuery>
): VaultTreasuryStagingEnvelope {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new VaultTreasuryStagingError("canonical staging envelope is empty or oversized");
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    throw new VaultTreasuryStagingError("canonical staging envelope is malformed", {
      cause: error,
    });
  }
  if (!isRecord(value) || stableStringify(value) !== text) {
    throw new VaultTreasuryStagingError("canonical staging envelope is not canonical JSON");
  }
  assertKeys(value, ["binding", "profile", "spend", "stagingKey", "version"], "staging envelope");
  if (value.version !== 1 || value.profile !== PROFILE) {
    throw new VaultTreasuryStagingError("canonical staging envelope profile is unsupported");
  }
  const binding = requireRecord(value.binding, "staging binding");
  assertKeys(binding, [
    "additionalCostCeilingAtomic",
    "additiveThresholdAtomic",
    "asset",
    "authorizationEvidenceDigest",
    "checkoutDigest",
    "exactFeeAtomic",
    "exactProfile",
    "merchantId",
    "network",
    "payTo",
    "paymentIdentifier",
    "paymentRequirementsDigest",
    "priceAtomic",
    "purchaseId",
    "requestFingerprint",
    "resourceFingerprint",
  ], "staging binding");
  const purchaseId = normalizeQuery({
    purchaseId: stringValue(binding.purchaseId, "Purchase identity") as PurchaseId,
    paymentIdentifier: stringValue(binding.paymentIdentifier, "Payment identity"),
  }).purchaseId;
  const paymentIdentifier = stringValue(binding.paymentIdentifier, "Payment identity");
  for (const [label, candidate] of [
    ["Checkout digest", binding.checkoutDigest],
    ["authorization evidence digest", binding.authorizationEvidenceDigest],
    ["request fingerprint", binding.requestFingerprint],
    ["payment requirements digest", binding.paymentRequirementsDigest],
    ["resource fingerprint", binding.resourceFingerprint],
  ] as const) requireDigest(candidate, label);
  if (
    binding.asset !== "KAS" ||
    binding.network !== NETWORK ||
    stringValue(binding.merchantId, "Merchant identity").length > 400 ||
    stringValue(binding.payTo, "payee").length > 500
  ) {
    throw new VaultTreasuryStagingError("staging binding is outside the pinned profile");
  }
  const price = atomic(binding.priceAtomic, "bound Merchant price", true);
  const ceiling = atomic(binding.additionalCostCeilingAtomic, "bound additional-cost ceiling");
  const threshold = atomic(binding.additiveThresholdAtomic, "bound KIP-10 threshold");
  if (
    (binding.exactProfile !== "standard-native" && binding.exactProfile !== "additive") ||
    (binding.exactProfile === "standard-native" && threshold !== 0n) ||
    (binding.exactProfile === "additive" && threshold === 0n)
  ) {
    throw new VaultTreasuryStagingError("staging exact profile and additive threshold disagree");
  }
  const exactFee = atomic(binding.exactFeeAtomic, "bound exact fee");
  if (exactFee.toString() !== SOMPI_EXACT_FEE_POLICY.feeSompi) {
    throw new VaultTreasuryStagingError("staging envelope exact fee policy changed");
  }

  const stagingKey = requireRecord(value.stagingKey, "public staging key metadata");
  assertKeys(stagingKey, [
    "address",
    "createdAt",
    "keyReference",
    "network",
    "publicKey",
    "scriptPublicKey",
  ], "public staging key metadata");
  if (stagingKey.network !== NETWORK) {
    throw new VaultTreasuryStagingError("public staging key has the wrong network");
  }
  const keyReference = stringValue(stagingKey.keyReference, "staging key reference");
  if (
    keyReference !== stagingKeyReference({ purchaseId, paymentIdentifier }) ||
    !/^[a-f0-9]{64}$/.test(stringValue(stagingKey.publicKey, "staging public key"))
  ) {
    throw new VaultTreasuryStagingError("public staging key is bound to different Purchase facts");
  }
  const createdAt = stringValue(stagingKey.createdAt, "staging key creation time");
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt) {
    throw new VaultTreasuryStagingError("staging key creation time is invalid");
  }
  const address = stringValue(stagingKey.address, "staging address");
  const scriptPublicKey = stringValue(stagingKey.scriptPublicKey, "staging script public key");

  const spend = requireRecord(value.spend, "prepared vault spend");
  assertKeys(spend, [
    "amountAtomic",
    "baseConfigDigest",
    "configUpdate",
    "continuationAddress",
    "continuationAmountAtomic",
    "continuationOutpoint",
    "covenantId",
    "destination",
    "destinationOutpoint",
    "feeAtomic",
    "transaction",
    "transactionEncoding",
    "transactionId",
  ], "prepared vault spend");
  const transactionId = hash32(spend.transactionId, "vault staging transaction ID");
  const destinationOutpoint = requireOutpoint(
    spend.destinationOutpoint,
    transactionId,
    0,
    "staging destination outpoint"
  );
  const continuationOutpoint = requireOutpoint(
    spend.continuationOutpoint,
    transactionId,
    1,
    "vault continuation outpoint"
  );
  const amount = atomic(spend.amountAtomic, "staging output amount", true);
  const fee = atomic(spend.feeAtomic, "staging transaction fee");
  const continuationAmount = atomic(
    spend.continuationAmountAtomic,
    "vault continuation amount",
    true
  );
  if (
    spend.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    spend.destination !== address ||
    stringValue(spend.destination, "staging destination") !== address ||
    !HASH32.test(stringValue(spend.covenantId, "vault covenant ID")) ||
    !DIGEST.test(stringValue(spend.baseConfigDigest, "base vault config digest"))
  ) {
    throw new VaultTreasuryStagingError("prepared vault spend metadata is invalid");
  }
  const configUpdate = requireRecord(spend.configUpdate, "vault config update");
  assertKeys(configUpdate, [
    "address",
    "currentOutpoint",
    "spentInWindowSompi",
    "windowStartDaa",
  ], "vault config update");
  atomic(configUpdate.windowStartDaa, "vault window start DAA");
  atomic(configUpdate.spentInWindowSompi, "vault spent-in-window amount");
  const continuationAddress = stringValue(
    spend.continuationAddress,
    "vault continuation address"
  );
  if (configUpdate.address !== continuationAddress) {
    throw new VaultTreasuryStagingError("vault continuation config address changed");
  }
  requireOutpoint(
    configUpdate.currentOutpoint,
    transactionId,
    1,
    "vault config continuation outpoint"
  );

  validateSignedVaultTransaction({
    transaction: stringValue(spend.transaction, "signed vault transaction"),
    transactionId,
    stagingAddress: address,
    stagingScriptPublicKey: scriptPublicKey,
    stagingAmount: amount,
    continuationAddress,
    continuationAmount,
    covenantId: stringValue(spend.covenantId, "vault covenant ID"),
    fee,
  });
  const gross = checkedAdd(amount, fee, "signed staging Treasury outflow");
  const grossBound = checkedAdd(price, ceiling, "bound staging Treasury outflow");
  const minimum = checkedAdd(
    price,
    exactFee,
    "bound exact price and fee"
  );
  if (gross > grossBound || amount < minimum) {
    throw new VaultTreasuryStagingError(
      "signed vault staging spend is outside its authorized exact-payment bounds"
    );
  }
  const change = amount - minimum;
  if (
    change > 0n &&
    change < BigInt(SOMPI_EXACT_FEE_POLICY.vaultChangeMinimumSompi)
  ) {
    throw new VaultTreasuryStagingError(
      "signed vault staging amount would create non-standard exact change"
    );
  }
  if (
    expected &&
    (expected.purchaseId !== purchaseId || expected.paymentIdentifier !== paymentIdentifier)
  ) {
    throw new VaultTreasuryStagingError(
      "canonical staging envelope belongs to a different Purchase or Payment Attempt"
    );
  }

  return Object.freeze({
    version: 1 as const,
    profile: PROFILE,
    binding: Object.freeze({
      purchaseId,
      paymentIdentifier,
      checkoutDigest: binding.checkoutDigest as Sha256Digest,
      authorizationEvidenceDigest: binding.authorizationEvidenceDigest as Sha256Digest,
      requestFingerprint: binding.requestFingerprint as Sha256Digest,
      paymentRequirementsDigest: binding.paymentRequirementsDigest as Sha256Digest,
      merchantId: binding.merchantId as string,
      resourceFingerprint: binding.resourceFingerprint as Sha256Digest,
      priceAtomic: price.toString(),
      asset: "KAS" as const,
      network: NETWORK,
      payTo: binding.payTo as string,
      additionalCostCeilingAtomic: ceiling.toString(),
      exactProfile: binding.exactProfile as "standard-native" | "additive",
      additiveThresholdAtomic: threshold.toString(),
      exactFeeAtomic: exactFee.toString(),
    }),
    stagingKey: Object.freeze({
      keyReference,
      network: NETWORK,
      address,
      publicKey: stagingKey.publicKey as string,
      scriptPublicKey,
      createdAt,
    }),
    spend: Object.freeze({
      transaction: spend.transaction as string,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
      transactionId,
      destination: address,
      destinationOutpoint,
      amountAtomic: amount.toString(),
      feeAtomic: fee.toString(),
      continuationOutpoint,
      continuationAddress,
      continuationAmountAtomic: continuationAmount.toString(),
      covenantId: spend.covenantId as string,
      baseConfigDigest: spend.baseConfigDigest as string,
      configUpdate: Object.freeze({
        windowStartDaa: configUpdate.windowStartDaa as string,
        spentInWindowSompi: configUpdate.spentInWindowSompi as string,
        address: continuationAddress,
        currentOutpoint: Object.freeze({ txid: transactionId, index: 1 as const }),
      }),
    }),
  });
}

/** Strict decoder for the public chain-observation evidence stored by the Journal. */
export function decodeTreasuryStagingObservationEvidence(
  bytes: Uint8Array,
  expected?: Readonly<TreasuryStagingMetadataQuery>
): TreasuryStagingObservationEvidenceFacts {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 64_000) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation evidence is empty or oversized"
    );
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation evidence is malformed",
      { cause: error }
    );
  }
  if (!isRecord(value) || stableStringify(value) !== text) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation evidence is not canonical JSON"
    );
  }
  assertKeys(value, [
    "chainEvidenceDigest",
    "chainEvidenceLevel",
    "continuationAmountAtomic",
    "continuationOutpoint",
    "envelopeDigest",
    "fundingSource",
    "keyReference",
    "observedAtDaa",
    "paymentIdentifier",
    "profile",
    "purchaseId",
    "stagingAddress",
    "stagingAmountAtomic",
    "stagingFeeAtomic",
    "stagingOutpoint",
    "stagingScriptPublicKey",
    "transactionId",
  ], "Treasury staging observation evidence");
  if (value.profile !== OBSERVATION_PROFILE || value.fundingSource !== FUNDING_SOURCE) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation evidence profile is unsupported"
    );
  }
  const query = normalizeQuery({
    purchaseId: stringValue(value.purchaseId, "observed staging Purchase identity") as PurchaseId,
    paymentIdentifier: stringValue(value.paymentIdentifier, "observed staging Payment identity"),
  });
  const transactionId = hash32(value.transactionId, "observed staging transaction ID");
  const stagingOutpoint = stringValue(value.stagingOutpoint, "observed staging outpoint");
  const continuationOutpoint = stringValue(
    value.continuationOutpoint,
    "observed vault continuation outpoint"
  );
  if (
    stagingOutpoint !== `${transactionId}:0` ||
    continuationOutpoint !== `${transactionId}:1`
  ) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation outpoints changed"
    );
  }
  requireDigest(value.envelopeDigest, "observed staging envelope digest");
  requireDigest(value.chainEvidenceDigest, "observed staging Chain Evidence digest");
  if (!["accepted", "depth-confirmed", "consensus-final"].includes(String(value.chainEvidenceLevel))) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation finality is not accepted Chain Evidence"
    );
  }
  const stagingAmountAtomic = atomic(
    value.stagingAmountAtomic,
    "observed staging amount",
    true
  ).toString();
  const stagingFeeAtomic = atomic(
    value.stagingFeeAtomic,
    "observed staging fee"
  ).toString();
  const continuationAmountAtomic = atomic(
    value.continuationAmountAtomic,
    "observed continuation amount",
    true
  ).toString();
  const observedAtDaa = atomic(
    value.observedAtDaa,
    "observed staging DAA score"
  ).toString();
  const keyReference = stringValue(value.keyReference, "observed staging key reference");
  if (keyReference !== stagingKeyReference(query)) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation key belongs to different Purchase facts"
    );
  }
  const stagingScriptPublicKey = stringValue(
    value.stagingScriptPublicKey,
    "observed staging script public key"
  );
  if (!/^0000(?:[a-f0-9]{2})+$/.test(stagingScriptPublicKey)) {
    throw new VaultTreasuryStagingError(
      "observed staging script public key is not canonical"
    );
  }
  if (
    expected &&
    (expected.purchaseId !== query.purchaseId ||
      expected.paymentIdentifier !== query.paymentIdentifier)
  ) {
    throw new VaultTreasuryStagingError(
      "Treasury staging observation belongs to a different Purchase or Payment Attempt"
    );
  }
  return Object.freeze({
    profile: OBSERVATION_PROFILE,
    purchaseId: query.purchaseId,
    paymentIdentifier: query.paymentIdentifier,
    envelopeDigest: value.envelopeDigest as Sha256Digest,
    transactionId,
    stagingOutpoint,
    stagingAmountAtomic,
    stagingFeeAtomic,
    stagingAddress: stringValue(value.stagingAddress, "observed staging address"),
    stagingScriptPublicKey,
    keyReference,
    continuationOutpoint,
    continuationAmountAtomic,
    observedAtDaa,
    chainEvidenceDigest: value.chainEvidenceDigest as Sha256Digest,
    chainEvidenceLevel: value.chainEvidenceLevel as
      | "accepted"
      | "depth-confirmed"
      | "consensus-final",
    fundingSource: FUNDING_SOURCE,
  });
}

function validateSignedVaultTransaction(input: {
  transaction: string;
  transactionId: string;
  stagingAddress: string;
  stagingScriptPublicKey: string;
  stagingAmount: bigint;
  continuationAddress: string;
  continuationAmount: bigint;
  covenantId: string;
  fee: bigint;
}): void {
  let transaction: Transaction | undefined;
  try {
    transaction = Transaction.deserializeFromSafeJSON(input.transaction);
    if (
      String(transaction.finalize()).toLowerCase() !== input.transactionId ||
      transaction.serializeToSafeJSON() !== input.transaction
    ) {
      throw new VaultTreasuryStagingError(
        "signed vault staging transaction identity or canonical encoding changed"
      );
    }
    const inputs = transaction.inputs;
    const outputs = transaction.outputs;
    if (inputs.length !== 1 || outputs.length !== 2) {
      throw new VaultTreasuryStagingError(
        "signed vault staging transaction must contain one vault input and two outputs"
      );
    }
    if (
      BigInt(outputs[0].value) !== input.stagingAmount ||
      BigInt(outputs[1].value) !== input.continuationAmount
    ) {
      throw new VaultTreasuryStagingError("signed vault staging output amounts changed");
    }
    const outputScript = serializeScriptPublicKey(
      outputs[0].scriptPublicKey.version,
      outputs[0].scriptPublicKey.script
    );
    if (outputScript !== input.stagingScriptPublicKey) {
      throw new VaultTreasuryStagingError(
        "signed vault staging script does not match its public key metadata"
      );
    }
    const destination = addressFromScriptPublicKey(outputs[0].scriptPublicKey, "testnet-10");
    const continuation = addressFromScriptPublicKey(outputs[1].scriptPublicKey, "testnet-10");
    try {
      if (
        destination?.toString() !== input.stagingAddress ||
        continuation?.toString() !== input.continuationAddress
      ) {
        throw new VaultTreasuryStagingError("signed vault staging output addresses changed");
      }
    } finally {
      destination?.free();
      continuation?.free();
    }
    if (outputs[0].covenant !== undefined) {
      throw new VaultTreasuryStagingError(
        "signed vault staging destination unexpectedly carries a covenant"
      );
    }
    if (
      !outputs[1].covenant ||
      String(outputs[1].covenant!.covenantId) !== input.covenantId ||
      outputs[1].covenant!.authorizingInput !== 0
    ) {
      throw new VaultTreasuryStagingError("signed vault continuation covenant changed");
    }
    const inputTotal = inputs.reduce(
      (sum, entry) => sum + BigInt((entry as unknown as { utxo: { amount: bigint } }).utxo.amount),
      0n
    );
    const outputTotal = outputs.reduce((sum, entry) => sum + BigInt(entry.value), 0n);
    if (inputTotal < outputTotal || inputTotal - outputTotal !== input.fee) {
      throw new VaultTreasuryStagingError(
        "declared staging fee does not equal the signed transaction fee"
      );
    }
  } catch (error) {
    if (error instanceof VaultTreasuryStagingError) throw error;
    throw new VaultTreasuryStagingError("signed vault staging transaction is invalid", {
      cause: error,
    });
  } finally {
    transaction?.free();
  }
}

function decodeForContext(
  context: Readonly<TreasuryStagingAdapterContext>
): VaultTreasuryStagingEnvelope {
  const envelope = decodeVaultTreasuryStagingEnvelope(context.staging.preparedBytes, {
    purchaseId: context.execution.purchaseId,
    paymentIdentifier: context.execution.paymentIdentifier,
  });
  const expectedDigest = evidenceDigest(context.staging.preparedBytes);
  const parsed = parseExactRequirement(
    context.paymentRequirements,
    context.execution.paymentIdentifier
  );
  const exact: ReadonlyArray<[string, unknown, unknown]> = [
    ["prepared digest", context.staging.preparedDigest, expectedDigest],
    ["transaction", context.staging.transactionId, envelope.spend.transactionId],
    ["outpoint", context.staging.expectedOutpoint, `${envelope.spend.transactionId}:0`],
    ["staging amount", context.staging.amountAtomic, envelope.spend.amountAtomic],
    ["funding source", context.staging.fundingSource, FUNDING_SOURCE],
    ["Checkout", context.execution.terms.checkoutDigest, envelope.binding.checkoutDigest],
    ["authorization evidence", context.execution.authorization.evidenceDigest, envelope.binding.authorizationEvidenceDigest],
    ["request", context.request.requestFingerprint, envelope.binding.requestFingerprint],
    ["resource", context.execution.terms.resourceFingerprint, envelope.binding.resourceFingerprint],
    ["Merchant", context.execution.terms.merchant.id, envelope.binding.merchantId],
    ["price", context.execution.terms.amountAtomic, envelope.binding.priceAtomic],
    ["asset", context.execution.terms.asset, envelope.binding.asset],
    ["network", context.execution.terms.network, envelope.binding.network],
    ["payee", context.execution.terms.payTo, envelope.binding.payTo],
    ["additional-cost ceiling", context.execution.authorizationRequest.additionalCostCeilingAtomic, envelope.binding.additionalCostCeilingAtomic],
    ["payment requirements", evidenceDigest(context.paymentRequirements), envelope.binding.paymentRequirementsDigest],
    ["exact profile", parsed.extra.profile, envelope.binding.exactProfile],
    [
      "KIP-10 threshold",
      parsed.extra.profile === "additive" ? parsed.extra.additiveThresholdSompi : "0",
      envelope.binding.additiveThresholdAtomic,
    ],
  ];
  for (const [field, actual, expected] of exact) {
    if (actual !== expected) {
      throw new VaultTreasuryStagingError(
        `durable staging ${field} does not match its canonical envelope`
      );
    }
  }
  return envelope;
}

function preparedVaultSpendFromEnvelope(
  envelope: VaultTreasuryStagingEnvelope
): PreparedVaultSpend {
  return Object.freeze({
    transaction: envelope.spend.transaction,
    transactionEncoding: envelope.spend.transactionEncoding,
    transactionId: envelope.spend.transactionId,
    destination: envelope.spend.destination,
    destinationOutpoint: Object.freeze({ ...envelope.spend.destinationOutpoint }),
    amountSompi: BigInt(envelope.spend.amountAtomic),
    feeSompi: BigInt(envelope.spend.feeAtomic),
    continuationOutpoint: Object.freeze({ ...envelope.spend.continuationOutpoint }),
    continuationAddress: envelope.spend.continuationAddress,
    continuationAmountSompi: BigInt(envelope.spend.continuationAmountAtomic),
    covenantId: envelope.spend.covenantId,
    baseConfigDigest: envelope.spend.baseConfigDigest,
    configUpdate: Object.freeze({
      ...envelope.spend.configUpdate,
      currentOutpoint: Object.freeze({ ...envelope.spend.configUpdate.currentOutpoint }),
    }),
  });
}

function stagingObservationEvidence(
  envelope: VaultTreasuryStagingEnvelope,
  prepared: PreparedVaultSpend,
  observed: ObservedVaultSpend
): VerifiedArtifact {
  if (
    observed.observedAtDaa === undefined ||
    observed.observedAtDaa < 0n ||
    observed.observedAtDaa > UINT64_MAX
  ) {
    throw new VaultTreasuryStagingError(
      "observed vault staging outputs have no valid DAA score"
    );
  }
  const facts = Object.freeze({
    profile: OBSERVATION_PROFILE,
    purchaseId: envelope.binding.purchaseId,
    paymentIdentifier: envelope.binding.paymentIdentifier,
    envelopeDigest: evidenceDigest(
      Buffer.from(stableStringify(envelope), "utf8")
    ),
    transactionId: observed.transactionId,
    stagingOutpoint: `${observed.destinationOutpoint.txid}:${observed.destinationOutpoint.index}`,
    stagingAmountAtomic: observed.amountSompi.toString(),
    stagingFeeAtomic: prepared.feeSompi.toString(),
    stagingAddress: envelope.stagingKey.address,
    stagingScriptPublicKey: envelope.stagingKey.scriptPublicKey,
    keyReference: envelope.stagingKey.keyReference,
    continuationOutpoint: `${observed.continuationOutpoint.txid}:${observed.continuationOutpoint.index}`,
    continuationAmountAtomic: observed.continuationAmountSompi.toString(),
    observedAtDaa: observed.observedAtDaa.toString(),
    chainEvidenceDigest: observed.chainEvidenceDigest,
    chainEvidenceLevel: observed.chainEvidenceLevel,
    fundingSource: FUNDING_SOURCE,
  });
  const bytes = Buffer.from(stableStringify(facts), "utf8");
  const digest = evidenceDigest(bytes);
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    mediaType: OBSERVATION_MEDIA_TYPE,
    profile: OBSERVATION_PROFILE,
    issuer: VERIFIER_ID,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId: VERIFIER_ID,
      profile: OBSERVATION_PROFILE,
      detailDigest: evidenceDigest(
        Buffer.from(
          stableStringify({
            profile: OBSERVATION_PROFILE,
            envelopeDigest: facts.envelopeDigest,
            transactionId: facts.transactionId,
            stagingOutpoint: facts.stagingOutpoint,
            continuationOutpoint: facts.continuationOutpoint,
            observedAtDaa: facts.observedAtDaa,
            chainEvidenceDigest: facts.chainEvidenceDigest,
            chainEvidenceLevel: facts.chainEvidenceLevel,
          }),
          "utf8"
        )
      ),
    }),
  });
}

function metadataFromEnvelope(
  envelope: VaultTreasuryStagingEnvelope,
  bytes: Uint8Array
): TreasuryStagingMetadata {
  return Object.freeze({
    purchaseId: envelope.binding.purchaseId,
    paymentIdentifier: envelope.binding.paymentIdentifier,
    envelopeDigest: evidenceDigest(bytes),
    paymentRequirementsDigest: envelope.binding.paymentRequirementsDigest,
    priceAtomic: envelope.binding.priceAtomic,
    additionalCostCeilingAtomic: envelope.binding.additionalCostCeilingAtomic,
    additiveThresholdAtomic: envelope.binding.additiveThresholdAtomic,
    exactFeeAtomic: envelope.binding.exactFeeAtomic,
    transactionId: envelope.spend.transactionId,
    outpoint: `${envelope.spend.transactionId}:0`,
    stagingAmountAtomic: envelope.spend.amountAtomic,
    stagingFeeAtomic: envelope.spend.feeAtomic,
    keyReference: envelope.stagingKey.keyReference,
    address: envelope.stagingKey.address,
    publicKey: envelope.stagingKey.publicKey,
    scriptPublicKey: envelope.stagingKey.scriptPublicKey,
  });
}

function normalizeQuery(
  query: Readonly<TreasuryStagingMetadataQuery>
): TreasuryStagingMetadataQuery {
  if (!query || typeof query !== "object") {
    throw new VaultTreasuryStagingError("staging metadata query is invalid");
  }
  let purchaseId: PurchaseId;
  try {
    purchaseId = assertPurchaseId(query.purchaseId);
  } catch (error) {
    throw new VaultTreasuryStagingError("staging metadata Purchase identity is invalid", {
      cause: error,
    });
  }
  if (!PAYMENT_IDENTIFIER.test(query.paymentIdentifier)) {
    throw new VaultTreasuryStagingError("staging metadata Payment identity is invalid");
  }
  return Object.freeze({ purchaseId, paymentIdentifier: query.paymentIdentifier });
}

function submissionDigest(transactionId: string): Sha256Digest {
  return evidenceDigest(
    Buffer.from(
      stableStringify({
        profile: `${PROFILE}:submission`,
        transactionId,
      }),
      "utf8"
    )
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new VaultTreasuryStagingError(`${label} is invalid`);
  return value;
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new VaultTreasuryStagingError(`${label} contains unsupported fields`);
  }
}

function requireOutpoint<I extends 0 | 1>(
  value: unknown,
  transactionId: string,
  index: I,
  label: string
): { readonly txid: string; readonly index: I } {
  const outpoint = requireRecord(value, label);
  assertKeys(outpoint, ["index", "txid"], label);
  if (outpoint.txid !== transactionId || outpoint.index !== index) {
    throw new VaultTreasuryStagingError(`${label} changed`);
  }
  return Object.freeze({ txid: transactionId, index });
}

function hash32(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH32.test(value)) {
    throw new VaultTreasuryStagingError(`${label} must be canonical lowercase hexadecimal`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): asserts value is Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new VaultTreasuryStagingError(`${label} is invalid`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VaultTreasuryStagingError(`${label} is invalid`);
  }
  return value;
}

function atomic(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new VaultTreasuryStagingError(`${label} must be a canonical atomic-unit integer`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new VaultTreasuryStagingError(`${label} is outside the supported uint64 range`);
  }
  return parsed;
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  const total = left + right;
  if (total > UINT64_MAX) {
    throw new VaultTreasuryStagingError(`${label} exceeds uint64`);
  }
  return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new VaultTreasuryStagingError("vault staging submission was aborted");
}

function transactionOutputs(transaction: string): readonly string[] {
  let document: Record<string, unknown>;
  try {
    document = requireRecord(JSON.parse(transaction), "staging transaction");
  } catch (cause) {
    throw new VaultTreasuryStagingError("staging transaction JSON is invalid", { cause });
  }
  const outputs = document.outputs;
  if (!Array.isArray(outputs)) throw new VaultTreasuryStagingError("staging transaction outputs are invalid");
  return outputs.map((value) => {
    const output = requireRecord(value, "staging transaction output");
    if (typeof output.scriptPublicKey === "string" && /^0000[a-f0-9]+$/.test(output.scriptPublicKey)) {
      return output.scriptPublicKey;
    }
    const script = requireRecord(output.scriptPublicKey, "staging output script");
    const version = Number(script.version);
    const body = String(script.script).toLowerCase();
    if (!Number.isSafeInteger(version) || version < 0 || version > 0xffff || !/^[a-f0-9]+$/.test(body)) {
      throw new VaultTreasuryStagingError("staging output script is invalid");
    }
    return `${version.toString(16).padStart(4, "0")}${body}`;
  });
}
