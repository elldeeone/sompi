import type {
  AddressCodec,
  ChannelSigner,
  ChannelStore,
  DirectModeChannel,
  FundingProvider,
  FundingProviderUtxo,
} from "@kaspa-x402/client";
import {
  DirectModeClient,
  MemoryChannelStore,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parsePaymentRequiredHeaderValue,
} from "@kaspa-x402/client";
import {
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  readKaspaSettlementExtension,
  sha256Hex,
  stableStringify,
  type BatchPaymentRequirements,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
  type SompiString,
} from "@kaspa-x402/core";

import type { PurchaseJournal, BatchTreasuryMovementRecord } from "../../purchase/journal.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type {
  FulfilmentResult,
  KaspaPaymentModule,
  KaspaPreparedExecutionContext,
  PaymentRecoveryObservation,
  PaymentSubmissionResult,
  PreparedKaspaPayment,
  PurchaseEgressSession,
  SettlementResult,
  VerifiedArtifact,
} from "../../purchase/coordinator.js";
import type { PaidResourceResponseVerifier } from "../../purchase/paid-resource-response.js";
import type { PinnedHttpTransport } from "../../http/pinned-transport.js";
import {
  requireSingleHttpHeader,
  sendBoundedPaidRequest,
  type BoundedPaidHttpResponse,
} from "./paid-http-transport.js";

const NETWORK = "kaspa:testnet-10" as const;
const SOURCE = "vault-treasury" as const;
const UINT64_MAX = (1n << 64n) - 1n;
const SETTLEMENT_PROFILE = "kaspa-x402-0.1.0-alpha.8-batch-settlement";
const SETTLEMENT_MEDIA_TYPE = "application/x.kaspa-x402-payment-response";
const BATCH_PROFILE = "kaspa-escrow-v1:batch-settlement";

export interface BatchActiveUtxoSource {
  getUtxos(addresses: readonly string[]): Promise<FundingProviderUtxo[]>;
  getVirtualDaaScore(): Promise<SompiString>;
}

export interface PrepareBatchPaymentInput {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly resourceUrl: string;
  readonly method: string;
  readonly body: Uint8Array;
  readonly requestHash: Hash32Hex;
  readonly merchantOrigin: string;
  readonly merchantId: string;
  readonly amountAtomic: string;
  readonly asset: "KAS";
  readonly network: typeof NETWORK;
  readonly payTo: string;
  readonly checkoutDigest: Sha256Digest;
  readonly resourceFingerprint: Sha256Digest;
  readonly paymentRequirements: Uint8Array;
  readonly claimFeeReserveAtomic: string;
  readonly authorizedChannelId: Hash32Hex;
  readonly authorizedChannelEpochDigest: Sha256Digest;
}

export interface PreparedBatchPayment {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly executionId: Hash32Hex;
  readonly preparedBytes: Uint8Array;
  readonly preparedDigest: Sha256Digest;
  readonly requirementsDigest: Sha256Digest;
  readonly channelId: Hash32Hex;
  readonly activeOutpoint: Readonly<{ txid: Hash32Hex; index: number }>;
  readonly maximumAuthorizedAtomic: string;
  readonly voucherCeilingAtomic: string;
  readonly fundingSource: typeof SOURCE;
}

export interface AppliedBatchSettlement {
  readonly executionId: Hash32Hex;
  readonly channelId: Hash32Hex;
  readonly commitmentId: Hash32Hex;
  readonly maximumAuthorizedAtomic: string;
  readonly chargedAmountAtomic: string;
  readonly voucherCeilingAtomic: string;
  readonly settlement: SettlementResponse;
}

interface PersistedBatchEnvelope {
  readonly paymentRequired: PaymentRequired;
  readonly paymentPayload: PaymentPayload;
  readonly channelId: Hash32Hex;
  readonly activeOutpoint: Readonly<{ txid: Hash32Hex; index: number }>;
  readonly maximumAuthorizedAtomic: string;
  readonly voucherCeilingAtomic: string;
  readonly executionId: Hash32Hex;
  readonly movementId: string;
  readonly channelBefore: DirectModeChannel;
}

