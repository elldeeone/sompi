import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { SecureLocalStateDirectory } from "../secure-local-state.js";
import { EvidenceStore, type StoredEvidence } from "./evidence-store.js";
import { authorizationFactsDigest } from "./contracts.js";
import {
  assertPurchaseId,
  assertPurchaseRequestKey,
  canonicalMediaType,
  canonicalRequestUrl,
  createPaymentIdentifier,
  evidenceDigest,
  requestFingerprintFromBodyDigest,
} from "./identity.js";
import {
  expectedSchemaFingerprint,
  JOURNAL_APPLICATION_ID,
  JOURNAL_SCHEMA_CHECKSUM,
  JOURNAL_SCHEMA_SQL,
  JOURNAL_SCHEMA_VERSION,
  schemaFingerprint,
} from "./journal-schema.js";
import { assertPurchaseTransition } from "./state-machine.js";
import type {
  CheckoutTerms,
  FundingSource,
  PaymentIdentifier,
  PurchaseId,
  PurchaseRequestKey,
  PurchaseState,
  Sha256Digest,
} from "./types.js";
import { paymentFinalityMeets, requirePaymentFinality } from "./finality.js";
import type {
  PreparedTreasuryOperation,
  TreasuryOperationIntent,
  TreasuryOperationObservationStatus,
  TreasuryOperationRecord,
  TreasuryOperationState,
} from "../treasury/operation-journal.js";
import type { ChainEvidenceRecord } from "../chain-evidence/types.js";
import {
  validateAdmissionBudgets,
  type AdmissionBudgetProjection,
} from "../admission.js";

const PAYMENT_ATTEMPT_STATES = ["planned", "prepared", "submitted", "observed", "failed"] as const;
const EFFECT_STATES = [
  "planned",
  "executing",
  "submitted",
  "ambiguous",
  "retryable",
  "observed",
  "failed_terminal",
  "abandoned",
] as const;
const RESERVATION_STATES = ["active", "in_flight", "spent", "released", "expired"] as const;

export const TREASURY_STAGING_EFFECT_KIND = "treasury-staging";
export const TREASURY_STAGING_EVIDENCE_KIND = "treasury-staging-output";
export const TREASURY_STAGING_RECOVERY_EFFECT_KIND = "treasury-staging-recovery";
export const MERCHANT_AUTHORIZATION_EFFECT_KIND = "merchant-authorization";
export const MERCHANT_AUTHORIZATION_EVIDENCE_KIND = "merchant-authorization";

export const PURCHASE_RECEIPT_SET_PROFILE = "urn:sompi:receipt-set:purchase:1";
export const PURCHASE_RECEIPT_REQUIREMENTS = Object.freeze([
  Object.freeze({
    role: "merchant",
    profile: "urn:sompi:receipt:merchant:1",
  }),
  Object.freeze({
    role: "payment",
    profile: "urn:sompi:receipt:payment:1",
  }),
] as const);

type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];
export type EffectState = (typeof EFFECT_STATES)[number];
type ReservationState = (typeof RESERVATION_STATES)[number];

/**
 * Complete executable manifest of transactional fault seams. Tests key their
 * rollback/restart scenarios by this list so a newly introduced seam cannot
 * silently escape fault-boundary coverage.
 */
export const JOURNAL_FAULT_POINTS = Object.freeze([
  "purchase.after_insert",
  "purchase_transition.after_state_update",
  "evidence.after_metadata_insert",
  "policy.after_snapshot_insert",
  "reservation.after_insert",
  "payment_attempt.after_insert",
  "payment_preparation.after_insert",
  "treasury_staging_plan.after_insert",
  "treasury_staging_observation.after_insert",
  "treasury_staging_recovery_plan.after_insert",
  "treasury_staging_recovery_observation.after_insert",
  "treasury_staging_recovery_accounting.after_insert",
  "effect.after_insert",
  "effect_claim.after_effect_update",
  "spend.after_insert",
  "checkout_terms.after_insert",
  "authorization_request.after_insert",
  "authorization_decision.after_insert",
  "fulfilment.after_insert",
  "receipt.after_insert",
  "treasury_operation.after_intent_insert",
  "treasury_operation.after_prepared_update",
  "treasury_operation.after_submission_plan",
  "treasury_operation.after_observation_insert",
  "treasury_operation.after_complete_update",
] as const);

export type JournalFaultPoint = (typeof JOURNAL_FAULT_POINTS)[number];

export interface PurchaseJournalOptions {
  now?: () => number;
  busyTimeoutMs?: number;
  evidenceDirectory?: string;
  preparedMaterialDirectory?: string;
  faultInjector?: (point: JournalFaultPoint) => void;
  operatorManifestIdentity?: Readonly<{ revision: number; digest: string }>;
  /** Manifest projection in production; explicit values are used by hermetic tests. */
  admission?: AdmissionBudgetProjection;
}

export interface JournalAdmissionStatus {
  readonly prevalidationPurchases: Readonly<{
    used: number;
    budget: number;
    saturated: boolean;
  }>;
  readonly evidenceBytes: Readonly<{
    used: number;
    reserved: number;
    budget: number;
    saturated: boolean;
  }>;
}

export interface CreatePurchaseInput {
  id: PurchaseId;
  requestKey: PurchaseRequestKey;
  resourceUrl: string;
  method: string;
  resourceFingerprint: Sha256Digest;
  expectedMerchantId?: string;
  expectedMerchantOrigin?: string;
}

export interface PurchaseRecord extends CreatePurchaseInput {
  state: PurchaseState;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PurchaseTransitionRecord {
  sequence: number;
  purchaseId: PurchaseId;
  fromState?: PurchaseState;
  toState: PurchaseState;
  reasonCode: string;
  detailDigest?: Sha256Digest;
  createdAtMs: number;
}

export interface BindCheckoutTermsInput {
  terms: CheckoutTerms;
  checkoutEvidenceDigest: Sha256Digest;
  checkoutVerificationProfile: string;
  checkoutVerifierId: string;
  paymentRequirementsDigest: Sha256Digest;
  paymentRequirementsVerificationProfile: string;
  paymentRequirementsVerifierId: string;
}

export interface CheckoutTermsRecord extends CheckoutTerms {
  purchaseId: PurchaseId;
  expiresAtMs: number;
  checkoutEvidenceDigest: Sha256Digest;
  checkoutVerificationProfile: string;
  checkoutVerifierId: string;
  paymentRequirementsDigest: Sha256Digest;
  paymentRequirementsVerificationProfile: string;
  paymentRequirementsVerifierId: string;
  createdAtMs: number;
}

export interface RecordAuthorizationRequestInput {
  checkoutDigest: Sha256Digest;
  requestDigest: Sha256Digest;
  nonceDigest: Sha256Digest;
  requestMediaType: string;
  requestBodyDigest: Sha256Digest;
  additionalCostCeilingAtomic: string;
  effectiveFinalityFloor: "accepted" | "depth-confirmed";
  expiresAtMs: number;
}

export interface AuthorizationRequestRecord extends RecordAuthorizationRequestInput {
  purchaseId: PurchaseId;
  createdAtMs: number;
}

export interface RecordAuthorizationDecisionInput {
  decision: "approved" | "denied" | "expired";
  authorityId: string;
  checkoutDigest: Sha256Digest;
  approvedFactsDigest: Sha256Digest;
  evidenceDigest: Sha256Digest;
  verificationProfile: string;
  verifierId: string;
  requestDigest: Sha256Digest;
  nonceDigest: Sha256Digest;
  expiresAtMs: number;
}

export interface AuthorizationRecord extends RecordAuthorizationDecisionInput {
  purchaseId: PurchaseId;
  decidedAtMs: number;
}

export interface RecordFulfilmentInput {
  attempt: number;
  httpStatus: number;
  resourceFingerprint: Sha256Digest;
  bodyDigest: Sha256Digest;
  bodyByteLength: number;
  mediaType: string;
  merchantEvidenceDigest: Sha256Digest;
  merchantVerificationProfile: string;
  merchantVerifierId: string;
}

export interface FulfilmentRecord extends RecordFulfilmentInput {
  purchaseId: PurchaseId;
  createdAtMs: number;
}

export interface RecordReceiptInput {
  role: string;
  evidenceDigest: Sha256Digest;
  profile: string;
  issuer?: string;
  verifierId: string;
  checkoutDigest: Sha256Digest;
  authorizationEvidenceDigest: Sha256Digest;
  settlementEvidenceDigest: Sha256Digest;
  fulfilmentDigest: Sha256Digest;
}

export interface ReceiptRecord extends RecordReceiptInput {
  id: number;
  purchaseId: PurchaseId;
  canonicalDigest: Sha256Digest;
  createdAtMs: number;
}

export interface ReceiptSetRecord {
  purchaseId: PurchaseId;
  profile: typeof PURCHASE_RECEIPT_SET_PROFILE;
  canonicalDigest: Sha256Digest;
  completedAtMs: number;
}

export interface EvidenceLinkRecord {
  purchaseId: PurchaseId;
  digest: Sha256Digest;
  kind: string;
  attempt?: number;
  mediaType: string;
  profile: string;
  issuer?: string;
  attachedAtMs: number;
}

export interface StoreEvidenceInput {
  bytes: Uint8Array;
  mediaType: string;
  profile: string;
  issuer?: string;
  kind: string;
  attempt?: number;
}

export interface EvidenceArtifactRecord {
  digest: Sha256Digest;
  byteLength: number;
  storageRef: string;
  createdAtMs: number;
}

export interface EvidenceAttachmentRecord extends EvidenceArtifactRecord {
  purchaseId: PurchaseId;
  kind: string;
  attempt?: number;
  mediaType: string;
  profile: string;
  issuer?: string;
  attachedAtMs: number;
}

export interface EvidenceVerificationInput {
  verifierId: string;
  profile: string;
  detailDigest: Sha256Digest;
}

export interface PolicyDefinition {
  maxPerPaymentAtomic: string;
  maxPerHourAtomic: string;
  approvalAboveAtomic: string;
  allowlist: readonly string[];
}

export interface PolicySnapshotRecord extends PolicyDefinition {
  digest: Sha256Digest;
  version: number;
  activatedAtMs: number;
}

export interface PolicyReservationInput {
  id: string;
  purchaseId: PurchaseId;
  policyDigest: Sha256Digest;
  payee: string;
  amountAtomic: string;
  additionalCostCeilingAtomic: string;
  fundingSource: FundingSource;
  expiresAtMs: number;
  approvalEvidenceDigest?: Sha256Digest;
  approvalVerificationProfile?: string;
  approvalVerifierId?: string;
}

export interface PolicyReservationRecord {
  id: string;
  purchaseId: PurchaseId;
  policyDigest: Sha256Digest;
  approvalEvidenceDigest?: Sha256Digest;
  approvalVerificationProfile?: string;
  approvalVerifierId?: string;
  payee: string;
  amountAtomic: string;
  additionalCostCeilingAtomic: string;
  fundingSource: FundingSource;
  state: ReservationState;
  expiresAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  inFlightAtMs?: number;
  spentAtMs?: number;
  releaseEvidenceDigest?: Sha256Digest;
}

export interface CreatePaymentAttemptInput {
  purchaseId: PurchaseId;
  attempt: number;
  identifier: PaymentIdentifier;
}

export interface PaymentAttemptRecord extends CreatePaymentAttemptInput {
  state: PaymentAttemptState;
  version: number;
  failureCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PreparePaymentAttemptInput {
  purchaseId: PurchaseId;
  attempt: number;
  reservationId: string;
  requirementsDigest: Sha256Digest;
  payloadDigest: Sha256Digest;
  preparedBytes: Uint8Array;
  transactionId: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payee: string;
  requiredFinality: string;
  fundingSource: FundingSource;
}

export interface PaymentPreparationRecord extends Omit<PreparePaymentAttemptInput, "preparedBytes"> {
  preparedRef: string;
  preparedByteLength: number;
  createdAtMs: number;
}

export interface PlanTreasuryStagingInput {
  purchaseId: PurchaseId;
  attempt: number;
  reservationId: string;
  idempotencyKey: string;
  payloadDigest: Sha256Digest;
  preparedBytes: Uint8Array;
  plannedTransactionId: string;
  expectedOutpoint: string;
  stagingAmountAtomic: string;
  fundingSource: FundingSource;
}

export interface TreasuryStagingPlanRecord extends Omit<PlanTreasuryStagingInput, "preparedBytes"> {
  effectId: string;
  preparedRef: string;
  preparedByteLength: number;
  createdAtMs: number;
}

export interface RecordObservedTreasuryStagingInput {
  effectId: string;
  reservationId: string;
  transactionId: string;
  outpoint: string;
  stagingAmountAtomic: string;
  fundingSource: FundingSource;
  evidenceDigest: Sha256Digest;
  evidenceVerificationProfile: string;
  evidenceVerifierId: string;
}

export interface TreasuryStagingObservationRecord
  extends RecordObservedTreasuryStagingInput {
  purchaseId: PurchaseId;
  attempt: number;
  observedAtMs: number;
}

export interface TreasuryStagingRecoveryContext {
  plan: TreasuryStagingPlanRecord;
  effect: EffectRecord;
  attempt: PaymentAttemptRecord;
  reservation: PolicyReservationRecord;
  observation?: TreasuryStagingObservationRecord;
}

export interface PlanTreasuryStagingRecoveryInput {
  purchaseId: PurchaseId;
  attempt: number;
  reservationId: string;
  stagingEffectId: string;
  idempotencyKey: string;
  payloadDigest: Sha256Digest;
  preparedBytes: Uint8Array;
  exactTransactionId?: string;
  recoveryTransactionId: string;
  recoveryOutpoint: string;
  recoveryAmountAtomic: string;
  stagingFeeAtomic: string;
  recoveryFeeAtomic: string;
  requiredFinality: string;
  authorizedAdditionalCostCeilingAtomic: string;
}

export interface TreasuryStagingRecoveryPlanRecord
  extends Omit<PlanTreasuryStagingRecoveryInput, "preparedBytes"> {
  effectId: string;
  preparedRef: string;
  preparedByteLength: number;
  createdAtMs: number;
}

export type TreasuryStagingRecoveryObservationStatus =
  | "safe_to_submit"
  | "pending"
  | "exact_payment_won"
  | "recovery_won"
  | "conflict";

export interface RecordTreasuryStagingRecoveryObservationInput {
  status: TreasuryStagingRecoveryObservationStatus;
  evidenceDigest: Sha256Digest;
  readinessProofDigest?: Sha256Digest;
  readinessObservedAtMs?: number;
  readinessExpiresAtMs?: number;
  winningTransactionId?: string;
  winningFinality?: string;
  recoveryOutpoint?: string;
  recoveryAmountAtomic?: string;
  conflictReason?: string;
}

export interface TreasuryStagingRecoveryObservationRecord
  extends RecordTreasuryStagingRecoveryObservationInput {
  sequence: number;
  effectId: string;
  leaseName: string;
  leaseGeneration: number;
  observedAtMs: number;
}

export interface TreasuryStagingRecoveryAccountingRecord {
  effectId: string;
  reservationId: string;
  purchaseId: PurchaseId;
  attempt: number;
  recoveryTransactionId: string;
  recoveryOutpoint: string;
  returnedAmountAtomic: string;
  stagingFeeAtomic: string;
  recoveryFeeAtomic: string;
  actualAdditionalCostAtomic: string;
  finality: string;
  evidenceDigest: Sha256Digest;
  observedAtMs: number;
}

export interface TreasuryStagingRecoveryJournalContext {
  plan: TreasuryStagingRecoveryPlanRecord;
  effect: EffectRecord;
  attempt: PaymentAttemptRecord;
  reservation: PolicyReservationRecord;
  staging: TreasuryStagingObservationRecord;
  observations: readonly TreasuryStagingRecoveryObservationRecord[];
  accounting?: TreasuryStagingRecoveryAccountingRecord;
}

export interface PlanEffectInput {
  purchaseId: PurchaseId;
  attempt?: number;
  kind: string;
  idempotencyKey: string;
  payloadDigest: Sha256Digest;
  preparedBytes: Uint8Array;
}

export interface EffectRecord extends Omit<PlanEffectInput, "preparedBytes"> {
  id: string;
  preparedRef: string;
  preparedByteLength: number;
  state: EffectState;
  version: number;
  claimLeaseName?: string;
  claimGeneration?: number;
  submissionDigest?: Sha256Digest;
  resultDigest?: Sha256Digest;
  errorCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
  executingAtMs?: number;
  submittedAtMs?: number;
  observedAtMs?: number;
}

export interface LeaseToken {
  name: string;
  holder: string;
  generation: number;
  expiresAtMs: number;
}

export interface EffectClaim {
  effect: EffectRecord;
  lease: LeaseToken;
}

export type EffectObservation =
  | { status: "observed"; resultDigest: Sha256Digest; detailDigest?: Sha256Digest }
  | { status: "pending"; detailDigest?: Sha256Digest }
  | { status: "not_found"; safeToRetry: boolean; detailDigest: Sha256Digest }
  | { status: "conflict"; detailDigest: Sha256Digest }
  | { status: "application_failure"; errorCode: string; detailDigest: Sha256Digest };

export interface EffectObservationRecord {
  id: number;
  effectId: string;
  status:
    | "observed"
    | "pending"
    | "not_found_retryable"
    | "not_found_ambiguous"
    | "conflict"
    | "application_failure";
  resultDigest?: Sha256Digest;
  detailDigest?: Sha256Digest;
  leaseName: string;
  leaseGeneration: number;
  observedAtMs: number;
}

export interface EffectTransitionRecord {
  sequence: number;
  effectId: string;
  fromState?: EffectState;
  toState: EffectState;
  reasonCode: string;
  detailDigest?: Sha256Digest;
  createdAtMs: number;
}

export interface RecordObservedSpendInput {
  effectId: string;
  reservationId: string;
  transactionId: string;
  outpoint?: string;
  actualAmountAtomic: string;
  actualAdditionalCostAtomic: string;
  asset: string;
  payee: string;
  network: string;
  finality: string;
  fundingSource: FundingSource;
  evidenceDigest: Sha256Digest;
  evidenceVerificationProfile: string;
  evidenceVerifierId: string;
}

export interface TreasurySpendRecord extends RecordObservedSpendInput {
  id: number;
  purchaseId: PurchaseId;
  attempt: number;
  observedAtMs: number;
}

export interface ReconciliationRunRecord {
  id: number;
  purchaseId: PurchaseId;
  effectId?: string;
  outcome: string;
  detailDigest?: Sha256Digest;
  leaseName: string;
  leaseGeneration: number;
  createdAtMs: number;
}

export class JournalInvariantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JournalInvariantError";
  }
}

export class JournalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalNotFoundError";
  }
}

export class JournalFencingError extends JournalInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "JournalFencingError";
  }
}

export class JournalEffectBusyError extends JournalFencingError {
  constructor(message: string) {
    super(message);
    this.name = "JournalEffectBusyError";
  }
}

export class PolicyReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyReservationError";
  }
}

export class PurchaseAdmissionError extends Error {
  readonly code = "purchase_admission_saturated" as const;

  constructor(message = "Purchase admission capacity is saturated") {
    super(message);
    this.name = "PurchaseAdmissionError";
  }
}

export class EvidenceAdmissionError extends Error {
  readonly code = "evidence_admission_saturated" as const;

  constructor(message = "Evidence admission capacity is saturated") {
    super(message);
    this.name = "EvidenceAdmissionError";
  }
}

export class PurchaseJournal {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly faultInjector?: (point: JournalFaultPoint) => void;
  private readonly evidenceStore?: EvidenceStore;
  private readonly preparedMaterialStore?: EvidenceStore;
  private readonly admission?: AdmissionBudgetProjection;

  constructor(readonly filename: string, options: PurchaseJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.faultInjector = options.faultInjector;
    const databasePath = prepareDatabasePath(filename);
    this.db = new Database(filename);
    try {
      this.configure(options.busyTimeoutMs ?? 5_000);
      validateDatabaseFiles(databasePath);
      this.migrate();
      this.bindOperatorManifest(options.operatorManifestIdentity);
      const existingAdmission = options.admission ?? this.readAdmissionProjection();
      if (options.operatorManifestIdentity && !existingAdmission) {
        throw new JournalInvariantError("production Purchase Journal requires the Operator Manifest admission projection");
      }
      this.admission = existingAdmission === undefined
        ? undefined
        : validateAdmissionBudgets(existingAdmission);
      if (this.admission) this.ensureAdmissionBudget();
      const evidenceDirectory =
        options.evidenceDirectory ?? (filename === ":memory:" ? undefined : `${filename}.evidence`);
      this.evidenceStore = evidenceDirectory ? new EvidenceStore(evidenceDirectory) : undefined;
      const preparedMaterialDirectory =
        options.preparedMaterialDirectory ?? (filename === ":memory:" ? undefined : `${filename}.prepared`);
      this.preparedMaterialStore = preparedMaterialDirectory
        ? new EvidenceStore(preparedMaterialDirectory)
        : undefined;
      if (this.admission) this.reconcileAdmissionLeases();
      this.verifyStartup();
    } catch (error) {
      if (this.db.open) this.db.close();
      if (error instanceof JournalInvariantError) throw error;
      throw new JournalInvariantError("Purchase Journal failed its startup checks", { cause: error });
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  operatorManifestIdentity(): Readonly<{ revision: number; digest: string }> | undefined {
    const row = this.db
      .prepare("SELECT revision, digest FROM operator_manifest_binding WHERE singleton = 1")
      .get() as { revision: number; digest: string } | undefined;
    return row ? Object.freeze({ revision: row.revision, digest: row.digest }) : undefined;
  }

  admissionStatus(): JournalAdmissionStatus | undefined {
    if (!this.admission) return undefined;
    const row = this.db.prepare(
      `SELECT prevalidation_purchase_limit, evidence_byte_limit,
              reserved_purchase_count, reserved_evidence_bytes,
              committed_evidence_bytes
         FROM journal_admission_budget WHERE singleton = 1`
    ).get() as {
      prevalidation_purchase_limit: number;
      evidence_byte_limit: number;
      reserved_purchase_count: number;
      reserved_evidence_bytes: number;
      committed_evidence_bytes: number;
    } | undefined;
    if (!row) throw new JournalInvariantError("Journal admission budget is missing");
    const evidenceUsed = row.reserved_evidence_bytes + row.committed_evidence_bytes;
    return Object.freeze({
      prevalidationPurchases: Object.freeze({
        used: row.reserved_purchase_count,
        budget: row.prevalidation_purchase_limit,
        saturated: row.reserved_purchase_count >= row.prevalidation_purchase_limit,
      }),
      evidenceBytes: Object.freeze({
        used: evidenceUsed,
        reserved: row.reserved_evidence_bytes,
        budget: row.evidence_byte_limit,
        saturated: evidenceUsed >= row.evidence_byte_limit,
      }),
    });
  }

  recordChainEvidence(record: Readonly<ChainEvidenceRecord>): ChainEvidenceRecord {
    validateChainEvidenceRecord(record);
    const manifest = this.operatorManifestIdentity();
    if (!manifest) throw new JournalInvariantError("Chain Evidence requires an Operator Manifest binding");
    const existing = this.db.prepare("SELECT * FROM chain_evidence WHERE detail_digest = ?").get(record.detailDigest) as ChainEvidenceRow | undefined;
    if (existing) {
      const decoded = chainEvidenceFromRow(existing);
      if (JSON.stringify(decoded) !== JSON.stringify(record)) throw new JournalInvariantError("Chain Evidence digest collision");
      return decoded;
    }
    this.db.prepare(
      `INSERT INTO chain_evidence (
         detail_digest, profile, operation_id, operation, transaction_id, status,
         level, view, mechanism, protocol_finality, operator_floor, effective_floor,
         primary_profile, witness_profile, block_hash, accepting_block_hash,
         accepting_block_daa_score, virtual_daa_score, outputs_digest, observed_at_ms,
         manifest_revision, manifest_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.detailDigest, record.profile, record.operationId, record.operation,
      record.transactionId, record.status, record.level ?? null, record.view ?? null,
      record.mechanism, record.protocolFinality, record.operatorFloor, record.effectiveFloor,
      record.primaryProfile, record.witnessProfile, record.blockHash ?? null,
      record.acceptingBlockHash ?? null, record.acceptingBlockDaaScore ?? null,
      record.virtualDaaScore ?? null, record.outputsDigest, record.observedAtMs,
      manifest.revision, manifest.digest
    );
    return Object.freeze({ ...record });
  }

  findAcceptedChainEvidence(transactionId: string): ChainEvidenceRecord | undefined {
    if (!/^[a-f0-9]{64}$/.test(transactionId)) throw new JournalInvariantError("Chain Evidence transaction ID is invalid");
    const row = this.db.prepare(
      `SELECT * FROM chain_evidence
       WHERE transaction_id = ? AND status = 'present'
         AND level IN ('accepted', 'depth-confirmed', 'consensus-final')
       ORDER BY CASE level WHEN 'consensus-final' THEN 3 WHEN 'depth-confirmed' THEN 2 ELSE 1 END DESC,
                observed_at_ms DESC LIMIT 1`
    ).get(transactionId) as ChainEvidenceRow | undefined;
    return row ? chainEvidenceFromRow(row) : undefined;
  }

  integrityCheck(): true {
    const result = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (result.length !== 1 || result[0].integrity_check !== "ok") {
      throw new JournalInvariantError(`SQLite integrity check failed: ${JSON.stringify(result)}`);
    }
    const foreignKeys = this.db.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) {
      throw new JournalInvariantError("SQLite foreign-key integrity check failed");
    }
    return true;
  }

  createPurchase(input: CreatePurchaseInput): PurchaseRecord {
    validateCreatePurchase(input);
    const create = this.db.transaction(() => {
      const existing = this.findPurchaseByRequestKey(input.requestKey);
      if (existing) {
        assertSamePurchaseIntent(existing, input);
        return existing;
      }
      if (this.findPurchase(input.id)) throw new JournalInvariantError(`PurchaseId ${input.id} already exists`);
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO purchases (
             id, request_key, state, resource_url, method, resource_fingerprint,
             expected_merchant_id, expected_merchant_origin, version, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 'created', ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          input.id,
          input.requestKey,
          input.resourceUrl,
          input.method,
          input.resourceFingerprint,
          input.expectedMerchantId ?? null,
          input.expectedMerchantOrigin ?? null,
          now,
          now
        );
      const admissionLease = this.admitPurchaseInternal(input, now);
      this.inject("purchase.after_insert");
      this.insertPurchaseTransition(input.id, undefined, "created", "purchase_created", undefined, now);
      this.completePurchaseAdmissionInternal(admissionLease, now);
      return this.requirePurchase(input.id);
    });
    return create.immediate();
  }

  requirePurchase(id: PurchaseId): PurchaseRecord {
    const purchase = this.findPurchase(id);
    if (!purchase) throw new JournalNotFoundError(`Purchase ${id} does not exist`);
    return purchase;
  }

  findPurchase(id: PurchaseId): PurchaseRecord | undefined {
    const row = this.db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as PurchaseRow | undefined;
    return row ? purchaseFromRow(row) : undefined;
  }

  findPurchaseByRequestKey(requestKey: PurchaseRequestKey): PurchaseRecord | undefined {
    const row = this.db.prepare("SELECT * FROM purchases WHERE request_key = ?").get(requestKey) as PurchaseRow | undefined;
    return row ? purchaseFromRow(row) : undefined;
  }

  transitionPurchase(
    id: PurchaseId,
    expectedState: PurchaseState,
    toState: PurchaseState,
    reasonCode: string,
    detailDigest?: Sha256Digest
  ): PurchaseRecord {
    assertCode(reasonCode, "Purchase transition reason code");
    if (detailDigest) assertDigest(detailDigest, "Purchase transition detail digest");
    const transition = this.db.transaction(() => {
      const current = this.requirePurchase(id);
      if (current.state !== expectedState) {
        throw new JournalInvariantError(`Purchase ${id} expected state ${expectedState}, found ${current.state}`);
      }
      if (current.state === toState) return current;
      try {
        assertPurchaseTransition(current.state, toState);
      } catch (error) {
        throw new JournalInvariantError((error as Error).message);
      }
      this.assertPurchaseStateFacts(id, toState);
      const now = this.timestamp();
      const result = this.db
        .prepare(
          `UPDATE purchases
             SET state = ?, version = version + 1, updated_at_ms = ?
           WHERE id = ? AND state = ? AND version = ?`
        )
        .run(toState, now, id, current.state, current.version);
      if (result.changes !== 1) throw new JournalInvariantError(`concurrent Purchase transition for ${id}`);
      this.inject("purchase_transition.after_state_update");
      this.insertPurchaseTransition(id, current.state, toState, reasonCode, detailDigest, now);
      return this.requirePurchase(id);
    });
    return transition.immediate();
  }

  transitions(id: PurchaseId): PurchaseTransitionRecord[] {
    this.requirePurchase(id);
    const rows = this.db
      .prepare("SELECT * FROM purchase_transitions WHERE purchase_id = ? ORDER BY sequence")
      .all(id) as PurchaseTransitionRow[];
    return rows.map(purchaseTransitionFromRow);
  }

  bindCheckoutTerms(purchaseId: PurchaseId, input: BindCheckoutTermsInput): CheckoutTermsRecord {
    validateCheckoutTermsRecordInput(input);
    const bind = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      const existing = this.findCheckoutTerms(purchaseId);
      if (existing) {
        assertSameCheckoutTerms(existing, input);
        return existing;
      }
      if (purchase.state !== "created") {
        throw new JournalInvariantError(`Checkout Terms cannot be bound from Purchase state ${purchase.state}`);
      }
      if (purchase.resourceFingerprint !== input.terms.resourceFingerprint) {
        throw new JournalInvariantError("Checkout Terms resource does not match the Purchase Intent");
      }
      if (input.terms.checkoutDigest !== input.checkoutEvidenceDigest) {
        throw new JournalInvariantError("Checkout Terms digest must identify the exact verified Merchant artifact");
      }
      if (purchase.expectedMerchantId && purchase.expectedMerchantId !== input.terms.merchant.id) {
        throw new JournalInvariantError("Checkout Terms merchant does not match the expected merchant identity");
      }
      if (purchase.expectedMerchantOrigin && purchase.expectedMerchantOrigin !== input.terms.merchant.origin) {
        throw new JournalInvariantError("Checkout Terms merchant does not match the expected merchant origin");
      }
      const checkoutAttachment = this.requireEvidenceAttachment(
        purchaseId,
        input.checkoutEvidenceDigest,
        "checkout-terms"
      );
      const requirementsAttachment = this.requireEvidenceAttachment(
        purchaseId,
        input.paymentRequirementsDigest,
        "payment-requirements"
      );
      if (
        checkoutAttachment.issuer !== input.terms.merchant.id ||
        checkoutAttachment.profile !== input.checkoutVerificationProfile ||
        requirementsAttachment.issuer !== input.terms.merchant.id ||
        requirementsAttachment.profile !== input.paymentRequirementsVerificationProfile
      ) {
        throw new JournalInvariantError("Checkout evidence metadata is not bound to the canonical Merchant");
      }
      if (
        !this.isVerifiedEvidenceLinked(purchaseId, input.checkoutEvidenceDigest, {
          attempt: null,
          kind: "checkout-terms",
          verificationProfile: input.checkoutVerificationProfile,
          verifierId: input.checkoutVerifierId,
        })
      ) {
        throw new JournalInvariantError("Checkout Terms evidence is not verified and linked to this Purchase");
      }
      if (
        !this.isVerifiedEvidenceLinked(purchaseId, input.paymentRequirementsDigest, {
          attempt: null,
          kind: "payment-requirements",
          verificationProfile: input.paymentRequirementsVerificationProfile,
          verifierId: input.paymentRequirementsVerifierId,
        })
      ) {
        throw new JournalInvariantError("payment requirements evidence is not verified and linked to this Purchase");
      }
      const expiresAtMs = strictTimestamp(input.terms.expiresAt, "Checkout Terms expiry");
      if (expiresAtMs <= this.timestamp()) throw new JournalInvariantError("Checkout Terms are already expired");
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO checkout_terms (
             purchase_id, merchant_id, merchant_name, merchant_origin, resource_fingerprint,
             amount_atomic, asset, network, pay_to, expires_at, expires_at_ms, checkout_digest,
             checkout_evidence_digest, checkout_verification_profile, checkout_verifier_id,
             payment_requirements_digest, payment_requirements_verification_profile,
             payment_requirements_verifier_id, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          purchaseId,
          input.terms.merchant.id,
          input.terms.merchant.name,
          input.terms.merchant.origin,
          input.terms.resourceFingerprint,
          input.terms.amountAtomic,
          input.terms.asset,
          input.terms.network,
          input.terms.payTo,
          input.terms.expiresAt,
          expiresAtMs,
          input.terms.checkoutDigest,
          input.checkoutEvidenceDigest,
          input.checkoutVerificationProfile,
          input.checkoutVerifierId,
          input.paymentRequirementsDigest,
          input.paymentRequirementsVerificationProfile,
          input.paymentRequirementsVerifierId,
          now
        );
      this.inject("checkout_terms.after_insert");
      this.transitionPurchase(purchaseId, "created", "terms_bound", "checkout_terms_bound", input.terms.checkoutDigest);
      return this.requireCheckoutTerms(purchaseId);
    });
    return bind.immediate();
  }

  requireCheckoutTerms(purchaseId: PurchaseId): CheckoutTermsRecord {
    const terms = this.findCheckoutTerms(purchaseId);
    if (!terms) throw new JournalNotFoundError(`Purchase ${purchaseId} has no Checkout Terms`);
    return terms;
  }

  findCheckoutTerms(purchaseId: PurchaseId): CheckoutTermsRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM checkout_terms WHERE purchase_id = ?")
      .get(purchaseId) as CheckoutTermsRow | undefined;
    return row ? checkoutTermsFromRow(row) : undefined;
  }

  recordAuthorizationRequest(
    purchaseId: PurchaseId,
    input: RecordAuthorizationRequestInput
  ): AuthorizationRequestRecord {
    validateAuthorizationRequestInput(input);
    const record = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      const terms = this.requireCheckoutTerms(purchaseId);
      const existing = this.findAuthorizationRequest(purchaseId);
      if (existing) {
        assertSameAuthorizationRequest(existing, input);
        return existing;
      }
      if (purchase.state !== "terms_bound") {
        throw new JournalInvariantError(`authorization cannot be requested from Purchase state ${purchase.state}`);
      }
      if (input.checkoutDigest !== terms.checkoutDigest) {
        throw new JournalInvariantError("authorization request is bound to different Checkout Terms");
      }
      if (!this.evidenceLinked(purchaseId, input.requestDigest, "authorization-request")) {
        throw new JournalInvariantError("authorization request bytes are not durably linked to this Purchase");
      }
      const body = this.requireEvidenceAttachment(
        purchaseId,
        input.requestBodyDigest,
        "purchase-request-body"
      );
      const requestMediaType = input.requestMediaType || undefined;
      if (
        requestMediaType !== undefined &&
        body.mediaType !== requestMediaType
      ) {
        throw new JournalInvariantError("authorization request media type does not match its durable request body");
      }
      if (
        purchase.resourceFingerprint !== requestFingerprintFromBodyDigest({
          url: purchase.resourceUrl,
          method: purchase.method,
          mediaType: requestMediaType,
          bodyDigest: input.requestBodyDigest,
        })
      ) {
        throw new JournalInvariantError("authorization request body does not match the Purchase request fingerprint");
      }
      if (input.expiresAtMs > terms.expiresAtMs || input.expiresAtMs <= this.timestamp()) {
        throw new JournalInvariantError("authorization request expiry is outside the valid Checkout Terms window");
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO authorization_requests
             (purchase_id, checkout_digest, request_digest, nonce_digest, request_media_type,
              request_body_digest, additional_cost_ceiling_atomic, effective_finality_floor,
              expires_at_ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          purchaseId,
          input.checkoutDigest,
          input.requestDigest,
          input.nonceDigest,
          input.requestMediaType,
          input.requestBodyDigest,
          input.additionalCostCeilingAtomic,
          input.effectiveFinalityFloor,
          input.expiresAtMs,
          now
        );
      this.inject("authorization_request.after_insert");
      this.transitionPurchase(
        purchaseId,
        "terms_bound",
        "awaiting_authority",
        "authorization_requested",
        input.requestDigest
      );
      return this.requireAuthorizationRequest(purchaseId);
    });
    return record.immediate();
  }

  requireAuthorizationRequest(purchaseId: PurchaseId): AuthorizationRequestRecord {
    const request = this.findAuthorizationRequest(purchaseId);
    if (!request) throw new JournalNotFoundError(`Purchase ${purchaseId} has no authorization request`);
    return request;
  }

  findAuthorizationRequest(purchaseId: PurchaseId): AuthorizationRequestRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM authorization_requests WHERE purchase_id = ?")
      .get(purchaseId) as AuthorizationRequestRow | undefined;
    return row ? authorizationRequestFromRow(row) : undefined;
  }

  recordAuthorizationDecision(
    purchaseId: PurchaseId,
    input: RecordAuthorizationDecisionInput
  ): AuthorizationRecord {
    validateAuthorizationDecisionInput(input);
    const record = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      const request = this.requireAuthorizationRequest(purchaseId);
      const existing = this.findAuthorization(purchaseId);
      if (existing) {
        assertSameAuthorization(existing, input);
        return existing;
      }
      if (purchase.state !== "awaiting_authority") {
        throw new JournalInvariantError(`authorization decision cannot be recorded from Purchase state ${purchase.state}`);
      }
      if (
        request.checkoutDigest !== input.checkoutDigest ||
        request.requestDigest !== input.requestDigest ||
        request.nonceDigest !== input.nonceDigest ||
        request.expiresAtMs !== input.expiresAtMs
      ) {
        throw new JournalInvariantError("authorization decision does not match its immutable request");
      }
      if (input.approvedFactsDigest !== this.canonicalAuthorizationFactsDigest(purchaseId)) {
        throw new JournalInvariantError("authorization decision does not bind the canonical Purchase facts");
      }
      if (
        !this.isVerifiedEvidenceLinked(purchaseId, input.evidenceDigest, {
          attempt: null,
          kind: "purchase-authorization",
          verificationProfile: input.verificationProfile,
          verifierId: input.verifierId,
        })
      ) {
        throw new JournalInvariantError("authorization evidence is not verified and linked to this Purchase");
      }
      if (input.decision === "approved" && input.expiresAtMs <= this.timestamp()) {
        throw new JournalInvariantError("expired authorization cannot approve a Purchase");
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO purchase_authorizations (
             purchase_id, decision, authority_id, checkout_digest, approved_facts_digest,
             evidence_digest, verification_profile, verifier_id, request_digest, nonce_digest,
             expires_at_ms, decided_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          purchaseId,
          input.decision,
          input.authorityId,
          input.checkoutDigest,
          input.approvedFactsDigest,
          input.evidenceDigest,
          input.verificationProfile,
          input.verifierId,
          input.requestDigest,
          input.nonceDigest,
          input.expiresAtMs,
          now
        );
      this.inject("authorization_decision.after_insert");
      const nextState = input.decision === "approved" ? "authorised" : input.decision;
      this.transitionPurchase(
        purchaseId,
        "awaiting_authority",
        nextState,
        `authorization_${input.decision}`,
        input.evidenceDigest
      );
      return this.requireAuthorization(purchaseId);
    });
    return record.immediate();
  }

  requireAuthorization(purchaseId: PurchaseId): AuthorizationRecord {
    const authorization = this.findAuthorization(purchaseId);
    if (!authorization) throw new JournalNotFoundError(`Purchase ${purchaseId} has no authorization decision`);
    return authorization;
  }

  findAuthorization(purchaseId: PurchaseId): AuthorizationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM purchase_authorizations WHERE purchase_id = ?")
      .get(purchaseId) as AuthorizationRow | undefined;
    return row ? authorizationFromRow(row) : undefined;
  }

  storeEvidence(purchaseId: PurchaseId, input: StoreEvidenceInput): EvidenceAttachmentRecord {
    validateEvidenceMetadata(input);
    if (!this.evidenceStore) {
      throw new JournalInvariantError("an evidence directory is required for immutable evidence storage");
    }
    const digest = evidenceDigest(input.bytes);
    const lease = this.admitEvidenceInternal(purchaseId, digest, input.bytes.byteLength);
    let stored: StoredEvidence;
    try {
      stored = this.evidenceStore.store(input.bytes);
    } catch (error) {
      this.cancelEvidenceAdmission(lease, "write_failed");
      throw error;
    }
    try {
      const attach = this.db.transaction(() => {
        this.requirePurchase(purchaseId);
        if (input.attempt !== undefined) this.requirePaymentAttempt(purchaseId, input.attempt);
        const existing = this.findEvidence(stored.digest);
        if (existing) {
          assertSameEvidenceBlob(existing, stored.byteLength, stored.storageRef);
        } else {
          const now = this.timestamp();
          this.db
            .prepare(
              `INSERT INTO evidence_artifacts
                 (digest, media_type, profile, issuer, byte_length, storage_ref, created_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              stored.digest,
              "application/octet-stream",
              "urn:sompi:evidence-blob:1",
              null,
              stored.byteLength,
              stored.storageRef,
              now
            );
          this.inject("evidence.after_metadata_insert");
        }
        const attachedAtMs = this.timestamp();
        this.db
          .prepare(
            `INSERT OR IGNORE INTO evidence_links
               (purchase_id, digest, kind, attempt, media_type, profile, issuer, attached_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            purchaseId,
            stored.digest,
            input.kind,
            input.attempt ?? null,
            input.mediaType,
            input.profile,
            input.issuer ?? null,
            attachedAtMs
          );
        const attachment = this.requireEvidenceAttachment(
          purchaseId,
          stored.digest,
          input.kind,
          input.attempt
        );
        assertSameEvidenceAttachment(attachment, input);
        this.completeEvidenceAdmissionInternal(lease, !existing, this.timestamp());
        return attachment;
      });
      return attach.immediate();
    } catch (error) {
      this.cancelEvidenceAdmission(lease, "journal_write_failed");
      throw error;
    }
  }

  readEvidence(digest: Sha256Digest): Buffer {
    assertDigest(digest, "evidence digest");
    if (!this.evidenceStore) throw new JournalInvariantError("evidence storage is unavailable");
    const artifact = this.requireEvidence(digest);
    return this.evidenceStore.read(digest, artifact.byteLength);
  }

  requireEvidence(digest: Sha256Digest): EvidenceArtifactRecord {
    const evidence = this.findEvidence(digest);
    if (!evidence) throw new JournalNotFoundError(`Evidence ${digest} does not exist`);
    return evidence;
  }

  findEvidence(digest: Sha256Digest): EvidenceArtifactRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM evidence_artifacts WHERE digest = ?")
      .get(digest) as EvidenceArtifactRow | undefined;
    return row ? evidenceFromRow(row) : undefined;
  }

  requireEvidenceAttachment(
    purchaseId: PurchaseId,
    digest: Sha256Digest,
    kind: string,
    attempt?: number
  ): EvidenceAttachmentRecord {
    const attemptClause = attempt === undefined ? "l.attempt IS NULL" : "l.attempt = ?";
    const parameters = attempt === undefined
      ? [purchaseId, digest, kind]
      : [purchaseId, digest, kind, attempt];
    const row = this.db
      .prepare(
        `SELECT l.purchase_id, l.digest, l.kind, l.attempt, l.media_type, l.profile,
                l.issuer, l.attached_at_ms, a.byte_length, a.storage_ref,
                a.created_at_ms AS blob_created_at_ms
         FROM evidence_links l
         JOIN evidence_artifacts a ON a.digest = l.digest
         WHERE l.purchase_id = ? AND l.digest = ? AND l.kind = ? AND ${attemptClause}`
      )
      .get(...parameters) as EvidenceAttachmentRow | undefined;
    if (!row) throw new JournalNotFoundError(`Evidence Attachment ${purchaseId}/${kind}/${digest} does not exist`);
    return evidenceAttachmentFromRow(row);
  }

  recordEvidenceVerification(digest: Sha256Digest, input: EvidenceVerificationInput): void {
    assertDigest(digest, "evidence digest");
    assertBoundedText(input.verifierId, "evidence verifier identity", 200);
    assertBoundedText(input.profile, "evidence verification profile", 200);
    assertDigest(input.detailDigest, "evidence verification detail digest");
    this.readEvidence(digest);
    const record = this.db.transaction(() => {
      this.requireEvidence(digest);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO evidence_verifications
             (digest, verifier_id, profile, detail_digest, verified_at_ms)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(digest, input.verifierId, input.profile, input.detailDigest, this.timestamp());
    });
    record.immediate();
  }

  installPolicy(definition: PolicyDefinition): PolicySnapshotRecord {
    const canonical = canonicalPolicy(definition);
    const digest = evidenceDigest(JSON.stringify(canonical));
    const install = this.db.transaction(() => {
      let snapshot = this.findPolicy(digest);
      const now = this.timestamp();
      if (!snapshot) {
        const version = Number(
          (this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM policy_snapshots").get() as {
            version: number;
          }).version
        );
        this.db
          .prepare(
            `INSERT INTO policy_snapshots
               (digest, version, max_per_payment_atomic, max_per_hour_atomic,
                approval_above_atomic, activated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            digest,
            version,
            canonical.maxPerPaymentAtomic,
            canonical.maxPerHourAtomic,
            canonical.approvalAboveAtomic,
            now
          );
        for (const payee of canonical.allowlist) {
          this.db
            .prepare("INSERT INTO policy_allowlist (policy_digest, payee) VALUES (?, ?)")
            .run(digest, payee);
        }
        this.inject("policy.after_snapshot_insert");
        snapshot = this.requirePolicy(digest);
      }
      this.db
        .prepare(
          `INSERT INTO journal_policy (singleton, active_digest, updated_at_ms)
           VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             active_digest = excluded.active_digest,
             updated_at_ms = excluded.updated_at_ms`
        )
        .run(digest, now);
      return snapshot;
    });
    return install.immediate();
  }

