import type {
  EscrowDepositRequest,
  EscrowDepositResult,
  ExactTransactionPaymentRequest,
  ExactTransactionPaymentResult,
  FeeEstimate,
  FeeEstimateRequest,
  FundingProvider,
  FundingProviderUtxo,
  PublicIdentity,
  SendTransactionResult,
} from "@kaspa-x402/client";
import {
  exactRequestAuthorizationDigest,
  stableStringify,
  type ByteHex,
  type NetworkId,
} from "@kaspa-x402/core";

import { KaspaTestnet10AddressCodec } from "./address-codec.js";

const TESTNET_10: NetworkId = "kaspa:testnet-10";
const VAULT_TREASURY = "vault-treasury" as const;
const EXACT_TRANSACTION_ENCODING = "kaspa-sdk-safe-json-v2.0.0" as const;
const HASH32 = /^[0-9a-fA-F]{64}$/;
const SIGNATURE64 = /^[0-9a-fA-F]{128}$/;
const SERIALIZED_V0_SCRIPT = /^0000(?:[0-9a-fA-F]{2})+$/;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = 0xffff_ffff;

export interface VaultTreasuryFundingProviderOptions {
  readonly networkId?: NetworkId;
  readonly getPublicIdentity: () => Promise<PublicIdentity>;
  readonly getVirtualDaaScore: () => Promise<string>;
  readonly getUtxos: (addresses: readonly string[]) => Promise<FundingProviderUtxo[]>;
  readonly estimateFees: (request: FeeEstimateRequest) => Promise<FeeEstimate>;
  readonly authorizeExactPayment: (
    request: Readonly<ExactTransactionPaymentRequest>
  ) => Promise<void>;
  readonly buildExactTransactionDurably: (
    request: Readonly<ExactTransactionPaymentRequest>
  ) => Promise<ExactTransactionPaymentResult>;
  readonly now?: () => number;
}

/**
 * Attempt-scoped alpha.9 FundingProvider. It can authorize and sign exactly one
 * immutable request, cannot broadcast, and has no batch-deposit authority.
 */
export class VaultTreasuryFundingProvider implements FundingProvider {
  readonly networkId: NetworkId;
  readonly sourceKind = VAULT_TREASURY;

  private readonly options: VaultTreasuryFundingProviderOptions;
  private readonly addressCodec = new KaspaTestnet10AddressCodec();
  private authorizedRequest?: string;

  constructor(options: VaultTreasuryFundingProviderOptions) {
    this.networkId = options.networkId ?? TESTNET_10;
    if (this.networkId !== TESTNET_10) {
      throw new Error(`unsupported funding network ${this.networkId}; only ${TESTNET_10} is enabled`);
    }
    this.options = options;
  }

  async getPublicIdentity(): Promise<PublicIdentity> {
    const identity = await this.options.getPublicIdentity();
    this.addressCodec.scriptPublicKeyForAddress(identity.address, this.networkId);
    if (identity.publicKey !== undefined && !HASH32.test(identity.publicKey)) {
      throw new Error("vault-treasury public identity contains an invalid public key");
    }
    return identity.publicKey === undefined
      ? { address: identity.address }
      : { address: identity.address, publicKey: identity.publicKey };
  }

  async authorizeExactPayment(request: ExactTransactionPaymentRequest): Promise<void> {
    validateExactRequest(request, this.networkId, this.addressCodec, this.now());
    const canonical = stableStringify(request);
    if (this.authorizedRequest !== undefined && this.authorizedRequest !== canonical) {
      throw new Error("attempt provider cannot authorize a different exact request");
    }
    await this.options.authorizeExactPayment(deepFreeze(structuredClone(request)));
    this.authorizedRequest = canonical;
  }

  async payExactTransaction(
    request: ExactTransactionPaymentRequest
  ): Promise<ExactTransactionPaymentResult> {
    validateExactRequest(request, this.networkId, this.addressCodec, this.now());
    if (this.authorizedRequest !== stableStringify(request)) {
      throw new Error("exact payment request was not authorized before signing");
    }
    const result = await this.options.buildExactTransactionDurably(
      deepFreeze(structuredClone(request))
    );
    validateExactResult(result, request, this.networkId, this.addressCodec);
    return {
      transaction: result.transaction,
      transactionEncoding: result.transactionEncoding,
      transactionId: result.transactionId,
      paymentOutputIndex: result.paymentOutputIndex,
      authorization: structuredClone(result.authorization),
      ...(result.payerAddress === undefined ? {} : { payerAddress: result.payerAddress }),
      fundingSource: VAULT_TREASURY,
    };
  }

