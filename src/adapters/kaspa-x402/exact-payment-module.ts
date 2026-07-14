import { createHash } from "node:crypto";

import {
  DirectModeClient,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parsePaymentRequiredHeaderValue,
  type AddressCodec,
  type ApplySettlementResult,
  type ChannelSigner,
  type ChannelStore,
  type CreatePaymentResult,
  type FundingProvider,
  type ParsedPaymentRequired,
} from "@kaspa-x402/client";
import {
  decodePaymentRequiredEnvelopeHeader,
  decodePaymentResponseHeader,
  encodePaymentRequiredHeader,
  encodePaymentRequiredEnvelopeHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  stableStringify,
  validatePaymentPayload,
  validatePaymentRequired,
  validatePaymentRetry,
  type ExactPaymentRequirements,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "@kaspa-x402/core";

import { requestFingerprint } from "../../purchase/identity.js";
import type {
  FulfilmentResult,
  KaspaPaymentModule,
  KaspaPreparedExecutionContext,
  KaspaRequestContext,
  KaspaTreasuryStagingContext,
  PaymentRecoveryObservation,
  PaymentSubmissionResult,
  PreparedKaspaPayment,
  PreparedTreasuryStaging,
  PurchaseEgressSession,
  SettlementResult,
  TreasuryStagingRecoveryObservation,
  TreasuryStagingSubmissionResult,
  VerifiedArtifact,
} from "../../purchase/coordinator.js";
import type { EffectObservation } from "../../purchase/journal.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import type { SupportedProtocolProfiles } from "../../protocols/profiles.js";
import type { PinnedHttpTransport } from "../../http/pinned-transport.js";
import type { PaidResourceResponseVerifier } from "../../purchase/paid-resource-response.js";

const CLIENT_VERSION: SupportedProtocolProfiles["x402"]["packages"]["client"]["version"] =
  "0.1.0-alpha.6";
const TESTNET_10: SupportedProtocolProfiles["x402"]["network"] = "kaspa:testnet-10";
const ASSET = "KAS" as const;
const FUNDING_SOURCE = "vault-treasury" as const;
const EXACT_SCHEME = "exact" as const;
const EXACT_BINDING = "kaspa-exact-v1" as const;
const EXACT_TEMPLATE = "kaspa-x402-kip10-additive-v1" as const;
const EXACT_ENCODING = "kaspa-sdk-safe-json-v2.0.0" as const;
const SETTLEMENT_PROFILE = `kaspa-x402-${CLIENT_VERSION}-exact-settlement`;
const SETTLEMENT_MEDIA_TYPE = "application/x.kaspa-x402-payment-response";
const MAX_HEADER_ARTIFACT_BYTES = 32 * 1024;
const MAX_VERIFIED_ARTIFACT_BYTES = 1024 * 1024;
const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const UINT64_MAX = (1n << 64n) - 1n;

type PrepareStagingInput = Parameters<KaspaPaymentModule["prepareStaging"]>[0];
type SubmitStagingInput = Parameters<KaspaPaymentModule["submitStaging"]>[0];
type ObserveStagingInput = Parameters<KaspaPaymentModule["observeStaging"]>[0];
type PreparePaymentInput = Parameters<KaspaPaymentModule["prepare"]>[0];
type SubmitPaymentInput = Parameters<KaspaPaymentModule["submit"]>[0];
type ObservePaymentInput = Parameters<KaspaPaymentModule["observe"]>[0];

export interface DurableTreasuryStagingSeam {
  prepare(input: Readonly<PrepareStagingInput>): Promise<PreparedTreasuryStaging>;
  submit(input: Readonly<SubmitStagingInput>): Promise<TreasuryStagingSubmissionResult>;
  observe(input: Readonly<ObserveStagingInput>): Promise<TreasuryStagingRecoveryObservation>;
}

export interface ExactAttemptFundingContext {
  purpose: "prepare";
  purchaseId: PurchaseId;
  paymentIdentifier: string;
  requestHash: Hash32Hex;
  amountAtomic: string;
  payTo: string;
  staging: Readonly<KaspaPreparedExecutionContext["staging"]>;
  additionalCostCeilingAtomic?: string;
}

/** A fresh provider must be returned for every invocation. */
export interface ExactAttemptFundingBridge {
  createProvider(context: Readonly<ExactAttemptFundingContext>): Promise<FundingProvider>;
}

export interface ExactSettlementVerificationInput {
  source: "paid-http-response" | "recovery-observer";
  context: Readonly<KaspaPreparedExecutionContext>;
  paymentRequired: Readonly<PaymentRequired>;
  paymentPayload: Readonly<PaymentPayload>;
  response: Readonly<SettlementResponse>;
  transactionId: Hash32Hex;
  evidenceBytes: Uint8Array;
}

export interface ExactSettlementVerificationResult {
  /** Actual staging fee + threshold + exact fee, not Merchant price or a ceiling. */
  additionalCostAtomic: string;
  /** Chain-attested exact Merchant payment output. */
  outpoint: string;
  verification: VerifiedArtifact["verification"];
}

export interface ExactSettlementVerifier {
  verify(
    input: Readonly<ExactSettlementVerificationInput>
  ): Promise<ExactSettlementVerificationResult>;
}

type PassiveRecoveryObservation = Exclude<EffectObservation, { status: "observed" }>;

export type KaspaExactRecoveryProbe =
  | PassiveRecoveryObservation
  | { status: "transaction_observed" }
  | { status: "payment_response"; paymentResponseHeader: Uint8Array };

export interface KaspaExactRecoveryObserver {
  observe(input: {
    context: Readonly<KaspaPreparedExecutionContext>;
    effect: Readonly<ObservePaymentInput["effect"]>;
    paymentRequired: Readonly<PaymentRequired>;
    paymentPayload: Readonly<PaymentPayload>;
    transactionId: Hash32Hex;
    signal: AbortSignal;
  }): Promise<KaspaExactRecoveryProbe>;
}

export interface KaspaX402ExactPaymentModuleOptions {
  staging: DurableTreasuryStagingSeam;
  funding: ExactAttemptFundingBridge;
  channelSigner: ChannelSigner;
  channelStore: ChannelStore;
  addressCodec: AddressCodec;
  transport: PinnedHttpTransport;
  settlementVerifier: ExactSettlementVerifier;
  recoveryObserver: KaspaExactRecoveryObserver;
  paidResponseVerifier?: PaidResourceResponseVerifier;
  now?: () => number;
}

export type KaspaX402AdapterErrorCode =
  | "invalid_configuration"
  | "profile_mismatch"
  | "artifact_mismatch"
  | "preparation_mismatch"
  | "transport_mismatch"
  | "settlement_mismatch"
  | "recovery_mismatch";

export class KaspaX402AdapterError extends Error {
  constructor(
    readonly code: KaspaX402AdapterErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "KaspaX402AdapterError";
  }
}

interface PersistedExactEnvelope {
  paymentPayload: PaymentPayload;
  paymentRequired: PaymentRequired;
  transactionId: Hash32Hex;
}

interface RehydratedExactPayment {
  client: DirectModeClient;
  envelope: PersistedExactEnvelope;
  payment: CreatePaymentResult;
  requestHash: Hash32Hex;
}

interface BoundedHttpResponse {
  status: number;
  headers: readonly (readonly [string, string])[];
  body: Uint8Array;
}

interface ProcessedPaymentResponse {
  settlement: SettlementResult;
  response: SettlementResponse;
}

/**
 * Pinned alpha.6 exact adapter. AP2 and Agent-facing types remain outside this
 * module; only the internal Purchase execution seam reaches it.
 */
export class KaspaX402ExactPaymentModule implements KaspaPaymentModule {
  private readonly staging: DurableTreasuryStagingSeam;
  private readonly funding: ExactAttemptFundingBridge;
  private readonly channelSigner: ChannelSigner;
  private readonly channelStore: ChannelStore;
  private readonly addressCodec: AddressCodec;
  private readonly transport: PinnedHttpTransport;
  private readonly settlementVerifier: ExactSettlementVerifier;
  private readonly recoveryObserver: KaspaExactRecoveryObserver;
  private readonly paidResponseVerifier?: PaidResourceResponseVerifier;
  private readonly now: () => number;
  private readonly usedProviders = new WeakSet<object>();

  constructor(options: KaspaX402ExactPaymentModuleOptions) {
    requireFunction(options?.staging?.prepare, "Treasury staging prepare seam");
    requireFunction(options?.staging?.submit, "Treasury staging submit seam");
    requireFunction(options?.staging?.observe, "Treasury staging observer seam");
    requireFunction(options?.funding?.createProvider, "attempt funding bridge");
    requireFunction(options?.transport?.send, "address-pinned HTTP transport");
    requireFunction(options?.settlementVerifier?.verify, "exact Settlement verifier");
    requireFunction(options?.recoveryObserver?.observe, "exact recovery observer");
    if (!options.channelSigner || !options.channelStore || !options.addressCodec) {
      throw adapterError("invalid_configuration", "official DirectModeClient dependency adapters are required");
    }
    this.staging = options.staging;
    this.funding = options.funding;
    this.channelSigner = options.channelSigner;
    this.channelStore = options.channelStore;
    this.addressCodec = options.addressCodec;
    this.transport = options.transport;
    this.settlementVerifier = options.settlementVerifier;
    this.recoveryObserver = options.recoveryObserver;
    this.paidResponseVerifier = options.paidResponseVerifier;
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async prepareStaging(input: PrepareStagingInput): Promise<PreparedTreasuryStaging> {
    assertExecutionBinding(input.execution, input.request, this.now);
    const header = strictPaymentRequiredArtifact(input.paymentRequirements);
    const parsed = parsePaymentRequiredHeaderValue(header, {
      supportedNetworks: [TESTNET_10],
      supportedSchemes: [EXACT_SCHEME],
    });
    assertExactRequirement(parsed, input.execution, input.request, this.now);
    const additionalCost = positiveOrZeroAtomic(
      input.additionalCostCeilingAtomic,
      "Treasury additional-cost ceiling"
    );
    if (additionalCost > BigInt(input.execution.authorizationRequest.additionalCostCeilingAtomic)) {
      throw adapterError(
        "profile_mismatch",
        "Treasury staging ceiling exceeds the exact Purchase authorization"
      );
    }
    const prepared = await this.staging.prepare(cloneForAdapter(input));
    validatePreparedStaging(
      prepared,
      BigInt(input.execution.terms.amountAtomic) +
        positiveOrZeroAtomic(
          parsed.accepted.extra.additiveThresholdSompi,
          "KIP-10 additive threshold"
        ),
      BigInt(input.execution.terms.amountAtomic) + additionalCost
    );
    return copyPreparedStaging(prepared);
  }

  async submitStaging(input: SubmitStagingInput): Promise<TreasuryStagingSubmissionResult> {
    assertTreasuryStagingContext(input.context, this.now);
    assertEffectBinding(
      input.effect,
      input.context.execution.purchaseId,
      "treasury-staging",
      input.context.staging.preparedDigest,
      `treasury-staging:${input.context.execution.paymentIdentifier}`,
      ["executing"]
    );
    if (input.signal.aborted) throw abortError(input.signal);
    const result = await this.staging.submit({
      context: cloneForAdapter(input.context),
      effect: cloneForAdapter(input.effect),
      signal: input.signal,
    });
    validateStagingSubmission(result, input.context);
    return copyStagingSubmission(result);
  }

  async observeStaging(input: ObserveStagingInput): Promise<TreasuryStagingRecoveryObservation> {
    assertTreasuryStagingContext(input.context, this.now, { allowExpired: true });
    assertEffectBinding(
      input.effect,
      input.context.execution.purchaseId,
      "treasury-staging",
      input.context.staging.preparedDigest,
      `treasury-staging:${input.context.execution.paymentIdentifier}`,
      ["executing", "submitted", "ambiguous"]
    );
    const result = await this.staging.observe({
      context: cloneForAdapter(input.context),
      effect: cloneForAdapter(input.effect),
    });
    validateStagingRecovery(result, input.context);
    return copyStagingRecovery(result);
  }

  async prepare(input: PreparePaymentInput): Promise<PreparedKaspaPayment> {
    assertExecutionBinding(input.execution, input.request, this.now);
    assertObservedStaging(input.staging, input.execution.purchaseId);
    const additionalCost = positiveOrZeroAtomic(
      input.additionalCostCeilingAtomic,
      "Treasury additional-cost ceiling"
    );
    if (additionalCost > BigInt(input.execution.authorizationRequest.additionalCostCeilingAtomic)) {
      throw adapterError(
        "profile_mismatch",
        "exact payment ceiling exceeds the exact Purchase authorization"
      );
    }
    if (
      BigInt(input.staging.amountAtomic) < BigInt(input.execution.terms.amountAtomic) ||
      BigInt(input.staging.amountAtomic) >
        BigInt(input.execution.terms.amountAtomic) + additionalCost
    ) {
      throw adapterError(
        "preparation_mismatch",
        "observed staging amount is outside the authorized gross payment bound"
      );
    }

    const header = strictPaymentRequiredArtifact(input.paymentRequirements);
    const requestHash = requestHashHex(input.request.requestFingerprint);
    const client = await this.createPreparationClient(
      input,
      requestHash,
      input.additionalCostCeilingAtomic
    );
    const selected = client.selectPaymentRequirement(header);
    assertExactRequirement(selected, input.execution, input.request, this.now);
    assertUsableStagingAmount(
      input.staging.amountAtomic,
      selected.accepted,
      input.execution,
      "observed Treasury staging"
    );

    const payment = await client.createPayment(header, {
      url: input.request.url,
      method: input.request.method,
      body: Uint8Array.from(input.request.body),
      origin: input.execution.terms.merchant.origin,
      paymentIdentifier: input.execution.paymentIdentifier,
      requestHash,
    });
    assertCreatedPayment(
      payment,
      selected,
      input.execution.paymentIdentifier,
      requestHash
    );

    const transactionId = requireHash32(payment.transactionId, "prepared exact transaction ID");
    const envelope: PersistedExactEnvelope = {
      paymentPayload: structuredClone(payment.paymentPayload),
      paymentRequired: structuredClone(payment.paymentRequired),
      transactionId,
    };
    const preparedBytes = Buffer.from(stableStringify(envelope), "utf8");
    const preparedDigest = digestBytes(preparedBytes);
    const finality = requireFinality(selected.accepted.extra.finality, "exact required finality");

    return {
      purchaseId: input.execution.purchaseId,
      checkoutDigest: input.execution.terms.checkoutDigest,
      resourceFingerprint: input.execution.terms.resourceFingerprint,
      amountAtomic: input.execution.terms.amountAtomic,
      asset: ASSET,
      network: TESTNET_10,
      payTo: input.execution.terms.payTo,
      paymentIdentifier: input.execution.paymentIdentifier,
      executionId: transactionId,
      preparedDigest,
      fundingSource: FUNDING_SOURCE,
      preparedBytes,
      requirementsDigest: digestBytes(input.paymentRequirements),
      transactionId,
      requiredFinality: finality,
    };
  }

  async submit(input: SubmitPaymentInput): Promise<PaymentSubmissionResult> {
    assertEffectBinding(
      input.effect,
      input.context.execution.purchaseId,
      "kaspa-x402-exact",
      input.context.preparation.preparedDigest,
      `payment:${input.context.execution.paymentIdentifier}`,
      ["executing"]
    );
    const rehydrated = await this.rehydrate(input.context);
    const signatureHeader = encodePaymentSignatureHeader(
      rehydrated.payment.paymentPayload
    );
    const submissionDigest = digestBytes(Buffer.from(signatureHeader, "ascii"));
    const response = await this.sendPreparedPayment(
      input.context,
      input.egress,
      signatureHeader,
      input.signal
    );
    const paymentResponse = requireSingleHeader(response.headers, PAYMENT_RESPONSE_HEADER);
    if (!paymentResponse) {
      if (response.status === 402) {
        // A corrective offer never authorizes construction of a second payment.
        const corrective = requireSingleHeader(response.headers, PAYMENT_REQUIRED_HEADER);
        if (corrective) {
          const correctiveHeader = strictPaymentRequiredHeader(corrective);
          parsePaymentRequiredHeaderValue(correctiveHeader, {
            supportedNetworks: [TESTNET_10],
            supportedSchemes: [EXACT_SCHEME],
          });
        }
        throw adapterError(
          "settlement_mismatch",
          "corrective PAYMENT-REQUIRED requires reconciliation of the immutable payment"
        );
      }
      throw adapterError(
        "settlement_mismatch",
        "paid retry response is missing PAYMENT-RESPONSE"
      );
    }
    const processed = await this.processPaymentResponse(
      "paid-http-response",
      input.context,
      rehydrated,
      Buffer.from(strictHeaderString(paymentResponse, PAYMENT_RESPONSE_HEADER), "ascii")
    );
    const paidResponse = await this.verifyPaidResponse(
      input.context,
      response,
      processed.settlement
    );
    return {
      status: "settled",
      submissionDigest,
      settlement: processed.settlement,
      ...(paidResponse ? { paidResponse } : {}),
    };
  }

  async observe(input: ObservePaymentInput): Promise<PaymentRecoveryObservation> {
    assertEffectBinding(
      input.effect,
      input.context.execution.purchaseId,
      "kaspa-x402-exact",
      input.context.preparation.preparedDigest,
      `payment:${input.context.execution.paymentIdentifier}`,
      ["executing", "submitted", "ambiguous"]
    );
    const rehydrated = await this.rehydrate(input.context, {
      allowExpired: true,
    });
    assertEgressBinding(input.context.request, input.egress.request);
    const probe = await runBeforeDeadline(
      input.egress.request.deadlineAtMs,
      this.now,
      "exact recovery observer",
      (signal) => this.recoveryObserver.observe({
        context: cloneForAdapter(input.context),
        effect: cloneForAdapter(input.effect),
        paymentRequired: cloneForAdapter(rehydrated.envelope.paymentRequired),
        paymentPayload: cloneForAdapter(rehydrated.envelope.paymentPayload),
        transactionId: rehydrated.envelope.transactionId,
        signal,
      })
    );

    if (probe.status === "payment_response") {
      const processed = await this.processPaymentResponse(
        "recovery-observer",
        input.context,
        rehydrated,
        probe.paymentResponseHeader
      );
      return { status: "settled", settlement: processed.settlement };
    }
    if (probe.status === "transaction_observed") {
      const signatureHeader = encodePaymentSignatureHeader(
        rehydrated.payment.paymentPayload
      );
      const response = await this.sendPreparedPayment(
        input.context,
        input.egress,
        signatureHeader,
        new AbortController().signal
      );
      const paymentResponse = requireSingleHeader(
        response.headers,
        PAYMENT_RESPONSE_HEADER
      );
      if (!paymentResponse) {
        throw adapterError(
          "recovery_mismatch",
          "Merchant retry after observed transaction has no PAYMENT-RESPONSE"
        );
      }
      const processed = await this.processPaymentResponse(
        "paid-http-response",
        input.context,
        rehydrated,
        Buffer.from(strictHeaderString(paymentResponse, PAYMENT_RESPONSE_HEADER), "ascii")
      );
      return { status: "settled", settlement: processed.settlement };
    }
    validatePassiveRecoveryObservation(probe);
    return structuredClone(probe);
  }

  async recoverFulfilment(input: {
    context: KaspaPreparedExecutionContext;
    egress: PurchaseEgressSession;
  }): Promise<FulfilmentResult> {
    const rehydrated = await this.rehydrate(input.context, { allowExpired: true });
    const signatureHeader = encodePaymentSignatureHeader(
      rehydrated.payment.paymentPayload
    );
    const response = await this.sendPreparedPayment(
      input.context,
      input.egress,
      signatureHeader,
      new AbortController().signal
    );
    const paymentResponse = requireSingleHeader(
      response.headers,
      PAYMENT_RESPONSE_HEADER
    );
    if (!paymentResponse) return { status: "pending" };
    const processed = await this.processPaymentResponse(
      "paid-http-response",
      input.context,
      rehydrated,
      Buffer.from(strictHeaderString(paymentResponse, PAYMENT_RESPONSE_HEADER), "ascii")
    );
    return await this.verifyPaidResponse(
      input.context,
      response,
      processed.settlement
    ) ?? { status: "pending" };
  }

  private async createPreparationClient(
    input: Pick<PreparePaymentInput, "execution" | "request" | "staging">,
    requestHash: Hash32Hex,
    additionalCostCeilingAtomic?: string
  ): Promise<DirectModeClient> {
    const provider = await this.funding.createProvider(Object.freeze({
      purpose: "prepare" as const,
      purchaseId: input.execution.purchaseId,
      paymentIdentifier: input.execution.paymentIdentifier,
      requestHash,
      amountAtomic: input.execution.terms.amountAtomic,
      payTo: input.execution.terms.payTo,
      staging: Object.freeze({ ...input.staging }),
      ...(additionalCostCeilingAtomic === undefined
        ? {}
        : { additionalCostCeilingAtomic }),
    }));
    if (!provider || typeof provider !== "object") {
      throw adapterError("invalid_configuration", "attempt funding bridge returned no provider");
    }
    if (this.usedProviders.has(provider as object)) {
      throw adapterError(
        "invalid_configuration",
        "attempt funding bridge reused a provider with mutable Purchase context"
      );
    }
    this.usedProviders.add(provider as object);
    if (
      provider.networkId !== TESTNET_10 ||
      provider.sourceKind !== FUNDING_SOURCE ||
      typeof provider.payExactTransaction !== "function"
    ) {
      throw adapterError(
        "profile_mismatch",
        "attempt funding provider must be fresh, testnet-10, vault-treasury, and exact-capable"
      );
    }
    return this.createClient(provider);
  }

  private createReplayClient(): DirectModeClient {
    // selectPaymentRequirement/applySettlement require a DirectModeClient but
    // never funding authority. Keep recovery and Merchant replay keyless.
    return this.createClient(inertReplayFundingProvider());
  }

  private createClient(provider: FundingProvider): DirectModeClient {
    const client = new DirectModeClient({
      fundingProvider: provider,
      signer: this.channelSigner,
      store: this.channelStore,
      addressCodec: this.addressCodec,
      supportedNetworks: [TESTNET_10],
      supportedSchemes: [EXACT_SCHEME],
      allowMainnet: false,
      fundingPolicy: { requiredSource: FUNDING_SOURCE },
      maxPaymentRetries: 0,
    });
    if (
      client.supportedNetworks().length !== 1 ||
      client.supportedNetworks()[0] !== TESTNET_10 ||
      client.supportedSchemes().length !== 1 ||
      client.supportedSchemes()[0] !== EXACT_SCHEME
    ) {
      throw adapterError("profile_mismatch", "DirectModeClient widened the pinned exact profile");
    }
    return client;
  }

  private async rehydrate(
    context: KaspaPreparedExecutionContext,
    options: { allowExpired?: boolean } = {}
  ): Promise<RehydratedExactPayment> {
    assertPreparedContext(context, this.now, options);
    const preparedBytes = Uint8Array.from(context.preparation.preparedBytes);
    if (digestBytes(preparedBytes) !== context.preparation.preparedDigest) {
      throw adapterError(
        "artifact_mismatch",
        "durable exact envelope does not match its content address"
      );
    }
    const text = fatalUtf8(preparedBytes, "durable exact envelope");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw adapterError("artifact_mismatch", "durable exact envelope is not JSON", { cause: error });
    }
    if (!isRecord(value) || !hasExactKeys(value, ["paymentPayload", "paymentRequired", "transactionId"])) {
      throw adapterError("artifact_mismatch", "durable exact envelope has an unknown or missing field");
    }
    if (stableStringify(value) !== text) {
      throw adapterError("artifact_mismatch", "durable exact envelope is not canonical JSON");
    }
    const requiredValidation = validatePaymentRequired(value.paymentRequired);
    if (!requiredValidation.ok) {
      throw adapterError("artifact_mismatch", "persisted PaymentRequired is invalid", {
        cause: requiredValidation.error,
      });
    }
    const payloadValidation = validatePaymentPayload(value.paymentPayload);
    if (!payloadValidation.ok) {
      throw adapterError("artifact_mismatch", "persisted PaymentPayload is invalid", {
        cause: payloadValidation.error,
      });
    }
    const retryValidation = validatePaymentRetry({
      paymentRequired: requiredValidation.value,
      paymentPayload: payloadValidation.value,
    });
    if (!retryValidation.ok) {
      throw adapterError("artifact_mismatch", "persisted exact retry artifacts are inconsistent", {
        cause: retryValidation.error,
      });
    }
    const transactionId = requireHash32(value.transactionId, "persisted exact transaction ID");
    if (transactionId !== context.preparation.transactionId) {
      throw adapterError(
        "artifact_mismatch",
        "persisted transaction identity does not match the Purchase preparation"
      );
    }
    const requestHash = requestHashHex(context.request.requestFingerprint);
    const client = this.createReplayClient();
    const selected = client.selectPaymentRequirement(
      encodePaymentRequiredHeader(requiredValidation.value)
    );
    assertExactRequirement(
      selected,
      context.execution,
      context.request,
      this.now,
      options
    );
    const originalHeader = strictPaymentRequiredArtifact(context.paymentRequirements);
    const original = client.selectPaymentRequirement(originalHeader);
    if (
      stableStringify(original.paymentRequired) !== stableStringify(requiredValidation.value) ||
      stableStringify(selected.accepted) !== stableStringify(payloadValidation.value.accepted)
    ) {
      throw adapterError(
        "artifact_mismatch",
        "durable exact envelope is bound to different payment requirements"
      );
    }
    const payment: CreatePaymentResult = {
      paymentRequired: requiredValidation.value,
      accepted: selected.accepted,
      paymentPayload: payloadValidation.value,
      scheme: EXACT_SCHEME,
      openedChannel: false,
      transactionId,
      paymentOutputIndex: exactPayload(payloadValidation.value).paymentOutputIndex,
      ...(exactPayload(payloadValidation.value).payerAddress === undefined
        ? {}
        : { payerAddress: exactPayload(payloadValidation.value).payerAddress }),
    };
    assertCreatedPayment(
      payment,
      selected,
      context.execution.paymentIdentifier,
      requestHash
    );
    return {
      client,
      envelope: {
        paymentRequired: requiredValidation.value,
        paymentPayload: payloadValidation.value,
        transactionId,
      },
      payment,
      requestHash,
    };
  }

  private async sendPreparedPayment(
    context: KaspaPreparedExecutionContext,
    egress: PurchaseEgressSession,
    signatureHeader: string,
    signal: AbortSignal
  ): Promise<BoundedHttpResponse> {
    strictHeaderString(signatureHeader, PAYMENT_SIGNATURE_HEADER);
    assertEgressBinding(context.request, egress.request);
    let hop = egress.request;
    for (;;) {
      const response = await this.sendOneHop(context, egress, hop, signatureHeader, signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = requireSingleHeader(response.headers, "location");
      if (!location) {
        throw adapterError("transport_mismatch", "paid retry redirect has no Location header");
      }
      hop = await egress.redirect(hop, location);
      assertEgressBinding(context.request, hop);
    }
  }

  private async sendOneHop(
    context: KaspaPreparedExecutionContext,
    egress: PurchaseEgressSession,
    hop: PurchaseEgressSession["request"],
    signatureHeader: string,
    signal: AbortSignal
  ): Promise<BoundedHttpResponse> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
    const remaining = hop.deadlineAtMs - readClock(this.now);
    if (remaining <= 0) controller.abort(new Error("egress deadline exceeded"));
    const timeout = setTimeout(
      () => controller.abort(new Error("egress deadline exceeded")),
      Math.max(1, remaining)
    );
    timeout.unref();
    const guard = egress.responseGuard(hop, (reason) => controller.abort(reason));
    try {
      controller.signal.throwIfAborted();
      const headers: Array<readonly [string, string]> = [
        [PAYMENT_SIGNATURE_HEADER, signatureHeader],
      ];
      if (context.request.mediaType) headers.push(["content-type", context.request.mediaType]);
      const response = await this.transport.send({
        hop,
        headers: Object.freeze(headers),
        body: Uint8Array.from(context.request.body),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
        throw adapterError("transport_mismatch", "paid retry returned an invalid HTTP status");
      }
      const responseHeaders = normalizeResponseHeaders(response.headers);
      guard.acceptHeaders(responseHeaders);
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        controller.signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) {
          throw adapterError("transport_mismatch", "paid retry body yielded a non-byte chunk");
        }
        guard.acceptBodyChunk(chunk);
        chunks.push(Buffer.from(chunk));
      }
      guard.checkTime();
      return {
        status: response.status,
        headers: responseHeaders,
        body: Buffer.concat(chunks),
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortFromCaller);
    }
  }

  private async processPaymentResponse(
    source: ExactSettlementVerificationInput["source"],
    context: KaspaPreparedExecutionContext,
    rehydrated: RehydratedExactPayment,
    evidenceBytes: Uint8Array
  ): Promise<ProcessedPaymentResponse> {
    // Take ownership before any await so an observer/transport retaining its
    // buffer cannot change the evidence after it has been decoded or verified.
    const evidenceSnapshot = Uint8Array.from(evidenceBytes);
    const header = strictHeaderArtifact(evidenceSnapshot, PAYMENT_RESPONSE_HEADER);
    const response = decodePaymentResponseHeader(header);
    if (encodePaymentResponseHeader(response) !== header) {
      throw adapterError(
        "artifact_mismatch",
        "PAYMENT-RESPONSE decoded JSON is not in the canonical upstream encoding"
      );
    }
    const applied = await rehydrated.client.applySettlement(
      rehydrated.payment,
      response
    );
    if (!response.success || applied.chargedAmount !== context.execution.terms.amountAtomic) {
      throw adapterError("settlement_mismatch", "Merchant did not return a successful exact Settlement");
    }
    const transactionId = requireHash32(
      applied.transactionId,
      "applied exact Settlement transaction ID"
    );
    if (transactionId !== context.preparation.transactionId) {
      throw adapterError(
        "settlement_mismatch",
        "Settlement transaction does not match the immutable payment"
      );
    }
    const actualFinality = requireFinality(applied.finality, "applied exact Settlement finality");
    if (!finalityMeets(actualFinality, context.preparation.requiredFinality)) {
      throw adapterError(
        "settlement_mismatch",
        "Settlement does not meet the immutable required finality"
      );
    }
    assertSettlementWireFacts(response, rehydrated.payment, context);
    const verified = await this.settlementVerifier.verify({
      source,
      context: cloneForAdapter(context),
      paymentRequired: cloneForAdapter(rehydrated.envelope.paymentRequired),
      paymentPayload: cloneForAdapter(rehydrated.envelope.paymentPayload),
      response: cloneForAdapter(response),
      transactionId,
      evidenceBytes: Uint8Array.from(evidenceSnapshot),
    });
    const additionalCost = positiveOrZeroAtomic(
      verified.additionalCostAtomic,
      "verified exact additional cost"
    );
    const authorizedCost = BigInt(
      context.execution.authorizationRequest.additionalCostCeilingAtomic
    );
    if (additionalCost > authorizedCost) {
      throw adapterError(
        "settlement_mismatch",
        "verified complete additional cost exceeds the Purchase authorization"
      );
    }
    validateVerification(verified.verification);
    if (verified.verification.profile !== SETTLEMENT_PROFILE) {
      throw adapterError(
        "settlement_mismatch",
        "Settlement verifier used a profile outside the pinned alpha.6 exact adapter"
      );
    }
    const outputIndex = exactPayload(rehydrated.envelope.paymentPayload).paymentOutputIndex;
    const outpoint = `${transactionId}:${outputIndex}`;
    if (verified.outpoint !== outpoint) {
      throw adapterError(
        "settlement_mismatch",
        "verified Settlement outpoint is not the Merchant payment output"
      );
    }
    const digest = digestBytes(evidenceSnapshot);
    const evidence: VerifiedArtifact = Object.freeze({
      bytes: Uint8Array.from(evidenceSnapshot),
      mediaType: SETTLEMENT_MEDIA_TYPE,
      profile: SETTLEMENT_PROFILE,
      issuer: context.execution.terms.merchant.id,
      declaredDigest: digest,
      verification: Object.freeze({ ...verified.verification }),
    });
    return {
      response,
      settlement: {
        evidence,
        transactionId,
        outpoint,
        amountAtomic: context.execution.terms.amountAtomic,
        additionalCostAtomic: verified.additionalCostAtomic,
        asset: ASSET,
        network: TESTNET_10,
        payTo: context.execution.terms.payTo,
        finality: actualFinality,
        fundingSource: FUNDING_SOURCE,
      },
    };
  }

  private async verifyPaidResponse(
    context: KaspaPreparedExecutionContext,
    response: BoundedHttpResponse,
    settlement: SettlementResult
  ): Promise<Extract<FulfilmentResult, { status: "fulfilled" }> | undefined> {
    if (!this.paidResponseVerifier || response.status < 200 || response.status > 299) return undefined;
    const mediaType = requireSingleHeader(response.headers, "content-type") ?? undefined;
    const fulfilled = await this.paidResponseVerifier.verify({
      context: Object.freeze({
        purchaseId: context.execution.purchaseId,
        terms: cloneForAdapter(context.execution.terms),
        authorizationRequest: cloneForAdapter(context.execution.authorizationRequest),
        authorization: cloneForAdapter(context.execution.authorization),
        paymentIdentifier: context.execution.paymentIdentifier,
        request: Object.freeze({
          url: context.request.url,
          method: context.request.method,
          requestFingerprint: context.request.requestFingerprint,
        }),
        paymentRequirements: Uint8Array.from(context.paymentRequirements),
        preparedTransactionId: context.preparation.transactionId,
      }),
      status: response.status,
      headers: response.headers,
      body: Uint8Array.from(response.body),
      mediaType,
      settlement: cloneForAdapter(settlement),
    });
    if (!fulfilled) return undefined;
    if (
      fulfilled.status !== "fulfilled" ||
      fulfilled.httpStatus !== response.status ||
      fulfilled.resourceFingerprint !== context.request.requestFingerprint ||
      !bytesEqual(fulfilled.body, response.body) ||
      fulfilled.mediaType !== (mediaType ?? "application/octet-stream")
    ) {
      throw adapterError(
        "settlement_mismatch",
        "paid response verifier returned facts that do not match the bounded HTTP response"
      );
    }
    validateVerifiedArtifact(fulfilled.merchantEvidence);
    for (const receipt of fulfilled.receipts) validateVerifiedArtifact(receipt.evidence);
    return copyFulfilment(fulfilled);
  }
}