  requireActivePolicy(): PolicySnapshotRecord {
    const row = this.db
      .prepare(
        `SELECT p.* FROM policy_snapshots p
         JOIN journal_policy j ON j.active_digest = p.digest
         WHERE j.singleton = 1`
      )
      .get() as PolicySnapshotRow | undefined;
    if (!row) throw new PolicyReservationError("no active treasury policy is installed");
    return policyFromRow(row, this.policyAllowlist(row.digest));
  }

  claimTreasuryOperationIntent(input: TreasuryOperationIntent): TreasuryOperationRecord {
    validateTreasuryOperationIntent(input);
    const claim = this.db.transaction(() => {
      const existing = this.findTreasuryOperation(input.operationKey);
      if (existing) {
        assertSameTreasuryOperationIntent(existing, input);
        return existing;
      }
      const policy = this.requireActivePolicy();
      if (policy.digest !== input.policyDigest) {
        throw new PolicyReservationError(
          "treasury policy changed; direct operation must re-evaluate against the active snapshot"
        );
      }
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      const resolved = input.requestedAmountAtomic === "max"
        ? undefined
        : input.requestedAmountAtomic;
      this.assertDirectTreasuryCapacity(
        policy,
        input.kind,
        input.destination,
        resolved ?? "0",
        input.feeCeilingAtomic,
        now
      );
      try {
        this.db.prepare(
          `INSERT INTO treasury_operations (
             operation_key, request_digest, kind, destination,
             requested_amount_atomic, keep_float_atomic, fee_ceiling_atomic,
             resolved_amount_atomic, policy_digest, retry_limit,
             state, retry_count, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', 0, ?, ?)`
        ).run(
          input.operationKey,
          input.requestDigest,
          input.kind,
          input.destination,
          input.requestedAmountAtomic,
          input.keepFloatAtomic ?? null,
          input.feeCeilingAtomic,
          resolved ?? null,
          input.policyDigest,
          input.retryLimit,
          now,
          now
        );
        this.inject("treasury_operation.after_intent_insert");
      } catch (cause) {
        if (isSqliteConstraint(cause)) {
          throw new PolicyReservationError(
            "another direct Treasury operation is unresolved; recover it before creating a new movement"
          );
        }
        throw cause;
      }
      this.insertTreasuryOperationTransition(
        input.operationKey,
        undefined,
        "intent",
        "intent_and_capacity_recorded",
        now
      );
      return this.requireTreasuryOperation(input.operationKey);
    });
    return claim.immediate();
  }

