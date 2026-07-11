import type {
  ExactTransactionPaymentRequest,
  ExactTransactionPaymentResult,
} from "@kaspa-x402/client";
import {
  KIP10_ADDITIVE_TEMPLATE_ID,
  KIP10_EXACT_TRANSACTION_ENCODING,
  buildKip10AdditiveBorrowArgs,
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import {
  ScriptPublicKey,
  SighashType,
  Transaction,
  calculateTransactionMass,
  createInputSignature,
  payToScriptHashSignatureScript,
  type PrivateKey,
} from "../../kaspa-wasm.js";
import { assertPurchaseId } from "../../purchase/identity.js";
import type { PurchaseId } from "../../purchase/types.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import {
  StagingKeyStore,
  type StagingKeyLookup,
  type StagingKeyRecord,
} from "./staging-key-store.js";

export const SOMPI_EXACT_FEE_POLICY = Object.freeze({
  id: "sompi-kaspa-x402-exact-testnet10-fixed-v2",
  // Matches the alpha.6 reference adapter's live Testnet-10 fee. The network
  // floor is 100 sompi/gram; the former 1,000,000-sompi fixture fee was below
  // the final two-input transaction mass and was rejected before admission.
  feeSompi: "2000000",
  feeRateSompiPerGram: 100,
  computeBudgetMassPerUnit: 100,
  minimumStandardOutputSompi: "10000000",
  inputComputeBudget: 10,
} as const);

const NETWORK = "kaspa:testnet-10" as const;
const SDK_NETWORK = "testnet-10";
const FUNDING_SOURCE = "vault-treasury" as const;
const NATIVE_SUBNETWORK = "00".repeat(20);
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = 0xffff_ffff;
const HASH32 = /^[a-f0-9]{64}$/;
const PAYMENT_IDENTIFIER_PATTERN = /^pay_[A-Za-z0-9_-]{43}$/;
const SERIALIZED_V0_SCRIPT = /^0000(?:[a-f0-9]{2})+$/;
const HEX_BYTES = /^(?:[a-f0-9]{2})+$/;
const KIP10_PREFIX = "6320";
const KIP10_AFTER_OWNER = "ac67b9bfb9c388b9c2";
const KIP10_SUFFIX = "94b9bea268";

export interface ObservedStagingOutput {
  readonly outpoint: {
    readonly txid: string;
    readonly index: number;
  };
  readonly amountAtomic: string;
  readonly scriptPublicKey: string;
  readonly address: string;
  readonly blockDaaScore: string;
  readonly keyReference: string;
}

export interface BuildKip10ExactTransactionInput {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly request: Readonly<ExactTransactionPaymentRequest>;
  readonly staging: Readonly<ObservedStagingOutput>;
  /** Complete Purchase authorization bound: threshold + exact fee + staging fee. */
  readonly additionalCostCeilingAtomic: string;
  /** Actual already-paid vault staging transaction fee. */
  readonly stagingTransactionFeeAtomic: string;
  /** Optional recovery assertion for an already-planned immutable transaction. */
  readonly expectedTransactionId?: string;
}

export interface Kip10ExactTransactionBuilderOptions {
  readonly keyStore: StagingKeyStore;
  readonly now?: () => number;
}

interface ValidatedBuild {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly request: Readonly<ExactTransactionPaymentRequest>;
  readonly staging: Readonly<ObservedStagingOutput>;
  readonly keyLookup: StagingKeyLookup;
  readonly keyRecord: StagingKeyRecord;
  readonly price: bigint;
  readonly borrowAmount: bigint;
  readonly threshold: bigint;
  readonly stagingAmount: bigint;
  readonly exactFee: bigint;
  readonly merchantScript: string;
  readonly borrowScript: string;
  readonly borrowRedeemScript: string;
  readonly stagingScript: string;
  readonly expectedTransactionId?: string;
}

export class ExactTransactionBuilderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExactTransactionBuilderError";
  }
}

/** Concrete alpha.6 KIP-10 additive exact transaction construction. */
export class Kip10ExactTransactionBuilder {
  private readonly keyStore: StagingKeyStore;
  private readonly now: () => number;
  private readonly addressCodec = new KaspaTestnet10AddressCodec();

