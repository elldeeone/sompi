import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

import type { AddressCodec } from "@kaspa-x402/client";
import {
  decodePaymentResponseHeader,
  encodePaymentResponseHeader,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  hexToBytes,
  sha256Hex,
  stableStringify,
  validatePaymentRetry,
  type ExactPaymentRequirements,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "@kaspa-x402/core";
import type { IdempotencyStore } from "@kaspa-x402/server";
import {
  buildKip10AdditiveBorrowArgs,
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import {
  Transaction,
  calculateTransactionFee,
  payToScriptHashSignatureScript,
} from "../../kaspa-wasm.js";
import { requestFingerprint } from "../../purchase/identity.js";
import type { Sha256Digest } from "../../purchase/types.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import { SOMPI_EXACT_FEE_POLICY } from "./exact-transaction-builder.js";
import type {
  ExactSettlementVerificationInput,
  ExactSettlementVerificationResult,
  ExactSettlementVerifier,
  KaspaExactRecoveryObserver,
  KaspaExactRecoveryProbe,
} from "./exact-payment-module.js";

const NETWORK = "kaspa:testnet-10" as const;
const ASSET = "KAS" as const;
const EXACT_SCHEME = "exact" as const;
const EXACT_BINDING = "kaspa-exact-v2" as const;
const EXACT_TEMPLATE = "kaspa-x402-kip10-additive-v1" as const;
const EXACT_ENCODING = "kaspa-sdk-safe-json-v2.0.0" as const;
const FUNDING_SOURCE = "vault-treasury" as const;
const SETTLEMENT_PROFILE = "kaspa-x402-0.1.0-alpha.8-exact-settlement";
const NATIVE_SUBNETWORK = "00".repeat(20);
const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SERIALIZED_V0_SCRIPT = /^0000(?:[a-f0-9]{2})+$/;
const HEX_BYTES = /^(?:[a-f0-9]{2})+$/;
const PAYMENT_IDENTIFIER = /^pay_[A-Za-z0-9_-]{43}$/;
const HEADER_ASCII = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UINT64_MAX = (1n << 64n) - 1n;
const MAX_PAYMENT_RESPONSE_HEADER_BYTES = 32 * 1024;
const MAX_TRANSACTION_ARTIFACT_BYTES = 2_000_000;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 15_000;
const MAX_CLOCK_FUTURE_SKEW_MS = 5 * 60_000;
const FINALITY_RANK = Object.freeze({ mempool: 0, accepted: 1, confirmed: 2 } as const);
const KIP10_PREFIX = "6320";
const KIP10_AFTER_OWNER = "ac67b9bfb9c388b9c2";
const KIP10_SUFFIX = "94b9bea268";

export type KaspaChainFinality = keyof typeof FINALITY_RANK;

export interface TreasuryStagingFeeRequest {
  purchaseId: ExactSettlementVerificationInput["context"]["execution"]["purchaseId"];
  paymentIdentifier: string;
  transactionId: Hash32Hex;
  outpoint: string;
  amountAtomic: string;
  evidenceDigest: Sha256Digest;
  deadlineAtMs: number;
  signal: AbortSignal;
}

/**
 * Narrow seam for the actual fee of the already-observed vault staging spend.
 * Runtime implementations join the canonical signed staging envelope to the
 * journaled staging observation before returning this value.
 */
export interface TreasuryStagingFeeSource {
  actualTransactionFeeAtomic(
    request: Readonly<TreasuryStagingFeeRequest>
  ): Promise<string | undefined>;
}

export interface ChainObservationRequest {
  network: typeof NETWORK;
  transactionId: Hash32Hex;
  outpoint: string;
  outputIndex: number;
  merchantAddress: string;
  expectedAmountAtomic: string;
  expectedScriptPublicKey: string;
  minimumFinality: KaspaChainFinality;
  deadlineAtMs: number;
  signal: AbortSignal;
}

export type ChainObservation =
  | { status: "pending"; detailDigest?: Sha256Digest }
  | {
      status: "observed";
      network: typeof NETWORK;
      transactionId: Hash32Hex;
      outpoint: string;
      amountAtomic: string;
      scriptPublicKey: string;
      finality: KaspaChainFinality;
      observedAtMs: number;
      detailDigest?: Sha256Digest;
    };

/** Read-only chain seam. It has deliberately no submission method. */
export interface ChainObservationSource {
  observeExactOutput(request: Readonly<ChainObservationRequest>): Promise<ChainObservation>;
}

export interface MerchantPaymentResponseLookupRequest {
  purchaseId: ExactSettlementVerificationInput["context"]["execution"]["purchaseId"];
  paymentIdentifier: string;
  transactionId: Hash32Hex;
  deadlineAtMs: number;
  signal: AbortSignal;
}

/** Read-only Merchant recovery seam, keyed by the durable payment identifier. */
export interface MerchantPaymentResponseLookup {
  findByPaymentIdentifier(
    request: Readonly<MerchantPaymentResponseLookupRequest>
  ): Promise<Uint8Array | undefined>;
}

export interface KaspaExactChainVerifierOptions {
  stagingMetadata: TreasuryStagingFeeSource;
  chain: ChainObservationSource;
  merchantResponses: MerchantPaymentResponseLookup;
  addressCodec?: AddressCodec;
  verifierId?: string;
  observationTimeoutMs?: number;
  now?: () => number;
  /** Wall clock used for the alpha.8 payer authorization expiry. */
  authorizationNow?: () => number;
}

export interface KaspaX402ServerStorePaymentResponseLookupOptions {
  store: IdempotencyStore;
  now?: () => number;
}

/**
 * Merchant recovery adapter for alpha.8's durable idempotency store. This
 * reads the already-committed PAYMENT-RESPONSE; it never invokes the paid
 * handler and therefore cannot accept or execute a second payment.
 */
export class KaspaX402ServerStorePaymentResponseLookup
  implements MerchantPaymentResponseLookup
{
  private readonly store: IdempotencyStore;
  private readonly now: () => number;

  constructor(options: KaspaX402ServerStorePaymentResponseLookupOptions) {
    if (typeof options?.store?.loadPaymentIdentifier !== "function") {
      throw error("source_failure", "Kaspa-x402 Merchant idempotency store is required");
    }
    this.store = options.store;
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async findByPaymentIdentifier(
    request: Readonly<MerchantPaymentResponseLookupRequest>
  ): Promise<Uint8Array | undefined> {
    request.signal.throwIfAborted();
    if (!Number.isSafeInteger(request.deadlineAtMs) || request.deadlineAtMs <= readClock(this.now)) {
      throw error("deadline_exceeded", "Merchant payment-response lookup deadline has expired");
    }
    const paymentIdentifier = requirePaymentIdentifier(request.paymentIdentifier);
    const transactionId = requireHash(request.transactionId, "Merchant lookup transaction ID");
    return boundedCall(
      "Merchant idempotency-store lookup",
      request.deadlineAtMs,
      this.now,
      request.signal,
      (signal) => this.findWithinDeadline(paymentIdentifier, transactionId, signal)
    );
  }

  private async findWithinDeadline(
    paymentIdentifier: string,
    transactionId: Hash32Hex,
    signal: AbortSignal
  ): Promise<Uint8Array | undefined> {
    const record = await raceSignal(
      this.store.loadPaymentIdentifier(paymentIdentifier),
      signal
    );
    signal.throwIfAborted();
    if (!record) return undefined;
    if (
      record.id !== paymentIdentifier ||
      record.transactionId !== transactionId ||
      record.settlement.success !== true ||
      record.settlement.transaction !== transactionId ||
      !Number.isSafeInteger(record.response.status) ||
      record.response.status < 200 ||
      record.response.status > 299
    ) {
      throw error(
        "payment_replay",
        "Merchant payment identifier is bound to a different or unsuccessful exact payment"
      );
    }
    const matches = Object.entries(record.response.headers).filter(
      ([name]) => name.toLowerCase() === "payment-response"
    );
    if (matches.length !== 1) {
      throw error("artifact_mismatch", "stored Merchant response has no unique PAYMENT-RESPONSE header");
    }
    const headerValue = matches[0][1];
    if (Buffer.from(headerValue, "ascii").toString("ascii") !== headerValue) {
      throw error("artifact_mismatch", "stored Merchant PAYMENT-RESPONSE is not ASCII");
    }
    const bytes = snapshotPaymentResponseHeader(Buffer.from(headerValue, "ascii"));
    let decoded: SettlementResponse;
    try {
      decoded = decodePaymentResponseHeader(Buffer.from(bytes).toString("ascii"));
    } catch (cause) {
      throw error("artifact_mismatch", "stored Merchant PAYMENT-RESPONSE cannot be decoded", {
        cause,
      });
    }
    if (
      encodePaymentResponseHeader(decoded) !== Buffer.from(bytes).toString("ascii") ||
      stableStringify(decoded) !== stableStringify(record.settlement)
    ) {
      throw error(
        "artifact_mismatch",
        "stored Merchant PAYMENT-RESPONSE differs from its durable Settlement record"
      );
    }
    return bytes;
  }
}

export type KaspaExactChainVerifierErrorCode =
  | "artifact_mismatch"
  | "chain_mismatch"
  | "cost_mismatch"
  | "finality_downgrade"
  | "payment_replay"
  | "deadline_exceeded"
  | "source_failure";

export class KaspaExactChainVerifierError extends Error {
  constructor(
    readonly code: KaspaExactChainVerifierErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "KaspaExactChainVerifierError";
  }
}

type ExactVerificationContext = ExactSettlementVerificationInput["context"] & {
  staging: NonNullable<ExactSettlementVerificationInput["context"]["staging"]>;
  preparation: ExactSettlementVerificationInput["context"]["preparation"] & {
    mechanism: "single-transaction";
    transactionId: string;
    requiredAssurance: "accepted" | "confirmed";
  };
};

interface ParsedExactPayment {
  context: ExactVerificationContext;
  accepted: ExactPaymentRequirements;
  transactionId: Hash32Hex;
  requestHash: Hash32Hex;
  paymentIdentifier: string;
  profile: "standard-native" | "additive";
  requestAuthorizationId: Hash32Hex;
  headId?: Hash32Hex;
  merchantOutputIndex: number;
  merchantOutputAmount: string;
  merchantScript: string;
  stagingScript: string;
  stagingAmount: bigint;
  threshold: bigint;
  exactFee: bigint;
  requiredFinality: KaspaChainFinality;
  bindingDigest: Sha256Digest;
}

interface PaymentBindingState {
  digest: Sha256Digest;
  highestFinality?: KaspaChainFinality;
}

/**
 * Deep alpha.8 adapter implementing both Settlement verification and passive
 * recovery. It revalidates the immutable exact transaction independently of
 * the Merchant and only accepts chain-attested Merchant output facts.
 */
export class KaspaExactChainVerifier
  implements ExactSettlementVerifier, KaspaExactRecoveryObserver
{
  private readonly stagingMetadata: TreasuryStagingFeeSource;
  private readonly chain: ChainObservationSource;
  private readonly merchantResponses: MerchantPaymentResponseLookup;
  private readonly addressCodec: AddressCodec;
  private readonly verifierId: string;
  private readonly observationTimeoutMs: number;
  private readonly now: () => number;
  private readonly authorizationNow: () => number;
  private readonly bindings = new Map<string, PaymentBindingState>();

  constructor(options: KaspaExactChainVerifierOptions) {
    if (typeof options?.stagingMetadata?.actualTransactionFeeAtomic !== "function") {
      throw error("source_failure", "Treasury staging metadata source is required");
    }
    if (typeof options?.chain?.observeExactOutput !== "function") {
      throw error("source_failure", "chain observation source is required");
    }
    if (typeof options?.merchantResponses?.findByPaymentIdentifier !== "function") {
      throw error("source_failure", "Merchant payment-response lookup is required");
    }
    if (options.addressCodec !== undefined && typeof options.addressCodec.scriptPublicKeyForAddress !== "function") {
      throw error("source_failure", "Kaspa address codec is invalid");
    }
    this.stagingMetadata = options.stagingMetadata;
    this.chain = options.chain;
    this.merchantResponses = options.merchantResponses;
    this.addressCodec = options.addressCodec ?? new KaspaTestnet10AddressCodec();
    this.verifierId = requireBoundedIdentifier(
      options.verifierId ?? "sompi:kaspa-chain-verifier:alpha.8",
      "Settlement verifier identity"
    );
    this.observationTimeoutMs = requireTimeout(
      options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS
    );
    this.now = options.now ?? Date.now;
    this.authorizationNow = options.authorizationNow ?? Date.now;
    readClock(this.now);
    readClock(this.authorizationNow);
  }

  async verify(
    input: Readonly<ExactSettlementVerificationInput>
  ): Promise<ExactSettlementVerificationResult> {
    const parsed = parseExactPayment(
      input.context,
      input.paymentRequired,
      input.paymentPayload,
      input.transactionId,
      this.addressCodec,
      {
        allowExpired: input.source === "recovery-observer",
        nowMs: readClock(this.now),
        authorizationNowMs: readClock(this.authorizationNow),
      }
    );
    validateSettlementResponse(input.response, parsed);
    this.claimBinding(parsed);

    const deadlineAtMs = checkedDeadline(readClock(this.now), this.observationTimeoutMs);
    const stagingFeeValue = await boundedCall(
      "Treasury staging metadata",
      deadlineAtMs,
      this.now,
      undefined,
      (signal) => this.stagingMetadata.actualTransactionFeeAtomic({
        purchaseId: parsed.context.execution.purchaseId,
        paymentIdentifier: parsed.paymentIdentifier,
        transactionId: requireHash(parsed.context.staging.transactionId, "staging transaction ID"),
        outpoint: parsed.context.staging.outpoint,
        amountAtomic: parsed.context.staging.amountAtomic,
        evidenceDigest: requireDigest(
          parsed.context.staging.evidenceDigest,
          "staging evidence digest"
        ),
        deadlineAtMs,
        signal,
      })
    );
    if (stagingFeeValue === undefined) {
      throw error("cost_mismatch", "actual Treasury staging fee is unavailable");
    }
    const stagingFee = uint64(stagingFeeValue, "actual Treasury staging fee");
    const additionalCost = checkedAdd(
      parsed.exactFee,
      stagingFee,
      "complete exact Purchase additional cost"
    );
    validateFullTreasuryBounds(parsed, stagingFee, additionalCost);

    const responseFinality = settlementFinality(input.response);
    const minimumFinality = strongerFinality(parsed.requiredFinality, responseFinality);
    const chainObservation = await this.observeChain(parsed, minimumFinality, deadlineAtMs);
    if (chainObservation.status !== "observed") {
      throw error("chain_mismatch", "Merchant exact output is not attested by the Kaspa chain source");
    }
    validateChainObservation(chainObservation, parsed, minimumFinality, readClock(this.now));
    this.recordFinality(parsed, chainObservation.finality);

    return Object.freeze({
      additionalCostAtomic: additionalCost.toString(),
      outpoint: `${parsed.transactionId}:${parsed.merchantOutputIndex}`,
      verification: Object.freeze({
        verifierId: this.verifierId,
        profile: SETTLEMENT_PROFILE,
        detailDigest: digestCanonical({
          profile: SETTLEMENT_PROFILE,
          source: input.source,
          paymentIdentifier: parsed.paymentIdentifier,
          transactionId: parsed.transactionId,
          merchantOutpoint: chainObservation.outpoint,
          merchantAmountAtomic: chainObservation.amountAtomic,
          merchantScriptPublicKey: chainObservation.scriptPublicKey,
          chainFinality: chainObservation.finality,
          requiredFinality: parsed.requiredFinality,
          stagingFeeAtomic: stagingFee.toString(),
          additiveThresholdAtomic: parsed.threshold.toString(),
          exactTransactionFeeAtomic: parsed.exactFee.toString(),
          additionalCostAtomic: additionalCost.toString(),
          requestHash: parsed.requestHash,
          exactProfile: parsed.profile,
          requestAuthorizationId: parsed.requestAuthorizationId,
          ...(parsed.headId === undefined ? {} : { headId: parsed.headId }),
          paymentResponseDigest: digestBytes(input.evidenceBytes),
        }),
      }),
    });
  }

  async observe(input: Parameters<KaspaExactRecoveryObserver["observe"]>[0]): Promise<KaspaExactRecoveryProbe> {
    if (input.signal.aborted) throw abortError(input.signal);
    const parsed = parseExactPayment(
      input.context,
      input.paymentRequired,
      input.paymentPayload,
      input.transactionId,
      this.addressCodec,
      {
        allowExpired: true,
        nowMs: readClock(this.now),
        authorizationNowMs: readClock(this.authorizationNow),
      }
    );
    this.claimBinding(parsed);
    const deadlineAtMs = checkedDeadline(readClock(this.now), this.observationTimeoutMs);

    // Merchant evidence is authoritative for an already-accepted retry, so it
    // is always queried before the chain. Neither branch submits anything.
    const paymentResponse = await boundedCall(
      "Merchant payment-response lookup",
      deadlineAtMs,
      this.now,
      input.signal,
      (signal) => this.merchantResponses.findByPaymentIdentifier({
        purchaseId: parsed.context.execution.purchaseId,
        paymentIdentifier: parsed.paymentIdentifier,
        transactionId: parsed.transactionId,
        deadlineAtMs,
        signal,
      })
    );
    if (paymentResponse !== undefined) {
      return {
        status: "payment_response",
        paymentResponseHeader: snapshotPaymentResponseHeader(paymentResponse),
      };
    }

    const chainObservation = await this.observeChain(
      parsed,
      "mempool",
      deadlineAtMs,
      input.signal
    );
    if (chainObservation.status === "observed") {
      validateChainObservation(chainObservation, parsed, "mempool", readClock(this.now));
      this.recordFinality(parsed, chainObservation.finality);
      return { status: "transaction_observed" };
    }
    return {
      status: "pending",
      detailDigest: chainObservation.detailDigest ?? digestCanonical({
        profile: SETTLEMENT_PROFILE,
        status: "pending",
        paymentIdentifier: parsed.paymentIdentifier,
        transactionId: parsed.transactionId,
        outpoint: `${parsed.transactionId}:${parsed.merchantOutputIndex}`,
      }),
    };
  }

  private async observeChain(
    parsed: ParsedExactPayment,
    minimumFinality: KaspaChainFinality,
    deadlineAtMs: number,
    callerSignal?: AbortSignal
  ): Promise<ChainObservation> {
    return boundedCall(
      "Kaspa chain observation",
      deadlineAtMs,
      this.now,
      callerSignal,
      (signal) => this.chain.observeExactOutput({
        network: NETWORK,
        transactionId: parsed.transactionId,
        outpoint: `${parsed.transactionId}:${parsed.merchantOutputIndex}`,
        outputIndex: parsed.merchantOutputIndex,
        merchantAddress: parsed.context.execution.terms.payTo,
        expectedAmountAtomic: parsed.merchantOutputAmount,
        expectedScriptPublicKey: parsed.merchantScript,
        minimumFinality,
        deadlineAtMs,
        signal,
      })
    );
  }

  private claimBinding(parsed: ParsedExactPayment): void {
    const current = this.bindings.get(parsed.paymentIdentifier);
    if (current && current.digest !== parsed.bindingDigest) {
      throw error(
        "payment_replay",
        "payment identifier was replayed with different exact Purchase or transaction facts"
      );
    }
    if (!current) this.bindings.set(parsed.paymentIdentifier, { digest: parsed.bindingDigest });
  }

  private recordFinality(parsed: ParsedExactPayment, finality: KaspaChainFinality): void {
    const state = this.bindings.get(parsed.paymentIdentifier);
    if (!state || state.digest !== parsed.bindingDigest) {
      throw error("payment_replay", "payment binding changed during chain observation");
    }
    if (
      state.highestFinality !== undefined &&
      FINALITY_RANK[finality] < FINALITY_RANK[state.highestFinality]
    ) {
      throw error(
        "finality_downgrade",
        `chain finality regressed from ${state.highestFinality} to ${finality}`
      );
    }
    state.highestFinality = finality;
  }
}

function assertExactVerificationContext(
  context: ExactSettlementVerificationInput["context"]
): asserts context is ExactVerificationContext {
  if (
    !context.staging ||
    context.preparation.mechanism !== "single-transaction" ||
    context.preparation.transactionId === undefined ||
    context.preparation.requiredAssurance === "channel-commitment"
  ) {
    throw error("artifact_mismatch", "exact Purchase execution context is incomplete");
  }
}

function parseExactPayment(
  context: ExactSettlementVerificationInput["context"],
  paymentRequired: PaymentRequired,
  paymentPayload: PaymentPayload,
  transactionIdValue: string,
  addressCodec: AddressCodec,
  options: { allowExpired: boolean; nowMs: number; authorizationNowMs: number }
): ParsedExactPayment {
  if (!context || typeof context !== "object") {
    throw error("artifact_mismatch", "exact Purchase execution context is missing");
  }
  assertExactVerificationContext(context);
  const transactionId = requireHash(transactionIdValue, "exact transaction ID");
  if (
    context.execution.terms.network !== NETWORK ||
    context.execution.terms.asset !== ASSET ||
    context.execution.authorization.decision !== "approved" ||
    context.preparation.fundingSource !== FUNDING_SOURCE ||
    context.staging.fundingSource !== FUNDING_SOURCE ||
    context.preparation.transactionId !== transactionId
  ) {
    throw error("artifact_mismatch", "exact transaction is outside the authorised testnet-10 profile");
  }
  const paymentIdentifier = requirePaymentIdentifier(context.execution.paymentIdentifier);
  const recomputedFingerprint = requestFingerprint({
    url: context.request.url,
    method: context.request.method,
    ...(context.request.mediaType === undefined ? {} : { mediaType: context.request.mediaType }),
    body: context.request.body,
  });
  if (
    recomputedFingerprint !== context.request.requestFingerprint ||
    recomputedFingerprint !== context.execution.terms.resourceFingerprint
  ) {
    throw error("artifact_mismatch", "exact request hash is not derived from the authorised HTTP request");
  }
  const requestHash = digestToHash32(recomputedFingerprint, "exact request fingerprint");
  const checkoutExpiry = canonicalTime(context.execution.terms.expiresAt, "Checkout expiry");
  if (!options.allowExpired && checkoutExpiry <= options.nowMs) {
    throw error("artifact_mismatch", "Checkout Terms expired before Settlement verification");
  }
  const authorizedCeiling = uint64(
    context.execution.authorizationRequest.additionalCostCeilingAtomic,
    "authorised additional-cost ceiling"
  );
  void authorizedCeiling;
  assertAuthorizationBindings(context);
  requireDigest(context.staging.evidenceDigest, "staging evidence digest");
  const stagingOutpoint = parseOutpointString(context.staging.outpoint, "observed staging outpoint");
  if (stagingOutpoint.transactionId !== requireHash(context.staging.transactionId, "staging transaction ID")) {
    throw error("artifact_mismatch", "observed staging outpoint is bound to a different transaction");
  }
  const stagingAmount = uint64(context.staging.amountAtomic, "observed staging amount", { positive: true });

  const retry = validatePaymentRetry({ paymentRequired, paymentPayload });
  if (!retry.ok) {
    throw error("artifact_mismatch", "alpha.8 PaymentRequired/PaymentPayload pair is invalid", {
      cause: retry.error,
    });
  }
  if (
    paymentRequired.x402Version !== 2 ||
    paymentPayload.x402Version !== 2 ||
    paymentRequired.resource.url !== context.request.url ||
    !Array.isArray(paymentRequired.accepts) ||
    paymentRequired.accepts.length !== 1 ||
    stableStringify(paymentRequired.accepts[0]) !== stableStringify(paymentPayload.accepted)
  ) {
    throw error("artifact_mismatch", "alpha.8 payment artifacts changed the exact resource or requirement");
  }
  const accepted = paymentPayload.accepted;
  const extra = accepted.extra;
  if (
    accepted.scheme !== EXACT_SCHEME ||
    accepted.network !== NETWORK ||
    accepted.asset !== ASSET ||
    accepted.amount !== context.execution.terms.amountAtomic ||
    accepted.payTo !== context.execution.terms.payTo ||
    extra.binding !== EXACT_BINDING ||
    (extra.profile !== "standard-native" && extra.profile !== "additive") ||
    extra.transactionEncoding !== EXACT_ENCODING ||
    (extra.profile === "standard-native"
      ? extra.paymentOutputIndex !== undefined
      : extra.paymentOutputIndex !== 0)
  ) {
    throw error("artifact_mismatch", "exact payment requirement does not match Checkout Terms");
  }
  if (!Number.isSafeInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds <= 0) {
    throw error("artifact_mismatch", "exact payment timeout is invalid");
  }
  assertPaymentIdentifierExtensions(paymentRequired, paymentPayload, paymentIdentifier);
  const profile = extra.profile;
  const requiredFinality = requireFinality(extra.finality, "exact required finality");
  if (requiredFinality === "mempool" || context.preparation.requiredAssurance !== requiredFinality) {
    throw error("artifact_mismatch", "durable exact finality changed from the Merchant requirement");
  }
  let merchantScript: string;
  try {
    merchantScript = String(addressCodec.scriptPublicKeyForAddress(accepted.payTo, NETWORK)).toLowerCase();
  } catch (cause) {
    throw error("artifact_mismatch", "Checkout payee address is invalid for testnet-10", { cause });
  }
  if (canonicalScript(extra.payToScriptPublicKey, "exact payTo script") !== merchantScript) {
    throw error("artifact_mismatch", "payTo address and payment script differ");
  }

  if (paymentPayload.payload.type !== "exact-transaction") {
    throw error("artifact_mismatch", "PaymentPayload is not alpha.8 exact-transaction");
  }
  const payload = paymentPayload.payload;
  if (
    payload.transactionEncoding !== EXACT_ENCODING ||
    payload.paymentOutputIndex !== 0 ||
    requireHash(payload.requestHash, "PaymentPayload request hash") !== requestHash ||
    typeof payload.transaction !== "string" ||
    payload.transaction.length === 0 ||
    Buffer.byteLength(payload.transaction, "utf8") > MAX_TRANSACTION_ARTIFACT_BYTES
  ) {
    throw error("artifact_mismatch", "PaymentPayload changed the immutable exact transaction profile");
  }

  let transaction: Transaction | undefined;
  let minimumExactFee = 0n;
  try {
    transaction = Transaction.deserializeFromSafeJSON(payload.transaction);
    const finalized = String(transaction.finalize()).toLowerCase();
    if (finalized !== transactionId || transaction.serializeToSafeJSON() !== payload.transaction) {
      throw error("artifact_mismatch", "safe-JSON exact transaction is non-canonical or ID-mismatched");
    }
    minimumExactFee = calculateTransactionFee("testnet-10", transaction) ?? 0n;
  } catch (cause) {
    if (cause instanceof KaspaExactChainVerifierError) throw cause;
    throw error("artifact_mismatch", "safe-JSON exact transaction cannot be rehydrated", { cause });
  } finally {
    transaction?.free();
  }

  const document = parseJsonRecord(payload.transaction, "safe-JSON exact transaction");
  const inputs = requireArray(document.inputs, "exact transaction inputs");
  const outputs = requireArray(document.outputs, "exact transaction outputs");
  const commonEnvelope =
    document.id === transactionId &&
    document.lockTime === "0" &&
    document.subnetworkId === NATIVE_SUBNETWORK &&
    document.gas === "0" &&
    document.payload === "" &&
    outputs.length === 1;
  if (!commonEnvelope) throw error("artifact_mismatch", "safe-JSON exact transaction envelope changed");

  let stagingInput: ReturnType<typeof validateVersionedInput>;
  let threshold = 0n;
  let merchantOutputAmount = context.execution.terms.amountAtomic;
  let headId: Hash32Hex | undefined;
  if (profile === "standard-native") {
    if (document.version !== 0 || inputs.length !== 1 || hasAnyAdditiveFact(extra)) {
      throw error("artifact_mismatch", "standard-native exact contains additive or v1 transaction facts");
    }
    stagingInput = validateVersionedInput(inputs[0], {
      transactionId: stagingOutpoint.transactionId,
      index: stagingOutpoint.index,
      amountAtomic: stagingAmount.toString(),
      version: 0,
      // Rust's semantic v0 commitment is SigOpCount-only, while the pinned
      // WASM safe-JSON v2.0.0 serializer emits the inactive numeric field as
      // zero. SigOpCount remains the authoritative version-0 commitment.
      computeBudget: 0,
      sigOpCount: 1,
    });
    validateOutput(outputs[0], context.execution.terms.amountAtomic, merchantScript);
  } else {
    if (
      document.version !== 1 ||
      inputs.length !== 2 ||
      extra.templateId !== EXACT_TEMPLATE ||
      !extra.expectedHeadOutpoint
    ) {
      throw error("artifact_mismatch", "additive exact head or v1 transaction facts are incomplete");
    }
    headId = requireHash(extra.headId, "additive head ID");
    const challengeId = requireHash(extra.challengeId, "additive challenge ID");
    const challengeExpiry = canonicalTime(extra.challengeExpiresAt, "additive challenge expiry");
    if (!options.allowExpired && challengeExpiry <= options.nowMs) {
      throw error("artifact_mismatch", "additive challenge expired before Settlement verification");
    }
    const headOutpoint = {
      transactionId: requireHash(extra.expectedHeadOutpoint.txid, "head transaction ID"),
      index: uint32(extra.expectedHeadOutpoint.index, "head output index"),
    };
    if (headOutpoint.index !== 0) throw error("artifact_mismatch", "additive head must use index 0");
    const headAmount = uint64(extra.headAmount, "head amount", { positive: true });
    threshold = uint64(extra.additiveThresholdSompi, "additive threshold", { positive: true });
    const price = uint64(accepted.amount, "Merchant price", { positive: true });
    if (price < threshold) throw error("artifact_mismatch", "Merchant price is below additive threshold");
    const headScript = canonicalScript(extra.headScriptPublicKey, "head script public key");
    const headRedeem = canonicalHex(extra.headRedeemScript, "head redeem script");
    validateKip10Head(headRedeem, headScript, threshold);
    if (headScript !== merchantScript) throw error("artifact_mismatch", "additive payTo is not the head script");
    const headSignature = payToScriptHashSignatureScript(
      headRedeem,
      buildKip10AdditiveBorrowArgs()
    ).toLowerCase();
    validateVersionedInput(inputs[0], {
      transactionId: headOutpoint.transactionId,
      index: headOutpoint.index,
      amountAtomic: headAmount.toString(),
      scriptPublicKey: headScript,
      signatureScript: headSignature,
      version: 1,
      computeBudget: SOMPI_EXACT_FEE_POLICY.kip10BorrowComputeBudget,
      sigOpCount: 0,
    });
    stagingInput = validateVersionedInput(inputs[1], {
      transactionId: stagingOutpoint.transactionId,
      index: stagingOutpoint.index,
      amountAtomic: stagingAmount.toString(),
      version: 1,
      computeBudget: SOMPI_EXACT_FEE_POLICY.p2pkComputeBudget,
      sigOpCount: 0,
    });
    merchantOutputAmount = checkedAdd(headAmount, price, "additive successor").toString();
    validateOutput(outputs[0], merchantOutputAmount, headScript);
    void challengeId;
  }

  const stagingScript = stagingInput.scriptPublicKey;
  if (payload.payerAddress !== undefined) {
    const payerScript = String(addressCodec.scriptPublicKeyForAddress(payload.payerAddress, NETWORK)).toLowerCase();
    if (payerScript !== stagingScript) {
      throw error("artifact_mismatch", "PaymentPayload payer address is not the observed staging key");
    }
  }
  const publicKeyMatch = /^000020([a-f0-9]{64})ac$/.exec(stagingScript);
  if (!publicKeyMatch) throw error("artifact_mismatch", "staging input is not canonical Schnorr P2PK");
  const authorizationInputIndex = profile === "additive" ? 1 : 0;
  const expectedAuthorizationDigest = exactRequestAuthorizationDigest({
    network: NETWORK,
    profile,
    transactionId,
    paymentOutputIndex: 0,
    amount: accepted.amount,
    payTo: accepted.payTo,
    payToScriptPublicKey: merchantScript,
    paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    requestHash,
    ...(profile === "additive" ? { challengeId: requireHash(extra.challengeId, "challenge ID") } : {}),
    inputIndex: authorizationInputIndex,
    expiresAt: payload.authorization.expiresAt,
  });
  if (
    payload.authorization.version !== "kaspa-x402-exact-request-authorization-v1" ||
    payload.authorization.inputIndex !== authorizationInputIndex ||
    payload.authorization.digest !== expectedAuthorizationDigest ||
    (!options.allowExpired &&
      canonicalTime(payload.authorization.expiresAt, "authorization expiry") <=
        options.authorizationNowMs) ||
    !schnorr.verify(
      hexToBytes(payload.authorization.signature, { expectedLength: 64 }),
      hexToBytes(expectedAuthorizationDigest, { expectedLength: 32 }),
      hexToBytes(publicKeyMatch[1]!, { expectedLength: 32 })
    )
  ) {
    throw error("artifact_mismatch", "payer request authorization is invalid or differently bound");
  }
  const requestAuthorizationId = exactRequestAuthorizationId(payload.authorization);

  const outputTotal = outputAmount(outputs[0], "exact output 0");
  const inputTotal = profile === "additive"
    ? checkedAdd(uint64(extra.headAmount, "head amount", { positive: true }), stagingAmount, "exact input total")
    : stagingAmount;
  if (outputTotal >= inputTotal) throw error("cost_mismatch", "exact transaction has no positive fee");
  const exactFee = inputTotal - outputTotal;
  if (exactFee.toString() !== SOMPI_EXACT_FEE_POLICY.feeSompi || exactFee < minimumExactFee) {
    throw error("cost_mismatch", "exact transaction fee changed from the bounded fee policy");
  }
  if (stagingAmount !== checkedAdd(uint64(accepted.amount, "Merchant price", { positive: true }), exactFee, "staging requirement")) {
    throw error("cost_mismatch", "exact staging does not equal price plus fee");
  }

  const bindingDigest = digestCanonical({
    profile: SETTLEMENT_PROFILE,
    exactProfile: profile,
    purchaseId: context.execution.purchaseId,
    paymentIdentifier,
    checkoutDigest: context.execution.terms.checkoutDigest,
    resourceFingerprint: recomputedFingerprint,
    transactionId,
    transactionArtifactDigest: digestBytes(Buffer.from(payload.transaction, "utf8")),
    amountAtomic: accepted.amount,
    payTo: accepted.payTo,
    requestHash,
    requestAuthorizationId,
    ...(headId === undefined ? {} : { headId }),
    stagingOutpoint: context.staging.outpoint,
    stagingAmountAtomic: context.staging.amountAtomic,
  });
  return {
    context,
    accepted,
    transactionId,
    requestHash,
    paymentIdentifier,
    profile,
    requestAuthorizationId,
    ...(headId === undefined ? {} : { headId }),
    merchantOutputIndex: 0,
    merchantOutputAmount,
    merchantScript,
    stagingScript,
    stagingAmount,
    threshold,
    exactFee,
    requiredFinality,
    bindingDigest,
  };
}

function assertAuthorizationBindings(
  context: ExactSettlementVerificationInput["context"]
): void {
  const { execution, request } = context;
  const { terms, authorizationRequest, authorization } = execution;
  const facts = authorization.facts;
  const requestBodyDigest = digestBytes(request.body);
  const expected: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["authorization Purchase", authorizationRequest.purchaseId, execution.purchaseId],
    ["authorization decision Purchase", authorization.purchaseId, execution.purchaseId],
    ["authorization Checkout", authorization.checkoutDigest, terms.checkoutDigest],
    ["authorization request URL", authorizationRequest.resourceUrl, request.url],
    ["authorization method", authorizationRequest.method, request.method],
    ["authorization request media type", authorizationRequest.requestMediaType, request.mediaType ?? ""],
    ["authorization request body", authorizationRequest.requestBodyDigest, requestBodyDigest],
    ["authorization terms", stableStringify(authorizationRequest.terms), stableStringify(terms)],
    ["fact Purchase", facts.purchaseId, execution.purchaseId],
    ["fact resource", facts.resourceFingerprint, terms.resourceFingerprint],
    ["fact Merchant", facts.merchantId, terms.merchant.id],
    ["fact Merchant origin", facts.merchantOrigin, terms.merchant.origin],
    ["fact amount", facts.amountAtomic, terms.amountAtomic],
    ["fact asset", facts.asset, ASSET],
    ["fact network", facts.network, NETWORK],
    ["fact payee", facts.payTo, terms.payTo],
    ["fact Checkout", facts.checkoutDigest, terms.checkoutDigest],
    [
      "fact additional-cost ceiling",
      facts.additionalCostCeilingAtomic,
      authorizationRequest.additionalCostCeilingAtomic,
    ],
  ];
  for (const [label, actual, wanted] of expected) {
    if (actual !== wanted) {
      throw error("artifact_mismatch", `${label} is not bound to the exact Purchase`);
    }
  }
}

function validateSettlementResponse(
  response: SettlementResponse,
  parsed: ParsedExactPayment
): void {
  const extension = response.extensions?.kaspa ?? response.extra;
  if (
    response.extensions?.kaspa !== undefined &&
    response.extra !== undefined &&
    stableStringify(response.extensions.kaspa) !== stableStringify(response.extra)
  ) {
    throw error("artifact_mismatch", "Settlement response carries conflicting Kaspa extension facts");
  }
  if (
    response.success !== true ||
    response.transaction !== parsed.transactionId ||
    response.network !== NETWORK ||
    response.amount !== parsed.context.execution.terms.amountAtomic ||
    !extension ||
    extension.paymentOutputIndex !== parsed.merchantOutputIndex ||
    extension.requestHash !== parsed.requestHash ||
    extension.transactionEncoding !== EXACT_ENCODING ||
    extension.exactProfile !== parsed.profile ||
    (parsed.profile === "additive" &&
      (extension.templateId !== EXACT_TEMPLATE ||
       extension.headId !== parsed.headId))
  ) {
    throw error("artifact_mismatch", "Settlement response changed exact transaction or profile facts");
  }
  settlementFinality(response);
}

function settlementFinality(response: SettlementResponse): KaspaChainFinality {
  const extension = response.extensions?.kaspa ?? response.extra;
  return requireFinality(extension?.finality, "Settlement response finality");
}

function validateFullTreasuryBounds(
  parsed: ParsedExactPayment,
  stagingFee: bigint,
  additionalCost: bigint
): void {
  const price = uint64(parsed.context.execution.terms.amountAtomic, "Merchant price", {
    positive: true,
  });
  const ceiling = uint64(
    parsed.context.execution.authorizationRequest.additionalCostCeilingAtomic,
    "authorised additional-cost ceiling"
  );
  if (additionalCost > ceiling) {
    throw error("cost_mismatch", "complete exact Purchase additional cost exceeds authorisation");
  }
  const stagedOutflow = checkedAdd(parsed.stagingAmount, stagingFee, "staged Treasury outflow");
  const authorisedGross = checkedAdd(price, ceiling, "authorised gross Treasury outflow");
  if (stagedOutflow > authorisedGross) {
    throw error("cost_mismatch", "staging amount plus its actual fee exceeds the authorised gross bound");
  }
  const minimumStaging = checkedAdd(
    price,
    parsed.exactFee,
    "price and exact fee"
  );
  if (parsed.stagingAmount < minimumStaging) {
    throw error("cost_mismatch", "observed staging output cannot fund price and exact fee");
  }
}

function validateChainObservation(
  observation: Extract<ChainObservation, { status: "observed" }>,
  parsed: ParsedExactPayment,
  minimumFinality: KaspaChainFinality,
  nowMs: number
): void {
  requireAllowedKeys(observation, [
    "status",
    "network",
    "transactionId",
    "outpoint",
    "amountAtomic",
    "scriptPublicKey",
    "finality",
    "observedAtMs",
    "detailDigest",
  ], "chain observation");
  const wantedOutpoint = `${parsed.transactionId}:${parsed.merchantOutputIndex}`;
  if (
    observation.network !== NETWORK ||
    requireHash(observation.transactionId, "chain-observed transaction ID") !== parsed.transactionId ||
    observation.outpoint !== wantedOutpoint ||
    uint64(observation.amountAtomic, "chain-observed Merchant amount", { positive: true }) !==
      uint64(parsed.merchantOutputAmount, "expected exact output amount", { positive: true }) ||
    canonicalScript(observation.scriptPublicKey, "chain-observed Merchant script") !== parsed.merchantScript
  ) {
    throw error("chain_mismatch", "Kaspa chain observation does not attest the exact Merchant output");
  }
  const finality = requireFinality(observation.finality, "chain-observed finality");
  if (FINALITY_RANK[finality] < FINALITY_RANK[minimumFinality]) {
    throw error(
      "finality_downgrade",
      `chain finality ${finality} is below required ${minimumFinality}`
    );
  }
  if (
    !Number.isSafeInteger(observation.observedAtMs) ||
    observation.observedAtMs <= 0 ||
    observation.observedAtMs > nowMs + MAX_CLOCK_FUTURE_SKEW_MS
  ) {
    throw error("chain_mismatch", "chain observation timestamp is invalid");
  }
  if (observation.detailDigest !== undefined) {
    requireDigest(observation.detailDigest, "chain observation detail digest");
  }
}

function hasAnyAdditiveFact(extra: ExactPaymentRequirements["extra"]): boolean {
  return [
    extra.templateId,
    extra.headId,
    extra.headVersion,
    extra.expectedHeadOutpoint,
    extra.headAmount,
    extra.headScriptPublicKey,
    extra.headRedeemScript,
    extra.challengeId,
    extra.challengeExpiresAt,
    extra.additiveThresholdSompi,
  ].some((value) => value !== undefined);
}

function validateVersionedInput(
  value: unknown,
  expected: {
    transactionId: string;
    index: number;
    amountAtomic: string;
    version: 0 | 1;
    computeBudget: number | null;
    sigOpCount: number;
    scriptPublicKey?: string;
    signatureScript?: string;
  }
): { scriptPublicKey: string } {
  const input = requireRecord(value, "exact transaction input");
  const utxo = requireRecord(input.utxo, "exact transaction input UTXO");
  const script = canonicalScript(utxo.scriptPublicKey, "exact input script public key");
  const signature = canonicalHex(input.signatureScript, "exact input signature script");
  if (
    input.transactionId !== expected.transactionId ||
    input.index !== expected.index ||
    input.sequence !== "0" ||
    input.sigOpCount !== expected.sigOpCount ||
    input.computeBudget !== expected.computeBudget ||
    utxo.amount !== expected.amountAtomic ||
    utxo.address !== null ||
    utxo.covenantId !== null ||
    utxo.isCoinbase !== false ||
    (expected.scriptPublicKey !== undefined && script !== expected.scriptPublicKey) ||
    (expected.signatureScript !== undefined && signature !== expected.signatureScript)
  ) {
    throw error("artifact_mismatch", "exact transaction input facts changed");
  }
  if (expected.signatureScript === undefined && !/^[a-f0-9]{132}$/.test(signature)) {
    throw error("artifact_mismatch", "payer input signature is not canonical Schnorr SIGHASH_ALL");
  }
  uint64(utxo.blockDaaScore, "exact input DAA score");
  return { scriptPublicKey: script };
}

function validateInput(
  value: unknown,
  expected: {
    transactionId: string;
    index: number;
    amountAtomic: string;
    scriptPublicKey?: string;
    signatureScript?: string;
    blockDaaScore?: string;
    stagingSignature: boolean;
  }
): { scriptPublicKey: string } {
  const input = requireRecord(value, "exact transaction input");
  const utxo = requireRecord(input.utxo, "exact transaction input UTXO");
  requireAllowedKeys(input, [
    "transactionId",
    "index",
    "signatureScript",
    "sequence",
    "sigOpCount",
    "computeBudget",
    "utxo",
  ], "exact transaction input");
  requireAllowedKeys(utxo, [
    "address",
    "amount",
    "scriptPublicKey",
    "blockDaaScore",
    "isCoinbase",
    "covenantId",
  ], "exact transaction input UTXO");
  const script = canonicalScript(utxo.scriptPublicKey, "exact input script public key");
  const signature = canonicalHex(input.signatureScript, "exact input signature script");
  if (
    input.transactionId !== expected.transactionId ||
    input.index !== expected.index ||
    input.sequence !== "0" ||
    input.sigOpCount !== 0 ||
    input.computeBudget !== SOMPI_EXACT_FEE_POLICY.p2pkComputeBudget ||
    utxo.amount !== expected.amountAtomic ||
    utxo.address !== null ||
    utxo.covenantId !== null ||
    utxo.isCoinbase !== false ||
    (expected.scriptPublicKey !== undefined && script !== expected.scriptPublicKey) ||
    (expected.signatureScript !== undefined && signature !== expected.signatureScript) ||
    (expected.blockDaaScore !== undefined && utxo.blockDaaScore !== expected.blockDaaScore)
  ) {
    throw error("artifact_mismatch", "exact transaction input facts changed");
  }
  if (expected.stagingSignature && !/^[a-f0-9]{132}$/.test(signature)) {
    throw error("artifact_mismatch", "staging input signature is not the pinned Schnorr script shape");
  }
  uint64(utxo.blockDaaScore, "exact input DAA score");
  return { scriptPublicKey: script };
}

function validateOutput(value: unknown, amount: string | undefined, scriptPublicKey: string): bigint {
  const output = requireRecord(value, "exact transaction output");
  requireAllowedKeys(output, ["value", "scriptPublicKey", "covenant"], "exact transaction output");
  const parsedAmount = uint64(output.value, "exact output amount", { positive: true });
  if (
    (amount !== undefined && output.value !== amount) ||
    canonicalScript(output.scriptPublicKey, "exact output script public key") !== scriptPublicKey ||
    output.covenant !== null
  ) {
    throw error("artifact_mismatch", "exact transaction output facts changed");
  }
  return parsedAmount;
}

function outputAmount(value: unknown, label: string): bigint {
  return uint64(requireRecord(value, label).value, `${label} amount`, { positive: true });
}

function validateKip10Head(
  redeemScript: string,
  scriptPublicKey: string,
  additiveThreshold: bigint
): void {
  const ownerStart = KIP10_PREFIX.length;
  const ownerEnd = ownerStart + 64;
  if (
    !redeemScript.startsWith(KIP10_PREFIX) ||
    redeemScript.slice(ownerEnd, ownerEnd + KIP10_AFTER_OWNER.length) !== KIP10_AFTER_OWNER ||
    !redeemScript.endsWith(KIP10_SUFFIX)
  ) {
    throw error("artifact_mismatch", "head redeem script is not the pinned KIP-10 additive template");
  }
  const ownerPublicKey = redeemScript.slice(ownerStart, ownerEnd);
  if (!/^[a-f0-9]{64}$/.test(ownerPublicKey)) {
    throw error("artifact_mismatch", "KIP-10 owner public key is invalid");
  }
  let expectedRedeem: string;
  let expectedScript: string;
  try {
    expectedRedeem = buildKip10AdditiveRedeemScript({
      ownerPublicKey,
      amount: additiveThreshold,
    }).toLowerCase();
    expectedScript = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({ ownerPublicKey, amount: additiveThreshold })
    ).toLowerCase();
  } catch (cause) {
    throw error("artifact_mismatch", "KIP-10 head parameters are invalid", { cause });
  }
  if (redeemScript !== expectedRedeem || scriptPublicKey !== expectedScript) {
    throw error("artifact_mismatch", "KIP-10 head script does not match the advertised head facts");
  }
}

function assertPaymentIdentifierExtensions(
  required: PaymentRequired,
  payload: PaymentPayload,
  expected: string
): void {
  const offered = required.extensions?.["payment-identifier"];
  const supplied = payload.extensions?.["payment-identifier"];
  if (
    !isRecord(offered) ||
    !isRecord(offered.info) ||
    offered.info.required !== true ||
    (offered.info.id !== undefined && offered.info.id !== expected) ||
    !isRecord(supplied) ||
    !isRecord(supplied.info) ||
    supplied.info.id !== expected
  ) {
    throw error("payment_replay", "payment-identifier extension is missing or rebound");
  }
}

function snapshotPaymentResponseHeader(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_PAYMENT_RESPONSE_HEADER_BYTES) {
    throw error("artifact_mismatch", "Merchant payment response is empty or oversized");
  }
  const snapshot = Uint8Array.from(bytes);
  const ascii = Buffer.from(snapshot).toString("ascii");
  if (
    !HEADER_ASCII.test(ascii) ||
    Buffer.from(ascii, "base64").toString("base64") !== ascii ||
    !Buffer.from(ascii, "ascii").equals(Buffer.from(snapshot))
  ) {
    throw error("artifact_mismatch", "Merchant payment response is not canonical ASCII base64");
  }
  return snapshot;
}

