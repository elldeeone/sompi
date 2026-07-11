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
import type { ByteHex, NetworkId } from "@kaspa-x402/core";

import { payToScriptHashScript } from "../../kaspa-wasm.js";
import { KaspaTestnet10AddressCodec, serializeScriptPublicKey } from "./address-codec.js";

const TESTNET_10: NetworkId = "kaspa:testnet-10";
const VAULT_TREASURY = "vault-treasury" as const;
const EXACT_TEMPLATE = "kaspa-x402-kip10-additive-v1" as const;
const EXACT_TRANSACTION_ENCODING = "kaspa-sdk-safe-json-v2.0.0" as const;
const HASH32 = /^[0-9a-fA-F]{64}$/;
const SERIALIZED_V0_SCRIPT = /^0000(?:[0-9a-fA-F]{2})+$/;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = 0xffff_ffff;

export interface VaultTreasuryFundingProviderOptions {
  /** Must remain kaspa:testnet-10 until the recorded mainnet gates pass. */
  networkId?: NetworkId;
  getPublicIdentity: () => Promise<PublicIdentity>;
  getVirtualDaaScore: () => Promise<string>;
  getUtxos: (addresses: readonly string[]) => Promise<FundingProviderUtxo[]>;
  estimateFees: (request: FeeEstimateRequest) => Promise<FeeEstimate>;
  /**
   * Owns journaled vault staging, exact construction, signing, persistence, and
   * artifact-level invariant checks before it returns a prepared transaction.
   */
  buildExactTransactionDurably: (
    request: Readonly<ExactTransactionPaymentRequest>,
  ) => Promise<ExactTransactionPaymentResult>;
  now?: () => number;
}

/**
 * The alpha.6 FundingProvider boundary for Sompi's journaled vault treasury.
 * It deliberately exposes no escrow-deposit or transaction-broadcast path:
 * exact artifacts are durably prepared here and submitted by the Merchant.
 */
export class VaultTreasuryFundingProvider implements FundingProvider {
  readonly networkId: NetworkId;
  readonly sourceKind = VAULT_TREASURY;

  private readonly options: VaultTreasuryFundingProviderOptions;
  private readonly addressCodec = new KaspaTestnet10AddressCodec();

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

  async payExactTransaction(
    request: ExactTransactionPaymentRequest,
  ): Promise<ExactTransactionPaymentResult> {
    validateExactRequest(request, this.networkId, this.addressCodec, this.options.now?.() ?? Date.now());

    const durableRequest = deepFreeze(structuredClone(request));
    const result = await this.options.buildExactTransactionDurably(durableRequest);
    validateExactResult(result, request, this.networkId, this.addressCodec);

    return {
      transaction: result.transaction,
      transactionEncoding: result.transactionEncoding,
      transactionId: result.transactionId,
      paymentOutputIndex: result.paymentOutputIndex,
      ...(result.payerAddress === undefined ? {} : { payerAddress: result.payerAddress }),
      fundingSource: VAULT_TREASURY,
    };
  }

  async fundEscrowDeposit(_request: EscrowDepositRequest): Promise<EscrowDepositResult> {
    throw new Error("Kaspa-x402 escrow deposits are disabled by the Sompi exact-only profile");
  }

  async getUtxos(addresses: readonly string[]): Promise<FundingProviderUtxo[]> {
    for (const address of addresses) {
      this.addressCodec.scriptPublicKeyForAddress(address, this.networkId);
    }
    const utxos = await this.options.getUtxos([...addresses]);
    for (const [position, utxo] of utxos.entries()) validateUtxo(utxo, position, this.networkId, this.addressCodec);
    return utxos.map((utxo) => structuredClone(utxo));
  }

  async getVirtualDaaScore(): Promise<string> {
    return assertUint64(await this.options.getVirtualDaaScore(), "virtual DAA score");
  }

  async estimateFees(request: FeeEstimateRequest): Promise<FeeEstimate> {
    assertNetwork(request.network, this.networkId);
    if (request.action !== "exact") {
      throw new Error(`fee action ${request.action} is disabled by the Sompi exact-only profile`);
    }
    if (request.amount !== undefined) assertPositiveUint64(request.amount, "fee estimate amount");
    const estimate = await this.options.estimateFees(structuredClone(request));
    return { feeSompi: assertUint64(estimate.feeSompi, "fee estimate") };
  }

  async sendTransaction(_transaction: ByteHex): Promise<SendTransactionResult> {
    throw new Error(
      "Kaspa-x402 transaction broadcast is disabled here; the exact Merchant submits the prepared artifact",
    );
  }
}

