import { createHash, randomBytes } from "node:crypto";

import {
  ScriptPublicKey,
  SighashType,
  Transaction,
  calculateTransactionMass,
  createInputSignature,
  type PrivateKey,
} from "../../kaspa-wasm.js";
import { assertPurchaseId } from "../../purchase/identity.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import {
  StagingKeyStore,
  type StagingKeyLookup,
  type StagingKeyRecord,
} from "./staging-key-store.js";

export const ABANDONED_STAGING_RECOVERY_PROFILE =
  "urn:sompi:kaspa-x402:abandoned-staging-recovery:1" as const;
export const ABANDONED_STAGING_RECOVERY_ENCODING =
  "kaspa-sdk-safe-json-v2.0.0" as const;
export const ABANDONED_STAGING_RECOVERY_FEE_POLICY = Object.freeze({
  id: "sompi-abandoned-staging-recovery-testnet10-fixed-v1",
  feeAtomic: "1000000",
  feeRateSompiPerGram: 100,
  computeBudgetMassPerUnit: 100,
  inputComputeBudget: 10,
  minimumStandardOutputAtomic: "10000000",
} as const);

const NETWORK = "kaspa:testnet-10" as const;
const SDK_NETWORK = "testnet-10";
const NATIVE_SUBNETWORK = "00".repeat(20);
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = 0xffff_ffff;
const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const READINESS_ISSUANCE_NONCE = /^[A-Za-z0-9_-]{22}$/;
const PAYMENT_IDENTIFIER = /^pay_[A-Za-z0-9_-]{43}$/;
const SERIALIZED_V0_SCRIPT = /^0000(?:[a-f0-9]{2})+$/;
const SIGNATURE_SCRIPT = /^[a-f0-9]{132}$/;
const MAX_PREPARED_BYTES = 2_000_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_TTL_MS = 5_000;
const MAX_OPERATION_TIMEOUT_MS = 120_000;
const MAX_READINESS_TTL_MS = 30_000;

export interface JournalVerifiedStagingOutput {
  readonly network: typeof NETWORK;
  readonly outpoint: {
    readonly txid: string;
    readonly index: number;
  };
  readonly amountAtomic: string;
  readonly scriptPublicKey: string;
  readonly address: string;
  readonly blockDaaScore: string;
  readonly keyReference: string;
  readonly evidenceDigest: Sha256Digest;
}

export interface ImmutableExactPaymentCandidate {
  readonly transaction: string;
  readonly transactionEncoding: typeof ABANDONED_STAGING_RECOVERY_ENCODING;
  readonly transactionId: string;
  readonly merchantOutputIndex: 1;
}

export type ImmutableExactPaymentSelection =
  | {
      readonly mode: "exact_candidate";
      readonly candidate: Readonly<ImmutableExactPaymentCandidate>;
    }
  | { readonly mode: "no_exact_candidate" };

export interface PrepareAbandonedStagingRecoveryInput {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly staging: Readonly<JournalVerifiedStagingOutput>;
  readonly exactPayment: Readonly<ImmutableExactPaymentSelection>;
  /** Recovery replay assertion for an already-journalled immutable sweep. */
  readonly expectedRecoveryTransactionId?: string;
}

export interface PreparedAbandonedStagingRecovery {
  /** These exact bytes are the artifact the Purchase effect must persist. */
  readonly preparedBytes: Uint8Array;
  readonly preparedDigest: Sha256Digest;
  readonly transactionId: string;
  readonly exactPaymentTransactionId?: string;
  readonly recoveryAmountAtomic: string;
  readonly feeAtomic: string;
}

export interface StagingRecoveryExpectedCandidate {
  readonly transactionId: string;
  readonly transactionArtifactDigest: Sha256Digest;
  readonly inputOutpoint: string;
  readonly outputOutpoint: string;
  readonly outputIndex: number;
  readonly outputAddress: string;
  readonly outputAmountAtomic: string;
  readonly outputScriptPublicKey: string;
}

export type StagingRecoveryCandidateObservation =
  | {
      readonly status: "absent";
      readonly detailDigest: Sha256Digest;
    }
  | {
      readonly status: "partial";
      readonly detailDigest: Sha256Digest;
    }
  | {
      readonly status: "observed";
      readonly transactionId: string;
      readonly inputOutpoint: string;
      readonly outputOutpoint: string;
      readonly outputAmountAtomic: string;
      readonly outputScriptPublicKey: string;
      readonly finality: "mempool" | "accepted" | "confirmed";
      readonly detailDigest: Sha256Digest;
    };

export type StagingRecoveryOutpointObservation =
  | {
      readonly status: "unspent";
      readonly outpoint: string;
      readonly amountAtomic: string;
      readonly scriptPublicKey: string;
      readonly blockDaaScore: string;
      readonly detailDigest: Sha256Digest;
    }
  | {
      readonly status: "spent";
      readonly spendingTransactionId?: string;
      readonly detailDigest: Sha256Digest;
    }
  | {
      readonly status: "unknown" | "partial";
      readonly detailDigest: Sha256Digest;
    };

export interface StagingRecoveryRaceRequest {
  readonly network: typeof NETWORK;
  readonly staging: {
    readonly outpoint: string;
    readonly address: string;
    readonly amountAtomic: string;
    readonly scriptPublicKey: string;
    readonly blockDaaScore: string;
  };
  readonly exactPayment: Readonly<StagingRecoveryExpectedCandidate> | null;
  readonly recovery: Readonly<StagingRecoveryExpectedCandidate>;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export interface StagingRecoveryRaceEvidence {
  readonly staging: StagingRecoveryOutpointObservation;
  readonly exactPayment: StagingRecoveryCandidateObservation | null;
  readonly recovery: StagingRecoveryCandidateObservation;
}

/** Read-only race observer. It deliberately has no submission method. */
export interface StagingRecoveryRaceSource {
  observeRace(
    request: Readonly<StagingRecoveryRaceRequest>
  ): Promise<Readonly<StagingRecoveryRaceEvidence>>;
}

export interface StagingRecoverySubmissionRequest {
  readonly network: typeof NETWORK;
  readonly transactionId: string;
  readonly transaction: string;
  readonly transactionEncoding: typeof ABANDONED_STAGING_RECOVERY_ENCODING;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export interface StagingRecoveryTransactionSubmitter {
  submitRecovery(
    request: Readonly<StagingRecoverySubmissionRequest>
  ): Promise<{ readonly transactionId: string }>;
}

export interface StagingRecoveryReadiness {
  readonly version: 1;
  readonly profile: typeof ABANDONED_STAGING_RECOVERY_PROFILE;
  readonly preparedDigest: Sha256Digest;
  readonly recoveryTransactionId: string;
  readonly exactPaymentTransactionId: string | null;
  readonly raceEvidenceDigest: Sha256Digest;
  /** Per-observation capability entropy; never persisted as Purchase state. */
  readonly issuanceNonce: string;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly proofDigest: Sha256Digest;
}

export type AbandonedStagingRecoveryConflictReason =
  | "exact_payment_won"
  | "partial_evidence"
  | "both_candidates_observed"
  | "candidate_observed_while_staging_unspent"
  | "candidate_observed_with_unknown_staging"
  | "unknown_staging_spender"
  | "spending_transaction_mismatch";

export type AbandonedStagingRecoveryObservation =
  | {
      readonly status: "safe_to_submit";
      readonly readiness: Readonly<StagingRecoveryReadiness>;
      readonly evidenceDigest: Sha256Digest;
    }
  | {
      readonly status: "pending";
      readonly evidenceDigest: Sha256Digest;
    }
  | {
      readonly status: "recovery_won";
      readonly transactionId: string;
      readonly recoveryOutpoint: string;
      readonly recoveryAmountAtomic: string;
      readonly finality: "mempool" | "accepted" | "confirmed";
      readonly evidenceDigest: Sha256Digest;
    }
  | {
      readonly status: "conflict";
      readonly reason: AbandonedStagingRecoveryConflictReason;
      /** Present when the immutable exact payment is the explicit winner. */
      readonly winningTransactionId?: string;
      readonly winningFinality?: "mempool" | "accepted" | "confirmed";
      readonly evidenceDigest: Sha256Digest;
    };

export type AbandonedStagingRecoverySubmission =
  | {
      readonly status: "accepted";
      readonly transactionId: string;
      readonly submissionDigest: Sha256Digest;
    }
  | {
      readonly status: "ambiguous";
      readonly transactionId: string;
      readonly submissionDigest: Sha256Digest;
    }
  | {
      readonly status: "conflict";
      readonly transactionId: string;
      readonly submissionDigest: Sha256Digest;
    };

export interface AbandonedStagingRecoveryOptions {
  readonly keyStore: StagingKeyStore;
  /** Explicit operator-configured Sompi wallet address; inputs cannot override it. */
  readonly recoveryAddress: string;
  readonly observer: StagingRecoveryRaceSource;
  readonly submitter: StagingRecoveryTransactionSubmitter;
  readonly operationTimeoutMs?: number;
  readonly readinessTtlMs?: number;
  readonly now?: () => number;
}

export type AbandonedStagingRecoveryErrorCode =
  | "invalid_input"
  | "artifact_mismatch"
  | "cost_mismatch"
  | "profile_mismatch"
  | "readiness_required"
  | "readiness_replay"
  | "deadline_exceeded"
  | "source_failure";

export class AbandonedStagingRecoveryError extends Error {
  constructor(
    readonly code: AbandonedStagingRecoveryErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "AbandonedStagingRecoveryError";
  }
}

interface ExactCandidateFacts extends StagingRecoveryExpectedCandidate {
  readonly artifact: string;
}

export interface AbandonedStagingRecoveryEnvelope {
  readonly version: 1;
  readonly profile: typeof ABANDONED_STAGING_RECOVERY_PROFILE;
  readonly network: typeof NETWORK;
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly keyReference: string;
  readonly staging: {
    readonly outpoint: string;
    readonly amountAtomic: string;
    readonly scriptPublicKey: string;
    readonly address: string;
    readonly blockDaaScore: string;
    readonly evidenceDigest: Sha256Digest;
  };
  readonly exactPayment: StagingRecoveryExpectedCandidate | null;
  readonly recovery: {
    readonly transaction: string;
    readonly transactionEncoding: typeof ABANDONED_STAGING_RECOVERY_ENCODING;
    readonly transactionId: string;
    readonly transactionArtifactDigest: Sha256Digest;
    readonly outputOutpoint: string;
    readonly outputIndex: 0;
    readonly outputAddress: string;
    readonly outputAmountAtomic: string;
    readonly outputScriptPublicKey: string;
    readonly feeAtomic: string;
  };
}

/**
 * Adapter-local abandoned staging recovery.
 *
 * The caller persists `preparedBytes` as a planned Purchase effect before it
 * may call `submit`. Submission additionally requires a fresh, single-use
 * proof that both competing immutable transactions were absent and the exact
 * staging outpoint remained unspent. An RPC exception is returned as
 * `ambiguous`; it never creates an implicit retry permission.
 */
export class AbandonedStagingRecovery {
  private readonly keyStore: StagingKeyStore;
  private readonly recoveryAddress: string;
  private readonly recoveryScriptPublicKey: string;
  private readonly observer: StagingRecoveryRaceSource;
  private readonly submitter: StagingRecoveryTransactionSubmitter;
  private readonly operationTimeoutMs: number;
  private readonly readinessTtlMs: number;
  private readonly now: () => number;
  private readonly readinessProofs = new Map<
    string,
    Readonly<{
      operationId: string;
      preparedDigest: Sha256Digest;
      state: "issued" | "consumed";
      expiresAtMs: number;
    }>
  >();
  private readonly readinessOperations = new Map<
    string,
    { generation: number; inFlightObservations: number; submissionInFlight: boolean }
  >();
  private readonly addressCodec = new KaspaTestnet10AddressCodec();