  constructor(options: Kip10ExactTransactionBuilderOptions) {
    if (!options?.keyStore) {
      throw new ExactTransactionBuilderError("staging key store is required");
    }
    this.keyStore = options.keyStore;
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async build(
    input: BuildKip10ExactTransactionInput
  ): Promise<ExactTransactionPaymentResult> {
    const validated = this.validate(input);
    return this.keyStore.withPrivateKey(
      validated.keyLookup,
      (privateKey, record) => this.buildWithKey(validated, privateKey, record)
    );
  }

  private validate(input: BuildKip10ExactTransactionInput): ValidatedBuild {
    if (!input || typeof input !== "object") {
      throw new ExactTransactionBuilderError("exact transaction input is invalid");
    }
    let purchaseId: PurchaseId;
    try {
      purchaseId = assertPurchaseId(input.purchaseId);
    } catch {
      throw new ExactTransactionBuilderError("exact transaction Purchase identity is invalid");
    }
    if (!PAYMENT_IDENTIFIER_PATTERN.test(input.paymentIdentifier)) {
      throw new ExactTransactionBuilderError("exact transaction payment identity is invalid");
    }
    const request = input.request;
    if (!request || typeof request !== "object") {
      throw new ExactTransactionBuilderError("alpha.6 exact payment request is missing");
    }
    assertExactKeys(request, [
      "network",
      "amount",
      "payTo",
      "requestHash",
      "requiredFinality",
      "fundingSource",
      "reservation",
    ], "alpha.6 exact payment request");
    if (request.network !== NETWORK) {
      throw new ExactTransactionBuilderError(`only ${NETWORK} exact transactions are enabled`);
    }
    if (request.fundingSource !== FUNDING_SOURCE) {
      throw new ExactTransactionBuilderError("exact transaction must use vault-treasury funding");
    }
    const price = uint64(request.amount, "Merchant price", { positive: true });
    const minimumOutput = BigInt(SOMPI_EXACT_FEE_POLICY.minimumStandardOutputSompi);
    if (price < minimumOutput) {
      throw new ExactTransactionBuilderError("Merchant price is below the standard-output floor");
    }
    const merchantScript = canonicalScript(
      this.addressCodec.scriptPublicKeyForAddress(request.payTo, NETWORK),
      "Merchant payment script"
    );
    requireHash(request.requestHash, "exact request hash");
    if (
      request.requiredFinality !== undefined &&
      !["mempool", "accepted", "confirmed"].includes(request.requiredFinality)
    ) {
      throw new ExactTransactionBuilderError("exact required finality is invalid");
    }

    const reservation = request.reservation;
    if (!reservation || typeof reservation !== "object") {
      throw new ExactTransactionBuilderError("exact KIP-10 reservation is missing");
    }
    assertExactKeys(reservation, [
      "templateId",
      "transactionEncoding",
      "borrowOutpoint",
      "borrowAmount",
      "borrowScriptPublicKey",
      "borrowRedeemScript",
      "additiveThresholdSompi",
      "paymentOutputIndex",
      "reservationId",
      "reservationExpiresAt",
    ], "alpha.6 exact reservation");
    if (reservation.templateId !== KIP10_ADDITIVE_TEMPLATE_ID) {
      throw new ExactTransactionBuilderError("exact reservation template is unsupported");
    }
    if (reservation.transactionEncoding !== KIP10_EXACT_TRANSACTION_ENCODING) {
      throw new ExactTransactionBuilderError("exact transaction encoding is unsupported");
    }
    requireHash(reservation.reservationId, "exact reservation ID");
    if (!reservation.borrowOutpoint) {
      throw new ExactTransactionBuilderError("exact reservation borrow outpoint is missing");
    }
    assertExactKeys(
      reservation.borrowOutpoint,
      ["txid", "index"],
      "borrow outpoint"
    );
    requireHash(reservation.borrowOutpoint.txid, "borrow transaction ID");
    uint32(reservation.borrowOutpoint.index, "borrow output index");
    const borrowAmount = uint64(reservation.borrowAmount, "borrow amount", { positive: true });
    const threshold = uint64(reservation.additiveThresholdSompi, "KIP-10 additive threshold", {
      positive: true,
    });
    if (threshold < minimumOutput) {
      throw new ExactTransactionBuilderError("KIP-10 additive threshold is below the pinned floor");
    }
    if (reservation.paymentOutputIndex !== 1) {
      throw new ExactTransactionBuilderError("reserved Merchant payment output must be index 1");
    }
    const borrowRedeemScript = canonicalHex(
      reservation.borrowRedeemScript,
      "borrow redeem script"
    );
    const borrowScript = canonicalScript(
      reservation.borrowScriptPublicKey,
      "borrow script public key"
    );
    validateKip10Reservation(borrowRedeemScript, borrowScript, threshold);
    const expiresAt = requireCanonicalFutureTime(
      reservation.reservationExpiresAt,
      readClock(this.now),
      "exact reservation expiry"
    );
    void expiresAt;

    const staging = input.staging;
    if (!staging || typeof staging !== "object") {
      throw new ExactTransactionBuilderError("observed staging output is missing");
    }
    assertExactKeys(staging, [
      "outpoint",
      "amountAtomic",
      "scriptPublicKey",
      "address",
      "blockDaaScore",
      "keyReference",
    ], "observed staging output");
    assertExactKeys(
      staging.outpoint,
      ["txid", "index"],
      "staging outpoint"
    );
    requireHash(staging.outpoint?.txid, "staging transaction ID");
    uint32(staging.outpoint?.index, "staging output index");
    if (
      staging.outpoint.txid === reservation.borrowOutpoint.txid &&
      staging.outpoint.index === reservation.borrowOutpoint.index
    ) {
      throw new ExactTransactionBuilderError("staging and borrow inputs must be distinct");
    }
    const stagingAmount = uint64(staging.amountAtomic, "staging output amount", {
      positive: true,
    });
    uint64(staging.blockDaaScore, "staging output DAA score");
    const stagingScript = canonicalScript(staging.scriptPublicKey, "staging script public key");
    const addressScript = canonicalScript(
      this.addressCodec.scriptPublicKeyForAddress(staging.address, NETWORK),
      "staging address script"
    );
    if (stagingScript !== addressScript) {
      throw new ExactTransactionBuilderError("staging address and script public key do not match");
    }

    const keyLookup: StagingKeyLookup = {
      purchaseId,
      paymentIdentifier: input.paymentIdentifier,
      keyReference: staging.keyReference,
    };
    const keyRecord = this.keyStore.recover(keyLookup);
    if (
      keyRecord.address !== staging.address ||
      keyRecord.scriptPublicKey !== stagingScript ||
      keyRecord.network !== NETWORK
    ) {
      throw new ExactTransactionBuilderError("observed staging output is bound to a different key");
    }

    const exactFee = BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi);
    const requiredStaging = checkedAdd(
      checkedAdd(price, threshold, "exact price and threshold"),
      exactFee,
      "exact staging requirement"
    );
    if (stagingAmount < requiredStaging) {
      throw new ExactTransactionBuilderError("staging output cannot fund price, threshold, and exact fee");
    }
    if (stagingAmount < requiredStaging) {
      throw new ExactTransactionBuilderError(
        "staging output cannot fund price, threshold, and exact fee"
      );
    }
    if (stagingAmount > requiredStaging) {
      throw new ExactTransactionBuilderError(
        "fixed-v2 exact staging must equal price, additive threshold, and pinned fee"
      );
    }

    const stagingFee = uint64(
      input.stagingTransactionFeeAtomic,
      "vault staging transaction fee"
    );
    const additionalCostCeiling = uint64(
      input.additionalCostCeilingAtomic,
      "authorized additional-cost ceiling"
    );
    const actualAdditionalCost = checkedAdd(
      checkedAdd(threshold, exactFee, "threshold and exact fee"),
      stagingFee,
      "complete additional cost"
    );
    if (actualAdditionalCost > additionalCostCeiling) {
      throw new ExactTransactionBuilderError("complete additional cost exceeds its authorization ceiling");
    }
    const stagingTreasuryOutflow = checkedAdd(
      stagingAmount,
      stagingFee,
      "staging treasury outflow"
    );
    const authorizedGross = checkedAdd(price, additionalCostCeiling, "authorized gross outflow");
    if (stagingTreasuryOutflow > authorizedGross) {
      throw new ExactTransactionBuilderError("staging treasury outflow exceeds the full authorized gross bound");
    }
    checkedAdd(borrowAmount, stagingAmount, "exact transaction input total");

    let expectedTransactionId: string | undefined;
    if (input.expectedTransactionId !== undefined) {
      expectedTransactionId = requireHash(
        input.expectedTransactionId,
        "expected exact transaction ID"
      );
    }
    return {
      purchaseId,
      paymentIdentifier: input.paymentIdentifier,
      request,
      staging,
      keyLookup,
      keyRecord,
      price,
      borrowAmount,
      threshold,
      stagingAmount,
      exactFee,
      merchantScript,
      borrowScript,
      borrowRedeemScript,
      stagingScript,
      ...(expectedTransactionId === undefined ? {} : { expectedTransactionId }),
    };
  }