  async fundEscrowDeposit(_request: EscrowDepositRequest): Promise<EscrowDepositResult> {
    throw new Error("batch deposits are outside the exact attempt provider");
  }

  async getUtxos(addresses: readonly string[]): Promise<FundingProviderUtxo[]> {
    for (const address of addresses) {
      this.addressCodec.scriptPublicKeyForAddress(address, this.networkId);
    }
    const utxos = await this.options.getUtxos([...addresses]);
    for (const [position, utxo] of utxos.entries()) {
      validateUtxo(utxo, position, this.networkId, this.addressCodec);
    }
    return utxos.map((utxo) => structuredClone(utxo));
  }

  async getVirtualDaaScore(): Promise<string> {
    return assertUint64(await this.options.getVirtualDaaScore(), "virtual DAA score");
  }

  async estimateFees(request: FeeEstimateRequest): Promise<FeeEstimate> {
    assertNetwork(request.network, this.networkId);
    if (request.action !== "exact") {
      throw new Error(`fee action ${request.action} is outside the exact attempt provider`);
    }
    if (request.amount !== undefined) assertPositiveUint64(request.amount, "fee estimate amount");
    const estimate = await this.options.estimateFees(structuredClone(request));
    return { feeSompi: assertUint64(estimate.feeSompi, "fee estimate") };
  }

  async sendTransaction(_transaction: ByteHex): Promise<SendTransactionResult> {
    throw new Error("the merchant or facilitator submits the prepared exact artifact");
  }

  private now(): number {
    const value = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("funding provider clock is invalid");
    return value;
  }
}

function validateExactRequest(
  request: ExactTransactionPaymentRequest,
  networkId: NetworkId,
  addressCodec: KaspaTestnet10AddressCodec,
  now: number
): void {
  assertNetwork(request.network, networkId);
  if (request.fundingSource !== VAULT_TREASURY) {
    throw new Error("exact payment request must require vault-treasury funding");
  }
  if (request.profile !== "standard-native" && request.profile !== "additive") {
    throw new Error("exact payment profile is unsupported");
  }
  assertPositiveUint64(request.amount, "exact payment amount");
  addressCodec.scriptPublicKeyForAddress(request.payTo, networkId);
  if (!SERIALIZED_V0_SCRIPT.test(request.payToScriptPublicKey)) {
    throw new Error("exact payment script public key is invalid");
  }
  assertHash32(request.requestHash, "request hash");
  assertHash32(request.paymentRequirementsHash, "payment requirements hash");
  if (request.requiredFinality === "mempool") {
    throw new Error("Sompi exact requires accepted or confirmed finality");
  }
  if (request.paymentOutputIndex !== undefined && request.paymentOutputIndex !== 0) {
    throw new Error("exact payment output must be index 0");
  }
  requireFutureTime(request.authorizationExpiresAt, now, "request authorization expiry");

  if (request.profile === "standard-native") {
    if (request.head !== undefined) throw new Error("standard-native exact must not include a head");
    return;
  }
  const head = request.head;
  if (!head) throw new Error("additive exact requires a head challenge");
  assertHash32(head.headId, "head ID");
  assertUint64(head.headVersion, "head version");
  assertHash32(head.challengeId, "head challenge ID");
  assertHash32(head.expectedHeadOutpoint.txid, "head outpoint transaction ID");
  assertUint32(head.expectedHeadOutpoint.index, "head outpoint index");
  assertPositiveUint64(head.headAmount, "head amount");
  assertPositiveUint64(head.additiveThresholdSompi, "additive threshold");
  if (!SERIALIZED_V0_SCRIPT.test(head.headScriptPublicKey) || !HEX_BYTES.test(head.headRedeemScript)) {
    throw new Error("additive head script facts are invalid");
  }
  requireFutureTime(head.challengeExpiresAt, now, "head challenge expiry");
  if (Date.parse(request.authorizationExpiresAt) > Date.parse(head.challengeExpiresAt)) {
    throw new Error("request authorization must not outlive the additive challenge");
  }
}