  recordPreparedTreasuryOperation(
    operationKey: string,
    prepared: PreparedTreasuryOperation
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    validatePreparedTreasuryOperation(prepared);
    const digest = evidenceDigest(prepared.bytes);
    const stored = this.storePreparedMaterial(prepared.bytes, digest);
    const record = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state !== "intent") {
        if (
          current.preparedDigest === stored.digest &&
          current.transactionId === prepared.transactionId &&
          current.resolvedAmountAtomic === prepared.amountAtomic &&
          current.feeAtomic === prepared.feeAtomic &&
          current.policyDigest === prepared.policyDigest
        ) {
          return current;
        }
        throw new JournalInvariantError(
          "direct Treasury operation preparation conflicts with durable material"
        );
      }
      const policy = this.requireActivePolicy();
      if (
        current.policyDigest !== prepared.policyDigest ||
        policy.digest !== prepared.policyDigest
      ) {
        throw new PolicyReservationError(
          "treasury policy changed before direct operation preparation was committed"
        );
      }
      if (
        current.requestedAmountAtomic !== "max" &&
        current.requestedAmountAtomic !== prepared.amountAtomic
      ) {
        throw new JournalInvariantError("prepared direct Treasury amount changed immutable intent");
      }
      if (BigInt(prepared.feeAtomic) > BigInt(current.feeCeilingAtomic)) {
        throw new PolicyReservationError(
          "prepared direct Treasury fee exceeds the capacity reserved before signing"
        );
      }
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      this.assertDirectTreasuryCapacity(
        policy,
        current.kind,
        current.destination,
        prepared.amountAtomic,
        current.feeCeilingAtomic,
        now,
        operationKey
      );
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET resolved_amount_atomic = ?, fee_atomic = ?, transaction_id = ?,
                prepared_digest = ?, prepared_ref = ?, prepared_byte_length = ?,
                state = 'prepared', updated_at_ms = ?
          WHERE operation_key = ? AND state = 'intent'`
      ).run(
        prepared.amountAtomic,
        prepared.feeAtomic,
        prepared.transactionId,
        stored.digest,
        stored.storageRef,
        stored.byteLength,
        now,
        operationKey
      );
      if (updated.changes !== 1) {
        throw new JournalInvariantError("concurrent direct Treasury preparation changed state");
      }
      this.inject("treasury_operation.after_prepared_update");
      this.insertTreasuryOperationTransition(
        operationKey,
        "intent",
        "prepared",
        "signed_material_persisted",
        now
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return record.immediate();
  }

  recordTreasuryPreparationRetry(
    operationKey: string,
    reasonCode: string,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    assertCode(reasonCode, "Treasury preparation retry reason");
    const retry = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state !== "intent") {
        throw new JournalInvariantError(
          "only an unprepared direct Treasury operation can record a preparation retry",
        );
      }
      if (current.retryCount >= current.retryLimit) {
        throw new JournalInvariantError("direct Treasury preparation retry limit is exhausted");
      }
      const now = this.timestamp();
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET retry_count = retry_count + 1, updated_at_ms = ?
          WHERE operation_key = ? AND state = 'intent' AND retry_count < retry_limit`
      ).run(now, operationKey);
      if (updated.changes !== 1) throw new JournalInvariantError("concurrent direct Treasury retry accounting");
      this.insertTreasuryOperationTransition(
        operationKey,
        "intent",
        "intent",
        reasonCode,
        now,
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return retry.immediate();
  }

  failTreasuryOperationPreparation(
    operationKey: string,
    reasonCode: string,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    if (
      reasonCode !== "invalid_destination" &&
      reasonCode !== "invalid_transaction_shape" &&
      reasonCode !== "cancelled_before_effect"
    ) {
      throw new JournalInvariantError("direct Treasury terminal preparation reason is invalid");
    }
    const failed = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state === "failed_terminal") return current;
      if (current.state !== "intent") {
        throw new JournalInvariantError(
          "only an unprepared direct Treasury operation may fail terminally",
        );
      }
      const now = this.timestamp();
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET state = 'failed_terminal', updated_at_ms = ?
          WHERE operation_key = ? AND state = 'intent'`
      ).run(now, operationKey);
      if (updated.changes !== 1) throw new JournalInvariantError("concurrent direct Treasury terminalization");
      this.insertTreasuryOperationTransition(
        operationKey,
        "intent",
        "failed_terminal",
        reasonCode,
        now,
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return failed.immediate();
  }

  cancelTreasuryOperation(operationKey: string): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    const current = this.requireTreasuryOperation(operationKey);
    if (current.state === "completed" || current.state === "failed_terminal") return current;
    if (current.state === "intent") {
      return this.failTreasuryOperationPreparation(operationKey, "cancelled_before_effect");
    }
    const cancelled = this.db.transaction(() => {
      const latest = this.requireTreasuryOperation(operationKey);
      if (latest.cancellationRequested) return latest;
      const now = this.timestamp();
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET cancellation_requested = 1, updated_at_ms = ?
          WHERE operation_key = ? AND cancellation_requested = 0`
      ).run(now, operationKey);
      if (updated.changes !== 1) throw new JournalInvariantError("concurrent direct Treasury cancellation");
      this.insertTreasuryOperationTransition(
        operationKey,
        latest.state,
        latest.state,
        "cancellation_requested",
        now,
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return cancelled.immediate();
  }

  requestTreasuryOperationCancellation(operationKey: string): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    const cancelled = this.db.transaction(() => {
      const latest = this.requireTreasuryOperation(operationKey);
      if (latest.state === "completed" || latest.state === "failed_terminal" || latest.cancellationRequested) {
        return latest;
      }
      const now = this.timestamp();
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET cancellation_requested = 1, updated_at_ms = ?
          WHERE operation_key = ? AND cancellation_requested = 0`
      ).run(now, operationKey);
      if (updated.changes !== 1) throw new JournalInvariantError("concurrent direct Treasury cancellation");
      this.insertTreasuryOperationTransition(
        operationKey,
        latest.state,
        latest.state,
        "cancellation_requested",
        now,
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return cancelled.immediate();
  }

  readPreparedTreasuryOperation(operationKey: string): Buffer {
    const operation = this.requireTreasuryOperation(operationKey);
    if (
      operation.preparedDigest === undefined ||
      operation.preparedByteLength === undefined
    ) {
      throw new JournalInvariantError("direct Treasury operation has no prepared material");
    }
    const row = this.db.prepare(
      "SELECT prepared_ref FROM treasury_operations WHERE operation_key = ?"
    ).get(operationKey) as { prepared_ref: string | null } | undefined;
    if (!row?.prepared_ref) {
      throw new JournalInvariantError("direct Treasury prepared material reference is missing");
    }
    return this.readPreparedMaterial(
      operation.preparedDigest as Sha256Digest,
      row.prepared_ref,
      operation.preparedByteLength
    );
  }

  readObservedTreasuryOperationDetail(
    operationKey: string
  ): Readonly<Record<string, unknown>> {
    const operation = this.requireTreasuryOperation(operationKey);
    if (operation.state !== "observed" && operation.state !== "completed") {
      throw new JournalInvariantError("direct Treasury operation has no observed result");
    }
    const row = this.db.prepare(
      `SELECT detail_json, detail_digest
         FROM treasury_operation_observations
        WHERE operation_key = ? AND status = 'observed'
        ORDER BY sequence DESC LIMIT 1`
    ).get(operationKey) as { detail_json: string; detail_digest: string } | undefined;
    if (!row || evidenceDigest(row.detail_json) !== row.detail_digest) {
      throw new JournalInvariantError("direct Treasury observation failed digest verification");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.detail_json);
    } catch (cause) {
      throw new JournalInvariantError("direct Treasury observation is malformed", { cause });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JournalInvariantError("direct Treasury observation is malformed");
    }
    return Object.freeze(parsed as Record<string, unknown>);
  }

  planTreasuryOperationSubmission(operationKey: string): boolean {
    assertTreasuryOperationKey(operationKey);
    const plan = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state !== "prepared") return false;
      const policy = this.requireActivePolicy();
      if (policy.digest !== current.policyDigest) {
        throw new PolicyReservationError(
          "treasury policy changed before direct operation submission"
        );
      }
      if (!current.resolvedAmountAtomic || current.feeAtomic === undefined) {
        throw new JournalInvariantError("direct Treasury operation lacks prepared cost facts");
      }
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      this.assertDirectTreasuryCapacity(
        policy,
        current.kind,
        current.destination,
        current.resolvedAmountAtomic,
        current.feeCeilingAtomic,
        now,
        operationKey
      );
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET state = 'submission_planned', updated_at_ms = ?
          WHERE operation_key = ? AND state = 'prepared'`
      ).run(now, operationKey);
      if (updated.changes !== 1) return false;
      this.inject("treasury_operation.after_submission_plan");
      this.insertTreasuryOperationTransition(
        operationKey,
        "prepared",
        "submission_planned",
        "submission_intent_committed",
        now
      );
      return true;
    });
    return plan.immediate();
  }

  recordTreasuryOperationSubmissionAccepted(
    operationKey: string,
    transactionId: string
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    assertTransactionId(transactionId);
    const record = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.transactionId !== transactionId) {
        throw new JournalInvariantError("submitted direct Treasury transaction identity changed");
      }
      if (["submitted", "observed", "completed"].includes(current.state)) return current;
      if (current.state !== "submission_planned") {
        throw new JournalInvariantError("direct Treasury submission was not durably planned");
      }
      const now = this.timestamp();
      this.db.prepare(
        `UPDATE treasury_operations SET state = 'submitted', updated_at_ms = ?
          WHERE operation_key = ? AND state = 'submission_planned'`
      ).run(now, operationKey);
      this.insertTreasuryOperationTransition(
        operationKey,
        "submission_planned",
        "submitted",
        "rpc_accepted",
        now
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return record.immediate();
  }

  recordTreasuryOperationObservation(
    operationKey: string,
    status: TreasuryOperationObservationStatus,
    detail: Readonly<Record<string, unknown>>
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    if (!["observed", "not_submitted", "pending"].includes(status)) {
      throw new JournalInvariantError("direct Treasury observation status is invalid");
    }
    const detailJson = canonicalTreasuryObservationJson(detail);
    if (Buffer.byteLength(detailJson) > 16_384) {
      throw new JournalInvariantError("direct Treasury observation is oversized");
    }
    const detailDigest = evidenceDigest(detailJson);
    const record = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (!["submission_planned", "submitted", "observed"].includes(current.state)) {
        throw new JournalInvariantError("direct Treasury operation is not awaiting observation");
      }
      const now = this.timestamp();
      this.db.prepare(
        `INSERT OR IGNORE INTO treasury_operation_observations
           (operation_key, status, detail_digest, detail_json, observed_at_ms)
         VALUES (?, ?, ?, ?, ?)`
      ).run(operationKey, status, detailDigest, detailJson, now);
      this.inject("treasury_operation.after_observation_insert");
      if (status === "pending" || current.state === "observed") {
        return this.requireTreasuryOperation(operationKey);
      }
      const next: TreasuryOperationState = status === "observed" ? "observed" : "prepared";
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET state = ?, retry_count = retry_count + ?, updated_at_ms = ?
          WHERE operation_key = ? AND state = ?`
      ).run(next, status === "not_submitted" ? 1 : 0, now, operationKey, current.state);
      if (updated.changes !== 1) {
        throw new JournalInvariantError("concurrent direct Treasury observation changed state");
      }
      this.insertTreasuryOperationTransition(
        operationKey,
        current.state,
        next,
        status === "observed" ? "chain_observed" : "exact_inputs_prove_not_submitted",
        now
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return record.immediate();
  }

  completeTreasuryOperation(operationKey: string): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    const complete = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state === "completed") return current;
      if (current.state !== "observed") {
        throw new JournalInvariantError("unobserved direct Treasury operation cannot complete");
      }
      const now = this.timestamp();
      this.db.prepare(
        `UPDATE treasury_operations
            SET state = 'completed', updated_at_ms = ?, completed_at_ms = ?
          WHERE operation_key = ? AND state = 'observed'`
      ).run(now, now, operationKey);
      this.inject("treasury_operation.after_complete_update");
      this.insertTreasuryOperationTransition(
        operationKey,
        "observed",
        "completed",
        "local_commit_complete",
        now
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return complete.immediate();
  }

  findTreasuryOperation(operationKey: string): TreasuryOperationRecord | undefined {
    assertTreasuryOperationKey(operationKey);
    const row = this.db.prepare(
      "SELECT * FROM treasury_operations WHERE operation_key = ?"
    ).get(operationKey) as TreasuryOperationRow | undefined;
    return row ? treasuryOperationFromRow(row) : undefined;
  }

  requireTreasuryOperation(operationKey: string): TreasuryOperationRecord {
    const operation = this.findTreasuryOperation(operationKey);
    if (!operation) {
      throw new JournalNotFoundError(`Treasury Operation ${operationKey} does not exist`);
    }
    return operation;
  }

  treasuryOperationSpentLastHour(): bigint {
    const cutoff = this.timestamp() - 60 * 60 * 1000;
    const rows = this.db.prepare(
      `SELECT kind, resolved_amount_atomic, fee_atomic FROM treasury_operations
        WHERE state = 'completed' AND completed_at_ms >= ?`
    ).all(cutoff) as Array<{
      kind: TreasuryOperationRecord["kind"];
      resolved_amount_atomic: string;
      fee_atomic: string;
    }>;
    return rows.reduce(
      (sum, row) =>
        sum +
        (row.kind === "vault_deposit" ? 0n : BigInt(row.resolved_amount_atomic)) +
        BigInt(row.fee_atomic),
      0n
    );
  }

  treasuryPolicyCapacityUsed(): bigint {
    const read = this.db.transaction(() => {
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      return this.policyCapacityUsedInternal(now);
    });
    return read.immediate();
  }

  unresolvedTreasuryOperationCount(): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS count FROM treasury_operations
        WHERE state NOT IN ('completed', 'failed_terminal')`
    ).get() as { count: number }).count;
  }

  requirePolicy(digest: Sha256Digest): PolicySnapshotRecord {
    const policy = this.findPolicy(digest);
    if (!policy) throw new JournalNotFoundError(`Policy ${digest} does not exist`);
    return policy;
  }

  reservePolicy(input: PolicyReservationInput): PolicyReservationRecord {
    validatePolicyReservationInput(input);
    const reserve = this.db.transaction(() => {
      const purchase = this.requirePurchase(input.purchaseId);
      if (purchase.state !== "authorised" && purchase.state !== "execution_prepared") {
        throw new PolicyReservationError(`Purchase ${input.purchaseId} is not authorized for treasury reservation`);
      }
      const terms = this.requireCheckoutTerms(input.purchaseId);
      const authorization = this.requireAuthorization(input.purchaseId);
      const authorizationRequest = this.requireAuthorizationRequest(input.purchaseId);
      if (authorization.decision !== "approved") {
        throw new PolicyReservationError("Treasury Reservation requires approved Purchase Authorization");
      }
      if (input.amountAtomic !== terms.amountAtomic || input.payee !== terms.payTo) {
        throw new PolicyReservationError("Treasury Reservation does not match canonical Checkout Terms");
      }
      if (BigInt(input.additionalCostCeilingAtomic) > BigInt(authorizationRequest.additionalCostCeilingAtomic)) {
        throw new PolicyReservationError("Treasury Reservation exceeds the authorized additional-cost ceiling");
      }
      if (
        input.approvalEvidenceDigest !== authorization.evidenceDigest ||
        input.approvalVerificationProfile !== authorization.verificationProfile ||
        input.approvalVerifierId !== authorization.verifierId
      ) {
        throw new PolicyReservationError("Treasury Reservation is not bound to the exact Purchase Authorization");
      }
      if (input.expiresAtMs > terms.expiresAtMs) {
        throw new PolicyReservationError("Treasury Reservation outlives canonical Checkout Terms");
      }
      const policy = this.requireActivePolicy();
      if (policy.digest !== input.policyDigest) {
        throw new PolicyReservationError("treasury policy changed; caller must re-evaluate against the active snapshot");
      }
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      if (input.expiresAtMs <= now) {
        throw new PolicyReservationError("treasury reservation expiry must be in the future");
      }
      const existing = this.findReservation(input.id);
      if (existing) {
        assertSameReservation(existing, input);
        return existing;
      }
      const open = this.db
        .prepare(
          `SELECT id FROM treasury_reservations
           WHERE purchase_id = ? AND state IN ('active', 'in_flight', 'spent')`
        )
        .get(input.purchaseId) as { id: string } | undefined;
      if (open) {
        throw new PolicyReservationError(`Purchase ${input.purchaseId} already has reservation ${open.id}`);
      }
      if (policy.allowlist.length > 0 && !policy.allowlist.includes(input.payee)) {
        throw new PolicyReservationError(`payee ${input.payee} is not on the active policy allowlist`);
      }
      const amount = decimalBigInt(input.amountAtomic, "reservation amount");
      const additionalCost = decimalBigInt(
        input.additionalCostCeilingAtomic,
        "reservation additional-cost ceiling",
        true
      );
      const gross = amount + additionalCost;
      const maxPerPayment = decimalBigInt(policy.maxPerPaymentAtomic, "per-payment limit");
      const maxPerHour = decimalBigInt(policy.maxPerHourAtomic, "hourly limit");
      const approvalThreshold = decimalBigInt(policy.approvalAboveAtomic, "approval threshold", true);
      if (gross > maxPerPayment) {
        throw new PolicyReservationError(`gross treasury movement ${gross} exceeds per-payment limit ${maxPerPayment}`);
      }
      if (approvalThreshold > 0n && amount > approvalThreshold) {
        if (!input.approvalEvidenceDigest) {
          throw new PolicyReservationError("verified authority evidence is required above the approval threshold");
        }
        if (
          !this.isVerifiedEvidenceLinked(input.purchaseId, input.approvalEvidenceDigest, {
            attempt: null,
            kind: "purchase-authorization",
            verificationProfile: input.approvalVerificationProfile,
            verifierId: input.approvalVerifierId,
          })
        ) {
          throw new PolicyReservationError("authority evidence is not verified and linked to this Purchase");
        }
      } else if (
        input.approvalEvidenceDigest &&
        !this.isVerifiedEvidenceLinked(input.purchaseId, input.approvalEvidenceDigest, {
        attempt: null,
        kind: "purchase-authorization",
        verificationProfile: input.approvalVerificationProfile,
        verifierId: input.approvalVerifierId,
        })
      ) {
        throw new PolicyReservationError("provided authority evidence is not verified and linked to this Purchase");
      }
      const used = this.policyCapacityUsedInternal(now);
      if (used + gross > maxPerHour) {
        throw new PolicyReservationError(
          `gross treasury movement ${gross} would exceed hourly limit ${maxPerHour}; ${used} already used or reserved`
        );
      }
      this.db
        .prepare(
          `INSERT INTO treasury_reservations
             (id, purchase_id, policy_digest, approval_evidence_digest,
              approval_verification_profile, approval_verifier_id, payee,
              amount_atomic, additional_cost_ceiling_atomic, funding_source,
              state, expires_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        )
        .run(
          input.id,
          input.purchaseId,
          input.policyDigest,
          input.approvalEvidenceDigest ?? null,
          input.approvalVerificationProfile ?? null,
          input.approvalVerifierId ?? null,
          input.payee,
          input.amountAtomic,
          input.additionalCostCeilingAtomic,
          input.fundingSource,
          input.expiresAtMs,
          now,
          now
        );
      this.inject("reservation.after_insert");
      return this.requireReservation(input.id);
    });
    return reserve.immediate();
  }

  releaseActiveReservation(id: string): PolicyReservationRecord {
    const release = this.db.transaction(() => {
      const reservation = this.requireReservation(id);
      if (reservation.state === "released") return reservation;
      if (reservation.state !== "active") {
        throw new PolicyReservationError(`reservation ${id} cannot be released from ${reservation.state}`);
      }
      const result = this.db
        .prepare("UPDATE treasury_reservations SET state = 'released', updated_at_ms = ? WHERE id = ? AND state = 'active'")
        .run(this.timestamp(), id);
      if (result.changes !== 1) throw new JournalInvariantError(`concurrent Treasury Reservation release for ${id}`);
      return this.requireReservation(id);
    });
    return release.immediate();
  }

  /**
   * Terminates a never-staged Purchase after Checkout expiry. Ambiguous
   * Merchant presentation must be reconciled first; accepted presentation is
   * harmless but can no longer authorize Treasury execution.
   */
  expirePurchaseBeforeTreasury(purchaseId: PurchaseId): PurchaseRecord {
    const expire = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      const terms = this.requireCheckoutTerms(purchaseId);
      const authorization = this.requireAuthorization(purchaseId);
      const now = this.timestamp();
      if (
        purchase.state !== "authorised" ||
        Math.min(terms.expiresAtMs, authorization.expiresAtMs) > now
      ) {
        throw new JournalInvariantError(
          "only an authorised Purchase with expired Checkout Terms can terminate before Treasury"
        );
      }
      const commerce = this.effectsForPurchase(purchaseId).filter(
        (effect) => effect.kind === MERCHANT_AUTHORIZATION_EFFECT_KIND
      );
      if (commerce.length > 1) {
        throw new JournalInvariantError("Purchase has conflicting Merchant authorization Effects");
      }
      const effect = commerce[0];
      if (
        effect &&
        !["planned", "retryable", "observed", "abandoned"].includes(effect.state)
      ) {
        throw new JournalEffectBusyError(
          "ambiguous Merchant authorization must be reconciled before expiry"
        );
      }
      const attempts = this.paymentAttempts(purchaseId);
      if (attempts.length > 1) {
        throw new JournalInvariantError("expired Purchase has multiple Payment Attempts");
      }
      const attempt = attempts[0];
      if (attempt && attempt.state === "planned") {
        this.transitionAttemptInternal(
          attempt,
          "failed",
          "checkout_expired_before_treasury",
          terms.checkoutDigest,
          now,
          "checkout_expired_before_treasury"
        );
      } else if (attempt && attempt.state !== "failed") {
        throw new JournalInvariantError("expired pre-Treasury Purchase already advanced execution");
      }
      if (effect && (effect.state === "planned" || effect.state === "retryable")) {
        this.updateEffectState(
          effect,
          "abandoned",
          "checkout_expired_before_treasury",
          terms.checkoutDigest,
          now,
          { errorCode: "checkout_expired_before_treasury" }
        );
      }
      const reservation = this.findReservationForPurchase(purchaseId);
      if (reservation?.state === "active") {
        const updated = this.db.prepare(
          "UPDATE treasury_reservations SET state = 'released', updated_at_ms = ? WHERE id = ? AND state = 'active'"
        ).run(now, reservation.id);
        if (updated.changes !== 1) {
          throw new JournalInvariantError("concurrent expired Reservation release");
        }
      } else if (reservation && reservation.state !== "released" && reservation.state !== "expired") {
        throw new JournalInvariantError("pre-Treasury expiry found irreversible Treasury state");
      }
      return this.transitionPurchase(
        purchaseId,
        "authorised",
        "expired",
        "checkout_expired_before_treasury",
        terms.checkoutDigest
      );
    });
    return expire.immediate();
  }

  /** Blocks the first Merchant payment after staging when its authority expired. */
  blockExpiredStagedPurchase(purchaseId: PurchaseId): PurchaseRecord {
    const block = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      const terms = this.requireCheckoutTerms(purchaseId);
      const authorization = this.requireAuthorization(purchaseId);
      const now = this.timestamp();
      if (
        purchase.state !== "execution_prepared" ||
        Math.min(terms.expiresAtMs, authorization.expiresAtMs) > now
      ) {
        throw new JournalInvariantError(
          "only an execution-prepared Purchase with expired Checkout Terms can be blocked"
        );
      }
      const attempts = this.paymentAttempts(purchaseId);
      if (attempts.length !== 1) {
        throw new JournalInvariantError("expired staged Purchase must have one Payment Attempt");
      }
      const attempt = attempts[0];
      const staging = this.findTreasuryStagingObservation(purchaseId, attempt.attempt);
      if (!staging || this.requireEffect(staging.effectId).state !== "observed") {
        throw new JournalInvariantError("expired staged Purchase lacks verified staging recovery facts");
      }
      const paymentEffects = this.effectsForPurchase(purchaseId).filter(
        (effect) =>
          effect.attempt === attempt.attempt &&
          effect.kind === "kaspa-x402-exact"
      );
      if (paymentEffects.length > 1 || paymentEffects.some((effect) => effect.state !== "planned")) {
        throw new JournalInvariantError(
          "expired staged Purchase may be blocked only before its first payment claim"
        );
      }
      if (attempt.state !== "planned" && attempt.state !== "prepared") {
        throw new JournalInvariantError("expired staged Payment Attempt already advanced submission");
      }
      this.transitionAttemptInternal(
        attempt,
        "failed",
        "checkout_expired_after_staging",
        terms.checkoutDigest,
        now,
        "checkout_expired_after_staging"
      );
      if (paymentEffects[0]) {
        this.updateEffectState(
          paymentEffects[0],
          "abandoned",
          "checkout_expired_after_staging",
          terms.checkoutDigest,
          now,
          { errorCode: "checkout_expired_after_staging" }
        );
      }
      return this.transitionPurchase(
        purchaseId,
        "execution_prepared",
        "failed_recoverable",
        "checkout_expired_after_staging",
        terms.checkoutDigest
      );
    });
    return block.immediate();
  }

  releaseInFlightReservation(
    reservationId: string,
    effectId: string,
    lease: LeaseToken,
    proofDigest: Sha256Digest
  ): PolicyReservationRecord {
    assertDigest(proofDigest, "reservation release proof digest");
    const release = this.db.transaction(() => {
      this.assertEffectWriter(effectId, lease);
      const effect = this.requireEffect(effectId);
      if (effect.state !== "retryable") {
        throw new PolicyReservationError("in-flight capacity can be released only after a retryable not-found observation");
      }
      const reservation = this.requireReservation(reservationId);
      if (reservation.state === "released") return reservation;
      if (reservation.state !== "in_flight") {
        throw new PolicyReservationError(`reservation ${reservationId} cannot be released from ${reservation.state}`);
      }
      const preparation = effect.attempt === undefined
        ? undefined
        : this.requirePaymentPreparation(effect.purchaseId, effect.attempt);
      if (!preparation || preparation.reservationId !== reservationId) {
        throw new PolicyReservationError("effect is not bound to the in-flight reservation");
      }
      const proof = this.db
        .prepare(
          `SELECT id FROM effect_observations
           WHERE effect_id = ? AND status = 'not_found_retryable' AND detail_digest = ?`
        )
        .get(effectId, proofDigest);
      if (!proof) throw new PolicyReservationError("reservation release proof is not recorded");
      const now = this.timestamp();
      this.db
        .prepare(
          `UPDATE treasury_reservations
           SET state = 'released', release_evidence_digest = ?, updated_at_ms = ?
           WHERE id = ? AND state = 'in_flight'`
        )
        .run(proofDigest, now, reservationId);
      if (effect.attempt === undefined) {
        throw new JournalInvariantError("in-flight payment release requires a Payment Attempt");
      }
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      if (attempt.state !== "submitted") {
        throw new JournalInvariantError("in-flight payment release requires a submitted Payment Attempt");
      }
      const reason = "payment_abandoned_after_not_found";
      this.transitionAttemptInternal(attempt, "failed", reason, proofDigest, now, reason, true);
      this.updateEffectState(effect, "failed_terminal", reason, proofDigest, now, { errorCode: reason });
      return this.requireReservation(reservationId);
    });
    return release.immediate();
  }

  expireReservations(): number {
    const expire = this.db.transaction(() => this.expireReservationsInternal(this.timestamp()));
    return expire.immediate();
  }

  requireReservation(id: string): PolicyReservationRecord {
    const reservation = this.findReservation(id);
    if (!reservation) throw new JournalNotFoundError(`Treasury Reservation ${id} does not exist`);
    return reservation;
  }

  policyCapacityUsed(): bigint {
    const calculate = this.db.transaction(() => {
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      return this.policyCapacityUsedInternal(now);
    });
    return calculate.immediate();
  }

  createPaymentAttempt(input: CreatePaymentAttemptInput): PaymentAttemptRecord {
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw new JournalInvariantError("payment attempt must be a positive safe integer");
    }
    const expectedIdentifier = createPaymentIdentifier(input.purchaseId, input.attempt);
    if (input.identifier !== expectedIdentifier) {
      throw new JournalInvariantError("payment identifier is not bound to this Purchase and attempt");
    }
    const create = this.db.transaction(() => {
      const purchase = this.requirePurchase(input.purchaseId);
      if (purchase.state !== "authorised" && purchase.state !== "execution_prepared") {
        throw new JournalInvariantError("Payment Attempt requires an authorized Purchase");
      }
      const existing = this.findPaymentAttempt(input.purchaseId, input.attempt);
      if (existing) {
        if (existing.identifier !== input.identifier) throw new JournalInvariantError("payment attempt identity conflict");
        return existing;
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO payment_attempts
             (purchase_id, attempt, identifier, state, version, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, 'planned', 0, ?, ?)`
        )
        .run(input.purchaseId, input.attempt, input.identifier, now, now);
      this.inject("payment_attempt.after_insert");
      this.insertAttemptTransition(input.purchaseId, input.attempt, undefined, "planned", "attempt_created", undefined, now);
      return this.requirePaymentAttempt(input.purchaseId, input.attempt);
    });
    return create.immediate();
  }

  requirePaymentAttempt(purchaseId: PurchaseId, attempt: number): PaymentAttemptRecord {
    const paymentAttempt = this.findPaymentAttempt(purchaseId, attempt);
    if (!paymentAttempt) throw new JournalNotFoundError(`Payment Attempt ${purchaseId}/${attempt} does not exist`);
    return paymentAttempt;
  }

  planTreasuryStaging(input: PlanTreasuryStagingInput): TreasuryStagingPlanRecord {
    validateTreasuryStagingPlanInput(input);
    const stored = this.storePreparedMaterial(input.preparedBytes, input.payloadDigest);
    const plan = this.db.transaction(() => {
      const attempt = this.requirePaymentAttempt(input.purchaseId, input.attempt);
      const effectRow = this.db
        .prepare("SELECT * FROM effects WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as EffectRow | undefined;
      if (effectRow) {
        const effect = effectFromRow(effectRow);
        if (effect.kind !== TREASURY_STAGING_EFFECT_KIND) {
          throw new JournalInvariantError("treasury staging idempotency key belongs to another Effect kind");
        }
        const existing = this.findTreasuryStagingPlanByEffect(effect.id);
        if (!existing) {
          throw new JournalInvariantError("treasury staging Effect has no immutable plan");
        }
        assertSameTreasuryStagingPlan(existing, input, stored);
        return existing;
      }
      if (this.findTreasuryStagingPlan(input.purchaseId, input.attempt)) {
        throw new JournalInvariantError("Payment Attempt already has a different treasury staging plan");
      }
      if (this.findPaymentPreparation(input.purchaseId, input.attempt)) {
        throw new JournalInvariantError("treasury staging must be planned before exact payment preparation");
      }
      if (attempt.state !== "planned") {
        throw new JournalInvariantError(`treasury staging cannot be planned from Attempt state ${attempt.state}`);
      }
      this.requireObservedMerchantAuthorization(
        input.purchaseId,
        input.attempt,
        attempt.identifier
      );
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      const reservation = this.requireReservation(input.reservationId);
      if (
        reservation.purchaseId !== input.purchaseId ||
        reservation.state !== "active" ||
        reservation.fundingSource !== input.fundingSource
      ) {
        throw new JournalInvariantError(
          "treasury staging requires this Purchase's active Reservation and funding source"
        );
      }
      if (reservation.policyDigest !== this.requireActivePolicy().digest) {
        throw new PolicyReservationError("active treasury policy changed before staging preparation");
      }
      const reservedGross =
        BigInt(reservation.amountAtomic) + BigInt(reservation.additionalCostCeilingAtomic);
      if (BigInt(input.stagingAmountAtomic) > reservedGross) {
        throw new PolicyReservationError("treasury staging amount exceeds its Reservation");
      }

      const effectId = opaqueId("eff");
      this.db
        .prepare(
          `INSERT INTO effects
             (id, purchase_id, attempt, kind, idempotency_key, state, version,
              payload_digest, prepared_ref, prepared_byte_length, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 'planned', 0, ?, ?, ?, ?, ?)`
        )
        .run(
          effectId,
          input.purchaseId,
          input.attempt,
          TREASURY_STAGING_EFFECT_KIND,
          input.idempotencyKey,
          input.payloadDigest,
          stored.storageRef,
          stored.byteLength,
          now,
          now
        );
      this.inject("effect.after_insert");
      this.insertEffectTransition(
        effectId,
        undefined,
        "planned",
        "treasury_staging_planned",
        input.payloadDigest,
        now
      );
      this.db
        .prepare(
          `INSERT INTO treasury_staging_plans
             (effect_id, purchase_id, attempt, reservation_id, payload_digest,
              prepared_ref, prepared_byte_length, planned_transaction_id,
              expected_outpoint, staging_amount_atomic, funding_source, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          effectId,
          input.purchaseId,
          input.attempt,
          input.reservationId,
          input.payloadDigest,
          stored.storageRef,
          stored.byteLength,
          input.plannedTransactionId,
          input.expectedOutpoint,
          input.stagingAmountAtomic,
          input.fundingSource,
          now
        );
      this.inject("treasury_staging_plan.after_insert");
      return this.requireTreasuryStagingPlan(input.purchaseId, input.attempt);
    });
    return plan.immediate();
  }

  requireTreasuryStagingPlan(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingPlanRecord {
    const plan = this.findTreasuryStagingPlan(purchaseId, attempt);
    if (!plan) {
      throw new JournalNotFoundError(`Treasury staging plan ${purchaseId}/${attempt} does not exist`);
    }
    return plan;
  }

  readPreparedTreasuryStaging(purchaseId: PurchaseId, attempt: number): Buffer {
    const plan = this.requireTreasuryStagingPlan(purchaseId, attempt);
    return this.readPreparedMaterial(plan.payloadDigest, plan.preparedRef, plan.preparedByteLength);
  }

  beginTreasuryStaging(
    effectId: string,
    reservationId: string,
    holder: string,
    ttlMs: number
  ): EffectClaim | undefined {
    const begin = this.db.transaction(() => {
      const effect = this.requireEffect(effectId);
      if (effect.kind !== TREASURY_STAGING_EFFECT_KIND || effect.attempt === undefined) {
        throw new JournalInvariantError("treasury staging claim requires its dedicated attempt-bound Effect");
      }
      const plan = this.requireTreasuryStagingPlan(effect.purchaseId, effect.attempt);
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      this.requireObservedMerchantAuthorization(
        effect.purchaseId,
        effect.attempt,
        attempt.identifier
      );
      this.readPreparedMaterial(plan.payloadDigest, plan.preparedRef, plan.preparedByteLength);
      this.readPreparedMaterial(effect.payloadDigest, effect.preparedRef, effect.preparedByteLength);
      if (
        plan.effectId !== effect.id ||
        plan.reservationId !== reservationId ||
        effect.payloadDigest !== plan.payloadDigest ||
        effect.preparedRef !== plan.preparedRef ||
        effect.preparedByteLength !== plan.preparedByteLength
      ) {
        throw new JournalInvariantError("treasury staging Effect is not bound to its immutable plan");
      }
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      const reservation = this.requireReservation(reservationId);
      if (
        reservation.purchaseId !== effect.purchaseId ||
        reservation.fundingSource !== plan.fundingSource
      ) {
        throw new JournalInvariantError("treasury staging plan is not bound to its Reservation");
      }
      if (effect.state === "planned") {
        if (attempt.state !== "planned" || reservation.state !== "active") {
          throw new JournalInvariantError(
            "first treasury staging claim requires planned Attempt and active Reservation"
          );
        }
        if (reservation.expiresAtMs <= now) {
          throw new PolicyReservationError("Reservation expired before treasury staging");
        }
        if (reservation.policyDigest !== this.requireActivePolicy().digest) {
          throw new PolicyReservationError("active treasury policy changed before treasury staging");
        }
      } else if (effect.state === "retryable") {
        if (attempt.state !== "planned" || reservation.state !== "in_flight") {
          throw new JournalInvariantError(
            "treasury staging retry requires planned Attempt and original in-flight Reservation"
          );
        }
      }
      const claimed = this.claimEffectInternal(effect, holder, ttlMs);
      if (!claimed) return undefined;
      if (reservation.state === "active") {
        const moved = this.db
          .prepare(
            `UPDATE treasury_reservations
             SET state = 'in_flight', in_flight_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND state = 'active'`
          )
          .run(now, now, reservationId);
        if (moved.changes !== 1) {
          throw new JournalInvariantError("concurrent Treasury Reservation staging claim");
        }
      }
      return { effect: this.requireEffect(effectId), lease: claimed.lease };
    });
    return begin.immediate();
  }

  private requireObservedMerchantAuthorization(
    purchaseId: PurchaseId,
    attempt: number,
    paymentIdentifier: string
  ): EffectRecord {
    const matches = this.effectsForPurchase(purchaseId).filter(
      (effect) => effect.kind === MERCHANT_AUTHORIZATION_EFFECT_KIND
    );
    if (matches.length !== 1) {
      throw new JournalInvariantError(
        "treasury staging requires exactly one durable Merchant authorization Effect"
      );
    }
    const effect = matches[0];
    if (
      effect.attempt !== undefined ||
      effect.idempotencyKey !== `merchant-authorization:${paymentIdentifier}` ||
      effect.state !== "observed" ||
      !effect.resultDigest ||
      !this.isVerifiedEvidenceLinked(purchaseId, effect.resultDigest, {
        attempt,
        kind: MERCHANT_AUTHORIZATION_EVIDENCE_KIND,
      })
    ) {
      throw new JournalInvariantError(
        "treasury staging requires verified Merchant authorization for this Payment Attempt"
      );
    }
    return effect;
  }

  recordObservedTreasuryStaging(
    lease: LeaseToken,
    input: RecordObservedTreasuryStagingInput
  ): TreasuryStagingObservationRecord {
    validateTreasuryStagingObservationInput(input);
    const record = this.db.transaction(() => {
      this.assertEffectWriter(input.effectId, lease);
      const effect = this.requireEffect(input.effectId);
      if (effect.kind !== TREASURY_STAGING_EFFECT_KIND || effect.attempt === undefined) {
        throw new JournalInvariantError("observed treasury staging requires its dedicated Effect");
      }
      const existing = this.findTreasuryStagingObservationByEffect(effect.id);
      if (existing) {
        assertSameTreasuryStagingObservation(existing, input);
        if (effect.state !== "observed" || effect.resultDigest !== input.evidenceDigest) {
          throw new JournalInvariantError("treasury staging observation conflicts with Effect state");
        }
        return existing;
      }
      if (effect.state !== "executing" && effect.state !== "submitted" && effect.state !== "ambiguous") {
        throw new JournalInvariantError(
          `Treasury staging Effect ${effect.id} cannot record output from ${effect.state}`
        );
      }
      const plan = this.requireTreasuryStagingPlan(effect.purchaseId, effect.attempt);
      if (
        plan.effectId !== effect.id ||
        plan.reservationId !== input.reservationId ||
        plan.plannedTransactionId !== input.transactionId ||
        plan.expectedOutpoint !== input.outpoint ||
        plan.stagingAmountAtomic !== input.stagingAmountAtomic ||
        plan.fundingSource !== input.fundingSource
      ) {
        throw new JournalInvariantError("observed treasury staging output does not match its immutable plan");
      }
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      if (attempt.state !== "planned") {
        throw new JournalInvariantError("treasury staging must be observed before exact payment preparation");
      }
      const reservation = this.requireReservation(input.reservationId);
      if (reservation.state !== "in_flight" || reservation.purchaseId !== effect.purchaseId) {
        throw new JournalInvariantError("observed treasury staging requires its in-flight Reservation");
      }
      if (
        !this.isVerifiedEvidenceLinked(effect.purchaseId, input.evidenceDigest, {
          attempt: effect.attempt,
          kind: TREASURY_STAGING_EVIDENCE_KIND,
          verificationProfile: input.evidenceVerificationProfile,
          verifierId: input.evidenceVerifierId,
        })
      ) {
        throw new JournalInvariantError(
          "treasury staging evidence is not verified and linked to the Payment Attempt"
        );
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO treasury_staging_observations
             (effect_id, purchase_id, attempt, reservation_id, transaction_id, outpoint,
              staging_amount_atomic, funding_source, evidence_digest,
              evidence_verification_profile, evidence_verifier_id, observed_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          effect.id,
          effect.purchaseId,
          effect.attempt,
          input.reservationId,
          input.transactionId,
          input.outpoint,
          input.stagingAmountAtomic,
          input.fundingSource,
          input.evidenceDigest,
          input.evidenceVerificationProfile,
          input.evidenceVerifierId,
          now
        );
      this.inject("treasury_staging_observation.after_insert");
      this.insertEffectObservation(
        effect.id,
        "observed",
        input.evidenceDigest,
        input.evidenceDigest,
        lease,
        now
      );
      this.updateEffectState(
        effect,
        "observed",
        "treasury_staging_output_observed",
        input.evidenceDigest,
        now,
        { resultDigest: input.evidenceDigest }
      );
      return this.findTreasuryStagingObservationByEffect(effect.id)!;
    });
    return record.immediate();
  }

  findTreasuryStagingObservation(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingObservationRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM treasury_staging_observations WHERE purchase_id = ? AND attempt = ?"
      )
      .get(purchaseId, attempt) as TreasuryStagingObservationRow | undefined;
    return row ? treasuryStagingObservationFromRow(row) : undefined;
  }

  treasuryStagingRecoveryContext(
    purchaseId: PurchaseId,
    attemptNumber: number
  ): TreasuryStagingRecoveryContext | undefined {
    const plan = this.findTreasuryStagingPlan(purchaseId, attemptNumber);
    if (!plan) return undefined;
    const effect = this.requireEffect(plan.effectId);
    const attempt = this.requirePaymentAttempt(purchaseId, attemptNumber);
    const reservation = this.requireReservation(plan.reservationId);
    const observation = this.findTreasuryStagingObservation(purchaseId, attemptNumber);
    return { plan, effect, attempt, reservation, observation };
  }

  planTreasuryStagingRecovery(
    input: PlanTreasuryStagingRecoveryInput
  ): TreasuryStagingRecoveryPlanRecord {
    validateTreasuryStagingRecoveryPlanInput(input);
    const stored = this.storePreparedMaterial(input.preparedBytes, input.payloadDigest);
    const plan = this.db.transaction(() => {
      const existingEffectRow = this.db
        .prepare("SELECT * FROM effects WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as EffectRow | undefined;
      if (existingEffectRow) {
        const existingEffect = effectFromRow(existingEffectRow);
        if (existingEffect.kind !== TREASURY_STAGING_RECOVERY_EFFECT_KIND) {
          throw new JournalInvariantError(
            "staging recovery idempotency key belongs to another Effect kind"
          );
        }
        const existing = this.findTreasuryStagingRecoveryPlanByEffect(existingEffect.id);
        if (!existing) {
          throw new JournalInvariantError("staging recovery Effect has no immutable plan");
        }
        assertSameTreasuryStagingRecoveryPlan(existing, input, stored);
        return existing;
      }
      if (this.findTreasuryStagingRecoveryPlan(input.purchaseId, input.attempt)) {
        throw new JournalInvariantError(
          "Payment Attempt already has a different staging recovery plan"
        );
      }
      const purchase = this.requirePurchase(input.purchaseId);
      if (purchase.state !== "failed_recoverable") {
        throw new JournalInvariantError(
          "staging recovery may be planned only for a recoverable Purchase"
        );
      }
      const attempt = this.requirePaymentAttempt(input.purchaseId, input.attempt);
      const staging = this.findTreasuryStagingObservation(input.purchaseId, input.attempt);
      if (!staging || staging.effectId !== input.stagingEffectId) {
        throw new JournalInvariantError(
          "staging recovery requires the exact journal-observed staging output"
        );
      }
      const stagingEffect = this.requireEffect(input.stagingEffectId);
      if (stagingEffect.state !== "observed") {
        throw new JournalInvariantError("staging recovery source is not durably observed");
      }
      const reservation = this.requireReservation(input.reservationId);
      if (
        reservation.purchaseId !== input.purchaseId ||
        reservation.state !== "in_flight" ||
        staging.reservationId !== reservation.id ||
        reservation.additionalCostCeilingAtomic !==
          input.authorizedAdditionalCostCeilingAtomic
      ) {
        throw new JournalInvariantError(
          "staging recovery is not bound to the in-flight Purchase Reservation"
        );
      }
      const preparation = this.findPaymentPreparation(input.purchaseId, input.attempt);
      if (
        (preparation?.transactionId ?? undefined) !== input.exactTransactionId ||
        (preparation === undefined && !["planned", "failed"].includes(attempt.state))
      ) {
        throw new JournalInvariantError(
          "staging recovery exact candidate differs from immutable payment preparation"
        );
      }
      if (this.findSpendForPurchase(input.purchaseId)) {
        throw new JournalInvariantError("settled Merchant payment cannot be swept");
      }
      if (
        BigInt(input.recoveryAmountAtomic) + BigInt(input.recoveryFeeAtomic) !==
        BigInt(staging.stagingAmountAtomic)
      ) {
        throw new JournalInvariantError("staging recovery does not conserve the staged value");
      }
      const now = this.timestamp();
      const effectId = opaqueId("eff");
      this.db.prepare(
        `INSERT INTO effects
           (id, purchase_id, attempt, kind, idempotency_key, state, version,
            payload_digest, prepared_ref, prepared_byte_length, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 'planned', 0, ?, ?, ?, ?, ?)`
      ).run(
        effectId,
        input.purchaseId,
        input.attempt,
        TREASURY_STAGING_RECOVERY_EFFECT_KIND,
        input.idempotencyKey,
        input.payloadDigest,
        stored.storageRef,
        stored.byteLength,
        now,
        now
      );
      this.inject("effect.after_insert");
      this.insertEffectTransition(
        effectId,
        undefined,
        "planned",
        "treasury_staging_recovery_planned",
        input.payloadDigest,
        now
      );
      this.db.prepare(
        `INSERT INTO treasury_staging_recovery_plans
           (effect_id, purchase_id, attempt, reservation_id, staging_effect_id,
            payload_digest, prepared_ref, prepared_byte_length, exact_transaction_id,
            recovery_transaction_id, recovery_outpoint, recovery_amount_atomic,
            staging_fee_atomic, recovery_fee_atomic, required_finality,
            authorized_additional_cost_ceiling_atomic, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        effectId,
        input.purchaseId,
        input.attempt,
        input.reservationId,
        input.stagingEffectId,
        input.payloadDigest,
        stored.storageRef,
        stored.byteLength,
        input.exactTransactionId ?? null,
        input.recoveryTransactionId,
        input.recoveryOutpoint,
        input.recoveryAmountAtomic,
        input.stagingFeeAtomic,
        input.recoveryFeeAtomic,
        input.requiredFinality,
        input.authorizedAdditionalCostCeilingAtomic,
        now
      );
      this.inject("treasury_staging_recovery_plan.after_insert");
      return this.requireTreasuryStagingRecoveryPlan(input.purchaseId, input.attempt);
    });
    return plan.immediate();
  }

  findTreasuryStagingRecoveryPlan(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingRecoveryPlanRecord | undefined {
    const row = this.db.prepare(
      `SELECT p.*, e.idempotency_key
         FROM treasury_staging_recovery_plans p
         JOIN effects e ON e.id = p.effect_id
        WHERE p.purchase_id = ? AND p.attempt = ?`
    ).get(purchaseId, attempt) as TreasuryStagingRecoveryPlanRow | undefined;
    return row ? treasuryStagingRecoveryPlanFromRow(row) : undefined;
  }

  requireTreasuryStagingRecoveryPlan(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingRecoveryPlanRecord {
    const plan = this.findTreasuryStagingRecoveryPlan(purchaseId, attempt);
    if (!plan) {
      throw new JournalNotFoundError(
        `Treasury staging recovery plan ${purchaseId}/${attempt} does not exist`
      );
    }
    return plan;
  }

  readPreparedTreasuryStagingRecovery(purchaseId: PurchaseId, attempt: number): Buffer {
    const plan = this.requireTreasuryStagingRecoveryPlan(purchaseId, attempt);
    return this.readPreparedMaterial(
      plan.payloadDigest,
      plan.preparedRef,
      plan.preparedByteLength
    );
  }

  treasuryStagingRecoveryJournalContext(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingRecoveryJournalContext | undefined {
    const plan = this.findTreasuryStagingRecoveryPlan(purchaseId, attempt);
    if (!plan) return undefined;
    const staging = this.findTreasuryStagingObservation(purchaseId, attempt);
    if (!staging) {
      throw new JournalInvariantError("staging recovery lost its observed source output");
    }
    return {
      plan,
      effect: this.requireEffect(plan.effectId),
      attempt: this.requirePaymentAttempt(purchaseId, attempt),
      reservation: this.requireReservation(plan.reservationId),
      staging,
      observations: this.treasuryStagingRecoveryObservations(plan.effectId),
      accounting: this.findTreasuryStagingRecoveryAccounting(plan.effectId),
    };
  }

  beginTreasuryStagingRecovery(
    effectId: string,
    holder: string,
    ttlMs: number
  ): EffectClaim | undefined {
    const begin = this.db.transaction(() => {
      const effect = this.requireEffect(effectId);
      if (
        effect.kind !== TREASURY_STAGING_RECOVERY_EFFECT_KIND ||
        effect.attempt === undefined
      ) {
        throw new JournalInvariantError(
          "staging recovery claim requires its dedicated attempt-bound Effect"
        );
      }
      const plan = this.requireTreasuryStagingRecoveryPlan(
        effect.purchaseId,
        effect.attempt
      );
      if (
        plan.effectId !== effect.id ||
        effect.payloadDigest !== plan.payloadDigest ||
        effect.preparedRef !== plan.preparedRef ||
        effect.preparedByteLength !== plan.preparedByteLength
      ) {
        throw new JournalInvariantError(
          "staging recovery Effect is not bound to its immutable plan"
        );
      }
      this.readPreparedMaterial(
        plan.payloadDigest,
        plan.preparedRef,
        plan.preparedByteLength
      );
      const reservation = this.requireReservation(plan.reservationId);
      if (reservation.state !== "in_flight") {
        throw new JournalInvariantError(
          "staging recovery requires its original in-flight Reservation"
        );
      }
      if (
        BigInt(plan.stagingFeeAtomic) + BigInt(plan.recoveryFeeAtomic) >
        BigInt(plan.authorizedAdditionalCostCeilingAtomic)
      ) {
        throw new PolicyReservationError(
          "staging recovery fee exceeds the still-authorized additional-cost ceiling; explicit operator authority is required"
        );
      }
      if (effect.state !== "planned" && effect.state !== "retryable") {
        return undefined;
      }
      return this.claimEffectInternal(effect, holder, ttlMs);
    });
    return begin.immediate();
  }

  recordTreasuryStagingRecoveryObservation(
    effectId: string,
    lease: LeaseToken,
    input: RecordTreasuryStagingRecoveryObservationInput
  ): TreasuryStagingRecoveryJournalContext {
    validateTreasuryStagingRecoveryObservationInput(input);
    const record = this.db.transaction(() => {
      this.assertEffectWriter(effectId, lease);
      let effect = this.requireEffect(effectId);
      if (
        effect.kind !== TREASURY_STAGING_RECOVERY_EFFECT_KIND ||
        effect.attempt === undefined
      ) {
        throw new JournalInvariantError(
          "staging recovery observation requires its dedicated Effect"
        );
      }
      const plan = this.requireTreasuryStagingRecoveryPlan(
        effect.purchaseId,
        effect.attempt
      );
      const now = this.timestamp();
      this.db.prepare(
        `INSERT OR IGNORE INTO treasury_staging_recovery_observations
           (effect_id, status, evidence_digest, readiness_proof_digest,
            readiness_observed_at_ms, readiness_expires_at_ms,
            winning_transaction_id, winning_finality, recovery_outpoint,
            recovery_amount_atomic, conflict_reason, lease_name,
            lease_generation, observed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        effectId,
        input.status,
        input.evidenceDigest,
        input.readinessProofDigest ?? null,
        input.readinessObservedAtMs ?? null,
        input.readinessExpiresAtMs ?? null,
        input.winningTransactionId ?? null,
        input.winningFinality ?? null,
        input.recoveryOutpoint ?? null,
        input.recoveryAmountAtomic ?? null,
        input.conflictReason ?? null,
        lease.name,
        lease.generation,
        now
      );
      this.inject("treasury_staging_recovery_observation.after_insert");

      if (input.status === "safe_to_submit") {
        if (
          lease.name.startsWith("purchase-reconciliation") &&
          ["executing", "submitted", "ambiguous"].includes(effect.state)
        ) {
          this.insertEffectObservation(
            effect.id,
            "not_found_retryable",
            undefined,
            input.evidenceDigest,
            lease,
            now
          );
          this.updateEffectState(
            effect,
            "retryable",
            "observation_not_found_retryable",
            input.evidenceDigest,
            now
          );
        }
      } else if (input.status === "exact_payment_won") {
        if (!plan.exactTransactionId || input.winningTransactionId !== plan.exactTransactionId || !input.winningFinality) {
          throw new JournalInvariantError("staging recovery observed a different exact winner");
        }
        if (paymentFinalityMeets(input.winningFinality, plan.requiredFinality)) {
          this.insertEffectObservation(effect.id, "observed", input.evidenceDigest, input.evidenceDigest, lease, now);
          this.updateEffectState(effect, "observed", "exact_payment_won_staging_race", input.evidenceDigest, now, { resultDigest: input.evidenceDigest });
        } else if (["executing", "submitted", "ambiguous"].includes(effect.state)) {
          this.insertEffectObservation(effect.id, "pending", undefined, input.evidenceDigest, lease, now);
          if (effect.state !== "ambiguous") {
            this.updateEffectState(effect, "ambiguous", "exact_payment_waiting_for_finality", input.evidenceDigest, now);
          }
        }
      } else if (input.status === "recovery_won") {
        if (
          input.winningTransactionId !== plan.recoveryTransactionId ||
          input.recoveryOutpoint !== plan.recoveryOutpoint ||
          input.recoveryAmountAtomic !== plan.recoveryAmountAtomic ||
          !input.winningFinality
        ) {
          throw new JournalInvariantError("staging recovery winner differs from its immutable plan");
        }
        if (paymentFinalityMeets(input.winningFinality, plan.requiredFinality)) {
          this.finalizeTreasuryStagingRecoveryInternal(plan, effect, lease, input, now);
        } else if (["executing", "submitted", "ambiguous"].includes(effect.state)) {
          this.insertEffectObservation(
            effect.id,
            "pending",
            undefined,
            input.evidenceDigest,
            lease,
            now
          );
          if (effect.state !== "ambiguous") {
            this.updateEffectState(
              effect,
              "ambiguous",
              "staging_recovery_waiting_for_finality",
              input.evidenceDigest,
              now
            );
          }
        }
      } else if (input.status === "conflict") {
        if (effect.state !== "ambiguous") {
          this.insertEffectObservation(
            effect.id,
            "conflict",
            undefined,
            input.evidenceDigest,
            lease,
            now
          );
          this.updateEffectState(
            effect,
            "ambiguous",
            "staging_recovery_requires_reobservation",
            input.evidenceDigest,
            now
          );
        }
      } else if (
        input.status === "pending" &&
        ["executing", "submitted"].includes(effect.state)
      ) {
        this.insertEffectObservation(
          effect.id,
          "pending",
          undefined,
          input.evidenceDigest,
          lease,
          now
        );
        this.updateEffectState(
          effect,
          "ambiguous",
          "staging_recovery_pending",
          input.evidenceDigest,
          now
        );
      }
      return this.treasuryStagingRecoveryJournalContext(
        effect.purchaseId,
        effect.attempt
      )!;
    });
    return record.immediate();
  }

  treasuryStagingRecoveryObservations(
    effectId: string
  ): TreasuryStagingRecoveryObservationRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM treasury_staging_recovery_observations
        WHERE effect_id = ? ORDER BY sequence`
    ).all(effectId) as TreasuryStagingRecoveryObservationRow[];
    return rows.map(treasuryStagingRecoveryObservationFromRow);
  }

  preparePaymentAttempt(input: PreparePaymentAttemptInput): PaymentPreparationRecord {
    validatePaymentPreparation(input);
    const stored = this.storePreparedMaterial(input.preparedBytes, input.payloadDigest);
    const prepare = this.db.transaction(() => {
      const attempt = this.requirePaymentAttempt(input.purchaseId, input.attempt);
      const existing = this.findPaymentPreparation(input.purchaseId, input.attempt);
      if (existing) {
        assertSamePreparation(existing, input, stored);
        return existing;
      }
      if (attempt.state !== "planned") {
        throw new JournalInvariantError(`Payment Attempt cannot prepare from ${attempt.state}`);
      }
      const reservation = this.requireReservation(input.reservationId);
      const stagingPlan = this.findTreasuryStagingPlan(input.purchaseId, input.attempt);
      const stagingObservation = this.findTreasuryStagingObservation(input.purchaseId, input.attempt);
      const directReservation = reservation.state === "active" && !stagingPlan && !stagingObservation;
      const stagedReservation =
        reservation.state === "in_flight" &&
        stagingPlan?.reservationId === reservation.id &&
        stagingObservation?.effectId === stagingPlan.effectId &&
        this.requireEffect(stagingPlan.effectId).state === "observed" &&
        this.isVerifiedEvidenceLinked(input.purchaseId, stagingObservation.evidenceDigest, {
          attempt: input.attempt,
          kind: TREASURY_STAGING_EVIDENCE_KIND,
          verificationProfile: stagingObservation.evidenceVerificationProfile,
          verifierId: stagingObservation.evidenceVerifierId,
        });
      if (reservation.purchaseId !== input.purchaseId || (!directReservation && !stagedReservation)) {
        throw new JournalInvariantError(
          "Payment preparation requires an active Reservation or its verified staged output"
        );
      }
      if (reservation.amountAtomic !== input.amountAtomic || reservation.payee !== input.payee) {
        throw new JournalInvariantError("payment preparation does not match its Treasury Reservation");
      }
      if (directReservation && reservation.expiresAtMs <= this.timestamp()) {
        throw new PolicyReservationError("Treasury Reservation expired before payment preparation");
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO payment_preparations
             (purchase_id, attempt, reservation_id, requirements_digest, payload_digest,
              prepared_ref, prepared_byte_length, transaction_id, amount_atomic, asset,
              network, payee, required_finality, funding_source, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.purchaseId,
          input.attempt,
          input.reservationId,
          input.requirementsDigest,
          input.payloadDigest,
          stored.storageRef,
          stored.byteLength,
          input.transactionId,
          input.amountAtomic,
          input.asset,
          input.network,
          input.payee,
          input.requiredFinality,
          input.fundingSource,
          now
        );
      this.inject("payment_preparation.after_insert");
      this.transitionAttemptInternal(attempt, "prepared", "payment_prepared", input.payloadDigest, now);
      return this.requirePaymentPreparation(input.purchaseId, input.attempt);
    });
    return prepare.immediate();
  }

  requirePaymentPreparation(purchaseId: PurchaseId, attempt: number): PaymentPreparationRecord {
    const preparation = this.findPaymentPreparation(purchaseId, attempt);
    if (!preparation) throw new JournalNotFoundError(`Payment preparation ${purchaseId}/${attempt} does not exist`);
    return preparation;
  }

  readPreparedPayment(purchaseId: PurchaseId, attempt: number): Buffer {
    const preparation = this.requirePaymentPreparation(purchaseId, attempt);
    return this.readPreparedMaterial(
      preparation.payloadDigest,
      preparation.preparedRef,
      preparation.preparedByteLength
    );
  }

  failPaymentAttempt(
    purchaseId: PurchaseId,
    attemptNumber: number,
    expectedState: "planned" | "prepared",
    failureCode: string,
    detailDigest?: Sha256Digest
  ): PaymentAttemptRecord {
    if (expectedState !== "planned" && expectedState !== "prepared") {
      throw new JournalInvariantError("submitted Payment Attempts may fail only through proof-backed reconciliation");
    }
    assertCode(failureCode, "Payment Attempt failure code");
    if (detailDigest) assertDigest(detailDigest, "Payment Attempt failure detail digest");
    const fail = this.db.transaction(() => {
      const attempt = this.requirePaymentAttempt(purchaseId, attemptNumber);
      if (attempt.state === "failed") {
        if (attempt.failureCode !== failureCode) throw new JournalInvariantError("conflicting Payment Attempt failure");
        return attempt;
      }
      if (attempt.state !== expectedState) {
        throw new JournalInvariantError(`Payment Attempt expected ${expectedState}, found ${attempt.state}`);
      }
      const now = this.timestamp();
      this.transitionAttemptInternal(attempt, "failed", failureCode, detailDigest, now, failureCode);
      return this.requirePaymentAttempt(purchaseId, attemptNumber);
    });
    return fail.immediate();
  }

  planEffect(input: PlanEffectInput): EffectRecord {
    validateEffectInput(input);
    if (input.kind === TREASURY_STAGING_EFFECT_KIND) {
      throw new JournalInvariantError("treasury staging Effects require planTreasuryStaging");
    }
    const stored = this.storePreparedMaterial(input.preparedBytes, input.payloadDigest);
    const plan = this.db.transaction(() => {
      this.requirePurchase(input.purchaseId);
      if (input.attempt !== undefined) this.requirePaymentAttempt(input.purchaseId, input.attempt);
      const existing = this.db
        .prepare("SELECT * FROM effects WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as EffectRow | undefined;
      if (existing) {
        const record = effectFromRow(existing);
        assertSameEffect(record, input, stored);
        return record;
      }
      const now = this.timestamp();
      const id = opaqueId("eff");
      this.db
        .prepare(
          `INSERT INTO effects
             (id, purchase_id, attempt, kind, idempotency_key, state, version,
              payload_digest, prepared_ref, prepared_byte_length, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 'planned', 0, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.purchaseId,
          input.attempt ?? null,
          input.kind,
          input.idempotencyKey,
          input.payloadDigest,
          stored.storageRef,
          stored.byteLength,
          now,
          now
        );
      this.inject("effect.after_insert");
      this.insertEffectTransition(id, undefined, "planned", "effect_planned", input.payloadDigest, now);
      return this.requireEffect(id);
    });
    return plan.immediate();
  }

  claimEffect(id: string, holder: string, ttlMs: number): EffectClaim | undefined {
    const claim = this.db.transaction(() => {
      const effect = this.requireEffect(id);
      if (effect.attempt !== undefined) {
        throw new JournalInvariantError("Payment effects must use beginPaymentSubmission so reservation fencing is atomic");
      }
      return this.claimEffectInternal(effect, holder, ttlMs);
    });
    return claim.immediate();
  }

  beginPaymentSubmission(effectId: string, reservationId: string, holder: string, ttlMs: number): EffectClaim | undefined {
    const begin = this.db.transaction(() => {
      const effect = this.requireEffect(effectId);
      if (effect.attempt === undefined) throw new JournalInvariantError("payment effect must identify a Payment Attempt");
      if (effect.kind === TREASURY_STAGING_EFFECT_KIND) {
        throw new JournalInvariantError("treasury staging Effects must use beginTreasuryStaging");
      }
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      const preparation = this.requirePaymentPreparation(effect.purchaseId, effect.attempt);
      this.readPreparedMaterial(
        preparation.payloadDigest,
        preparation.preparedRef,
        preparation.preparedByteLength
      );
      this.readPreparedMaterial(effect.payloadDigest, effect.preparedRef, effect.preparedByteLength);
      if (preparation.reservationId !== reservationId) {
        throw new JournalInvariantError("payment effect and Treasury Reservation are not bound to the same preparation");
      }
      const reservation = this.requireReservation(reservationId);
      if (reservation.purchaseId !== effect.purchaseId) {
        throw new JournalInvariantError("payment effect and Treasury Reservation belong to different Purchases");
      }
      if (
        effect.payloadDigest !== preparation.payloadDigest ||
        effect.preparedRef !== preparation.preparedRef
      ) {
        throw new JournalInvariantError("payment effect does not reference the immutable payment preparation");
      }
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      if (effect.state === "planned") {
        const stagingPlan = this.findTreasuryStagingPlan(effect.purchaseId, effect.attempt);
        const stagingObservation = this.findTreasuryStagingObservation(effect.purchaseId, effect.attempt);
        const directReservation = reservation.state === "active" && !stagingPlan && !stagingObservation;
        const stagedReservation =
          reservation.state === "in_flight" &&
          stagingPlan?.reservationId === reservation.id &&
          stagingObservation?.effectId === stagingPlan.effectId &&
          this.requireEffect(stagingPlan.effectId).state === "observed" &&
          this.isVerifiedEvidenceLinked(effect.purchaseId, stagingObservation.evidenceDigest, {
            attempt: effect.attempt,
            kind: TREASURY_STAGING_EVIDENCE_KIND,
            verificationProfile: stagingObservation.evidenceVerificationProfile,
            verifierId: stagingObservation.evidenceVerifierId,
          });
        if (attempt.state !== "prepared" || (!directReservation && !stagedReservation)) {
          throw new JournalInvariantError(
            "first payment submission requires a prepared Attempt and usable Reservation"
          );
        }
        if (directReservation && reservation.expiresAtMs <= now) {
          throw new PolicyReservationError("reservation expired before submission");
        }
        if (
          directReservation &&
          reservation.policyDigest !== this.requireActivePolicy().digest
        ) {
          throw new PolicyReservationError("active treasury policy changed before payment submission");
        }
      } else if (effect.state === "retryable") {
        if (attempt.state !== "submitted" || reservation.state !== "in_flight") {
          throw new JournalInvariantError("retry requires the original submitted Attempt and in-flight Reservation");
        }
      }
      const claimed = this.claimEffectInternal(effect, holder, ttlMs);
      if (!claimed) return undefined;
      if (reservation.state === "active") {
        const moved = this.db
          .prepare(
            `UPDATE treasury_reservations
             SET state = 'in_flight', in_flight_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND state = 'active'`
          )
          .run(now, now, reservationId);
        if (moved.changes !== 1) throw new JournalInvariantError("concurrent Treasury Reservation submission");
      }
      if (attempt.state === "prepared") {
        this.transitionAttemptInternal(attempt, "submitted", "payment_submission_claimed", effect.payloadDigest, now);
      }
      return { effect: this.requireEffect(effectId), lease: claimed.lease };
    });
    return begin.immediate();
  }

  abandonExpiredPreparedPayment(effectId: string, reservationId: string): PurchaseRecord {
    const abandon = this.db.transaction(() => {
      const effect = this.requireEffect(effectId);
      if (effect.attempt === undefined) {
        throw new JournalInvariantError("expired prepared payment must identify a Payment Attempt");
      }
      const purchase = this.requirePurchase(effect.purchaseId);
      const preparation = this.requirePaymentPreparation(effect.purchaseId, effect.attempt);
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      this.expireReservationsInternal(this.timestamp());
      const reservation = this.requireReservation(reservationId);
      if (
        purchase.state !== "execution_prepared" ||
        effect.state !== "planned" ||
        attempt.state !== "prepared" ||
        preparation.reservationId !== reservationId ||
        reservation.state !== "expired"
      ) {
        throw new JournalInvariantError("only a never-claimed payment with an expired Reservation can be abandoned");
      }
      const now = this.timestamp();
      const reason = "reservation_expired_before_submission";
      this.transitionAttemptInternal(
        attempt,
        "failed",
        reason,
        reservation.policyDigest,
        now,
        reason
      );
      this.updateEffectState(effect, "abandoned", reason, reservation.policyDigest, now, {
        errorCode: reason,
      });
      return this.transitionPurchase(
        purchase.id,
        "execution_prepared",
        "expired",
        reason,
        reservation.policyDigest
      );
    });
    return abandon.immediate();
  }

  abandonExpiredTreasuryStaging(effectId: string, reservationId: string): PurchaseRecord {
    const abandon = this.db.transaction(() => {
      const effect = this.requireEffect(effectId);
      if (
        effect.kind !== TREASURY_STAGING_EFFECT_KIND ||
        effect.attempt === undefined
      ) {
        throw new JournalInvariantError(
          "expired treasury staging must identify its dedicated Payment Attempt"
        );
      }
      const purchase = this.requirePurchase(effect.purchaseId);
      const plan = this.requireTreasuryStagingPlan(effect.purchaseId, effect.attempt);
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      this.expireReservationsInternal(this.timestamp());
      const reservation = this.requireReservation(reservationId);
      if (
        purchase.state !== "execution_prepared" ||
        plan.effectId !== effect.id ||
        plan.reservationId !== reservationId ||
        effect.state !== "planned" ||
        attempt.state !== "planned" ||
        reservation.state !== "expired"
      ) {
        throw new JournalInvariantError(
          "only never-claimed treasury staging with an expired Reservation can be abandoned"
        );
      }
      const now = this.timestamp();
      const reason = "reservation_expired_before_treasury_staging";
      this.transitionAttemptInternal(
        attempt,
        "failed",
        reason,
        reservation.policyDigest,
        now,
        reason
      );
      this.updateEffectState(effect, "abandoned", reason, reservation.policyDigest, now, {
        errorCode: reason,
      });
      return this.transitionPurchase(
        purchase.id,
        "execution_prepared",
        "expired",
        reason,
        reservation.policyDigest
      );
    });
    return abandon.immediate();
  }

  markEffectSubmitted(claim: EffectClaim, submissionDigest: Sha256Digest): EffectRecord {
    assertDigest(submissionDigest, "effect submission digest");
    return this.transitionClaimedEffect(
      claim,
      "executing",
      "submitted",
      "effect_submission_acknowledged",
      submissionDigest,
      { submissionDigest }
    );
  }

  markEffectAmbiguous(claim: EffectClaim, detailDigest?: Sha256Digest): EffectRecord {
    if (detailDigest) assertDigest(detailDigest, "effect ambiguity detail digest");
    const ambiguous = this.db.transaction(() => {
      this.assertEffectWriter(claim.effect.id, claim.lease);
      const current = this.requireEffect(claim.effect.id);
      if (current.state === "ambiguous") return current;
      if (current.state !== "executing" && current.state !== "submitted") {
        throw new JournalInvariantError(`Effect ${current.id} cannot become ambiguous from ${current.state}`);
      }
      const now = this.timestamp();
      this.updateEffectState(current, "ambiguous", "execution_ambiguous", detailDigest, now);
      this.insertEffectObservation(current.id, "pending", undefined, detailDigest, claim.lease, now);
      return this.requireEffect(current.id);
    });
    return ambiguous.immediate();
  }

  recordEffectObservation(effectId: string, lease: LeaseToken, observation: EffectObservation): EffectRecord {
    validateObservation(observation);
    const record = this.db.transaction(() => {
      this.assertEffectWriter(effectId, lease);
      const effect = this.requireEffect(effectId);
      if (observation.status === "observed" && effect.attempt !== undefined) {
        throw new JournalInvariantError("payment effects must be finalized with recordObservedSpend");
      }
      if (effect.state === "observed") {
        if (observation.status !== "observed" || effect.resultDigest !== observation.resultDigest) {
          throw new JournalInvariantError(`conflicting observation for already-observed Effect ${effectId}`);
        }
        return effect;
      }
      if (effect.state === "failed_terminal") {
        throw new JournalInvariantError(`terminal Effect ${effectId} cannot accept another observation`);
      }
      if (effect.state === "planned" || effect.state === "retryable") {
        throw new JournalInvariantError(`Effect ${effectId} has no ambiguous execution to observe from ${effect.state}`);
      }
      const now = this.timestamp();
      const mapped = mapObservation(observation);
      this.insertEffectObservation(
        effectId,
        mapped.status,
        mapped.resultDigest,
        mapped.detailDigest,
        lease,
        now
      );
      this.updateEffectState(
        effect,
        mapped.nextState,
        `observation_${mapped.status}`,
        mapped.detailDigest ?? mapped.resultDigest,
        now,
        {
          resultDigest: mapped.resultDigest,
          errorCode: mapped.errorCode,
        }
      );
      return this.requireEffect(effectId);
    });
    return record.immediate();
  }

  recordObservedSpend(
    lease: LeaseToken,
    input: RecordObservedSpendInput
  ): TreasurySpendRecord {
    validateSpendInput(input);
    const record = this.db.transaction(() => {
      this.assertEffectWriter(input.effectId, lease);
      const effect = this.requireEffect(input.effectId);
      if (effect.attempt === undefined) throw new JournalInvariantError("observed spend requires a payment effect");
      const existing = this.findSpend(input.reservationId);
      if (existing) {
        assertSameSpend(existing, input);
        if (effect.state !== "observed" || effect.resultDigest !== input.evidenceDigest) {
          throw new JournalInvariantError("spend exists but effect observation conflicts");
        }
        return existing;
      }
      if (effect.state !== "executing" && effect.state !== "submitted" && effect.state !== "ambiguous") {
        throw new JournalInvariantError(`Effect ${effect.id} cannot record spend from ${effect.state}`);
      }
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      if (attempt.state !== "submitted") throw new JournalInvariantError("observed spend requires submitted Payment Attempt");
      const preparation = this.requirePaymentPreparation(effect.purchaseId, effect.attempt);
      if (
        preparation.reservationId !== input.reservationId ||
        preparation.transactionId !== input.transactionId ||
        preparation.amountAtomic !== input.actualAmountAtomic ||
        preparation.asset !== input.asset ||
        preparation.payee !== input.payee ||
        preparation.network !== input.network ||
        !paymentFinalityMeets(input.finality, preparation.requiredFinality) ||
        preparation.fundingSource !== input.fundingSource
      ) {
        throw new JournalInvariantError("observed spend does not match immutable payment preparation");
      }
      const reservation = this.requireReservation(input.reservationId);
      if (reservation.state !== "in_flight") {
        throw new JournalInvariantError(`observed spend requires in-flight Reservation, found ${reservation.state}`);
      }
      const amount = decimalBigInt(input.actualAmountAtomic, "actual spend amount");
      const additionalCost = decimalBigInt(
        input.actualAdditionalCostAtomic,
        "actual additional treasury cost",
        true
      );
      if (
        amount !== BigInt(reservation.amountAtomic) ||
        additionalCost > BigInt(reservation.additionalCostCeilingAtomic)
      ) {
        throw new PolicyReservationError("observed spend exceeds its Treasury Reservation");
      }
      if (
        !this.isVerifiedEvidenceLinked(effect.purchaseId, input.evidenceDigest, {
          attempt: effect.attempt,
          kind: "kaspa-settlement",
          verificationProfile: input.evidenceVerificationProfile,
          verifierId: input.evidenceVerifierId,
        })
      ) {
        throw new JournalInvariantError("settlement evidence is not verified and linked to the Payment Attempt");
      }
      const now = this.timestamp();
      const inserted = this.db
        .prepare(
          `INSERT INTO treasury_spends
             (effect_id, reservation_id, purchase_id, attempt, transaction_id, outpoint,
              actual_amount_atomic, actual_additional_cost_atomic, asset, payee, network, finality,
              funding_source, evidence_digest, evidence_verification_profile,
              evidence_verifier_id, observed_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.effectId,
          input.reservationId,
          effect.purchaseId,
          effect.attempt,
          input.transactionId,
          input.outpoint ?? null,
          input.actualAmountAtomic,
          input.actualAdditionalCostAtomic,
          input.asset,
          input.payee,
          input.network,
          input.finality,
          input.fundingSource,
          input.evidenceDigest,
          input.evidenceVerificationProfile,
          input.evidenceVerifierId,
          now
        );
      this.inject("spend.after_insert");
      const reservationUpdate = this.db
        .prepare(
          `UPDATE treasury_reservations
           SET state = 'spent', spent_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND state = 'in_flight'`
        )
        .run(now, now, input.reservationId);
      if (reservationUpdate.changes !== 1) throw new JournalInvariantError("concurrent spend finalization");
      this.transitionAttemptInternal(attempt, "observed", "settlement_observed", input.evidenceDigest, now);
      this.insertEffectObservation(
        effect.id,
        "observed",
        input.evidenceDigest,
        input.evidenceDigest,
        lease,
        now
      );
      this.updateEffectState(
        effect,
        "observed",
        "settlement_spend_observed",
        input.evidenceDigest,
        now,
        { resultDigest: input.evidenceDigest }
      );
      return {
        id: Number(inserted.lastInsertRowid),
        ...input,
        purchaseId: effect.purchaseId,
        attempt: effect.attempt,
        observedAtMs: now,
      };
    });
    return record.immediate();
  }

  recordFulfilment(
    purchaseId: PurchaseId,
    input: RecordFulfilmentInput,
    receipts: readonly RecordReceiptInput[] = []
  ): FulfilmentRecord {
    validateFulfilmentInput(input);
    for (const receipt of receipts) validateReceiptInput(receipt);
    const record = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      const existing = this.findFulfilment(purchaseId);
      if (existing) {
        assertSameFulfilment(existing, input);
        for (const receipt of receipts) this.recordReceipt(purchaseId, receipt);
        return existing;
      }
      if (purchase.state !== "settled") {
        throw new JournalInvariantError(`Fulfilment cannot be recorded from Purchase state ${purchase.state}`);
      }
      const terms = this.requireCheckoutTerms(purchaseId);
      if (input.resourceFingerprint !== terms.resourceFingerprint) {
        throw new JournalInvariantError("Fulfilment resource does not match Checkout Terms");
      }
      const attempt = this.requirePaymentAttempt(purchaseId, input.attempt);
      if (attempt.state !== "observed") {
        throw new JournalInvariantError("Fulfilment requires an observed Payment Attempt");
      }
      const body = this.requireEvidenceAttachment(
        purchaseId,
        input.bodyDigest,
        "fulfilment-body",
        input.attempt
      );
      if (body.byteLength !== input.bodyByteLength || body.mediaType !== input.mediaType) {
        throw new JournalInvariantError("Fulfilment body metadata does not match immutable evidence");
      }
      if (!this.evidenceLinked(purchaseId, input.bodyDigest, "fulfilment-body", input.attempt)) {
        throw new JournalInvariantError("Fulfilment body is not linked to this Payment Attempt");
      }
      if (
        !this.isVerifiedEvidenceLinked(purchaseId, input.merchantEvidenceDigest, {
          attempt: input.attempt,
          kind: "merchant-fulfilment",
          verificationProfile: input.merchantVerificationProfile,
          verifierId: input.merchantVerifierId,
        })
      ) {
        throw new JournalInvariantError("Merchant Fulfilment evidence is not verified and linked");
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO fulfilments (
             purchase_id, attempt, http_status, resource_fingerprint, body_digest,
             body_byte_length, media_type, merchant_evidence_digest,
             merchant_verification_profile, merchant_verifier_id, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          purchaseId,
          input.attempt,
          input.httpStatus,
          input.resourceFingerprint,
          input.bodyDigest,
          input.bodyByteLength,
          input.mediaType,
          input.merchantEvidenceDigest,
          input.merchantVerificationProfile,
          input.merchantVerifierId,
          now
        );
      this.inject("fulfilment.after_insert");
      this.transitionPurchase(purchaseId, "settled", "fulfilled", "merchant_fulfilment_verified", input.bodyDigest);
      const fulfilment = this.requireFulfilment(purchaseId);
      for (const receipt of receipts) this.recordReceipt(purchaseId, receipt);
      return fulfilment;
    });
    return record.immediate();
  }

  requireFulfilment(purchaseId: PurchaseId): FulfilmentRecord {
    const fulfilment = this.findFulfilment(purchaseId);
    if (!fulfilment) throw new JournalNotFoundError(`Purchase ${purchaseId} has no Fulfilment`);
    return fulfilment;
  }

  findFulfilment(purchaseId: PurchaseId): FulfilmentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM fulfilments WHERE purchase_id = ?").get(purchaseId) as
      | FulfilmentRow
      | undefined;
    return row ? fulfilmentFromRow(row) : undefined;
  }

  recordReceipt(purchaseId: PurchaseId, input: RecordReceiptInput): ReceiptRecord {
    validateReceiptInput(input);
    const record = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      if (purchase.state !== "fulfilled" && purchase.state !== "receipted") {
        throw new JournalInvariantError(`Receipt cannot be recorded from Purchase state ${purchase.state}`);
      }
      const terms = this.requireCheckoutTerms(purchaseId);
      const authorization = this.requireAuthorization(purchaseId);
      const fulfilment = this.requireFulfilment(purchaseId);
      const spend = this.findSpendForPurchase(purchaseId);
      if (!spend) throw new JournalInvariantError("Receipt requires verified Settlement");
      if (
        input.checkoutDigest !== terms.checkoutDigest ||
        input.authorizationEvidenceDigest !== authorization.evidenceDigest ||
        input.settlementEvidenceDigest !== spend.evidenceDigest ||
        input.fulfilmentDigest !== fulfilment.bodyDigest
      ) {
        throw new JournalInvariantError("Receipt does not join the canonical Purchase facts");
      }
      if (
        !this.isVerifiedEvidenceLinked(purchaseId, input.evidenceDigest, {
          attempt: null,
          kind: "purchase-receipt",
          verificationProfile: input.profile,
          verifierId: input.verifierId,
        })
      ) {
        throw new JournalInvariantError("Receipt evidence is not verified and linked to this Purchase");
      }
      const canonicalDigest = canonicalReceiptDigest(
        purchaseId,
        fulfilment.attempt,
        this.requirePaymentAttempt(purchaseId, fulfilment.attempt).identifier,
        input
      );
      const existing = this.db
        .prepare("SELECT * FROM purchase_receipts WHERE purchase_id = ? AND role = ?")
        .get(purchaseId, input.role) as ReceiptRow | undefined;
      let receipt: ReceiptRecord;
      if (existing) {
        receipt = receiptFromRow(existing);
        assertSameReceipt(receipt, input, canonicalDigest);
      } else {
        const now = this.timestamp();
        const inserted = this.db
          .prepare(
            `INSERT INTO purchase_receipts (
               purchase_id, role, canonical_digest, evidence_digest, profile, issuer, verifier_id,
               checkout_digest, authorization_evidence_digest, settlement_evidence_digest,
               fulfilment_digest, created_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            purchaseId,
            input.role,
            canonicalDigest,
            input.evidenceDigest,
            input.profile,
            input.issuer ?? null,
            input.verifierId,
            input.checkoutDigest,
            input.authorizationEvidenceDigest,
            input.settlementEvidenceDigest,
            input.fulfilmentDigest,
            now
          );
        this.inject("receipt.after_insert");
        receipt = {
          id: Number(inserted.lastInsertRowid),
          purchaseId,
          ...input,
          canonicalDigest,
          createdAtMs: now,
        };
      }
      this.completeReceiptSetIfSatisfied(purchaseId);
      return receipt;
    });
    return record.immediate();
  }

  receipts(purchaseId: PurchaseId): ReceiptRecord[] {
    this.requirePurchase(purchaseId);
    const rows = this.db
      .prepare("SELECT * FROM purchase_receipts WHERE purchase_id = ? ORDER BY role, id")
      .all(purchaseId) as ReceiptRow[];
    return rows.map(receiptFromRow);
  }

  findReceiptSet(purchaseId: PurchaseId): ReceiptSetRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM purchase_receipt_sets WHERE purchase_id = ?")
      .get(purchaseId) as ReceiptSetRow | undefined;
    return row ? receiptSetFromRow(row) : undefined;
  }

  private completeReceiptSetIfSatisfied(purchaseId: PurchaseId): ReceiptSetRecord | undefined {
    const receipts = this.receipts(purchaseId);
    if (receipts.length < PURCHASE_RECEIPT_REQUIREMENTS.length) return undefined;
    if (receipts.length !== PURCHASE_RECEIPT_REQUIREMENTS.length) {
      throw new JournalInvariantError("Receipt set contains an unsupported canonical role");
    }
    for (const requirement of PURCHASE_RECEIPT_REQUIREMENTS) {
      const receipt = receipts.find((candidate) => candidate.role === requirement.role);
      if (!receipt || receipt.profile !== requirement.profile) {
        throw new JournalInvariantError(`Receipt set is missing required ${requirement.role} evidence`);
      }
    }
    const fulfilment = this.requireFulfilment(purchaseId);
    const attempt = this.requirePaymentAttempt(purchaseId, fulfilment.attempt);
    const canonicalDigest = canonicalReceiptSetDigest(
      purchaseId,
      fulfilment.attempt,
      attempt.identifier,
      receipts
    );
    const existing = this.findReceiptSet(purchaseId);
    if (existing) {
      if (
        existing.profile !== PURCHASE_RECEIPT_SET_PROFILE ||
        existing.canonicalDigest !== canonicalDigest
      ) {
        throw new JournalInvariantError("immutable Receipt set conflict");
      }
      return existing;
    }
    const now = this.timestamp();
    this.db.prepare(
      `INSERT INTO purchase_receipt_sets
         (purchase_id, profile, canonical_digest, completed_at_ms)
       VALUES (?, ?, ?, ?)`
    ).run(purchaseId, PURCHASE_RECEIPT_SET_PROFILE, canonicalDigest, now);
    const purchase = this.requirePurchase(purchaseId);
    if (purchase.state === "fulfilled") {
      this.transitionPurchase(
        purchaseId,
        "fulfilled",
        "receipted",
        "canonical_receipt_set_complete",
        canonicalDigest
      );
    }
    return this.findReceiptSet(purchaseId)!;
  }

  paymentAttempts(purchaseId: PurchaseId): PaymentAttemptRecord[] {
    this.requirePurchase(purchaseId);
    return (
      this.db
        .prepare("SELECT * FROM payment_attempts WHERE purchase_id = ? ORDER BY attempt")
        .all(purchaseId) as PaymentAttemptRow[]
    ).map(paymentAttemptFromRow);
  }

  findReservationForPurchase(purchaseId: PurchaseId): PolicyReservationRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM treasury_reservations
         WHERE purchase_id = ?
         ORDER BY CASE state
           WHEN 'spent' THEN 0 WHEN 'in_flight' THEN 1 WHEN 'active' THEN 2
           WHEN 'released' THEN 3 ELSE 4 END, created_at_ms DESC
         LIMIT 1`
      )
      .get(purchaseId) as ReservationRow | undefined;
    return row ? reservationFromRow(row) : undefined;
  }

  effectsForPurchase(purchaseId: PurchaseId): EffectRecord[] {
    this.requirePurchase(purchaseId);
    return (
      this.db.prepare("SELECT * FROM effects WHERE purchase_id = ? ORDER BY created_at_ms, id").all(purchaseId) as EffectRow[]
    ).map(effectFromRow);
  }

  evidenceLinks(purchaseId: PurchaseId): EvidenceLinkRecord[] {
    this.requirePurchase(purchaseId);
    const rows = this.db
      .prepare(
        `SELECT purchase_id, digest, kind, attempt, media_type, profile, issuer, attached_at_ms
         FROM evidence_links WHERE purchase_id = ? ORDER BY kind, attempt, digest`
      )
      .all(purchaseId) as EvidenceLinkRow[];
    return rows.map(evidenceLinkFromRow);
  }

  findSpendForPurchase(purchaseId: PurchaseId): TreasurySpendRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM treasury_spends WHERE purchase_id = ? ORDER BY id DESC LIMIT 1")
      .get(purchaseId) as TreasurySpendRow | undefined;
    return row ? treasurySpendFromRow(row) : undefined;
  }

  requireSpend(reservationId: string): TreasurySpendRecord {
    const spend = this.findSpend(reservationId);
    if (!spend) throw new JournalNotFoundError(`Treasury spend for Reservation ${reservationId} does not exist`);
    return spend;
  }

  requireEffect(id: string): EffectRecord {
    const row = this.db.prepare("SELECT * FROM effects WHERE id = ?").get(id) as EffectRow | undefined;
    if (!row) throw new JournalNotFoundError(`Effect ${id} does not exist`);
    return effectFromRow(row);
  }

  recoverableEffects(purchaseId?: PurchaseId): EffectRecord[] {
    const rows = purchaseId
      ? (this.db
          .prepare(
            `SELECT * FROM effects
             WHERE purchase_id = ? AND state NOT IN ('observed', 'abandoned')
             ORDER BY created_at_ms, id`
          )
          .all(purchaseId) as EffectRow[])
      : (this.db
          .prepare(
            `SELECT * FROM effects
             WHERE state NOT IN ('observed', 'abandoned')
             ORDER BY created_at_ms, id`
          )
          .all() as EffectRow[]);
    return rows.map(effectFromRow);
  }

  effectObservations(effectId: string): EffectObservationRecord[] {
    this.requireEffect(effectId);
    const rows = this.db
      .prepare("SELECT * FROM effect_observations WHERE effect_id = ? ORDER BY id")
      .all(effectId) as EffectObservationRow[];
    return rows.map(effectObservationFromRow);
  }

  effectTransitions(effectId: string): EffectTransitionRecord[] {
    this.requireEffect(effectId);
    const rows = this.db
      .prepare("SELECT * FROM effect_transitions WHERE effect_id = ? ORDER BY sequence")
      .all(effectId) as EffectTransitionRow[];
    return rows.map(effectTransitionFromRow);
  }

  effectClaimActive(effectId: string): boolean {
    return this.effectClaimActiveInternal(this.requireEffect(effectId), this.timestamp());
  }

  verifyEffectPreparedMaterial(effectId: string): true {
    const effect = this.requireEffect(effectId);
    this.readPreparedMaterial(effect.payloadDigest, effect.preparedRef, effect.preparedByteLength);
    return true;
  }

  acquireLease(name: string, holder: string, ttlMs: number): LeaseToken | undefined {
    const acquire = this.db.transaction(() => this.acquireLeaseInternal(name, holder, ttlMs, this.timestamp()));
    return acquire.immediate();
  }

  renewLease(token: LeaseToken, ttlMs: number): LeaseToken {
    validateLeaseFields(token.name, token.holder, ttlMs);
    const renew = this.db.transaction(() => {
      const now = this.timestamp();
      this.assertLeaseInternal(token, now);
      const expiresAtMs = safeExpiry(now, ttlMs);
      const updated = this.db
        .prepare(
          `UPDATE leases SET expires_at_ms = ?, updated_at_ms = ?
           WHERE name = ? AND holder = ? AND generation = ? AND expires_at_ms > ?`
        )
        .run(expiresAtMs, now, token.name, token.holder, token.generation, now);
      if (updated.changes !== 1) throw new JournalFencingError(`lease ${token.name} was lost during renewal`);
      return { ...token, expiresAtMs };
    });
    return renew.immediate();
  }

  releaseLease(token: LeaseToken): boolean {
    const now = this.timestamp();
    return (
      this.db
        .prepare(
          `UPDATE leases SET expires_at_ms = ?, updated_at_ms = ?
           WHERE name = ? AND holder = ? AND generation = ? AND expires_at_ms > ?`
        )
        .run(now, now, token.name, token.holder, token.generation, now).changes === 1
    );
  }

  recordReconciliation(
    lease: LeaseToken,
    purchaseId: PurchaseId,
    effectId: string | undefined,
    outcome: string,
    detailDigest?: Sha256Digest
  ): ReconciliationRunRecord {
    assertCode(outcome, "reconciliation outcome");
    if (detailDigest) assertDigest(detailDigest, "reconciliation detail digest");
    const record = this.db.transaction(() => {
      this.assertRecoveryLease(lease, purchaseId);
      this.requirePurchase(purchaseId);
      if (effectId) {
        const effect = this.requireEffect(effectId);
        if (effect.purchaseId !== purchaseId) {
          throw new JournalInvariantError(`Effect ${effectId} does not belong to Purchase ${purchaseId}`);
        }
      }
      const now = this.timestamp();
      const result = this.db
        .prepare(
          `INSERT INTO reconciliation_runs
             (purchase_id, effect_id, outcome, detail_digest, lease_name, lease_generation, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          purchaseId,
          effectId ?? null,
          outcome,
          detailDigest ?? null,
          lease.name,
          lease.generation,
          now
        );
      return {
        id: Number(result.lastInsertRowid),
        purchaseId,
        effectId,
        outcome,
        detailDigest,
        leaseName: lease.name,
        leaseGeneration: lease.generation,
        createdAtMs: now,
      };
    });
    return record.immediate();
  }

  reconciliationRuns(purchaseId: PurchaseId): ReconciliationRunRecord[] {
    this.requirePurchase(purchaseId);
    const rows = this.db
      .prepare("SELECT * FROM reconciliation_runs WHERE purchase_id = ? ORDER BY id")
      .all(purchaseId) as ReconciliationRunRow[];
    return rows.map(reconciliationRunFromRow);
  }

  private configure(busyTimeoutMs: number): void {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new JournalInvariantError("SQLite busy timeout must be a non-negative safe integer");
    }
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("trusted_schema = OFF");
    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (this.filename !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("wal_autocheckpoint = 1000");
  }

  private bindOperatorManifest(
    identity: Readonly<{ revision: number; digest: string }> | undefined
  ): void {
    if (identity === undefined) return;
    if (
      !Number.isSafeInteger(identity.revision) ||
      identity.revision < 1 ||
      !/^sha256:[A-Za-z0-9_-]{43}$/.test(identity.digest)
    ) {
      throw new JournalInvariantError("Operator Manifest identity is invalid");
    }
    const existing = this.operatorManifestIdentity();
    if (existing) {
      if (
        existing.revision !== identity.revision ||
        existing.digest !== identity.digest
      ) {
        throw new JournalInvariantError(
          "Purchase Journal is bound to a different Operator Manifest"
        );
      }
      return;
    }
    const facts = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM purchases) +
           (SELECT COUNT(*) FROM treasury_operations) AS count`
      )
      .get() as { count: number };
    if (facts.count !== 0) {
      throw new JournalInvariantError(
        "cannot bind an existing development Journal to an Operator Manifest"
      );
    }
    this.db
      .prepare(
        `INSERT INTO operator_manifest_binding
           (singleton, revision, digest, bound_at_ms)
         VALUES (1, ?, ?, ?)`
      )
      .run(identity.revision, identity.digest, this.timestamp());
  }

  private migrate(): void {
    const version = this.schemaVersion();
    const applicationId = this.db.pragma("application_id", { simple: true }) as number;
    if (version !== 0 && version !== JOURNAL_SCHEMA_VERSION) {
      throw new JournalInvariantError(
        `clean cutover refuses Purchase Journal schema ${version}; recreate it at schema ${JOURNAL_SCHEMA_VERSION}`
      );
    }
    if (version === JOURNAL_SCHEMA_VERSION) {
      if (applicationId !== JOURNAL_APPLICATION_ID) {
        throw new JournalInvariantError("Purchase Journal application identity is invalid");
      }
      return;
    }
    if (version !== 0 || applicationId !== 0) {
      throw new JournalInvariantError(`unsupported Purchase Journal schema ${version}`);
    }
    const existingObjects = this.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get() as { count: number };
    if (existingObjects.count !== 0) {
      throw new JournalInvariantError("refusing to initialize over an existing unversioned SQLite schema");
    }
    const migrate = this.db.transaction(() => {
      this.db.exec(JOURNAL_SCHEMA_SQL);
      this.db
        .prepare("INSERT INTO schema_migrations (version, checksum, applied_at_ms) VALUES (?, ?, ?)")
        .run(JOURNAL_SCHEMA_VERSION, JOURNAL_SCHEMA_CHECKSUM, this.timestamp());
      this.db.pragma(`application_id = ${JOURNAL_APPLICATION_ID}`);
      this.db.pragma(`user_version = ${JOURNAL_SCHEMA_VERSION}`);
    });
    migrate.immediate();
  }

  private verifyStartup(): void {
    if ((this.db.pragma("application_id", { simple: true }) as number) !== JOURNAL_APPLICATION_ID) {
      throw new JournalInvariantError("Purchase Journal application identity is invalid");
    }
    this.integrityCheck();
    const migration = this.db
      .prepare("SELECT checksum FROM schema_migrations WHERE version = ?")
      .get(JOURNAL_SCHEMA_VERSION) as { checksum: string } | undefined;
    if (!migration || migration.checksum !== JOURNAL_SCHEMA_CHECKSUM) {
      throw new JournalInvariantError("Purchase Journal migration checksum is invalid");
    }
    if (schemaFingerprint(this.db) !== expectedSchemaFingerprint()) {
      throw new JournalInvariantError("Purchase Journal schema fingerprint is invalid");
    }
    this.verifySemanticConsistency();
  }

  private verifySemanticConsistency(): void {
    const purchases = this.db.prepare("SELECT * FROM purchases ORDER BY id").all() as PurchaseRow[];
    for (const purchase of purchases) {
      const transitions = this.db
        .prepare("SELECT * FROM purchase_transitions WHERE purchase_id = ? ORDER BY sequence")
        .all(purchase.id) as PurchaseTransitionRow[];
      if (transitions.length === 0 || transitions[0].from_state !== null || transitions[0].to_state !== "created") {
        throw new JournalInvariantError(`Purchase ${purchase.id} has invalid initial history`);
      }
      let state: PurchaseState = "created";
      let timestamp = transitions[0].created_at_ms;
      for (const transition of transitions.slice(1)) {
        if (transition.from_state !== state || transition.created_at_ms < timestamp) {
          throw new JournalInvariantError(`Purchase ${purchase.id} history is inconsistent`);
        }
        try {
          assertPurchaseTransition(state, transition.to_state);
        } catch {
          throw new JournalInvariantError(`Purchase ${purchase.id} history contains an invalid transition`);
        }
        state = transition.to_state;
        timestamp = transition.created_at_ms;
      }
      if (state !== purchase.state || purchase.version !== transitions.length - 1) {
        throw new JournalInvariantError(`Purchase ${purchase.id} state does not match immutable history`);
      }

      const purchaseId = purchase.id as PurchaseId;
      const terms = this.findCheckoutTerms(purchaseId);
      const authorizationRequest = this.findAuthorizationRequest(purchaseId);
      const authorization = this.findAuthorization(purchaseId);
      const fulfilment = this.findFulfilment(purchaseId);
      const receipts = this.receipts(purchaseId);
      const receiptSet = this.findReceiptSet(purchaseId);
      this.assertPurchaseStateFacts(purchaseId, purchase.state);
      const requiresTerms = !["created", "cancelled"].includes(purchase.state);
      if (requiresTerms && !terms) {
        throw new JournalInvariantError(`Purchase ${purchase.id} state requires immutable Checkout Terms`);
      }
      if (terms) {
        if (
          terms.resourceFingerprint !== purchase.resource_fingerprint ||
          terms.checkoutDigest !== terms.checkoutEvidenceDigest ||
          (purchase.expected_merchant_id !== null && terms.merchant.id !== purchase.expected_merchant_id) ||
          (purchase.expected_merchant_origin !== null && terms.merchant.origin !== purchase.expected_merchant_origin) ||
          !this.isVerifiedEvidenceLinked(purchaseId, terms.checkoutEvidenceDigest, {
            attempt: null,
            kind: "checkout-terms",
            verificationProfile: terms.checkoutVerificationProfile,
            verifierId: terms.checkoutVerifierId,
          }) ||
          !this.isVerifiedEvidenceLinked(purchaseId, terms.paymentRequirementsDigest, {
            attempt: null,
            kind: "payment-requirements",
            verificationProfile: terms.paymentRequirementsVerificationProfile,
            verifierId: terms.paymentRequirementsVerifierId,
          }) ||
          this.requireEvidenceAttachment(
            purchaseId,
            terms.checkoutEvidenceDigest,
            "checkout-terms"
          ).issuer !== terms.merchant.id ||
          this.requireEvidenceAttachment(
            purchaseId,
            terms.checkoutEvidenceDigest,
            "checkout-terms"
          ).profile !== terms.checkoutVerificationProfile ||
          this.requireEvidenceAttachment(
            purchaseId,
            terms.paymentRequirementsDigest,
            "payment-requirements"
          ).issuer !== terms.merchant.id ||
          this.requireEvidenceAttachment(
            purchaseId,
            terms.paymentRequirementsDigest,
            "payment-requirements"
          ).profile !== terms.paymentRequirementsVerificationProfile
        ) {
          throw new JournalInvariantError(`Purchase ${purchase.id} Checkout Terms are inconsistent`);
        }
      }
      if (authorizationRequest) {
        const requestBody = this.requireEvidenceAttachment(
          purchaseId,
          authorizationRequest.requestBodyDigest,
          "purchase-request-body"
        );
        const requestMediaType = authorizationRequest.requestMediaType || undefined;
        if (
          !terms ||
          authorizationRequest.checkoutDigest !== terms.checkoutDigest ||
          !this.evidenceLinked(purchaseId, authorizationRequest.requestDigest, "authorization-request") ||
          (requestMediaType !== undefined && requestBody.mediaType !== requestMediaType) ||
          purchase.resource_fingerprint !== requestFingerprintFromBodyDigest({
            url: purchase.resource_url,
            method: purchase.method,
            mediaType: requestMediaType,
            bodyDigest: authorizationRequest.requestBodyDigest,
          })
        ) {
          throw new JournalInvariantError(`Purchase ${purchase.id} authorization request is misbound`);
        }
      }
      if (["awaiting_authority", "authorised", "execution_prepared", "submitted", "settled", "fulfilled", "receipted", "denied", "failed_recoverable", "failed_terminal"].includes(purchase.state) && !authorizationRequest) {
        throw new JournalInvariantError(`Purchase ${purchase.id} state requires an authorization request`);
      }
      if (authorization) {
        if (
          !authorizationRequest ||
          authorization.checkoutDigest !== authorizationRequest.checkoutDigest ||
          authorization.requestDigest !== authorizationRequest.requestDigest ||
          authorization.nonceDigest !== authorizationRequest.nonceDigest ||
          authorization.expiresAtMs !== authorizationRequest.expiresAtMs ||
          authorization.approvedFactsDigest !== this.canonicalAuthorizationFactsDigest(purchaseId) ||
          !this.isVerifiedEvidenceLinked(purchaseId, authorization.evidenceDigest, {
            attempt: null,
            kind: "purchase-authorization",
            verificationProfile: authorization.verificationProfile,
            verifierId: authorization.verifierId,
          })
        ) {
          throw new JournalInvariantError(`Purchase ${purchase.id} authorization decision is inconsistent`);
        }
      }
      const requiresApprovedAuthorization = [
        "authorised",
        "execution_prepared",
        "submitted",
        "settled",
        "fulfilled",
        "receipted",
        "failed_recoverable",
        "failed_terminal",
      ].includes(purchase.state);
      if (requiresApprovedAuthorization && authorization?.decision !== "approved") {
        throw new JournalInvariantError(`Purchase ${purchase.id} state requires approved authorization`);
      }
      if (purchase.state === "denied" && authorization?.decision !== "denied") {
        throw new JournalInvariantError(`Purchase ${purchase.id} denial has no matching authorization fact`);
      }
      if ((purchase.state === "fulfilled" || purchase.state === "receipted") && !fulfilment) {
        throw new JournalInvariantError(`Purchase ${purchase.id} state requires verified Fulfilment`);
      }
      if (purchase.state === "receipted" && !receiptSet) {
        throw new JournalInvariantError(`Purchase ${purchase.id} state requires a complete canonical Receipt set`);
      }
      if (purchase.state !== "receipted" && receiptSet) {
        throw new JournalInvariantError(`Purchase ${purchase.id} has a completed Receipt set in state ${purchase.state}`);
      }
    }

    const attempts = this.db
      .prepare("SELECT * FROM payment_attempts ORDER BY purchase_id, attempt")
      .all() as PaymentAttemptRow[];
    for (const attempt of attempts) {
      const transitions = this.db
        .prepare(
          `SELECT * FROM payment_attempt_transitions
           WHERE purchase_id = ? AND attempt = ? ORDER BY sequence`
        )
        .all(attempt.purchase_id, attempt.attempt) as PaymentAttemptTransitionRow[];
      if (transitions.length === 0 || transitions[0].from_state !== null || transitions[0].to_state !== "planned") {
        throw new JournalInvariantError(`Payment Attempt ${attempt.purchase_id}/${attempt.attempt} has invalid history`);
      }
      let state: PaymentAttemptState = "planned";
      let timestamp = transitions[0].created_at_ms;
      for (const transition of transitions.slice(1)) {
        if (transition.from_state !== state || transition.created_at_ms < timestamp) {
          throw new JournalInvariantError(`Payment Attempt ${attempt.purchase_id}/${attempt.attempt} history is inconsistent`);
        }
        const proofBackedSubmittedFailure =
          state === "submitted" &&
          transition.to_state === "failed" &&
          [
            "payment_abandoned_after_not_found",
            "staging_recovered_without_payment",
          ].includes(transition.reason_code) &&
          transition.detail_digest !== null;
        assertAttemptTransition(state, transition.to_state, proofBackedSubmittedFailure);
        state = transition.to_state;
        timestamp = transition.created_at_ms;
      }
      if (state !== attempt.state || attempt.version !== transitions.length - 1) {
        throw new JournalInvariantError(
          `Payment Attempt ${attempt.purchase_id}/${attempt.attempt} state does not match immutable history`
        );
      }
      if ((attempt.state === "failed") !== (attempt.failure_code !== null)) {
        throw new JournalInvariantError(`Payment Attempt ${attempt.purchase_id}/${attempt.attempt} failure fact is inconsistent`);
      }
      const preparation = this.findPaymentPreparation(attempt.purchase_id as PurchaseId, attempt.attempt);
      if (["prepared", "submitted", "observed"].includes(attempt.state) && !preparation) {
        throw new JournalInvariantError(`Payment Attempt ${attempt.purchase_id}/${attempt.attempt} lost its preparation`);
      }
      if (attempt.state === "planned" && preparation) {
        throw new JournalInvariantError(`planned Payment Attempt ${attempt.purchase_id}/${attempt.attempt} has preparation`);
      }
    }

    const preparations = this.db.prepare("SELECT * FROM payment_preparations").all() as PaymentPreparationRow[];
    for (const row of preparations) {
      const preparation = paymentPreparationFromRow(row);
      const reservation = this.requireReservation(preparation.reservationId);
      const terms = this.requireCheckoutTerms(preparation.purchaseId);
      const stagingPlan = this.findTreasuryStagingPlan(preparation.purchaseId, preparation.attempt);
      const stagingObservation = this.findTreasuryStagingObservation(
        preparation.purchaseId,
        preparation.attempt
      );
      if (
        reservation.purchaseId !== preparation.purchaseId ||
        reservation.amountAtomic !== preparation.amountAtomic ||
        reservation.payee !== preparation.payee ||
        preparation.requirementsDigest !== terms.paymentRequirementsDigest ||
        preparation.amountAtomic !== terms.amountAtomic ||
        preparation.asset !== terms.asset ||
        preparation.network !== terms.network ||
        preparation.payee !== terms.payTo ||
        preparation.fundingSource !== reservation.fundingSource ||
        (stagingPlan !== undefined &&
          (stagingPlan.reservationId !== preparation.reservationId ||
            stagingObservation?.effectId !== stagingPlan.effectId ||
            this.requireEffect(stagingPlan.effectId).state !== "observed"))
      ) {
        throw new JournalInvariantError(`payment preparation ${preparation.purchaseId}/${preparation.attempt} is misbound`);
      }
      this.readPreparedMaterial(
        preparation.payloadDigest,
        preparation.preparedRef,
        preparation.preparedByteLength
      );
    }

    const effects = this.db.prepare("SELECT * FROM effects").all() as EffectRow[];
    for (const row of effects) {
      const effect = effectFromRow(row);
      const transitions = this.db
        .prepare("SELECT * FROM effect_transitions WHERE effect_id = ? ORDER BY sequence")
        .all(effect.id) as EffectTransitionRow[];
      if (transitions.length === 0 || transitions[0].from_state !== null || transitions[0].to_state !== "planned") {
        throw new JournalInvariantError(`Effect ${effect.id} has invalid initial history`);
      }
      let effectState: EffectState = "planned";
      let effectTimestamp = transitions[0].created_at_ms;
      for (const transition of transitions.slice(1)) {
        if (transition.from_state !== effectState || transition.created_at_ms < effectTimestamp) {
          throw new JournalInvariantError(`Effect ${effect.id} history is inconsistent`);
        }
        assertEffectTransition(effectState, transition.to_state);
        if (transition.to_state === "retryable") {
          if (
            transition.reason_code !== "observation_not_found_retryable" ||
            transition.detail_digest === null
          ) {
            throw new JournalInvariantError(`Effect ${effect.id} retry transition has no not-found proof`);
          }
          const proof = this.db
            .prepare(
              `SELECT id FROM effect_observations
               WHERE effect_id = ? AND status = 'not_found_retryable' AND detail_digest = ?`
            )
            .get(effect.id, transition.detail_digest);
          if (!proof) throw new JournalInvariantError(`Effect ${effect.id} retry proof is missing`);
        }
        effectState = transition.to_state;
        effectTimestamp = transition.created_at_ms;
      }
      if (effectState !== effect.state || effect.version !== transitions.length - 1) {
        throw new JournalInvariantError(`Effect ${effect.id} state does not match immutable history`);
      }
      this.readPreparedMaterial(effect.payloadDigest, effect.preparedRef, effect.preparedByteLength);
      if (effect.kind === TREASURY_STAGING_EFFECT_KIND) {
        if (effect.attempt === undefined) {
          throw new JournalInvariantError(`Treasury staging Effect ${effect.id} has no Payment Attempt`);
        }
        const plan = this.findTreasuryStagingPlanByEffect(effect.id);
        if (
          !plan ||
          plan.purchaseId !== effect.purchaseId ||
          plan.attempt !== effect.attempt ||
          plan.payloadDigest !== effect.payloadDigest ||
          plan.preparedRef !== effect.preparedRef ||
          plan.preparedByteLength !== effect.preparedByteLength ||
          plan.idempotencyKey !== effect.idempotencyKey
        ) {
          throw new JournalInvariantError(`Treasury staging Effect ${effect.id} is not bound to its plan`);
        }
        const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
        this.requireObservedMerchantAuthorization(
          effect.purchaseId,
          effect.attempt,
          attempt.identifier
        );
        const observation = this.findTreasuryStagingObservationByEffect(effect.id);
        if ((effect.state === "observed") !== Boolean(observation)) {
          throw new JournalInvariantError(`Treasury staging Effect ${effect.id} observation state is inconsistent`);
        }
        if (observation && effect.resultDigest !== observation.evidenceDigest) {
          throw new JournalInvariantError(`Treasury staging Effect ${effect.id} result evidence is inconsistent`);
        }
      } else if (effect.kind === TREASURY_STAGING_RECOVERY_EFFECT_KIND) {
        if (effect.attempt === undefined) {
          throw new JournalInvariantError(
            `Treasury staging recovery Effect ${effect.id} has no Payment Attempt`
          );
        }
        const plan = this.findTreasuryStagingRecoveryPlanByEffect(effect.id);
        if (
          !plan ||
          plan.purchaseId !== effect.purchaseId ||
          plan.attempt !== effect.attempt ||
          plan.payloadDigest !== effect.payloadDigest ||
          plan.preparedRef !== effect.preparedRef ||
          plan.preparedByteLength !== effect.preparedByteLength ||
          plan.idempotencyKey !== effect.idempotencyKey
        ) {
          throw new JournalInvariantError(
            `Treasury staging recovery Effect ${effect.id} is not bound to its plan`
          );
        }
        const accounting = this.findTreasuryStagingRecoveryAccounting(effect.id);
        if (accounting && (effect.state !== "observed" || effect.resultDigest !== accounting.evidenceDigest)) {
          throw new JournalInvariantError(
            `Treasury staging recovery Effect ${effect.id} accounting conflicts with its state`
          );
        }
      } else if (effect.attempt !== undefined && effect.state !== "planned") {
        const preparation = this.requirePaymentPreparation(effect.purchaseId, effect.attempt);
        if (
          effect.payloadDigest !== preparation.payloadDigest ||
          effect.preparedRef !== preparation.preparedRef ||
          effect.preparedByteLength !== preparation.preparedByteLength
        ) {
          throw new JournalInvariantError(`submitted Effect ${effect.id} is not bound to its payment preparation`);
        }
      }
    }

    const stagingPlans = this.db
      .prepare(
        `SELECT p.*, e.idempotency_key
           FROM treasury_staging_plans p
           JOIN effects e ON e.id = p.effect_id`
      )
      .all() as TreasuryStagingPlanRow[];
    for (const row of stagingPlans) {
      const plan = treasuryStagingPlanFromRow(row);
      const effect = this.requireEffect(plan.effectId);
      const attempt = this.requirePaymentAttempt(plan.purchaseId, plan.attempt);
      const reservation = this.requireReservation(plan.reservationId);
      const reservedGross =
        BigInt(reservation.amountAtomic) + BigInt(reservation.additionalCostCeilingAtomic);
      if (
        effect.kind !== TREASURY_STAGING_EFFECT_KIND ||
        effect.purchaseId !== plan.purchaseId ||
        effect.attempt !== plan.attempt ||
        effect.payloadDigest !== plan.payloadDigest ||
        effect.preparedRef !== plan.preparedRef ||
        effect.preparedByteLength !== plan.preparedByteLength ||
        effect.idempotencyKey !== plan.idempotencyKey ||
        reservation.purchaseId !== plan.purchaseId ||
        reservation.fundingSource !== plan.fundingSource ||
        BigInt(plan.stagingAmountAtomic) > reservedGross ||
        (attempt.state === "planned" && this.findPaymentPreparation(plan.purchaseId, plan.attempt) !== undefined)
      ) {
        throw new JournalInvariantError(
          `Treasury staging plan ${plan.purchaseId}/${plan.attempt} is misbound`
        );
      }
      this.readPreparedMaterial(plan.payloadDigest, plan.preparedRef, plan.preparedByteLength);
    }

    const stagingObservationRows = this.db
      .prepare("SELECT * FROM treasury_staging_observations")
      .all() as TreasuryStagingObservationRow[];
    for (const row of stagingObservationRows) {
      const observation = treasuryStagingObservationFromRow(row);
      const plan = this.findTreasuryStagingPlanByEffect(observation.effectId);
      const effect = this.requireEffect(observation.effectId);
      if (
        !plan ||
        plan.purchaseId !== observation.purchaseId ||
        plan.attempt !== observation.attempt ||
        plan.reservationId !== observation.reservationId ||
        plan.plannedTransactionId !== observation.transactionId ||
        plan.expectedOutpoint !== observation.outpoint ||
        plan.stagingAmountAtomic !== observation.stagingAmountAtomic ||
        plan.fundingSource !== observation.fundingSource ||
        effect.state !== "observed" ||
        effect.resultDigest !== observation.evidenceDigest ||
        !this.isVerifiedEvidenceLinked(observation.purchaseId, observation.evidenceDigest, {
          attempt: observation.attempt,
          kind: TREASURY_STAGING_EVIDENCE_KIND,
          verificationProfile: observation.evidenceVerificationProfile,
          verifierId: observation.evidenceVerifierId,
        })
      ) {
        throw new JournalInvariantError(
          `Treasury staging observation ${observation.effectId} is inconsistent`
        );
      }
    }

    const stagingRecoveryPlanRows = this.db.prepare(
      `SELECT p.*, e.idempotency_key
         FROM treasury_staging_recovery_plans p
         JOIN effects e ON e.id = p.effect_id`
    ).all() as TreasuryStagingRecoveryPlanRow[];
    for (const row of stagingRecoveryPlanRows) {
      const plan = treasuryStagingRecoveryPlanFromRow(row);
      const effect = this.requireEffect(plan.effectId);
      const staging = this.findTreasuryStagingObservation(plan.purchaseId, plan.attempt);
      const reservation = this.requireReservation(plan.reservationId);
      const preparation = this.findPaymentPreparation(plan.purchaseId, plan.attempt);
      if (
        effect.kind !== TREASURY_STAGING_RECOVERY_EFFECT_KIND ||
        effect.purchaseId !== plan.purchaseId ||
        effect.attempt !== plan.attempt ||
        effect.payloadDigest !== plan.payloadDigest ||
        effect.preparedRef !== plan.preparedRef ||
        effect.preparedByteLength !== plan.preparedByteLength ||
        effect.idempotencyKey !== plan.idempotencyKey ||
        !staging ||
        staging.effectId !== plan.stagingEffectId ||
        staging.reservationId !== plan.reservationId ||
        reservation.purchaseId !== plan.purchaseId ||
        reservation.additionalCostCeilingAtomic !==
          plan.authorizedAdditionalCostCeilingAtomic ||
        (preparation?.transactionId ?? undefined) !== plan.exactTransactionId ||
        BigInt(plan.recoveryAmountAtomic) + BigInt(plan.recoveryFeeAtomic) !==
          BigInt(staging.stagingAmountAtomic)
      ) {
        throw new JournalInvariantError(
          `Treasury staging recovery plan ${plan.purchaseId}/${plan.attempt} is inconsistent`
        );
      }
      this.readPreparedMaterial(
        plan.payloadDigest,
        plan.preparedRef,
        plan.preparedByteLength
      );
    }

    const stagingRecoveryAccountingRows = this.db.prepare(
      "SELECT * FROM treasury_staging_recovery_accounting"
    ).all() as TreasuryStagingRecoveryAccountingRow[];
    for (const row of stagingRecoveryAccountingRows) {
      const accounting = treasuryStagingRecoveryAccountingFromRow(row);
      const plan = this.findTreasuryStagingRecoveryPlanByEffect(accounting.effectId);
      const effect = this.requireEffect(accounting.effectId);
      const reservation = this.requireReservation(accounting.reservationId);
      if (
        !plan ||
        plan.reservationId !== accounting.reservationId ||
        plan.purchaseId !== accounting.purchaseId ||
        plan.attempt !== accounting.attempt ||
        plan.recoveryTransactionId !== accounting.recoveryTransactionId ||
        plan.recoveryOutpoint !== accounting.recoveryOutpoint ||
        plan.recoveryAmountAtomic !== accounting.returnedAmountAtomic ||
        plan.stagingFeeAtomic !== accounting.stagingFeeAtomic ||
        plan.recoveryFeeAtomic !== accounting.recoveryFeeAtomic ||
        BigInt(accounting.actualAdditionalCostAtomic) !==
          BigInt(accounting.stagingFeeAtomic) + BigInt(accounting.recoveryFeeAtomic) ||
        !paymentFinalityMeets(accounting.finality, plan.requiredFinality) ||
        effect.state !== "observed" ||
        effect.resultDigest !== accounting.evidenceDigest ||
        reservation.state !== "released" ||
        reservation.releaseEvidenceDigest !== accounting.evidenceDigest
      ) {
        throw new JournalInvariantError(
          `Treasury staging recovery accounting ${accounting.effectId} is inconsistent`
        );
      }
    }

    const reservations = this.db.prepare("SELECT * FROM treasury_reservations").all() as ReservationRow[];
    for (const row of reservations) {
      const reservation = reservationFromRow(row);
      const terms = this.requireCheckoutTerms(reservation.purchaseId);
      const authorization = this.requireAuthorization(reservation.purchaseId);
      const authorizationRequest = this.requireAuthorizationRequest(reservation.purchaseId);
      if (
        authorization.decision !== "approved" ||
        reservation.amountAtomic !== terms.amountAtomic ||
        reservation.payee !== terms.payTo ||
        reservation.expiresAtMs > terms.expiresAtMs ||
        BigInt(reservation.additionalCostCeilingAtomic) >
          BigInt(authorizationRequest.additionalCostCeilingAtomic) ||
        reservation.approvalEvidenceDigest !== authorization.evidenceDigest ||
        reservation.approvalVerificationProfile !== authorization.verificationProfile ||
        reservation.approvalVerifierId !== authorization.verifierId ||
        reservation.fundingSource !== "vault-treasury"
      ) {
        throw new JournalInvariantError(`Treasury Reservation ${reservation.id} is misbound to its Purchase`);
      }
      const spend = this.findSpend(reservation.id);
      if ((reservation.state === "spent") !== Boolean(spend)) {
        throw new JournalInvariantError(`Treasury Reservation ${reservation.id} spend state is inconsistent`);
      }
      if (reservation.state === "in_flight" || reservation.state === "spent" || reservation.releaseEvidenceDigest) {
        const preparationRow = this.db
          .prepare("SELECT * FROM payment_preparations WHERE reservation_id = ?")
          .get(reservation.id) as PaymentPreparationRow | undefined;
        const stagingPlan = this.findTreasuryStagingPlanByReservation(reservation.id);
        if (!preparationRow && !stagingPlan) {
          throw new JournalInvariantError(
            `Treasury Reservation ${reservation.id} has neither staging nor payment preparation`
          );
        }
        if (
          preparationRow &&
          stagingPlan &&
          (preparationRow.purchase_id !== stagingPlan.purchaseId ||
            preparationRow.attempt !== stagingPlan.attempt)
        ) {
          throw new JournalInvariantError(
            `Treasury Reservation ${reservation.id} has conflicting staging and payment attempts`
          );
        }
        const attemptPurchaseId = (preparationRow?.purchase_id ?? stagingPlan!.purchaseId) as PurchaseId;
        const attemptNumber = preparationRow?.attempt ?? stagingPlan!.attempt;
        const attempt = this.requirePaymentAttempt(attemptPurchaseId, attemptNumber);
        const attemptEffects = (
          this.db
            .prepare("SELECT * FROM effects WHERE purchase_id = ? AND attempt = ?")
            .all(attemptPurchaseId, attemptNumber) as EffectRow[]
        ).map(effectFromRow);
        const paymentEffects = attemptEffects.filter(
          (effect) =>
            effect.kind !== TREASURY_STAGING_EFFECT_KIND &&
            effect.kind !== TREASURY_STAGING_RECOVERY_EFFECT_KIND
        );
        const stagingEffect = stagingPlan
          ? attemptEffects.find((effect) => effect.id === stagingPlan.effectId)
          : undefined;
        const stagingObservation = stagingPlan
          ? this.findTreasuryStagingObservation(attemptPurchaseId, attemptNumber)
          : undefined;
        const recoveryAccounting =
          this.findTreasuryStagingRecoveryAccountingByReservation(reservation.id);
        if (reservation.state === "in_flight") {
          if (stagingPlan) {
            if (
              !stagingEffect ||
              !["executing", "submitted", "ambiguous", "retryable", "observed", "failed_terminal"].includes(
                stagingEffect.state
              )
            ) {
              throw new JournalInvariantError(
                `in-flight Treasury Reservation ${reservation.id} has no recoverable staging Effect`
              );
            }
            if (stagingEffect.state === "observed") {
              if (!stagingObservation || stagingObservation.effectId !== stagingEffect.id) {
                throw new JournalInvariantError(
                  `in-flight Treasury Reservation ${reservation.id} lost its staging observation`
                );
              }
              if (attempt.state === "planned" && preparationRow) {
                throw new JournalInvariantError(
                  `staged Treasury Reservation ${reservation.id} has preparation before Attempt transition`
                );
              }
              if (attempt.state === "prepared" && !preparationRow) {
                throw new JournalInvariantError(
                  `staged Treasury Reservation ${reservation.id} lost exact payment preparation`
                );
              }
              if (
                attempt.state === "submitted" &&
                !paymentEffects.some((effect) =>
                  ["executing", "submitted", "ambiguous", "retryable", "failed_terminal"].includes(effect.state)
                )
              ) {
                throw new JournalInvariantError(
                  `staged Treasury Reservation ${reservation.id} has no recoverable payment Effect`
                );
              }
              if (!["planned", "prepared", "submitted", "failed"].includes(attempt.state)) {
                throw new JournalInvariantError(
                  `staged in-flight Treasury Reservation ${reservation.id} has invalid Attempt state`
                );
              }
            } else if (attempt.state !== "planned" || preparationRow) {
              throw new JournalInvariantError(
                `unobserved Treasury staging ${reservation.id} advanced exact payment state`
              );
            }
          } else if (
            attempt.state !== "submitted" ||
            !paymentEffects.some((effect) =>
              ["executing", "submitted", "ambiguous", "retryable", "failed_terminal"].includes(effect.state)
            )
          ) {
            throw new JournalInvariantError(
              `direct in-flight Treasury Reservation ${reservation.id} has invalid payment state`
            );
          }
        }
        if (reservation.state === "spent" && attempt.state !== "observed") {
          throw new JournalInvariantError(`spent Treasury Reservation ${reservation.id} has invalid Attempt state`);
        }
        if (reservation.state === "spent" && !paymentEffects.some((effect) => effect.state === "observed")) {
          throw new JournalInvariantError(`spent Treasury Reservation ${reservation.id} has no observed Effect`);
        }
        if (reservation.releaseEvidenceDigest && attempt.state !== "failed") {
          throw new JournalInvariantError(`released Treasury Reservation ${reservation.id} has invalid Attempt state`);
        }
        if (
          reservation.releaseEvidenceDigest &&
          !recoveryAccounting &&
          !paymentEffects.some((effect) => effect.state === "failed_terminal")
        ) {
          throw new JournalInvariantError(`released Treasury Reservation ${reservation.id} has no terminal Effect`);
        }
        if (
          recoveryAccounting &&
          (reservation.state !== "released" ||
            reservation.releaseEvidenceDigest !== recoveryAccounting.evidenceDigest ||
            attempt.state !== "failed")
        ) {
          throw new JournalInvariantError(
            `recovered Treasury Reservation ${reservation.id} accounting is inconsistent`
          );
        }
      }
    }

    const spends = this.db.prepare("SELECT * FROM treasury_spends").all() as TreasurySpendRow[];
    for (const row of spends) {
      const spend = treasurySpendFromRow(row);
      const preparation = this.requirePaymentPreparation(spend.purchaseId, spend.attempt);
      const effect = this.requireEffect(spend.effectId);
      if (
        spend.reservationId !== preparation.reservationId ||
        spend.transactionId !== preparation.transactionId ||
        spend.actualAmountAtomic !== preparation.amountAtomic ||
        spend.asset !== preparation.asset ||
        spend.payee !== preparation.payee ||
        spend.network !== preparation.network ||
        !paymentFinalityMeets(spend.finality, preparation.requiredFinality) ||
        spend.fundingSource !== preparation.fundingSource ||
        effect.state !== "observed" ||
        effect.resultDigest !== spend.evidenceDigest
      ) {
        throw new JournalInvariantError(`Treasury spend ${spend.id} is inconsistent with immutable preparation`);
      }
    }

    const fulfilments = this.db.prepare("SELECT * FROM fulfilments").all() as FulfilmentRow[];
    for (const row of fulfilments) {
      const fulfilment = fulfilmentFromRow(row);
      const terms = this.requireCheckoutTerms(fulfilment.purchaseId);
      const attempt = this.requirePaymentAttempt(fulfilment.purchaseId, fulfilment.attempt);
      const body = this.requireEvidenceAttachment(
        fulfilment.purchaseId,
        fulfilment.bodyDigest,
        "fulfilment-body",
        fulfilment.attempt
      );
      if (
        terms.resourceFingerprint !== fulfilment.resourceFingerprint ||
        attempt.state !== "observed" ||
        body.byteLength !== fulfilment.bodyByteLength ||
        body.mediaType !== fulfilment.mediaType ||
        !this.evidenceLinked(fulfilment.purchaseId, fulfilment.bodyDigest, "fulfilment-body", fulfilment.attempt) ||
        !this.isVerifiedEvidenceLinked(fulfilment.purchaseId, fulfilment.merchantEvidenceDigest, {
          attempt: fulfilment.attempt,
          kind: "merchant-fulfilment",
          verificationProfile: fulfilment.merchantVerificationProfile,
          verifierId: fulfilment.merchantVerifierId,
        })
      ) {
        throw new JournalInvariantError(`Purchase ${fulfilment.purchaseId} Fulfilment is inconsistent`);
      }
    }

    const receiptRows = this.db.prepare("SELECT * FROM purchase_receipts").all() as ReceiptRow[];
    for (const row of receiptRows) {
      const receipt = receiptFromRow(row);
      const terms = this.requireCheckoutTerms(receipt.purchaseId);
      const authorization = this.requireAuthorization(receipt.purchaseId);
      const fulfilment = this.requireFulfilment(receipt.purchaseId);
      const spend = this.findSpendForPurchase(receipt.purchaseId);
      if (
        !spend ||
        receipt.canonicalDigest !== canonicalReceiptDigest(
          receipt.purchaseId,
          fulfilment.attempt,
          this.requirePaymentAttempt(receipt.purchaseId, fulfilment.attempt).identifier,
          receipt
        ) ||
        receipt.checkoutDigest !== terms.checkoutDigest ||
        receipt.authorizationEvidenceDigest !== authorization.evidenceDigest ||
        receipt.settlementEvidenceDigest !== spend.evidenceDigest ||
        receipt.fulfilmentDigest !== fulfilment.bodyDigest ||
        !this.isVerifiedEvidenceLinked(receipt.purchaseId, receipt.evidenceDigest, {
          attempt: null,
          kind: "purchase-receipt",
          verificationProfile: receipt.profile,
          verifierId: receipt.verifierId,
        })
      ) {
        throw new JournalInvariantError(`Purchase ${receipt.purchaseId} Receipt is inconsistent`);
      }
    }

    const receiptSetRows = this.db.prepare("SELECT * FROM purchase_receipt_sets").all() as ReceiptSetRow[];
    for (const row of receiptSetRows) {
      const set = receiptSetFromRow(row);
      const purchase = this.requirePurchase(set.purchaseId);
      const receipts = this.receipts(set.purchaseId);
      if (
        purchase.state !== "receipted" ||
        receipts.length !== PURCHASE_RECEIPT_REQUIREMENTS.length ||
        PURCHASE_RECEIPT_REQUIREMENTS.some((requirement) =>
          !receipts.some((receipt) => receipt.role === requirement.role && receipt.profile === requirement.profile)
        ) ||
        set.canonicalDigest !== canonicalReceiptSetDigest(
          set.purchaseId,
          this.requireFulfilment(set.purchaseId).attempt,
          this.requirePaymentAttempt(
            set.purchaseId,
            this.requireFulfilment(set.purchaseId).attempt
          ).identifier,
          receipts
        )
      ) {
        throw new JournalInvariantError(`Purchase ${set.purchaseId} canonical Receipt set is inconsistent`);
      }
    }

    const treasuryOperations = this.db
      .prepare("SELECT * FROM treasury_operations ORDER BY operation_key")
      .all() as TreasuryOperationRow[];
    for (const row of treasuryOperations) {
      const operation = treasuryOperationFromRow(row);
      const transitions = this.db.prepare(
        `SELECT from_state, to_state, created_at_ms
           FROM treasury_operation_transitions
          WHERE operation_key = ? ORDER BY sequence`
      ).all(operation.operationKey) as Array<{
        from_state: TreasuryOperationState | null;
        to_state: TreasuryOperationState;
        created_at_ms: number;
      }>;
      if (
        transitions.length === 0 ||
        transitions[0].from_state !== null ||
        transitions[0].to_state !== "intent"
      ) {
        throw new JournalInvariantError(
          `Treasury Operation ${operation.operationKey} has invalid initial history`
        );
      }
      let state: TreasuryOperationState = "intent";
      let timestamp = transitions[0].created_at_ms;
      for (const transition of transitions.slice(1)) {
        if (
          transition.from_state !== state ||
          transition.created_at_ms < timestamp ||
          !directTreasuryTransitionAllowed(state, transition.to_state)
        ) {
          throw new JournalInvariantError(
            `Treasury Operation ${operation.operationKey} history is inconsistent`
          );
        }
        state = transition.to_state;
        timestamp = transition.created_at_ms;
      }
      if (state !== operation.state) {
        throw new JournalInvariantError(
          `Treasury Operation ${operation.operationKey} state does not match immutable history`
        );
      }
      this.requirePolicy(operation.policyDigest as Sha256Digest);
      if (operation.state !== "intent" && operation.state !== "failed_terminal") {
        this.readPreparedTreasuryOperation(operation.operationKey);
      }
      const observed = this.db.prepare(
        `SELECT COUNT(*) AS count FROM treasury_operation_observations
          WHERE operation_key = ? AND status = 'observed'`
      ).get(operation.operationKey) as { count: number };
      if (
        (["observed", "completed"].includes(operation.state) && observed.count !== 1) ||
        (!(["observed", "completed"].includes(operation.state)) && observed.count !== 0) ||
        ((operation.state === "completed") !== (operation.completedAtMs !== undefined))
      ) {
        throw new JournalInvariantError(
          `Treasury Operation ${operation.operationKey} observation facts are inconsistent`
        );
      }
    }

    const artifacts = this.db.prepare("SELECT * FROM evidence_artifacts").all() as EvidenceArtifactRow[];
    for (const row of artifacts) {
      if (!this.evidenceStore) throw new JournalInvariantError("evidence metadata exists without evidence storage");
      this.evidenceStore.verify(row.digest as Sha256Digest, row.byte_length);
    }
  }

  private assertPurchaseStateFacts(purchaseId: PurchaseId, state: PurchaseState): void {
    const terms = this.findCheckoutTerms(purchaseId);
    const authorizationRequest = this.findAuthorizationRequest(purchaseId);
    const authorization = this.findAuthorization(purchaseId);
    const reservation = this.findReservationForPurchase(purchaseId);
    const attempts = this.paymentAttempts(purchaseId);
    const latestAttempt = attempts.at(-1);
    const preparation = latestAttempt
      ? this.findPaymentPreparation(purchaseId, latestAttempt.attempt)
      : undefined;
    const attemptEffects = this.effectsForPurchase(purchaseId).filter(
      (effect) => effect.attempt === latestAttempt?.attempt
    );
    const stagingPlan = latestAttempt
      ? this.findTreasuryStagingPlan(purchaseId, latestAttempt.attempt)
      : undefined;
    const stagingObservation = latestAttempt
      ? this.findTreasuryStagingObservation(purchaseId, latestAttempt.attempt)
      : undefined;
    const stagingEffect = stagingPlan
      ? attemptEffects.find((effect) => effect.id === stagingPlan.effectId)
      : undefined;
    const paymentEffects = attemptEffects.filter(
      (effect) =>
        effect.kind !== TREASURY_STAGING_EFFECT_KIND &&
        effect.kind !== TREASURY_STAGING_RECOVERY_EFFECT_KIND
    );
    const spend = this.findSpendForPurchase(purchaseId);
    const fulfilment = this.findFulfilment(purchaseId);
    const receipts = this.receipts(purchaseId);
    const receiptSet = this.findReceiptSet(purchaseId);

    if (state === "terms_bound" && !terms) {
      throw new JournalInvariantError(`Purchase ${purchaseId} cannot enter terms_bound without Checkout Terms`);
    }
    if (state === "awaiting_authority" && (!terms || !authorizationRequest)) {
      throw new JournalInvariantError(`Purchase ${purchaseId} cannot await authority without a durable request`);
    }
    if (state === "authorised" && authorization?.decision !== "approved") {
      throw new JournalInvariantError(`Purchase ${purchaseId} cannot be authorised without an approved decision`);
    }
    if (state === "denied" && authorization?.decision !== "denied") {
      throw new JournalInvariantError(`Purchase ${purchaseId} cannot be denied without a denied decision`);
    }
    if (state === "execution_prepared") {
      const stagingInProgress =
        latestAttempt?.state === "planned" &&
        stagingPlan &&
        stagingEffect &&
        reservation?.id === stagingPlan.reservationId &&
        (
          (reservation.state === "active" && stagingEffect.state === "planned") ||
          (
            reservation.state === "in_flight" &&
            ["executing", "submitted", "ambiguous", "retryable", "observed", "failed_terminal"].includes(
              stagingEffect.state
            )
          )
        ) &&
        (stagingEffect.state !== "observed" || stagingObservation?.effectId === stagingEffect.id);
      const firstSubmissionInProgress =
        latestAttempt &&
        ["submitted", "observed", "failed"].includes(latestAttempt.state) &&
        reservation &&
        ["in_flight", "spent", "released"].includes(reservation.state) &&
        paymentEffects.some((effect) =>
          ["executing", "submitted", "ambiguous", "retryable", "observed", "failed_terminal"].includes(effect.state)
        );
      const readyToSubmit =
        latestAttempt?.state === "prepared" &&
        (
          reservation?.state === "active" ||
          (
            reservation?.state === "in_flight" &&
            stagingEffect?.state === "observed" &&
            stagingObservation?.effectId === stagingEffect.id
          )
        ) &&
        paymentEffects.some((effect) => effect.state === "planned" || effect.state === "retryable");
      const stagedPreparationAwaitingEffect =
        preparation &&
        latestAttempt?.state === "prepared" &&
        reservation?.state === "in_flight" &&
        stagingEffect?.state === "observed" &&
        stagingObservation?.effectId === stagingEffect.id &&
        paymentEffects.length === 0;
      if (!stagingInProgress && (!preparation || (!readyToSubmit && !firstSubmissionInProgress && !stagedPreparationAwaitingEffect))) {
        throw new JournalInvariantError(
          `Purchase ${purchaseId} cannot enter execution_prepared without durable staging or exact payment facts`
        );
      }
    }
    if (state === "submitted") {
      const submitted =
        preparation &&
        latestAttempt &&
        ["submitted", "observed", "failed"].includes(latestAttempt.state) &&
        reservation &&
        ["in_flight", "spent", "released"].includes(reservation.state) &&
        paymentEffects.some((effect) =>
          ["executing", "submitted", "ambiguous", "retryable", "observed", "failed_terminal"].includes(effect.state)
        );
      if (!submitted) {
        throw new JournalInvariantError(`Purchase ${purchaseId} cannot enter submitted without a fenced Payment Attempt`);
      }
    }
    if (["settled", "fulfilled", "receipted"].includes(state)) {
      if (
        !spend ||
        latestAttempt?.state !== "observed" ||
        reservation?.state !== "spent" ||
        !paymentEffects.some((effect) => effect.state === "observed")
      ) {
        throw new JournalInvariantError(`Purchase ${purchaseId} cannot enter ${state} without verified Settlement`);
      }
    }
    if ((state === "fulfilled" || state === "receipted") && !fulfilment) {
      throw new JournalInvariantError(`Purchase ${purchaseId} cannot enter ${state} without Fulfilment`);
    }
    if (state === "receipted" && (!receiptSet || receipts.length !== PURCHASE_RECEIPT_REQUIREMENTS.length)) {
      throw new JournalInvariantError(`Purchase ${purchaseId} cannot enter receipted without a complete Receipt set`);
    }
  }

  private findPolicy(digest: Sha256Digest): PolicySnapshotRecord | undefined {
    const row = this.db.prepare("SELECT * FROM policy_snapshots WHERE digest = ?").get(digest) as
      | PolicySnapshotRow
      | undefined;
    return row ? policyFromRow(row, this.policyAllowlist(row.digest)) : undefined;
  }

  private canonicalAuthorizationFactsDigest(purchaseId: PurchaseId): Sha256Digest {
    const purchase = this.requirePurchase(purchaseId);
    const terms = this.requireCheckoutTerms(purchaseId);
    const request = this.requireAuthorizationRequest(purchaseId);
    return authorizationFactsDigest({
      purchaseId,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      requestMediaType: request.requestMediaType,
      requestBodyDigest: request.requestBodyDigest,
      terms,
      requestDigest: request.requestDigest,
      nonceDigest: request.nonceDigest,
      additionalCostCeilingAtomic: request.additionalCostCeilingAtomic,
      effectiveFinalityFloor: request.effectiveFinalityFloor,
      createdAtMs: request.createdAtMs,
      expiresAtMs: request.expiresAtMs,
    });
  }

  private policyAllowlist(digest: string): string[] {
    return (
      this.db
        .prepare("SELECT payee FROM policy_allowlist WHERE policy_digest = ? ORDER BY payee")
        .all(digest) as Array<{ payee: string }>
    ).map((row) => row.payee);
  }

  private findReservation(id: string): PolicyReservationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM treasury_reservations WHERE id = ?")
      .get(id) as ReservationRow | undefined;
    return row ? reservationFromRow(row) : undefined;
  }

  private findPaymentAttempt(purchaseId: PurchaseId, attempt: number): PaymentAttemptRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM payment_attempts WHERE purchase_id = ? AND attempt = ?")
      .get(purchaseId, attempt) as PaymentAttemptRow | undefined;
    return row ? paymentAttemptFromRow(row) : undefined;
  }

  private findPaymentPreparation(purchaseId: PurchaseId, attempt: number): PaymentPreparationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM payment_preparations WHERE purchase_id = ? AND attempt = ?")
      .get(purchaseId, attempt) as PaymentPreparationRow | undefined;
    return row ? paymentPreparationFromRow(row) : undefined;
  }

  private findTreasuryStagingPlan(
    purchaseId: PurchaseId,
    attempt: number
  ): TreasuryStagingPlanRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT p.*, e.idempotency_key
           FROM treasury_staging_plans p
           JOIN effects e ON e.id = p.effect_id
          WHERE p.purchase_id = ? AND p.attempt = ?`
      )
      .get(purchaseId, attempt) as TreasuryStagingPlanRow | undefined;
    return row ? treasuryStagingPlanFromRow(row) : undefined;
  }

  private findTreasuryStagingPlanByEffect(effectId: string): TreasuryStagingPlanRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT p.*, e.idempotency_key
           FROM treasury_staging_plans p
           JOIN effects e ON e.id = p.effect_id
          WHERE p.effect_id = ?`
      )
      .get(effectId) as TreasuryStagingPlanRow | undefined;
    return row ? treasuryStagingPlanFromRow(row) : undefined;
  }

  private findTreasuryStagingPlanByReservation(
    reservationId: string
  ): TreasuryStagingPlanRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT p.*, e.idempotency_key
           FROM treasury_staging_plans p
           JOIN effects e ON e.id = p.effect_id
          WHERE p.reservation_id = ?`
      )
      .get(reservationId) as TreasuryStagingPlanRow | undefined;
    return row ? treasuryStagingPlanFromRow(row) : undefined;
  }

  private findTreasuryStagingObservationByEffect(
    effectId: string
  ): TreasuryStagingObservationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM treasury_staging_observations WHERE effect_id = ?")
      .get(effectId) as TreasuryStagingObservationRow | undefined;
    return row ? treasuryStagingObservationFromRow(row) : undefined;
  }

  private findTreasuryStagingRecoveryPlanByEffect(
    effectId: string
  ): TreasuryStagingRecoveryPlanRecord | undefined {
    const row = this.db.prepare(
      `SELECT p.*, e.idempotency_key
         FROM treasury_staging_recovery_plans p
         JOIN effects e ON e.id = p.effect_id
        WHERE p.effect_id = ?`
    ).get(effectId) as TreasuryStagingRecoveryPlanRow | undefined;
    return row ? treasuryStagingRecoveryPlanFromRow(row) : undefined;
  }

  private findTreasuryStagingRecoveryAccounting(
    effectId: string
  ): TreasuryStagingRecoveryAccountingRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM treasury_staging_recovery_accounting WHERE effect_id = ?"
    ).get(effectId) as TreasuryStagingRecoveryAccountingRow | undefined;
    return row ? treasuryStagingRecoveryAccountingFromRow(row) : undefined;
  }

  private findTreasuryStagingRecoveryAccountingByReservation(
    reservationId: string
  ): TreasuryStagingRecoveryAccountingRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM treasury_staging_recovery_accounting WHERE reservation_id = ?"
    ).get(reservationId) as TreasuryStagingRecoveryAccountingRow | undefined;
    return row ? treasuryStagingRecoveryAccountingFromRow(row) : undefined;
  }

  private finalizeTreasuryStagingRecoveryInternal(
    plan: TreasuryStagingRecoveryPlanRecord,
    effect: EffectRecord,
    lease: LeaseToken,
    input: RecordTreasuryStagingRecoveryObservationInput,
    now: number
  ): void {
    const existing = this.findTreasuryStagingRecoveryAccounting(effect.id);
    if (existing) {
      if (
        existing.recoveryTransactionId !== plan.recoveryTransactionId ||
        existing.recoveryOutpoint !== plan.recoveryOutpoint ||
        existing.returnedAmountAtomic !== plan.recoveryAmountAtomic ||
        existing.finality !== input.winningFinality ||
        existing.evidenceDigest !== input.evidenceDigest
      ) {
        throw new JournalInvariantError("conflicting staging recovery accounting");
      }
      return;
    }
    const reservation = this.requireReservation(plan.reservationId);
    if (reservation.state !== "in_flight") {
      throw new JournalInvariantError(
        "observed staging recovery requires the original in-flight Reservation"
      );
    }
    const actualAdditionalCost =
      BigInt(plan.stagingFeeAtomic) + BigInt(plan.recoveryFeeAtomic);
    if (
      actualAdditionalCost > BigInt(plan.authorizedAdditionalCostCeilingAtomic) ||
      plan.authorizedAdditionalCostCeilingAtomic !==
        reservation.additionalCostCeilingAtomic
    ) {
      throw new PolicyReservationError(
        "observed staging recovery exceeds its authorized additional-cost ceiling"
      );
    }
    this.db.prepare(
      `INSERT INTO treasury_staging_recovery_accounting
         (effect_id, reservation_id, purchase_id, attempt,
          recovery_transaction_id, recovery_outpoint, returned_amount_atomic,
          staging_fee_atomic, recovery_fee_atomic, actual_additional_cost_atomic,
          finality, evidence_digest, observed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      effect.id,
      reservation.id,
      effect.purchaseId,
      effect.attempt,
      plan.recoveryTransactionId,
      plan.recoveryOutpoint,
      plan.recoveryAmountAtomic,
      plan.stagingFeeAtomic,
      plan.recoveryFeeAtomic,
      actualAdditionalCost.toString(),
      input.winningFinality,
      input.evidenceDigest,
      now
    );
    this.inject("treasury_staging_recovery_accounting.after_insert");
    const released = this.db.prepare(
      `UPDATE treasury_reservations
          SET state = 'released', release_evidence_digest = ?, updated_at_ms = ?
        WHERE id = ? AND state = 'in_flight'`
    ).run(input.evidenceDigest, now, reservation.id);
    if (released.changes !== 1) {
      throw new JournalInvariantError("concurrent staging recovery Reservation release");
    }
    const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt!);
    if (attempt.state !== "failed") {
      this.transitionAttemptInternal(
        attempt,
        "failed",
        "staging_recovered_without_payment",
        input.evidenceDigest,
        now,
        "staging_recovered_without_payment",
        attempt.state === "submitted"
      );
    }
    this.insertEffectObservation(
      effect.id,
      "observed",
      input.evidenceDigest,
      input.evidenceDigest,
      lease,
      now
    );
    this.updateEffectState(
      effect,
      "observed",
      "staging_recovery_finality_observed",
      input.evidenceDigest,
      now,
      { resultDigest: input.evidenceDigest }
    );
    const purchase = this.requirePurchase(effect.purchaseId);
    if (purchase.state === "failed_recoverable") {
      this.transitionPurchase(
        purchase.id,
        "failed_recoverable",
        "failed_terminal",
        "staging_recovered_without_payment",
        input.evidenceDigest
      );
    }
  }

  private findSpend(reservationId: string): TreasurySpendRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM treasury_spends WHERE reservation_id = ?")
      .get(reservationId) as TreasurySpendRow | undefined;
    return row ? treasurySpendFromRow(row) : undefined;
  }

  private storePreparedMaterial(bytes: Uint8Array, expectedDigest: Sha256Digest): StoredEvidence {
    if (!this.preparedMaterialStore) {
      throw new JournalInvariantError("a prepared-material directory is required for durable execution");
    }
    const stored = this.preparedMaterialStore.store(bytes);
    if (stored.digest !== expectedDigest) {
      throw new JournalInvariantError("prepared material does not match its declared payload digest");
    }
    return stored;
  }

  private readPreparedMaterial(
    digest: Sha256Digest,
    storageRef: string,
    byteLength: number
  ): Buffer {
    if (!this.preparedMaterialStore) {
      throw new JournalInvariantError("prepared-material storage is unavailable");
    }
    const verified = this.preparedMaterialStore.verify(digest, byteLength);
    if (verified.storageRef !== storageRef) {
      throw new JournalInvariantError("prepared-material reference does not match its content address");
    }
    return this.preparedMaterialStore.read(digest, byteLength);
  }

  private evidenceLinked(
    purchaseId: PurchaseId,
    digest: Sha256Digest,
    kind: string,
    attempt?: number
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM evidence_links
         WHERE purchase_id = ? AND digest = ? AND kind = ?
           AND ((? IS NULL AND attempt IS NULL) OR attempt = ?)
         LIMIT 1`
      )
      .get(purchaseId, digest, kind, attempt ?? null, attempt ?? null) as { ok: number } | undefined;
    if (row?.ok !== 1 || !this.evidenceStore) return false;
    try {
      const artifact = this.requireEvidence(digest);
      this.evidenceStore.verify(digest, artifact.byteLength);
      return true;
    } catch {
      return false;
    }
  }

  private isVerifiedEvidenceLinked(
    purchaseId: PurchaseId,
    digest: Sha256Digest,
    options: {
      attempt?: number | null;
      kind?: string;
      verificationProfile?: string;
      verifierId?: string;
    } = {}
  ): boolean {
    const attemptClause =
      options.attempt === null
        ? "AND l.attempt IS NULL"
        : options.attempt === undefined
          ? ""
          : "AND l.attempt = @attempt";
    const kindClause = options.kind === undefined ? "" : "AND l.kind = @kind";
    const verificationProfileClause =
      options.verificationProfile === undefined ? "" : "AND v.profile = @verificationProfile";
    const verifierClause = options.verifierId === undefined ? "" : "AND v.verifier_id = @verifierId";
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
           FROM evidence_links l
          WHERE l.purchase_id = @purchaseId AND l.digest = @digest
            ${attemptClause}
            ${kindClause}
            AND EXISTS (
              SELECT 1 FROM evidence_verifications v
              WHERE v.digest = l.digest ${verificationProfileClause} ${verifierClause}
            )
          LIMIT 1`
      )
      .get({
        purchaseId,
        digest,
        attempt: options.attempt ?? null,
        kind: options.kind ?? null,
        verificationProfile: options.verificationProfile ?? null,
        verifierId: options.verifierId ?? null,
      }) as { ok: number } | undefined;
    if (row?.ok !== 1 || !this.evidenceStore) return false;
    try {
      const artifact = this.requireEvidence(digest);
      this.evidenceStore.verify(digest, artifact.byteLength);
      return true;
    } catch {
      return false;
    }
  }

  private insertPurchaseTransition(
    purchaseId: PurchaseId,
    fromState: PurchaseState | undefined,
    toState: PurchaseState,
    reasonCode: string,
    detailDigest: Sha256Digest | undefined,
    now: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO purchase_transitions
           (purchase_id, from_state, to_state, reason_code, detail_digest, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(purchaseId, fromState ?? null, toState, reasonCode, detailDigest ?? null, now);
  }

  private insertAttemptTransition(
    purchaseId: PurchaseId,
    attempt: number,
    fromState: PaymentAttemptState | undefined,
    toState: PaymentAttemptState,
    reasonCode: string,
    detailDigest: Sha256Digest | undefined,
    now: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO payment_attempt_transitions
           (purchase_id, attempt, from_state, to_state, reason_code, detail_digest, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(purchaseId, attempt, fromState ?? null, toState, reasonCode, detailDigest ?? null, now);
  }

  private transitionAttemptInternal(
    attempt: PaymentAttemptRecord,
    toState: PaymentAttemptState,
    reasonCode: string,
    detailDigest: Sha256Digest | undefined,
    now: number,
    failureCode?: string,
    proofBackedSubmittedFailure = false
  ): void {
    assertAttemptTransition(attempt.state, toState, proofBackedSubmittedFailure);
    const result = this.db
      .prepare(
        `UPDATE payment_attempts
         SET state = ?, version = version + 1, failure_code = ?, updated_at_ms = ?
         WHERE purchase_id = ? AND attempt = ? AND state = ? AND version = ?`
      )
      .run(toState, failureCode ?? null, now, attempt.purchaseId, attempt.attempt, attempt.state, attempt.version);
    if (result.changes !== 1) {
      throw new JournalInvariantError(`concurrent Payment Attempt transition for ${attempt.purchaseId}/${attempt.attempt}`);
    }
    this.insertAttemptTransition(
      attempt.purchaseId,
      attempt.attempt,
      attempt.state,
      toState,
      reasonCode,
      detailDigest,
      now
    );
  }

  private claimEffectInternal(effect: EffectRecord, holder: string, ttlMs: number): EffectClaim | undefined {
    if (effect.state !== "planned" && effect.state !== "retryable") {
      throw new JournalInvariantError(`Effect ${effect.id} cannot be claimed from ${effect.state}`);
    }
    const now = this.timestamp();
    const leaseName = `effect:${effect.id}`;
    const lease = this.acquireLeaseInternal(leaseName, holder, ttlMs, now);
    if (!lease) return undefined;
    const updated = this.db
      .prepare(
        `UPDATE effects
         SET state = 'executing', version = version + 1,
             claim_lease_name = ?, claim_generation = ?, executing_at_ms = ?, updated_at_ms = ?
         WHERE id = ? AND state = ? AND version = ?`
      )
      .run(lease.name, lease.generation, now, now, effect.id, effect.state, effect.version);
    if (updated.changes !== 1) throw new JournalInvariantError(`concurrent Effect claim for ${effect.id}`);
    this.inject("effect_claim.after_effect_update");
    this.insertEffectTransition(
      effect.id,
      effect.state,
      "executing",
      "effect_claimed",
      effect.payloadDigest,
      now
    );
    return { effect: this.requireEffect(effect.id), lease };
  }

  private transitionClaimedEffect(
    claim: EffectClaim,
    expectedState: EffectState,
    toState: EffectState,
    reasonCode: string,
    detailDigest: Sha256Digest | undefined,
    updates: { submissionDigest?: Sha256Digest; resultDigest?: Sha256Digest; errorCode?: string }
  ): EffectRecord {
    const transition = this.db.transaction(() => {
      this.assertEffectWriter(claim.effect.id, claim.lease);
      const current = this.requireEffect(claim.effect.id);
      if (current.state === toState) {
        if (updates.submissionDigest && current.submissionDigest !== updates.submissionDigest) {
          throw new JournalInvariantError(`conflicting Effect submission for ${current.id}`);
        }
        return current;
      }
      if (current.state !== expectedState) {
        throw new JournalInvariantError(`Effect ${current.id} expected ${expectedState}, found ${current.state}`);
      }
      this.updateEffectState(current, toState, reasonCode, detailDigest, this.timestamp(), updates);
      return this.requireEffect(current.id);
    });
    return transition.immediate();
  }

  private updateEffectState(
    effect: EffectRecord,
    toState: EffectState,
    reasonCode: string,
    detailDigest: Sha256Digest | undefined,
    now: number,
    updates: { submissionDigest?: Sha256Digest; resultDigest?: Sha256Digest; errorCode?: string } = {}
  ): void {
    assertEffectTransition(effect.state, toState);
    const result = this.db
      .prepare(
        `UPDATE effects SET
           state = ?, version = version + 1,
           submission_digest = COALESCE(?, submission_digest),
           result_digest = COALESCE(?, result_digest),
           error_code = COALESCE(?, error_code),
           submitted_at_ms = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at_ms END,
           observed_at_ms = CASE WHEN ? = 'observed' THEN ? ELSE observed_at_ms END,
           updated_at_ms = ?
         WHERE id = ? AND state = ? AND version = ?`
      )
      .run(
        toState,
        updates.submissionDigest ?? null,
        updates.resultDigest ?? null,
        updates.errorCode ?? null,
        toState,
        now,
        toState,
        now,
        now,
        effect.id,
        effect.state,
        effect.version
    );
    if (result.changes !== 1) throw new JournalInvariantError(`concurrent Effect transition for ${effect.id}`);
    this.insertEffectTransition(effect.id, effect.state, toState, reasonCode, detailDigest, now);
  }

  private insertEffectTransition(
    effectId: string,
    fromState: EffectState | undefined,
    toState: EffectState,
    reasonCode: string,
    detailDigest: Sha256Digest | undefined,
    now: number
  ): void {
    assertCode(reasonCode, "Effect transition reason code");
    if (detailDigest) assertDigest(detailDigest, "Effect transition detail digest");
    this.db
      .prepare(
        `INSERT INTO effect_transitions
           (effect_id, from_state, to_state, reason_code, detail_digest, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(effectId, fromState ?? null, toState, reasonCode, detailDigest ?? null, now);
  }

  private insertEffectObservation(
    effectId: string,
    status: EffectObservationRecord["status"],
    resultDigest: Sha256Digest | undefined,
    detailDigest: Sha256Digest | undefined,
    lease: LeaseToken,
    now: number
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO effect_observations
           (effect_id, status, result_digest, detail_digest, lease_name, lease_generation, observed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        effectId,
        status,
        resultDigest ?? null,
        detailDigest ?? null,
        lease.name,
        lease.generation,
        now
      );
  }

  private acquireLeaseInternal(name: string, holder: string, ttlMs: number, now: number): LeaseToken | undefined {
    validateLeaseFields(name, holder, ttlMs);
    const expiresAtMs = safeExpiry(now, ttlMs);
    const row = this.db.prepare("SELECT * FROM leases WHERE name = ?").get(name) as LeaseRow | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO leases (name, holder, generation, expires_at_ms, updated_at_ms) VALUES (?, ?, 1, ?, ?)")
        .run(name, holder, expiresAtMs, now);
      return { name, holder, generation: 1, expiresAtMs };
    }
    if (row.expires_at_ms > now) return undefined;
    const generation = row.generation + 1;
    const updated = this.db
      .prepare(
        `UPDATE leases SET holder = ?, generation = ?, expires_at_ms = ?, updated_at_ms = ?
         WHERE name = ? AND generation = ? AND expires_at_ms = ?`
      )
      .run(holder, generation, expiresAtMs, now, name, row.generation, row.expires_at_ms);
    if (updated.changes !== 1) throw new JournalFencingError(`concurrent lease acquisition for ${name}`);
    return { name, holder, generation, expiresAtMs };
  }

  private assertLeaseInternal(token: LeaseToken, now = this.timestamp()): void {
    const row = this.db.prepare("SELECT * FROM leases WHERE name = ?").get(token.name) as LeaseRow | undefined;
    if (
      !row ||
      row.holder !== token.holder ||
      row.generation !== token.generation ||
      row.expires_at_ms <= now
    ) {
      throw new JournalFencingError(`lease token for ${token.name} is stale or expired`);
    }
  }

  private assertRecoveryLease(token: LeaseToken, purchaseId?: PurchaseId): void {
    const scoped = purchaseId ? `purchase-reconciliation:${purchaseId}` : undefined;
    if (token.name !== "purchase-reconciliation" && token.name !== scoped) {
      throw new JournalFencingError("reconciliation writes require the recovery lease");
    }
    this.assertLeaseInternal(token);
  }

  private assertEffectWriter(effectId: string, token: LeaseToken): void {
    this.assertLeaseInternal(token);
    const effect = this.requireEffect(effectId);
    if (
      token.name === "purchase-reconciliation" ||
      token.name === `purchase-reconciliation:${effect.purchaseId}`
    ) {
      if (this.effectClaimActiveInternal(effect, this.timestamp())) {
        throw new JournalEffectBusyError(`Effect ${effectId} still has a live executor fence`);
      }
      return;
    }
    if (
      token.name !== `effect:${effectId}` ||
      effect.claimLeaseName !== token.name ||
      effect.claimGeneration !== token.generation
    ) {
      throw new JournalFencingError(`lease token cannot write Effect ${effectId}`);
    }
  }

  private effectClaimActiveInternal(effect: EffectRecord, now: number): boolean {
    if (!effect.claimLeaseName || effect.claimGeneration === undefined) return false;
    const lease = this.db.prepare("SELECT * FROM leases WHERE name = ?").get(effect.claimLeaseName) as
      | LeaseRow
      | undefined;
    return Boolean(
      lease &&
        lease.generation === effect.claimGeneration &&
        lease.expires_at_ms > now
    );
  }

  private expireReservationsInternal(now: number): number {
    return this.db
      .prepare(
        `UPDATE treasury_reservations
         SET state = 'expired', updated_at_ms = ?
         WHERE state = 'active' AND expires_at_ms <= ?`
      )
      .run(now, now).changes;
  }

  private assertDirectTreasuryCapacity(
    policy: PolicySnapshotRecord,
    kind: TreasuryOperationRecord["kind"],
    destination: string,
    amountAtomic: string,
    feeAtomic: string,
    now: number,
    excludeOperationKey?: string
  ): void {
    if (
      kind !== "vault_deposit" &&
      policy.allowlist.length > 0 &&
      !policy.allowlist.includes(destination)
    ) {
      throw new PolicyReservationError(
        `payee ${destination} is not on the active policy allowlist`
      );
    }
    const amount = decimalBigInt(
      amountAtomic,
      "direct Treasury amount",
      kind === "vault_deposit"
    );
    const fee = decimalBigInt(feeAtomic, "direct Treasury fee ceiling", true);
    const policyAmount = kind === "vault_deposit" ? 0n : amount;
    const gross = policyAmount + fee;
    const maxPerPayment = decimalBigInt(policy.maxPerPaymentAtomic, "per-payment limit");
    const maxPerHour = decimalBigInt(policy.maxPerHourAtomic, "hourly limit");
    const approvalThreshold = decimalBigInt(
      policy.approvalAboveAtomic,
      "approval threshold",
      true
    );
    if (gross > maxPerPayment) {
      throw new PolicyReservationError(
        `gross direct Treasury movement ${gross} exceeds per-payment limit ${maxPerPayment}`
      );
    }
    if (approvalThreshold > 0n && policyAmount > approvalThreshold) {
      throw new PolicyReservationError(
        "direct Treasury movement exceeds the operator approval threshold; use a Purchase authorization or operator-controlled transaction"
      );
    }
    const used = this.policyCapacityUsedInternal(now, excludeOperationKey);
    if (used + gross > maxPerHour) {
      throw new PolicyReservationError(
        `gross direct Treasury movement ${gross} would exceed hourly limit ${maxPerHour}; ${used} already used or reserved`
      );
    }
  }

  private insertTreasuryOperationTransition(
    operationKey: string,
    fromState: TreasuryOperationState | undefined,
    toState: TreasuryOperationState,
    reason: string,
    createdAtMs: number
  ): void {
    this.db.prepare(
      `INSERT INTO treasury_operation_transitions
         (operation_key, from_state, to_state, reason, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run(operationKey, fromState ?? null, toState, reason, createdAtMs);
  }

  private policyCapacityUsedInternal(now: number, excludeOperationKey?: string): bigint {
    const reservationRows = this.db
      .prepare(
        `SELECT amount_atomic, additional_cost_ceiling_atomic FROM treasury_reservations
         WHERE (state = 'active' AND expires_at_ms > ?) OR state = 'in_flight'`
      )
      .all(now) as Array<{ amount_atomic: string; additional_cost_ceiling_atomic: string }>;
    const cutoff = now - 60 * 60 * 1000;
    const spendRows = this.db
      .prepare(
        `SELECT actual_amount_atomic, actual_additional_cost_atomic FROM treasury_spends
         WHERE observed_at_ms >= ?`
      )
      .all(cutoff) as Array<{ actual_amount_atomic: string; actual_additional_cost_atomic: string }>;
    const recoveryRows = this.db
      .prepare(
        `SELECT actual_additional_cost_atomic
           FROM treasury_staging_recovery_accounting
          WHERE observed_at_ms >= ?`
      )
      .all(cutoff) as Array<{ actual_additional_cost_atomic: string }>;
    const directRows = this.db.prepare(
      `SELECT kind, state, resolved_amount_atomic, fee_atomic,
              fee_ceiling_atomic, requested_amount_atomic
         FROM treasury_operations
        WHERE operation_key <> COALESCE(?, '')
          AND (
            state IN ('intent', 'prepared', 'submission_planned', 'submitted', 'observed')
            OR (state = 'completed' AND completed_at_ms >= ?)
          )`
    ).all(excludeOperationKey ?? null, cutoff) as Array<{
      resolved_amount_atomic: string | null;
      fee_atomic: string | null;
      fee_ceiling_atomic: string;
      requested_amount_atomic: string;
      kind: TreasuryOperationRecord["kind"];
      state: TreasuryOperationState;
    }>;
    return (
      reservationRows.reduce(
        (total, row) => total + BigInt(row.amount_atomic) + BigInt(row.additional_cost_ceiling_atomic),
        0n
      ) +
      spendRows.reduce(
        (total, row) => total + BigInt(row.actual_amount_atomic) + BigInt(row.actual_additional_cost_atomic),
        0n
      ) +
      recoveryRows.reduce(
        (total, row) => total + BigInt(row.actual_additional_cost_atomic),
        0n
      ) +
      directRows.reduce((total, row) => {
        const amount = row.kind === "vault_deposit"
          ? "0"
          : row.resolved_amount_atomic ??
            (row.requested_amount_atomic === "max" ? "0" : row.requested_amount_atomic);
        const fee = row.state === "completed"
          ? row.fee_atomic ?? row.fee_ceiling_atomic
          : row.fee_ceiling_atomic;
        return total + BigInt(amount) + BigInt(fee);
      }, 0n)
    );
  }

  private ensureAdmissionBudget(): void {
    if (!this.admission) return;
    const existing = this.db.prepare(
      "SELECT * FROM journal_admission_budget WHERE singleton = 1"
    ).get() as {
      prevalidation_purchase_limit: number;
      evidence_byte_limit: number;
      direct_treasury_retry_limit: number;
    } | undefined;
    if (existing) {
      if (
        existing.prevalidation_purchase_limit !== this.admission.prevalidationPurchases ||
        existing.evidence_byte_limit !== this.admission.evidenceBytes ||
        existing.direct_treasury_retry_limit !== this.admission.directTreasuryRetries
      ) {
        throw new JournalInvariantError("Purchase Journal admission projection changed without a new Operator Manifest");
      }
      return;
    }
    this.db.prepare(
      `INSERT INTO journal_admission_budget
         (singleton, prevalidation_purchase_limit, evidence_byte_limit,
          direct_treasury_retry_limit, updated_at_ms)
       VALUES (1, ?, ?, ?, ?)`
    ).run(
      this.admission.prevalidationPurchases,
      this.admission.evidenceBytes,
      this.admission.directTreasuryRetries,
      this.timestamp(),
    );
  }

  private readAdmissionProjection(): AdmissionBudgetProjection | undefined {
    const row = this.db.prepare(
      `SELECT prevalidation_purchase_limit, evidence_byte_limit,
              direct_treasury_retry_limit
         FROM journal_admission_budget WHERE singleton = 1`
    ).get() as {
      prevalidation_purchase_limit: number;
      evidence_byte_limit: number;
      direct_treasury_retry_limit: number;
    } | undefined;
    if (!row) return undefined;
    return {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: row.prevalidation_purchase_limit,
      evidenceBytes: row.evidence_byte_limit,
      directTreasuryRetries: row.direct_treasury_retry_limit,
    };
  }

  private admitPurchaseInternal(input: CreatePurchaseInput, now: number): string | undefined {
    if (!this.admission) return undefined;
    const budget = this.db.prepare(
      "SELECT reserved_purchase_count, prevalidation_purchase_limit FROM journal_admission_budget WHERE singleton = 1"
    ).get() as { reserved_purchase_count: number; prevalidation_purchase_limit: number } | undefined;
    if (!budget) throw new JournalInvariantError("Journal admission budget is missing");
    if (budget.reserved_purchase_count >= budget.prevalidation_purchase_limit) {
      throw new PurchaseAdmissionError();
    }
    const leaseId = `purchase:${input.id}`;
    this.db.prepare(
      `INSERT INTO admission_leases
         (lease_id, owner, resource, purchase_id, quantity, state,
          deadline_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'prevalidation_purchase', ?, 1, 'admitted', ?, ?, ?)`
    ).run(leaseId, `purchase-journal:${process.pid}`, input.id, now + 60_000, now, now);
    this.db.prepare(
      "UPDATE admission_leases SET state = 'active', updated_at_ms = ? WHERE lease_id = ?"
    ).run(now, leaseId);
    this.db.prepare(
      `UPDATE journal_admission_budget
          SET reserved_purchase_count = reserved_purchase_count + 1, updated_at_ms = ?
        WHERE singleton = 1`
    ).run(now);
    return leaseId;
  }

  private completePurchaseAdmissionInternal(leaseId: string | undefined, now: number): void {
    if (!leaseId) return;
    const updated = this.db.prepare(
      `UPDATE admission_leases
          SET state = 'completed', outcome = 'purchase_retained', updated_at_ms = ?
        WHERE lease_id = ? AND state = 'active'`
    ).run(now, leaseId);
    if (updated.changes !== 1) throw new JournalInvariantError("Purchase Admission Lease was released more than once");
  }

  private admitEvidenceInternal(
    purchaseId: PurchaseId,
    digest: Sha256Digest,
    byteLength: number,
  ): string | undefined {
    if (!this.admission) return undefined;
    const acquire = this.db.transaction(() => {
      this.requirePurchase(purchaseId);
      const existing = this.findEvidence(digest);
      const quantity = existing ? 0 : byteLength;
      const budget = this.db.prepare(
        `SELECT reserved_evidence_bytes, committed_evidence_bytes, evidence_byte_limit
           FROM journal_admission_budget WHERE singleton = 1`
      ).get() as {
        reserved_evidence_bytes: number;
        committed_evidence_bytes: number;
        evidence_byte_limit: number;
      } | undefined;
      if (!budget) throw new JournalInvariantError("Journal admission budget is missing");
      if (budget.reserved_evidence_bytes + budget.committed_evidence_bytes + quantity > budget.evidence_byte_limit) {
        throw new EvidenceAdmissionError();
      }
      const leaseId = `evidence:${process.pid}:${randomBytes(12).toString("hex")}`;
      const now = this.timestamp();
      this.db.prepare(
        `INSERT INTO admission_leases
           (lease_id, owner, resource, purchase_id, digest, storage_ref, quantity,
            state, deadline_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'evidence_bytes', ?, ?, ?, ?, 'admitted', ?, ?, ?)`
      ).run(
        leaseId,
        `purchase-journal:${process.pid}`,
        purchaseId,
        digest,
        storageRefForDigest(digest),
        quantity,
        now + 60_000,
        now,
        now,
      );
      this.db.prepare(
        "UPDATE admission_leases SET state = 'active', updated_at_ms = ? WHERE lease_id = ?"
      ).run(now, leaseId);
      if (quantity > 0) {
        this.db.prepare(
          `UPDATE journal_admission_budget
              SET reserved_evidence_bytes = reserved_evidence_bytes + ?, updated_at_ms = ?
            WHERE singleton = 1`
        ).run(quantity, now);
      }
      return leaseId;
    });
    return acquire.immediate();
  }

  private completeEvidenceAdmissionInternal(
    leaseId: string | undefined,
    uniqueBlob: boolean,
    now: number,
  ): void {
    if (!leaseId) return;
    const lease = this.db.prepare(
      "SELECT quantity, state FROM admission_leases WHERE lease_id = ?"
    ).get(leaseId) as { quantity: number; state: string } | undefined;
    if (!lease || lease.state !== "active") {
      throw new JournalInvariantError("Evidence Admission Lease was released more than once");
    }
    const updated = this.db.prepare(
      `UPDATE admission_leases
          SET state = 'completed', outcome = ?, updated_at_ms = ?
        WHERE lease_id = ? AND state = 'active'`
    ).run(uniqueBlob ? "blob_committed" : "blob_deduplicated", now, leaseId);
    if (updated.changes !== 1) throw new JournalInvariantError("Evidence Admission Lease completion raced");
    if (lease.quantity > 0) {
      this.db.prepare(
        `UPDATE journal_admission_budget
            SET reserved_evidence_bytes = reserved_evidence_bytes - ?,
                committed_evidence_bytes = committed_evidence_bytes + ?,
                updated_at_ms = ?
          WHERE singleton = 1`
      ).run(lease.quantity, uniqueBlob ? lease.quantity : 0, now);
    }
  }

  private cancelEvidenceAdmission(leaseId: string | undefined, outcome: string): void {
    if (!leaseId || !this.admission) return;
    let storageRef: string | undefined;
    let digest: Sha256Digest | undefined;
    const cancel = this.db.transaction(() => {
      const lease = this.db.prepare(
        "SELECT quantity, state, storage_ref, digest FROM admission_leases WHERE lease_id = ?"
      ).get(leaseId) as { quantity: number; state: string; storage_ref: string | null; digest: string | null } | undefined;
      if (!lease) return;
      if (lease.state !== "active") return;
      storageRef = lease.storage_ref ?? undefined;
      digest = lease.digest as Sha256Digest | undefined;
      const now = this.timestamp();
      this.db.prepare(
        `UPDATE admission_leases
            SET state = 'cancelled', outcome = ?, updated_at_ms = ?
          WHERE lease_id = ? AND state = 'active'`
      ).run(outcome, now, leaseId);
      if (lease.quantity > 0) {
        this.db.prepare(
          `UPDATE journal_admission_budget
              SET reserved_evidence_bytes = reserved_evidence_bytes - ?, updated_at_ms = ?
            WHERE singleton = 1`
        ).run(lease.quantity, now);
      }
    });
    cancel.immediate();
    if (storageRef && digest && !this.findEvidence(digest)) {
      this.evidenceStore?.removeUnreferenced(digest);
    }
  }

  private reconcileAdmissionLeases(): void {
    if (!this.admission || !this.evidenceStore) return;
    const remove = new Set<Sha256Digest>();
    const reconcile = this.db.transaction(() => {
      const leases = this.db.prepare(
        `SELECT lease_id, resource, purchase_id, digest, quantity, state
           FROM admission_leases WHERE state IN ('offered', 'admitted', 'active')`
      ).all() as Array<{
        lease_id: string;
        resource: string;
        purchase_id: string | null;
        digest: string | null;
        quantity: number;
        state: string;
      }>;
      const now = this.timestamp();
      for (const lease of leases) {
        if (lease.resource === "prevalidation_purchase") {
          const purchase = lease.purchase_id
            ? this.db.prepare("SELECT id FROM purchases WHERE id = ?").get(lease.purchase_id)
            : undefined;
          if (purchase) {
            this.db.prepare(
              `UPDATE admission_leases SET state = 'completed', outcome = 'purchase_retained', updated_at_ms = ?
                WHERE lease_id = ? AND state IN ('offered', 'admitted', 'active')`
            ).run(now, lease.lease_id);
          } else {
            this.db.prepare(
              `UPDATE admission_leases SET state = 'cancelled', outcome = 'restart_recovery', updated_at_ms = ?
                WHERE lease_id = ? AND state IN ('offered', 'admitted', 'active')`
            ).run(now, lease.lease_id);
          }
          continue;
        }
        const linked = lease.purchase_id && lease.digest
          ? this.db.prepare(
              "SELECT 1 FROM evidence_links WHERE purchase_id = ? AND digest = ? LIMIT 1"
            ).get(lease.purchase_id, lease.digest)
          : undefined;
        const artifact = lease.digest
          ? this.db.prepare("SELECT 1 FROM evidence_artifacts WHERE digest = ?").get(lease.digest)
          : undefined;
        if (linked && artifact) {
          this.db.prepare(
            `UPDATE admission_leases SET state = 'completed', outcome = 'restart_recovered', updated_at_ms = ?
              WHERE lease_id = ? AND state IN ('offered', 'admitted', 'active')`
          ).run(now, lease.lease_id);
        } else {
          this.db.prepare(
            `UPDATE admission_leases SET state = 'cancelled', outcome = 'restart_recovered', updated_at_ms = ?
              WHERE lease_id = ? AND state IN ('offered', 'admitted', 'active')`
          ).run(now, lease.lease_id);
          if (lease.digest && !artifact) remove.add(lease.digest as Sha256Digest);
        }
      }
      this.db.prepare(
        `UPDATE journal_admission_budget
            SET reserved_purchase_count = (
                  SELECT COUNT(*) FROM admission_leases
                   WHERE resource = 'prevalidation_purchase'
                     AND state NOT IN ('cancelled', 'expired', 'failed_terminal')
                ),
                reserved_evidence_bytes = (
                  SELECT COALESCE(SUM(quantity), 0) FROM admission_leases
                   WHERE resource = 'evidence_bytes' AND state IN ('offered', 'admitted', 'active')
                ),
                committed_evidence_bytes = (
                  SELECT COALESCE(SUM(quantity), 0) FROM admission_leases
                   WHERE resource = 'evidence_bytes' AND state = 'completed' AND outcome IN ('blob_committed', 'restart_recovered')
                ),
                updated_at_ms = ?
          WHERE singleton = 1`
      ).run(now);
    });
    reconcile.immediate();
    for (const digest of remove) {
      if (!this.findEvidence(digest)) this.evidenceStore.removeUnreferenced(digest);
    }
  }

  private inject(point: JournalFaultPoint): void {
    this.faultInjector?.(point);
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new JournalInvariantError("clock returned invalid timestamp");
    return value;
  }
}

interface PurchaseRow {
  id: string;
  request_key: string;
  state: PurchaseState;
  resource_url: string;
  method: string;
  resource_fingerprint: string;
  expected_merchant_id: string | null;
  expected_merchant_origin: string | null;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ChainEvidenceRow {
  detail_digest: string;
  profile: string;
  operation_id: string;
  operation: ChainEvidenceRecord["operation"];
  transaction_id: string;
  status: ChainEvidenceRecord["status"];
  level: ChainEvidenceRecord["level"] | null;
  view: ChainEvidenceRecord["view"] | null;
  mechanism: ChainEvidenceRecord["mechanism"];
  protocol_finality: ChainEvidenceRecord["protocolFinality"];
  operator_floor: ChainEvidenceRecord["operatorFloor"];
  effective_floor: ChainEvidenceRecord["effectiveFloor"];
  primary_profile: string;
  witness_profile: string;
  block_hash: string | null;
  accepting_block_hash: string | null;
  accepting_block_daa_score: string | null;
  virtual_daa_score: string | null;
  outputs_digest: string;
  observed_at_ms: number;
}

interface TreasuryOperationRow {
  operation_key: string;
  request_digest: string;
  kind: string;
  destination: string;
  requested_amount_atomic: string;
  keep_float_atomic: string | null;
  fee_ceiling_atomic: string;
  resolved_amount_atomic: string | null;
  fee_atomic: string | null;
  transaction_id: string | null;
  prepared_digest: string | null;
  prepared_ref: string | null;
  prepared_byte_length: number | null;
  policy_digest: string;
  retry_limit: number;
  cancellation_requested: number;
  state: string;
  retry_count: number;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
}

interface PurchaseTransitionRow {
  sequence: number;
  purchase_id: string;
  from_state: PurchaseState | null;
  to_state: PurchaseState;
  reason_code: string;
  detail_digest: string | null;
  created_at_ms: number;
}

interface CheckoutTermsRow {
  purchase_id: string;
  merchant_id: string;
  merchant_name: string;
  merchant_origin: string;
  resource_fingerprint: string;
  amount_atomic: string;
  asset: string;
  network: string;
  pay_to: string;
  expires_at: string;
  expires_at_ms: number;
  checkout_digest: string;
  checkout_evidence_digest: string;
  checkout_verification_profile: string;
  checkout_verifier_id: string;
  payment_requirements_digest: string;
  payment_requirements_verification_profile: string;
  payment_requirements_verifier_id: string;
  created_at_ms: number;
}

interface AuthorizationRequestRow {
  purchase_id: string;
  checkout_digest: string;
  request_digest: string;
  nonce_digest: string;
  request_media_type: string;
  request_body_digest: string;
  additional_cost_ceiling_atomic: string;
  effective_finality_floor: "accepted" | "depth-confirmed";
  expires_at_ms: number;
  created_at_ms: number;
}

interface AuthorizationRow {
  purchase_id: string;
  decision: AuthorizationRecord["decision"];
  authority_id: string;
  checkout_digest: string;
  approved_facts_digest: string;
  evidence_digest: string;
  verification_profile: string;
  verifier_id: string;
  request_digest: string;
  nonce_digest: string;
  expires_at_ms: number;
  decided_at_ms: number;
}

interface FulfilmentRow {
  purchase_id: string;
  attempt: number;
  http_status: number;
  resource_fingerprint: string;
  body_digest: string;
  body_byte_length: number;
  media_type: string;
  merchant_evidence_digest: string;
  merchant_verification_profile: string;
  merchant_verifier_id: string;
  created_at_ms: number;
}

interface ReceiptRow {
  id: number;
  purchase_id: string;
  role: string;
  canonical_digest: string;
  evidence_digest: string;
  profile: string;
  issuer: string | null;
  verifier_id: string;
  checkout_digest: string;
  authorization_evidence_digest: string;
  settlement_evidence_digest: string;
  fulfilment_digest: string;
  created_at_ms: number;
}

interface ReceiptSetRow {
  purchase_id: string;
  profile: string;
  canonical_digest: string;
  completed_at_ms: number;
}

interface EvidenceLinkRow {
  purchase_id: string;
  digest: string;
  kind: string;
  attempt: number | null;
  media_type: string;
  profile: string;
  issuer: string | null;
  attached_at_ms: number;
}

interface EvidenceAttachmentRow extends EvidenceLinkRow {
  byte_length: number;
  storage_ref: string;
  blob_created_at_ms: number;
}

interface EvidenceArtifactRow {
  digest: string;
  media_type: string;
  profile: string;
  issuer: string | null;
  byte_length: number;
  storage_ref: string;
  created_at_ms: number;
}

interface PolicySnapshotRow {
  digest: string;
  version: number;
  max_per_payment_atomic: string;
  max_per_hour_atomic: string;
  approval_above_atomic: string;
  activated_at_ms: number;
}

interface ReservationRow {
  id: string;
  purchase_id: string;
  policy_digest: string;
  approval_evidence_digest: string | null;
  approval_verification_profile: string | null;
  approval_verifier_id: string | null;
  payee: string;
  amount_atomic: string;
  additional_cost_ceiling_atomic: string;
  funding_source: FundingSource;
  state: ReservationState;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  in_flight_at_ms: number | null;
  spent_at_ms: number | null;
  release_evidence_digest: string | null;
}

interface PaymentAttemptRow {
  purchase_id: string;
  attempt: number;
  identifier: string;
  state: PaymentAttemptState;
  version: number;
  failure_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface PaymentAttemptTransitionRow {
  sequence: number;
  purchase_id: string;
  attempt: number;
  from_state: PaymentAttemptState | null;
  to_state: PaymentAttemptState;
  reason_code: string;
  detail_digest: string | null;
  created_at_ms: number;
}

interface PaymentPreparationRow {
  purchase_id: string;
  attempt: number;
  reservation_id: string;
  requirements_digest: string;
  payload_digest: string;
  prepared_ref: string;
  prepared_byte_length: number;
  transaction_id: string;
  amount_atomic: string;
  asset: string;
  network: string;
  payee: string;
  required_finality: string;
  funding_source: FundingSource;
  created_at_ms: number;
}

interface TreasuryStagingPlanRow {
  effect_id: string;
  purchase_id: string;
  attempt: number;
  reservation_id: string;
  idempotency_key: string;
  payload_digest: string;
  prepared_ref: string;
  prepared_byte_length: number;
  planned_transaction_id: string;
  expected_outpoint: string;
  staging_amount_atomic: string;
  funding_source: FundingSource;
  created_at_ms: number;
}

interface TreasuryStagingObservationRow {
  effect_id: string;
  purchase_id: string;
  attempt: number;
  reservation_id: string;
  transaction_id: string;
  outpoint: string;
  staging_amount_atomic: string;
  funding_source: FundingSource;
  evidence_digest: string;
  evidence_verification_profile: string;
  evidence_verifier_id: string;
  observed_at_ms: number;
}

interface TreasuryStagingRecoveryPlanRow {
  effect_id: string;
  purchase_id: string;
  attempt: number;
  reservation_id: string;
  staging_effect_id: string;
  idempotency_key: string;
  payload_digest: string;
  prepared_ref: string;
  prepared_byte_length: number;
  exact_transaction_id: string | null;
  recovery_transaction_id: string;
  recovery_outpoint: string;
  recovery_amount_atomic: string;
  staging_fee_atomic: string;
  recovery_fee_atomic: string;
  required_finality: string;
  authorized_additional_cost_ceiling_atomic: string;
  created_at_ms: number;
}

interface TreasuryStagingRecoveryObservationRow {
  sequence: number;
  effect_id: string;
  status: TreasuryStagingRecoveryObservationStatus;
  evidence_digest: string;
  readiness_proof_digest: string | null;
  readiness_observed_at_ms: number | null;
  readiness_expires_at_ms: number | null;
  winning_transaction_id: string | null;
  winning_finality: string | null;
  recovery_outpoint: string | null;
  recovery_amount_atomic: string | null;
  conflict_reason: string | null;
  lease_name: string;
  lease_generation: number;
  observed_at_ms: number;
}

interface TreasuryStagingRecoveryAccountingRow {
  effect_id: string;
  reservation_id: string;
  purchase_id: string;
  attempt: number;
  recovery_transaction_id: string;
  recovery_outpoint: string;
  returned_amount_atomic: string;
  staging_fee_atomic: string;
  recovery_fee_atomic: string;
  actual_additional_cost_atomic: string;
  finality: string;
  evidence_digest: string;
  observed_at_ms: number;
}

interface EffectRow {
  id: string;
  purchase_id: string;
  attempt: number | null;
  kind: string;
  idempotency_key: string;
  state: EffectState;
  version: number;
  payload_digest: string;
  prepared_ref: string;
  prepared_byte_length: number;
  claim_lease_name: string | null;
  claim_generation: number | null;
  submission_digest: string | null;
  result_digest: string | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  executing_at_ms: number | null;
  submitted_at_ms: number | null;
  observed_at_ms: number | null;
}

interface EffectObservationRow {
  id: number;
  effect_id: string;
  status: EffectObservationRecord["status"];
  result_digest: string | null;
  detail_digest: string | null;
  lease_name: string;
  lease_generation: number;
  observed_at_ms: number;
}

interface EffectTransitionRow {
  sequence: number;
  effect_id: string;
  from_state: EffectState | null;
  to_state: EffectState;
  reason_code: string;
  detail_digest: string | null;
  created_at_ms: number;
}

interface TreasurySpendRow {
  id: number;
  effect_id: string;
  reservation_id: string;
  purchase_id: string;
  attempt: number;
  transaction_id: string;
  outpoint: string | null;
  actual_amount_atomic: string;
  actual_additional_cost_atomic: string;
  asset: string;
  payee: string;
  network: string;
  finality: string;
  funding_source: FundingSource;
  evidence_digest: string;
  evidence_verification_profile: string;
  evidence_verifier_id: string;
  observed_at_ms: number;
}

interface LeaseRow {
  name: string;
  holder: string;
  generation: number;
  expires_at_ms: number;
  updated_at_ms: number;
}

interface ReconciliationRunRow {
  id: number;
  purchase_id: string;
  effect_id: string | null;
  outcome: string;
  detail_digest: string | null;
  lease_name: string;
  lease_generation: number;
  created_at_ms: number;
}

function purchaseFromRow(row: PurchaseRow): PurchaseRecord {
  return {
    id: row.id as PurchaseId,
    requestKey: row.request_key as PurchaseRequestKey,
    state: row.state,
    resourceUrl: row.resource_url,
    method: row.method,
    resourceFingerprint: row.resource_fingerprint as Sha256Digest,
    expectedMerchantId: row.expected_merchant_id ?? undefined,
    expectedMerchantOrigin: row.expected_merchant_origin ?? undefined,
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function treasuryOperationFromRow(row: TreasuryOperationRow): TreasuryOperationRecord {
  const state = row.state as TreasuryOperationState;
  if (![
    "intent",
    "prepared",
    "submission_planned",
    "submitted",
    "observed",
    "completed",
    "failed_terminal",
  ].includes(state)) {
    throw new JournalInvariantError("direct Treasury operation state is invalid");
  }
  const operation: TreasuryOperationRecord = Object.freeze({
    operationKey: row.operation_key,
    requestDigest: row.request_digest,
    kind: row.kind as TreasuryOperationRecord["kind"],
    destination: row.destination,
    requestedAmountAtomic: row.requested_amount_atomic,
    ...(row.keep_float_atomic === null ? {} : { keepFloatAtomic: row.keep_float_atomic }),
    feeCeilingAtomic: row.fee_ceiling_atomic,
    retryLimit: row.retry_limit,
    cancellationRequested: row.cancellation_requested === 1,
    ...(row.resolved_amount_atomic === null
      ? {}
      : { resolvedAmountAtomic: row.resolved_amount_atomic }),
    ...(row.fee_atomic === null ? {} : { feeAtomic: row.fee_atomic }),
    ...(row.transaction_id === null ? {} : { transactionId: row.transaction_id }),
    ...(row.prepared_digest === null ? {} : { preparedDigest: row.prepared_digest }),
    ...(row.prepared_byte_length === null
      ? {}
      : { preparedByteLength: row.prepared_byte_length }),
    policyDigest: row.policy_digest,
    state,
    retryCount: row.retry_count,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.completed_at_ms === null ? {} : { completedAtMs: row.completed_at_ms }),
  });
  validateTreasuryOperationIntent({
    operationKey: operation.operationKey,
    requestDigest: operation.requestDigest,
    kind: operation.kind,
    destination: operation.destination,
    requestedAmountAtomic: operation.requestedAmountAtomic,
    keepFloatAtomic: operation.keepFloatAtomic,
    feeCeilingAtomic: operation.feeCeilingAtomic,
    retryLimit: operation.retryLimit,
    policyDigest: operation.policyDigest!,
  });
  if (operation.resolvedAmountAtomic !== undefined) {
    decimalBigInt(operation.resolvedAmountAtomic, "direct Treasury amount");
  }
  if (operation.feeAtomic !== undefined) {
    decimalBigInt(operation.feeAtomic, "direct Treasury fee", true);
  }
  if (operation.transactionId !== undefined) assertTransactionId(operation.transactionId);
  if (operation.preparedDigest !== undefined) {
    assertDigest(operation.preparedDigest, "direct Treasury prepared digest");
  }
  if (!Number.isSafeInteger(operation.retryCount) || operation.retryCount < 0) {
    throw new JournalInvariantError("direct Treasury retry count is invalid");
  }
  if (!Number.isSafeInteger(operation.retryLimit) || operation.retryLimit <= 0) {
    throw new JournalInvariantError("direct Treasury retry limit is invalid");
  }
  return operation;
}

function purchaseTransitionFromRow(row: PurchaseTransitionRow): PurchaseTransitionRecord {
  return {
    sequence: row.sequence,
    purchaseId: row.purchase_id as PurchaseId,
    fromState: row.from_state ?? undefined,
    toState: row.to_state,
    reasonCode: row.reason_code,
    detailDigest: (row.detail_digest as Sha256Digest | null) ?? undefined,
    createdAtMs: row.created_at_ms,
  };
}

function checkoutTermsFromRow(row: CheckoutTermsRow): CheckoutTermsRecord {
  return {
    purchaseId: row.purchase_id as PurchaseId,
    merchant: {
      id: row.merchant_id,
      name: row.merchant_name,
      origin: row.merchant_origin,
    },
    resourceFingerprint: row.resource_fingerprint as Sha256Digest,
    amountAtomic: row.amount_atomic,
    asset: row.asset,
    network: row.network,
    payTo: row.pay_to,
    expiresAt: row.expires_at,
    expiresAtMs: row.expires_at_ms,
    checkoutDigest: row.checkout_digest as Sha256Digest,
    checkoutEvidenceDigest: row.checkout_evidence_digest as Sha256Digest,
    checkoutVerificationProfile: row.checkout_verification_profile,
    checkoutVerifierId: row.checkout_verifier_id,
    paymentRequirementsDigest: row.payment_requirements_digest as Sha256Digest,
    paymentRequirementsVerificationProfile: row.payment_requirements_verification_profile,
    paymentRequirementsVerifierId: row.payment_requirements_verifier_id,
    createdAtMs: row.created_at_ms,
  };
}

function authorizationRequestFromRow(row: AuthorizationRequestRow): AuthorizationRequestRecord {
  return {
    purchaseId: row.purchase_id as PurchaseId,
    checkoutDigest: row.checkout_digest as Sha256Digest,
    requestDigest: row.request_digest as Sha256Digest,
    nonceDigest: row.nonce_digest as Sha256Digest,
    requestMediaType: row.request_media_type,
    requestBodyDigest: row.request_body_digest as Sha256Digest,
    additionalCostCeilingAtomic: row.additional_cost_ceiling_atomic,
    effectiveFinalityFloor: row.effective_finality_floor,
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
  };
}

function authorizationFromRow(row: AuthorizationRow): AuthorizationRecord {
  return {
    purchaseId: row.purchase_id as PurchaseId,
    decision: row.decision,
    authorityId: row.authority_id,
    checkoutDigest: row.checkout_digest as Sha256Digest,
    approvedFactsDigest: row.approved_facts_digest as Sha256Digest,
    evidenceDigest: row.evidence_digest as Sha256Digest,
    verificationProfile: row.verification_profile,
    verifierId: row.verifier_id,
    requestDigest: row.request_digest as Sha256Digest,
    nonceDigest: row.nonce_digest as Sha256Digest,
    expiresAtMs: row.expires_at_ms,
    decidedAtMs: row.decided_at_ms,
  };
}

function fulfilmentFromRow(row: FulfilmentRow): FulfilmentRecord {
  return {
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    httpStatus: row.http_status,
    resourceFingerprint: row.resource_fingerprint as Sha256Digest,
    bodyDigest: row.body_digest as Sha256Digest,
    bodyByteLength: row.body_byte_length,
    mediaType: row.media_type,
    merchantEvidenceDigest: row.merchant_evidence_digest as Sha256Digest,
    merchantVerificationProfile: row.merchant_verification_profile,
    merchantVerifierId: row.merchant_verifier_id,
    createdAtMs: row.created_at_ms,
  };
}

function receiptFromRow(row: ReceiptRow): ReceiptRecord {
  return {
    id: row.id,
    purchaseId: row.purchase_id as PurchaseId,
    role: row.role,
    canonicalDigest: row.canonical_digest as Sha256Digest,
    evidenceDigest: row.evidence_digest as Sha256Digest,
    profile: row.profile,
    issuer: row.issuer ?? undefined,
    verifierId: row.verifier_id,
    checkoutDigest: row.checkout_digest as Sha256Digest,
    authorizationEvidenceDigest: row.authorization_evidence_digest as Sha256Digest,
    settlementEvidenceDigest: row.settlement_evidence_digest as Sha256Digest,
    fulfilmentDigest: row.fulfilment_digest as Sha256Digest,
    createdAtMs: row.created_at_ms,
  };
}

function receiptSetFromRow(row: ReceiptSetRow): ReceiptSetRecord {
  if (row.profile !== PURCHASE_RECEIPT_SET_PROFILE) {
    throw new JournalInvariantError("unsupported canonical Receipt set profile");
  }
  return {
    purchaseId: row.purchase_id as PurchaseId,
    profile: PURCHASE_RECEIPT_SET_PROFILE,
    canonicalDigest: row.canonical_digest as Sha256Digest,
    completedAtMs: row.completed_at_ms,
  };
}

function evidenceLinkFromRow(row: EvidenceLinkRow): EvidenceLinkRecord {
  return {
    purchaseId: row.purchase_id as PurchaseId,
    digest: row.digest as Sha256Digest,
    kind: row.kind,
    attempt: row.attempt ?? undefined,
    mediaType: row.media_type,
    profile: row.profile,
    issuer: row.issuer ?? undefined,
    attachedAtMs: row.attached_at_ms,
  };
}

function evidenceAttachmentFromRow(row: EvidenceAttachmentRow): EvidenceAttachmentRecord {
  return {
    ...evidenceLinkFromRow(row),
    byteLength: row.byte_length,
    storageRef: row.storage_ref,
    createdAtMs: row.blob_created_at_ms,
  };
}

function evidenceFromRow(row: EvidenceArtifactRow): EvidenceArtifactRecord {
  return {
    digest: row.digest as Sha256Digest,
    byteLength: row.byte_length,
    storageRef: row.storage_ref,
    createdAtMs: row.created_at_ms,
  };
}

function policyFromRow(row: PolicySnapshotRow, allowlist: string[]): PolicySnapshotRecord {
  return {
    digest: row.digest as Sha256Digest,
    version: row.version,
    maxPerPaymentAtomic: row.max_per_payment_atomic,
    maxPerHourAtomic: row.max_per_hour_atomic,
    approvalAboveAtomic: row.approval_above_atomic,
    allowlist,
    activatedAtMs: row.activated_at_ms,
  };
}

function reservationFromRow(row: ReservationRow): PolicyReservationRecord {
  return {
    id: row.id,
    purchaseId: row.purchase_id as PurchaseId,
    policyDigest: row.policy_digest as Sha256Digest,
    approvalEvidenceDigest: (row.approval_evidence_digest as Sha256Digest | null) ?? undefined,
    approvalVerificationProfile: row.approval_verification_profile ?? undefined,
    approvalVerifierId: row.approval_verifier_id ?? undefined,
    payee: row.payee,
    amountAtomic: row.amount_atomic,
    additionalCostCeilingAtomic: row.additional_cost_ceiling_atomic,
    fundingSource: row.funding_source,
    state: row.state,
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    inFlightAtMs: row.in_flight_at_ms ?? undefined,
    spentAtMs: row.spent_at_ms ?? undefined,
    releaseEvidenceDigest: (row.release_evidence_digest as Sha256Digest | null) ?? undefined,
  };
}

function paymentAttemptFromRow(row: PaymentAttemptRow): PaymentAttemptRecord {
  return {
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    identifier: row.identifier as PaymentIdentifier,
    state: row.state,
    version: row.version,
    failureCode: row.failure_code ?? undefined,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function paymentPreparationFromRow(row: PaymentPreparationRow): PaymentPreparationRecord {
  return {
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    reservationId: row.reservation_id,
    requirementsDigest: row.requirements_digest as Sha256Digest,
    payloadDigest: row.payload_digest as Sha256Digest,
    preparedRef: row.prepared_ref,
    preparedByteLength: row.prepared_byte_length,
    transactionId: row.transaction_id,
    amountAtomic: row.amount_atomic,
    asset: row.asset,
    network: row.network,
    payee: row.payee,
    requiredFinality: row.required_finality,
    fundingSource: row.funding_source,
    createdAtMs: row.created_at_ms,
  };
}

function treasuryStagingPlanFromRow(row: TreasuryStagingPlanRow): TreasuryStagingPlanRecord {
  return {
    effectId: row.effect_id,
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    reservationId: row.reservation_id,
    idempotencyKey: row.idempotency_key,
    payloadDigest: row.payload_digest as Sha256Digest,
    preparedRef: row.prepared_ref,
    preparedByteLength: row.prepared_byte_length,
    plannedTransactionId: row.planned_transaction_id,
    expectedOutpoint: row.expected_outpoint,
    stagingAmountAtomic: row.staging_amount_atomic,
    fundingSource: row.funding_source,
    createdAtMs: row.created_at_ms,
  };
}

function treasuryStagingObservationFromRow(
  row: TreasuryStagingObservationRow
): TreasuryStagingObservationRecord {
  return {
    effectId: row.effect_id,
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    reservationId: row.reservation_id,
    transactionId: row.transaction_id,
    outpoint: row.outpoint,
    stagingAmountAtomic: row.staging_amount_atomic,
    fundingSource: row.funding_source,
    evidenceDigest: row.evidence_digest as Sha256Digest,
    evidenceVerificationProfile: row.evidence_verification_profile,
    evidenceVerifierId: row.evidence_verifier_id,
    observedAtMs: row.observed_at_ms,
  };
}

function treasuryStagingRecoveryPlanFromRow(
  row: TreasuryStagingRecoveryPlanRow
): TreasuryStagingRecoveryPlanRecord {
  return {
    effectId: row.effect_id,
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    reservationId: row.reservation_id,
    stagingEffectId: row.staging_effect_id,
    idempotencyKey: row.idempotency_key,
    payloadDigest: row.payload_digest as Sha256Digest,
    preparedRef: row.prepared_ref,
    preparedByteLength: row.prepared_byte_length,
    exactTransactionId: row.exact_transaction_id ?? undefined,
    recoveryTransactionId: row.recovery_transaction_id,
    recoveryOutpoint: row.recovery_outpoint,
    recoveryAmountAtomic: row.recovery_amount_atomic,
    stagingFeeAtomic: row.staging_fee_atomic,
    recoveryFeeAtomic: row.recovery_fee_atomic,
    requiredFinality: row.required_finality,
    authorizedAdditionalCostCeilingAtomic:
      row.authorized_additional_cost_ceiling_atomic,
    createdAtMs: row.created_at_ms,
  };
}

function treasuryStagingRecoveryObservationFromRow(
  row: TreasuryStagingRecoveryObservationRow
): TreasuryStagingRecoveryObservationRecord {
  return {
    sequence: row.sequence,
    effectId: row.effect_id,
    status: row.status,
    evidenceDigest: row.evidence_digest as Sha256Digest,
    readinessProofDigest:
      (row.readiness_proof_digest as Sha256Digest | null) ?? undefined,
    readinessObservedAtMs: row.readiness_observed_at_ms ?? undefined,
    readinessExpiresAtMs: row.readiness_expires_at_ms ?? undefined,
    winningTransactionId: row.winning_transaction_id ?? undefined,
    winningFinality: row.winning_finality ?? undefined,
    recoveryOutpoint: row.recovery_outpoint ?? undefined,
    recoveryAmountAtomic: row.recovery_amount_atomic ?? undefined,
    conflictReason: row.conflict_reason ?? undefined,
    leaseName: row.lease_name,
    leaseGeneration: row.lease_generation,
    observedAtMs: row.observed_at_ms,
  };
}

function treasuryStagingRecoveryAccountingFromRow(
  row: TreasuryStagingRecoveryAccountingRow
): TreasuryStagingRecoveryAccountingRecord {
  return {
    effectId: row.effect_id,
    reservationId: row.reservation_id,
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    recoveryTransactionId: row.recovery_transaction_id,
    recoveryOutpoint: row.recovery_outpoint,
    returnedAmountAtomic: row.returned_amount_atomic,
    stagingFeeAtomic: row.staging_fee_atomic,
    recoveryFeeAtomic: row.recovery_fee_atomic,
    actualAdditionalCostAtomic: row.actual_additional_cost_atomic,
    finality: row.finality,
    evidenceDigest: row.evidence_digest as Sha256Digest,
    observedAtMs: row.observed_at_ms,
  };
}

function effectFromRow(row: EffectRow): EffectRecord {
  return {
    id: row.id,
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt ?? undefined,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    version: row.version,
    payloadDigest: row.payload_digest as Sha256Digest,
    preparedRef: row.prepared_ref,
    preparedByteLength: row.prepared_byte_length,
    claimLeaseName: row.claim_lease_name ?? undefined,
    claimGeneration: row.claim_generation ?? undefined,
    submissionDigest: (row.submission_digest as Sha256Digest | null) ?? undefined,
    resultDigest: (row.result_digest as Sha256Digest | null) ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    executingAtMs: row.executing_at_ms ?? undefined,
    submittedAtMs: row.submitted_at_ms ?? undefined,
    observedAtMs: row.observed_at_ms ?? undefined,
  };
}

function effectObservationFromRow(row: EffectObservationRow): EffectObservationRecord {
  return {
    id: row.id,
    effectId: row.effect_id,
    status: row.status,
    resultDigest: (row.result_digest as Sha256Digest | null) ?? undefined,
    detailDigest: (row.detail_digest as Sha256Digest | null) ?? undefined,
    leaseName: row.lease_name,
    leaseGeneration: row.lease_generation,
    observedAtMs: row.observed_at_ms,
  };
}

function effectTransitionFromRow(row: EffectTransitionRow): EffectTransitionRecord {
  return {
    sequence: row.sequence,
    effectId: row.effect_id,
    fromState: row.from_state ?? undefined,
    toState: row.to_state,
    reasonCode: row.reason_code,
    detailDigest: (row.detail_digest as Sha256Digest | null) ?? undefined,
    createdAtMs: row.created_at_ms,
  };
}

function treasurySpendFromRow(row: TreasurySpendRow): TreasurySpendRecord {
  return {
    id: row.id,
    effectId: row.effect_id,
    reservationId: row.reservation_id,
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    transactionId: row.transaction_id,
    outpoint: row.outpoint ?? undefined,
    actualAmountAtomic: row.actual_amount_atomic,
    actualAdditionalCostAtomic: row.actual_additional_cost_atomic,
    asset: row.asset,
    payee: row.payee,
    network: row.network,
    finality: row.finality,
    fundingSource: row.funding_source,
    evidenceDigest: row.evidence_digest as Sha256Digest,
    evidenceVerificationProfile: row.evidence_verification_profile,
    evidenceVerifierId: row.evidence_verifier_id,
    observedAtMs: row.observed_at_ms,
  };
}

function reconciliationRunFromRow(row: ReconciliationRunRow): ReconciliationRunRecord {
  return {
    id: row.id,
    purchaseId: row.purchase_id as PurchaseId,
    effectId: row.effect_id ?? undefined,
    outcome: row.outcome,
    detailDigest: (row.detail_digest as Sha256Digest | null) ?? undefined,
    leaseName: row.lease_name,
    leaseGeneration: row.lease_generation,
    createdAtMs: row.created_at_ms,
  };
}

function validateCreatePurchase(input: CreatePurchaseInput): void {
  try {
    assertPurchaseId(input.id);
    assertPurchaseRequestKey(input.requestKey);
  } catch (error) {
    throw new JournalInvariantError((error as Error).message);
  }
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalRequestUrl(input.resourceUrl);
  } catch (error) {
    throw new JournalInvariantError((error as Error).message);
  }
  if (canonicalUrl !== input.resourceUrl) throw new JournalInvariantError("Purchase resource URL must already be canonical");
  if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(input.method)) {
    throw new JournalInvariantError("invalid canonical Purchase HTTP method");
  }
  assertDigest(input.resourceFingerprint, "Purchase resource fingerprint");
  if (input.expectedMerchantId !== undefined) {
    assertBoundedText(input.expectedMerchantId, "expected Merchant identity", 200);
  }
  if (input.expectedMerchantOrigin !== undefined) {
    let origin: string;
    try {
      origin = new URL(input.expectedMerchantOrigin).origin;
    } catch {
      throw new JournalInvariantError("invalid expected Merchant origin");
    }
    if (origin !== input.expectedMerchantOrigin) {
      throw new JournalInvariantError("expected Merchant origin must be canonical");
    }
  }
}

function validateCheckoutTermsRecordInput(input: BindCheckoutTermsInput): void {
  assertBoundedText(input.terms.merchant.id, "Checkout Terms Merchant identity", 200);
  assertBoundedText(input.terms.merchant.name, "Checkout Terms Merchant name", 200);
  let origin: string;
  try {
    origin = new URL(input.terms.merchant.origin).origin;
  } catch {
    throw new JournalInvariantError("invalid Checkout Terms Merchant origin");
  }
  if (origin !== input.terms.merchant.origin) {
    throw new JournalInvariantError("Checkout Terms Merchant origin must be canonical");
  }
  assertDigest(input.terms.resourceFingerprint, "Checkout Terms resource fingerprint");
  decimalBigInt(input.terms.amountAtomic, "Checkout Terms amount");
  assertSafeIdentity(input.terms.asset, "Checkout Terms asset", 40);
  assertSafeIdentity(input.terms.network, "Checkout Terms network", 100);
  assertBoundedText(input.terms.payTo, "Checkout Terms payee", 300);
  strictTimestamp(input.terms.expiresAt, "Checkout Terms expiry");
  assertDigest(input.terms.checkoutDigest, "Checkout Terms digest");
  assertDigest(input.checkoutEvidenceDigest, "Checkout Terms evidence digest");
  assertSafeIdentity(input.checkoutVerificationProfile, "Checkout Terms verification profile", 200);
  assertSafeIdentity(input.checkoutVerifierId, "Checkout Terms verifier identity", 200);
  assertDigest(input.paymentRequirementsDigest, "payment requirements digest");
  assertSafeIdentity(
    input.paymentRequirementsVerificationProfile,
    "payment requirements verification profile",
    200
  );
  assertSafeIdentity(input.paymentRequirementsVerifierId, "payment requirements verifier identity", 200);
}

function validateAuthorizationRequestInput(input: RecordAuthorizationRequestInput): void {
  assertDigest(input.checkoutDigest, "authorization request Checkout Terms digest");
  assertDigest(input.requestDigest, "authorization request digest");
  assertDigest(input.nonceDigest, "authorization request nonce digest");
  try {
    if ((canonicalMediaType(input.requestMediaType || undefined) ?? "") !== input.requestMediaType) {
      throw new Error("not canonical");
    }
  } catch {
    throw new JournalInvariantError("authorization request media type is invalid");
  }
  assertDigest(input.requestBodyDigest, "authorization request body digest");
  decimalBigInt(input.additionalCostCeilingAtomic, "authorization additional-cost ceiling", true);
  if (input.effectiveFinalityFloor !== "accepted" && input.effectiveFinalityFloor !== "depth-confirmed") {
    throw new JournalInvariantError("authorization effective finality floor is invalid");
  }
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs < 0) {
    throw new JournalInvariantError("authorization request expiry is invalid");
  }
}

function validateAuthorizationDecisionInput(input: RecordAuthorizationDecisionInput): void {
  if (!(["approved", "denied", "expired"] as const).includes(input.decision)) {
    throw new JournalInvariantError("authorization decision is invalid");
  }
  assertSafeIdentity(input.authorityId, "authority identity", 200);
  assertDigest(input.checkoutDigest, "authorization Checkout Terms digest");
  assertDigest(input.approvedFactsDigest, "authorization approved-facts digest");
  assertDigest(input.evidenceDigest, "authorization evidence digest");
  assertSafeIdentity(input.verificationProfile, "authorization verification profile", 200);
  assertSafeIdentity(input.verifierId, "authorization verifier identity", 200);
  assertDigest(input.requestDigest, "authorization request digest");
  assertDigest(input.nonceDigest, "authorization nonce digest");
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs < 0) {
    throw new JournalInvariantError("authorization expiry is invalid");
  }
}

function validateFulfilmentInput(input: RecordFulfilmentInput): void {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new JournalInvariantError("Fulfilment attempt must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
    throw new JournalInvariantError("Fulfilment HTTP status is invalid");
  }
  assertDigest(input.resourceFingerprint, "Fulfilment resource fingerprint");
  assertDigest(input.bodyDigest, "Fulfilment body digest");
  if (!Number.isSafeInteger(input.bodyByteLength) || input.bodyByteLength < 0) {
    throw new JournalInvariantError("Fulfilment body length is invalid");
  }
  assertBoundedText(input.mediaType, "Fulfilment media type", 200);
  assertDigest(input.merchantEvidenceDigest, "Merchant Fulfilment evidence digest");
  assertSafeIdentity(input.merchantVerificationProfile, "Merchant Fulfilment verification profile", 200);
  assertSafeIdentity(input.merchantVerifierId, "Merchant Fulfilment verifier identity", 200);
}

export function canonicalReceiptDigest(
  purchaseId: PurchaseId,
  attempt: number,
  paymentIdentifier: PaymentIdentifier,
  input: RecordReceiptInput
): Sha256Digest {
  return evidenceDigest(JSON.stringify({
    profile: "urn:sompi:canonical-receipt:1",
    purchaseId,
    attempt,
    paymentIdentifier,
    role: input.role,
    evidenceDigest: input.evidenceDigest,
    evidenceProfile: input.profile,
    issuer: input.issuer ?? null,
    verifierId: input.verifierId,
    checkoutDigest: input.checkoutDigest,
    authorizationEvidenceDigest: input.authorizationEvidenceDigest,
    settlementEvidenceDigest: input.settlementEvidenceDigest,
    fulfilmentDigest: input.fulfilmentDigest,
  }));
}

export function canonicalReceiptSetDigest(
  purchaseId: PurchaseId,
  attempt: number,
  paymentIdentifier: PaymentIdentifier,
  receipts: readonly Pick<ReceiptRecord, "role" | "canonicalDigest">[]
): Sha256Digest {
  const entries = [...receipts]
    .map((receipt) => ({ role: receipt.role, canonicalDigest: receipt.canonicalDigest }))
    .sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
  return evidenceDigest(JSON.stringify({
    profile: PURCHASE_RECEIPT_SET_PROFILE,
    purchaseId,
    attempt,
    paymentIdentifier,
    receipts: entries,
  }));
}

function validateReceiptInput(input: RecordReceiptInput): void {
  assertCode(input.role, "Receipt role");
  assertDigest(input.evidenceDigest, "Receipt evidence digest");
  assertSafeIdentity(input.profile, "Receipt profile", 200);
  if (input.issuer !== undefined) assertBoundedText(input.issuer, "Receipt issuer", 200);
  assertSafeIdentity(input.verifierId, "Receipt verifier identity", 200);
  assertDigest(input.checkoutDigest, "Receipt Checkout Terms digest");
  assertDigest(input.authorizationEvidenceDigest, "Receipt authorization evidence digest");
  assertDigest(input.settlementEvidenceDigest, "Receipt Settlement evidence digest");
  assertDigest(input.fulfilmentDigest, "Receipt Fulfilment digest");
  const requirement = PURCHASE_RECEIPT_REQUIREMENTS.find((candidate) => candidate.role === input.role);
  if (!requirement || requirement.profile !== input.profile) {
    throw new JournalInvariantError("Receipt role or canonical verification profile is unsupported");
  }
}

function validateEvidenceMetadata(input: StoreEvidenceInput): void {
  assertBoundedText(input.mediaType, "evidence media type", 200);
  assertBoundedText(input.profile, "evidence profile", 200);
  assertCode(input.kind, "evidence kind");
  if (input.issuer !== undefined) assertBoundedText(input.issuer, "evidence issuer", 200);
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) {
    throw new JournalInvariantError("evidence attempt must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.bytes.byteLength) || input.bytes.byteLength < 0) {
    throw new JournalInvariantError("evidence byte length is invalid");
  }
}

function canonicalPolicy(definition: PolicyDefinition): PolicyDefinition {
  decimalBigInt(definition.maxPerPaymentAtomic, "per-payment limit");
  decimalBigInt(definition.maxPerHourAtomic, "hourly limit");
  decimalBigInt(definition.approvalAboveAtomic, "approval threshold", true);
  const allowlist = [...new Set(definition.allowlist)];
  for (const payee of allowlist) assertBoundedText(payee, "policy allowlist payee", 300);
  allowlist.sort();
  return {
    maxPerPaymentAtomic: definition.maxPerPaymentAtomic,
    maxPerHourAtomic: definition.maxPerHourAtomic,
    approvalAboveAtomic: definition.approvalAboveAtomic,
    allowlist,
  };
}

function validatePolicyReservationInput(input: PolicyReservationInput): void {
  assertCode(input.id, "reservation id");
  assertDigest(input.policyDigest, "policy digest");
  assertBoundedText(input.payee, "reservation payee", 300);
  decimalBigInt(input.amountAtomic, "reservation amount");
  decimalBigInt(input.additionalCostCeilingAtomic, "reservation additional-cost ceiling", true);
  assertVaultFundingSource(input.fundingSource);
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs < 0) {
    throw new PolicyReservationError("invalid reservation expiry");
  }
  if (input.approvalEvidenceDigest) assertDigest(input.approvalEvidenceDigest, "approval evidence digest");
  const approvalParts = [
    input.approvalEvidenceDigest,
    input.approvalVerificationProfile,
    input.approvalVerifierId,
  ].filter((value) => value !== undefined).length;
  if (approvalParts !== 0 && approvalParts !== 3) {
    throw new PolicyReservationError(
      "approval evidence, verification profile, and verifier identity must be supplied together"
    );
  }
  if (input.approvalVerificationProfile) {
    assertSafeIdentity(input.approvalVerificationProfile, "approval verification profile", 200);
  }
  if (input.approvalVerifierId) assertSafeIdentity(input.approvalVerifierId, "approval verifier identity", 200);
}

function validatePaymentPreparation(input: PreparePaymentAttemptInput): void {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new JournalInvariantError("payment attempt must be a positive safe integer");
  }
  assertCode(input.reservationId, "reservation id");
  assertDigest(input.requirementsDigest, "payment requirements digest");
  assertDigest(input.payloadDigest, "payment payload digest");
  assertTransactionId(input.transactionId);
  decimalBigInt(input.amountAtomic, "prepared payment amount");
  assertSafeIdentity(input.asset, "prepared payment asset", 40);
  assertSafeIdentity(input.network, "prepared payment network", 100);
  assertBoundedText(input.payee, "prepared payment payee", 300);
  requirePaymentFinality(input.requiredFinality, "prepared payment finality");
  assertVaultFundingSource(input.fundingSource);
  if (!Number.isSafeInteger(input.preparedBytes.byteLength) || input.preparedBytes.byteLength < 1) {
    throw new JournalInvariantError("prepared payment bytes must not be empty");
  }
}

function validateTreasuryStagingPlanInput(input: PlanTreasuryStagingInput): void {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new JournalInvariantError("treasury staging attempt must be a positive safe integer");
  }
  assertCode(input.reservationId, "treasury staging reservation id");
  assertSafeIdentity(input.idempotencyKey, "treasury staging idempotency key", 300);
  assertDigest(input.payloadDigest, "treasury staging payload digest");
  assertTransactionId(input.plannedTransactionId);
  assertSafeIdentity(input.expectedOutpoint, "treasury staging expected outpoint", 200);
  if (!new RegExp(`^${input.plannedTransactionId}:[0-9]+$`).test(input.expectedOutpoint)) {
    throw new JournalInvariantError(
      "treasury staging expected outpoint must be bound to the planned transaction identity"
    );
  }
  decimalBigInt(input.stagingAmountAtomic, "treasury staging amount");
  assertVaultFundingSource(input.fundingSource);
  if (!Number.isSafeInteger(input.preparedBytes.byteLength) || input.preparedBytes.byteLength < 1) {
    throw new JournalInvariantError("prepared treasury staging bytes must not be empty");
  }
}

function validateTreasuryStagingObservationInput(
  input: RecordObservedTreasuryStagingInput
): void {
  assertCode(input.effectId, "treasury staging Effect id");
  assertCode(input.reservationId, "treasury staging reservation id");
  assertTransactionId(input.transactionId);
  assertSafeIdentity(input.outpoint, "treasury staging observed outpoint", 200);
  if (!new RegExp(`^${input.transactionId}:[0-9]+$`).test(input.outpoint)) {
    throw new JournalInvariantError(
      "treasury staging observed outpoint must be bound to the transaction identity"
    );
  }
  decimalBigInt(input.stagingAmountAtomic, "observed treasury staging amount");
  assertVaultFundingSource(input.fundingSource);
  assertDigest(input.evidenceDigest, "treasury staging evidence digest");
  assertSafeIdentity(
    input.evidenceVerificationProfile,
    "treasury staging evidence verification profile",
    200
  );
  assertSafeIdentity(input.evidenceVerifierId, "treasury staging evidence verifier identity", 200);
}

function validateTreasuryStagingRecoveryPlanInput(
  input: PlanTreasuryStagingRecoveryInput
): void {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new JournalInvariantError(
      "treasury staging recovery attempt must be a positive safe integer"
    );
  }
  assertCode(input.reservationId, "staging recovery reservation id");
  assertCode(input.stagingEffectId, "staging recovery source Effect id");
  assertSafeIdentity(input.idempotencyKey, "staging recovery idempotency key", 300);
  assertDigest(input.payloadDigest, "staging recovery payload digest");
  if (input.exactTransactionId !== undefined) {
    assertTransactionId(input.exactTransactionId);
  }
  assertTransactionId(input.recoveryTransactionId);
  assertSafeIdentity(input.recoveryOutpoint, "staging recovery outpoint", 200);
  if (input.recoveryOutpoint !== `${input.recoveryTransactionId}:0`) {
    throw new JournalInvariantError(
      "staging recovery output must be output zero of its immutable transaction"
    );
  }
  decimalBigInt(input.recoveryAmountAtomic, "staging recovery returned amount");
  decimalBigInt(input.stagingFeeAtomic, "staging transaction fee", true);
  decimalBigInt(input.recoveryFeeAtomic, "staging recovery fee");
  decimalBigInt(
    input.authorizedAdditionalCostCeilingAtomic,
    "staging recovery authorized additional-cost ceiling",
    true
  );
  requirePaymentFinality(input.requiredFinality, "staging recovery finality");
  if (!Number.isSafeInteger(input.preparedBytes.byteLength) || input.preparedBytes.byteLength < 1) {
    throw new JournalInvariantError("prepared staging recovery bytes must not be empty");
  }
}

function validateTreasuryStagingRecoveryObservationInput(
  input: RecordTreasuryStagingRecoveryObservationInput
): void {
  if (![
    "safe_to_submit",
    "pending",
    "exact_payment_won",
    "recovery_won",
    "conflict",
  ].includes(input.status)) {
    throw new JournalInvariantError("staging recovery observation status is invalid");
  }
  assertDigest(input.evidenceDigest, "staging recovery observation evidence digest");
  if (input.status === "safe_to_submit") {
    if (
      !input.readinessProofDigest ||
      !Number.isSafeInteger(input.readinessObservedAtMs) ||
      !Number.isSafeInteger(input.readinessExpiresAtMs) ||
      input.readinessObservedAtMs! >= input.readinessExpiresAtMs!
    ) {
      throw new JournalInvariantError("staging recovery readiness proof is incomplete");
    }
    assertDigest(input.readinessProofDigest, "staging recovery readiness proof digest");
  } else if (
    input.readinessProofDigest !== undefined ||
    input.readinessObservedAtMs !== undefined ||
    input.readinessExpiresAtMs !== undefined
  ) {
    throw new JournalInvariantError("non-readiness recovery observation contains a readiness proof");
  }
  if (input.winningTransactionId !== undefined) {
    assertTransactionId(input.winningTransactionId);
  }
  if (input.winningFinality !== undefined) {
    requirePaymentFinality(input.winningFinality, "staging recovery winner finality");
  }
  if (input.recoveryOutpoint !== undefined) {
    assertSafeIdentity(input.recoveryOutpoint, "observed recovery outpoint", 200);
  }
  if (input.recoveryAmountAtomic !== undefined) {
    decimalBigInt(input.recoveryAmountAtomic, "observed recovery amount");
  }
  if (input.status === "conflict") {
    if (!input.conflictReason) {
      throw new JournalInvariantError("staging recovery conflict has no bounded reason");
    }
    assertCode(input.conflictReason, "staging recovery conflict reason");
  } else if (input.conflictReason !== undefined) {
    throw new JournalInvariantError("non-conflict recovery observation contains a conflict reason");
  }
}

function validateEffectInput(input: PlanEffectInput): void {
  assertCode(input.kind, "effect kind");
  assertSafeIdentity(input.idempotencyKey, "effect idempotency key", 300);
  assertDigest(input.payloadDigest, "effect payload digest");
  if (!Number.isSafeInteger(input.preparedBytes.byteLength) || input.preparedBytes.byteLength < 1) {
    throw new JournalInvariantError("effect preparation bytes must not be empty");
  }
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) {
    throw new JournalInvariantError("effect attempt must be a positive safe integer");
  }
}