export class JournalBatchVoucherAuthorizer {
  constructor(
    private readonly journal: PurchaseJournal,
    private readonly claimFeeReserveAtomic: string
  ) {
    atomic(claimFeeReserveAtomic, "batch claim-fee reserve");
  }

  authorize(input: Readonly<{
    purchaseId: PurchaseId;
    channel: DirectModeChannel;
    maximumAuthorizedAtomic: string;
    voucherCeilingAtomic: string;
    requirementsDigest: Sha256Digest;
    requestHash: Hash32Hex;
  }>): BatchTreasuryMovementRecord {
    const purchase = this.journal.requirePurchase(input.purchaseId);
    if (purchase.state !== "authorised" && purchase.state !== "execution_prepared") {
      throw new Error("batch voucher requires a separately authorized Purchase");
    }
    const maximum = atomic(input.maximumAuthorizedAtomic, "batch maximum authorization", true);
    const ceiling = atomic(input.voucherCeilingAtomic, "batch voucher ceiling", true);
    const funding = atomic(input.channel.fundingAmount, "batch channel funding", true);
    const charged = atomic(input.channel.chargedCumulativeAmount, "batch charged amount");
    const claimed = atomic(input.channel.claimedCumulativeAmount, "batch claimed amount");
    const signed = atomic(input.channel.signedCumulativeAmount, "batch signed amount");
    const reserve = atomic(this.claimFeeReserveAtomic, "batch claim-fee reserve");
    const activeCharged = checkedSubtract(charged, claimed, "batch active charge");
    const requiredCeiling = max(signed, checkedAdd(activeCharged, maximum, "batch required ceiling"));
    if (ceiling !== requiredCeiling) throw new Error("batch voucher ceiling does not equal the authorized monotonic ceiling");
    if (checkedAdd(requiredCeiling, reserve, "batch claim reserve") > funding) {
      throw new Error("batch voucher would consume the claim-fee reserve");
    }
    const movementId = `batch-voucher:${input.purchaseId}`;
    const requestDigest = evidenceDigest(Buffer.from(stableStringify({
      profile: "urn:sompi:batch-voucher-authorization:1",
      purchaseId: input.purchaseId,
      channelId: input.channel.id,
      activeOutpoint: input.channel.activeOutpoint,
      maximumAuthorizedAtomic: maximum.toString(),
      voucherCeilingAtomic: ceiling.toString(),
      requirementsDigest: input.requirementsDigest,
      requestHash: input.requestHash,
    }), "utf8"));
    return this.journal.planBatchTreasuryMovement({
      movementId,
      channelId: input.channel.id,
      purchaseId: input.purchaseId,
      kind: "voucher",
      requestDigest,
      activeOutpointBefore: input.channel.activeOutpoint,
      maximumAuthorizedAtomic: maximum.toString(),
      voucherCeilingAtomic: ceiling.toString(),
    });
  }

  accept(input: Readonly<{
    purchaseId: PurchaseId;
    paymentIdentifier: string;
    merchantId: string;
    movementId: string;
    actualChargeAtomic: string;
    commitmentId: Hash32Hex;
    evidenceBytes: Uint8Array;
    verification: VerifiedArtifact["verification"];
  }>): BatchTreasuryMovementRecord {
    const current = this.journal.requireBatchTreasuryMovement(input.movementId);
    const attempts = this.journal.paymentAttempts(input.purchaseId).filter(
      (candidate) => candidate.identifier === input.paymentIdentifier
    );
    if (attempts.length !== 1) {
      throw new Error("batch commitment is not bound to one durable Payment Attempt");
    }
    const stored = this.journal.storeEvidence(input.purchaseId, {
      bytes: Uint8Array.from(input.evidenceBytes),
      mediaType: SETTLEMENT_MEDIA_TYPE,
      profile: SETTLEMENT_PROFILE,
      issuer: input.merchantId,
      kind: "batch-voucher-commitment",
      attempt: attempts[0]!.attempt,
    });
    this.journal.recordEvidenceVerification(stored.digest, input.verification);
    if (current.state === "accepted") {
      if (
        current.actualChargeAtomic !== input.actualChargeAtomic ||
        current.transactionId !== input.commitmentId ||
        current.evidenceDigest !== stored.digest
      ) {
        throw new Error("accepted batch voucher movement conflicts with durable commitment");
      }
      return current;
    }
    return this.journal.advanceBatchTreasuryMovement({
      movementId: input.movementId,
      expectedState: "planned",
      state: "accepted",
      actualChargeAtomic: input.actualChargeAtomic,
      transactionId: input.commitmentId,
      evidenceDigest: stored.digest,
    });
  }
}