function assertTreasuryStagingContext(
  context: KaspaTreasuryStagingContext,
  now: () => number,
  options: { allowExpired?: boolean } = {}
): void {
  assertExecutionBinding(context.execution, context.request, now, options);
  const header = strictPaymentRequiredArtifact(context.paymentRequirements);
  const parsed = parsePaymentRequiredHeaderValue(header, {
    supportedNetworks: [TESTNET_10],
    supportedSchemes: [EXACT_SCHEME],
  });
  assertExactRequirement(parsed, context.execution, context.request, now, options);
  assertUsableStagingAmount(
    context.staging.amountAtomic,
    parsed.accepted,
    context.execution,
    "durable Treasury staging plan"
  );
  if (
    digestBytes(context.staging.preparedBytes) !== context.staging.preparedDigest ||
    !HASH32.test(context.staging.transactionId) ||
    context.staging.expectedOutpoint !== `${context.staging.transactionId}:0` ||
    context.staging.fundingSource !== FUNDING_SOURCE
  ) {
    throw adapterError("artifact_mismatch", "durable Treasury staging context is inconsistent");
  }
  positiveAtomic(context.staging.amountAtomic, "Treasury staging amount");
}

function assertPreparedContext(
  context: KaspaPreparedExecutionContext,
  now: () => number,
  options: { allowExpired?: boolean } = {}
): void {
  assertExecutionBinding(context.execution, context.request, now, options);
  assertObservedStaging(context.staging, context.execution.purchaseId);
  const header = strictPaymentRequiredArtifact(context.paymentRequirements);
  const parsed = parsePaymentRequiredHeaderValue(header, {
    supportedNetworks: [TESTNET_10],
    supportedSchemes: [EXACT_SCHEME],
  });
  assertExactRequirement(parsed, context.execution, context.request, now, options);
  assertUsableStagingAmount(
    context.staging.amountAtomic,
    parsed.accepted,
    context.execution,
    "observed Treasury staging"
  );
  if (
    context.preparation.fundingSource !== FUNDING_SOURCE ||
    !HASH32.test(context.preparation.transactionId) ||
    !DIGEST.test(context.preparation.preparedDigest) ||
    context.preparation.preparedBytes.byteLength === 0
  ) {
    throw adapterError("artifact_mismatch", "durable exact preparation metadata is invalid");
  }
  requireFinality(context.preparation.requiredFinality, "durable exact required finality");
}