  private buildWithKey(
    input: ValidatedBuild,
    privateKey: PrivateKey,
    record: StagingKeyRecord
  ): ExactTransactionPaymentResult {
    if (
      record.keyReference !== input.keyRecord.keyReference ||
      record.address !== input.keyRecord.address ||
      record.scriptPublicKey !== input.keyRecord.scriptPublicKey
    ) {
      throw new ExactTransactionBuilderError("staging key changed between validation and signing");
    }
    const reservation = input.request.reservation;
    const borrowOutpoint = reservation.borrowOutpoint!;
    const continuationAmount = checkedAdd(
      input.borrowAmount,
      input.threshold,
      "KIP-10 continuation amount"
    );
    const borrowArgs = payToScriptHashSignatureScript(
      input.borrowRedeemScript,
      buildKip10AdditiveBorrowArgs()
    ).toLowerCase();
    const borrowScript = sdkScriptPublicKey(input.borrowScript);
    const stagingScript = sdkScriptPublicKey(input.stagingScript);
    const merchantScript = sdkScriptPublicKey(input.merchantScript);
    let transaction: Transaction | undefined;
    try {
      const outputs: Array<{ value: bigint; scriptPublicKey: ScriptPublicKey }> = [
        { value: continuationAmount, scriptPublicKey: borrowScript },
        { value: input.price, scriptPublicKey: merchantScript },
      ];
      transaction = new Transaction({
        version: 1,
        inputs: [
          transactionInput({
            txid: borrowOutpoint.txid,
            index: borrowOutpoint.index,
            amount: input.borrowAmount,
            scriptPublicKey: borrowScript,
            blockDaaScore: 0n,
            signatureScript: borrowArgs,
          }),
          transactionInput({
            txid: input.staging.outpoint.txid,
            index: input.staging.outpoint.index,
            amount: input.stagingAmount,
            scriptPublicKey: stagingScript,
            blockDaaScore: BigInt(input.staging.blockDaaScore),
            signatureScript: "",
          }),
        ],
        outputs,
        lockTime: 0n,
        subnetworkId: NATIVE_SUBNETWORK,
        gas: 0n,
        payload: "",
      } as never);

      const stagingSignature = createInputSignature(
        transaction,
        1,
        privateKey,
        SighashType.All
      ).toLowerCase();
      if (!/^[a-f0-9]{132}$/.test(stagingSignature)) {
        throw new ExactTransactionBuilderError("staging input signer returned an invalid signature script");
      }
      const inputs = transaction.inputs;
      inputs[0].signatureScript = borrowArgs;
      inputs[0].sigOpCount = 0;
      inputs[0].computeBudget = SOMPI_EXACT_FEE_POLICY.inputComputeBudget;
      inputs[1].signatureScript = stagingSignature;
      inputs[1].sigOpCount = 0;
      inputs[1].computeBudget = SOMPI_EXACT_FEE_POLICY.inputComputeBudget;
      transaction.inputs = inputs;

      const transactionId = String(transaction.finalize()).toLowerCase();
      requireHash(transactionId, "final exact transaction ID");
      if (
        input.expectedTransactionId !== undefined &&
        transactionId !== input.expectedTransactionId
      ) {
        throw new ExactTransactionBuilderError("final exact transaction ID changed during recovery");
      }
      const requiredFee = minimumRequiredExactFeeSompi(transaction);
      if (input.exactFee < requiredFee) {
        throw new ExactTransactionBuilderError("pinned exact fee is below final signed transaction mass");
      }
      const artifact = transaction.serializeToSafeJSON();
      validateFinalArtifact(artifact, transactionId, input, borrowArgs, stagingSignature);
      return Object.freeze({
        transaction: artifact,
        transactionEncoding: KIP10_EXACT_TRANSACTION_ENCODING,
        transactionId,
        paymentOutputIndex: 1,
        payerAddress: input.staging.address,
        fundingSource: FUNDING_SOURCE,
      });
    } catch (error) {
      if (error instanceof ExactTransactionBuilderError) throw error;
      throw new ExactTransactionBuilderError("KIP-10 exact transaction construction failed", {
        cause: error,
      });
    } finally {
      transaction?.free();
      borrowScript.free();
      stagingScript.free();
      merchantScript.free();
    }
  }
}