/** Batch is an explicit channel lifecycle, not another exact profile. */
export class KaspaX402BatchPaymentModule implements KaspaPaymentModule {
  constructor(private readonly options: Readonly<{
    store: ChannelStore;
    signer: ChannelSigner;
    addressCodec: AddressCodec;
    chain: BatchActiveUtxoSource;
    authorizer: JournalBatchVoucherAuthorizer;
    claimFeeReserveAtomic: string;
    transport: PinnedHttpTransport;
    paidResponseVerifier?: PaidResourceResponseVerifier;
    now?: () => number;
  }>) {
    if (
      !options?.store || !options.signer || !options.addressCodec || !options.chain ||
      !options.authorizer || typeof options.transport?.send !== "function"
    ) {
      throw new Error("batch payment module dependencies are incomplete");
    }
    atomic(options.claimFeeReserveAtomic, "batch claim-fee reserve");
    readClock(options.now ?? Date.now);
  }

  async prepare(input: Parameters<KaspaPaymentModule["prepare"]>[0]): Promise<PreparedKaspaPayment> {
    if (
      input.staging !== undefined ||
      input.execution.authorizationRequest.executionMechanism !== "channel-voucher" ||
      input.execution.authorizationRequest.executionProfile !== BATCH_PROFILE ||
      input.execution.authorizationRequest.settlementAssurance !== "channel-commitment" ||
      input.additionalCostCeilingAtomic !== "0"
    ) {
      throw new Error("batch Purchase execution plan is inconsistent");
    }
    const prepared = await this.prepareVoucher({
      purchaseId: input.execution.purchaseId,
      paymentIdentifier: input.execution.paymentIdentifier,
      resourceUrl: input.request.url,
      method: input.request.method,
      body: Uint8Array.from(input.request.body),
      requestHash: requestHashHex(input.request.requestFingerprint),
      merchantOrigin: input.execution.terms.merchant.origin,
      merchantId: input.execution.terms.merchant.id,
      amountAtomic: input.execution.terms.amountAtomic,
      asset: "KAS",
      network: NETWORK,
      payTo: input.execution.terms.payTo,
      checkoutDigest: input.execution.terms.checkoutDigest,
      resourceFingerprint: input.execution.terms.resourceFingerprint,
      paymentRequirements: Uint8Array.from(input.paymentRequirements),
      claimFeeReserveAtomic: this.options.claimFeeReserveAtomic,
      authorizedChannelId: requireHash32(
        input.execution.authorizationRequest.channelId,
        "authorized batch channel ID"
      ),
      authorizedChannelEpochDigest: requireDigest(
        input.execution.authorizationRequest.channelEpochDigest,
        "authorized batch channel epoch"
      ),
    });
    return Object.freeze({
      purchaseId: input.execution.purchaseId,
      checkoutDigest: input.execution.terms.checkoutDigest,
      resourceFingerprint: input.execution.terms.resourceFingerprint,
      amountAtomic: input.execution.terms.amountAtomic,
      asset: "KAS",
      network: NETWORK,
      payTo: input.execution.terms.payTo,
      paymentIdentifier: input.execution.paymentIdentifier,
      executionId: prepared.executionId,
      preparedDigest: prepared.preparedDigest,
      preparedBytes: Uint8Array.from(prepared.preparedBytes),
      requirementsDigest: prepared.requirementsDigest,
      mechanism: "channel-voucher",
      profile: BATCH_PROFILE,
      requiredAssurance: "channel-commitment",
      fundingSource: SOURCE,
    });
  }