function validateObservation(observation: EffectObservation): void {
  if (observation.status === "observed") assertDigest(observation.resultDigest, "effect result digest");
  if (observation.detailDigest) assertDigest(observation.detailDigest, "effect observation detail digest");
  if (observation.status === "application_failure") {
    assertCode(observation.errorCode, "effect error code");
    assertDigest(observation.detailDigest, "application failure detail digest");
  }
}

function validateSpendInput(input: RecordObservedSpendInput): void {
  assertCode(input.reservationId, "reservation id");
  assertTransactionId(input.transactionId);
  if (input.outpoint !== undefined) {
    assertSafeIdentity(input.outpoint, "spend outpoint", 200);
    if (!new RegExp(`^${input.transactionId}:[0-9]+$`).test(input.outpoint)) {
      throw new JournalInvariantError("spend outpoint must be bound to the canonical transaction identity");
    }
  }
  decimalBigInt(input.actualAmountAtomic, "actual spend amount");
  decimalBigInt(input.actualAdditionalCostAtomic, "actual additional treasury cost", true);
  assertSafeIdentity(input.asset, "spend asset", 40);
  assertBoundedText(input.payee, "spend payee", 300);
  assertSafeIdentity(input.network, "spend network", 100);
  requirePaymentFinality(input.finality, "spend finality");
  assertVaultFundingSource(input.fundingSource);
  assertDigest(input.evidenceDigest, "spend evidence digest");
  assertSafeIdentity(input.evidenceVerificationProfile, "spend evidence verification profile", 200);
  assertSafeIdentity(input.evidenceVerifierId, "spend evidence verifier identity", 200);
}