function transactionInput(input: {
  txid: string;
  index: number;
  amount: bigint;
  scriptPublicKey: ScriptPublicKey;
  blockDaaScore: bigint;
  signatureScript: string;
}): Record<string, unknown> {
  return {
    previousOutpoint: { transactionId: input.txid, index: input.index },
    signatureScript: input.signatureScript,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: SOMPI_EXACT_FEE_POLICY.inputComputeBudget,
    utxo: {
      outpoint: { transactionId: input.txid, index: input.index },
      amount: input.amount,
      scriptPublicKey: input.scriptPublicKey,
      blockDaaScore: input.blockDaaScore,
      isCoinbase: false,
    },
  };
}

function validateKip10Reservation(
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
    throw new ExactTransactionBuilderError("borrow redeem script is not the pinned KIP-10 additive template");
  }
  const ownerPublicKey = redeemScript.slice(ownerStart, ownerEnd);
  if (!/^[a-f0-9]{64}$/.test(ownerPublicKey)) {
    throw new ExactTransactionBuilderError("borrow KIP-10 owner public key is invalid");
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
  } catch (error) {
    throw new ExactTransactionBuilderError("borrow KIP-10 template parameters are invalid", {
      cause: error,
    });
  }
  if (redeemScript !== expectedRedeem || scriptPublicKey !== expectedScript) {
    throw new ExactTransactionBuilderError("borrow redeem script and script public key do not match reservation facts");
  }
}

