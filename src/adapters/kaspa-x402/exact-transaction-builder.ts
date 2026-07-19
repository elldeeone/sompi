import { schnorr } from "@noble/curves/secp256k1.js";
import type {
  ExactTransactionPaymentRequest,
  ExactTransactionPaymentResult,
} from "@kaspa-x402/client";
import {
  bytesToHex,
  exactRequestAuthorizationDigest,
  hexToBytes,
} from "@kaspa-x402/core";
import {
  KIP10_ADDITIVE_TEMPLATE_ID,
  KIP10_EXACT_TRANSACTION_ENCODING,
  buildKip10AdditiveBorrowArgs,
  buildKip10AdditiveRedeemScript,
  calculateKaspaStorageMass,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import {
  ScriptPublicKey,
  SighashType,
  Transaction,
  calculateTransactionFee,
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

/**
 * Testnet-only bounded fee policy. It is an explicit payer cost ceiling, not a
 * dust rule or an amount transferred to the merchant. The final signed
 * transaction is also checked against the SDK's current minimum fee.
 */
export const SOMPI_EXACT_FEE_POLICY = Object.freeze({
  id: "sompi-kaspa-x402-exact-v2-testnet10-fixed-v1",
  feeSompi: "2000000",
  feeRateSompiPerGram: 100,
  vaultChangeMinimumSompi: "10000000",
  p2pkComputeBudget: 10,
  kip10BorrowComputeBudget: 0,
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

export interface ObservedStagingOutput {
  readonly outpoint: { readonly txid: string; readonly index: number };
  readonly amountAtomic: string;
  readonly scriptPublicKey: string;
  readonly address: string;
  readonly blockDaaScore: string;
  readonly keyReference: string;
}

export interface BuildExactTransactionInput {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly request: Readonly<ExactTransactionPaymentRequest>;
  readonly staging: Readonly<ObservedStagingOutput>;
  readonly additionalCostCeilingAtomic: string;
  readonly stagingTransactionFeeAtomic: string;
  readonly expectedTransactionId?: string;
}

export interface ExactTransactionBuilderOptions {
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
  readonly stagingAmount: bigint;
  readonly exactFee: bigint;
  readonly paymentScript: string;
  readonly stagingScript: string;
  readonly head?: {
    readonly amount: bigint;
    readonly threshold: bigint;
    readonly script: string;
    readonly redeemScript: string;
  };
  readonly expectedTransactionId?: string;
}

export class ExactTransactionBuilderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExactTransactionBuilderError";
  }
}

/**
 * Builds the two clean-cut kaspa-exact-v2 profiles from one already-observed,
 * attempt-scoped Treasury staging output.
 */
export class ExactTransactionBuilder {
  private readonly keyStore: StagingKeyStore;
  private readonly now: () => number;
  private readonly addressCodec = new KaspaTestnet10AddressCodec();

  constructor(options: ExactTransactionBuilderOptions) {
    if (!options?.keyStore) {
      throw new ExactTransactionBuilderError("staging key store is required");
    }
    this.keyStore = options.keyStore;
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async build(input: BuildExactTransactionInput): Promise<ExactTransactionPaymentResult> {
    const validated = this.validate(input);
    return this.keyStore.withPrivateKey(validated.keyLookup, (privateKey, record) =>
      this.buildWithKey(validated, privateKey, record)
    );
  }

  private validate(input: BuildExactTransactionInput): ValidatedBuild {
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
    if (!request || request.network !== NETWORK) {
      throw new ExactTransactionBuilderError(`only ${NETWORK} exact transactions are enabled`);
    }
    if (request.profile !== "standard-native" && request.profile !== "additive") {
      throw new ExactTransactionBuilderError("unsupported kaspa-exact-v2 profile");
    }
    if (request.fundingSource !== FUNDING_SOURCE) {
      throw new ExactTransactionBuilderError("exact transaction must use vault-treasury funding");
    }
    const price = uint64(request.amount, "merchant price", { positive: true });
    requireHash(request.requestHash, "exact request hash");
    requireHash(request.paymentRequirementsHash, "payment requirements hash");
    requireCanonicalFutureTime(
      request.authorizationExpiresAt,
      readClock(this.now),
      "request authorization expiry"
    );
    if (request.requiredFinality === "mempool") {
      throw new ExactTransactionBuilderError("Sompi exact requires accepted or confirmed finality");
    }
    const paymentScript = canonicalScript(
      request.payToScriptPublicKey,
      "payment script public key"
    );
    const addressScript = canonicalScript(
      this.addressCodec.scriptPublicKeyForAddress(request.payTo, NETWORK),
      "payTo address script"
    );
    if (paymentScript !== addressScript) {
      throw new ExactTransactionBuilderError("payTo does not match its exact payment script");
    }
    if (request.paymentOutputIndex !== undefined && request.paymentOutputIndex !== 0) {
      throw new ExactTransactionBuilderError("Sompi exact payment output must be index 0");
    }

    const staging = validateStaging(input.staging, this.addressCodec);
    const keyLookup: StagingKeyLookup = {
      purchaseId,
      paymentIdentifier: input.paymentIdentifier,
      keyReference: staging.keyReference,
    };
    const keyRecord = this.keyStore.recover(keyLookup);
    if (
      keyRecord.address !== staging.address ||
      keyRecord.scriptPublicKey !== staging.scriptPublicKey ||
      keyRecord.network !== NETWORK
    ) {
      throw new ExactTransactionBuilderError("observed staging output is bound to a different key");
    }

    const exactFee = BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi);
    const stagingAmount = uint64(staging.amountAtomic, "staging output amount", { positive: true });
    const requiredStaging = checkedAdd(price, exactFee, "price and exact fee");
    if (stagingAmount !== requiredStaging) {
      throw new ExactTransactionBuilderError("exact staging must equal price plus the bounded fee");
    }
    const stagingFee = uint64(input.stagingTransactionFeeAtomic, "vault staging fee");
    const costCeiling = uint64(input.additionalCostCeilingAtomic, "additional-cost ceiling");
    if (checkedAdd(exactFee, stagingFee, "complete additional cost") > costCeiling) {
      throw new ExactTransactionBuilderError("complete additional cost exceeds authorization");
    }

    let head: ValidatedBuild["head"];
    if (request.profile === "standard-native") {
      if (request.head !== undefined) {
        throw new ExactTransactionBuilderError("standard-native exact must not include an additive head");
      }
    } else {
      head = validateAdditiveHead(
        request,
        paymentScript,
        price,
        staging.outpoint,
        readClock(this.now)
      );
    }

    const expectedTransactionId = input.expectedTransactionId === undefined
      ? undefined
      : requireHash(input.expectedTransactionId, "expected exact transaction ID");
    return {
      purchaseId,
      paymentIdentifier: input.paymentIdentifier,
      request,
      staging,
      keyLookup,
      keyRecord,
      price,
      stagingAmount,
      exactFee,
      paymentScript,
      stagingScript: staging.scriptPublicKey,
      ...(head === undefined ? {} : { head }),
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
    return input.request.profile === "additive"
      ? this.buildAdditive(input, privateKey)
      : this.buildStandard(input, privateKey);
  }

  private buildStandard(input: ValidatedBuild, privateKey: PrivateKey): ExactTransactionPaymentResult {
    const stagingScript = sdkScriptPublicKey(input.stagingScript);
    const paymentScript = sdkScriptPublicKey(input.paymentScript);
    let transaction: Transaction | undefined;
    try {
      const shape = {
        version: 0,
        inputs: [legacyInput(input.staging, input.stagingAmount, stagingScript, "")],
        outputs: [{ value: input.price, scriptPublicKey: paymentScript }],
        lockTime: 0n,
        subnetworkId: NATIVE_SUBNETWORK,
        gas: 0n,
        payload: "",
        storageMass: calculateKaspaStorageMass({
          inputs: [{
            amount: input.stagingAmount,
            scriptPublicKey: input.stagingScript,
            hasCovenant: false,
          }],
          outputs: [{
            amount: input.price,
            scriptPublicKey: input.paymentScript,
            hasCovenant: false,
          }],
        }),
      };
      const unsigned = new Transaction(shape as never);
      const signature = createInputSignature(unsigned, 0, privateKey, SighashType.All).toLowerCase();
      unsigned.free();
      transaction = new Transaction({
        ...shape,
        inputs: [legacyInput(input.staging, input.stagingAmount, stagingScript, signature)],
      } as never);
      return this.finish(transaction, input, privateKey, 0);
    } catch (error) {
      if (error instanceof ExactTransactionBuilderError) throw error;
      throw new ExactTransactionBuilderError("standard-native exact construction failed", { cause: error });
    } finally {
      transaction?.free();
      stagingScript.free();
      paymentScript.free();
    }
  }

  private buildAdditive(input: ValidatedBuild, privateKey: PrivateKey): ExactTransactionPaymentResult {
    const head = input.head;
    if (!head || !input.request.head) {
      throw new ExactTransactionBuilderError("additive head disappeared before signing");
    }
    const headScript = sdkScriptPublicKey(head.script);
    const stagingScript = sdkScriptPublicKey(input.stagingScript);
    const headArgs = payToScriptHashSignatureScript(
      head.redeemScript,
      buildKip10AdditiveBorrowArgs()
    ).toLowerCase();
    let transaction: Transaction | undefined;
    try {
      const shape = {
        version: 1,
        inputs: [
          computeInput(
            input.request.head.expectedHeadOutpoint,
            head.amount,
            headScript,
            headArgs,
            SOMPI_EXACT_FEE_POLICY.kip10BorrowComputeBudget
          ),
          computeInput(
            input.staging.outpoint,
            input.stagingAmount,
            stagingScript,
            "",
            SOMPI_EXACT_FEE_POLICY.p2pkComputeBudget,
            BigInt(input.staging.blockDaaScore)
          ),
        ],
        outputs: [{ value: checkedAdd(head.amount, input.price, "additive successor"), scriptPublicKey: headScript }],
        lockTime: 0n,
        subnetworkId: NATIVE_SUBNETWORK,
        gas: 0n,
        payload: "",
        storageMass: calculateKaspaStorageMass({
          inputs: [
            {
              amount: head.amount,
              scriptPublicKey: head.script,
              hasCovenant: false,
            },
            {
              amount: input.stagingAmount,
              scriptPublicKey: input.stagingScript,
              hasCovenant: false,
            },
          ],
          outputs: [{
            amount: checkedAdd(head.amount, input.price, "additive successor"),
            scriptPublicKey: head.script,
            hasCovenant: false,
          }],
        }),
      };
      const unsigned = new Transaction(shape as never);
      const signature = createInputSignature(unsigned, 1, privateKey, SighashType.All).toLowerCase();
      unsigned.free();
      transaction = new Transaction({
        ...shape,
        inputs: [
          shape.inputs[0],
          computeInput(
            input.staging.outpoint,
            input.stagingAmount,
            stagingScript,
            signature,
            SOMPI_EXACT_FEE_POLICY.p2pkComputeBudget,
            BigInt(input.staging.blockDaaScore)
          ),
        ],
      } as never);
      return this.finish(transaction, input, privateKey, 1);
    } catch (error) {
      if (error instanceof ExactTransactionBuilderError) throw error;
      throw new ExactTransactionBuilderError("additive exact construction failed", { cause: error });
    } finally {
      transaction?.free();
      headScript.free();
      stagingScript.free();
    }
  }

  private finish(
    transaction: Transaction,
    input: ValidatedBuild,
    privateKey: PrivateKey,
    authorizationInputIndex: number
  ): ExactTransactionPaymentResult {
    const transactionId = String(transaction.finalize()).toLowerCase();
    requireHash(transactionId, "final exact transaction ID");
    if (input.expectedTransactionId !== undefined && transactionId !== input.expectedTransactionId) {
      throw new ExactTransactionBuilderError("final exact transaction ID changed during recovery");
    }
    const minimumFee = calculateTransactionFee(SDK_NETWORK, transaction);
    if (minimumFee === undefined || input.exactFee < minimumFee) {
      throw new ExactTransactionBuilderError("bounded exact fee is below the final SDK fee");
    }
    const artifact = transaction.serializeToSafeJSON();
    const digest = exactRequestAuthorizationDigest({
      network: input.request.network,
      profile: input.request.profile,
      transactionId,
      paymentOutputIndex: 0,
      amount: input.request.amount,
      payTo: input.request.payTo,
      payToScriptPublicKey: input.request.payToScriptPublicKey,
      paymentRequirementsHash: input.request.paymentRequirementsHash,
      requestHash: input.request.requestHash,
      ...(input.request.head === undefined ? {} : { challengeId: input.request.head.challengeId }),
      inputIndex: authorizationInputIndex,
      expiresAt: input.request.authorizationExpiresAt,
    });
    const signature = bytesToHex(
      schnorr.sign(
        hexToBytes(digest, { expectedLength: 32 }),
        hexToBytes(privateKey.toString(), { expectedLength: 32 })
      )
    );
    return Object.freeze({
      transaction: artifact,
      transactionEncoding: KIP10_EXACT_TRANSACTION_ENCODING,
      transactionId,
      paymentOutputIndex: 0,
      authorization: {
        version: "kaspa-x402-exact-request-authorization-v1" as const,
        inputIndex: authorizationInputIndex,
        expiresAt: input.request.authorizationExpiresAt,
        digest,
        signature,
      },
      payerAddress: input.staging.address,
      fundingSource: FUNDING_SOURCE,
    });
  }
}

function validateStaging(
  staging: Readonly<ObservedStagingOutput>,
  codec: KaspaTestnet10AddressCodec
): Readonly<ObservedStagingOutput> {
  if (!staging || typeof staging !== "object") {
    throw new ExactTransactionBuilderError("observed staging output is missing");
  }
  requireHash(staging.outpoint?.txid, "staging transaction ID");
  uint32(staging.outpoint?.index, "staging output index");
  uint64(staging.blockDaaScore, "staging output DAA score");
  const script = canonicalScript(staging.scriptPublicKey, "staging script public key");
  const addressScript = canonicalScript(
    codec.scriptPublicKeyForAddress(staging.address, NETWORK),
    "staging address script"
  );
  if (script !== addressScript) {
    throw new ExactTransactionBuilderError("staging address and script public key do not match");
  }
  return staging;
}

function validateAdditiveHead(
  request: Readonly<ExactTransactionPaymentRequest>,
  paymentScript: string,
  price: bigint,
  stagingOutpoint: Readonly<{ txid: string; index: number }>,
  now: number
): NonNullable<ValidatedBuild["head"]> {
  const head = request.head;
  if (!head) throw new ExactTransactionBuilderError("additive exact requires a head challenge");
  requireHash(head.headId, "head ID");
  uint64(head.headVersion, "head version");
  requireHash(head.challengeId, "head challenge ID");
  requireCanonicalFutureTime(head.challengeExpiresAt, now, "head challenge expiry");
  requireHash(head.expectedHeadOutpoint?.txid, "head outpoint transaction ID");
  uint32(head.expectedHeadOutpoint?.index, "head outpoint index");
  if (head.expectedHeadOutpoint.index !== 0) {
    throw new ExactTransactionBuilderError("Sompi additive head input and successor must use index 0");
  }
  if (
    head.expectedHeadOutpoint.txid === stagingOutpoint.txid &&
    head.expectedHeadOutpoint.index === stagingOutpoint.index
  ) {
    throw new ExactTransactionBuilderError("head and staging inputs must be distinct");
  }
  const amount = uint64(head.headAmount, "head amount", { positive: true });
  const threshold = uint64(head.additiveThresholdSompi, "additive threshold", { positive: true });
  if (price < threshold) {
    throw new ExactTransactionBuilderError("merchant price is below the additive threshold");
  }
  const script = canonicalScript(head.headScriptPublicKey, "head script public key");
  const redeemScript = canonicalHex(head.headRedeemScript, "head redeem script");
  if (script !== paymentScript) {
    throw new ExactTransactionBuilderError("additive payTo script does not identify the challenged head");
  }
  let expectedRedeem: string;
  let expectedScript: string;
  try {
    const owner = redeemScript.slice(4, 68);
    if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error("invalid owner key");
    expectedRedeem = buildKip10AdditiveRedeemScript({ ownerPublicKey: owner, amount: threshold }).toLowerCase();
    expectedScript = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({ ownerPublicKey: owner, amount: threshold })
    ).toLowerCase();
  } catch (error) {
    throw new ExactTransactionBuilderError("head is not the canonical KIP-10 additive template", { cause: error });
  }
  if (
    expectedRedeem !== redeemScript ||
    expectedScript !== script ||
    request.head === undefined ||
    request.paymentOutputIndex !== undefined && request.paymentOutputIndex !== 0
  ) {
    throw new ExactTransactionBuilderError("head covenant facts do not match the additive challenge");
  }
  void KIP10_ADDITIVE_TEMPLATE_ID;
  return { amount, threshold, script, redeemScript };
}

function legacyInput(
  staging: Readonly<ObservedStagingOutput>,
  amount: bigint,
  scriptPublicKey: ScriptPublicKey,
  signatureScript: string
): Record<string, unknown> {
  return {
    previousOutpoint: { transactionId: staging.outpoint.txid, index: staging.outpoint.index },
    signatureScript,
    sequence: 0n,
    sigOpCount: 1,
    utxo: {
      outpoint: { transactionId: staging.outpoint.txid, index: staging.outpoint.index },
      amount,
      scriptPublicKey,
      blockDaaScore: BigInt(staging.blockDaaScore),
      isCoinbase: false,
    },
  };
}

function computeInput(
  outpoint: Readonly<{ txid: string; index: number }>,
  amount: bigint,
  scriptPublicKey: ScriptPublicKey,
  signatureScript: string,
  computeBudget: number,
  blockDaaScore = 0n
): Record<string, unknown> {
  return {
    previousOutpoint: { transactionId: outpoint.txid, index: outpoint.index },
    signatureScript,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget,
    utxo: {
      outpoint: { transactionId: outpoint.txid, index: outpoint.index },
      amount,
      scriptPublicKey,
      blockDaaScore,
      isCoinbase: false,
    },
  };
}

function sdkScriptPublicKey(serialized: string): ScriptPublicKey {
  const script = canonicalScript(serialized, "SDK script public key");
  return new ScriptPublicKey(0, script.slice(4));
}

function canonicalScript(value: unknown, label: string): string {
  if (typeof value !== "string" || !SERIALIZED_V0_SCRIPT.test(value)) {
    throw new ExactTransactionBuilderError(`${label} must be a canonical serialized version-0 script`);
  }
  return value.toLowerCase();
}

function canonicalHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) {
    throw new ExactTransactionBuilderError(`${label} must be canonical complete hexadecimal bytes`);
  }
  return value.toLowerCase();
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

function uint64(value: unknown, label: string, options: { positive?: boolean } = {}): bigint {
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
  if (value > UINT64_MAX) throw new ExactTransactionBuilderError(`${label} exceeds uint64`);
  return value;
}

function requireCanonicalFutureTime(value: unknown, now: number, label: string): string {
  if (typeof value !== "string") throw new ExactTransactionBuilderError(`${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed <= now) {
    throw new ExactTransactionBuilderError(`${label} is invalid or expired`);
  }
  return value;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExactTransactionBuilderError("exact transaction clock is invalid");
  }
  return value;
}