function validateLeaseFields(name: string, holder: string, ttlMs: number): void {
  assertSafeIdentity(name, "lease name", 300);
  assertSafeIdentity(holder, "lease holder", 200);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new JournalInvariantError("lease ttl must be a positive safe integer");
  }
}

function assertSamePurchaseIntent(existing: PurchaseRecord, input: CreatePurchaseInput): void {
  if (
    existing.resourceUrl !== input.resourceUrl ||
    existing.method !== input.method ||
    existing.resourceFingerprint !== input.resourceFingerprint ||
    existing.expectedMerchantId !== input.expectedMerchantId ||
    existing.expectedMerchantOrigin !== input.expectedMerchantOrigin
  ) {
    throw new JournalInvariantError(`request key ${input.requestKey} was reused for a different Purchase Intent`);
  }
}

function assertSameCheckoutTerms(existing: CheckoutTermsRecord, input: BindCheckoutTermsInput): void {
  if (
    existing.merchant.id !== input.terms.merchant.id ||
    existing.merchant.name !== input.terms.merchant.name ||
    existing.merchant.origin !== input.terms.merchant.origin ||
    existing.resourceFingerprint !== input.terms.resourceFingerprint ||
    existing.amountAtomic !== input.terms.amountAtomic ||
    existing.asset !== input.terms.asset ||
    existing.network !== input.terms.network ||
    existing.payTo !== input.terms.payTo ||
    existing.expiresAt !== input.terms.expiresAt ||
    existing.checkoutDigest !== input.terms.checkoutDigest ||
    existing.checkoutEvidenceDigest !== input.checkoutEvidenceDigest ||
    existing.checkoutVerificationProfile !== input.checkoutVerificationProfile ||
    existing.checkoutVerifierId !== input.checkoutVerifierId ||
    existing.paymentRequirementsDigest !== input.paymentRequirementsDigest ||
    existing.paymentRequirementsVerificationProfile !== input.paymentRequirementsVerificationProfile ||
    existing.paymentRequirementsVerifierId !== input.paymentRequirementsVerifierId
  ) {
    throw new JournalInvariantError("immutable Checkout Terms conflict");
  }
}