  private async prepareVoucher(input: Readonly<PrepareBatchPaymentInput>): Promise<PreparedBatchPayment> {
    validateInput(input);
    const header = strictHeader(input.paymentRequirements);
    const selected = parsePaymentRequiredHeaderValue(header, {
      supportedNetworks: [NETWORK],
      supportedSchemes: ["batch-settlement"],
    });
    assertBatchRequirement(selected.accepted as BatchPaymentRequirements, selected.paymentRequired, input);
    const requirementsDigest = evidenceDigest(input.paymentRequirements);
    const boundedSigner = new AuthorizedVoucherSigner(
      this.options.signer,
      this.options.authorizer,
      input,
      requirementsDigest
    );
    const client = new DirectModeClient({
      fundingProvider: readOnlyBatchProvider(this.options.chain),
      signer: boundedSigner,
      store: this.options.store,
      addressCodec: this.options.addressCodec,
      supportedNetworks: [NETWORK],
      supportedSchemes: ["batch-settlement"],
      fundingPolicy: {
        requiredSource: SOURCE,
        allowedOrigins: [input.merchantOrigin],
        allowedPayTo: [input.payTo],
      },
    });
    const payment = await client.createPayment(header, {
      url: input.resourceUrl,
      method: input.method,
      body: Uint8Array.from(input.body),
      origin: input.merchantOrigin,
      paymentIdentifier: input.paymentIdentifier,
      requestHash: input.requestHash,
    });
    if (payment.scheme !== "batch-settlement" || payment.openedChannel || !payment.channel || payment.paymentPayload.payload.type !== "voucher") {
      throw new Error("batch Purchase must use an already accepted channel epoch");
    }
    const movement = boundedSigner.requireMovement();
    const payload = payment.paymentPayload.payload;
    const executionId = sha256Hex(stableStringify(payment.paymentPayload));
    const envelope: PersistedBatchEnvelope = {
      paymentRequired: structuredClone(payment.paymentRequired),
      paymentPayload: structuredClone(payment.paymentPayload),
      channelId: payment.channel.id,
      activeOutpoint: Object.freeze({ ...payment.channel.activeOutpoint }),
      maximumAuthorizedAtomic: input.amountAtomic,
      voucherCeilingAtomic: payload.voucher.amount,
      executionId,
      movementId: movement.movementId,
      channelBefore: structuredClone(payment.channel),
    };
    const preparedBytes = Buffer.from(stableStringify(envelope), "utf8");
    return Object.freeze({
      purchaseId: input.purchaseId,
      paymentIdentifier: input.paymentIdentifier,
      executionId,
      preparedBytes: Uint8Array.from(preparedBytes),
      preparedDigest: evidenceDigest(preparedBytes),
      requirementsDigest,
      channelId: payment.channel.id,
      activeOutpoint: Object.freeze({ ...payment.channel.activeOutpoint }),
      maximumAuthorizedAtomic: input.amountAtomic,
      voucherCeilingAtomic: payload.voucher.amount,
      fundingSource: SOURCE,
    });
  }

  async submit(input: Parameters<KaspaPaymentModule["submit"]>[0]): Promise<PaymentSubmissionResult> {
    this.assertPreparedContext(input.context);
    assertEffect(input.effect, input.context, ["executing"]);
    const signatureHeader = this.signatureHeader(input.context.preparation.preparedBytes);
    const submissionDigest = evidenceDigest(Buffer.from(signatureHeader, "ascii"));
    const response = await this.send(input.context, input.egress, input.signal);
    const settlement = await this.settlementFromResponse(input.context, response);
    const paidResponse = await this.verifyPaidResponse(input.context, response, settlement);
    return Object.freeze({
      status: "settled" as const,
      submissionDigest,
      settlement,
      ...(paidResponse ? { paidResponse } : {}),
    });
  }