function validateFinalArtifact(
  artifact: string,
  transactionId: string,
  input: ValidatedBuild,
  borrowArgs: string,
  stagingSignature: string
): void {
  if (artifact.length === 0 || artifact.length > 2_000_000) {
    throw new ExactTransactionBuilderError("final exact transaction artifact is empty or oversized");
  }
  let roundTrip: Transaction | undefined;
  try {
    roundTrip = Transaction.deserializeFromSafeJSON(artifact);
    if (
      String(roundTrip.finalize()).toLowerCase() !== transactionId ||
      roundTrip.serializeToSafeJSON() !== artifact
    ) {
      throw new ExactTransactionBuilderError("final exact transaction artifact is not canonical or id-bound");
    }
  } catch (error) {
    if (error instanceof ExactTransactionBuilderError) throw error;
    throw new ExactTransactionBuilderError("final exact transaction artifact cannot be rehydrated", {
      cause: error,
    });
  } finally {
    roundTrip?.free();
  }

  let value: unknown;
  try {
    value = JSON.parse(artifact);
  } catch (error) {
    throw new ExactTransactionBuilderError("final exact transaction artifact is not safe JSON", {
      cause: error,
    });
  }
  if (!isRecord(value) || !Array.isArray(value.inputs) || !Array.isArray(value.outputs)) {
    throw new ExactTransactionBuilderError("final exact transaction artifact shape is invalid");
  }
  if (
    value.id !== transactionId ||
    value.version !== 1 ||
    value.inputs.length !== 2 ||
    value.outputs.length !== 2 ||
    value.subnetworkId !== NATIVE_SUBNETWORK ||
    value.lockTime !== "0" ||
    value.gas !== "0" ||
    value.payload !== ""
  ) {
    throw new ExactTransactionBuilderError("final exact transaction envelope changed");
  }
  const borrowInput = requireRecord(value.inputs[0], "final borrow input");
  const stagingInput = requireRecord(value.inputs[1], "final staging input");
  validateFinalInput(borrowInput, {
    txid: input.request.reservation.borrowOutpoint!.txid,
    index: input.request.reservation.borrowOutpoint!.index,
    amount: input.borrowAmount.toString(),
    scriptPublicKey: input.borrowScript,
    signatureScript: borrowArgs,
    blockDaaScore: "0",
  });
  validateFinalInput(stagingInput, {
    txid: input.staging.outpoint.txid,
    index: input.staging.outpoint.index,
    amount: input.stagingAmount.toString(),
    scriptPublicKey: input.stagingScript,
    signatureScript: stagingSignature,
    blockDaaScore: input.staging.blockDaaScore,
  });
  validateFinalOutput(value.outputs[0], {
    amount: checkedAdd(input.borrowAmount, input.threshold, "continuation output").toString(),
    scriptPublicKey: input.borrowScript,
  });
  validateFinalOutput(value.outputs[1], {
    amount: input.price.toString(),
    scriptPublicKey: input.merchantScript,
  });
  const inputTotal = checkedAdd(input.borrowAmount, input.stagingAmount, "final input total");
  const outputTotal = checkedAdd(
    checkedAdd(input.borrowAmount, input.threshold, "final continuation total"),
    input.price,
    "final output total"
  );
  if (inputTotal - outputTotal !== input.exactFee) {
    throw new ExactTransactionBuilderError("final exact transaction does not conserve the pinned fee");
  }
}