function assertSameAuthorizationRequest(
  existing: AuthorizationRequestRecord,
  input: RecordAuthorizationRequestInput
): void {
  if (
    existing.checkoutDigest !== input.checkoutDigest ||
    existing.requestDigest !== input.requestDigest ||
    existing.nonceDigest !== input.nonceDigest ||
    existing.requestMediaType !== input.requestMediaType ||
    existing.requestBodyDigest !== input.requestBodyDigest ||
    existing.additionalCostCeilingAtomic !== input.additionalCostCeilingAtomic ||
    existing.expiresAtMs !== input.expiresAtMs
  ) {
    throw new JournalInvariantError("immutable authorization request conflict");
  }
}

function assertSameAuthorization(existing: AuthorizationRecord, input: RecordAuthorizationDecisionInput): void {
  if (
    existing.decision !== input.decision ||
    existing.authorityId !== input.authorityId ||
    existing.checkoutDigest !== input.checkoutDigest ||
    existing.approvedFactsDigest !== input.approvedFactsDigest ||
    existing.evidenceDigest !== input.evidenceDigest ||
    existing.verificationProfile !== input.verificationProfile ||
    existing.verifierId !== input.verifierId ||
    existing.requestDigest !== input.requestDigest ||
    existing.nonceDigest !== input.nonceDigest ||
    existing.expiresAtMs !== input.expiresAtMs
  ) {
    throw new JournalInvariantError("immutable authorization decision conflict");
  }
}