  async observe(input: Parameters<KaspaPaymentModule["observe"]>[0]): Promise<PaymentRecoveryObservation> {
    this.assertPreparedContext(input.context);
    assertEffect(input.effect, input.context, ["executing", "submitted", "ambiguous"]);
    try {
      const response = await this.send(
        input.context,
        input.egress,
        new AbortController().signal
      );
      const paymentResponse = requireSingleHttpHeader(
        response.headers,
        PAYMENT_RESPONSE_HEADER,
        batchError
      );
      if (!paymentResponse) {
        return {
          status: "pending",
          detailDigest: evidenceDigest(Buffer.from("batch-commitment-pending")),
        };
      }
      return {
        status: "settled",
        settlement: await this.settlementFromResponse(input.context, response),
      };
    } catch (error) {
      return {
        status: "conflict",
        detailDigest: evidenceDigest(
          Buffer.from(`batch-observation:${safeErrorCode(error)}`)
        ),
      };
    }
  }

  async recoverFulfilment(input: {
    context: KaspaPreparedExecutionContext;
    egress: PurchaseEgressSession;
  }): Promise<FulfilmentResult> {
    this.assertPreparedContext(input.context);
    const response = await this.send(
      input.context,
      input.egress,
      new AbortController().signal
    );
    const paymentResponse = requireSingleHttpHeader(
      response.headers,
      PAYMENT_RESPONSE_HEADER,
      batchError
    );
    if (!paymentResponse) return { status: "pending" };
    const settlement = await this.settlementFromResponse(input.context, response);
    return await this.verifyPaidResponse(input.context, response, settlement) ?? {
      status: "pending",
    };
  }

  signatureHeader(preparedBytes: Uint8Array): string {
    return encodePaymentSignatureHeader(decodeEnvelope(preparedBytes).paymentPayload);
  }

  async applySettlement(
    preparedBytes: Uint8Array,
    paymentResponseHeader: string
  ): Promise<AppliedBatchSettlement> {
    const envelope = decodeEnvelope(preparedBytes);
    const isolatedStore = new MemoryChannelStore([
      structuredClone(envelope.channelBefore),
    ]);
    const client = new DirectModeClient({
      fundingProvider: readOnlyBatchProvider(this.options.chain),
      signer: disabledSigner(),
      store: isolatedStore,
      addressCodec: this.options.addressCodec,
      supportedNetworks: [NETWORK],
      supportedSchemes: ["batch-settlement"],
    });
    const channel = structuredClone(envelope.channelBefore);
    const accepted = envelope.paymentPayload.accepted as BatchPaymentRequirements;
    const payment = {
      paymentRequired: envelope.paymentRequired,
      accepted,
      paymentPayload: envelope.paymentPayload,
      scheme: "batch-settlement" as const,
      channel,
      openedChannel: false,
    };
    const response = decodePaymentResponseHeader(paymentResponseHeader);
    const applied = await client.applySettlement(payment, response);
    const extra = readKaspaSettlementExtension(response);
    if (!response.success || !extra?.commitmentId || applied.pending) {
      throw new Error("batch settlement is not durably committed");
    }
    if (!applied.channel) throw new Error("batch settlement returned no channel state");
    const current = (await this.options.store.loadChannels({})).find(
      (candidate) => candidate.id === envelope.channelId
    );
    if (
      !current ||
      (!sameChannelState(current, channel) && !sameChannelState(current, applied.channel))
    ) {
      throw new Error("prepared batch epoch diverged before commitment application");
    }
    await this.options.store.saveChannel(applied.channel);
    return Object.freeze({
      executionId: envelope.executionId,
      channelId: envelope.channelId,
      commitmentId: extra.commitmentId,
      maximumAuthorizedAtomic: envelope.maximumAuthorizedAtomic,
      chargedAmountAtomic: applied.chargedAmount,
      voucherCeilingAtomic: envelope.voucherCeilingAtomic,
      settlement: structuredClone(response),
    });
  }

  private assertPreparedContext(context: KaspaPreparedExecutionContext): void {
    if (
      context.staging !== undefined ||
      context.preparation.mechanism !== "channel-voucher" ||
      context.preparation.profile !== BATCH_PROFILE ||
      context.preparation.transactionId !== undefined ||
      context.preparation.requiredAssurance !== "channel-commitment" ||
      context.execution.authorizationRequest.executionMechanism !== "channel-voucher" ||
      context.execution.authorizationRequest.executionProfile !== BATCH_PROFILE
    ) {
      throw new Error("durable batch preparation context is inconsistent");
    }
    const envelope = decodeEnvelope(context.preparation.preparedBytes);
    if (
      envelope.executionId !== context.preparation.executionId ||
      evidenceDigest(context.preparation.preparedBytes) !== context.preparation.preparedDigest ||
      envelope.paymentPayload.extensions?.["payment-identifier"]?.info?.id !==
        context.execution.paymentIdentifier
    ) {
      throw new Error("durable batch preparation bytes changed");
    }
  }