function assertExecutionBinding(
  execution: KaspaPreparedExecutionContext["execution"],
  request: KaspaRequestContext,
  now: () => number,
  options: { allowExpired?: boolean } = {}
): void {
  if (
    execution.terms.asset !== ASSET ||
    execution.terms.network !== TESTNET_10 ||
    execution.authorization.decision !== "approved"
  ) {
    throw adapterError("profile_mismatch", "Purchase is outside the exact KAS testnet-10 profile");
  }
  if (!DIGEST.test(execution.terms.checkoutDigest) || !DIGEST.test(request.requestFingerprint)) {
    throw adapterError("profile_mismatch", "Purchase contains an invalid canonical digest");
  }
  const expiresAt = Date.parse(execution.terms.expiresAt);
  if (!Number.isFinite(expiresAt) || (!options.allowExpired && expiresAt <= readClock(now))) {
    throw adapterError("profile_mismatch", "Checkout Terms are invalid or expired");
  }
  let resource: URL;
  try {
    resource = new URL(request.url);
  } catch (error) {
    throw adapterError("profile_mismatch", "Purchase request URL is invalid", { cause: error });
  }
  if (
    resource.href !== request.url ||
    resource.origin !== execution.terms.merchant.origin ||
    !/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(request.method)
  ) {
    throw adapterError("profile_mismatch", "Purchase request identity is not canonical for the Merchant");
  }
  const bodyDigest = digestBytes(request.body);
  let computedRequestFingerprint: Sha256Digest;
  try {
    computedRequestFingerprint = requestFingerprint({
      url: request.url,
      method: request.method,
      ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
      body: request.body,
    });
  } catch (error) {
    throw adapterError("profile_mismatch", "Purchase request identity is invalid", {
      cause: error,
    });
  }
  if (computedRequestFingerprint !== request.requestFingerprint) {
    throw adapterError(
      "profile_mismatch",
      "request fingerprint is not derived from the exact authorized HTTP request"
    );
  }
  const requestMediaType = request.mediaType ?? "";
  const authorizationRequest = execution.authorizationRequest;
  const authorization = execution.authorization;
  const facts = authorization.facts;
  positiveOrZeroAtomic(
    authorizationRequest.additionalCostCeilingAtomic,
    "authorized additional-cost ceiling"
  );
  assertDigest(authorizationRequest.requestDigest, "authorization request digest");
  assertDigest(authorizationRequest.nonceDigest, "authorization nonce digest");
  const exact: ReadonlyArray<[string, unknown, unknown]> = [
    ["Purchase", authorizationRequest.purchaseId, execution.purchaseId],
    ["authorization Purchase", authorization.purchaseId, execution.purchaseId],
    ["authorization Checkout", authorization.checkoutDigest, execution.terms.checkoutDigest],
    ["authorization request URL", authorizationRequest.resourceUrl, request.url],
    ["authorization method", authorizationRequest.method, request.method],
    ["authorization media type", authorizationRequest.requestMediaType, requestMediaType],
    ["authorization body", authorizationRequest.requestBodyDigest, bodyDigest],
    ["authorization terms", stableStringify(authorizationRequest.terms), stableStringify(execution.terms)],
    ["authorization expiry", authorizationRequest.expiresAtMs, expiresAt],
    ["request fingerprint", request.requestFingerprint, execution.terms.resourceFingerprint],
    ["fact Purchase", facts.purchaseId, execution.purchaseId],
    ["fact request URL", facts.resourceUrl, request.url],
    ["fact method", facts.method, request.method],
    ["fact media type", facts.requestMediaType, requestMediaType],
    ["fact body", facts.requestBodyDigest, bodyDigest],
    ["fact resource", facts.resourceFingerprint, execution.terms.resourceFingerprint],
    ["fact Merchant", facts.merchantId, execution.terms.merchant.id],
    ["fact Merchant origin", facts.merchantOrigin, execution.terms.merchant.origin],
    ["fact amount", facts.amountAtomic, execution.terms.amountAtomic],
    ["fact asset", facts.asset, ASSET],
    ["fact network", facts.network, TESTNET_10],
    ["fact payee", facts.payTo, execution.terms.payTo],
    ["fact expiry", facts.expiresAt, execution.terms.expiresAt],
    ["fact Checkout", facts.checkoutDigest, execution.terms.checkoutDigest],
    ["fact request", facts.requestDigest, authorizationRequest.requestDigest],
    ["fact nonce", facts.nonceDigest, authorizationRequest.nonceDigest],
    [
      "fact additional-cost ceiling",
      facts.additionalCostCeilingAtomic,
      authorizationRequest.additionalCostCeilingAtomic,
    ],
  ];
  for (const [field, actual, expected] of exact) {
    if (actual !== expected) {
      throw adapterError("profile_mismatch", `${field} is not bound to the exact Purchase`);
    }
  }
  positiveAtomic(execution.terms.amountAtomic, "Purchase amount");
  if (!execution.paymentIdentifier || execution.paymentIdentifier.length > 200) {
    throw adapterError("profile_mismatch", "Payment identifier is missing or unbounded");
  }
}