function validateExactRequest(
  request: ExactTransactionPaymentRequest,
  networkId: NetworkId,
  addressCodec: KaspaTestnet10AddressCodec,
  now: number,
): void {
  assertNetwork(request.network, networkId);
  if (request.fundingSource !== VAULT_TREASURY) {
    throw new Error("exact payment request must require vault-treasury funding");
  }
  assertPositiveUint64(request.amount, "exact payment amount");
  addressCodec.scriptPublicKeyForAddress(request.payTo, networkId);
  if (request.requestHash !== undefined) assertHash32(request.requestHash, "request hash");
  if (
    request.requiredFinality !== undefined &&
    request.requiredFinality !== "mempool" &&
    request.requiredFinality !== "accepted" &&
    request.requiredFinality !== "confirmed"
  ) {
    throw new Error("exact payment required finality is invalid");
  }

  const reservation = request.reservation;
  if (reservation.templateId !== EXACT_TEMPLATE) {
    throw new Error("exact payment reservation uses an unsupported KIP-10 template");
  }
  if (reservation.transactionEncoding !== EXACT_TRANSACTION_ENCODING) {
    throw new Error("exact payment reservation uses an unsupported transaction encoding");
  }
  assertHash32(reservation.reservationId, "reservation ID");
  const borrowOutpoint = reservation.borrowOutpoint;
  if (!borrowOutpoint) throw new Error("exact payment reservation is missing its borrow outpoint");
  assertHash32(borrowOutpoint.txid, "borrow outpoint transaction ID");
  assertUint32(borrowOutpoint.index, "borrow outpoint index");
  assertPositiveUint64(reservation.borrowAmount, "borrow amount");
  assertUint64(reservation.additiveThresholdSompi, "additive threshold");
  assertUint32(reservation.paymentOutputIndex, "payment output index");
  const borrowScriptPublicKey = reservation.borrowScriptPublicKey;
  if (typeof borrowScriptPublicKey !== "string" || !SERIALIZED_V0_SCRIPT.test(borrowScriptPublicKey)) {
    throw new Error("borrow script public key is not an alpha.6 serialized version-0 script");
  }
  const borrowRedeemScript = reservation.borrowRedeemScript;
  if (typeof borrowRedeemScript !== "string" || !HEX_BYTES.test(borrowRedeemScript)) {
    throw new Error("borrow redeem script must contain complete hexadecimal bytes");
  }

  const derivedBorrowScript = payToScriptHashScript(borrowRedeemScript);
  try {
    const serialized = serializeScriptPublicKey(derivedBorrowScript.version, derivedBorrowScript.script);
    if (serialized !== borrowScriptPublicKey.toLowerCase()) {
      throw new Error("borrow redeem script does not match the reserved script public key");
    }
  } finally {
    derivedBorrowScript.free();
  }

  if (typeof reservation.reservationExpiresAt !== "string") {
    throw new Error("exact payment reservation must have an expiry");
  }
  const expiresAt = Date.parse(reservation.reservationExpiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("exact payment reservation expiry is invalid");
  }
  if (expiresAt <= now) {
    throw new Error("exact payment reservation has expired");
  }
}

function validateExactResult(
  result: ExactTransactionPaymentResult,
  request: ExactTransactionPaymentRequest,
  networkId: NetworkId,
  addressCodec: KaspaTestnet10AddressCodec,
): void {
  if (!result || typeof result !== "object") {
    throw new Error("durable exact transaction builder returned no result");
  }
  if (result.transactionEncoding !== request.reservation.transactionEncoding) {
    throw new Error("prepared transaction encoding does not match the reservation");
  }
  if (result.fundingSource !== VAULT_TREASURY) {
    throw new Error("prepared exact transaction must use vault-treasury funding");
  }
  assertHash32(result.transactionId, "prepared transaction ID");
  assertUint32(result.paymentOutputIndex, "prepared payment output index");
  const expectedPaymentOutputIndex = request.reservation.paymentOutputIndex;
  assertUint32(expectedPaymentOutputIndex, "reserved payment output index");
  if (result.paymentOutputIndex !== expectedPaymentOutputIndex) {
    throw new Error("prepared payment output index does not match the reservation");
  }
  if (typeof result.transaction !== "string" || result.transaction.length === 0) {
    throw new Error("prepared exact transaction artifact is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.transaction);
  } catch {
    throw new Error("prepared exact transaction artifact is not safe JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("prepared exact transaction artifact must be a JSON object");
  }
  if (parsed.id !== undefined) {
    assertHash32(parsed.id, "transaction artifact ID");
    if (parsed.id.toLowerCase() !== result.transactionId.toLowerCase()) {
      throw new Error("transaction artifact ID does not match the prepared transaction ID");
    }
  }
  if (result.payerAddress !== undefined) {
    addressCodec.scriptPublicKeyForAddress(result.payerAddress, networkId);
  }
}

function validateUtxo(
  utxo: FundingProviderUtxo,
  position: number,
  networkId: NetworkId,
  addressCodec: KaspaTestnet10AddressCodec,
): void {
  assertHash32(utxo.outpoint.txid, `UTXO ${position} transaction ID`);
  assertUint32(utxo.outpoint.index, `UTXO ${position} output index`);
  assertUint64(utxo.amount, `UTXO ${position} amount`);
  if (!SERIALIZED_V0_SCRIPT.test(utxo.scriptPublicKey)) {
    throw new Error(`UTXO ${position} script public key is not a serialized version-0 script`);
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
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error(`${label} exceeds uint64`);
  return value;
}

function assertPositiveUint64(value: unknown, label: string): string {
  const normalized = assertUint64(value, label);
  if (normalized === "0") throw new Error(`${label} must be greater than zero`);
  return normalized;
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