  private async send(
    context: KaspaPreparedExecutionContext,
    egress: PurchaseEgressSession,
    signal: AbortSignal
  ): Promise<BoundedPaidHttpResponse> {
    return sendBoundedPaidRequest({
      request: context.request,
      egress,
      transport: this.options.transport,
      paymentHeaderName: PAYMENT_SIGNATURE_HEADER,
      paymentHeaderValue: this.signatureHeader(context.preparation.preparedBytes),
      signal,
      now: this.options.now ?? Date.now,
      error: batchError,
    });
  }

  private async settlementFromResponse(
    context: KaspaPreparedExecutionContext,
    response: BoundedPaidHttpResponse
  ): Promise<SettlementResult> {
    const paymentResponse = requireSingleHttpHeader(
      response.headers,
      PAYMENT_RESPONSE_HEADER,
      batchError
    );
    if (!paymentResponse) throw new Error("batch paid response is missing PAYMENT-RESPONSE");
    const evidenceBytes = Buffer.from(paymentResponse, "ascii");
    const applied = await this.applySettlement(
      context.preparation.preparedBytes,
      paymentResponse
    );
    const verification = Object.freeze({
      verifierId: "sompi-kaspa-x402-alpha8-batch",
      profile: SETTLEMENT_PROFILE,
      detailDigest: evidenceDigest(Buffer.from(stableStringify({
        executionId: applied.executionId,
        channelId: applied.channelId,
        commitmentId: applied.commitmentId,
        chargedAmountAtomic: applied.chargedAmountAtomic,
        voucherCeilingAtomic: applied.voucherCeilingAtomic,
      }), "utf8")),
    });
    const envelope = decodeEnvelope(context.preparation.preparedBytes);
    this.options.authorizer.accept({
      purchaseId: context.execution.purchaseId,
      paymentIdentifier: context.execution.paymentIdentifier,
      merchantId: context.execution.terms.merchant.id,
      movementId: envelope.movementId,
      actualChargeAtomic: applied.chargedAmountAtomic,
      commitmentId: applied.commitmentId,
      evidenceBytes,
      verification,
    });
    const evidence: VerifiedArtifact = Object.freeze({
      bytes: Uint8Array.from(evidenceBytes),
      mediaType: SETTLEMENT_MEDIA_TYPE,
      profile: SETTLEMENT_PROFILE,
      issuer: context.execution.terms.merchant.id,
      declaredDigest: evidenceDigest(evidenceBytes),
      verification,
    });
    return Object.freeze({
      evidence,
      executionId: applied.executionId,
      mechanism: "channel-voucher" as const,
      profile: BATCH_PROFILE,
      commitmentId: applied.commitmentId,
      amountAtomic: applied.chargedAmountAtomic,
      additionalCostAtomic: "0",
      asset: "KAS",
      network: NETWORK,
      payTo: context.execution.terms.payTo,
      settlementAssurance: "channel-commitment" as const,
      fundingSource: SOURCE,
    });
  }

  private async verifyPaidResponse(
    context: KaspaPreparedExecutionContext,
    response: BoundedPaidHttpResponse,
    settlement: SettlementResult
  ): Promise<Extract<FulfilmentResult, { status: "fulfilled" }> | undefined> {
    if (!this.options.paidResponseVerifier || response.status < 200 || response.status > 299) {
      return undefined;
    }
    const mediaType = requireSingleHttpHeader(
      response.headers,
      "content-type",
      batchError
    ) ?? undefined;
    return this.options.paidResponseVerifier.verify({
      context: Object.freeze({
        purchaseId: context.execution.purchaseId,
        terms: structuredClone(context.execution.terms),
        authorizationRequest: structuredClone(context.execution.authorizationRequest),
        authorization: structuredClone(context.execution.authorization),
        paymentIdentifier: context.execution.paymentIdentifier,
        request: Object.freeze({
          url: context.request.url,
          method: context.request.method,
          requestFingerprint: context.request.requestFingerprint,
        }),
        paymentRequirements: Uint8Array.from(context.paymentRequirements),
        preparedExecutionId: context.preparation.executionId,
      }),
      status: response.status,
      headers: response.headers,
      body: Uint8Array.from(response.body),
      mediaType,
      settlement: structuredClone(settlement),
    });
  }
}