function assertExactRequirement(
  parsed: ParsedPaymentRequired,
  execution: KaspaPreparedExecutionContext["execution"],
  request: KaspaRequestContext,
  now: () => number,
  options: { allowExpired?: boolean } = {}
): asserts parsed is ParsedPaymentRequired & { accepted: ExactPaymentRequirements } {
  const accepted = parsed.accepted;
  if (
    accepted.scheme !== EXACT_SCHEME ||
    accepted.network !== TESTNET_10 ||
    accepted.asset !== ASSET ||
    accepted.amount !== execution.terms.amountAtomic ||
    accepted.payTo !== execution.terms.payTo ||
    accepted.extra.binding !== EXACT_BINDING ||
    parsed.paymentRequired.resource.url !== request.url
  ) {
    throw adapterError("profile_mismatch", "PAYMENT-REQUIRED does not match exact Checkout Terms");
  }
  if (!Number.isSafeInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds <= 0) {
    throw adapterError("profile_mismatch", "exact payment timeout is invalid");
  }
  const extra = accepted.extra;
  if (
    extra.templateId !== EXACT_TEMPLATE ||
    extra.transactionEncoding !== EXACT_ENCODING ||
    !extra.borrowOutpoint ||
    !HASH32.test(String(extra.borrowOutpoint.txid).toLowerCase()) ||
    !Number.isSafeInteger(extra.borrowOutpoint.index) ||
    extra.borrowOutpoint.index < 0 ||
    extra.borrowOutpoint.index > 0xffff_ffff ||
    typeof extra.borrowScriptPublicKey !== "string" ||
    !/^(?:[a-fA-F0-9]{2})+$/.test(extra.borrowScriptPublicKey) ||
    typeof extra.borrowRedeemScript !== "string" ||
    !/^(?:[a-fA-F0-9]{2})+$/.test(extra.borrowRedeemScript) ||
    typeof extra.paymentOutputIndex !== "number" ||
    !Number.isSafeInteger(extra.paymentOutputIndex) ||
    extra.paymentOutputIndex < 0 ||
    extra.paymentOutputIndex > 0xffff_ffff ||
    typeof extra.reservationId !== "string" ||
    !HASH32.test(extra.reservationId.toLowerCase())
  ) {
    throw adapterError("profile_mismatch", "exact KIP-10 reservation terms are incomplete");
  }
  positiveAtomic(extra.borrowAmount, "Merchant borrow amount");
  positiveOrZeroAtomic(extra.additiveThresholdSompi, "KIP-10 additive threshold");
  requireFinality(extra.finality, "exact required finality");
  if (typeof extra.reservationExpiresAt !== "string") {
    throw adapterError("profile_mismatch", "exact reservation expiry is required");
  }
  const reservationExpiry = Date.parse(extra.reservationExpiresAt);
  if (
    !Number.isFinite(reservationExpiry) ||
    (!options.allowExpired && reservationExpiry <= readClock(now))
  ) {
    throw adapterError("profile_mismatch", "exact reservation is invalid or expired");
  }
  assertRequiredPaymentIdentifier(parsed.paymentRequired, execution.paymentIdentifier);
}