  constructor(options: AbandonedStagingRecoveryOptions) {
    if (!options?.keyStore) throw adapterError("invalid_input", "staging key store is required");
    if (typeof options.observer?.observeRace !== "function") {
      throw adapterError("invalid_input", "staging recovery race observer is required");
    }
    if (typeof options.submitter?.submitRecovery !== "function") {
      throw adapterError("invalid_input", "staging recovery transaction submitter is required");
    }
    this.keyStore = options.keyStore;
    this.recoveryAddress = requireAddress(
      options.recoveryAddress,
      this.addressCodec,
      "configured Sompi wallet recovery address"
    );
    this.recoveryScriptPublicKey = canonicalScript(
      this.addressCodec.scriptPublicKeyForAddress(this.recoveryAddress, NETWORK),
      "configured recovery script public key"
    );
    this.observer = options.observer;
    this.submitter = options.submitter;
    this.operationTimeoutMs = boundedPositiveInteger(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      MAX_OPERATION_TIMEOUT_MS,
      "staging recovery operation timeout"
    );
    this.readinessTtlMs = boundedPositiveInteger(
      options.readinessTtlMs ?? DEFAULT_READINESS_TTL_MS,
      MAX_READINESS_TTL_MS,
      "staging recovery readiness lifetime"
    );
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async prepare(
    input: Readonly<PrepareAbandonedStagingRecoveryInput>
  ): Promise<Readonly<PreparedAbandonedStagingRecovery>> {
    const normalized = this.validatePrepareInput(input);
    const envelope = await this.keyStore.withPrivateKey(
      normalized.keyLookup,
      (privateKey, record) => this.buildEnvelope(normalized, privateKey, record)
    );
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    if (bytes.byteLength > MAX_PREPARED_BYTES) {
      throw adapterError("artifact_mismatch", "staging recovery envelope is oversized");
    }
    const decoded = decodeAbandonedStagingRecoveryEnvelope(bytes);
    const preparedDigest = digestBytes(bytes);
    return Object.freeze({
      preparedBytes: Uint8Array.from(bytes),
      preparedDigest,
      transactionId: decoded.recovery.transactionId,
      ...(decoded.exactPayment === null
        ? {}
        : { exactPaymentTransactionId: decoded.exactPayment.transactionId }),
      recoveryAmountAtomic: decoded.recovery.outputAmountAtomic,
      feeAtomic: decoded.recovery.feeAtomic,
    });
  }

  async observe(
    preparedBytes: Uint8Array,
    signal = new AbortController().signal
  ): Promise<Readonly<AbandonedStagingRecoveryObservation>> {
    const { envelope, preparedDigest } = this.requirePrepared(preparedBytes);
    const operationId = envelope.recovery.transactionId;
    if (signal.aborted) throw abortError(signal);
    const now = readClock(this.now);
    this.pruneReadinessProofs(now);
    const observationLifetime = this.beginReadinessObservation(operationId);
    const deadlineAtMs = checkedDeadline(now, this.operationTimeoutMs);
    try {
      let raw: Readonly<StagingRecoveryRaceEvidence>;
      try {
        raw = await boundedCall(
          this.observer.observeRace({
            network: NETWORK,
            staging: Object.freeze({
              outpoint: envelope.staging.outpoint,
              address: envelope.staging.address,
              amountAtomic: envelope.staging.amountAtomic,
              scriptPublicKey: envelope.staging.scriptPublicKey,
              blockDaaScore: envelope.staging.blockDaaScore,
            }),
            exactPayment:
              envelope.exactPayment === null
                ? null
                : Object.freeze({ ...envelope.exactPayment }),
            recovery: recoveryCandidate(envelope),
            deadlineAtMs,
            signal,
          }),
          deadlineAtMs,
          this.now,
          signal
        );
      } catch (cause) {
        if (cause instanceof AbandonedStagingRecoveryError) throw cause;
        throw adapterError("source_failure", "staging recovery race observation failed", { cause });
      }

      return this.classifyObservation(
        envelope,
        preparedDigest,
        operationId,
        raw,
        observationLifetime
      );
    } finally {
      this.endReadinessObservation(operationId);
    }
  }

  async submit(
    preparedBytes: Uint8Array,
    readiness: Readonly<StagingRecoveryReadiness>,
    signal = new AbortController().signal
  ): Promise<Readonly<AbandonedStagingRecoverySubmission>> {
    const { envelope, preparedDigest } = this.requirePrepared(preparedBytes);
    const now = readClock(this.now);
    validateReadiness(readiness, envelope, preparedDigest, now);
    this.pruneReadinessProofs(now);
    const issued = this.readinessProofs.get(readiness.proofDigest);
    if (!issued) {
      throw adapterError(
        "readiness_required",
        "staging recovery readiness was not issued by this staging recovery observer"
      );
    }
    if (issued.state === "consumed") {
      throw adapterError(
        "readiness_replay",
        "staging recovery readiness proof was already consumed; observe the race again"
      );
    }
    if (issued.preparedDigest !== preparedDigest) {
      throw adapterError("readiness_required", "staging recovery readiness changed its operation");
    }
    const operationId = envelope.recovery.transactionId;
    if (issued.operationId !== operationId) {
      throw adapterError("readiness_required", "staging recovery readiness changed its operation");
    }
    this.beginReadinessSubmission(operationId);
    this.consumeReadinessProofs(operationId);
    try {
      if (signal.aborted) throw abortError(signal);
      const deadlineAtMs = checkedDeadline(now, this.operationTimeoutMs);
      const submissionBase = {
        profile: ABANDONED_STAGING_RECOVERY_PROFILE,
        preparedDigest,
        readinessProofDigest: readiness.proofDigest,
        recoveryTransactionId: envelope.recovery.transactionId,
      };
      try {
        const submitted = await boundedCall(
          this.submitter.submitRecovery({
            network: NETWORK,
            transactionId: envelope.recovery.transactionId,
            transaction: envelope.recovery.transaction,
            transactionEncoding: envelope.recovery.transactionEncoding,
            deadlineAtMs,
            signal,
          }),
          deadlineAtMs,
          this.now,
          signal,
        );
        if (!submitted || !HASH32.test(submitted.transactionId)) {
          return Object.freeze({
            status: "conflict" as const,
            transactionId: envelope.recovery.transactionId,
            submissionDigest: digestCanonical({ ...submissionBase, status: "conflict" }),
          });
        }
        if (submitted.transactionId !== envelope.recovery.transactionId) {
          return Object.freeze({
            status: "conflict" as const,
            transactionId: envelope.recovery.transactionId,
            submissionDigest: digestCanonical({
              ...submissionBase,
              status: "conflict",
              returnedTransactionId: submitted.transactionId,
            }),
          });
        }
        return Object.freeze({
          status: "accepted" as const,
          transactionId: submitted.transactionId,
          submissionDigest: digestCanonical({ ...submissionBase, status: "accepted" }),
        });
      } catch (cause) {
        // A timeout/transport failure can occur after the node accepted bytes.
        // The same is true for cancellation after invocation. No cause text is
        // exposed or used as permission to retry.
        return Object.freeze({
          status: "ambiguous" as const,
          transactionId: envelope.recovery.transactionId,
          submissionDigest: digestCanonical({ ...submissionBase, status: "ambiguous" }),
        });
      }
    } finally {
      this.endReadinessSubmission(operationId);
    }
  }

  private validatePrepareInput(input: Readonly<PrepareAbandonedStagingRecoveryInput>): {
    purchaseId: PurchaseId;
    paymentIdentifier: string;
    staging: Readonly<JournalVerifiedStagingOutput>;
    keyLookup: StagingKeyLookup;
    keyRecord: StagingKeyRecord;
    exactPayment: ExactCandidateFacts | null;
    expectedRecoveryTransactionId?: string;
  } {
    if (!input || typeof input !== "object") {
      throw adapterError("invalid_input", "staging recovery input is invalid");
    }
    let purchaseId: PurchaseId;
    try {
      purchaseId = assertPurchaseId(input.purchaseId);
    } catch {
      throw adapterError("invalid_input", "staging recovery Purchase identity is invalid");
    }
    const paymentIdentifier = requirePaymentIdentifier(input.paymentIdentifier);
    const staging = validateStagingInput(input.staging, this.addressCodec);
    const keyLookup: StagingKeyLookup = {
      purchaseId,
      paymentIdentifier,
      keyReference: staging.keyReference,
    };
    let keyRecord: StagingKeyRecord;
    try {
      keyRecord = this.keyStore.recover(keyLookup);
    } catch (cause) {
      throw adapterError("artifact_mismatch", "staging recovery key reference is unavailable or misbound", {
        cause,
      });
    }
    if (
      keyRecord.network !== NETWORK ||
      keyRecord.address !== staging.address ||
      keyRecord.scriptPublicKey !== staging.scriptPublicKey
    ) {
      throw adapterError(
        "artifact_mismatch",
        "journal-verified staging output is bound to a different recovery key"
      );
    }
    const exactPayment = validateExactPaymentSelection(
      input.exactPayment,
      staging,
      this.addressCodec
    );
    const expectedRecoveryTransactionId =
      input.expectedRecoveryTransactionId === undefined
        ? undefined
        : requireHash(input.expectedRecoveryTransactionId, "expected recovery transaction ID");
    return {
      purchaseId,
      paymentIdentifier,
      staging,
      keyLookup,
      keyRecord,
      exactPayment,
      ...(expectedRecoveryTransactionId === undefined
        ? {}
        : { expectedRecoveryTransactionId }),
    };
  }

  private buildEnvelope(
    input: ReturnType<AbandonedStagingRecovery["validatePrepareInput"]>,
    privateKey: PrivateKey,
    record: StagingKeyRecord
  ): AbandonedStagingRecoveryEnvelope {
    if (
      record.keyReference !== input.keyRecord.keyReference ||
      record.address !== input.keyRecord.address ||
      record.scriptPublicKey !== input.keyRecord.scriptPublicKey
    ) {
      throw adapterError("artifact_mismatch", "staging recovery key changed before signing");
    }
    const stagingAmount = uint64(input.staging.amountAtomic, "staging recovery input amount", {
      positive: true,
    });
    const fee = BigInt(ABANDONED_STAGING_RECOVERY_FEE_POLICY.feeAtomic);
    if (stagingAmount <= fee) {
      throw adapterError("cost_mismatch", "staging output cannot fund the pinned recovery fee");
    }
    const recoveryAmount = stagingAmount - fee;
    if (recoveryAmount < BigInt(ABANDONED_STAGING_RECOVERY_FEE_POLICY.minimumStandardOutputAtomic)) {
      throw adapterError(
        "cost_mismatch",
        "staging recovery output is below the pinned standard-output floor"
      );
    }

    const stagingScript = sdkScriptPublicKey(input.staging.scriptPublicKey);
    const recoveryScript = sdkScriptPublicKey(this.recoveryScriptPublicKey);
    let transaction: Transaction | undefined;
    try {
      transaction = new Transaction({
        version: 1,
        inputs: [
          transactionInput({
            txid: input.staging.outpoint.txid,
            index: input.staging.outpoint.index,
            amount: stagingAmount,
            scriptPublicKey: stagingScript,
            blockDaaScore: BigInt(input.staging.blockDaaScore),
          }),
        ],
        outputs: [{ value: recoveryAmount, scriptPublicKey: recoveryScript }],
        lockTime: 0n,
        subnetworkId: NATIVE_SUBNETWORK,
        gas: 0n,
        payload: "",
      } as never);
      const signatureScript = createInputSignature(
        transaction,
        0,
        privateKey,
        SighashType.All
      ).toLowerCase();
      if (!SIGNATURE_SCRIPT.test(signatureScript)) {
        throw adapterError("artifact_mismatch", "staging recovery signer returned invalid bytes");
      }
      const inputs = transaction.inputs;
      inputs[0].signatureScript = signatureScript;
      inputs[0].sigOpCount = 0;
      inputs[0].computeBudget = ABANDONED_STAGING_RECOVERY_FEE_POLICY.inputComputeBudget;
      transaction.inputs = inputs;

      const transactionId = requireHash(
        String(transaction.finalize()).toLowerCase(),
        "final staging recovery transaction ID"
      );
      if (
        input.expectedRecoveryTransactionId !== undefined &&
        transactionId !== input.expectedRecoveryTransactionId
      ) {
        throw adapterError(
          "artifact_mismatch",
          "staging recovery transaction changed from its journalled identity"
        );
      }
      if (input.exactPayment && transactionId === input.exactPayment.transactionId) {
        throw adapterError("artifact_mismatch", "recovery and exact payment identities collide");
      }
      const minimumFee = minimumRequiredFee(transaction);
      if (fee < minimumFee) {
        throw adapterError(
          "cost_mismatch",
          "pinned staging recovery fee is below final signed transaction mass"
        );
      }
      const artifact = transaction.serializeToSafeJSON();
      validateRecoveryTransaction({
        artifact,
        transactionId,
        staging: input.staging,
        recoveryAddress: this.recoveryAddress,
        recoveryScriptPublicKey: this.recoveryScriptPublicKey,
        recoveryAmountAtomic: recoveryAmount.toString(),
        feeAtomic: fee.toString(),
        addressCodec: this.addressCodec,
      });
      return Object.freeze({
        version: 1 as const,
        profile: ABANDONED_STAGING_RECOVERY_PROFILE,
        network: NETWORK,
        purchaseId: input.purchaseId,
        paymentIdentifier: input.paymentIdentifier,
        keyReference: input.staging.keyReference,
        staging: Object.freeze({
          outpoint: outpointString(input.staging.outpoint),
          amountAtomic: input.staging.amountAtomic,
          scriptPublicKey: input.staging.scriptPublicKey,
          address: input.staging.address,
          blockDaaScore: input.staging.blockDaaScore,
          evidenceDigest: input.staging.evidenceDigest,
        }),
        exactPayment:
          input.exactPayment === null
            ? null
            : Object.freeze({
                transactionId: input.exactPayment.transactionId,
                transactionArtifactDigest: input.exactPayment.transactionArtifactDigest,
                inputOutpoint: input.exactPayment.inputOutpoint,
                outputOutpoint: input.exactPayment.outputOutpoint,
                outputIndex: input.exactPayment.outputIndex,
                outputAddress: input.exactPayment.outputAddress,
                outputAmountAtomic: input.exactPayment.outputAmountAtomic,
                outputScriptPublicKey: input.exactPayment.outputScriptPublicKey,
              }),
        recovery: Object.freeze({
          transaction: artifact,
          transactionEncoding: ABANDONED_STAGING_RECOVERY_ENCODING,
          transactionId,
          transactionArtifactDigest: digestBytes(Buffer.from(artifact, "utf8")),
          outputOutpoint: `${transactionId}:0`,
          outputIndex: 0 as const,
          outputAddress: this.recoveryAddress,
          outputAmountAtomic: recoveryAmount.toString(),
          outputScriptPublicKey: this.recoveryScriptPublicKey,
          feeAtomic: fee.toString(),
        }),
      });
    } catch (cause) {
      if (cause instanceof AbandonedStagingRecoveryError) throw cause;
      throw adapterError("artifact_mismatch", "staging recovery transaction construction failed", {
        cause,
      });
    } finally {
      transaction?.free();
      stagingScript.free();
      recoveryScript.free();
    }
  }

  private requirePrepared(bytes: Uint8Array): {
    envelope: Readonly<AbandonedStagingRecoveryEnvelope>;
    preparedDigest: Sha256Digest;
  } {
    const envelope = decodeAbandonedStagingRecoveryEnvelope(bytes);
    if (
      envelope.recovery.outputAddress !== this.recoveryAddress ||
      envelope.recovery.outputScriptPublicKey !== this.recoveryScriptPublicKey
    ) {
      throw adapterError(
        "artifact_mismatch",
        "staging recovery envelope targets a different configured wallet"
      );
    }
    let key: StagingKeyRecord;
    try {
      key = this.keyStore.recover({
        purchaseId: envelope.purchaseId,
        paymentIdentifier: envelope.paymentIdentifier,
        keyReference: envelope.keyReference,
      });
    } catch (cause) {
      throw adapterError("artifact_mismatch", "staging recovery key is unavailable or misbound", {
        cause,
      });
    }
    if (
      key.address !== envelope.staging.address ||
      key.scriptPublicKey !== envelope.staging.scriptPublicKey ||
      key.network !== NETWORK
    ) {
      throw adapterError("artifact_mismatch", "staging recovery envelope changed its key binding");
    }
    return { envelope, preparedDigest: digestBytes(bytes) };
  }

  private classifyObservation(
    envelope: Readonly<AbandonedStagingRecoveryEnvelope>,
    preparedDigest: Sha256Digest,
    operationId: string,
    raw: Readonly<StagingRecoveryRaceEvidence>,
    observationLifetime: Readonly<{
      generation: number;
      submissionInFlightAtStart: boolean;
    }>
  ): Readonly<AbandonedStagingRecoveryObservation> {
    const evidenceDigest = observationDigest(envelope, preparedDigest, raw);
    const exact =
      envelope.exactPayment === null
        ? raw?.exactPayment === null
          ? ({ status: "absent" as const, detailDigest: evidenceDigest })
          : ({ status: "partial" as const, detailDigest: evidenceDigest })
        : candidateMatches(raw?.exactPayment ?? undefined, envelope.exactPayment);
    const recovery = candidateMatches(raw?.recovery, recoveryCandidate(envelope));
    const staging = stagingMatches(raw?.staging, envelope.staging);

    if (exact.status === "partial" || recovery.status === "partial" || staging === "partial") {
      return conflict("partial_evidence", evidenceDigest);
    }
    if (exact.status === "observed" && recovery.status === "observed") {
      return conflict("both_candidates_observed", evidenceDigest);
    }
    if (staging.status === "unspent") {
      // The accepted UTXO set can still contain the source while one candidate
      // is only in mempool. That is a provisional explicit winner, not a
      // contradiction. Accepted/confirmed output evidence with an unspent
      // source is contradictory.
      if (exact.status === "observed" && exact.finality === "mempool") {
        return conflict(
          "exact_payment_won",
          evidenceDigest,
          envelope.exactPayment!.transactionId,
          exact.finality
        );
      }
      if (recovery.status === "observed" && recovery.finality === "mempool") {
        return recoveryWon(envelope, recovery.finality, evidenceDigest);
      }
      if (exact.status === "observed" || recovery.status === "observed") {
        return conflict("candidate_observed_while_staging_unspent", evidenceDigest);
      }
      if (exact.status === "absent" && recovery.status === "absent") {
        const operation = this.readinessOperations.get(operationId);
        if (
          !operation ||
          observationLifetime.submissionInFlightAtStart ||
          operation.generation !== observationLifetime.generation ||
          operation.submissionInFlight
        ) {
          return Object.freeze({ status: "pending" as const, evidenceDigest });
        }
        const observedAtMs = readClock(this.now);
        const proofBase = {
          version: 1 as const,
          profile: ABANDONED_STAGING_RECOVERY_PROFILE,
          preparedDigest,
          recoveryTransactionId: envelope.recovery.transactionId,
          exactPaymentTransactionId: envelope.exactPayment?.transactionId ?? null,
          raceEvidenceDigest: evidenceDigest,
          issuanceNonce: randomBytes(16).toString("base64url"),
          observedAtMs,
          expiresAtMs: checkedDeadline(observedAtMs, this.readinessTtlMs),
        };
        const readiness = Object.freeze({
          ...proofBase,
          proofDigest: digestCanonical(proofBase),
        });
        this.pruneReadinessProofs(observedAtMs);
        this.consumeReadinessProofs(operationId);
        this.readinessProofs.set(readiness.proofDigest, Object.freeze({
          operationId,
          preparedDigest,
          state: "issued",
          expiresAtMs: readiness.expiresAtMs,
        }));
        return Object.freeze({ status: "safe_to_submit" as const, readiness, evidenceDigest });
      }
      return Object.freeze({ status: "pending" as const, evidenceDigest });
    }
    if (staging.status === "unknown") {
      if (exact.status === "observed" || recovery.status === "observed") {
        return conflict("candidate_observed_with_unknown_staging", evidenceDigest);
      }
      return Object.freeze({ status: "pending" as const, evidenceDigest });
    }

    if (exact.status === "observed") {
      if (
        staging.spendingTransactionId !== undefined &&
        staging.spendingTransactionId !== envelope.exactPayment!.transactionId
      ) {
        return conflict("spending_transaction_mismatch", evidenceDigest);
      }
      return conflict(
        "exact_payment_won",
        evidenceDigest,
        envelope.exactPayment!.transactionId,
        exact.finality
      );
    }
    if (recovery.status === "observed") {
      if (
        staging.spendingTransactionId !== undefined &&
        staging.spendingTransactionId !== envelope.recovery.transactionId
      ) {
        return conflict("spending_transaction_mismatch", evidenceDigest);
      }
      return recoveryWon(envelope, recovery.finality, evidenceDigest);
    }
    return conflict("unknown_staging_spender", evidenceDigest);
  }

  private pruneReadinessProofs(now: number): void {
    const affected = new Set<string>();
    for (const [proofDigest, readiness] of this.readinessProofs) {
      if (readiness.expiresAtMs <= now) {
        this.readinessProofs.delete(proofDigest);
        affected.add(readiness.operationId);
      }
    }
    for (const operationId of affected) {
      this.cleanupReadinessOperation(operationId);
    }
  }

  private consumeReadinessProofs(operationId: string): void {
    for (const [proofDigest, readiness] of this.readinessProofs) {
      if (readiness.operationId !== operationId || readiness.state === "consumed") continue;
      this.readinessProofs.set(proofDigest, Object.freeze({
        ...readiness,
        state: "consumed",
      }));
    }
  }

  private beginReadinessObservation(operationId: string): Readonly<{
    generation: number;
    submissionInFlightAtStart: boolean;
  }> {
    const operation = this.readinessOperations.get(operationId) ?? {
      generation: 0,
      inFlightObservations: 0,
      submissionInFlight: false,
    };
    operation.inFlightObservations += 1;
    this.readinessOperations.set(operationId, operation);
    return Object.freeze({
      generation: operation.generation,
      submissionInFlightAtStart: operation.submissionInFlight,
    });
  }

  private endReadinessObservation(operationId: string): void {
    const operation = this.readinessOperations.get(operationId);
    if (!operation || operation.inFlightObservations <= 0) {
      throw adapterError("artifact_mismatch", "staging recovery observation lifetime is invalid");
    }
    operation.inFlightObservations -= 1;
    this.cleanupReadinessOperation(operationId);
  }

  private beginReadinessSubmission(operationId: string): void {
    const operation = this.readinessOperations.get(operationId);
    if (
      !operation ||
      operation.submissionInFlight ||
      operation.generation >= Number.MAX_SAFE_INTEGER
    ) {
      throw adapterError("readiness_required", "staging recovery readiness generation is invalid");
    }
    operation.generation += 1;
    operation.submissionInFlight = true;
  }

  private endReadinessSubmission(operationId: string): void {
    const operation = this.readinessOperations.get(operationId);
    if (!operation || !operation.submissionInFlight) {
      throw adapterError("artifact_mismatch", "staging recovery submission lifetime is invalid");
    }
    operation.submissionInFlight = false;
    this.cleanupReadinessOperation(operationId);
  }

  private cleanupReadinessOperation(operationId: string): void {
    const operation = this.readinessOperations.get(operationId);
    if (
      !operation ||
      operation.inFlightObservations !== 0 ||
      operation.submissionInFlight
    ) return;
    for (const readiness of this.readinessProofs.values()) {
      if (readiness.operationId === operationId) return;
    }
    this.readinessOperations.delete(operationId);
  }
}

/** Public journal decoder. It validates every canonical and transaction fact. */
export function decodeAbandonedStagingRecoveryEnvelope(
  bytes: Uint8Array
): Readonly<AbandonedStagingRecoveryEnvelope> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_PREPARED_BYTES) {
    throw adapterError("artifact_mismatch", "staging recovery envelope bytes are invalid");
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("line");
    value = JSON.parse(text.slice(0, -1));
  } catch (cause) {
    throw adapterError("artifact_mismatch", "staging recovery envelope is malformed", { cause });
  }
  const envelope = validateEnvelopeShape(value);
  if (`${JSON.stringify(envelope)}\n` !== text) {
    throw adapterError("artifact_mismatch", "staging recovery envelope is not canonical JSON");
  }
  validateRecoveryTransaction({
    artifact: envelope.recovery.transaction,
    transactionId: envelope.recovery.transactionId,
    staging: {
      network: NETWORK,
      outpoint: parseOutpoint(envelope.staging.outpoint, "staging outpoint"),
      amountAtomic: envelope.staging.amountAtomic,
      scriptPublicKey: envelope.staging.scriptPublicKey,
      address: envelope.staging.address,
      blockDaaScore: envelope.staging.blockDaaScore,
      keyReference: envelope.keyReference,
      evidenceDigest: envelope.staging.evidenceDigest,
    },
    recoveryAddress: envelope.recovery.outputAddress,
    recoveryScriptPublicKey: envelope.recovery.outputScriptPublicKey,
    recoveryAmountAtomic: envelope.recovery.outputAmountAtomic,
    feeAtomic: envelope.recovery.feeAtomic,
    addressCodec: new KaspaTestnet10AddressCodec(),
  });
  if (
    digestBytes(Buffer.from(envelope.recovery.transaction, "utf8")) !==
    envelope.recovery.transactionArtifactDigest
  ) {
    throw adapterError("artifact_mismatch", "staging recovery transaction digest changed");
  }
  return deepFreeze(envelope);
}

function validateEnvelopeShape(value: unknown): AbandonedStagingRecoveryEnvelope {
  const root = exactRecord(value, [
    "version",
    "profile",
    "network",
    "purchaseId",
    "paymentIdentifier",
    "keyReference",
    "staging",
    "exactPayment",
    "recovery",
  ], "staging recovery envelope");
  if (
    root.version !== 1 ||
    root.profile !== ABANDONED_STAGING_RECOVERY_PROFILE ||
    root.network !== NETWORK
  ) {
    throw adapterError("profile_mismatch", "staging recovery envelope profile is unsupported");
  }
  let purchaseId: PurchaseId;
  try {
    purchaseId = assertPurchaseId(requireString(root.purchaseId, "Purchase identity"));
  } catch (cause) {
    throw adapterError("artifact_mismatch", "staging recovery Purchase identity is invalid", {
      cause,
    });
  }
  const paymentIdentifier = requirePaymentIdentifier(root.paymentIdentifier);
  const keyReference = requireString(root.keyReference, "staging key reference");
  if (!/^stg_v1_[A-Za-z0-9_-]{43}$/.test(keyReference)) {
    throw adapterError("artifact_mismatch", "staging recovery key reference is invalid");
  }

  const staging = exactRecord(root.staging, [
    "outpoint",
    "amountAtomic",
    "scriptPublicKey",
    "address",
    "blockDaaScore",
    "evidenceDigest",
  ], "staging recovery source");
  const stagingOutpoint = outpointString(
    parseOutpoint(staging.outpoint, "staging recovery source outpoint")
  );
  const stagingAmount = uint64(staging.amountAtomic, "staging recovery source amount", {
    positive: true,
  }).toString();
  const stagingScript = canonicalScript(
    staging.scriptPublicKey,
    "staging recovery source script"
  );
  const stagingAddress = requireString(staging.address, "staging recovery source address");
  const blockDaaScore = uint64(staging.blockDaaScore, "staging recovery source DAA score").toString();
  const stagingEvidenceDigest = requireDigest(staging.evidenceDigest, "staging evidence digest");

  const exactPayment =
    root.exactPayment === null
      ? null
      : validateExpectedCandidateRecord(
          root.exactPayment,
          "immutable exact payment candidate"
        );
  if (
    exactPayment !== null &&
    (exactPayment.inputOutpoint !== stagingOutpoint || exactPayment.outputIndex !== 1)
  ) {
    throw adapterError("artifact_mismatch", "exact payment candidate changed its staging input or output index");
  }
  const codec = new KaspaTestnet10AddressCodec();
  try {
    if (
      codec.scriptPublicKeyForAddress(stagingAddress, NETWORK) !== stagingScript ||
      (exactPayment !== null &&
        codec.scriptPublicKeyForAddress(exactPayment.outputAddress, NETWORK) !==
          exactPayment.outputScriptPublicKey)
    ) {
      throw adapterError("artifact_mismatch", "staging or exact candidate address and script differ");
    }
  } catch (cause) {
    if (cause instanceof AbandonedStagingRecoveryError) throw cause;
    throw adapterError("artifact_mismatch", "staging or exact candidate address is invalid", {
      cause,
    });
  }

  const recovery = exactRecord(root.recovery, [
    "transaction",
    "transactionEncoding",
    "transactionId",
    "transactionArtifactDigest",
    "outputOutpoint",
    "outputIndex",
    "outputAddress",
    "outputAmountAtomic",
    "outputScriptPublicKey",
    "feeAtomic",
  ], "staging recovery transaction");
  const transaction = requireString(recovery.transaction, "staging recovery transaction artifact");
  if (Buffer.byteLength(transaction, "utf8") > MAX_PREPARED_BYTES) {
    throw adapterError("artifact_mismatch", "staging recovery transaction artifact is oversized");
  }
  if (recovery.transactionEncoding !== ABANDONED_STAGING_RECOVERY_ENCODING) {
    throw adapterError("profile_mismatch", "staging recovery transaction encoding is unsupported");
  }
  const recoveryTransactionId = requireHash(recovery.transactionId, "recovery transaction ID");
  const recoveryArtifactDigest = requireDigest(
    recovery.transactionArtifactDigest,
    "recovery transaction artifact digest"
  );
  const recoveryOutpoint = requireString(recovery.outputOutpoint, "recovery output outpoint");
  if (recovery.outputIndex !== 0 || recoveryOutpoint !== `${recoveryTransactionId}:0`) {
    throw adapterError("artifact_mismatch", "staging recovery output identity changed");
  }
  const recoveryAddress = requireString(recovery.outputAddress, "recovery output address");
  const recoveryAmount = uint64(recovery.outputAmountAtomic, "recovery output amount", {
    positive: true,
  }).toString();
  const recoveryScript = canonicalScript(recovery.outputScriptPublicKey, "recovery output script");
  const recoveryFee = uint64(recovery.feeAtomic, "staging recovery fee", { positive: true }).toString();
  if (recoveryFee !== ABANDONED_STAGING_RECOVERY_FEE_POLICY.feeAtomic) {
    throw adapterError("cost_mismatch", "staging recovery fee changed from the pinned policy");
  }
  if (exactPayment !== null && recoveryTransactionId === exactPayment.transactionId) {
    throw adapterError("artifact_mismatch", "recovery and exact payment transaction IDs collide");
  }
  if (BigInt(stagingAmount) !== BigInt(recoveryAmount) + BigInt(recoveryFee)) {
    throw adapterError("cost_mismatch", "staging recovery envelope does not conserve value exactly");
  }

  return {
    version: 1,
    profile: ABANDONED_STAGING_RECOVERY_PROFILE,
    network: NETWORK,
    purchaseId,
    paymentIdentifier,
    keyReference,
    staging: {
      outpoint: stagingOutpoint,
      amountAtomic: stagingAmount,
      scriptPublicKey: stagingScript,
      address: stagingAddress,
      blockDaaScore,
      evidenceDigest: stagingEvidenceDigest,
    },
    exactPayment,
    recovery: {
      transaction,
      transactionEncoding: ABANDONED_STAGING_RECOVERY_ENCODING,
      transactionId: recoveryTransactionId,
      transactionArtifactDigest: recoveryArtifactDigest,
      outputOutpoint: recoveryOutpoint,
      outputIndex: 0,
      outputAddress: recoveryAddress,
      outputAmountAtomic: recoveryAmount,
      outputScriptPublicKey: recoveryScript,
      feeAtomic: recoveryFee,
    },
  };
}

function validateExpectedCandidateRecord(
  value: unknown,
  label: string
): StagingRecoveryExpectedCandidate {
  const record = exactRecord(value, [
    "transactionId",
    "transactionArtifactDigest",
    "inputOutpoint",
    "outputOutpoint",
    "outputIndex",
    "outputAddress",
    "outputAmountAtomic",
    "outputScriptPublicKey",
  ], label);
  const transactionId = requireHash(record.transactionId, `${label} transaction ID`);
  const transactionArtifactDigest = requireDigest(
    record.transactionArtifactDigest,
    `${label} artifact digest`
  );
  const inputOutpoint = outpointString(parseOutpoint(record.inputOutpoint, `${label} input outpoint`));
  const outputIndex = uint32(record.outputIndex, `${label} output index`);
  const outputOutpoint = requireString(record.outputOutpoint, `${label} output outpoint`);
  if (outputOutpoint !== `${transactionId}:${outputIndex}`) {
    throw adapterError("artifact_mismatch", `${label} output identity changed`);
  }
  return {
    transactionId,
    transactionArtifactDigest,
    inputOutpoint,
    outputOutpoint,
    outputIndex,
    outputAddress: requireString(record.outputAddress, `${label} output address`),
    outputAmountAtomic: uint64(record.outputAmountAtomic, `${label} output amount`, {
      positive: true,
    }).toString(),
    outputScriptPublicKey: canonicalScript(record.outputScriptPublicKey, `${label} output script`),
  };
}

function validateStagingInput(
  value: Readonly<JournalVerifiedStagingOutput>,
  codec: KaspaTestnet10AddressCodec
): Readonly<JournalVerifiedStagingOutput> {
  if (!value || typeof value !== "object" || value.network !== NETWORK) {
    throw adapterError("profile_mismatch", `only ${NETWORK} staging recovery is enabled`);
  }
  const outpoint = parseOutpoint(value.outpoint, "journal-verified staging outpoint");
  const amountAtomic = uint64(value.amountAtomic, "journal-verified staging amount", {
    positive: true,
  }).toString();
  const scriptPublicKey = canonicalScript(
    value.scriptPublicKey,
    "journal-verified staging script"
  );
  const address = requireAddress(value.address, codec, "journal-verified staging address");
  if (codec.scriptPublicKeyForAddress(address, NETWORK) !== scriptPublicKey) {
    throw adapterError("artifact_mismatch", "journal-verified staging address and script differ");
  }
  const blockDaaScore = uint64(value.blockDaaScore, "journal-verified staging DAA score").toString();
  const keyReference = requireString(value.keyReference, "journal-verified staging key reference");
  if (!/^stg_v1_[A-Za-z0-9_-]{43}$/.test(keyReference)) {
    throw adapterError("artifact_mismatch", "journal-verified staging key reference is invalid");
  }
  return Object.freeze({
    network: NETWORK,
    outpoint: Object.freeze(outpoint),
    amountAtomic,
    scriptPublicKey,
    address,
    blockDaaScore,
    keyReference,
    evidenceDigest: requireDigest(value.evidenceDigest, "journal-verified staging evidence digest"),
  });
}

function validateExactCandidate(
  value: Readonly<ImmutableExactPaymentCandidate>,
  staging: Readonly<JournalVerifiedStagingOutput>,
  codec: KaspaTestnet10AddressCodec
): ExactCandidateFacts {
  if (!value || typeof value !== "object") {
    throw adapterError("invalid_input", "immutable exact payment candidate is missing");
  }
  if (value.transactionEncoding !== ABANDONED_STAGING_RECOVERY_ENCODING) {
    throw adapterError("profile_mismatch", "immutable exact payment encoding is unsupported");
  }
  if (value.merchantOutputIndex !== 1) {
    throw adapterError("profile_mismatch", "pinned exact Merchant output index must be 1");
  }
  const transactionId = requireHash(value.transactionId, "immutable exact payment transaction ID");
  const artifact = requireString(value.transaction, "immutable exact payment transaction artifact");
  if (artifact.length === 0 || Buffer.byteLength(artifact, "utf8") > MAX_PREPARED_BYTES) {
    throw adapterError("artifact_mismatch", "immutable exact payment transaction is empty or oversized");
  }
  const document = canonicalTransactionDocument(artifact, transactionId, "immutable exact payment");
  if (
    document.version !== 1 ||
    document.lockTime !== "0" ||
    document.subnetworkId !== NATIVE_SUBNETWORK ||
    document.gas !== "0" ||
    document.payload !== ""
  ) {
    throw adapterError("profile_mismatch", "immutable exact payment is outside the pinned Kaspa profile");
  }
  const inputs = requireArray(document.inputs, "immutable exact payment inputs");
  const outputs = requireArray(document.outputs, "immutable exact payment outputs");
  if (inputs.length !== 2 || outputs.length < 2 || outputs.length > 3) {
    throw adapterError("profile_mismatch", "immutable exact payment is not the pinned two-input exact shape");
  }
  const stagingOutpoint = outpointString(staging.outpoint);
  const matchingInputs = inputs.filter((candidate) => {
    const record = requireRecord(candidate, "immutable exact payment input");
    return record.transactionId === staging.outpoint.txid && record.index === staging.outpoint.index;
  });
  if (matchingInputs.length !== 1) {
    throw adapterError("artifact_mismatch", "immutable exact payment does not spend the exact staging outpoint once");
  }
  const pinnedStagingInput = requireRecord(inputs[1], "immutable exact staging input");
  if (
    pinnedStagingInput.transactionId !== staging.outpoint.txid ||
    pinnedStagingInput.index !== staging.outpoint.index
  ) {
    throw adapterError("profile_mismatch", "immutable exact payment changed its pinned staging input index");
  }
  const stagingInput = requireRecord(matchingInputs[0], "immutable exact staging input");
  const stagingUtxo = requireRecord(stagingInput.utxo, "immutable exact staging input UTXO");
  if (
    stagingUtxo.amount !== staging.amountAtomic ||
    stagingUtxo.scriptPublicKey !== staging.scriptPublicKey ||
    stagingUtxo.blockDaaScore !== staging.blockDaaScore
  ) {
    throw adapterError("artifact_mismatch", "immutable exact payment changed its staging UTXO facts");
  }
  const output = requireRecord(outputs[1], "immutable exact Merchant output");
  if (output.covenant !== null) {
    throw adapterError("profile_mismatch", "immutable exact Merchant output unexpectedly carries a covenant");
  }
  const outputAmountAtomic = uint64(output.value, "immutable exact Merchant amount", {
    positive: true,
  }).toString();
  const outputScriptPublicKey = canonicalScript(
    output.scriptPublicKey,
    "immutable exact Merchant script"
  );
  const outputAddress = addressForScript(codec, outputScriptPublicKey, "immutable exact Merchant output");
  return {
    artifact,
    transactionId,
    transactionArtifactDigest: digestBytes(Buffer.from(artifact, "utf8")),
    inputOutpoint: stagingOutpoint,
    outputOutpoint: `${transactionId}:1`,
    outputIndex: 1,
    outputAddress,
    outputAmountAtomic,
    outputScriptPublicKey,
  };
}

function validateExactPaymentSelection(
  value: Readonly<ImmutableExactPaymentSelection>,
  staging: Readonly<JournalVerifiedStagingOutput>,
  codec: KaspaTestnet10AddressCodec
): ExactCandidateFacts | null {
  if (!value || typeof value !== "object") {
    throw adapterError("invalid_input", "immutable exact payment selection is missing");
  }
  if (value.mode === "no_exact_candidate") {
    if (Object.keys(value).length !== 1) {
      throw adapterError(
        "invalid_input",
        "no-exact-candidate recovery selection contains unexpected fields"
      );
    }
    return null;
  }
  if (value.mode !== "exact_candidate" || Object.keys(value).length !== 2) {
    throw adapterError("invalid_input", "immutable exact payment selection is invalid");
  }
  return validateExactCandidate(value.candidate, staging, codec);
}

function validateRecoveryTransaction(input: {
  artifact: string;
  transactionId: string;
  staging: Readonly<JournalVerifiedStagingOutput>;
  recoveryAddress: string;
  recoveryScriptPublicKey: string;
  recoveryAmountAtomic: string;
  feeAtomic: string;
  addressCodec: KaspaTestnet10AddressCodec;
}): void {
  const document = canonicalTransactionDocument(
    input.artifact,
    input.transactionId,
    "staging recovery"
  );
  const inputs = requireArray(document.inputs, "staging recovery inputs");
  const outputs = requireArray(document.outputs, "staging recovery outputs");
  if (
    document.version !== 1 ||
    document.lockTime !== "0" ||
    document.subnetworkId !== NATIVE_SUBNETWORK ||
    document.gas !== "0" ||
    document.payload !== "" ||
    inputs.length !== 1 ||
    outputs.length !== 1
  ) {
    throw adapterError("artifact_mismatch", "staging recovery transaction envelope changed");
  }
  const txInput = requireRecord(inputs[0], "staging recovery input");
  const utxo = requireRecord(txInput.utxo, "staging recovery input UTXO");
  if (
    txInput.transactionId !== input.staging.outpoint.txid ||
    txInput.index !== input.staging.outpoint.index ||
    txInput.sequence !== "0" ||
    txInput.sigOpCount !== 0 ||
    txInput.computeBudget !== ABANDONED_STAGING_RECOVERY_FEE_POLICY.inputComputeBudget ||
    typeof txInput.signatureScript !== "string" ||
    !SIGNATURE_SCRIPT.test(txInput.signatureScript) ||
    utxo.amount !== input.staging.amountAtomic ||
    utxo.scriptPublicKey !== input.staging.scriptPublicKey ||
    utxo.blockDaaScore !== input.staging.blockDaaScore ||
    utxo.isCoinbase !== false
  ) {
    throw adapterError("artifact_mismatch", "staging recovery input facts changed");
  }
  const output = requireRecord(outputs[0], "staging recovery output");
  if (
    output.value !== input.recoveryAmountAtomic ||
    output.scriptPublicKey !== input.recoveryScriptPublicKey ||
    output.covenant !== null
  ) {
    throw adapterError("artifact_mismatch", "staging recovery output facts changed");
  }
  if (
    requireAddress(input.recoveryAddress, input.addressCodec, "staging recovery output address") !==
      input.recoveryAddress ||
    input.addressCodec.scriptPublicKeyForAddress(input.recoveryAddress, NETWORK) !==
      input.recoveryScriptPublicKey
  ) {
    throw adapterError("artifact_mismatch", "staging recovery output address and script differ");
  }
  const stagingAmount = uint64(input.staging.amountAtomic, "staging recovery input amount", {
    positive: true,
  });
  const outputAmount = uint64(input.recoveryAmountAtomic, "staging recovery output amount", {
    positive: true,
  });
  const fee = uint64(input.feeAtomic, "staging recovery fee", { positive: true });
  if (
    fee.toString() !== ABANDONED_STAGING_RECOVERY_FEE_POLICY.feeAtomic ||
    stagingAmount !== outputAmount + fee ||
    outputAmount < BigInt(ABANDONED_STAGING_RECOVERY_FEE_POLICY.minimumStandardOutputAtomic)
  ) {
    throw adapterError("cost_mismatch", "staging recovery value or fee bounds changed");
  }
}

function canonicalTransactionDocument(
  artifact: string,
  transactionId: string,
  label: string
): Record<string, unknown> {
  let transaction: Transaction | undefined;
  try {
    transaction = Transaction.deserializeFromSafeJSON(artifact);
    if (
      String(transaction.finalize()).toLowerCase() !== transactionId ||
      transaction.serializeToSafeJSON() !== artifact
    ) {
      throw adapterError("artifact_mismatch", `${label} transaction is non-canonical or ID-mismatched`);
    }
  } catch (cause) {
    if (cause instanceof AbandonedStagingRecoveryError) throw cause;
    throw adapterError("artifact_mismatch", `${label} transaction cannot be rehydrated`, { cause });
  } finally {
    transaction?.free();
  }
  try {
    return requireRecord(JSON.parse(artifact), `${label} safe JSON`);
  } catch (cause) {
    if (cause instanceof AbandonedStagingRecoveryError) throw cause;
    throw adapterError("artifact_mismatch", `${label} transaction is not JSON`, { cause });
  }
}

function transactionInput(input: {
  txid: string;
  index: number;
  amount: bigint;
  scriptPublicKey: ScriptPublicKey;
  blockDaaScore: bigint;
}): Record<string, unknown> {
  return {
    previousOutpoint: { transactionId: input.txid, index: input.index },
    signatureScript: "",
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: ABANDONED_STAGING_RECOVERY_FEE_POLICY.inputComputeBudget,
    utxo: {
      outpoint: { transactionId: input.txid, index: input.index },
      amount: input.amount,
      scriptPublicKey: input.scriptPublicKey,
      blockDaaScore: input.blockDaaScore,
      isCoinbase: false,
    },
  };
}

function minimumRequiredFee(transaction: Transaction): bigint {
  const baseMass = calculateTransactionMass(SDK_NETWORK, transaction);
  const computeMass =
    BigInt(ABANDONED_STAGING_RECOVERY_FEE_POLICY.inputComputeBudget) *
    BigInt(ABANDONED_STAGING_RECOVERY_FEE_POLICY.computeBudgetMassPerUnit);
  return (
    baseMass + computeMass
  ) * BigInt(ABANDONED_STAGING_RECOVERY_FEE_POLICY.feeRateSompiPerGram);
}

function recoveryCandidate(
  envelope: Readonly<AbandonedStagingRecoveryEnvelope>
): Readonly<StagingRecoveryExpectedCandidate> {
  return Object.freeze({
    transactionId: envelope.recovery.transactionId,
    transactionArtifactDigest: envelope.recovery.transactionArtifactDigest,
    inputOutpoint: envelope.staging.outpoint,
    outputOutpoint: envelope.recovery.outputOutpoint,
    outputIndex: envelope.recovery.outputIndex,
    outputAddress: envelope.recovery.outputAddress,
    outputAmountAtomic: envelope.recovery.outputAmountAtomic,
    outputScriptPublicKey: envelope.recovery.outputScriptPublicKey,
  });
}

function candidateMatches(
  candidate: StagingRecoveryCandidateObservation | undefined,
  expected: Readonly<StagingRecoveryExpectedCandidate>
):
  | { readonly status: "absent" | "partial" }
  | {
      readonly status: "observed";
      readonly finality: "mempool" | "accepted" | "confirmed";
    } {
  if (!candidate || typeof candidate !== "object") return { status: "partial" };
  try {
    requireDigest(candidate.detailDigest, "candidate observation detail digest");
  } catch {
    return { status: "partial" };
  }
  if (candidate.status === "absent") return { status: "absent" };
  if (candidate.status === "partial") return { status: "partial" };
  if (candidate.status !== "observed") return { status: "partial" };
  if (
    !["mempool", "accepted", "confirmed"].includes(candidate.finality) ||
    candidate.transactionId !== expected.transactionId ||
    candidate.inputOutpoint !== expected.inputOutpoint ||
    candidate.outputOutpoint !== expected.outputOutpoint ||
    candidate.outputAmountAtomic !== expected.outputAmountAtomic ||
    candidate.outputScriptPublicKey !== expected.outputScriptPublicKey
  ) {
    return { status: "partial" };
  }
  return { status: "observed", finality: candidate.finality };
}

function stagingMatches(
  staging: StagingRecoveryOutpointObservation | undefined,
  expected: Readonly<AbandonedStagingRecoveryEnvelope["staging"]>
):
  | { status: "unspent" }
  | { status: "spent"; spendingTransactionId?: string }
  | { status: "unknown" }
  | "partial" {
  if (!staging || typeof staging !== "object") return "partial";
  try {
    requireDigest(staging.detailDigest, "staging outpoint observation detail digest");
  } catch {
    return "partial";
  }
  if (staging.status === "partial") return "partial";
  if (staging.status === "unknown") return { status: "unknown" };
  if (staging.status === "unspent") {
    if (
      staging.outpoint !== expected.outpoint ||
      staging.amountAtomic !== expected.amountAtomic ||
      staging.scriptPublicKey !== expected.scriptPublicKey ||
      staging.blockDaaScore !== expected.blockDaaScore
    ) {
      return "partial";
    }
    return { status: "unspent" };
  }
  if (staging.status !== "spent") return "partial";
  if (
    staging.spendingTransactionId !== undefined &&
    !HASH32.test(staging.spendingTransactionId)
  ) {
    return "partial";
  }
  return {
    status: "spent",
    ...(staging.spendingTransactionId === undefined
      ? {}
      : { spendingTransactionId: staging.spendingTransactionId }),
  };
}

function observationDigest(
  envelope: Readonly<AbandonedStagingRecoveryEnvelope>,
  preparedDigest: Sha256Digest,
  raw: Readonly<StagingRecoveryRaceEvidence>
): Sha256Digest {
  try {
    return digestCanonical({
      profile: ABANDONED_STAGING_RECOVERY_PROFILE,
      preparedDigest,
      stagingOutpoint: envelope.staging.outpoint,
      exactPaymentTransactionId: envelope.exactPayment?.transactionId ?? null,
      recoveryTransactionId: envelope.recovery.transactionId,
      evidence: raw,
    });
  } catch {
    return digestCanonical({
      profile: ABANDONED_STAGING_RECOVERY_PROFILE,
      preparedDigest,
      status: "malformed-observation",
    });
  }
}

function conflict(
  reason: AbandonedStagingRecoveryConflictReason,
  evidenceDigest: Sha256Digest,
  winningTransactionId?: string,
  winningFinality?: "mempool" | "accepted" | "confirmed"
): Readonly<Extract<AbandonedStagingRecoveryObservation, { status: "conflict" }>> {
  return Object.freeze({
    status: "conflict" as const,
    reason,
    ...(winningTransactionId === undefined ? {} : { winningTransactionId }),
    ...(winningFinality === undefined ? {} : { winningFinality }),
    evidenceDigest,
  });
}

function recoveryWon(
  envelope: Readonly<AbandonedStagingRecoveryEnvelope>,
  finality: "mempool" | "accepted" | "confirmed",
  evidenceDigest: Sha256Digest
): Readonly<Extract<AbandonedStagingRecoveryObservation, { status: "recovery_won" }>> {
  return Object.freeze({
    status: "recovery_won" as const,
    transactionId: envelope.recovery.transactionId,
    recoveryOutpoint: envelope.recovery.outputOutpoint,
    recoveryAmountAtomic: envelope.recovery.outputAmountAtomic,
    finality,
    evidenceDigest,
  });
}

function validateReadiness(
  value: Readonly<StagingRecoveryReadiness>,
  envelope: Readonly<AbandonedStagingRecoveryEnvelope>,
  preparedDigest: Sha256Digest,
  now: number
): void {
  if (!value || typeof value !== "object") {
    throw adapterError("readiness_required", "fresh staging race observation is required before submit");
  }
  const base = {
    version: value.version,
    profile: value.profile,
    preparedDigest: value.preparedDigest,
    recoveryTransactionId: value.recoveryTransactionId,
    exactPaymentTransactionId: value.exactPaymentTransactionId,
    raceEvidenceDigest: value.raceEvidenceDigest,
    issuanceNonce: value.issuanceNonce,
    observedAtMs: value.observedAtMs,
    expiresAtMs: value.expiresAtMs,
  };
  if (
    value.version !== 1 ||
    value.profile !== ABANDONED_STAGING_RECOVERY_PROFILE ||
    value.preparedDigest !== preparedDigest ||
    value.recoveryTransactionId !== envelope.recovery.transactionId ||
    value.exactPaymentTransactionId !==
      (envelope.exactPayment?.transactionId ?? null) ||
    !DIGEST.test(value.raceEvidenceDigest) ||
    !READINESS_ISSUANCE_NONCE.test(value.issuanceNonce) ||
    !Number.isSafeInteger(value.observedAtMs) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.observedAtMs > now ||
    value.expiresAtMs <= now ||
    value.expiresAtMs <= value.observedAtMs ||
    value.expiresAtMs - value.observedAtMs > MAX_READINESS_TTL_MS ||
    value.proofDigest !== digestCanonical(base)
  ) {
    throw adapterError("readiness_required", "staging recovery readiness proof is invalid or expired");
  }
}

function sdkScriptPublicKey(serialized: string): ScriptPublicKey {
  const script = canonicalScript(serialized, "SDK script public key");
  return new ScriptPublicKey(0, script.slice(4));
}

function addressForScript(
  codec: KaspaTestnet10AddressCodec,
  serialized: string,
  label: string
): string {
  try {
    return codec.encodeScriptAddress({
      network: NETWORK,
      scriptPublicKey: { version: 0, script: serialized.slice(4) },
      serializedScriptPublicKey: serialized,
    });
  } catch (cause) {
    throw adapterError("artifact_mismatch", `${label} script cannot be encoded as testnet-10`, {
      cause,
    });
  }
}

function requireAddress(
  value: unknown,
  codec: KaspaTestnet10AddressCodec,
  label: string
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw adapterError("invalid_input", `${label} is invalid`);
  }
  try {
    codec.scriptPublicKeyForAddress(value, NETWORK);
    return value;
  } catch (cause) {
    throw adapterError("invalid_input", `${label} is invalid for testnet-10`, { cause });
  }
}