function validateFinalInput(
  candidate: Record<string, unknown>,
  expected: {
    txid: string;
    index: number;
    amount: string;
    scriptPublicKey: string;
    signatureScript: string;
    blockDaaScore: string;
  }
): void {
  const utxo = requireRecord(candidate.utxo, "final input UTXO");
  if (
    candidate.transactionId !== expected.txid ||
    candidate.index !== expected.index ||
    candidate.sequence !== "0" ||
    candidate.sigOpCount !== 0 ||
    candidate.computeBudget !== SOMPI_EXACT_FEE_POLICY.inputComputeBudget ||
    candidate.signatureScript !== expected.signatureScript ||
    utxo.amount !== expected.amount ||
    utxo.scriptPublicKey !== expected.scriptPublicKey ||
    utxo.blockDaaScore !== expected.blockDaaScore ||
    utxo.address !== null ||
    utxo.covenantId !== null ||
    utxo.isCoinbase !== false
  ) {
    throw new ExactTransactionBuilderError("final exact transaction input facts changed");
  }
}

function validateFinalOutput(
  candidate: unknown,
  expected: { amount: string; scriptPublicKey: string }
): void {
  const output = requireRecord(candidate, "final transaction output");
  if (
    output.value !== expected.amount ||
    output.scriptPublicKey !== expected.scriptPublicKey ||
    output.covenant !== null
  ) {
    throw new ExactTransactionBuilderError("final exact transaction output facts changed");
  }
}

export function minimumRequiredExactFeeSompi(transaction: Transaction): bigint {
  const baseMass = calculateTransactionMass(SDK_NETWORK, transaction);
  const computeMass =
    BigInt(SOMPI_EXACT_FEE_POLICY.inputComputeBudget * 2) *
    BigInt(SOMPI_EXACT_FEE_POLICY.computeBudgetMassPerUnit);
  return (
    baseMass + computeMass
  ) * BigInt(SOMPI_EXACT_FEE_POLICY.feeRateSompiPerGram);
}

function sdkScriptPublicKey(serialized: string): ScriptPublicKey {
  const script = canonicalScript(serialized, "SDK script public key");
  return new ScriptPublicKey(0, script.slice(4));
}

function canonicalScript(value: unknown, label: string): string {
  if (typeof value !== "string" || !SERIALIZED_V0_SCRIPT.test(value)) {
    throw new ExactTransactionBuilderError(`${label} must be a canonical serialized version-0 script`);
  }
  return value;
}

function canonicalHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) {
    throw new ExactTransactionBuilderError(`${label} must be canonical complete hexadecimal bytes`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH32.test(value)) {
    throw new ExactTransactionBuilderError(`${label} must be a canonical 32-byte hash`);
  }
  return value;
}

function uint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw new ExactTransactionBuilderError(`${label} must fit in uint32`);
  }
  return value as number;
}

function uint64(
  value: unknown,
  label: string,
  options: { positive?: boolean } = {}
): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ExactTransactionBuilderError(`${label} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (options.positive && parsed === 0n)) {
    throw new ExactTransactionBuilderError(`${label} is outside uint64 bounds`);
  }
  return parsed;
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  const value = left + right;
  if (value > UINT64_MAX) {
    throw new ExactTransactionBuilderError(`${label} exceeds uint64`);
  }
  return value;
}

function requireCanonicalFutureTime(value: unknown, now: number, label: string): string {
  if (typeof value !== "string") {
    throw new ExactTransactionBuilderError(`${label} is missing`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed <= now) {
    throw new ExactTransactionBuilderError(`${label} is invalid or expired`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExactTransactionBuilderError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string
): void {
  if (!isRecord(value)) {
    throw new ExactTransactionBuilderError(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (keys.length !== sorted.length || keys.some((key, index) => key !== sorted[index])) {
    throw new ExactTransactionBuilderError(`${label} contains missing or unsupported fields`);
  }
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExactTransactionBuilderError("exact transaction clock is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