function assertCreatedPayment(
  payment: CreatePaymentResult,
  selected: ParsedPaymentRequired & { accepted: ExactPaymentRequirements },
  paymentIdentifier: string,
  requestHash: Hash32Hex
): void {
  if (
    payment.scheme !== EXACT_SCHEME ||
    payment.openedChannel !== false ||
    payment.channel !== undefined ||
    stableStringify(payment.paymentRequired) !== stableStringify(selected.paymentRequired) ||
    stableStringify(payment.accepted) !== stableStringify(selected.accepted)
  ) {
    throw adapterError("preparation_mismatch", "DirectModeClient returned a non-exact or substituted payment");
  }
  const retry = validatePaymentRetry({
    paymentRequired: payment.paymentRequired,
    paymentPayload: payment.paymentPayload,
  });
  if (!retry.ok) {
    throw adapterError("preparation_mismatch", "DirectModeClient returned invalid retry artifacts", {
      cause: retry.error,
    });
  }
  if (stableStringify(payment.paymentPayload.accepted) !== stableStringify(selected.accepted)) {
    throw adapterError("preparation_mismatch", "PaymentPayload accepted different requirements");
  }
  const payload = exactPayload(payment.paymentPayload);
  if (
    payload.requestHash?.toLowerCase() !== requestHash ||
    payload.transactionEncoding !== EXACT_ENCODING ||
    payload.paymentOutputIndex !== selected.accepted.extra.paymentOutputIndex ||
    payment.paymentOutputIndex !== selected.accepted.extra.paymentOutputIndex ||
    payment.payerAddress !== payload.payerAddress
  ) {
    throw adapterError("preparation_mismatch", "exact PaymentPayload changed immutable request facts");
  }
  assertPaymentIdentifierEcho(payment.paymentPayload, paymentIdentifier);
  // alpha.6 deliberately keeps transactionId outside the client-supplied wire
  // payload. DirectModeClient validates and returns the provider's transactionId;
  // the Merchant and injected chain verifier derive it from the signed artifact.
  requireHash32(payment.transactionId, "prepared exact transaction ID");
}