function validateExactResult(
  result: ExactTransactionPaymentResult,
  request: ExactTransactionPaymentRequest,
  networkId: NetworkId,
  addressCodec: KaspaTestnet10AddressCodec
): void {
  if (!result || typeof result !== "object") throw new Error("exact builder returned no result");
  if (result.transactionEncoding !== EXACT_TRANSACTION_ENCODING) {
    throw new Error("prepared transaction encoding does not match kaspa-exact-v2");
  }
  if (result.fundingSource !== VAULT_TREASURY) {
    throw new Error("prepared exact transaction must use vault-treasury funding");
  }
  assertHash32(result.transactionId, "prepared transaction ID");
  if (result.paymentOutputIndex !== 0) throw new Error("prepared payment output must be index 0");
  if (typeof result.transaction !== "string" || result.transaction.length === 0) {
    throw new Error("prepared exact transaction artifact is empty");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.transaction); } catch { throw new Error("prepared transaction is not safe JSON"); }
  if (!isRecord(parsed)) throw new Error("prepared transaction artifact must be an object");
  if (parsed.id !== undefined && parsed.id !== result.transactionId) {
    throw new Error("transaction artifact ID does not match the prepared ID");
  }
  if (result.payerAddress !== undefined) {
    addressCodec.scriptPublicKeyForAddress(result.payerAddress, networkId);
  }
  const expectedDigest = exactRequestAuthorizationDigest({
    network: request.network,
    profile: request.profile,
    transactionId: result.transactionId,
    paymentOutputIndex: result.paymentOutputIndex,
    amount: request.amount,
    payTo: request.payTo,
    payToScriptPublicKey: request.payToScriptPublicKey,
    paymentRequirementsHash: request.paymentRequirementsHash,
    requestHash: request.requestHash,
    ...(request.head === undefined ? {} : { challengeId: request.head.challengeId }),
    inputIndex: request.profile === "additive" ? 1 : 0,
    expiresAt: request.authorizationExpiresAt,
  });
  if (
    result.authorization.version !== "kaspa-x402-exact-request-authorization-v1" ||
    result.authorization.inputIndex !== (request.profile === "additive" ? 1 : 0) ||
    result.authorization.expiresAt !== request.authorizationExpiresAt ||
    result.authorization.digest !== expectedDigest ||
    !SIGNATURE64.test(result.authorization.signature)
  ) {
    throw new Error("prepared exact request authorization is not bound to the request");
  }
}

function validateUtxo(
  utxo: FundingProviderUtxo,
  position: number,
  networkId: NetworkId,
  addressCodec: KaspaTestnet10AddressCodec
): void {
  assertHash32(utxo.outpoint.txid, `UTXO ${position} transaction ID`);
  assertUint32(utxo.outpoint.index, `UTXO ${position} output index`);
  assertUint64(utxo.amount, `UTXO ${position} amount`);
  if (!SERIALIZED_V0_SCRIPT.test(utxo.scriptPublicKey)) {
    throw new Error(`UTXO ${position} script public key is invalid`);
  }
  if (utxo.address !== undefined) addressCodec.scriptPublicKeyForAddress(utxo.address, networkId);
}

function assertNetwork(actual: NetworkId, expected: NetworkId): void {
  if (actual !== expected || actual !== TESTNET_10) {
    throw new Error(`funding provider only supports ${TESTNET_10}, received ${actual}`);
  }
}

function assertHash32(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH32.test(value)) {
    throw new Error(`${label} must be a 32-byte hexadecimal value`);
  }
}

function assertUint32(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw new Error(`${label} must fit in uint32`);
  }
}

function assertUint64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`);
  }
  if (BigInt(value) > UINT64_MAX) throw new Error(`${label} exceeds uint64`);
  return value;
}

function assertPositiveUint64(value: unknown, label: string): string {
  const normalized = assertUint64(value, label);
  if (normalized === "0") throw new Error(`${label} must be greater than zero`);
  return normalized;
}

function requireFutureTime(value: unknown, now: number, label: string): void {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed <= now) {
    throw new Error(`${label} is invalid or expired`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