async function boundedCall<T>(
  label: string,
  deadlineAtMs: number,
  now: () => number,
  callerSignal: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const remaining = deadlineAtMs - readClock(now);
  if (remaining <= 0) throw error("deadline_exceeded", `${label} deadline has expired`);
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(error("deadline_exceeded", `${label} deadline exceeded`)),
    remaining
  );
  // This timer is the completion mechanism when a source ignores abort and
  // retains no event-loop handles of its own. Keep it referenced until the
  // bounded call settles; otherwise Node may terminate with the caller still
  // awaiting a deadline that can no longer fire.
  try {
    controller.signal.throwIfAborted();
    return await raceSignal(action(controller.signal), controller.signal);
  } catch (cause) {
    if (cause instanceof KaspaExactChainVerifierError) throw cause;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof KaspaExactChainVerifierError) throw reason;
      if (callerSignal?.aborted) throw abortError(callerSignal);
      throw error("deadline_exceeded", `${label} deadline exceeded`, { cause: reason });
    }
    throw error("source_failure", `${label} failed`, { cause });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      }
    );
  });
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw error("artifact_mismatch", `${label} is not JSON`, { cause });
  }
  return requireRecord(parsed, label);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw error("artifact_mismatch", `${label} must be an array`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw error("artifact_mismatch", `${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !set.has(key));
  if (unknown.length > 0) {
    throw error("artifact_mismatch", `${label} contains unknown field ${unknown[0]}`);
  }
}

function canonicalScript(value: unknown, label: string): string {
  if (typeof value !== "string" || !SERIALIZED_V0_SCRIPT.test(value)) {
    throw error("artifact_mismatch", `${label} is not a canonical serialized version-0 script`);
  }
  return value;
}

function canonicalHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) {
    throw error("artifact_mismatch", `${label} is not canonical complete hexadecimal bytes`);
  }
  return value;
}

function requireHash(value: unknown, label: string): Hash32Hex {
  if (typeof value !== "string" || !HASH32.test(value)) {
    throw error("artifact_mismatch", `${label} is not a canonical 32-byte hash`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw error("artifact_mismatch", `${label} is not a canonical SHA-256 digest`);
  }
  return value as Sha256Digest;
}

function requirePaymentIdentifier(value: unknown): string {
  if (typeof value !== "string" || !PAYMENT_IDENTIFIER.test(value)) {
    throw error("payment_replay", "exact payment identifier is invalid");
  }
  return value;
}

function requireFinality(value: unknown, label: string): KaspaChainFinality {
  if (typeof value !== "string" || !(value in FINALITY_RANK)) {
    throw error("artifact_mismatch", `${label} is unknown`);
  }
  return value as KaspaChainFinality;
}

function strongerFinality(
  left: KaspaChainFinality,
  right: KaspaChainFinality
): KaspaChainFinality {
  return FINALITY_RANK[left] >= FINALITY_RANK[right] ? left : right;
}

function uint64(
  value: unknown,
  label: string,
  options: { positive?: boolean } = {}
): bigint {
  if (typeof value !== "string" || !UINT_DECIMAL.test(value)) {
    throw error("artifact_mismatch", `${label} is not a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (options.positive && parsed === 0n)) {
    throw error("artifact_mismatch", `${label} is outside uint64 bounds`);
  }
  return parsed;
}