function assertUsableStagingAmount(
  value: string,
  accepted: ExactPaymentRequirements,
  execution: KaspaPreparedExecutionContext["execution"],
  label: string
): void {
  const amount = positiveAtomic(value, `${label} amount`);
  const price = positiveAtomic(execution.terms.amountAtomic, "Purchase amount");
  const threshold = positiveOrZeroAtomic(
    accepted.extra.additiveThresholdSompi,
    "KIP-10 additive threshold"
  );
  const authorizedGross =
    price +
    positiveOrZeroAtomic(
      execution.authorizationRequest.additionalCostCeilingAtomic,
      "authorized additional-cost ceiling"
    );
  if (amount < price + threshold || amount > authorizedGross) {
    throw adapterError(
      "preparation_mismatch",
      `${label} cannot fund the Merchant price and additive threshold within the authorized gross bound`
    );
  }
}

function assertSettlementWireFacts(
  response: SettlementResponse,
  payment: CreatePaymentResult,
  context: KaspaPreparedExecutionContext
): void {
  const payload = exactPayload(payment.paymentPayload);
  const extra = response.extensions?.kaspa ?? response.extra;
  if (
    response.extensions?.kaspa !== undefined &&
    response.extra !== undefined &&
    stableStringify(response.extensions.kaspa) !== stableStringify(response.extra)
  ) {
    throw adapterError(
      "settlement_mismatch",
      "Settlement duplicated conflicting Kaspa extension facts"
    );
  }
  if (
    response.network !== TESTNET_10 ||
    response.amount !== context.execution.terms.amountAtomic ||
    response.transaction !== context.preparation.transactionId ||
    (response.payer !== undefined && response.payer !== payload.payerAddress) ||
    !extra ||
    extra.paymentOutputIndex !== payload.paymentOutputIndex ||
    extra.requestHash?.toLowerCase() !== requestHashHex(context.request.requestFingerprint) ||
    extra.transactionEncoding !== EXACT_ENCODING ||
    extra.templateId !== EXACT_TEMPLATE ||
    extra.reservationId !== (payment.accepted as ExactPaymentRequirements).extra.reservationId ||
    stableStringify(extra.borrowOutpoint) !==
      stableStringify((payment.accepted as ExactPaymentRequirements).extra.borrowOutpoint)
  ) {
    throw adapterError(
      "settlement_mismatch",
      "Settlement response changed exact requirement, request, or KIP-10 reservation facts"
    );
  }
}

