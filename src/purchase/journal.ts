import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { EvidenceStore, type StoredEvidence } from "./evidence-store";
import {
  assertPurchaseId,
  assertPurchaseRequestKey,
  canonicalRequestUrl,
  createPaymentIdentifier,
  evidenceDigest,
} from "./identity";
import {
  expectedSchemaFingerprint,
  JOURNAL_APPLICATION_ID,
  JOURNAL_SCHEMA_CHECKSUM,
  JOURNAL_SCHEMA_SQL,
  JOURNAL_SCHEMA_VERSION,
  schemaFingerprint,
} from "./journal-schema";
import { assertPurchaseTransition } from "./state-machine";
import type {
  PaymentIdentifier,
  PurchaseId,
  PurchaseRequestKey,
  PurchaseState,
  Sha256Digest,
} from "./types";

const PAYMENT_ATTEMPT_STATES = ["planned", "prepared", "submitted", "observed", "failed"] as const;
const EFFECT_STATES = [
  "planned",
  "executing",
  "submitted",
  "ambiguous",
  "retryable",
  "observed",
  "failed_terminal",
] as const;
const RESERVATION_STATES = ["active", "in_flight", "spent", "released", "expired"] as const;

type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];
export type EffectState = (typeof EFFECT_STATES)[number];
type ReservationState = (typeof RESERVATION_STATES)[number];

export type JournalFaultPoint =
  | "purchase.after_insert"
  | "purchase_transition.after_state_update"
  | "evidence.after_metadata_insert"
  | "policy.after_snapshot_insert"
  | "reservation.after_insert"
  | "payment_attempt.after_insert"
  | "payment_preparation.after_insert"
  | "effect.after_insert"
  | "effect_claim.after_effect_update"
  | "spend.after_insert";

export interface PurchaseJournalOptions {
  now?: () => number;
  busyTimeoutMs?: number;
  evidenceDirectory?: string;
  preparedMaterialDirectory?: string;
  faultInjector?: (point: JournalFaultPoint) => void;
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
  mediaType: string;
  profile: string;
  issuer?: string;
  byteLength: number;
  storageRef: string;
  createdAtMs: number;
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
  feeCeilingAtomic: string;
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
  feeCeilingAtomic: string;
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
}

export interface PaymentPreparationRecord extends Omit<PreparePaymentAttemptInput, "preparedBytes"> {
  preparedRef: string;
  preparedByteLength: number;
  createdAtMs: number;
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
  | { status: "failed_terminal"; errorCode: string; detailDigest?: Sha256Digest };

export interface EffectObservationRecord {
  id: number;
  effectId: string;
  status:
    | "observed"
    | "pending"
    | "not_found_retryable"
    | "not_found_ambiguous"
    | "conflict"
    | "failed_terminal";
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
  actualFeeAtomic: string;
  asset: string;
  payee: string;
  network: string;
  finality: string;
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

export class PurchaseJournal {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly faultInjector?: (point: JournalFaultPoint) => void;
  private readonly evidenceStore?: EvidenceStore;
  private readonly preparedMaterialStore?: EvidenceStore;