function assertSameFulfilment(existing: FulfilmentRecord, input: RecordFulfilmentInput): void {
  if (
    existing.attempt !== input.attempt ||
    existing.httpStatus !== input.httpStatus ||
    existing.resourceFingerprint !== input.resourceFingerprint ||
    existing.bodyDigest !== input.bodyDigest ||
    existing.bodyByteLength !== input.bodyByteLength ||
    existing.mediaType !== input.mediaType ||
    existing.merchantEvidenceDigest !== input.merchantEvidenceDigest ||
    existing.merchantVerificationProfile !== input.merchantVerificationProfile ||
    existing.merchantVerifierId !== input.merchantVerifierId
  ) {
    throw new JournalInvariantError("immutable Fulfilment conflict");
  }
}

function assertSameReceipt(
  existing: ReceiptRecord,
  input: RecordReceiptInput,
  canonicalDigest: Sha256Digest
): void {
  if (
    existing.role !== input.role ||
    existing.canonicalDigest !== canonicalDigest ||
    existing.evidenceDigest !== input.evidenceDigest ||
    existing.profile !== input.profile ||
    existing.issuer !== input.issuer ||
    existing.verifierId !== input.verifierId ||
    existing.checkoutDigest !== input.checkoutDigest ||
    existing.authorizationEvidenceDigest !== input.authorizationEvidenceDigest ||
    existing.settlementEvidenceDigest !== input.settlementEvidenceDigest ||
    existing.fulfilmentDigest !== input.fulfilmentDigest
  ) {
    throw new JournalInvariantError("immutable Receipt conflict");
  }
}