function assertRequiredPaymentIdentifier(required: PaymentRequired, expected: string): void {
  const extension = required.extensions?.["payment-identifier"];
  if (!isRecord(extension) || !isRecord(extension.info) || extension.info.required !== true) {
    throw adapterError(
      "profile_mismatch",
      "initial exact profile requires the official payment-identifier extension"
    );
  }
  if (extension.info.id !== undefined && extension.info.id !== expected) {
    throw adapterError("profile_mismatch", "Merchant fixed a different payment identifier");
  }
}

function assertPaymentIdentifierEcho(payload: PaymentPayload, expected: string): void {
  const extension = payload.extensions?.["payment-identifier"];
  if (!isRecord(extension) || !isRecord(extension.info) || extension.info.id !== expected) {
    throw adapterError("preparation_mismatch", "PaymentPayload did not bind the exact payment identifier");
  }
}

function exactPayload(payload: PaymentPayload) {
  if (payload.payload.type !== "exact-transaction") {
    throw adapterError("preparation_mismatch", "PaymentPayload is not an exact transaction");
  }
  return payload.payload;
}

function assertObservedStaging(
  staging: KaspaPreparedExecutionContext["staging"],
  _purchaseId: PurchaseId
): void {
  if (
    !HASH32.test(staging.transactionId) ||
    !new RegExp(`^${staging.transactionId}:(0|[1-9][0-9]*)$`).test(staging.outpoint) ||
    !DIGEST.test(staging.evidenceDigest) ||
    staging.fundingSource !== FUNDING_SOURCE
  ) {
    throw adapterError("preparation_mismatch", "observed Treasury staging output is invalid");
  }
  positiveAtomic(staging.amountAtomic, "observed Treasury staging amount");
}

function validatePreparedStaging(
  prepared: PreparedTreasuryStaging,
  minimumUsable: bigint,
  reservedGross: bigint
): void {
  if (
    !(prepared.preparedBytes instanceof Uint8Array) ||
    prepared.preparedBytes.byteLength === 0 ||
    prepared.preparedDigest !== digestBytes(prepared.preparedBytes) ||
    !HASH32.test(prepared.transactionId) ||
    prepared.expectedOutpoint !== `${prepared.transactionId}:0` ||
    prepared.fundingSource !== FUNDING_SOURCE
  ) {
    throw adapterError("preparation_mismatch", "Treasury staging seam returned invalid prepared facts");
  }
  const amount = positiveAtomic(prepared.stagingAmountAtomic, "prepared Treasury staging amount");
  if (amount < minimumUsable || amount > reservedGross) {
    throw adapterError(
      "preparation_mismatch",
      "prepared Treasury staging cannot fund the Merchant price and additive threshold within the reserved gross amount"
    );
  }
}

function validateStagingSubmission(
  result: TreasuryStagingSubmissionResult,
  context: KaspaTreasuryStagingContext
): void {
  assertDigest(result.submissionDigest, "Treasury staging submission digest");
  if (result.status === "staged") validateStagingResult(result.staging, context);
  else if (result.status !== "submitted") {
    throw adapterError("artifact_mismatch", "Treasury staging seam returned an unknown submission status");
  }
}

function validateStagingRecovery(
  result: TreasuryStagingRecoveryObservation,
  context: KaspaTreasuryStagingContext
): void {
  if (result.status === "staged") validateStagingResult(result.staging, context);
  else validatePassiveRecoveryObservation(result as PassiveRecoveryObservation);
}

function validateStagingResult(
  result: Extract<TreasuryStagingSubmissionResult, { status: "staged" }>["staging"],
  context: KaspaTreasuryStagingContext
): void {
  if (
    result.transactionId !== context.staging.transactionId ||
    result.outpoint !== context.staging.expectedOutpoint ||
    result.stagingAmountAtomic !== context.staging.amountAtomic ||
    result.fundingSource !== FUNDING_SOURCE
  ) {
    throw adapterError("artifact_mismatch", "observed Treasury staging output changed its durable plan");
  }
  validateVerifiedArtifact(result.evidence);
}

function validatePassiveRecoveryObservation(observation: PassiveRecoveryObservation): void {
  switch (observation.status) {
    case "pending":
      if (observation.detailDigest) assertDigest(observation.detailDigest, "pending recovery detail");
      return;
    case "not_found":
      assertDigest(observation.detailDigest, "not-found recovery proof");
      return;
    case "conflict":
      assertDigest(observation.detailDigest, "recovery conflict detail");
      return;
    case "application_failure":
      assertCode(observation.errorCode, "recovery application error");
      assertDigest(observation.detailDigest, "recovery application detail");
      return;
  }
  throw adapterError("recovery_mismatch", "recovery observer returned an unsupported state");
}

function validateVerifiedArtifact(artifact: VerifiedArtifact): void {
  if (
    !(artifact.bytes instanceof Uint8Array) ||
    artifact.bytes.byteLength === 0 ||
    artifact.bytes.byteLength > MAX_VERIFIED_ARTIFACT_BYTES ||
    artifact.declaredDigest !== digestBytes(artifact.bytes) ||
    artifact.profile !== artifact.verification.profile
  ) {
    throw adapterError("artifact_mismatch", "verified artifact is not bound to its exact bytes and profile");
  }
  if (!artifact.mediaType || artifact.mediaType.length > 200) {
    throw adapterError("artifact_mismatch", "verified artifact media type is invalid");
  }
  validateVerification(artifact.verification);
}

function validateVerification(verification: VerifiedArtifact["verification"]): void {
  if (
    !verification ||
    !verification.verifierId ||
    verification.verifierId.length > 200 ||
    !verification.profile ||
    verification.profile.length > 200
  ) {
    throw adapterError("settlement_mismatch", "verification identity or profile is invalid");
  }
  assertDigest(verification.detailDigest, "verification detail digest");
}

function copyPreparedStaging(prepared: PreparedTreasuryStaging): PreparedTreasuryStaging {
  return Object.freeze({
    preparedBytes: Uint8Array.from(prepared.preparedBytes),
    preparedDigest: prepared.preparedDigest,
    transactionId: prepared.transactionId,
    expectedOutpoint: prepared.expectedOutpoint,
    stagingAmountAtomic: prepared.stagingAmountAtomic,
    fundingSource: FUNDING_SOURCE,
  });
}

function copyStagingSubmission(
  result: TreasuryStagingSubmissionResult
): TreasuryStagingSubmissionResult {
  return result.status === "submitted"
    ? Object.freeze({ ...result })
    : Object.freeze({
        status: "staged" as const,
        submissionDigest: result.submissionDigest,
        staging: copyStagingResult(result.staging),
      });
}