function parseOutpoint(
  value: unknown,
  label: string
): { readonly txid: string; readonly index: number } {
  if (typeof value === "string") {
    const match = /^([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(value);
    if (!match) throw adapterError("artifact_mismatch", `${label} is invalid`);
    return Object.freeze({ txid: match[1], index: uint32(Number(match[2]), `${label} index`) });
  }
  const record = exactRecord(value, ["txid", "index"], label);
  return Object.freeze({
    txid: requireHash(record.txid, `${label} transaction ID`),
    index: uint32(record.index, `${label} index`),
  });
}

function outpointString(value: { readonly txid: string; readonly index: number }): string {
  return `${requireHash(value.txid, "outpoint transaction ID")}:${uint32(value.index, "outpoint index")}`;
}

function canonicalScript(value: unknown, label: string): string {
  if (typeof value !== "string" || !SERIALIZED_V0_SCRIPT.test(value)) {
    throw adapterError("artifact_mismatch", `${label} must be a canonical version-0 script`);
  }
  return value;
}

function requirePaymentIdentifier(value: unknown): string {
  if (typeof value !== "string" || !PAYMENT_IDENTIFIER.test(value)) {
    throw adapterError("invalid_input", "staging recovery payment identity is invalid");
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH32.test(value)) {
    throw adapterError("artifact_mismatch", `${label} must be a canonical 32-byte hash`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw adapterError("artifact_mismatch", `${label} must be a canonical SHA-256 digest`);
  }
  return value as Sha256Digest;
}

function uint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw adapterError("artifact_mismatch", `${label} must fit uint32`);
  }
  return value as number;
}

function uint64(
  value: unknown,
  label: string,
  options: { positive?: boolean } = {}
): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw adapterError("artifact_mismatch", `${label} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (options.positive && parsed === 0n)) {
    throw adapterError("cost_mismatch", `${label} is outside uint64 bounds`);
  }
  return parsed;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw adapterError("artifact_mismatch", `${label} contains unsupported or missing fields`);
  }
  return record;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw adapterError("artifact_mismatch", `${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw adapterError("artifact_mismatch", `${label} are invalid`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw adapterError("artifact_mismatch", `${label} is invalid`);
  return value;
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

function digestCanonical(value: unknown): Sha256Digest {
  return digestBytes(Buffer.from(stableJson(value), "utf8"));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical number is invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("canonical value is invalid");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw adapterError("invalid_input", `${label} is invalid`);
  }
  return value;
}

function checkedDeadline(now: number, duration: number): number {
  const value = now + duration;
  if (!Number.isSafeInteger(value)) throw adapterError("deadline_exceeded", "deadline overflowed");
  return value;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw adapterError("invalid_input", "staging recovery clock is invalid");
  }
  return value;
}

async function boundedCall<T>(
  promise: Promise<T>,
  deadlineAtMs: number,
  now: () => number,
  callerSignal: AbortSignal
): Promise<T> {
  callerSignal.throwIfAborted();
  const remaining = deadlineAtMs - readClock(now);
  if (remaining <= 0) throw adapterError("deadline_exceeded", "staging recovery deadline expired");
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: "resolve" | "reject", value: T | unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onAbort);
      if (outcome === "resolve") resolve(value as T);
      else reject(value);
    };
    const onAbort = () => finish("reject", abortError(callerSignal));
    const timer = setTimeout(
      () => finish("reject", adapterError("deadline_exceeded", "staging recovery deadline expired")),
      remaining
    );
    // The observer or submitter may return a handle-free pending Promise. This
    // deadline is then the only completion mechanism, so keep it referenced
    // until finish() clears it.
    callerSignal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish("resolve", value),
      (cause) => finish("reject", cause)
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("staging recovery was aborted");
}

function adapterError(
  code: AbandonedStagingRecoveryErrorCode,
  message: string,
  options?: { cause?: unknown }
): AbandonedStagingRecoveryError {
  return new AbandonedStagingRecoveryError(code, message, options);
}