function uint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw error("artifact_mismatch", `${label} is outside uint32 bounds`);
  }
  return value as number;
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  const total = left + right;
  if (total > UINT64_MAX) throw error("cost_mismatch", `${label} exceeds uint64`);
  return total;
}

function parseOutpointString(value: unknown, label: string): { transactionId: string; index: number } {
  if (typeof value !== "string") throw error("artifact_mismatch", `${label} is invalid`);
  const separator = value.lastIndexOf(":");
  if (separator <= 0) throw error("artifact_mismatch", `${label} is invalid`);
  const transactionId = requireHash(value.slice(0, separator), `${label} transaction ID`);
  const indexText = value.slice(separator + 1);
  if (!/^(?:0|[1-9][0-9]*)$/.test(indexText)) {
    throw error("artifact_mismatch", `${label} index is invalid`);
  }
  const index = uint32(Number(indexText), `${label} index`);
  if (`${transactionId}:${index}` !== value) {
    throw error("artifact_mismatch", `${label} is not canonical`);
  }
  return { transactionId, index };
}

function canonicalTime(value: unknown, label: string): number {
  if (typeof value !== "string") throw error("artifact_mismatch", `${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw error("artifact_mismatch", `${label} is not canonical`);
  }
  return parsed;
}

function digestToHash32(value: string, label: string): Hash32Hex {
  requireDigest(value, label);
  const bytes = Buffer.from(value.slice("sha256:".length), "base64url");
  if (bytes.byteLength !== 32) throw error("artifact_mismatch", `${label} is not 32 bytes`);
  return bytes.toString("hex");
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

function digestCanonical(value: Record<string, unknown>): Sha256Digest {
  return digestBytes(Buffer.from(stableStringify(value), "utf8"));
}

function requireBoundedIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw error("source_failure", `${label} is invalid`);
  }
  return value;
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 5 * 60_000) {
    throw error("source_failure", "chain observation timeout is invalid");
  }
  return value;
}

function checkedDeadline(nowMs: number, timeoutMs: number): number {
  const value = nowMs + timeoutMs;
  if (!Number.isSafeInteger(value)) throw error("deadline_exceeded", "observation deadline overflowed");
  return value;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw error("source_failure", "chain verifier clock returned an invalid timestamp");
  }
  return value;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const errorValue = new Error("operation aborted");
  errorValue.name = "AbortError";
  return errorValue;
}

function error(
  code: KaspaExactChainVerifierErrorCode,
  message: string,
  options?: { cause?: unknown }
): KaspaExactChainVerifierError {
  return new KaspaExactChainVerifierError(code, message, options);
}