function copyStagingRecovery(
  result: TreasuryStagingRecoveryObservation
): TreasuryStagingRecoveryObservation {
  return result.status === "staged"
    ? Object.freeze({ status: "staged" as const, staging: copyStagingResult(result.staging) })
    : structuredClone(result);
}

function copyStagingResult(
  result: Extract<TreasuryStagingSubmissionResult, { status: "staged" }>["staging"]
) {
  return Object.freeze({
    ...result,
    evidence: Object.freeze({
      ...result.evidence,
      bytes: Uint8Array.from(result.evidence.bytes),
      verification: Object.freeze({ ...result.evidence.verification }),
    }),
  });
}

function copyFulfilment(
  fulfilled: Extract<FulfilmentResult, { status: "fulfilled" }>
): Extract<FulfilmentResult, { status: "fulfilled" }> {
  return structuredClone(fulfilled);
}

function inertReplayFundingProvider(): FundingProvider {
  const unavailable = async (): Promise<never> => {
    throw adapterError(
      "invalid_configuration",
      "keyless replay client cannot construct, sign, or broadcast a transaction"
    );
  };
  return Object.freeze({
    networkId: TESTNET_10,
    sourceKind: FUNDING_SOURCE,
    getPublicIdentity: unavailable,
    fundEscrowDeposit: unavailable,
    payExactTransaction: unavailable,
    getUtxos: unavailable,
    getVirtualDaaScore: unavailable,
    sendTransaction: unavailable,
    estimateFees: unavailable,
  });
}

async function runBeforeDeadline<T>(
  deadlineAtMs: number,
  now: () => number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const remaining = deadlineAtMs - readClock(now);
  if (!Number.isSafeInteger(deadlineAtMs) || remaining <= 0) {
    throw adapterError("recovery_mismatch", `${label} deadline has expired`);
  }
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = adapterError("recovery_mismatch", `${label} deadline has expired`);
      controller.abort(error);
      reject(error);
    }, Math.min(remaining, 0x7fff_ffff));
    // The deadline must keep the process alive when the observed operation is
    // a handle-free pending Promise. It is cleared immediately on settlement.
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function strictHeaderArtifact(bytes: Uint8Array, name: string): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_HEADER_ARTIFACT_BYTES) {
    throw adapterError("artifact_mismatch", `${name} artifact length is invalid`);
  }
  return strictHeaderString(Buffer.from(bytes).toString("latin1"), name, bytes);
}

function strictPaymentRequiredArtifact(bytes: Uint8Array): string {
  return strictPaymentRequiredHeader(
    strictHeaderArtifact(bytes, PAYMENT_REQUIRED_HEADER)
  );
}

function strictPaymentRequiredHeader(value: string): string {
  const header = strictHeaderString(value, PAYMENT_REQUIRED_HEADER);
  const envelope = decodePaymentRequiredEnvelopeHeader(header);
  if (encodePaymentRequiredEnvelopeHeader(envelope) !== header) {
    throw adapterError(
      "artifact_mismatch",
      "PAYMENT-REQUIRED decoded JSON is not in the canonical upstream encoding"
    );
  }
  return header;
}

function strictHeaderString(value: string, name: string, originalBytes?: Uint8Array): string {
  if (
    value.length === 0 ||
    value.length > MAX_HEADER_ARTIFACT_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    value.length % 4 !== 0
  ) {
    throw adapterError("artifact_mismatch", `${name} must be one canonical ASCII base64 value`);
  }
  if (originalBytes && !bytesEqual(originalBytes, Buffer.from(value, "ascii"))) {
    throw adapterError("artifact_mismatch", `${name} contains non-ASCII bytes`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw adapterError("artifact_mismatch", `${name} base64 encoding is not canonical`);
  }
  fatalUtf8(decoded, `${name} decoded JSON`);
  return value;
}

function normalizeResponseHeaders(
  headers: readonly (readonly [string, string])[]
): readonly (readonly [string, string])[] {
  if (!Array.isArray(headers)) {
    throw adapterError("transport_mismatch", "HTTP transport returned no header collection");
  }
  return Object.freeze(headers.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw adapterError("transport_mismatch", "HTTP transport returned an invalid header");
    }
    return Object.freeze([entry[0], entry[1]] as const);
  }));
}

function requireSingleHeader(
  headers: readonly (readonly [string, string])[],
  name: string
): string | undefined {
  const values = headers
    .filter(([candidate]) => candidate.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);
  if (values.length > 1) {
    throw adapterError("transport_mismatch", `HTTP response repeated ${name}`);
  }
  return values[0];
}

function assertEgressBinding(
  request: KaspaRequestContext,
  hop: PurchaseEgressSession["request"]
): void {
  if (
    hop.url !== request.url ||
    hop.method !== request.method ||
    hop.requestFingerprint !== request.requestFingerprint ||
    !bytesEqual(hop.body ?? new Uint8Array(), request.body)
  ) {
    throw adapterError("transport_mismatch", "address-pinned egress hop changed the authorized request");
  }
}

function assertEffectBinding(
  effect: {
    purchaseId: PurchaseId;
    attempt?: number;
    kind: string;
    idempotencyKey: string;
    payloadDigest: Sha256Digest;
    state: string;
  },
  purchaseId: PurchaseId,
  expectedKind: string,
  expectedDigest: Sha256Digest,
  expectedIdempotencyKey: string,
  allowedStates: readonly string[]
): void {
  if (
    effect.purchaseId !== purchaseId ||
    effect.attempt === undefined ||
    effect.kind !== expectedKind ||
    effect.payloadDigest !== expectedDigest ||
    effect.idempotencyKey !== expectedIdempotencyKey ||
    !allowedStates.includes(effect.state) ||
    !DIGEST.test(effect.payloadDigest)
  ) {
    throw adapterError("artifact_mismatch", `${expectedKind} Effect is not bound to this Purchase attempt`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw adapterError("artifact_mismatch", `${label} is not a canonical SHA-256 digest`);
  }
}

function assertCode(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(value)) {
    throw adapterError("recovery_mismatch", `${label} is not a canonical code`);
  }
}

function requireHash32(value: unknown, label: string): Hash32Hex {
  if (typeof value !== "string" || !HASH32.test(value)) {
    throw adapterError("artifact_mismatch", `${label} must be canonical lowercase 32-byte hex`);
  }
  return value;
}

function requestHashHex(value: Sha256Digest): Hash32Hex {
  assertDigest(value, "request fingerprint");
  const bytes = Buffer.from(value.slice("sha256:".length), "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value.slice("sha256:".length)) {
    throw adapterError("profile_mismatch", "request fingerprint encoding is not canonical");
  }
  return bytes.toString("hex");
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

function fatalUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw adapterError("artifact_mismatch", `${label} is not valid UTF-8`, { cause: error });
  }
}

function positiveAtomic(value: unknown, label: string): bigint {
  const amount = positiveOrZeroAtomic(value, label);
  if (amount === 0n) throw adapterError("profile_mismatch", `${label} must be positive`);
  return amount;
}

function positiveOrZeroAtomic(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw adapterError("profile_mismatch", `${label} must be a canonical atomic integer`);
  }
  const amount = BigInt(value);
  if (amount > UINT64_MAX) throw adapterError("profile_mismatch", `${label} exceeds uint64`);
  return amount;
}

function requireFinality(
  value: unknown,
  label: string
): "mempool" | "accepted" | "confirmed" {
  if (value !== "mempool" && value !== "accepted" && value !== "confirmed") {
    throw adapterError("profile_mismatch", `${label} is invalid`);
  }
  return value;
}

function finalityMeets(actual: string, required: string): boolean {
  const rank: Record<string, number> = { mempool: 0, accepted: 1, confirmed: 2 };
  return rank[actual] !== undefined && rank[required] !== undefined && rank[actual] >= rank[required];
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function cloneForAdapter<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== "function") {
    throw adapterError("invalid_configuration", `${label} is required`);
  }
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw adapterError("invalid_configuration", "injected clock returned an invalid timestamp");
  }
  return value;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}

function adapterError(
  code: KaspaX402AdapterErrorCode,
  message: string,
  options?: { cause?: unknown }
): KaspaX402AdapterError {
  return new KaspaX402AdapterError(code, message, options);
}