  constructor(readonly filename: string, options: PurchaseJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.faultInjector = options.faultInjector;
    prepareDatabasePath(filename);
    this.db = new Database(filename);
    try {
      if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
      this.configure(options.busyTimeoutMs ?? 5_000);
      this.migrate();
      const evidenceDirectory =
        options.evidenceDirectory ?? (filename === ":memory:" ? undefined : `${filename}.evidence`);
      this.evidenceStore = evidenceDirectory ? new EvidenceStore(evidenceDirectory) : undefined;
      const preparedMaterialDirectory =
        options.preparedMaterialDirectory ?? (filename === ":memory:" ? undefined : `${filename}.prepared`);
      this.preparedMaterialStore = preparedMaterialDirectory
        ? new EvidenceStore(preparedMaterialDirectory)
        : undefined;
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
      this.inject("purchase.after_insert");
      this.insertPurchaseTransition(input.id, undefined, "created", "purchase_created", undefined, now);
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

  storeEvidence(purchaseId: PurchaseId, input: StoreEvidenceInput): EvidenceArtifactRecord {
    validateEvidenceMetadata(input);
    if (!this.evidenceStore) {
      throw new JournalInvariantError("an evidence directory is required for immutable evidence storage");
    }
    const stored = this.evidenceStore.store(input.bytes);
    const attach = this.db.transaction(() => {
      this.requirePurchase(purchaseId);
      if (input.attempt !== undefined) this.requirePaymentAttempt(purchaseId, input.attempt);
      const existing = this.findEvidence(stored.digest);
      if (existing) {
        assertSameEvidence(existing, input, stored.byteLength, stored.storageRef);
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
            input.mediaType,
            input.profile,
            input.issuer ?? null,
            stored.byteLength,
            stored.storageRef,
            now
          );
        this.inject("evidence.after_metadata_insert");
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO evidence_links (purchase_id, digest, kind, attempt)
           VALUES (?, ?, ?, ?)`
        )
        .run(purchaseId, stored.digest, input.kind, input.attempt ?? null);
      return this.requireEvidence(stored.digest);
    });
    return attach.immediate();
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
      const fee = decimalBigInt(input.feeCeilingAtomic, "reservation fee ceiling", true);
      const gross = amount + fee;
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
              amount_atomic, fee_ceiling_atomic, state, expires_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
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
          input.feeCeilingAtomic,
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
      if (reservation.purchaseId !== input.purchaseId || reservation.state !== "active") {
        throw new JournalInvariantError("Payment preparation requires this Purchase's active Treasury Reservation");
      }
      if (reservation.amountAtomic !== input.amountAtomic || reservation.payee !== input.payee) {
        throw new JournalInvariantError("payment preparation does not match its Treasury Reservation");
      }
      if (reservation.expiresAtMs <= this.timestamp()) {
        throw new PolicyReservationError("Treasury Reservation expired before payment preparation");
      }
      const now = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO payment_preparations
             (purchase_id, attempt, reservation_id, requirements_digest, payload_digest,
              prepared_ref, prepared_byte_length, transaction_id, amount_atomic, asset,
              network, payee, required_finality, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      if (reservation.policyDigest !== this.requireActivePolicy().digest) {
        throw new PolicyReservationError("active treasury policy changed before payment submission");
      }
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      if (effect.state === "planned") {
        if (attempt.state !== "prepared" || reservation.state !== "active") {
          throw new JournalInvariantError("first payment submission requires prepared Attempt and active Reservation");
        }
        if (reservation.expiresAtMs <= now) throw new PolicyReservationError("reservation expired before submission");
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
        if (observation.status !== "failed_terminal" || effect.errorCode !== observation.errorCode) {
          throw new JournalInvariantError(`conflicting terminal observation for Effect ${effectId}`);
        }
        return effect;
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
        preparation.requiredFinality !== input.finality
      ) {
        throw new JournalInvariantError("observed spend does not match immutable payment preparation");
      }
      const reservation = this.requireReservation(input.reservationId);
      if (reservation.state !== "in_flight") {
        throw new JournalInvariantError(`observed spend requires in-flight Reservation, found ${reservation.state}`);
      }
      const amount = decimalBigInt(input.actualAmountAtomic, "actual spend amount");
      const fee = decimalBigInt(input.actualFeeAtomic, "actual spend fee", true);
      if (amount !== BigInt(reservation.amountAtomic) || fee > BigInt(reservation.feeCeilingAtomic)) {
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
              actual_amount_atomic, actual_fee_atomic, asset, payee, network, finality,
              evidence_digest, evidence_verification_profile, evidence_verifier_id, observed_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.effectId,
          input.reservationId,
          effect.purchaseId,
          effect.attempt,
          input.transactionId,
          input.outpoint ?? null,
          input.actualAmountAtomic,
          input.actualFeeAtomic,
          input.asset,
          input.payee,
          input.network,
          input.finality,
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
             WHERE purchase_id = ? AND state NOT IN ('observed', 'failed_terminal')
             ORDER BY created_at_ms, id`
          )
          .all(purchaseId) as EffectRow[])
      : (this.db
          .prepare(
            `SELECT * FROM effects
             WHERE state NOT IN ('observed', 'failed_terminal')
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
      this.assertRecoveryLease(lease);
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

  private migrate(): void {
    const version = this.schemaVersion();
    const applicationId = this.db.pragma("application_id", { simple: true }) as number;
    if (version > JOURNAL_SCHEMA_VERSION) {
      throw new JournalInvariantError(
        `Purchase Journal schema ${version} is newer than supported schema ${JOURNAL_SCHEMA_VERSION}`
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
          transition.reason_code === "payment_abandoned_after_not_found" &&
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
      if (
        reservation.purchaseId !== preparation.purchaseId ||
        reservation.amountAtomic !== preparation.amountAtomic ||
        reservation.payee !== preparation.payee
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
      if (effect.attempt !== undefined && effect.state !== "planned") {
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

    const reservations = this.db.prepare("SELECT * FROM treasury_reservations").all() as ReservationRow[];
    for (const row of reservations) {
      const reservation = reservationFromRow(row);
      const spend = this.findSpend(reservation.id);
      if ((reservation.state === "spent") !== Boolean(spend)) {
        throw new JournalInvariantError(`Treasury Reservation ${reservation.id} spend state is inconsistent`);
      }
      if (reservation.state === "in_flight" || reservation.state === "spent" || reservation.releaseEvidenceDigest) {
        const preparationRow = this.db
          .prepare("SELECT * FROM payment_preparations WHERE reservation_id = ?")
          .get(reservation.id) as PaymentPreparationRow | undefined;
        if (!preparationRow) throw new JournalInvariantError(`Treasury Reservation ${reservation.id} has no preparation`);
        const attempt = this.requirePaymentAttempt(
          preparationRow.purchase_id as PurchaseId,
          preparationRow.attempt
        );
        const paymentEffects = (
          this.db
            .prepare("SELECT * FROM effects WHERE purchase_id = ? AND attempt = ?")
            .all(preparationRow.purchase_id, preparationRow.attempt) as EffectRow[]
        ).map(effectFromRow);
        if (reservation.state === "in_flight" && attempt.state !== "submitted") {
          throw new JournalInvariantError(`in-flight Treasury Reservation ${reservation.id} has invalid Attempt state`);
        }
        if (
          reservation.state === "in_flight" &&
          !paymentEffects.some((effect) =>
            ["executing", "submitted", "ambiguous", "retryable", "failed_terminal"].includes(effect.state)
          )
        ) {
          throw new JournalInvariantError(`in-flight Treasury Reservation ${reservation.id} has no recoverable Effect`);
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
          !paymentEffects.some((effect) => effect.state === "failed_terminal")
        ) {
          throw new JournalInvariantError(`released Treasury Reservation ${reservation.id} has no terminal Effect`);
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
        spend.finality !== preparation.requiredFinality ||
        effect.state !== "observed" ||
        effect.resultDigest !== spend.evidenceDigest
      ) {
        throw new JournalInvariantError(`Treasury spend ${spend.id} is inconsistent with immutable preparation`);
      }
    }

    const artifacts = this.db.prepare("SELECT * FROM evidence_artifacts").all() as EvidenceArtifactRow[];
    for (const row of artifacts) {
      if (!this.evidenceStore) throw new JournalInvariantError("evidence metadata exists without evidence storage");
      this.evidenceStore.verify(row.digest as Sha256Digest, row.byte_length);
    }
  }

  private findPolicy(digest: Sha256Digest): PolicySnapshotRecord | undefined {
    const row = this.db.prepare("SELECT * FROM policy_snapshots WHERE digest = ?").get(digest) as
      | PolicySnapshotRow
      | undefined;
    return row ? policyFromRow(row, this.policyAllowlist(row.digest)) : undefined;
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

  private assertRecoveryLease(token: LeaseToken): void {
    if (token.name !== "purchase-reconciliation") {
      throw new JournalFencingError("reconciliation writes require the recovery lease");
    }
    this.assertLeaseInternal(token);
  }

  private assertEffectWriter(effectId: string, token: LeaseToken): void {
    this.assertLeaseInternal(token);
    const effect = this.requireEffect(effectId);
    if (token.name === "purchase-reconciliation") {
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

  private policyCapacityUsedInternal(now: number): bigint {
    const reservationRows = this.db
      .prepare(
        `SELECT amount_atomic, fee_ceiling_atomic FROM treasury_reservations
         WHERE (state = 'active' AND expires_at_ms > ?) OR state = 'in_flight'`
      )
      .all(now) as Array<{ amount_atomic: string; fee_ceiling_atomic: string }>;
    const cutoff = now - 60 * 60 * 1000;
    const spendRows = this.db
      .prepare(
        `SELECT actual_amount_atomic, actual_fee_atomic FROM treasury_spends
         WHERE observed_at_ms >= ?`
      )
      .all(cutoff) as Array<{ actual_amount_atomic: string; actual_fee_atomic: string }>;
    return (
      reservationRows.reduce(
        (total, row) => total + BigInt(row.amount_atomic) + BigInt(row.fee_ceiling_atomic),
        0n
      ) +
      spendRows.reduce(
        (total, row) => total + BigInt(row.actual_amount_atomic) + BigInt(row.actual_fee_atomic),
        0n
      )
    );
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

interface PurchaseTransitionRow {
  sequence: number;
  purchase_id: string;
  from_state: PurchaseState | null;
  to_state: PurchaseState;
  reason_code: string;
  detail_digest: string | null;
  created_at_ms: number;
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
  fee_ceiling_atomic: string;
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
  created_at_ms: number;
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
  actual_fee_atomic: string;
  asset: string;
  payee: string;
  network: string;
  finality: string;
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

function evidenceFromRow(row: EvidenceArtifactRow): EvidenceArtifactRecord {
  return {
    digest: row.digest as Sha256Digest,
    mediaType: row.media_type,
    profile: row.profile,
    issuer: row.issuer ?? undefined,
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
    feeCeilingAtomic: row.fee_ceiling_atomic,
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
    createdAtMs: row.created_at_ms,
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
    actualFeeAtomic: row.actual_fee_atomic,
    asset: row.asset,
    payee: row.payee,
    network: row.network,
    finality: row.finality,
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
  decimalBigInt(input.feeCeilingAtomic, "reservation fee ceiling", true);
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
  assertSafeIdentity(input.requiredFinality, "prepared payment finality", 100);
  if (!Number.isSafeInteger(input.preparedBytes.byteLength) || input.preparedBytes.byteLength < 1) {
    throw new JournalInvariantError("prepared payment bytes must not be empty");
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
  if (observation.status === "failed_terminal") assertCode(observation.errorCode, "effect error code");
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
  decimalBigInt(input.actualFeeAtomic, "actual spend fee", true);
  assertSafeIdentity(input.asset, "spend asset", 40);
  assertBoundedText(input.payee, "spend payee", 300);
  assertSafeIdentity(input.network, "spend network", 100);
  assertSafeIdentity(input.finality, "spend finality", 100);
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

function assertSameEvidence(
  existing: EvidenceArtifactRecord,
  input: StoreEvidenceInput,
  byteLength: number,
  storageRef: string
): void {
  if (
    existing.mediaType !== input.mediaType ||
    existing.profile !== input.profile ||
    existing.issuer !== input.issuer ||
    existing.byteLength !== byteLength ||
    existing.storageRef !== storageRef
  ) {
    throw new JournalInvariantError(`evidence metadata conflict for ${existing.digest}`);
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
    existing.feeCeilingAtomic !== input.feeCeilingAtomic ||
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
  ) {
    throw new JournalInvariantError("immutable payment preparation conflict");
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
    existing.actualFeeAtomic !== input.actualFeeAtomic ||
    existing.asset !== input.asset ||
    existing.payee !== input.payee ||
    existing.network !== input.network ||
    existing.finality !== input.finality ||
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
    case "failed_terminal":
      return {
        status: "failed_terminal",
        nextState: "failed_terminal",
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
    planned: ["executing"],
    executing: ["submitted", "ambiguous", "retryable", "observed", "failed_terminal"],
    submitted: ["ambiguous", "retryable", "observed", "failed_terminal"],
    ambiguous: ["retryable", "observed", "failed_terminal"],
    retryable: ["executing", "failed_terminal"],
    observed: [],
    failed_terminal: [],
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

function assertTransactionId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new JournalInvariantError("invalid canonical Kaspa transaction identity");
}

function safeExpiry(now: number, ttlMs: number): number {
  const expiresAtMs = now + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) throw new JournalInvariantError("lease expiry exceeds safe timestamp range");
  return expiresAtMs;
}

function prepareDatabasePath(filename: string): void {
  if (filename === ":memory:") return;
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JournalInvariantError("Purchase Journal directory is unsafe");
  if ((stat.mode & 0o077) !== 0) {
    throw new JournalInvariantError("Purchase Journal directory must not be accessible by group or other users");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new JournalInvariantError("Purchase Journal directory must be owned by the current user");
  }
  if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) {
    throw new JournalInvariantError("Purchase Journal file must not be a symbolic link");
  }
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}