function assertSameEvidenceBlob(
  existing: EvidenceArtifactRecord,
  byteLength: number,
  storageRef: string
): void {
  if (
    existing.byteLength !== byteLength ||
    existing.storageRef !== storageRef
  ) {
    throw new JournalInvariantError(`evidence blob conflict for ${existing.digest}`);
  }
}

function assertSameEvidenceAttachment(
  existing: EvidenceAttachmentRecord,
  input: StoreEvidenceInput
): void {
  if (
    existing.mediaType !== input.mediaType ||
    existing.profile !== input.profile ||
    existing.issuer !== input.issuer ||
    existing.kind !== input.kind ||
    existing.attempt !== input.attempt
  ) {
    throw new JournalInvariantError(`Evidence Attachment metadata conflict for ${existing.digest}`);
  }
}

function assertSameReservation(existing: PolicyReservationRecord, input: PolicyReservationInput): void {
  if (
    existing.purchaseId !== input.purchaseId ||
    existing.policyDigest !== input.policyDigest ||
    existing.approvalEvidenceDigest !== input.approvalEvidenceDigest ||
    existing.approvalVerificationProfile !== input.approvalVerificationProfile ||
    existing.approvalVerifierId !== input.approvalVerifierId ||
    existing.payee !== input.payee ||
    existing.amountAtomic !== input.amountAtomic ||
    existing.additionalCostCeilingAtomic !== input.additionalCostCeilingAtomic ||
    existing.expiresAtMs !== input.expiresAtMs
  ) {
    throw new JournalInvariantError(`reservation id ${input.id} was reused with different terms`);
  }
}

function assertSamePreparation(
  existing: PaymentPreparationRecord,
  input: PreparePaymentAttemptInput,
  stored: StoredEvidence
): void {
  if (
    existing.reservationId !== input.reservationId ||
    existing.requirementsDigest !== input.requirementsDigest ||
    existing.payloadDigest !== input.payloadDigest ||
    existing.preparedRef !== stored.storageRef ||
    existing.preparedByteLength !== stored.byteLength ||
    existing.transactionId !== input.transactionId ||
    existing.amountAtomic !== input.amountAtomic ||
    existing.asset !== input.asset ||
    existing.network !== input.network ||
    existing.payee !== input.payee ||
    existing.requiredFinality !== input.requiredFinality
    || existing.fundingSource !== input.fundingSource
  ) {
    throw new JournalInvariantError("immutable payment preparation conflict");
  }
}

function assertSameTreasuryStagingPlan(
  existing: TreasuryStagingPlanRecord,
  input: PlanTreasuryStagingInput,
  stored: StoredEvidence
): void {
  if (
    existing.purchaseId !== input.purchaseId ||
    existing.attempt !== input.attempt ||
    existing.reservationId !== input.reservationId ||
    existing.idempotencyKey !== input.idempotencyKey ||
    existing.payloadDigest !== input.payloadDigest ||
    existing.preparedRef !== stored.storageRef ||
    existing.preparedByteLength !== stored.byteLength ||
    existing.plannedTransactionId !== input.plannedTransactionId ||
    existing.expectedOutpoint !== input.expectedOutpoint ||
    existing.stagingAmountAtomic !== input.stagingAmountAtomic ||
    existing.fundingSource !== input.fundingSource
  ) {
    throw new JournalInvariantError(
      `treasury staging idempotency conflict for ${input.idempotencyKey}`
    );
  }
}

function assertSameTreasuryStagingObservation(
  existing: TreasuryStagingObservationRecord,
  input: RecordObservedTreasuryStagingInput
): void {
  if (
    existing.effectId !== input.effectId ||
    existing.reservationId !== input.reservationId ||
    existing.transactionId !== input.transactionId ||
    existing.outpoint !== input.outpoint ||
    existing.stagingAmountAtomic !== input.stagingAmountAtomic ||
    existing.fundingSource !== input.fundingSource ||
    existing.evidenceDigest !== input.evidenceDigest ||
    existing.evidenceVerificationProfile !== input.evidenceVerificationProfile ||
    existing.evidenceVerifierId !== input.evidenceVerifierId
  ) {
    throw new JournalInvariantError(
      `conflicting treasury staging observation for Effect ${input.effectId}`
    );
  }
}

function assertSameTreasuryStagingRecoveryPlan(
  existing: TreasuryStagingRecoveryPlanRecord,
  input: PlanTreasuryStagingRecoveryInput,
  stored: StoredEvidence
): void {
  if (
    existing.purchaseId !== input.purchaseId ||
    existing.attempt !== input.attempt ||
    existing.reservationId !== input.reservationId ||
    existing.stagingEffectId !== input.stagingEffectId ||
    existing.idempotencyKey !== input.idempotencyKey ||
    existing.payloadDigest !== input.payloadDigest ||
    existing.preparedRef !== stored.storageRef ||
    existing.preparedByteLength !== stored.byteLength ||
    existing.exactTransactionId !== input.exactTransactionId ||
    existing.recoveryTransactionId !== input.recoveryTransactionId ||
    existing.recoveryOutpoint !== input.recoveryOutpoint ||
    existing.recoveryAmountAtomic !== input.recoveryAmountAtomic ||
    existing.stagingFeeAtomic !== input.stagingFeeAtomic ||
    existing.recoveryFeeAtomic !== input.recoveryFeeAtomic ||
    existing.requiredFinality !== input.requiredFinality ||
    existing.authorizedAdditionalCostCeilingAtomic !==
      input.authorizedAdditionalCostCeilingAtomic
  ) {
    throw new JournalInvariantError(
      `staging recovery idempotency conflict for ${input.idempotencyKey}`
    );
  }
}

function assertSameEffect(existing: EffectRecord, input: PlanEffectInput, stored: StoredEvidence): void {
  if (
    existing.purchaseId !== input.purchaseId ||
    existing.attempt !== input.attempt ||
    existing.kind !== input.kind ||
    existing.payloadDigest !== input.payloadDigest ||
    existing.preparedRef !== stored.storageRef ||
    existing.preparedByteLength !== stored.byteLength
  ) {
    throw new JournalInvariantError(`effect idempotency conflict for ${input.idempotencyKey}`);
  }
}

function assertSameSpend(existing: TreasurySpendRecord, input: RecordObservedSpendInput): void {
  if (
    existing.effectId !== input.effectId ||
    existing.reservationId !== input.reservationId ||
    existing.transactionId !== input.transactionId ||
    existing.outpoint !== input.outpoint ||
    existing.actualAmountAtomic !== input.actualAmountAtomic ||
    existing.actualAdditionalCostAtomic !== input.actualAdditionalCostAtomic ||
    existing.asset !== input.asset ||
    existing.payee !== input.payee ||
    existing.network !== input.network ||
    existing.finality !== input.finality ||
    existing.fundingSource !== input.fundingSource ||
    existing.evidenceDigest !== input.evidenceDigest ||
    existing.evidenceVerificationProfile !== input.evidenceVerificationProfile ||
    existing.evidenceVerifierId !== input.evidenceVerifierId
  ) {
    throw new JournalInvariantError(`conflicting spend finalization for Reservation ${input.reservationId}`);
  }
}

function mapObservation(observation: EffectObservation): {
  status: EffectObservationRecord["status"];
  nextState: EffectState;
  resultDigest?: Sha256Digest;
  detailDigest?: Sha256Digest;
  errorCode?: string;
} {
  switch (observation.status) {
    case "observed":
      return {
        status: "observed",
        nextState: "observed",
        resultDigest: observation.resultDigest,
        detailDigest: observation.detailDigest,
      };
    case "pending":
      return { status: "pending", nextState: "ambiguous", detailDigest: observation.detailDigest };
    case "not_found":
      return {
        status: observation.safeToRetry ? "not_found_retryable" : "not_found_ambiguous",
        nextState: observation.safeToRetry ? "retryable" : "ambiguous",
        detailDigest: observation.detailDigest,
      };
    case "conflict":
      return { status: "conflict", nextState: "ambiguous", detailDigest: observation.detailDigest };
    case "application_failure":
      return {
        status: "application_failure",
        nextState: "ambiguous",
        detailDigest: observation.detailDigest,
        errorCode: observation.errorCode,
      };
  }
}

function assertAttemptTransition(
  from: PaymentAttemptState,
  to: PaymentAttemptState,
  proofBackedSubmittedFailure = false
): void {
  if (from === "submitted" && to === "failed" && proofBackedSubmittedFailure) return;
  const allowed: Record<PaymentAttemptState, readonly PaymentAttemptState[]> = {
    planned: ["prepared", "failed"],
    prepared: ["submitted", "failed"],
    submitted: ["observed"],
    observed: [],
    failed: [],
  };
  if (!allowed[from].includes(to)) {
    throw new JournalInvariantError(`invalid Payment Attempt transition ${from} -> ${to}`);
  }
}

function assertEffectTransition(from: EffectState, to: EffectState): void {
  const allowed: Record<EffectState, readonly EffectState[]> = {
    planned: ["executing", "abandoned"],
    executing: ["submitted", "ambiguous", "retryable", "observed", "failed_terminal"],
    submitted: ["ambiguous", "retryable", "observed", "failed_terminal"],
    ambiguous: ["retryable", "observed", "failed_terminal"],
    retryable: ["executing", "failed_terminal", "abandoned"],
    observed: [],
    failed_terminal: [],
    abandoned: [],
  };
  if (from !== to && !allowed[from].includes(to)) {
    throw new JournalInvariantError(`invalid Effect transition ${from} -> ${to}`);
  }
}

function decimalBigInt(value: string, label: string, allowZero = false): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new PolicyReservationError(`${label} must be an unsigned decimal integer`);
  }
  const parsed = BigInt(value);
  if (allowZero ? parsed < 0n : parsed <= 0n) {
    throw new PolicyReservationError(`${label} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return parsed;
}

function validateTreasuryOperationIntent(input: TreasuryOperationIntent): void {
  assertTreasuryOperationKey(input.operationKey);
  assertDigest(input.requestDigest, "direct Treasury request digest");
  if (
    input.kind !== "wallet_send" &&
    input.kind !== "vault_send" &&
    input.kind !== "vault_deposit"
  ) {
    throw new JournalInvariantError("direct Treasury operation kind is invalid");
  }
  if (
    typeof input.destination !== "string" ||
    input.destination.length > 256 ||
    !/^kaspatest:[a-z0-9]+$/.test(input.destination)
  ) {
    throw new JournalInvariantError("direct Treasury destination is invalid");
  }
  if (input.requestedAmountAtomic !== "max") {
    decimalBigInt(input.requestedAmountAtomic, "direct Treasury requested amount");
  }
  if (input.kind !== "vault_deposit" && input.requestedAmountAtomic === "max") {
    throw new JournalInvariantError("direct send Treasury operation requires an exact amount");
  }
  if (input.keepFloatAtomic !== undefined) {
    if (input.kind !== "vault_deposit") {
      throw new JournalInvariantError("keep-float applies only to vault deposits");
    }
    decimalBigInt(input.keepFloatAtomic, "vault deposit keep-float", true);
  }
  decimalBigInt(input.feeCeilingAtomic, "direct Treasury fee ceiling");
  if (!Number.isSafeInteger(input.retryLimit) || input.retryLimit <= 0 || input.retryLimit > 128) {
    throw new JournalInvariantError("direct Treasury retry limit is invalid");
  }
  assertDigest(input.policyDigest, "direct Treasury policy digest");
}

function validatePreparedTreasuryOperation(input: PreparedTreasuryOperation): void {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > 2_000_000
  ) {
    throw new JournalInvariantError("direct Treasury prepared material is empty or oversized");
  }
  assertTransactionId(input.transactionId);
  decimalBigInt(input.amountAtomic, "direct Treasury prepared amount");
  decimalBigInt(input.feeAtomic, "direct Treasury prepared fee", true);
  assertDigest(input.policyDigest, "direct Treasury prepared policy digest");
}

function assertSameTreasuryOperationIntent(
  existing: TreasuryOperationRecord,
  input: TreasuryOperationIntent
): void {
  if (
    existing.requestDigest !== input.requestDigest ||
    existing.kind !== input.kind ||
    existing.destination !== input.destination ||
    existing.requestedAmountAtomic !== input.requestedAmountAtomic ||
    existing.keepFloatAtomic !== input.keepFloatAtomic ||
    existing.retryLimit !== input.retryLimit
  ) {
    throw new JournalInvariantError(
      "direct Treasury operation key is already bound to different immutable intent"
    );
  }
}

function assertTreasuryOperationKey(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new JournalInvariantError(
      "direct Treasury operation key must be 1-160 canonical characters"
    );
  }
}

function canonicalTreasuryObservationJson(value: unknown): string {
  return JSON.stringify(sortTreasuryJson(value));
}

function directTreasuryTransitionAllowed(
  from: TreasuryOperationState,
  to: TreasuryOperationState
): boolean {
  return (
    from === to ||
    (from === "intent" && (to === "intent" || to === "prepared" || to === "failed_terminal")) ||
    (from === "prepared" && to === "submission_planned") ||
    (from === "submission_planned" &&
      (to === "prepared" || to === "submitted" || to === "observed")) ||
    (from === "submitted" && (to === "prepared" || to === "observed")) ||
    (from === "observed" && to === "completed")
  );
}

function storageRefForDigest(digest: Sha256Digest): string {
  assertDigest(digest, "evidence digest");
  return `sha256-${digest.slice("sha256:".length)}.evidence`;
}

function sortTreasuryJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortTreasuryJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortTreasuryJson(child)])
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")
  );
}

function assertDigest(value: string, label: string): void {
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new JournalInvariantError(`${label} must be a SHA-256 base64url digest`);
  }
}

function assertCode(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new JournalInvariantError(`${label} must be a bounded machine-readable code`);
  }
}

function assertSafeIdentity(value: string, label: string, maxLength: number): void {
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
}

function assertBoundedText(value: string, label: string, maxLength: number): void {
  if (!value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
}

function strictTimestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new JournalInvariantError(`${label} must be strict RFC3339`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new JournalInvariantError(`${label} is outside the supported timestamp range`);
  }
  return timestamp;
}

function assertTransactionId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new JournalInvariantError("invalid canonical Kaspa transaction identity");
}

function assertVaultFundingSource(value: FundingSource): void {
  if (value !== "vault-treasury") {
    throw new JournalInvariantError("initial Purchase profile requires vault-treasury funding");
  }
}

function safeExpiry(now: number, ttlMs: number): number {
  const expiresAtMs = now + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) throw new JournalInvariantError("lease expiry exceeds safe timestamp range");
  return expiresAtMs;
}

interface PreparedJournalDatabasePath {
  readonly state: SecureLocalStateDirectory;
  readonly basename: string;
}

function prepareDatabasePath(filename: string): PreparedJournalDatabasePath | undefined {
  if (filename === ":memory:") return undefined;
  try {
    const state = new SecureLocalStateDirectory(
      path.dirname(path.resolve(filename)),
      "Purchase Journal"
    );
    const basename = path.basename(filename);
    if (!state.fileExists(basename)) {
      state.createEmptyFileExclusive(basename);
    }
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      state.fileExists(`${basename}${suffix}`);
    }
    return Object.freeze({ state, basename });
  } catch (error) {
    throw new JournalInvariantError(
      "Purchase Journal database path is unsafe",
      { cause: error }
    );
  }
}

function validateDatabaseFiles(pathInfo: PreparedJournalDatabasePath | undefined): void {
  if (!pathInfo) return;
  try {
    if (!pathInfo.state.fileExists(pathInfo.basename)) {
      throw new Error("Purchase Journal database disappeared during open");
    }
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      pathInfo.state.fileExists(`${pathInfo.basename}${suffix}`);
    }
  } catch (error) {
    throw new JournalInvariantError(
      "Purchase Journal database files are unsafe",
      { cause: error }
    );
  }
}

function validateChainEvidenceRecord(record: Readonly<ChainEvidenceRecord>): void {
  if (
    record.profile !== "urn:sompi:chain-evidence:testnet-10:1" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(record.operationId) ||
    !/^[a-f0-9]{64}$/.test(record.transactionId) ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(record.outputsDigest) ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(record.detailDigest) ||
    !Number.isSafeInteger(record.observedAtMs) || record.observedAtMs <= 0
  ) throw new JournalInvariantError("Chain Evidence record is invalid");
  const present = record.status === "present";
  if (present !== (record.level !== undefined && record.view !== undefined)) {
    throw new JournalInvariantError("Chain Evidence presence fields are inconsistent");
  }
  const accepted = record.level === "accepted" || record.level === "depth-confirmed" || record.level === "consensus-final";
  if (accepted !== Boolean(record.blockHash && record.acceptingBlockHash && record.acceptingBlockDaaScore && record.virtualDaaScore)) {
    throw new JournalInvariantError("accepted Chain Evidence has incomplete anchors");
  }
}

function chainEvidenceFromRow(row: ChainEvidenceRow): ChainEvidenceRecord {
  const record: ChainEvidenceRecord = {
    profile: "urn:sompi:chain-evidence:testnet-10:1",
    operationId: row.operation_id,
    operation: row.operation,
    transactionId: row.transaction_id,
    status: row.status,
    ...(row.level ? { level: row.level } : {}),
    ...(row.view ? { view: row.view } : {}),
    mechanism: row.mechanism,
    protocolFinality: row.protocol_finality,
    operatorFloor: row.operator_floor,
    effectiveFloor: row.effective_floor,
    primaryProfile: row.primary_profile,
    witnessProfile: row.witness_profile,
    ...(row.block_hash ? { blockHash: row.block_hash } : {}),
    ...(row.accepting_block_hash ? { acceptingBlockHash: row.accepting_block_hash } : {}),
    ...(row.accepting_block_daa_score ? { acceptingBlockDaaScore: row.accepting_block_daa_score } : {}),
    ...(row.virtual_daa_score ? { virtualDaaScore: row.virtual_daa_score } : {}),
    outputsDigest: row.outputs_digest,
    detailDigest: row.detail_digest,
    observedAtMs: row.observed_at_ms,
  };
  validateChainEvidenceRecord(record);
  return Object.freeze(record);
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}