class AuthorizedVoucherSigner implements ChannelSigner {
  private movement?: BatchTreasuryMovementRecord;

  constructor(
    private readonly signer: ChannelSigner,
    private readonly authorizer: JournalBatchVoucherAuthorizer,
    private readonly input: Readonly<PrepareBatchPaymentInput>,
    private readonly requirementsDigest: Sha256Digest
  ) {}

  async generateChannelKey(): Promise<never> { throw new Error("batch Purchase cannot open a channel"); }
  async randomSalt(): Promise<never> { throw new Error("batch Purchase cannot create channel salt"); }
  async randomNonce(): Promise<never> { throw new Error("batch Purchase cannot create channel nonce"); }

  async signVoucher(request: Parameters<ChannelSigner["signVoucher"]>[0]) {
    if (this.movement) throw new Error("batch Purchase cannot sign more than one voucher");
    if (
      request.channel.id !== this.input.authorizedChannelId ||
      digestChannelEpoch(request.channel) !== this.input.authorizedChannelEpochDigest
    ) {
      throw new Error("batch channel epoch differs from the Trusted Authority approval");
    }
    this.movement = this.authorizer.authorize({
      purchaseId: this.input.purchaseId,
      channel: request.channel,
      maximumAuthorizedAtomic: this.input.amountAtomic,
      voucherCeilingAtomic: request.amount,
      requirementsDigest: this.requirementsDigest,
      requestHash: this.input.requestHash,
    });
    return this.signer.signVoucher(request);
  }

  requireMovement(): BatchTreasuryMovementRecord {
    if (!this.movement) throw new Error("batch voucher was not durably authorized before signing");
    return this.movement;
  }
}

function readOnlyBatchProvider(chain: BatchActiveUtxoSource): FundingProvider {
  const unavailable = async (): Promise<never> => { throw new Error("batch Purchase provider has no funding or broadcast authority"); };
  return Object.freeze({
    networkId: NETWORK,
    sourceKind: SOURCE,
    getPublicIdentity: unavailable,
    authorizeExactPayment: unavailable,
    fundEscrowDeposit: unavailable,
    payExactTransaction: unavailable,
    getUtxos: (addresses: readonly string[]) => chain.getUtxos([...addresses]),
    getVirtualDaaScore: () => chain.getVirtualDaaScore(),
    sendTransaction: unavailable,
    estimateFees: async () => ({ feeSompi: "0" }),
  });
}

function disabledSigner(): ChannelSigner {
  const unavailable = async (): Promise<never> => { throw new Error("settlement replay cannot sign"); };
  return { generateChannelKey: unavailable, randomSalt: unavailable, randomNonce: unavailable, signVoucher: unavailable };
}

function validateInput(input: Readonly<PrepareBatchPaymentInput>): void {
  if (input.network !== NETWORK || input.asset !== "KAS") throw new Error("batch Purchase profile is unsupported");
  atomic(input.amountAtomic, "batch maximum charge", true);
  atomic(input.claimFeeReserveAtomic, "batch claim-fee reserve");
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error("batch request hash is invalid");
  requireHash32(input.authorizedChannelId, "authorized batch channel ID");
  requireDigest(input.authorizedChannelEpochDigest, "authorized batch channel epoch");
  if (!(input.paymentRequirements instanceof Uint8Array) || input.paymentRequirements.byteLength === 0 || input.paymentRequirements.byteLength > 32 * 1024) {
    throw new Error("batch PAYMENT-REQUIRED artifact is invalid");
  }
}

function digestChannelEpoch(channel: DirectModeChannel): Sha256Digest {
  return evidenceDigest(Buffer.from(JSON.stringify({
    channelId: channel.id,
    activeOutpoint: {
      txid: channel.activeOutpoint.txid,
      index: channel.activeOutpoint.index,
    },
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmountAtomic: channel.fundingAmount,
    refundTimeoutDaa: channel.refundTimeoutDaa,
  }), "utf8"));
}

function requireHash32(value: unknown, label: string): Hash32Hex {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Hash32Hex;
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Sha256Digest;
}

function assertBatchRequirement(
  accepted: BatchPaymentRequirements,
  required: PaymentRequired,
  input: Readonly<PrepareBatchPaymentInput>
): void {
  if (
    accepted.scheme !== "batch-settlement" || accepted.network !== NETWORK || accepted.asset !== "KAS" ||
    accepted.amount !== input.amountAtomic || accepted.payTo !== input.payTo ||
    accepted.extra.binding !== "kaspa-escrow-v1" || accepted.extra.templateId !== "kaspa-x402-escrow-v1" ||
    required.resource.url !== input.resourceUrl
  ) throw new Error("batch PAYMENT-REQUIRED does not match the authorized Purchase");
}

function decodeEnvelope(bytes: Uint8Array): PersistedBatchEnvelope {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) {
    throw new Error("prepared batch envelope is invalid");
  }
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as PersistedBatchEnvelope;
  if (
    !parsed ||
    parsed.paymentPayload?.payload?.type !== "voucher" ||
    !/^[a-f0-9]{64}$/.test(parsed.executionId) ||
    !parsed.channelBefore ||
    parsed.channelBefore.id !== parsed.channelId ||
    parsed.channelBefore.activeOutpoint.txid !== parsed.activeOutpoint.txid ||
    parsed.channelBefore.activeOutpoint.index !== parsed.activeOutpoint.index
  ) {
    throw new Error("prepared batch envelope is malformed");
  }
  if (sha256Hex(stableStringify(parsed.paymentPayload)) !== parsed.executionId) {
    throw new Error("prepared batch execution identity changed");
  }
  return structuredClone(parsed);
}

function strictHeader(bytes: Uint8Array): string {
  const header = Buffer.from(bytes).toString("ascii");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(header) || Buffer.from(header, "ascii").byteLength !== bytes.byteLength) {
    throw new Error("batch PAYMENT-REQUIRED is not canonical compact ASCII");
  }
  return header;
}

function atomic(value: string, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) throw new Error(`${label} is outside uint64 bounds`);
  return parsed;
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  const result = left + right;
  if (result > UINT64_MAX) throw new Error(`${label} exceeds uint64 bounds`);
  return result;
}

function checkedSubtract(left: bigint, right: bigint, label: string): bigint {
  if (right > left) throw new Error(`${label} is negative`);
  return left - right;
}

function max(left: bigint, right: bigint): bigint { return left > right ? left : right; }

function requestHashHex(fingerprint: Sha256Digest): Hash32Hex {
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(fingerprint)) {
    throw new Error("batch request fingerprint is invalid");
  }
  return Buffer.from(fingerprint.slice("sha256:".length), "base64url").toString("hex") as Hash32Hex;
}

function assertEffect(
  effect: Parameters<KaspaPaymentModule["submit"]>[0]["effect"],
  context: KaspaPreparedExecutionContext,
  states: readonly string[]
): void {
  if (
    effect.purchaseId !== context.execution.purchaseId ||
    effect.attempt === undefined ||
    effect.kind !== "kaspa-x402-payment" ||
    effect.idempotencyKey !== `payment:${context.execution.paymentIdentifier}` ||
    effect.payloadDigest !== context.preparation.preparedDigest ||
    !states.includes(effect.state)
  ) {
    throw new Error("batch payment Effect is not bound to the immutable preparation");
  }
}

function sameChannelState(left: DirectModeChannel, right: DirectModeChannel): boolean {
  return stableStringify(left) === stableStringify(right);
}

function batchError(message: string, options?: unknown): Error {
  return new Error(message, options === undefined ? undefined : { cause: options });
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.name : "unknown";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("batch payment clock is invalid");
  return value;
}
