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
import {
  canonicalPurchaseExecutionPlan,
  channelEpochDigest,
  type CanonicalPurchaseExecutionPlan,
  type PurchaseExecutionAssurance,
  type PurchaseExecutionMechanism,
  type PurchaseExecutionPlan,
} from "./execution-plan.js";
import type {
  PreparedTreasuryOperation,
  TreasuryOperationIntent,
  TreasuryOperationPreflight,
  TreasuryOperationObservationStatus,
  TreasuryOperationRecord,
  TreasuryOperationState,
  TreasurySubmissionOutcome,
  TreasuryDriverClaim,
  TreasuryDriverLease,
} from "../treasury/operation-journal.js";
import type { ChainEvidenceRecord } from "../chain-evidence/types.js";
import {
  validateAdmissionBudgets,
  type AdmissionBudgetProjection,
} from "../admission.js";
import { assertTransferTransition } from "../transfer/state-machine.js";
import type {
  TransferAuthorizationFacts,
  TransferAuthorizationRecord,
  TransferAuthorityDecision,
  TransferReceipt,
  TransferRecord,
  TransferState,
} from "../transfer/types.js";
import type { TransferJournalIntent } from "../transfer/journal.js";
import type { TreasuryOperationView } from "../treasury/operations.js";

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
export const PURCHASE_RECEIPT_PROFILE = "urn:sompi:receipt:purchase:1" as const;

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
  "settlement.after_insert",
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
  "batch_channel.after_insert",
  "batch_channel.after_update",
  "batch_movement.after_insert",
  "transfer.after_insert",
  "transfer_transition.after_state_update",
  "transfer_authorization.after_insert",
  "transfer_treasury_bind.after_update",
  "transfer_treasury_sync.after_update",
  "transfer_receipt.after_insert",
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

function transferFromRow(row: TransferRow): TransferRecord {
  return Object.freeze({
    id: row.id,
    requestKey: row.request_key,
    requestDigest: row.request_digest,
    state: row.state,
    destination: row.destination,
    amountAtomic: row.amount_atomic,
    asset: row.asset,
    network: row.network,
    sourceVaultAddress: row.source_vault_address,
    sourceVaultDigest: row.source_vault_digest,
    feeCeilingAtomic: row.fee_ceiling_atomic,
    maximumTotalAtomic: row.maximum_total_atomic,
    expiresAtMs: row.expires_at_ms,
    policyDigest: row.policy_digest,
    manifestRevision: row.manifest_revision,
    manifestDigest: row.manifest_digest,
    finalityFloor: row.finality_floor,
    ...(row.treasury_operation_key === null ? {} : { treasuryOperationKey: row.treasury_operation_key }),
    ...(row.transaction_id === null ? {} : { transactionId: row.transaction_id }),
    ...(row.actual_fee_atomic === null ? {} : { actualFeeAtomic: row.actual_fee_atomic }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  });
}

function transferAuthorizationFromRow(row: TransferAuthorizationRow): TransferAuthorizationRecord {
  let facts: unknown;
  try { facts = JSON.parse(row.facts_json); } catch {
    throw new JournalInvariantError("Transfer authorization facts JSON is invalid");
  }
  if (evidenceDigest(row.facts_json) !== row.facts_digest) {
    throw new JournalInvariantError("Transfer authorization facts digest changed");
  }
  if (evidenceDigest(row.evidence) !== row.evidence_digest) {
    throw new JournalInvariantError("Transfer authorization evidence digest changed");
  }
  return Object.freeze({
    transferId: row.transfer_id,
    facts: facts as TransferAuthorizationFacts,
    factsDigest: row.facts_digest,
    decision: row.decision,
    authorityId: row.authority_id,
    ...(row.denial_code === null ? {} : { denialCode: row.denial_code }),
    evidenceDigest: row.evidence_digest,
    verificationProfile: row.verification_profile,
    verifierId: row.verifier_id,
    decidedAtMs: row.decided_at_ms,
    expiresAtMs: row.expires_at_ms,
  });
}

function validateTransferIntent(input: TransferJournalIntent): void {
  assertTransferId(input.id);
  assertTransferRequestKey(input.requestKey);
  assertDigest(input.requestDigest, "Transfer request digest");
  assertTransferAddress(input.destination, "Transfer destination");
  assertTransferAtomic(input.amountAtomic, "Transfer amount", false);
  assertTransferAddress(input.sourceVaultAddress, "Transfer source vault");
  assertDigest(input.sourceVaultDigest, "Transfer source vault digest");
  const amount = assertTransferAtomic(input.amountAtomic, "Transfer amount", false);
  const fee = assertTransferAtomic(input.feeCeilingAtomic, "Transfer fee ceiling", true);
  const total = assertTransferAtomic(input.maximumTotalAtomic, "Transfer maximum total", false);
  if (amount + fee !== total) throw new JournalInvariantError("Transfer maximum total is inconsistent");
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
    throw new JournalInvariantError("Transfer expiry is invalid");
  }
  assertDigest(input.policyDigest, "Transfer policy digest");
  if (!Number.isSafeInteger(input.manifestRevision) || input.manifestRevision < 1) {
    throw new JournalInvariantError("Transfer manifest revision is invalid");
  }
  assertDigest(input.manifestDigest, "Transfer manifest digest");
  if (input.finalityFloor !== "accepted" && input.finalityFloor !== "depth-confirmed") {
    throw new JournalInvariantError("Transfer finality floor is invalid");
  }
}

function sameTransferIntent(record: TransferRecord, input: TransferJournalIntent): boolean {
  return record.id === input.id &&
    record.requestDigest === input.requestDigest &&
    record.destination === input.destination &&
    record.amountAtomic === input.amountAtomic &&
    record.sourceVaultAddress === input.sourceVaultAddress &&
    record.sourceVaultDigest === input.sourceVaultDigest &&
    record.feeCeilingAtomic === input.feeCeilingAtomic &&
    record.maximumTotalAtomic === input.maximumTotalAtomic &&
    record.expiresAtMs === input.expiresAtMs &&
    record.policyDigest === input.policyDigest &&
    record.manifestRevision === input.manifestRevision &&
    record.manifestDigest === input.manifestDigest &&
    record.finalityFloor === input.finalityFloor;
}

function canonicalTransferFactsJson(facts: TransferAuthorizationFacts): string {
  if (!facts || facts.profile !== "sompi.transfer.1") {
    throw new JournalInvariantError("Transfer authorization profile is unsupported");
  }
  return JSON.stringify({
    profile: facts.profile,
    transferId: facts.transferId,
    requestKey: facts.requestKey,
    sourceVaultAddress: facts.sourceVaultAddress,
    sourceVaultDigest: facts.sourceVaultDigest,
    destination: facts.destination,
    amountAtomic: facts.amountAtomic,
    asset: facts.asset,
    network: facts.network,
    feeCeilingAtomic: facts.feeCeilingAtomic,
    maximumTotalAtomic: facts.maximumTotalAtomic,
    issuedAt: facts.issuedAt,
    expiresAt: facts.expiresAt,
    policyDigest: facts.policyDigest,
    operatorManifestRevision: facts.operatorManifestRevision,
    operatorManifestDigest: facts.operatorManifestDigest,
    finalityFloor: facts.finalityFloor,
  });
}

function assertTransferFactsMatchIntent(facts: TransferAuthorizationFacts, transfer: TransferRecord): void {
  if (
    facts.transferId !== transfer.id ||
    facts.requestKey !== transfer.requestKey ||
    facts.sourceVaultAddress !== transfer.sourceVaultAddress ||
    facts.sourceVaultDigest !== transfer.sourceVaultDigest ||
    facts.destination !== transfer.destination ||
    facts.amountAtomic !== transfer.amountAtomic ||
    facts.asset !== transfer.asset ||
    facts.network !== transfer.network ||
    facts.feeCeilingAtomic !== transfer.feeCeilingAtomic ||
    facts.maximumTotalAtomic !== transfer.maximumTotalAtomic ||
    Date.parse(facts.issuedAt) !== transfer.createdAtMs ||
    Date.parse(facts.expiresAt) !== transfer.expiresAtMs ||
    facts.policyDigest !== transfer.policyDigest ||
    facts.operatorManifestRevision !== transfer.manifestRevision ||
    facts.operatorManifestDigest !== transfer.manifestDigest ||
    facts.finalityFloor !== transfer.finalityFloor
  ) {
    throw new JournalInvariantError("Transfer authorization facts changed from durable intent");
  }
}

function validateTransferAuthorityDecision(decision: TransferAuthorityDecision): void {
  if (!decision || (decision.decision !== "approved" && decision.decision !== "denied")) {
    throw new JournalInvariantError("Transfer Authority decision is invalid");
  }
  if (!(decision.evidence instanceof Uint8Array) || decision.evidence.byteLength < 1 || decision.evidence.byteLength > 256 * 1024) {
    throw new JournalInvariantError("Transfer Authority evidence is invalid");
  }
  assertDigest(decision.evidenceDigest, "Transfer Authority evidence digest");
  assertDigest(decision.factsDigest, "Transfer Authority facts digest");
  assertBoundedText(decision.authorityId, "Transfer Authority identity", 200);
  assertBoundedText(decision.verificationProfile, "Transfer verification profile", 200);
  assertBoundedText(decision.verifierId, "Transfer verifier identity", 200);
  if (!Number.isSafeInteger(decision.decidedAtMs) || decision.decidedAtMs <= 0) {
    throw new JournalInvariantError("Transfer Authority decision time is invalid");
  }
  if (decision.decision === "approved" && decision.denialCode !== undefined) {
    throw new JournalInvariantError("Approved Transfer has a denial code");
  }
  if (decision.decision === "denied" && decision.denialCode !== "user_denied" && decision.denialCode !== "terms_expired") {
    throw new JournalInvariantError("Denied Transfer has an invalid denial code");
  }
}

function sameTransferAuthorization(
  existing: TransferAuthorizationRecord,
  facts: TransferAuthorizationFacts,
  decision: TransferAuthorityDecision,
): boolean {
  return existing.factsDigest === decision.factsDigest &&
    existing.evidenceDigest === decision.evidenceDigest &&
    existing.decision === decision.decision &&
    existing.authorityId === decision.authorityId &&
    canonicalTransferFactsJson(existing.facts) === canonicalTransferFactsJson(facts);
}

function transferStateForTreasury(operation: TreasuryOperationView): TransferState {
  switch (operation.state) {
    case "intent": return "funds_reserved";
    case "prepared": return "prepared";
    case "submission_planned":
    case "submitted": return "submitted";
    case "observed":
    case "completed": return "settled";
    case "failed_terminal": return "failed_terminal";
  }
}

function assertTransferReceiptMatches(receipt: TransferReceipt, transfer: TransferRecord): void {
  if (
    receipt.profile !== "urn:sompi:receipt:transfer:1" ||
    receipt.transferId !== transfer.id ||
    receipt.requestKey !== transfer.requestKey ||
    receipt.destination !== transfer.destination ||
    receipt.amountAtomic !== transfer.amountAtomic ||
    receipt.network !== transfer.network ||
    receipt.fundingSource !== "vault-treasury" ||
    receipt.fundingSummary !== "Sent securely from your protected Sompi wallet." ||
    receipt.transactionId !== transfer.transactionId ||
    receipt.finality !== transfer.finalityFloor ||
    receipt.feeAtomic !== transfer.actualFeeAtomic ||
    !Number.isFinite(Date.parse(receipt.settledAt))
  ) {
    throw new JournalInvariantError("Transfer receipt does not match settled Transfer facts");
  }
}

function assertTransferId(value: string): void {
  if (typeof value !== "string" || !/^trf_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new JournalInvariantError("Transfer ID is invalid");
  }
}

function assertTransferRequestKey(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new JournalInvariantError("Transfer request key is invalid");
  }
}

function assertTransferAddress(value: string, label: string): void {
  if (typeof value !== "string" || value.length > 256 || !/^kaspatest:[a-z0-9]+$/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
}

function assertTransferAtomic(value: string, label: string, zeroAllowed: boolean): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n || (!zeroAllowed && parsed === 0n)) {
    throw new JournalInvariantError(`${label} is outside uint64 bounds`);
  }
  return parsed;
}

function batchChannelFromRow(row: BatchChannelRow): BatchChannelJournalRecord {
  return Object.freeze({
    channelId: row.channel_id,
    origin: row.origin,
    ...(row.resource_url === null ? {} : { resourceUrl: row.resource_url }),
    network: row.network,
    asset: row.asset,
    templateId: row.template_id,
    clientPublicKey: row.client_public_key,
    serverPublicKey: row.server_public_key,
    payTo: row.pay_to,
    refundAddress: row.refund_address,
    refundTimeoutDaa: row.refund_timeout_daa,
    salt: row.salt,
    activeOutpoint: Object.freeze({ txid: row.active_txid, index: row.active_output_index }),
    activeScriptPublicKey: row.active_script_public_key,
    escrowAddress: row.escrow_address,
    fundingSource: row.funding_source,
    fundingAmountAtomic: row.funding_amount_atomic,
    chargedCumulativeAtomic: row.charged_cumulative_atomic,
    claimedCumulativeAtomic: row.claimed_cumulative_atomic,
    signedCumulativeAtomic: row.signed_cumulative_atomic,
    ...(row.latest_voucher_amount_atomic === null || row.latest_voucher_signature === null
      ? {}
      : { latestVoucher: Object.freeze({
          amountAtomic: row.latest_voucher_amount_atomic,
          signature: row.latest_voucher_signature,
        }) }),
    status: row.status,
    epoch: row.epoch,
    version: row.version,
    ...(row.retired_reason === null ? {} : { retiredReason: row.retired_reason }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  });
}

function batchRaceRecoveryFromRow(row: BatchRaceRecoveryRow): BatchRaceRecoveryRecord {
  return Object.freeze({
    channelId: row.channel_id,
    sourceOutpoint: Object.freeze({
      txid: row.source_txid,
      index: row.source_output_index,
    }),
    refundTransactionId: row.refund_txid,
    ...(row.next_before_cursor === null
      ? {}
      : { nextBeforeCursor: row.next_before_cursor }),
    pagesScanned: row.pages_scanned,
    rowsScanned: row.rows_scanned,
    state: row.state,
    ...(row.winner_txid === null
      ? {}
      : { winnerTransactionId: row.winner_txid }),
    ...(row.evidence_digest === null
      ? {}
      : { evidenceDigest: row.evidence_digest }),
    updatedAtMs: row.updated_at_ms,
  });
}

function normalizeBatchChannel(
  value: Readonly<BatchChannelJournalRecord>,
  now: number
): BatchChannelJournalRecord {
  if (!value || typeof value !== "object") throw new JournalInvariantError("batch channel is invalid");
  requireBatchHash(value.channelId, "batch channel ID");
  requireBatchText(value.origin, "batch channel origin", 2048);
  if (value.resourceUrl !== undefined) requireBatchText(value.resourceUrl, "batch resource URL", 4096);
  if (value.network !== "kaspa:testnet-10" || value.asset !== "KAS" || value.templateId !== "kaspa-x402-escrow-v1") {
    throw new JournalInvariantError("batch channel profile is unsupported");
  }
  requireBatchHash(value.clientPublicKey, "batch client public key");
  requireBatchHash(value.serverPublicKey, "batch server public key");
  requireBatchText(value.payTo, "batch payee", 512);
  requireBatchText(value.refundAddress, "batch refund address", 512);
  requireBatchAtomic(value.refundTimeoutDaa, "batch refund DAA");
  requireBatchHash(value.salt, "batch channel salt");
  requireBatchHash(value.activeOutpoint?.txid, "batch active transaction ID");
  if (!Number.isSafeInteger(value.activeOutpoint?.index) || value.activeOutpoint.index < 0 || value.activeOutpoint.index > 0xffff_ffff) {
    throw new JournalInvariantError("batch active output index is invalid");
  }
  requireBatchHex(value.activeScriptPublicKey, "batch active script public key", 8192);
  requireBatchText(value.escrowAddress, "batch escrow address", 512);
  if (value.fundingSource !== "vault-treasury") throw new JournalInvariantError("batch funding source is unsupported");
  const funding = requireBatchAtomic(value.fundingAmountAtomic, "batch funding amount", true);
  const charged = requireBatchAtomic(value.chargedCumulativeAtomic, "batch charged amount");
  const claimed = requireBatchAtomic(value.claimedCumulativeAtomic, "batch claimed amount");
  const signed = requireBatchAtomic(value.signedCumulativeAtomic, "batch signed amount");
  const suspicious = value.status === "suspicious";
  const unclaimedCharge = charged > claimed ? charged - claimed : 0n;
  if (
    (!suspicious && charged < claimed) ||
    (!suspicious && (signed < unclaimedCharge || funding < unclaimedCharge))
  ) {
    throw new JournalInvariantError("batch channel accounting is inconsistent");
  }
  if (suspicious && (signed !== 0n || value.latestVoucher !== undefined || value.retiredReason === undefined)) {
    throw new JournalInvariantError("suspicious batch channel is not durably fenced");
  }
  if (value.latestVoucher) {
    if (requireBatchAtomic(value.latestVoucher.amountAtomic, "batch voucher amount") !== signed) {
      throw new JournalInvariantError("latest batch voucher does not match signed ceiling");
    }
    requireBatchSignature(value.latestVoucher.signature, "batch voucher signature");
  } else if (signed !== 0n) {
    throw new JournalInvariantError("signed batch channel has no latest voucher");
  }
  if (!["active", "retired", "refundable", "refunded", "suspicious"].includes(value.status)) {
    throw new JournalInvariantError("batch channel status is invalid");
  }
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0 || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new JournalInvariantError("batch channel generation is invalid");
  }
  if (value.retiredReason !== undefined) requireBatchReason(value.retiredReason);
  const createdAtMs = requireBatchTime(value.createdAtMs, "batch channel creation time");
  const updatedAtMs = requireBatchTime(value.updatedAtMs, "batch channel update time");
  if (updatedAtMs < createdAtMs || updatedAtMs > now + 60_000) {
    throw new JournalInvariantError("batch channel timestamps are inconsistent");
  }
  return Object.freeze({
    ...value,
    activeOutpoint: Object.freeze({ ...value.activeOutpoint }),
    ...(value.latestVoucher ? { latestVoucher: Object.freeze({ ...value.latestVoucher }) } : {}),
  });
}

function batchChannelSqlValues(value: BatchChannelJournalRecord): unknown[] {
  return [
    value.channelId, value.origin, value.resourceUrl ?? null, value.network,
    value.asset, value.templateId, value.clientPublicKey, value.serverPublicKey,
    value.payTo, value.refundAddress, value.refundTimeoutDaa, value.salt,
    value.activeOutpoint.txid, value.activeOutpoint.index,
    value.activeScriptPublicKey, value.escrowAddress, value.fundingSource,
    value.fundingAmountAtomic, value.chargedCumulativeAtomic,
    value.claimedCumulativeAtomic, value.signedCumulativeAtomic,
    value.latestVoucher?.amountAtomic ?? null,
    value.latestVoucher?.signature ?? null, value.status, value.epoch,
    value.version, value.retiredReason ?? null, value.createdAtMs,
    value.updatedAtMs,
  ];
}

function assertBatchChannelIdentity(
  previous: BatchChannelJournalRecord,
  next: BatchChannelJournalRecord
): void {
  for (const [label, left, right] of [
    ["origin", previous.origin, next.origin],
    ["network", previous.network, next.network],
    ["asset", previous.asset, next.asset],
    ["template", previous.templateId, next.templateId],
    ["client key", previous.clientPublicKey, next.clientPublicKey],
    ["server key", previous.serverPublicKey, next.serverPublicKey],
    ["payee", previous.payTo, next.payTo],
    ["refund address", previous.refundAddress, next.refundAddress],
    ["refund timeout", previous.refundTimeoutDaa, next.refundTimeoutDaa],
    ["salt", previous.salt, next.salt],
    ["escrow address", previous.escrowAddress, next.escrowAddress],
    ["funding source", previous.fundingSource, next.fundingSource],
  ] as const) {
    if (left !== right) throw new JournalInvariantError(`batch channel ${label} is immutable`);
  }
}

function assertBatchChannelProgress(
  previous: BatchChannelJournalRecord,
  next: BatchChannelJournalRecord
): void {
  if (next.createdAtMs !== previous.createdAtMs || next.updatedAtMs < previous.updatedAtMs) {
    throw new JournalInvariantError("batch channel time moved backward");
  }
  if (previous.status === "refunded" || previous.status === "retired") {
    if (next.status !== previous.status) throw new JournalInvariantError("terminal batch channel cannot reactivate");
  }
  const activeChanged =
    previous.activeOutpoint.txid !== next.activeOutpoint.txid ||
    previous.activeOutpoint.index !== next.activeOutpoint.index;
  if (activeChanged) {
    if (next.epoch !== previous.epoch + 1) {
      throw new JournalInvariantError("batch continuation must advance exactly one epoch");
    }
    if (BigInt(next.chargedCumulativeAtomic) < BigInt(previous.chargedCumulativeAtomic) ||
        BigInt(next.claimedCumulativeAtomic) < BigInt(previous.claimedCumulativeAtomic)) {
      throw new JournalInvariantError("batch continuation cumulative accounting moved backward");
    }
    return;
  }
  if (next.epoch !== previous.epoch || next.fundingAmountAtomic !== previous.fundingAmountAtomic ||
      next.activeScriptPublicKey !== previous.activeScriptPublicKey) {
    throw new JournalInvariantError("same-epoch batch funding identity changed");
  }
  for (const [label, before, after] of [
    ["charged", previous.chargedCumulativeAtomic, next.chargedCumulativeAtomic],
    ["claimed", previous.claimedCumulativeAtomic, next.claimedCumulativeAtomic],
    ["signed", previous.signedCumulativeAtomic, next.signedCumulativeAtomic],
  ] as const) {
    if (BigInt(after) < BigInt(before)) throw new JournalInvariantError(`batch ${label} amount moved backward`);
  }
}

function batchTransitionReason(
  previous: BatchChannelJournalRecord,
  next: BatchChannelJournalRecord
): string {
  if (previous.status !== next.status) return `status_${previous.status}_to_${next.status}`;
  if (previous.epoch !== next.epoch) return "continuation_rotated";
  if (previous.signedCumulativeAtomic !== next.signedCumulativeAtomic) return "voucher_advanced";
  if (previous.chargedCumulativeAtomic !== next.chargedCumulativeAtomic) return "charge_accepted";
  return "channel_refreshed";
}

function requireBatchHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  return value;
}

function optionalBatchHistoryCursor(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  return value;
}

function requireBatchSignature(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{128}$/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  return value;
}

function requireBatchHex(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes * 2 || !/^(?:[a-f0-9]{2})+$/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  return value;
}

function requireBatchAtomic(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n || (positive && parsed === 0n)) {
    throw new JournalInvariantError(`${label} is outside uint64 bounds`);
  }
  return parsed;
}

function requireBatchText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  return value;
}

function requireBatchReason(value: string): string {
  return requireBatchText(value, "batch retirement reason", 256);
}

function requireBatchTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new JournalInvariantError(`${label} is invalid`);
  }
  return value as number;
}

function batchMovementFromRow(row: BatchTreasuryMovementRow): BatchTreasuryMovementRecord {
  return Object.freeze({
    movementId: row.movement_id,
    channelId: row.channel_id,
    ...(row.purchase_id === null ? {} : { purchaseId: assertPurchaseId(row.purchase_id) }),
    kind: row.kind,
    state: row.state,
    requestDigest: row.request_digest,
    ...(row.active_txid_before === null || row.active_output_index_before === null
      ? {}
      : { activeOutpointBefore: Object.freeze({ txid: row.active_txid_before, index: row.active_output_index_before }) }),
    ...(row.active_txid_after === null || row.active_output_index_after === null
      ? {}
      : { activeOutpointAfter: Object.freeze({ txid: row.active_txid_after, index: row.active_output_index_after }) }),
    ...(row.maximum_authorized_atomic === null ? {} : { maximumAuthorizedAtomic: row.maximum_authorized_atomic }),
    ...(row.actual_charge_atomic === null ? {} : { actualChargeAtomic: row.actual_charge_atomic }),
    ...(row.voucher_ceiling_atomic === null ? {} : { voucherCeilingAtomic: row.voucher_ceiling_atomic }),
    ...(row.transaction_id === null ? {} : { transactionId: row.transaction_id }),
    ...(row.prepared_digest === null ? {} : { preparedDigest: row.prepared_digest }),
    ...(row.evidence_digest === null ? {} : { evidenceDigest: row.evidence_digest }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  });
}

function normalizeBatchMovementPlan(
  input: Readonly<PlanBatchTreasuryMovementInput>
): PlanBatchTreasuryMovementInput {
  requireBatchText(input?.movementId, "batch Treasury Movement ID", 256);
  requireBatchHash(input?.channelId, "batch Treasury Movement channel ID");
  if (input.purchaseId !== undefined) assertPurchaseId(input.purchaseId);
  if (!["deposit", "topup", "voucher", "claim", "refund"].includes(input.kind)) {
    throw new JournalInvariantError("batch Treasury Movement kind is invalid");
  }
  if (input.kind === "voucher" ? input.purchaseId === undefined : input.purchaseId !== undefined) {
    throw new JournalInvariantError("only voucher movements bind a Purchase");
  }
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(input.requestDigest)) {
    throw new JournalInvariantError("batch Treasury Movement request digest is invalid");
  }
  if (input.preparedDigest !== undefined && !/^sha256:[A-Za-z0-9_-]{43}$/.test(input.preparedDigest)) {
    throw new JournalInvariantError("batch Treasury Movement preparation digest is invalid");
  }
  const before = input.activeOutpointBefore === undefined
    ? undefined
    : normalizeBatchOutpoint(input.activeOutpointBefore, "batch movement predecessor");
  const maximum = input.maximumAuthorizedAtomic === undefined
    ? undefined
    : requireBatchAtomic(input.maximumAuthorizedAtomic, "batch maximum authorization", true).toString();
  const ceiling = input.voucherCeilingAtomic === undefined
    ? undefined
    : requireBatchAtomic(input.voucherCeilingAtomic, "batch voucher ceiling", true).toString();
  if (input.kind === "voucher" && (maximum === undefined || ceiling === undefined || before === undefined)) {
    throw new JournalInvariantError("voucher movement lacks authorization, ceiling, or active outpoint");
  }
  return Object.freeze({
    ...input,
    ...(before === undefined ? {} : { activeOutpointBefore: before }),
    ...(maximum === undefined ? {} : { maximumAuthorizedAtomic: maximum }),
    ...(ceiling === undefined ? {} : { voucherCeilingAtomic: ceiling }),
  });
}

function normalizeBatchOutpoint(
  value: Readonly<{ txid: string; index: number }>,
  label: string
): Readonly<{ txid: string; index: number }> {
  requireBatchHash(value?.txid, `${label} transaction ID`);
  if (!Number.isSafeInteger(value?.index) || value.index < 0 || value.index > 0xffff_ffff) {
    throw new JournalInvariantError(`${label} output index is invalid`);
  }
  return Object.freeze({ txid: value.txid, index: value.index });
}

function assertBatchMovementTransition(
  from: BatchTreasuryMovementState,
  to: BatchTreasuryMovementState
): void {
  const allowed: Readonly<Record<BatchTreasuryMovementState, readonly BatchTreasuryMovementState[]>> = {
    planned: ["submitted", "ambiguous", "accepted", "failed_terminal"],
    submitted: ["ambiguous", "accepted", "failed_terminal"],
    ambiguous: ["accepted", "failed_terminal"],
    accepted: [],
    failed_terminal: [],
  };
  if (!allowed[from].includes(to)) {
    throw new JournalInvariantError(`invalid batch Treasury Movement transition ${from} -> ${to}`);
  }
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

export type BatchChannelStatus =
  | "active"
  | "retired"
  | "refundable"
  | "refunded"
  | "suspicious";

/** Protocol-adapter state stored in the same SQLite durability boundary. */
export interface BatchChannelJournalRecord {
  readonly channelId: string;
  readonly origin: string;
  readonly resourceUrl?: string;
  readonly network: "kaspa:testnet-10";
  readonly asset: "KAS";
  readonly templateId: "kaspa-x402-escrow-v1";
  readonly clientPublicKey: string;
  readonly serverPublicKey: string;
  readonly payTo: string;
  readonly refundAddress: string;
  readonly refundTimeoutDaa: string;
  readonly salt: string;
  readonly activeOutpoint: Readonly<{ txid: string; index: number }>;
  readonly activeScriptPublicKey: string;
  readonly escrowAddress: string;
  readonly fundingSource: "vault-treasury";
  readonly fundingAmountAtomic: string;
  readonly chargedCumulativeAtomic: string;
  readonly claimedCumulativeAtomic: string;
  readonly signedCumulativeAtomic: string;
  readonly latestVoucher?: Readonly<{ amountAtomic: string; signature: string }>;
  readonly status: BatchChannelStatus;
  readonly epoch: number;
  readonly version: number;
  readonly retiredReason?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface BatchChannelLookup {
  readonly origin?: string;
  readonly resourceUrl?: string;
  readonly network?: "kaspa:testnet-10";
  readonly status?: BatchChannelStatus;
}

export type BatchTreasuryMovementKind = "deposit" | "topup" | "voucher" | "claim" | "refund";
export type BatchTreasuryMovementState = "planned" | "submitted" | "ambiguous" | "accepted" | "failed_terminal";

export interface BatchTreasuryMovementRecord {
  readonly movementId: string;
  readonly channelId: string;
  readonly purchaseId?: PurchaseId;
  readonly kind: BatchTreasuryMovementKind;
  readonly state: BatchTreasuryMovementState;
  readonly requestDigest: Sha256Digest;
  readonly activeOutpointBefore?: Readonly<{ txid: string; index: number }>;
  readonly activeOutpointAfter?: Readonly<{ txid: string; index: number }>;
  readonly maximumAuthorizedAtomic?: string;
  readonly actualChargeAtomic?: string;
  readonly voucherCeilingAtomic?: string;
  readonly transactionId?: string;
  readonly preparedDigest?: Sha256Digest;
  readonly evidenceDigest?: Sha256Digest;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type BatchRaceRecoveryState = "active" | "exhausted" | "accepted";

export interface BatchRaceRecoveryRecord {
  readonly channelId: string;
  readonly sourceOutpoint: Readonly<{ txid: string; index: number }>;
  readonly refundTransactionId: string;
  readonly nextBeforeCursor?: string;
  readonly pagesScanned: number;
  readonly rowsScanned: number;
  readonly state: BatchRaceRecoveryState;
  readonly winnerTransactionId?: string;
  readonly evidenceDigest?: Sha256Digest;
  readonly updatedAtMs: number;
}

export interface PlanBatchTreasuryMovementInput {
  readonly movementId: string;
  readonly channelId: string;
  readonly purchaseId?: PurchaseId;
  readonly kind: BatchTreasuryMovementKind;
  readonly requestDigest: Sha256Digest;
  readonly activeOutpointBefore?: Readonly<{ txid: string; index: number }>;
  readonly maximumAuthorizedAtomic?: string;
  readonly voucherCeilingAtomic?: string;
  readonly preparedDigest?: Sha256Digest;
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
  executionPlan: PurchaseExecutionPlan;
  executionPlanEvidenceDigest: Sha256Digest;
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

export interface PurchaseExecutionPlanRecord extends CanonicalPurchaseExecutionPlan {
  purchaseId: PurchaseId;
  evidenceDigest: Sha256Digest;
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
  executionPlanDigest: Sha256Digest;
  executionMechanism: PurchaseExecutionMechanism;
  executionProfile: string;
  settlementAssurance: PurchaseExecutionAssurance;
  maximumAuthorizedChargeAtomic: string;
  channelId?: string;
  channelEpochDigest?: Sha256Digest;
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
  purchaseId: PurchaseId;
  canonicalDigest: Sha256Digest;
  createdAtMs: number;
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

export interface CreatePurchaseWithEvidenceInput {
  purchase: CreatePurchaseInput;
  evidence: StoreEvidenceInput;
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
  allowlist: readonly string[];
}

export interface PolicySnapshotRecord extends PolicyDefinition {
  digest: Sha256Digest;
  version: number;
  activatedAtMs: number;
}

export interface ActivePolicyRecord {
  readonly policy: PolicySnapshotRecord;
  readonly activationGeneration: number;
}

export type PolicyChangeJournalState =
  | "created"
  | "awaiting_authority"
  | "authorised"
  | "applied"
  | "denied"
  | "expired"
  | "failed";

export interface PolicyChangeJournalRecord {
  id: string;
  requestKey: string;
  state: PolicyChangeJournalState;
  expectedPolicyDigest: Sha256Digest;
  expectedPolicyGeneration: number;
  expectedVaultDigest: Sha256Digest;
  previousMaximumPerPaymentAtomic: string;
  previousMaximumPerHourAtomic: string;
  proposedMaximumPerPaymentAtomic: string;
  proposedMaximumPerHourAtomic: string;
  vaultMaximumOutflowAtomic: string;
  manifestRevision: number;
  manifestDigest: Sha256Digest;
  expiresAtMs: number;
  authorityId?: string;
  authorityEvidenceDigest?: Sha256Digest;
  authorityEvidence?: Uint8Array;
  appliedPolicyDigest?: Sha256Digest;
  appliedPolicyVersion?: number;
  failureCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreatePolicyChangeJournalInput {
  id: string;
  requestKey: string;
  expectedPolicyDigest: Sha256Digest;
  expectedPolicyGeneration: number;
  expectedVaultDigest: Sha256Digest;
  previousMaximumPerPaymentAtomic: string;
  previousMaximumPerHourAtomic: string;
  proposedMaximumPerPaymentAtomic: string;
  proposedMaximumPerHourAtomic: string;
  vaultMaximumOutflowAtomic: string;
  manifestRevision: number;
  manifestDigest: Sha256Digest;
  expiresAtMs: number;
}

export type VaultMigrationJournalState =
  | "created"
  | "awaiting_authority"
  | "awaiting_owner"
  | "executing"
  | "applied"
  | "denied"
  | "expired"
  | "reconciliation_required"
  | "failed";

export interface VaultMigrationJournalRecord {
  id: string;
  requestKey: string;
  state: VaultMigrationJournalState;
  oldVaultDigest: Sha256Digest;
  expectedPolicyDigest: Sha256Digest;
  expectedPolicyGeneration: number;
  oldMaximumOutflowAtomic: string;
  newMaximumOutflowAtomic: string;
  windowSizeDaa: string;
  windowStartDaa: string;
  spentInWindowAtomic: string;
  stableReceiveAddress: string;
  manifestRevision: number;
  manifestDigest: Sha256Digest;
  expiresAtMs: number;
  authorityId?: string;
  authorityEvidenceDigest?: Sha256Digest;
  authorityEvidence?: Uint8Array;
  recoveryTransactionId?: string;
  replacementTransactionId?: string;
  receiptDigest?: Sha256Digest;
  failureCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateVaultMigrationJournalInput {
  id: string;
  requestKey: string;
  oldVaultDigest: Sha256Digest;
  expectedPolicyDigest: Sha256Digest;
  expectedPolicyGeneration: number;
  oldMaximumOutflowAtomic: string;
  newMaximumOutflowAtomic: string;
  windowSizeDaa: string;
  windowStartDaa: string;
  spentInWindowAtomic: string;
  stableReceiveAddress: string;
  manifestRevision: number;
  manifestDigest: Sha256Digest;
  expiresAtMs: number;
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
  executionId: string;
  mechanism: PurchaseExecutionMechanism;
  profile: string;
  transactionId?: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payee: string;
  requiredAssurance: PurchaseExecutionAssurance;
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

export interface RecordPurchaseSettlementInput {
  effectId: string;
  reservationId: string;
  executionId: string;
  mechanism: PurchaseExecutionMechanism;
  profile: string;
  transactionId?: string;
  commitmentId?: string;
  outpoint?: string;
  actualAmountAtomic: string;
  actualAdditionalCostAtomic: string;
  asset: string;
  payee: string;
  network: string;
  settlementAssurance: PurchaseExecutionAssurance;
  fundingSource: FundingSource;
  evidenceDigest: Sha256Digest;
  evidenceVerificationProfile: string;
  evidenceVerifierId: string;
}

export interface PurchaseSettlementRecord extends RecordPurchaseSettlementInput {
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

interface BatchChannelRow {
  channel_id: string;
  origin: string;
  resource_url: string | null;
  network: "kaspa:testnet-10";
  asset: "KAS";
  template_id: "kaspa-x402-escrow-v1";
  client_public_key: string;
  server_public_key: string;
  pay_to: string;
  refund_address: string;
  refund_timeout_daa: string;
  salt: string;
  active_txid: string;
  active_output_index: number;
  active_script_public_key: string;
  escrow_address: string;
  funding_source: "vault-treasury";
  funding_amount_atomic: string;
  charged_cumulative_atomic: string;
  claimed_cumulative_atomic: string;
  signed_cumulative_atomic: string;
  latest_voucher_amount_atomic: string | null;
  latest_voucher_signature: string | null;
  status: BatchChannelStatus;
  epoch: number;
  version: number;
  retired_reason: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface BatchTreasuryMovementRow {
  movement_id: string;
  channel_id: string;
  purchase_id: string | null;
  kind: BatchTreasuryMovementKind;
  state: BatchTreasuryMovementState;
  request_digest: Sha256Digest;
  active_txid_before: string | null;
  active_output_index_before: number | null;
  active_txid_after: string | null;
  active_output_index_after: number | null;
  maximum_authorized_atomic: string | null;
  actual_charge_atomic: string | null;
  voucher_ceiling_atomic: string | null;
  transaction_id: string | null;
  prepared_digest: Sha256Digest | null;
  evidence_digest: Sha256Digest | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface BatchRaceRecoveryRow {
  channel_id: string;
  source_txid: string;
  source_output_index: number;
  refund_txid: string;
  next_before_cursor: string | null;
  pages_scanned: number;
  rows_scanned: number;
  state: BatchRaceRecoveryState;
  winner_txid: string | null;
  evidence_digest: Sha256Digest | null;
  updated_at_ms: number;
}

interface TransferRow {
  id: string;
  request_key: string;
  request_digest: string;
  state: TransferState;
  destination: string;
  amount_atomic: string;
  asset: "KAS";
  network: "kaspa:testnet-10";
  source_vault_address: string;
  source_vault_digest: string;
  fee_ceiling_atomic: string;
  maximum_total_atomic: string;
  expires_at_ms: number;
  policy_digest: string;
  manifest_revision: number;
  manifest_digest: string;
  finality_floor: "accepted" | "depth-confirmed";
  treasury_operation_key: string | null;
  transaction_id: string | null;
  actual_fee_atomic: string | null;
  failure_code: string | null;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface TransferAuthorizationRow {
  transfer_id: string;
  facts_json: string;
  facts_digest: string;
  decision: "approved" | "denied";
  authority_id: string;
  denial_code: string | null;
  evidence: Buffer;
  evidence_digest: string;
  verification_profile: string;
  verifier_id: string;
  decided_at_ms: number;
  expires_at_ms: number;
}

interface TransferReceiptRow {
  transfer_id: string;
  receipt_json: string;
  receipt_digest: string;
  created_at_ms: number;
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
      if (this.admission) {
        this.reconcilePurchaseAdmissionIntents();
        this.reconcileAdmissionLeases();
      }
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

  claimTransferIntent(input: TransferJournalIntent): TransferRecord {
    validateTransferIntent(input);
    const claim = this.db.transaction(() => {
      const byKey = this.findTransferByRequestKey(input.requestKey);
      if (byKey) {
        if (!sameTransferIntent(byKey, input)) {
          throw new JournalInvariantError("Transfer request key is already bound to different intent");
        }
        return byKey;
      }
      if (this.findTransfer(input.id)) {
        throw new JournalInvariantError("Transfer ID is already bound to different intent");
      }
      this.requirePolicy(input.policyDigest as Sha256Digest);
      const manifest = this.operatorManifestIdentity();
      if (
        !manifest ||
        manifest.revision !== input.manifestRevision ||
        manifest.digest !== input.manifestDigest
      ) {
        throw new JournalInvariantError("Transfer intent does not match the bound Operator Manifest");
      }
      const now = this.timestamp();
      this.db.prepare(
        `INSERT INTO transfers (
           id, request_key, request_digest, state, destination, amount_atomic,
           asset, network, source_vault_address, source_vault_digest,
           fee_ceiling_atomic, maximum_total_atomic, expires_at_ms,
           policy_digest, manifest_revision, manifest_digest, finality_floor,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'created', ?, ?, 'KAS', 'kaspa:testnet-10', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.requestKey,
        input.requestDigest,
        input.destination,
        input.amountAtomic,
        input.sourceVaultAddress,
        input.sourceVaultDigest,
        input.feeCeilingAtomic,
        input.maximumTotalAtomic,
        input.expiresAtMs,
        input.policyDigest,
        input.manifestRevision,
        input.manifestDigest,
        input.finalityFloor,
        now,
        now,
      );
      this.db.prepare(
        `INSERT INTO transfer_transitions
           (transfer_id, from_state, to_state, reason_code, created_at_ms)
         VALUES (?, NULL, 'created', 'intent_recorded', ?)`
      ).run(input.id, now);
      this.inject("transfer.after_insert");
      return this.requireTransfer(input.id);
    });
    return claim.immediate();
  }

  findTransferByRequestKey(requestKey: string): TransferRecord | undefined {
    assertTransferRequestKey(requestKey);
    const row = this.db.prepare("SELECT * FROM transfers WHERE request_key = ?").get(requestKey) as TransferRow | undefined;
    return row ? transferFromRow(row) : undefined;
  }

  findTransfer(id: string): TransferRecord | undefined {
    assertTransferId(id);
    const row = this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as TransferRow | undefined;
    return row ? transferFromRow(row) : undefined;
  }

  requireTransfer(id: string): TransferRecord {
    const transfer = this.findTransfer(id);
    if (!transfer) throw new JournalNotFoundError(`Transfer ${id} does not exist`);
    return transfer;
  }

  transitionTransfer(
    id: string,
    to: TransferState,
    reasonCode: string,
    detailDigest?: string,
  ): TransferRecord {
    assertTransferId(id);
    assertBoundedText(reasonCode, "Transfer transition reason", 120);
    if (detailDigest !== undefined) assertDigest(detailDigest, "Transfer transition detail digest");
    const transition = this.db.transaction(() =>
      this.transitionTransferInternal(id, to, reasonCode, detailDigest)
    );
    return transition.immediate();
  }

  recordTransferAuthorization(
    id: string,
    facts: TransferAuthorizationFacts,
    decision: TransferAuthorityDecision,
  ): TransferAuthorizationRecord {
    assertTransferId(id);
    const factsJson = canonicalTransferFactsJson(facts);
    const factsDigest = evidenceDigest(factsJson);
    if (facts.transferId !== id || decision.factsDigest !== factsDigest) {
      throw new JournalInvariantError("Transfer authorization facts do not match the Transfer intent");
    }
    validateTransferAuthorityDecision(decision);
    if (evidenceDigest(decision.evidence) !== decision.evidenceDigest) {
      throw new JournalInvariantError("Transfer authorization evidence digest changed");
    }
    const record = this.db.transaction(() => {
      const transfer = this.requireTransfer(id);
      if (transfer.state !== "awaiting_authority") {
        const existing = this.findTransferAuthorization(id);
        if (existing && sameTransferAuthorization(existing, facts, decision)) return existing;
        throw new JournalInvariantError("Transfer is not awaiting an Authority decision");
      }
      assertTransferFactsMatchIntent(facts, transfer);
      if (decision.decidedAtMs > transfer.expiresAtMs) {
        throw new JournalInvariantError("Transfer authorization was decided after expiry");
      }
      this.db.prepare(
        `INSERT INTO transfer_authorizations (
           transfer_id, facts_json, facts_digest, decision, authority_id,
           denial_code, evidence, evidence_digest, verification_profile,
           verifier_id, decided_at_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        factsJson,
        factsDigest,
        decision.decision,
        decision.authorityId,
        decision.denialCode ?? null,
        Buffer.from(decision.evidence),
        decision.evidenceDigest,
        decision.verificationProfile,
        decision.verifierId,
        decision.decidedAtMs,
        transfer.expiresAtMs,
      );
      this.inject("transfer_authorization.after_insert");
      this.transitionTransferInternal(
        id,
        decision.decision === "approved" ? "authorised" : "denied",
        `authorization_${decision.decision}`,
        decision.evidenceDigest,
      );
      return this.requireTransferAuthorization(id);
    });
    return record.immediate();
  }

  findTransferAuthorization(id: string): TransferAuthorizationRecord | undefined {
    assertTransferId(id);
    const row = this.db.prepare(
      "SELECT * FROM transfer_authorizations WHERE transfer_id = ?"
    ).get(id) as TransferAuthorizationRow | undefined;
    return row ? transferAuthorizationFromRow(row) : undefined;
  }

  requireTransferAuthorization(id: string): TransferAuthorizationRecord {
    const authorization = this.findTransferAuthorization(id);
    if (!authorization) throw new JournalNotFoundError(`Transfer ${id} has no authorization decision`);
    return authorization;
  }

  readTransferAuthorizationEvidence(id: string): Buffer {
    assertTransferId(id);
    const row = this.db.prepare(
      "SELECT evidence FROM transfer_authorizations WHERE transfer_id = ?"
    ).get(id) as { evidence: Buffer } | undefined;
    if (!row) throw new JournalNotFoundError(`Transfer ${id} has no authorization evidence`);
    return Buffer.from(row.evidence);
  }

  bindTransferTreasuryOperation(id: string, operationKey: string): TransferRecord {
    assertTransferId(id);
    assertTreasuryOperationKey(operationKey);
    const bind = this.db.transaction(() => {
      const transfer = this.requireTransfer(id);
      if (transfer.treasuryOperationKey) {
        if (transfer.treasuryOperationKey !== operationKey) {
          throw new JournalInvariantError("Transfer is bound to a different Treasury operation");
        }
        return transfer;
      }
      if (transfer.state !== "authorised") {
        throw new JournalInvariantError("Transfer requires approved Authority evidence before Treasury reservation");
      }
      const authorization = this.findTransferAuthorization(id);
      if (authorization?.decision !== "approved") {
        throw new JournalInvariantError("Transfer approval evidence is unavailable");
      }
      this.db.prepare(
        "UPDATE transfers SET treasury_operation_key = ?, updated_at_ms = ? WHERE id = ?"
      ).run(operationKey, this.timestamp(), id);
      this.inject("transfer_treasury_bind.after_update");
      return this.transitionTransferInternal(id, "funds_reserved", "treasury_operation_bound");
    });
    return bind.immediate();
  }

  syncTransferTreasuryOperation(id: string, operation: TreasuryOperationView): TransferRecord {
    assertTransferId(id);
    const sync = this.db.transaction(() => {
      let transfer = this.requireTransfer(id);
      if (transfer.treasuryOperationKey !== operation.operationKey || operation.kind !== "vault_send") {
        throw new JournalInvariantError("Treasury operation does not belong to this Transfer");
      }
      if (
        operation.destination !== transfer.destination ||
        operation.requestedAmountAtomic !== transfer.amountAtomic ||
        operation.feeCeilingAtomic !== transfer.feeCeilingAtomic
      ) {
        throw new JournalInvariantError("Treasury operation changed the authorized Transfer intent");
      }
      const target = transferStateForTreasury(operation);
      const failure = operation.state === "failed_terminal" ? "treasury_operation_failed" : null;
      this.db.prepare(
        `UPDATE transfers
            SET transaction_id = COALESCE(transaction_id, ?),
                actual_fee_atomic = COALESCE(actual_fee_atomic, ?),
                failure_code = COALESCE(failure_code, ?),
                updated_at_ms = ?
          WHERE id = ?`
      ).run(operation.transactionId ?? null, operation.feeAtomic ?? null, failure, this.timestamp(), id);
      this.inject("transfer_treasury_sync.after_update");
      transfer = this.requireTransfer(id);
      if (transfer.state !== target) {
        transfer = this.transitionTransferInternal(id, target, `treasury_${operation.state}`);
      }
      return transfer;
    });
    return sync.immediate();
  }

  recordTransferReceipt(id: string, receipt: TransferReceipt): TransferReceipt {
    assertTransferId(id);
    const json = JSON.stringify(receipt);
    const digest = evidenceDigest(json);
    const record = this.db.transaction(() => {
      const transfer = this.requireTransfer(id);
      if (transfer.state === "receipted") {
        const existing = this.findTransferReceipt(id);
        if (existing && JSON.stringify(existing) === json) return existing;
        throw new JournalInvariantError("Transfer receipt conflicts with immutable history");
      }
      if (transfer.state !== "settled") throw new JournalInvariantError("Transfer is not settled");
      assertTransferReceiptMatches(receipt, transfer);
      this.db.prepare(
        `INSERT INTO transfer_receipts
           (transfer_id, receipt_json, receipt_digest, created_at_ms)
         VALUES (?, ?, ?, ?)`
      ).run(id, json, digest, this.timestamp());
      this.inject("transfer_receipt.after_insert");
      this.transitionTransferInternal(id, "receipted", "receipt_recorded", digest);
      return receipt;
    });
    return record.immediate();
  }

  findTransferReceipt(id: string): TransferReceipt | undefined {
    assertTransferId(id);
    const row = this.db.prepare(
      "SELECT * FROM transfer_receipts WHERE transfer_id = ?"
    ).get(id) as TransferReceiptRow | undefined;
    if (!row) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(row.receipt_json); } catch {
      throw new JournalInvariantError("Transfer receipt JSON is invalid");
    }
    if (evidenceDigest(row.receipt_json) !== row.receipt_digest) {
      throw new JournalInvariantError("Transfer receipt digest changed");
    }
    return parsed as TransferReceipt;
  }

  listTransfers(limit: number): readonly TransferRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new JournalInvariantError("Transfer activity limit is invalid");
    }
    const rows = this.db.prepare(
      "SELECT * FROM transfers ORDER BY created_at_ms DESC, id DESC LIMIT ?"
    ).all(limit) as TransferRow[];
    return Object.freeze(rows.map(transferFromRow));
  }

  listPurchases(limit: number): readonly PurchaseRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new JournalInvariantError("Purchase activity limit is invalid");
    }
    const rows = this.db.prepare(
      "SELECT * FROM purchases ORDER BY created_at_ms DESC, id DESC LIMIT ?"
    ).all(limit) as PurchaseRow[];
    return Object.freeze(rows.map(purchaseFromRow));
  }

  private transitionTransferInternal(
    id: string,
    to: TransferState,
    reasonCode: string,
    detailDigest?: string,
  ): TransferRecord {
    const current = this.requireTransfer(id);
    assertTransferTransition(current.state, to);
    const now = this.timestamp();
    const changed = this.db.prepare(
      `UPDATE transfers SET state = ?, version = version + 1, updated_at_ms = ?
        WHERE id = ? AND state = ? AND version = ?`
    ).run(to, now, id, current.state, current.version).changes;
    if (changed !== 1) throw new JournalInvariantError("Transfer state changed concurrently");
    this.inject("transfer_transition.after_state_update");
    this.db.prepare(
      `INSERT INTO transfer_transitions
         (transfer_id, from_state, to_state, reason_code, detail_digest, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, current.state, to, reasonCode, detailDigest ?? null, now);
    return this.requireTransfer(id);
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

  /**
   * Offers the Purchase count and mandatory request-body evidence as one
   * durable admission. The immutable Purchase and evidence link are published
   * only after the reversible blob staging step succeeds.
   */
  createPurchaseWithEvidence(input: CreatePurchaseWithEvidenceInput): PurchaseRecord {
    validateCreatePurchase(input.purchase);
    validateEvidenceMetadata(input.evidence);
    if (!(input.evidence.bytes instanceof Uint8Array)) {
      throw new JournalInvariantError("evidence bytes must be a Uint8Array");
    }
    if (!this.admission) {
      const purchase = this.createPurchase(input.purchase);
      try {
        this.storeEvidence(purchase.id, input.evidence);
      } catch (error) {
        throw error;
      }
      return purchase;
    }
    if (!this.evidenceStore) {
      throw new JournalInvariantError("an evidence directory is required for immutable evidence storage");
    }

    const existing = this.findPurchaseByRequestKey(input.purchase.requestKey);
    if (existing) {
      assertSamePurchaseIntent(existing, input.purchase);
      const digest = evidenceDigest(input.evidence.bytes);
      if (!this.findEvidenceAttachmentForKind(existing.id, digest, input.evidence.kind, input.evidence.attempt)) {
        this.storeEvidence(existing.id, input.evidence);
      }
      return existing;
    }

    const digest = evidenceDigest(input.evidence.bytes);
    const admissionId = `purchase-admission:${process.pid}:${randomBytes(12).toString("hex")}`;
    const owner = `purchase-journal:${process.pid}:${randomBytes(8).toString("hex")}`;
    const now = this.timestamp();
    const deadline = now + 60_000;
    const offer = this.db.transaction(() => {
      if (this.findPurchaseByRequestKey(input.purchase.requestKey)) {
        throw new JournalInvariantError("Purchase admission raced another request-key owner");
      }
      if (this.findPurchase(input.purchase.id)) {
        throw new JournalInvariantError(`PurchaseId ${input.purchase.id} already exists`);
      }
      const budget = this.db.prepare(
        `SELECT reserved_purchase_count, reserved_evidence_bytes,
                committed_evidence_bytes, prevalidation_purchase_limit,
                evidence_byte_limit
           FROM journal_admission_budget WHERE singleton = 1`
      ).get() as {
        reserved_purchase_count: number;
        reserved_evidence_bytes: number;
        committed_evidence_bytes: number;
        prevalidation_purchase_limit: number;
        evidence_byte_limit: number;
      } | undefined;
      if (!budget) throw new JournalInvariantError("Journal admission budget is missing");
      const existingArtifact = this.findEvidence(digest);
      const quantity = existingArtifact ? 0 : input.evidence.bytes.byteLength;
      if (budget.reserved_purchase_count + 1 > budget.prevalidation_purchase_limit) {
        throw new PurchaseAdmissionError();
      }
      if (
        budget.reserved_evidence_bytes + budget.committed_evidence_bytes + quantity >
        budget.evidence_byte_limit
      ) {
        throw new EvidenceAdmissionError();
      }
      this.db.prepare(
        `INSERT INTO purchase_admission_intents (
           admission_id, purchase_id, request_key, resource_url, method,
           resource_fingerprint, expected_merchant_id, expected_merchant_origin,
           evidence_digest, evidence_byte_length, evidence_storage_ref,
           evidence_media_type, evidence_profile, evidence_issuer, evidence_kind, state,
           owner, deadline_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?)`
      ).run(
        admissionId,
        input.purchase.id,
        input.purchase.requestKey,
        input.purchase.resourceUrl,
        input.purchase.method,
        input.purchase.resourceFingerprint,
        input.purchase.expectedMerchantId ?? null,
        input.purchase.expectedMerchantOrigin ?? null,
        digest,
        input.evidence.bytes.byteLength,
        storageRefForDigest(digest),
        input.evidence.mediaType,
        input.evidence.profile,
        input.evidence.issuer ?? null,
        input.evidence.kind,
        owner,
        deadline,
        now,
        now,
      );
      this.db.prepare(
        `INSERT INTO admission_leases
           (lease_id, owner, resource, purchase_id, digest, storage_ref,
            quantity, state, deadline_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'evidence_bytes', NULL, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(
        `evidence:${admissionId}`,
        owner,
        digest,
        storageRefForDigest(digest),
        quantity,
        deadline,
        now,
        now,
      );
      this.db.prepare(
        `UPDATE journal_admission_budget
            SET reserved_purchase_count = reserved_purchase_count + 1,
                reserved_evidence_bytes = reserved_evidence_bytes + ?,
                updated_at_ms = ?
          WHERE singleton = 1`
      ).run(quantity, now);
    });
    try {
      offer.immediate();
      this.evidenceStore.store(input.evidence.bytes);
      const staged = this.db.transaction(() => {
        const updated = this.db.prepare(
          `UPDATE purchase_admission_intents
              SET state = 'staged', updated_at_ms = ?
            WHERE admission_id = ? AND state = 'offered' AND owner = ?`
        ).run(this.timestamp(), admissionId, owner);
        if (updated.changes !== 1) {
          throw new JournalInvariantError("Purchase admission staging fence was lost");
        }
      });
      staged.immediate();
      return this.commitPurchaseAdmissionIntent(admissionId, owner);
    } catch (error) {
      this.cancelPurchaseAdmission(admissionId, "failed_terminal");
      throw error;
    }
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
        assertSameExecutionPlan(this.requireExecutionPlan(purchaseId), input.executionPlan, input.executionPlanEvidenceDigest);
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
      const executionPlanAttachment = this.requireEvidenceAttachment(
        purchaseId,
        input.executionPlanEvidenceDigest,
        "execution-plan"
      );
      if (
        checkoutAttachment.issuer !== input.terms.merchant.id ||
        checkoutAttachment.profile !== input.checkoutVerificationProfile ||
        requirementsAttachment.issuer !== input.terms.merchant.id ||
        requirementsAttachment.profile !== input.paymentRequirementsVerificationProfile ||
        executionPlanAttachment.issuer !== "sompi-purchase-module" ||
        executionPlanAttachment.profile !== "urn:sompi:purchase-execution-plan:1"
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
      const executionPlan = canonicalPurchaseExecutionPlan(input.executionPlan);
      if (
        executionPlan.digest !== input.executionPlanEvidenceDigest ||
        executionPlan.requirementsDigest !== input.paymentRequirementsDigest ||
        executionPlan.maximumChargeAtomic !== input.terms.amountAtomic
      ) {
        throw new JournalInvariantError("Purchase execution plan is not bound to Checkout evidence");
      }
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
      this.db.prepare(
        `INSERT INTO purchase_execution_plans (
           purchase_id, plan_digest, mechanism, profile, requirements_digest,
           maximum_charge_atomic, settlement_assurance, channel_id, active_txid,
           active_output_index, active_script_public_key, channel_funding_amount_atomic,
           refund_timeout_daa, claim_fee_reserve_atomic, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        purchaseId,
        executionPlan.digest,
        executionPlan.mechanism,
        executionPlan.profile,
        executionPlan.requirementsDigest,
        executionPlan.maximumChargeAtomic,
        executionPlan.settlementAssurance,
        executionPlan.channelEpoch?.channelId ?? null,
        executionPlan.channelEpoch?.activeOutpoint.txid ?? null,
        executionPlan.channelEpoch?.activeOutpoint.index ?? null,
        executionPlan.channelEpoch?.activeScriptPublicKey ?? null,
        executionPlan.channelEpoch?.fundingAmountAtomic ?? null,
        executionPlan.channelEpoch?.refundTimeoutDaa ?? null,
        executionPlan.claimFeeReserveAtomic ?? null,
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

  requireExecutionPlan(purchaseId: PurchaseId): PurchaseExecutionPlanRecord {
    const row = this.db.prepare(
      "SELECT * FROM purchase_execution_plans WHERE purchase_id = ?"
    ).get(purchaseId) as PurchaseExecutionPlanRow | undefined;
    if (!row) throw new JournalNotFoundError(`Purchase ${purchaseId} has no execution plan`);
    return purchaseExecutionPlanFromRow(row);
  }

  recordAuthorizationRequest(
    purchaseId: PurchaseId,
    input: RecordAuthorizationRequestInput
  ): AuthorizationRequestRecord {
    validateAuthorizationRequestInput(input);
    const record = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      const terms = this.requireCheckoutTerms(purchaseId);
      const executionPlan = this.requireExecutionPlan(purchaseId);
      const existing = this.findAuthorizationRequest(purchaseId);
      if (existing) {
        assertSameAuthorizationRequest(existing, input, executionPlan);
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
              execution_plan_digest, execution_mechanism, execution_profile,
              settlement_assurance, maximum_authorized_charge_atomic, channel_id,
              channel_epoch_digest, expires_at_ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          executionPlan.digest,
          executionPlan.mechanism,
          executionPlan.profile,
          executionPlan.settlementAssurance,
          executionPlan.maximumChargeAtomic,
          executionPlan.channelEpoch?.channelId ?? null,
          channelEpochDigest(executionPlan) ?? null,
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

  storeExecutionPlanEvidence(
    purchaseId: PurchaseId,
    input: PurchaseExecutionPlan
  ): Readonly<{ plan: CanonicalPurchaseExecutionPlan; evidenceDigest: Sha256Digest }> {
    const plan = canonicalPurchaseExecutionPlan(input);
    const { digest, ...facts } = plan;
    const bytes = Buffer.from(JSON.stringify(facts), "utf8");
    if (evidenceDigest(bytes) !== digest) {
      throw new JournalInvariantError("Purchase execution plan serialization is not canonical");
    }
    const evidence = this.storeEvidence(purchaseId, {
      bytes,
      mediaType: "application/json",
      profile: "urn:sompi:purchase-execution-plan:1",
      issuer: "sompi-purchase-module",
      kind: "execution-plan",
    });
    return Object.freeze({ plan, evidenceDigest: evidence.digest });
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

  private findEvidenceAttachmentForKind(
    purchaseId: PurchaseId,
    digest: Sha256Digest,
    kind: string,
    attempt?: number,
  ): EvidenceAttachmentRecord | undefined {
    const attemptClause = attempt === undefined ? "l.attempt IS NULL" : "l.attempt = ?";
    const parameters = attempt === undefined
      ? [purchaseId, digest, kind]
      : [purchaseId, digest, kind, attempt];
    const row = this.db.prepare(
      `SELECT l.purchase_id, l.digest, l.kind, l.attempt, l.media_type, l.profile,
              l.issuer, l.attached_at_ms, a.byte_length, a.storage_ref,
              a.created_at_ms AS blob_created_at_ms
         FROM evidence_links l
         JOIN evidence_artifacts a ON a.digest = l.digest
        WHERE l.purchase_id = ? AND l.digest = ? AND l.kind = ? AND ${attemptClause}`
    ).get(...parameters) as EvidenceAttachmentRow | undefined;
    return row ? evidenceAttachmentFromRow(row) : undefined;
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

  createPolicyChange(input: CreatePolicyChangeJournalInput): PolicyChangeJournalRecord {
    validatePolicyChangeJournalInput(input);
    const create = this.db.transaction(() => {
      const existing = this.findPolicyChangeByRequestKey(input.requestKey);
      if (existing) {
        if (!policyChangeIntentMatches(existing, input)) {
          throw new JournalInvariantError("Policy Change request key is already bound to different limits");
        }
        return existing;
      }
      const active = this.requireActivePolicy();
      if (active.digest !== input.expectedPolicyDigest) {
        throw new PolicyReservationError("active treasury policy changed before Policy Change creation");
      }
      const activation = this.requireActivePolicyActivation();
      if (activation.activationGeneration !== input.expectedPolicyGeneration) {
        throw new PolicyReservationError("active treasury policy generation changed before Policy Change creation");
      }
      if (
        active.maxPerPaymentAtomic !== input.previousMaximumPerPaymentAtomic ||
        active.maxPerHourAtomic !== input.previousMaximumPerHourAtomic
      ) {
        throw new PolicyReservationError(
          "Policy Change previous limits do not match the active treasury policy"
        );
      }
      const now = this.timestamp();
      this.db.prepare(
        `INSERT INTO policy_changes (
           id, request_key, state, expected_policy_digest, expected_policy_generation,
           expected_vault_digest,
           previous_max_per_payment_atomic, previous_max_per_hour_atomic,
           proposed_max_per_payment_atomic, proposed_max_per_hour_atomic,
           vault_maximum_outflow_atomic, manifest_revision, manifest_digest,
           expires_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.requestKey,
        input.expectedPolicyDigest,
        input.expectedPolicyGeneration,
        input.expectedVaultDigest,
        input.previousMaximumPerPaymentAtomic,
        input.previousMaximumPerHourAtomic,
        input.proposedMaximumPerPaymentAtomic,
        input.proposedMaximumPerHourAtomic,
        input.vaultMaximumOutflowAtomic,
        input.manifestRevision,
        input.manifestDigest,
        input.expiresAtMs,
        now,
        now,
      );
      this.insertPolicyChangeTransition(input.id, null, "created", "created", now);
      return this.policyChange(input.id);
    });
    return create.immediate();
  }

  policyChange(id: string): PolicyChangeJournalRecord {
    assertPolicyChangeId(id);
    const row = this.db.prepare("SELECT * FROM policy_changes WHERE id = ?").get(id) as PolicyChangeRow | undefined;
    if (!row) throw new JournalNotFoundError(`Policy Change ${id} does not exist`);
    return policyChangeFromRow(row);
  }

  findPolicyChangeByRequestKey(requestKey: string): PolicyChangeJournalRecord | undefined {
    assertPolicyChangeRequestKey(requestKey);
    const row = this.db.prepare("SELECT * FROM policy_changes WHERE request_key = ?").get(requestKey) as PolicyChangeRow | undefined;
    return row ? policyChangeFromRow(row) : undefined;
  }

  createVaultMigration(input: CreateVaultMigrationJournalInput): VaultMigrationJournalRecord {
    validateVaultMigrationInput(input);
    const create = this.db.transaction(() => {
      const existing = this.findVaultMigrationByRequestKey(input.requestKey);
      if (existing) {
        if (!vaultMigrationIntentMatches(existing, input)) {
          throw new JournalInvariantError("Vault Migration request key is already bound to different protection");
        }
        return existing;
      }
      const now = this.timestamp();
      this.db.prepare(
        `INSERT INTO vault_migrations (
           id, request_key, state, old_vault_digest, expected_policy_digest,
           expected_policy_generation,
           old_maximum_outflow_atomic, new_maximum_outflow_atomic,
           window_size_daa, window_start_daa, spent_in_window_atomic,
           stable_receive_address, manifest_revision, manifest_digest,
           expires_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id, input.requestKey, input.oldVaultDigest,
        input.expectedPolicyDigest, input.expectedPolicyGeneration,
        input.oldMaximumOutflowAtomic, input.newMaximumOutflowAtomic,
        input.windowSizeDaa, input.windowStartDaa, input.spentInWindowAtomic,
        input.stableReceiveAddress, input.manifestRevision, input.manifestDigest,
        input.expiresAtMs, now, now,
      );
      this.insertVaultMigrationTransition(input.id, null, "created", "created", now);
      return this.vaultMigration(input.id);
    });
    return create.immediate();
  }

  vaultMigration(id: string): VaultMigrationJournalRecord {
    assertVaultMigrationId(id);
    const row = this.db.prepare("SELECT * FROM vault_migrations WHERE id = ?").get(id) as VaultMigrationRow | undefined;
    if (!row) throw new JournalNotFoundError(`Vault Migration ${id} does not exist`);
    return vaultMigrationFromRow(row);
  }

  findVaultMigrationByRequestKey(requestKey: string): VaultMigrationJournalRecord | undefined {
    assertPolicyChangeRequestKey(requestKey);
    const row = this.db.prepare("SELECT * FROM vault_migrations WHERE request_key = ?").get(requestKey) as VaultMigrationRow | undefined;
    return row ? vaultMigrationFromRow(row) : undefined;
  }

  expireStaleVaultMigration(): VaultMigrationJournalRecord | undefined {
    const expire = this.db.transaction(() => {
      const now = this.timestamp();
      const row = this.db.prepare(
        `SELECT * FROM vault_migrations
          WHERE state IN ('awaiting_authority', 'awaiting_owner')
            AND expires_at_ms <= ?
          ORDER BY created_at_ms ASC, id ASC
          LIMIT 1`
      ).get(now) as VaultMigrationRow | undefined;
      if (!row) return undefined;
      const current = vaultMigrationFromRow(row);
      const reason = current.state === "awaiting_authority" ? "authority_expired" : "owner_execution_expired";
      const updated = this.db.prepare(
        `UPDATE vault_migrations SET state = 'expired', updated_at_ms = ?
          WHERE id = ? AND state = ? AND expires_at_ms <= ?`
      ).run(now, current.id, current.state, now);
      if (updated.changes !== 1) {
        throw new JournalInvariantError(`concurrent Vault Migration expiry for ${current.id}`);
      }
      this.insertVaultMigrationTransition(current.id, current.state, "expired", reason, now);
      return this.vaultMigration(current.id);
    });
    return expire.immediate();
  }

  /** Ordered owner-approved vault lineage used only for startup verification. */
  vaultMigrationLineage(): readonly VaultMigrationJournalRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM vault_migrations
        WHERE state IN ('executing', 'reconciliation_required', 'applied')
        ORDER BY created_at_ms ASC, id ASC`
    ).all() as VaultMigrationRow[];
    return Object.freeze(rows.map(vaultMigrationFromRow));
  }

  markVaultMigrationAwaitingAuthority(id: string): VaultMigrationJournalRecord {
    return this.transitionVaultMigration(id, "created", "awaiting_authority", "authority_requested");
  }

  decideVaultMigration(
    id: string,
    decision: Readonly<{ decision: "approved" | "denied"; authorityId: string; evidenceDigest: Sha256Digest; evidence: Uint8Array }>,
  ): VaultMigrationJournalRecord {
    validatePolicyDecision(decision);
    const decide = this.db.transaction(() => {
      const current = this.vaultMigration(id);
      if (["awaiting_owner", "denied", "expired"].includes(current.state)) return current;
      if (current.state !== "awaiting_authority") {
        throw new JournalInvariantError(`Vault Migration ${id} cannot be decided from ${current.state}`);
      }
      if (this.timestamp() >= current.expiresAtMs) {
        return this.transitionVaultMigration(id, "awaiting_authority", "expired", "authority_expired");
      }
      const now = this.timestamp();
      const next = decision.decision === "approved" ? "awaiting_owner" : "denied";
      this.db.prepare(
        `UPDATE vault_migrations SET state = ?, authority_id = ?, authority_evidence_digest = ?,
           authority_evidence = ?, updated_at_ms = ? WHERE id = ? AND state = 'awaiting_authority'`
      ).run(next, decision.authorityId, decision.evidenceDigest, Buffer.from(decision.evidence), now, id);
      this.insertVaultMigrationTransition(id, "awaiting_authority", next, next === "denied" ? "authority_denied" : "authority_approved", now);
      return this.vaultMigration(id);
    });
    return decide.immediate();
  }

  beginVaultMigrationExecution(id: string): VaultMigrationJournalRecord {
    const begin = this.db.transaction(() => {
      const current = this.vaultMigration(id);
      if (current.state !== "awaiting_owner") {
        throw new JournalInvariantError(`Vault Migration ${id} cannot execute from ${current.state}`);
      }
      const now = this.timestamp();
      if (now >= current.expiresAtMs) {
        return this.transitionVaultMigration(id, "awaiting_owner", "expired", "owner_execution_expired");
      }
      const activation = this.requireActivePolicyActivation();
      if (
        activation.policy.digest !== current.expectedPolicyDigest ||
        activation.activationGeneration !== current.expectedPolicyGeneration
      ) {
        throw new PolicyReservationError("everyday policy changed after Vault Migration approval");
      }
      if (BigInt(activation.policy.maxPerPaymentAtomic) > BigInt(current.newMaximumOutflowAtomic) ||
          BigInt(activation.policy.maxPerHourAtomic) > BigInt(current.newMaximumOutflowAtomic)) {
        throw new PolicyReservationError("active everyday limits exceed proposed vault protection");
      }
      const direct = (this.db.prepare(
        `SELECT COUNT(*) AS count FROM treasury_operations
          WHERE state NOT IN ('completed', 'failed_terminal')`
      ).get() as { count: number }).count;
      const purchase = (this.db.prepare(
        `SELECT COUNT(*) AS count FROM effects
          WHERE kind = ? AND state NOT IN ('observed', 'failed_terminal', 'abandoned')`
      ).get(TREASURY_STAGING_EFFECT_KIND) as { count: number }).count;
      if (direct !== 0 || purchase !== 0) {
        throw new JournalInvariantError("Vault Migration must wait for every unresolved wallet effect");
      }
      const updated = this.db.prepare(
        `UPDATE vault_migrations SET state = 'executing', updated_at_ms = ?
          WHERE id = ? AND state = 'awaiting_owner'`
      ).run(now, id);
      if (updated.changes !== 1) throw new JournalInvariantError(`concurrent Vault Migration execution for ${id}`);
      this.insertVaultMigrationTransition(id, "awaiting_owner", "executing", "owner_execution_started", now);
      return this.vaultMigration(id);
    });
    return begin.immediate();
  }

  assertVaultMigrationExecutionReady(id: string): VaultMigrationJournalRecord {
    const current = this.vaultMigration(id);
    if (current.state !== "awaiting_owner") {
      throw new JournalInvariantError(`Vault Migration ${id} cannot execute from ${current.state}`);
    }
    if (this.timestamp() >= current.expiresAtMs) {
      throw new JournalInvariantError("Vault Migration approval expired before owner execution");
    }
    const activation = this.requireActivePolicyActivation();
    if (
      activation.policy.digest !== current.expectedPolicyDigest ||
      activation.activationGeneration !== current.expectedPolicyGeneration
    ) {
      throw new PolicyReservationError("everyday policy changed after Vault Migration approval");
    }
    if (BigInt(activation.policy.maxPerPaymentAtomic) > BigInt(current.newMaximumOutflowAtomic) ||
        BigInt(activation.policy.maxPerHourAtomic) > BigInt(current.newMaximumOutflowAtomic)) {
      throw new PolicyReservationError("active everyday limits exceed proposed vault protection");
    }
    const direct = this.unresolvedTreasuryOperationCount();
    const purchase = (this.db.prepare(
      `SELECT COUNT(*) AS count FROM effects
        WHERE kind = ? AND state NOT IN ('observed', 'failed_terminal', 'abandoned')`
    ).get(TREASURY_STAGING_EFFECT_KIND) as { count: number }).count;
    if (direct !== 0 || purchase !== 0) {
      throw new JournalInvariantError("Vault Migration must wait for every unresolved wallet effect");
    }
    return current;
  }

  expireVaultMigrationBeforeExecution(id: string): VaultMigrationJournalRecord {
    const current = this.vaultMigration(id);
    if (current.state === "expired") return current;
    if (current.state !== "awaiting_owner") {
      throw new JournalInvariantError(`Vault Migration ${id} cannot expire from ${current.state}`);
    }
    if (this.timestamp() < current.expiresAtMs) {
      throw new JournalInvariantError(`Vault Migration ${id} owner approval has not expired`);
    }
    return this.transitionVaultMigration(id, "awaiting_owner", "expired", "owner_execution_expired");
  }

  failStaleVaultMigrationBeforeExecution(id: string): VaultMigrationJournalRecord {
    const current = this.vaultMigration(id);
    if (current.state === "failed") return current;
    if (current.state !== "awaiting_owner") {
      throw new JournalInvariantError(`Vault Migration ${id} cannot fail stale from ${current.state}`);
    }
    return this.transitionVaultMigration(
      id,
      "awaiting_owner",
      "failed",
      "plan_stale_before_owner_execution",
      "plan_stale_before_owner_execution",
    );
  }

  requireVaultMigrationReconciliation(id: string, failureCode: string): VaultMigrationJournalRecord {
    assertSafeIdentity(failureCode, "Vault Migration failure code", 100);
    const update = this.db.transaction(() => {
      const current = this.vaultMigration(id);
      if (current.state === "reconciliation_required") return current;
      if (current.state !== "executing") throw new JournalInvariantError(`Vault Migration ${id} is not executing`);
      const now = this.timestamp();
      this.db.prepare("UPDATE vault_migrations SET state = 'reconciliation_required', failure_code = ?, updated_at_ms = ? WHERE id = ? AND state = 'executing'")
        .run(failureCode, now, id);
      this.insertVaultMigrationTransition(id, "executing", "reconciliation_required", failureCode, now);
      return this.vaultMigration(id);
    });
    return update.immediate();
  }

  completeVaultMigration(
    id: string,
    result: Readonly<{ recoveryTransactionId: string; replacementTransactionId: string; receiptDigest: Sha256Digest }>,
  ): VaultMigrationJournalRecord {
    assertTransactionId(result.recoveryTransactionId);
    assertTransactionId(result.replacementTransactionId);
    assertDigest(result.receiptDigest, "Vault Migration receipt digest");
    const complete = this.db.transaction(() => {
      const current = this.vaultMigration(id);
      if (current.state === "applied") return current;
      if (current.state !== "executing" && current.state !== "reconciliation_required") {
        throw new JournalInvariantError(`Vault Migration ${id} cannot complete from ${current.state}`);
      }
      const now = this.timestamp();
      this.db.prepare(
        `UPDATE vault_migrations SET state = 'applied', recovery_transaction_id = ?,
           replacement_transaction_id = ?, receipt_digest = ?, failure_code = NULL, updated_at_ms = ?
         WHERE id = ? AND state IN ('executing', 'reconciliation_required')`
      ).run(result.recoveryTransactionId, result.replacementTransactionId, result.receiptDigest, now, id);
      this.insertVaultMigrationTransition(id, current.state, "applied", "replacement_accepted", now);
      return this.vaultMigration(id);
    });
    return complete.immediate();
  }

  markPolicyChangeAwaitingAuthority(id: string): PolicyChangeJournalRecord {
    return this.transitionPolicyChange(id, "created", "awaiting_authority", "authority_requested");
  }

  denyPolicyChange(
    id: string,
    decision: Readonly<{ authorityId: string; evidenceDigest: Sha256Digest; evidence: Uint8Array }>,
  ): PolicyChangeJournalRecord {
    return this.completePolicyChangeDecision(id, "denied", decision);
  }

  authorizeAndActivatePolicyChange(
    id: string,
    decision: Readonly<{ authorityId: string; evidenceDigest: Sha256Digest; evidence: Uint8Array }>,
    definition: PolicyDefinition,
    protection: Readonly<{
      expectedPolicyGeneration: number;
      expectedVaultDigest: Sha256Digest;
      currentVaultDigest: Sha256Digest;
      currentVaultMaximumOutflowAtomic: string;
    }>,
  ): PolicyChangeJournalRecord {
    validatePolicyDecision(decision);
    const canonical = canonicalPolicy(definition);
    const activate = this.db.transaction(() => {
      const current = this.policyChange(id);
      if (current.state === "applied") return current;
      if (current.state !== "awaiting_authority") {
        throw new JournalInvariantError(`Policy Change ${id} cannot be authorized from ${current.state}`);
      }
      if (this.timestamp() >= current.expiresAtMs) {
        return this.transitionPolicyChange(id, "awaiting_authority", "expired", "authority_expired");
      }
      if (
        protection.expectedPolicyGeneration !== current.expectedPolicyGeneration ||
        protection.expectedVaultDigest !== current.expectedVaultDigest ||
        protection.currentVaultDigest !== current.expectedVaultDigest
      ) {
        throw new PolicyReservationError("protection state changed before this approved revision could be applied");
      }
      const vaultMaximum = decimalBigInt(
        protection.currentVaultMaximumOutflowAtomic,
        "current vault maximum outflow",
      );
      if (
        decimalBigInt(canonical.maxPerPaymentAtomic, "per-payment limit") > vaultMaximum ||
        decimalBigInt(canonical.maxPerHourAtomic, "hourly limit") > vaultMaximum
      ) {
        throw new PolicyReservationError("approved policy exceeds current vault protection");
      }
      const activeMigration = this.db.prepare(
        `SELECT id FROM vault_migrations
          WHERE state IN ('executing', 'reconciliation_required') LIMIT 1`
      ).get() as { id: string } | undefined;
      if (activeMigration) {
        throw new PolicyReservationError("policy activation must wait for vault protection transition");
      }
      this.writePolicyChangeDecision(current, "authorised", decision);
      const snapshot = this.activatePolicySnapshotIfCurrent(
        current.expectedPolicyDigest,
        current.expectedPolicyGeneration,
        canonical,
      );
      const now = this.timestamp();
      this.db.prepare(
        `UPDATE policy_changes
            SET state = 'applied', applied_policy_digest = ?, applied_policy_version = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'authorised'`
      ).run(snapshot.digest, snapshot.version, now, id);
      this.insertPolicyChangeTransition(id, "authorised", "applied", "policy_activated", now);
      return this.policyChange(id);
    });
    return activate.immediate();
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
               (digest, version, max_per_payment_atomic, max_per_hour_atomic, activated_at_ms)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            digest,
            version,
            canonical.maxPerPaymentAtomic,
            canonical.maxPerHourAtomic,
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
      const current = this.db.prepare(
        "SELECT active_digest, activation_generation FROM journal_policy WHERE singleton = 1"
      ).get() as { active_digest: string; activation_generation: number } | undefined;
      if (!current) {
        this.db.prepare(
          `INSERT INTO journal_policy (singleton, active_digest, updated_at_ms, activation_generation)
           VALUES (1, ?, ?, 1)`
        ).run(digest, now);
      } else if (current.active_digest !== digest) {
        this.db.prepare(
          `UPDATE journal_policy
              SET active_digest = ?, updated_at_ms = ?, activation_generation = activation_generation + 1
            WHERE singleton = 1`
        ).run(digest, now);
      }
      return snapshot;
    });
    return install.immediate();
  }

  /** Activate an immutable policy revision only if the caller reviewed the active snapshot. */
  activatePolicyIfCurrent(
    expectedDigest: Sha256Digest,
    definition: PolicyDefinition,
  ): PolicySnapshotRecord {
    assertDigest(expectedDigest, "expected active policy digest");
    const canonical = canonicalPolicy(definition);
    const activate = this.db.transaction(() =>
      this.activatePolicySnapshotIfCurrent(
        expectedDigest,
        this.requireActivePolicyActivation().activationGeneration,
        canonical,
      )
    );
    return activate.immediate();
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

  requireActivePolicyActivation(): ActivePolicyRecord {
    const row = this.db.prepare(
      `SELECT p.*, j.activation_generation
         FROM policy_snapshots p
         JOIN journal_policy j ON j.active_digest = p.digest
        WHERE j.singleton = 1`
    ).get() as (PolicySnapshotRow & { activation_generation: number }) | undefined;
    if (!row || !Number.isSafeInteger(row.activation_generation) || row.activation_generation < 1) {
      throw new PolicyReservationError("no active treasury policy generation is installed");
    }
    return Object.freeze({
      policy: policyFromRow(row, this.policyAllowlist(row.digest)),
      activationGeneration: row.activation_generation,
    });
  }

  preflightTreasuryOperation(input: TreasuryOperationPreflight): void {
    validateTreasuryOperationPreflight(input);
    const policy = this.requireActivePolicy();
    if (policy.digest !== input.policyDigest) {
      throw new PolicyReservationError(
        "treasury policy changed; direct operation must re-evaluate against the active snapshot"
      );
    }
    this.assertDirectTreasuryCapacity(
      policy,
      input.kind,
      input.destination,
      input.amountAtomic,
      input.feeCeilingAtomic,
      this.timestamp(),
      undefined,
    );
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
      const humanApproved = input.authorizationEvidenceDigest !== undefined;
      if (humanApproved) {
        const authorization = this.db.prepare(
          `SELECT 1 AS approved
             FROM transfers transfer
             JOIN transfer_authorizations authorization
               ON authorization.transfer_id = transfer.id
            WHERE transfer.treasury_operation_key = ?
              AND authorization.evidence_digest = ?
              AND authorization.decision = 'approved'`
        ).get(input.operationKey, input.authorizationEvidenceDigest) as
          | { approved: number }
          | undefined;
        if (!authorization) {
          throw new PolicyReservationError(
            "direct Treasury movement has no matching approved Transfer authorization"
          );
        }
      }
      this.assertDirectTreasuryCapacity(
        policy,
        input.kind,
        input.destination,
        resolved ?? "0",
        input.feeCeilingAtomic,
        now,
        undefined,
      );
      try {
        this.db.prepare(
          `INSERT INTO treasury_operations (
             operation_key, request_digest, kind, destination,
             requested_amount_atomic, keep_float_atomic, fee_ceiling_atomic,
             resolved_amount_atomic, policy_digest, retry_limit,
             authorization_evidence_digest,
             state, retry_count, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', 0, ?, ?)`
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
          input.authorizationEvidenceDigest ?? null,
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

  claimTreasuryOperationDriver(
    operationKey: string,
    owner: string,
    leaseTtlMs: number,
  ): TreasuryDriverClaim {
    assertTreasuryOperationKey(operationKey);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(owner)) {
      throw new JournalInvariantError("Treasury driver owner is invalid");
    }
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 10 * 60_000) {
      throw new JournalInvariantError("Treasury driver lease duration is invalid");
    }
    const claim = this.db.transaction((): TreasuryDriverClaim => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state === "completed" || current.state === "failed_terminal") {
        return Object.freeze({ acquired: false, record: current });
      }
      const now = this.timestamp();
      const activeForeignDriver =
        current.driverOwner !== undefined &&
        current.driverLeaseExpiresAtMs !== undefined &&
        current.driverLeaseExpiresAtMs > now &&
        current.driverOwner !== owner;
      if (activeForeignDriver) return Object.freeze({ acquired: false, record: current });
      const sameLiveOwner =
        current.driverOwner === owner &&
        current.driverLeaseExpiresAtMs !== undefined &&
        current.driverLeaseExpiresAtMs > now;
      const generation = sameLiveOwner
        ? current.driverGeneration
        : current.driverGeneration + 1;
      const expiresAtMs = now + leaseTtlMs;
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET driver_owner = ?, driver_generation = ?, driver_lease_expires_at_ms = ?,
                effect_capability_generation = CASE
                  WHEN state IN ('intent', 'prepared') THEN NULL
                  ELSE effect_capability_generation
                END,
                updated_at_ms = ?
          WHERE operation_key = ?
            AND (driver_owner IS NULL OR driver_lease_expires_at_ms <= ? OR driver_owner = ?)`
      ).run(owner, generation, expiresAtMs, now, operationKey, now, owner);
      if (updated.changes !== 1) {
        return Object.freeze({ acquired: false, record: this.requireTreasuryOperation(operationKey) });
      }
      const record = this.requireTreasuryOperation(operationKey);
      return Object.freeze({
        acquired: true,
        record,
        lease: Object.freeze({ owner, generation, expiresAtMs }),
      });
    });
    return claim.immediate();
  }

  renewTreasuryOperationDriver(
    lease: TreasuryDriverLease,
    operationKey: string,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    const renewed = this.db.transaction(() => {
      const now = this.timestamp();
      const expiresAtMs = now + 60_000;
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET driver_lease_expires_at_ms = ?, updated_at_ms = ?
          WHERE operation_key = ? AND driver_owner = ? AND driver_generation = ?
            AND driver_lease_expires_at_ms > ?`
      ).run(expiresAtMs, now, operationKey, lease.owner, lease.generation, now);
      if (updated.changes !== 1) throw new JournalInvariantError("Treasury driver lease is stale");
      return this.requireTreasuryOperation(operationKey);
    });
    return renewed.immediate();
  }

  releaseTreasuryOperationDriver(
    lease: TreasuryDriverLease,
    operationKey: string,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    const released = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE treasury_operations
            SET driver_owner = NULL, driver_lease_expires_at_ms = NULL, updated_at_ms = ?
          WHERE operation_key = ? AND driver_owner = ? AND driver_generation = ?`
      ).run(this.timestamp(), operationKey, lease.owner, lease.generation);
      return this.requireTreasuryOperation(operationKey);
    });
    return released.immediate();
  }

  recordPreparedTreasuryOperation(
    operationKey: string,
    prepared: PreparedTreasuryOperation,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    validatePreparedTreasuryOperation(prepared);
    const digest = evidenceDigest(prepared.bytes);
    try {
      const record = this.db.transaction(() => {
        const current = this.requireTreasuryOperation(operationKey);
        if (driver && !driverOwns(current, driver, this.timestamp())) {
          throw new JournalInvariantError("direct Treasury preparation driver is stale");
        }
        if (current.preparationFenced) {
          throw new JournalInvariantError("fenced Treasury preparation cannot commit prepared material");
        }
        if (current.state !== "intent") {
          if (
            current.preparedDigest === digest &&
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
        if (current.cancellationRequested) {
          throw new JournalInvariantError("cancelled Treasury preparation cannot commit prepared material");
        }
        const policy = this.requirePolicy(current.policyDigest as Sha256Digest);
        if (
          current.policyDigest !== prepared.policyDigest
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
          operationKey,
        );
        const stored = this.storePreparedMaterial(prepared.bytes, digest);
        const driverSql = driver
          ? " AND driver_owner = ? AND driver_generation = ?"
          : "";
        const updated = this.db.prepare(
          `UPDATE treasury_operations
              SET resolved_amount_atomic = ?, fee_atomic = ?, transaction_id = ?,
                  prepared_digest = ?, prepared_ref = ?, prepared_byte_length = ?,
                  state = 'prepared', updated_at_ms = ?
            WHERE operation_key = ? AND state = 'intent'
              AND cancellation_requested = 0 AND preparation_fenced = 0${driverSql}`
        ).run(
          prepared.amountAtomic,
          prepared.feeAtomic,
          prepared.transactionId,
          stored.digest,
          stored.storageRef,
          stored.byteLength,
          now,
          operationKey,
          ...(driver ? [driver.owner, driver.generation] : [])
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
    } catch (error) {
      if (!this.preparedMaterialHasDurableOwner(digest)) {
        this.preparedMaterialStore?.removeUnreferenced(digest);
      }
      throw error;
    }
  }

  recordTreasuryPreparationRetry(
    operationKey: string,
    reasonCode: string,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    assertCode(reasonCode, "Treasury preparation retry reason");
    const retry = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (driver && !driverOwns(current, driver, this.timestamp())) {
        throw new JournalInvariantError("direct Treasury retry driver is stale");
      }
      if (current.state !== "intent") {
        throw new JournalInvariantError(
          "only an unprepared direct Treasury operation can record a preparation retry",
        );
      }
      if (current.retryCount >= current.retryLimit) {
        throw new JournalInvariantError("direct Treasury preparation retry limit is exhausted");
      }
      const now = this.timestamp();
      const driverSql = driver
        ? " AND driver_owner = ? AND driver_generation = ?"
        : "";
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET retry_count = retry_count + 1, updated_at_ms = ?
          WHERE operation_key = ? AND state = 'intent' AND retry_count < retry_limit${driverSql}`
      ).run(now, operationKey, ...(driver ? [driver.owner, driver.generation] : []));
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
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    if (
      reasonCode !== "invalid_destination" &&
      reasonCode !== "invalid_transaction_shape" &&
      reasonCode !== "insufficient_funds" &&
      reasonCode !== "not_funded" &&
      reasonCode !== "invalid_runtime_state" &&
      reasonCode !== "cancelled_before_effect" &&
      reasonCode !== "retry_exhausted"
    ) {
      throw new JournalInvariantError("direct Treasury terminal preparation reason is invalid");
    }
    const failed = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (driver && !driverOwns(current, driver, this.timestamp())) {
        throw new JournalInvariantError("direct Treasury terminalization driver is stale");
      }
      if (current.state === "failed_terminal") return current;
      if (current.state !== "intent") {
        throw new JournalInvariantError(
          "only an unprepared direct Treasury operation may fail terminally",
        );
      }
      const now = this.timestamp();
      const driverSql = driver
        ? " AND driver_owner = ? AND driver_generation = ?"
        : "";
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET state = 'failed_terminal', updated_at_ms = ?
          WHERE operation_key = ? AND state = 'intent'${driverSql}`
      ).run(now, operationKey, ...(driver ? [driver.owner, driver.generation] : []));
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

  fenceTreasuryOperationPreparation(
    operationKey: string,
    reasonCode: string,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    assertCode(reasonCode, "Treasury preparation fence reason");
    const fenced = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (driver && !driverOwns(current, driver, this.timestamp())) {
        throw new JournalInvariantError("direct Treasury fence driver is stale");
      }
      if (current.preparationFenced) return current;
      if (current.state !== "intent") {
        throw new JournalInvariantError("only an unprepared direct Treasury operation may be fenced");
      }
      const now = this.timestamp();
      const driverSql = driver
        ? " AND driver_owner = ? AND driver_generation = ?"
        : "";
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET preparation_fenced = 1, updated_at_ms = ?
          WHERE operation_key = ? AND state = 'intent'
            AND cancellation_requested = 0 AND preparation_fenced = 0${driverSql}`
      ).run(now, operationKey, ...(driver ? [driver.owner, driver.generation] : []));
      if (updated.changes !== 1) throw new JournalInvariantError("concurrent direct Treasury preparation fence");
      this.insertTreasuryOperationTransition(operationKey, "intent", "intent", reasonCode, now);
      return this.requireTreasuryOperation(operationKey);
    });
    return fenced.immediate();
  }

  cancelTreasuryOperation(operationKey: string): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    const current = this.requireTreasuryOperation(operationKey);
    if (current.state === "completed" || current.state === "failed_terminal") return current;
    if (current.state === "intent" && current.preparationFenced) {
      return this.requestTreasuryOperationCancellation(operationKey);
    }
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

  planTreasuryOperationSubmission(operationKey: string, driver?: TreasuryDriverLease): boolean {
    assertTreasuryOperationKey(operationKey);
    const plan = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state !== "prepared" || current.cancellationRequested || current.preparationFenced) return false;
      if (driver && !driverOwns(current, driver, this.timestamp())) return false;
      const policy = this.requirePolicy(current.policyDigest as Sha256Digest);
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
        operationKey,
      );
      const driverSql = driver
        ? " AND driver_owner = ? AND driver_generation = ?"
        : "";
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET state = 'submission_planned', updated_at_ms = ?
          WHERE operation_key = ? AND state = 'prepared'
            AND cancellation_requested = 0 AND preparation_fenced = 0${driverSql}`
      ).run(now, operationKey, ...(driver ? [driver.owner, driver.generation] : []));
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

  claimTreasuryOperationEffectCapability(
    operationKey: string,
    driver: TreasuryDriverLease,
  ): boolean {
    assertTreasuryOperationKey(operationKey);
    const claim = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (!driverOwns(current, driver, this.timestamp()) || current.state !== "submission_planned" ||
          current.cancellationRequested || current.preparationFenced || current.submissionInFlight) return false;
      const now = this.timestamp();
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET effect_capability_generation = ?, submission_in_flight = 1, updated_at_ms = ?
          WHERE operation_key = ? AND state = 'submission_planned'
            AND cancellation_requested = 0 AND preparation_fenced = 0
            AND driver_owner = ? AND driver_generation = ?
            AND effect_capability_generation IS NULL
            AND submission_in_flight = 0`
      ).run(driver.generation, now, operationKey, driver.owner, driver.generation);
      if (updated.changes !== 1) return false;
      this.insertTreasuryOperationTransition(
        operationKey,
        "submission_planned",
        "submission_planned",
        "submission_in_flight",
        now,
      );
      return true;
    });
    return claim.immediate();
  }

  recordTreasuryOperationSubmissionAccepted(
    operationKey: string,
    transactionId: string,
    driver?: TreasuryDriverLease,
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    assertTransactionId(transactionId);
    const record = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (driver && !driverOwns(current, driver, this.timestamp())) {
        throw new JournalInvariantError("direct Treasury submission driver is stale");
      }
      if (current.transactionId !== transactionId) {
        throw new JournalInvariantError("submitted direct Treasury transaction identity changed");
      }
      if (["submitted", "observed", "completed"].includes(current.state)) return current;
      if (current.state !== "submission_planned") {
        throw new JournalInvariantError("direct Treasury submission was not durably planned");
      }
      if (
        current.preparationFenced ||
        (driver !== undefined && current.effectCapabilityGeneration !== driver.generation)
      ) {
        throw new JournalInvariantError("direct Treasury submission capability is no longer valid");
      }
      const now = this.timestamp();
      const updated = this.db.prepare(
        `UPDATE treasury_operations SET state = 'submitted', submission_in_flight = 0, updated_at_ms = ?
          WHERE operation_key = ? AND state = 'submission_planned'
            AND preparation_fenced = 0
            AND submission_in_flight = 1
            AND effect_capability_generation IS NOT NULL
            ${driver ? "AND driver_owner = ? AND driver_generation = ?" : ""}`
      ).run(now, operationKey, ...(driver ? [driver.owner, driver.generation] : []));
      if (updated.changes !== 1) {
        throw new JournalInvariantError("direct Treasury submission capability was lost");
      }
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
    detail: Readonly<Record<string, unknown>>,
    driver?: TreasuryDriverLease,
    submissionOutcome: TreasurySubmissionOutcome = "in_flight",
  ): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    if (!["observed", "not_submitted", "pending", "superseded"].includes(status)) {
      throw new JournalInvariantError("direct Treasury observation status is invalid");
    }
    if (!["in_flight", "ambiguous", "accepted"].includes(submissionOutcome)) {
      throw new JournalInvariantError("direct Treasury submission outcome is invalid");
    }
    const detailJson = canonicalTreasuryObservationJson(detail);
    if (Buffer.byteLength(detailJson) > 16_384) {
      throw new JournalInvariantError("direct Treasury observation is oversized");
    }
    const detailDigest = evidenceDigest(detailJson);
    const record = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state === "failed_terminal" && status === "superseded") {
        const existing = this.db.prepare(
          `SELECT detail_digest, detail_json
             FROM treasury_operation_observations
            WHERE operation_key = ? AND status = 'superseded'
            ORDER BY sequence DESC LIMIT 1`,
        ).get(operationKey) as { detail_digest: string; detail_json: string } | undefined;
        if (
          !existing || existing.detail_digest !== detailDigest ||
          existing.detail_json !== detailJson
        ) {
          throw new JournalInvariantError("superseded Treasury evidence changed after terminalization");
        }
        return current;
      }
      if (!["submission_planned", "submitted", "observed"].includes(current.state)) {
        throw new JournalInvariantError("direct Treasury operation is not awaiting observation");
      }
      if (driver && !driverOwns(current, driver, this.timestamp())) {
        throw new JournalInvariantError("direct Treasury observation driver is stale");
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
      if (status === "superseded") {
        const driverSql = driver
          ? " AND driver_owner = ? AND driver_generation = ?"
          : "";
        const updated = this.db.prepare(
          `UPDATE treasury_operations
              SET state = 'failed_terminal', submission_in_flight = 0,
                  effect_capability_generation = NULL,
                  completed_at_ms = ?, updated_at_ms = ?
            WHERE operation_key = ? AND state = ?${driverSql}`
        ).run(
          now,
          now,
          operationKey,
          current.state,
          ...(driver ? [driver.owner, driver.generation] : []),
        );
        if (updated.changes !== 1) {
          throw new JournalInvariantError("concurrent superseding Treasury effect changed state");
        }
        this.insertTreasuryOperationTransition(
          operationKey,
          current.state,
          "failed_terminal",
          "mutually_exclusive_chain_effect_accepted",
          now,
        );
        return this.requireTreasuryOperation(operationKey);
      }
      // No current observation is proof that an exact effect-capable
      // transaction can no longer execute. Temporary or corroborated absence
      // therefore retains the capability, reservation, and exclusive slot for
      // Reconciliation under every supported submission outcome.
      if (status === "not_submitted") {
        return this.requireTreasuryOperation(operationKey);
      }
      const driverSql = driver
        ? " AND driver_owner = ? AND driver_generation = ?"
        : "";
      const updated = this.db.prepare(
        `UPDATE treasury_operations
            SET state = 'observed', submission_in_flight = 0, updated_at_ms = ?
          WHERE operation_key = ? AND state = ?${driverSql}`
      ).run(
        now,
        operationKey,
        current.state,
        ...(driver ? [driver.owner, driver.generation] : []),
      );
      if (updated.changes !== 1) {
        throw new JournalInvariantError("concurrent direct Treasury observation changed state");
      }
      this.insertTreasuryOperationTransition(
        operationKey,
        current.state,
        "observed",
        "chain_observed",
        now
      );
      return this.requireTreasuryOperation(operationKey);
    });
    return record.immediate();
  }

  completeTreasuryOperation(operationKey: string, driver?: TreasuryDriverLease): TreasuryOperationRecord {
    assertTreasuryOperationKey(operationKey);
    const complete = this.db.transaction(() => {
      const current = this.requireTreasuryOperation(operationKey);
      if (current.state === "completed") return current;
      if (current.state !== "observed") {
        throw new JournalInvariantError("unobserved direct Treasury operation cannot complete");
      }
      if (driver && !driverOwns(current, driver, this.timestamp())) {
        throw new JournalInvariantError("direct Treasury completion driver is stale");
      }
      const driverSql = driver
        ? " AND driver_owner = ? AND driver_generation = ?"
        : "";
      const now = this.timestamp();
      this.db.prepare(
        `UPDATE treasury_operations
            SET state = 'completed', updated_at_ms = ?, completed_at_ms = ?
          WHERE operation_key = ? AND state = 'observed'${driverSql}`
      ).run(now, now, operationKey, ...(driver ? [driver.owner, driver.generation] : []));
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

  listTreasuryOperations(
    kind: TreasuryOperationRecord["kind"],
    limit: number,
  ): readonly TreasuryOperationRecord[] {
    if (!(["wallet_send", "vault_send", "vault_deposit", "batch_refund"] as const).includes(kind)) {
      throw new JournalInvariantError("Treasury Operation activity kind is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new JournalInvariantError("Treasury Operation activity limit is invalid");
    }
    const rows = this.db.prepare(
      `SELECT * FROM treasury_operations
        WHERE kind = ?
        ORDER BY created_at_ms DESC, operation_key DESC
        LIMIT ?`
    ).all(kind, limit) as TreasuryOperationRow[];
    return Object.freeze(rows.map(treasuryOperationFromRow));
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
        (row.kind === "vault_deposit" || row.kind === "batch_refund" ? 0n : BigInt(row.resolved_amount_atomic)) +
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

  treasuryPendingCapacityUsed(): bigint {
    const read = this.db.transaction(() => {
      const now = this.timestamp();
      this.expireReservationsInternal(now);
      const reservations = this.db.prepare(
        `SELECT amount_atomic, additional_cost_ceiling_atomic FROM treasury_reservations
          WHERE (state = 'active' AND expires_at_ms > ?) OR state = 'in_flight'`
      ).all(now) as Array<{ amount_atomic: string; additional_cost_ceiling_atomic: string }>;
      const operations = this.db.prepare(
        `SELECT kind, resolved_amount_atomic, fee_ceiling_atomic, requested_amount_atomic
           FROM treasury_operations
          WHERE state IN ('intent', 'prepared', 'submission_planned', 'submitted', 'observed')`
      ).all() as Array<{
        kind: TreasuryOperationRecord["kind"];
        resolved_amount_atomic: string | null;
        fee_ceiling_atomic: string;
        requested_amount_atomic: string;
      }>;
      return reservations.reduce(
        (total, row) => total + BigInt(row.amount_atomic) + BigInt(row.additional_cost_ceiling_atomic), 0n,
      ) + operations.reduce((total, row) => {
        const amount = row.kind === "vault_deposit" || row.kind === "batch_refund"
          ? 0n
          : BigInt(row.resolved_amount_atomic ?? (row.requested_amount_atomic === "max" ? "0" : row.requested_amount_atomic));
        return total + amount + BigInt(row.fee_ceiling_atomic);
      }, 0n);
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
      if (gross > maxPerPayment) {
        throw new PolicyReservationError(`gross treasury movement ${gross} exceeds per-payment limit ${maxPerPayment}`);
      }
      if (
        !input.approvalEvidenceDigest ||
        !this.isVerifiedEvidenceLinked(input.purchaseId, input.approvalEvidenceDigest, {
        attempt: null,
        kind: "purchase-authorization",
        verificationProfile: input.approvalVerificationProfile,
        verifierId: input.approvalVerifierId,
        })
      ) {
        throw new PolicyReservationError("verified authority evidence is required for every Purchase");
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
   * Cancels only while the Journal proves that no irreversible Treasury or
   * payment effect can have occurred. Prepared bytes may exist, but
   * every effect must still be unclaimed. Capacity release and lifecycle
   * cancellation are one SQLite transaction.
   */
  cancelPurchaseBeforeExternalEffect(purchaseId: PurchaseId): PurchaseRecord {
    const cancel = this.db.transaction(() => {
      const purchase = this.requirePurchase(purchaseId);
      if (purchase.state === "cancelled") return purchase;
      if (!["created", "terms_bound", "awaiting_authority", "authorised", "execution_prepared"].includes(purchase.state)) {
        throw new JournalEffectBusyError(
          `Purchase ${purchaseId} cannot be cancelled after external execution began`
        );
      }

      const effects = this.effectsForPurchase(purchaseId);
      for (const effect of effects) {
        if (
          effect.state !== "planned" &&
          effect.state !== "retryable" &&
          effect.state !== "abandoned"
        ) {
          throw new JournalEffectBusyError(
            `Purchase ${purchaseId} has a possible external effect ${effect.id}`
          );
        }
      }

      const now = this.timestamp();
      const detailDigest = this.findCheckoutTerms(purchaseId)?.checkoutDigest;
      this.terminalizeNeverSubmittedBatchVoucherMovement(
        purchaseId,
        now
      );
      for (const effect of effects) {
        if (effect.state === "planned" || effect.state === "retryable") {
          this.updateEffectState(
            effect,
            "abandoned",
            "purchase_cancelled_before_external_effect",
            detailDigest ?? effect.payloadDigest,
            now,
            { errorCode: "cancelled_before_external_effect" }
          );
        }
      }

      const attempts = this.paymentAttempts(purchaseId);
      if (attempts.length > 1) {
        throw new JournalInvariantError("pre-effect cancellation found multiple Payment Attempts");
      }
      const attempt = attempts[0];
      if (attempt && (attempt.state === "planned" || attempt.state === "prepared")) {
        this.transitionAttemptInternal(
          attempt,
          "failed",
          "purchase_cancelled_before_external_effect",
          detailDigest,
          now,
          "cancelled_before_external_effect"
        );
      } else if (attempt && attempt.state !== "failed") {
        throw new JournalEffectBusyError(
          `Purchase ${purchaseId} has an irreversible Payment Attempt`
        );
      }

      const reservation = this.findReservationForPurchase(purchaseId);
      if (reservation?.state === "active") {
        const released = this.db.prepare(
          "UPDATE treasury_reservations SET state = 'released', updated_at_ms = ? WHERE id = ? AND state = 'active'"
        ).run(now, reservation.id);
        if (released.changes !== 1) {
          throw new JournalInvariantError("concurrent pre-effect Treasury Reservation release");
        }
      } else if (
        reservation &&
        reservation.state !== "released" &&
        reservation.state !== "expired"
      ) {
        throw new JournalEffectBusyError(
          `Purchase ${purchaseId} has irreversible Treasury Reservation state ${reservation.state}`
        );
      }

      return this.transitionPurchase(
        purchaseId,
        purchase.state,
        "cancelled",
        "purchase_cancelled_before_external_effect",
        detailDigest
      );
    });
    return cancel.immediate();
  }

  /**
   * Terminates a never-staged Purchase after Checkout expiry.
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
          effect.kind === "kaspa-x402-payment"
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
          input.transactionId ?? null,
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
      if (this.findSettlementForPurchase(input.purchaseId)) {
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
              prepared_ref, prepared_byte_length, execution_id, mechanism, profile,
              transaction_id, amount_atomic, asset, network, payee,
              required_assurance, funding_source, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.purchaseId,
          input.attempt,
          input.reservationId,
          input.requirementsDigest,
          input.payloadDigest,
          stored.storageRef,
          stored.byteLength,
          input.executionId,
          input.mechanism,
          input.profile,
          input.transactionId ?? null,
          input.amountAtomic,
          input.asset,
          input.network,
          input.payee,
          input.requiredAssurance,
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
      this.terminalizeNeverSubmittedBatchVoucherMovement(
        purchase.id,
        now
      );
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
        throw new JournalInvariantError("payment effects must be finalized with recordPurchaseSettlement");
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

  recordPurchaseSettlement(
    lease: LeaseToken,
    input: RecordPurchaseSettlementInput
  ): PurchaseSettlementRecord {
    validatePurchaseSettlementInput(input);
    const record = this.db.transaction(() => {
      this.assertEffectWriter(input.effectId, lease);
      const effect = this.requireEffect(input.effectId);
      if (effect.attempt === undefined) throw new JournalInvariantError("observed spend requires a payment effect");
      const existing = this.findSettlement(input.reservationId);
      if (existing) {
        assertSameSettlement(existing, input);
        if (effect.state !== "observed" || effect.resultDigest !== input.evidenceDigest) {
          throw new JournalInvariantError("Settlement exists but effect observation conflicts");
        }
        return existing;
      }
      if (effect.state !== "executing" && effect.state !== "submitted" && effect.state !== "ambiguous") {
        throw new JournalInvariantError(`Effect ${effect.id} cannot record spend from ${effect.state}`);
      }
      const attempt = this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
      if (attempt.state !== "submitted") throw new JournalInvariantError("observed spend requires submitted Payment Attempt");
      const preparation = this.requirePaymentPreparation(effect.purchaseId, effect.attempt);
      const amountMatchesPreparation = input.mechanism === "single-transaction"
        ? preparation.amountAtomic === input.actualAmountAtomic
        : BigInt(input.actualAmountAtomic) > 0n &&
          BigInt(input.actualAmountAtomic) <= BigInt(preparation.amountAtomic);
      if (
        preparation.reservationId !== input.reservationId ||
        preparation.executionId !== input.executionId ||
        preparation.mechanism !== input.mechanism ||
        preparation.profile !== input.profile ||
        preparation.transactionId !== input.transactionId ||
        !amountMatchesPreparation ||
        preparation.asset !== input.asset ||
        preparation.payee !== input.payee ||
        preparation.network !== input.network ||
        !settlementAssuranceMeets(input.settlementAssurance, preparation.requiredAssurance) ||
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
        (input.mechanism === "single-transaction"
          ? amount !== BigInt(reservation.amountAtomic)
          : amount <= 0n || amount > BigInt(reservation.amountAtomic)) ||
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
          `INSERT INTO purchase_settlements
             (effect_id, reservation_id, purchase_id, attempt, execution_id, mechanism, profile,
              transaction_id, commitment_id, outpoint,
              actual_amount_atomic, actual_additional_cost_atomic, asset, payee, network, settlement_assurance,
              funding_source, evidence_digest, evidence_verification_profile,
              evidence_verifier_id, observed_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.effectId,
          input.reservationId,
          effect.purchaseId,
          effect.attempt,
          input.executionId,
          input.mechanism,
          input.profile,
          input.transactionId ?? null,
          input.commitmentId ?? null,
          input.outpoint ?? null,
          input.actualAmountAtomic,
          input.actualAdditionalCostAtomic,
          input.asset,
          input.payee,
          input.network,
          input.settlementAssurance,
          input.fundingSource,
          input.evidenceDigest,
          input.evidenceVerificationProfile,
          input.evidenceVerifierId,
          now
        );
      this.inject("settlement.after_insert");
      const reservationUpdate = this.db
        .prepare(
          `UPDATE treasury_reservations
           SET state = 'spent', spent_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND state = 'in_flight'`
        )
        .run(now, now, input.reservationId);
      if (reservationUpdate.changes !== 1) throw new JournalInvariantError("concurrent Settlement finalization");
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
      const spend = this.findSettlementForPurchase(purchaseId);
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
        .prepare("SELECT * FROM purchase_receipts WHERE purchase_id = ?")
        .get(purchaseId) as ReceiptRow | undefined;
      let receipt: ReceiptRecord;
      if (existing) {
        receipt = receiptFromRow(existing);
        assertSameReceipt(receipt, input, canonicalDigest);
      } else {
        const now = this.timestamp();
        this.db
          .prepare(
            `INSERT INTO purchase_receipts (
               purchase_id, canonical_digest, evidence_digest, profile, issuer, verifier_id,
               checkout_digest, authorization_evidence_digest, settlement_evidence_digest,
               fulfilment_digest, created_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            purchaseId,
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
          purchaseId,
          ...input,
          canonicalDigest,
          createdAtMs: now,
        };
      }
      const current = this.requirePurchase(purchaseId);
      if (current.state === "fulfilled") {
        this.transitionPurchase(
          purchaseId,
          "fulfilled",
          "receipted",
          "canonical_receipt_recorded",
          canonicalDigest
        );
      }
      return receipt;
    });
    return record.immediate();
  }

  receipts(purchaseId: PurchaseId): ReceiptRecord[] {
    this.requirePurchase(purchaseId);
    const rows = this.db
      .prepare("SELECT * FROM purchase_receipts WHERE purchase_id = ?")
      .all(purchaseId) as ReceiptRow[];
    return rows.map(receiptFromRow);
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

  findSettlementForPurchase(purchaseId: PurchaseId): PurchaseSettlementRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM purchase_settlements WHERE purchase_id = ? ORDER BY id DESC LIMIT 1")
      .get(purchaseId) as PurchaseSettlementRow | undefined;
    return row ? purchaseSettlementFromRow(row) : undefined;
  }

  requireSettlement(reservationId: string): PurchaseSettlementRecord {
    const settlement = this.findSettlement(reservationId);
    if (!settlement) throw new JournalNotFoundError(`Settlement for Reservation ${reservationId} does not exist`);
    return settlement;
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

  loadBatchChannels(scope: Readonly<BatchChannelLookup> = {}): BatchChannelJournalRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [
      ["origin", scope.origin],
      ["resource_url", scope.resourceUrl],
      ["network", scope.network],
      ["status", scope.status],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        values.push(value);
      }
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT * FROM batch_channels${where} ORDER BY created_at_ms, channel_id`)
      .all(...values) as BatchChannelRow[];
    return rows.map(batchChannelFromRow);
  }

  requireBatchChannel(channelId: string): BatchChannelJournalRecord {
    requireBatchHash(channelId, "batch channel ID");
    const row = this.db
      .prepare("SELECT * FROM batch_channels WHERE channel_id = ?")
      .get(channelId) as BatchChannelRow | undefined;
    if (!row) throw new JournalNotFoundError(`Batch channel ${channelId} does not exist`);
    return batchChannelFromRow(row);
  }

  /**
   * Journal-backed compare-and-swap for the SDK ChannelStore. All monotonic
   * voucher/accounting checks happen in the same SQLite transaction as the
   * durable channel update and immutable transition record.
   */
  saveBatchChannel(candidate: Readonly<BatchChannelJournalRecord>): BatchChannelJournalRecord {
    const normalized = normalizeBatchChannel(candidate, this.timestamp());
    const save = this.db.transaction(() => {
      const existingRow = this.db
        .prepare("SELECT * FROM batch_channels WHERE channel_id = ?")
        .get(normalized.channelId) as BatchChannelRow | undefined;
      if (!existingRow) {
        if (normalized.version !== 1 || normalized.epoch !== 0) {
          throw new JournalInvariantError("new batch channel must begin at epoch 0 version 1");
        }
        this.db.prepare(
          `INSERT INTO batch_channels (
             channel_id, origin, resource_url, network, asset, template_id,
             client_public_key, server_public_key, pay_to, refund_address,
             refund_timeout_daa, salt, active_txid, active_output_index,
             active_script_public_key, escrow_address, funding_source,
             funding_amount_atomic, charged_cumulative_atomic,
             claimed_cumulative_atomic, signed_cumulative_atomic,
             latest_voucher_amount_atomic, latest_voucher_signature, status,
             epoch, version, retired_reason, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(...batchChannelSqlValues(normalized));
        this.insertBatchChannelTransition(undefined, normalized, "channel_created");
        this.inject("batch_channel.after_insert");
        return normalized;
      }
      const existing = batchChannelFromRow(existingRow);
      assertBatchChannelIdentity(existing, normalized);
      assertBatchChannelProgress(existing, normalized);
      if (normalized.version !== existing.version + 1) {
        throw new JournalFencingError(
          `batch channel version ${normalized.version} does not follow ${existing.version}`
        );
      }
      const result = this.db.prepare(
        `UPDATE batch_channels SET
           resource_url = ?, active_txid = ?, active_output_index = ?,
           active_script_public_key = ?, funding_amount_atomic = ?,
           charged_cumulative_atomic = ?, claimed_cumulative_atomic = ?,
           signed_cumulative_atomic = ?, latest_voucher_amount_atomic = ?,
           latest_voucher_signature = ?, status = ?, epoch = ?, version = ?,
           retired_reason = ?, updated_at_ms = ?
         WHERE channel_id = ? AND version = ?`
      ).run(
        normalized.resourceUrl ?? null,
        normalized.activeOutpoint.txid,
        normalized.activeOutpoint.index,
        normalized.activeScriptPublicKey,
        normalized.fundingAmountAtomic,
        normalized.chargedCumulativeAtomic,
        normalized.claimedCumulativeAtomic,
        normalized.signedCumulativeAtomic,
        normalized.latestVoucher?.amountAtomic ?? null,
        normalized.latestVoucher?.signature ?? null,
        normalized.status,
        normalized.epoch,
        normalized.version,
        normalized.retiredReason ?? null,
        normalized.updatedAtMs,
        normalized.channelId,
        existing.version
      );
      if (result.changes !== 1) throw new JournalFencingError("batch channel update lost its compare-and-swap");
      this.insertBatchChannelTransition(existing, normalized, batchTransitionReason(existing, normalized));
      this.inject("batch_channel.after_update");
      return normalized;
    });
    return save.immediate();
  }

  /** Persists only same-outpoint SDK state; successors require verified evidence. */
  saveBatchChannelWithLifecycleMovement(
    candidate: Readonly<BatchChannelJournalRecord>
  ): BatchChannelJournalRecord {
    const save = this.db.transaction(() => {
      const previousRow = this.db
        .prepare("SELECT * FROM batch_channels WHERE channel_id = ?")
        .get(candidate.channelId) as BatchChannelRow | undefined;
      const previous = previousRow ? batchChannelFromRow(previousRow) : undefined;
      if (previous && (
        previous.activeOutpoint.txid === candidate.activeOutpoint.txid &&
        previous.activeOutpoint.index === candidate.activeOutpoint.index
      )) {
        return this.saveBatchChannel(candidate);
      }
      if (previous) {
        throw new JournalInvariantError(
          "batch channel successors require a verified lifecycle transition",
        );
      }
      return this.saveBatchChannel(candidate);
    });
    return save.immediate();
  }

  /** Atomically publishes an accepted initial deposit and its active channel. */
  activateBatchChannelFromDeposit(
    candidate: Readonly<BatchChannelJournalRecord>,
    movementId: string,
  ): Readonly<{
    channel: BatchChannelJournalRecord;
    movement: BatchTreasuryMovementRecord;
  }> {
    const activate = this.db.transaction(() => {
      const movement = this.requireBatchTreasuryMovement(movementId);
      if (
        movement.kind !== "deposit" || movement.channelId !== candidate.channelId ||
        (movement.state !== "planned" && movement.state !== "submitted" && movement.state !== "accepted")
      ) {
        throw new JournalInvariantError("batch deposit Movement cannot activate this channel");
      }
      const existing = this.db
        .prepare("SELECT * FROM batch_channels WHERE channel_id = ?")
        .get(candidate.channelId) as BatchChannelRow | undefined;
      const channel = existing ? batchChannelFromRow(existing) : this.saveBatchChannel(candidate);
      if (existing && JSON.stringify(channel) !== JSON.stringify(normalizeBatchChannel(candidate, channel.updatedAtMs))) {
        throw new JournalInvariantError("accepted batch deposit conflicts with the active channel");
      }
      const evidenceDigest = this.requireAcceptedTreasuryMovementEvidence(
        channel.activeOutpoint.txid,
      );
      const accepted = movement.state === "accepted"
        ? this.requireAcceptedBatchMovementEvidence(movement)
        : this.advanceBatchTreasuryMovement({
            movementId,
            expectedState: movement.state,
            state: "accepted",
            activeOutpointAfter: channel.activeOutpoint,
            transactionId: channel.activeOutpoint.txid,
            evidenceDigest,
          });
      if (
        accepted.transactionId !== channel.activeOutpoint.txid ||
        !accepted.activeOutpointAfter ||
        accepted.activeOutpointAfter.txid !== channel.activeOutpoint.txid ||
        accepted.activeOutpointAfter.index !== channel.activeOutpoint.index
      ) {
        throw new JournalInvariantError("accepted batch deposit does not match the active channel outpoint");
      }
      return Object.freeze({ channel, movement: accepted });
    });
    return activate.immediate();
  }

  completeBatchChannelRefund(input: Readonly<{
    channelId: string;
    movementId: string;
    transactionId: string;
    chainEvidenceDigest: Sha256Digest;
  }>): Readonly<{
    channel: BatchChannelJournalRecord;
    movement: BatchTreasuryMovementRecord;
  }> {
    const complete = this.db.transaction(() => {
      const current = this.requireBatchChannel(input.channelId);
      const movement = this.requireBatchTreasuryMovement(input.movementId);
      requireBatchHash(input.transactionId, "batch refund transaction ID");
      if (movement.channelId !== current.channelId || movement.kind !== "refund") {
        throw new JournalInvariantError("batch refund Movement does not belong to the channel");
      }
      const channel = current.status === "refunded"
        ? current
        : this.saveBatchChannel({
            ...current,
            status: "refunded",
            version: current.version + 1,
            updatedAtMs: this.timestamp(),
          });
      const accepted = movement.state === "accepted"
        ? this.requireAcceptedBatchMovementEvidence(movement)
        : this.advanceBatchTreasuryMovement({
            movementId: movement.movementId,
            expectedState: movement.state,
            state: "accepted",
            transactionId: input.transactionId,
            evidenceDigest: input.chainEvidenceDigest,
          });
      if (accepted.transactionId !== input.transactionId) {
        throw new JournalInvariantError("accepted batch refund transaction changed");
      }
      if (accepted.evidenceDigest !== input.chainEvidenceDigest) {
        throw new JournalInvariantError("accepted batch refund evidence changed");
      }
      return Object.freeze({ channel, movement: accepted });
    });
    return complete.immediate();
  }

  loadBatchRaceRecovery(input: Readonly<{
    channelId: string;
    sourceOutpoint: Readonly<{ txid: string; index: number }>;
    refundTransactionId: string;
  }>): BatchRaceRecoveryRecord | undefined {
    requireBatchHash(input.channelId, "batch race channel ID");
    const source = normalizeBatchOutpoint(input.sourceOutpoint, "batch race source");
    requireBatchHash(input.refundTransactionId, "batch race refund transaction ID");
    const row = this.db.prepare(
      `SELECT * FROM batch_race_recoveries
        WHERE channel_id = ? AND source_txid = ?
          AND source_output_index = ? AND refund_txid = ?`,
    ).get(
      input.channelId,
      source.txid,
      source.index,
      input.refundTransactionId,
    ) as BatchRaceRecoveryRow | undefined;
    return row ? batchRaceRecoveryFromRow(row) : undefined;
  }

  /**
   * Commits one completed, bounded history page. The expected cursor and page
   * revision form the compare-and-swap fence, so concurrent recovery workers
   * cannot skip, duplicate, or rewind pages. A later recovery call resumes
   * from `nextBeforeCursor`; an exhausted cycle may be safely rescanned because
   * address indexing can lag accepted chain state.
   */
  advanceBatchRaceRecovery(input: Readonly<{
    channelId: string;
    sourceOutpoint: Readonly<{ txid: string; index: number }>;
    refundTransactionId: string;
    expectedBeforeCursor?: string;
    expectedPagesScanned: number;
    nextBeforeCursor?: string;
    rowsScanned: number;
  }>): BatchRaceRecoveryRecord {
    requireBatchHash(input.channelId, "batch race channel ID");
    const source = normalizeBatchOutpoint(input.sourceOutpoint, "batch race source");
    requireBatchHash(input.refundTransactionId, "batch race refund transaction ID");
    const expected = optionalBatchHistoryCursor(input.expectedBeforeCursor, "expected batch history cursor");
    const next = optionalBatchHistoryCursor(input.nextBeforeCursor, "next batch history cursor");
    if (expected !== undefined && next !== undefined && BigInt(next) >= BigInt(expected)) {
      throw new JournalInvariantError("batch history cursor did not move backward");
    }
    if (!Number.isSafeInteger(input.expectedPagesScanned) || input.expectedPagesScanned < 0) {
      throw new JournalInvariantError("expected batch history page count is invalid");
    }
    if (!Number.isSafeInteger(input.rowsScanned) || input.rowsScanned < 0 || input.rowsScanned > 5_000) {
      throw new JournalInvariantError("batch history row count is invalid");
    }
    const advance = this.db.transaction(() => {
      const channel = this.requireBatchChannel(input.channelId);
      if (
        channel.status !== "active" ||
        channel.activeOutpoint.txid !== source.txid ||
        channel.activeOutpoint.index !== source.index
      ) {
        throw new JournalFencingError("batch history recovery source is no longer the active channel outpoint");
      }
      const current = this.loadBatchRaceRecovery(input);
      if (!current) {
        if (expected !== undefined || input.expectedPagesScanned !== 0) {
          throw new JournalFencingError("batch history recovery cursor has no durable predecessor");
        }
        this.db.prepare(
          `INSERT INTO batch_race_recoveries
             (channel_id, source_txid, source_output_index, refund_txid,
              next_before_cursor, pages_scanned, rows_scanned, state,
              winner_txid, evidence_digest, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, ?)`,
        ).run(
          input.channelId,
          source.txid,
          source.index,
          input.refundTransactionId,
          next ?? null,
          input.rowsScanned,
          next === undefined ? "exhausted" : "active",
          this.timestamp(),
        );
      } else {
        if (current.state === "accepted") return current;
        if (
          current.nextBeforeCursor !== expected ||
          current.pagesScanned !== input.expectedPagesScanned ||
          (current.state === "exhausted" && expected !== undefined)
        ) {
          throw new JournalFencingError("batch history recovery cursor changed concurrently");
        }
        const updated = this.db.prepare(
          `UPDATE batch_race_recoveries
              SET next_before_cursor = ?, pages_scanned = pages_scanned + 1,
                  rows_scanned = rows_scanned + ?, state = ?, updated_at_ms = ?
            WHERE channel_id = ? AND source_txid = ? AND source_output_index = ?
              AND refund_txid = ? AND state = ?
              AND next_before_cursor IS ? AND pages_scanned = ?`,
        ).run(
          next ?? null,
          input.rowsScanned,
          next === undefined ? "exhausted" : "active",
          this.timestamp(),
          input.channelId,
          source.txid,
          source.index,
          input.refundTransactionId,
          current.state,
          expected ?? null,
          input.expectedPagesScanned,
        );
        if (updated.changes !== 1) {
          throw new JournalFencingError("batch history recovery progress lost its compare-and-swap");
        }
      }
      return this.loadBatchRaceRecovery(input)!;
    });
    return advance.immediate();
  }

  /**
   * Atomically adopts a fully verified merchant claim which spent the active
   * channel before the prepared client refund, and terminally supersedes that
   * refund Movement. The expected active outpoint is the compare-and-swap
   * fence; address equality alone can never advance channel lineage.
   */
  completeBatchClaimRefundRace(input: Readonly<{
    channelId: string;
    treasuryOperationKey: string;
    refundMovementId: string;
    expectedActiveOutpoint: Readonly<{ txid: string; index: number }>;
    refundTransactionId: string;
    claimTransactionId: string;
    finality: "accepted" | "depth-confirmed";
    continuationOutpoint: Readonly<{ txid: string; index: number }>;
    continuationScriptPublicKey: string;
    continuationFundingAmountAtomic: string;
    chainEvidenceDigest: Sha256Digest;
  }>): Readonly<{
    channel: BatchChannelJournalRecord;
    refundMovement: BatchTreasuryMovementRecord;
    treasuryObservationDetail: Readonly<Record<string, unknown>>;
  }> {
    const reconcile = this.db.transaction(() => {
      assertTreasuryOperationKey(input.treasuryOperationKey);
      if (input.treasuryOperationKey !== `batch.refund.${input.channelId}`) {
        throw new JournalInvariantError("batch claim race Treasury operation does not match the channel");
      }
      requireBatchHash(input.refundTransactionId, "batch refund transaction ID");
      requireBatchHash(input.claimTransactionId, "batch claim transaction ID");
      if (input.finality !== "accepted" && input.finality !== "depth-confirmed") {
        throw new JournalInvariantError("batch claim race finality is invalid");
      }
      const expected = normalizeBatchOutpoint(input.expectedActiveOutpoint, "batch claim source");
      const continuation = normalizeBatchOutpoint(input.continuationOutpoint, "batch claim continuation");
      if (continuation.txid !== input.claimTransactionId || continuation.index !== 1) {
        throw new JournalInvariantError("batch claim continuation does not belong to the accepted claim");
      }
      requireBatchText(input.continuationScriptPublicKey, "batch claim continuation script", 100_000);
      const continuationFundingAtomic = requireBatchAtomic(
        input.continuationFundingAmountAtomic,
        "batch claim continuation funding",
      ).toString();
      const continuationFunding = BigInt(continuationFundingAtomic);
      let channel = this.requireBatchChannel(input.channelId);
      const alreadyApplied =
        channel.activeOutpoint.txid === continuation.txid &&
        channel.activeOutpoint.index === continuation.index;
      if (!alreadyApplied) {
        if (
          channel.activeOutpoint.txid !== expected.txid ||
          channel.activeOutpoint.index !== expected.index ||
          channel.status !== "active"
        ) {
          throw new JournalFencingError("batch claim/refund race lost its active-channel compare-and-swap");
        }
        const funding = BigInt(channel.fundingAmountAtomic);
        const signed = BigInt(channel.signedCumulativeAtomic);
        const claimed = BigInt(channel.claimedCumulativeAtomic);
        const charged = BigInt(channel.chargedCumulativeAtomic);
        const claim = funding - continuationFunding;
        const expectedClaim = charged - claimed;
        if (
          continuationFunding >= funding ||
          claim <= 0n ||
          claim > signed - claimed ||
          input.continuationScriptPublicKey !== channel.activeScriptPublicKey
        ) {
          throw new JournalInvariantError("batch claim/refund race continuation violates channel accounting");
        }
        const chargeMismatch = claim !== expectedClaim;
        const { latestVoucher: _latestVoucher, ...withoutVoucher } = channel;
        const previous = channel;
        channel = this.saveBatchChannel({
          ...withoutVoucher,
          activeOutpoint: continuation,
          activeScriptPublicKey: input.continuationScriptPublicKey,
          fundingAmountAtomic: continuationFundingAtomic,
          chargedCumulativeAtomic: charged.toString(),
          claimedCumulativeAtomic: (claimed + claim).toString(),
          signedCumulativeAtomic: "0",
          ...(chargeMismatch ? {
            status: "suspicious" as const,
            retiredReason: "merchant-claim-does-not-match-active-charge",
          } : {}),
          epoch: channel.epoch + 1,
          version: channel.version + 1,
          updatedAtMs: this.timestamp(),
        });
        const movementId = `batch-claim:${channel.channelId}:${continuation.txid}:${continuation.index}`;
        const requestDigest = evidenceDigest(Buffer.from(JSON.stringify({
          profile: "urn:sompi:batch-channel-successor:1",
          kind: "claim",
          channelId: channel.channelId,
          before: previous.activeOutpoint,
          after: channel.activeOutpoint,
          fundingBefore: previous.fundingAmountAtomic,
          fundingAfter: channel.fundingAmountAtomic,
          charged: channel.chargedCumulativeAtomic,
          acceptedClaimAtomic: claim.toString(),
          chargeMismatch,
          claimedBefore: previous.claimedCumulativeAtomic,
          claimedAfter: channel.claimedCumulativeAtomic,
        }), "utf8"));
        const claimMovement = this.planBatchTreasuryMovement({
          movementId,
          channelId: channel.channelId,
          kind: "claim",
          requestDigest,
          activeOutpointBefore: previous.activeOutpoint,
        });
        if (claimMovement.state === "accepted") {
          this.requireAcceptedBatchMovementEvidence(claimMovement);
        } else {
          this.advanceBatchTreasuryMovement({
            movementId,
            expectedState: claimMovement.state,
            state: "accepted",
            activeOutpointAfter: channel.activeOutpoint,
            transactionId: input.claimTransactionId,
            evidenceDigest: input.chainEvidenceDigest,
          });
        }
      } else if (
        channel.fundingAmountAtomic !== continuationFundingAtomic ||
        channel.activeScriptPublicKey !== input.continuationScriptPublicKey ||
        channel.signedCumulativeAtomic !== "0" ||
        channel.latestVoucher !== undefined ||
        (
          channel.claimedCumulativeAtomic !== channel.chargedCumulativeAtomic &&
          (
            channel.status !== "suspicious" ||
            channel.retiredReason !== "merchant-claim-does-not-match-active-charge"
          )
        )
      ) {
        throw new JournalInvariantError("previously applied batch claim conflicts with race evidence");
      }
      if (alreadyApplied) {
        const claimMovement = this.requireBatchTreasuryMovement(
          `batch-claim:${channel.channelId}:${continuation.txid}:${continuation.index}`,
        );
        this.requireAcceptedBatchMovementEvidence(claimMovement);
        if (claimMovement.evidenceDigest !== input.chainEvidenceDigest) {
          throw new JournalInvariantError("accepted batch claim evidence changed");
        }
      }

      let refundMovement = this.requireBatchTreasuryMovement(input.refundMovementId);
      if (
        refundMovement.kind !== "refund" ||
        refundMovement.channelId !== channel.channelId ||
        refundMovement.activeOutpointBefore?.txid !== expected.txid ||
        refundMovement.activeOutpointBefore?.index !== expected.index
      ) {
        throw new JournalInvariantError("batch refund Movement does not match the accepted claim race");
      }
      if (refundMovement.state !== "failed_terminal") {
        refundMovement = this.advanceBatchTreasuryMovement({
          movementId: refundMovement.movementId,
          expectedState: refundMovement.state,
          state: "failed_terminal",
        });
      }

      const treasuryObservationDetail = Object.freeze({
        profile: "urn:sompi:batch-refund-observation:1",
        operationKey: input.treasuryOperationKey,
        refundTransactionId: input.refundTransactionId,
        winningEffect: "merchant-claim",
        winningTransactionId: input.claimTransactionId,
        continuationOutpoint: continuation,
        continuationFundingAmountAtomic: continuationFundingAtomic,
        chainEvidenceDigest: input.chainEvidenceDigest,
        chainEvidenceLevel: input.finality,
      });
      const detailJson = canonicalTreasuryObservationJson(treasuryObservationDetail);
      if (Buffer.byteLength(detailJson) > 16_384) {
        throw new JournalInvariantError("batch claim race Treasury observation is oversized");
      }
      const detailDigest = evidenceDigest(detailJson);
      const operation = this.requireTreasuryOperation(input.treasuryOperationKey);
      if (
        operation.kind !== "batch_refund" ||
        operation.transactionId !== input.refundTransactionId ||
        !["submission_planned", "submitted", "failed_terminal"].includes(operation.state)
      ) {
        throw new JournalInvariantError("batch claim race Treasury operation is not the prepared refund");
      }
      this.db.prepare(
        `INSERT OR IGNORE INTO treasury_operation_observations
           (operation_key, status, detail_digest, detail_json, observed_at_ms)
         VALUES (?, 'superseded', ?, ?, ?)`,
      ).run(input.treasuryOperationKey, detailDigest, detailJson, this.timestamp());
      if (operation.state !== "failed_terminal") {
        const now = this.timestamp();
        const updated = this.db.prepare(
          `UPDATE treasury_operations
              SET state = 'failed_terminal', submission_in_flight = 0,
                  effect_capability_generation = NULL,
                  completed_at_ms = ?, updated_at_ms = ?
            WHERE operation_key = ? AND state = ?`,
        ).run(now, now, input.treasuryOperationKey, operation.state);
        if (updated.changes !== 1) {
          throw new JournalInvariantError("batch claim race lost its Treasury supersession fence");
        }
        this.insertTreasuryOperationTransition(
          input.treasuryOperationKey,
          operation.state,
          "failed_terminal",
          "mutually_exclusive_chain_effect_accepted",
          now,
        );
      } else {
        const existing = this.db.prepare(
          `SELECT detail_digest FROM treasury_operation_observations
            WHERE operation_key = ? AND status = 'superseded'
            ORDER BY sequence DESC LIMIT 1`,
        ).get(input.treasuryOperationKey) as { detail_digest: string } | undefined;
        if (existing?.detail_digest !== detailDigest) {
          throw new JournalInvariantError("batch claim race Treasury evidence changed");
        }
      }

      const recovery = this.loadBatchRaceRecovery({
        channelId: input.channelId,
        sourceOutpoint: expected,
        refundTransactionId: input.refundTransactionId,
      });
      if (recovery?.state === "accepted") {
        if (
          recovery.winnerTransactionId !== input.claimTransactionId ||
          recovery.evidenceDigest !== input.chainEvidenceDigest
        ) {
          throw new JournalInvariantError("batch claim race accepted evidence changed");
        }
      } else if (recovery) {
        const updated = this.db.prepare(
          `UPDATE batch_race_recoveries
              SET state = 'accepted', winner_txid = ?, evidence_digest = ?, updated_at_ms = ?
            WHERE channel_id = ? AND source_txid = ? AND source_output_index = ?
              AND refund_txid = ? AND state IN ('active', 'exhausted')`,
        ).run(
          input.claimTransactionId,
          input.chainEvidenceDigest,
          this.timestamp(),
          input.channelId,
          expected.txid,
          expected.index,
          input.refundTransactionId,
        );
        if (updated.changes !== 1) {
          throw new JournalInvariantError("batch claim race recovery state changed concurrently");
        }
      } else {
        this.db.prepare(
          `INSERT INTO batch_race_recoveries
             (channel_id, source_txid, source_output_index, refund_txid,
              next_before_cursor, pages_scanned, rows_scanned, state,
              winner_txid, evidence_digest, updated_at_ms)
           VALUES (?, ?, ?, ?, NULL, 0, 0, 'accepted', ?, ?, ?)`,
        ).run(
          input.channelId,
          expected.txid,
          expected.index,
          input.refundTransactionId,
          input.claimTransactionId,
          input.chainEvidenceDigest,
          this.timestamp(),
        );
      }
      return Object.freeze({ channel, refundMovement, treasuryObservationDetail });
    });
    return reconcile.immediate();
  }

  listRefundableBatchChannels(nowDaa: string): BatchChannelJournalRecord[] {
    const now = requireBatchAtomic(nowDaa, "current DAA");
    return this.loadBatchChannels({}).filter((channel) =>
      (channel.status === "active" || channel.status === "refundable") &&
      now > BigInt(channel.refundTimeoutDaa)
    );
  }

  planBatchTreasuryMovement(
    input: Readonly<PlanBatchTreasuryMovementInput>
  ): BatchTreasuryMovementRecord {
    const normalized = normalizeBatchMovementPlan(input);
    const plan = this.db.transaction(() => {
      // The initial deposit Movement is the durable intent that must exist
      // before an escrow-funding effect. The channel cannot exist until that
      // deposit is accepted and its exact outpoint is known.
      if (normalized.kind !== "deposit") this.requireBatchChannel(normalized.channelId);
      if (normalized.purchaseId !== undefined) this.requirePurchase(normalized.purchaseId);
      const existing = this.db
        .prepare("SELECT * FROM batch_treasury_movements WHERE movement_id = ? OR request_digest = ?")
        .get(normalized.movementId, normalized.requestDigest) as BatchTreasuryMovementRow | undefined;
      if (existing) {
        const record = batchMovementFromRow(existing);
        if (
          record.movementId !== normalized.movementId ||
          record.channelId !== normalized.channelId ||
          record.purchaseId !== normalized.purchaseId ||
          record.kind !== normalized.kind ||
          record.requestDigest !== normalized.requestDigest
        ) {
          throw new JournalInvariantError("batch Treasury Movement identity conflicts with existing state");
        }
        return record;
      }
      if (normalized.kind === "voucher") {
        const open = this.db.prepare(
          `SELECT movement_id FROM batch_treasury_movements
            WHERE channel_id = ? AND kind = 'voucher'
              AND state IN ('planned', 'submitted', 'ambiguous')
              AND active_txid_before = ? AND active_output_index_before = ?
            LIMIT 1`
        ).get(
          normalized.channelId,
          normalized.activeOutpointBefore?.txid ?? null,
          normalized.activeOutpointBefore?.index ?? null
        ) as { movement_id: string } | undefined;
        if (open) {
          throw new JournalFencingError(
            `batch channel epoch already has open voucher Movement ${open.movement_id}`
          );
        }
      }
      const now = this.timestamp();
      this.db.prepare(
        `INSERT INTO batch_treasury_movements (
           movement_id, channel_id, purchase_id, kind, state, request_digest,
           active_txid_before, active_output_index_before,
           maximum_authorized_atomic, voucher_ceiling_atomic, prepared_digest,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        normalized.movementId, normalized.channelId, normalized.purchaseId ?? null,
        normalized.kind, normalized.requestDigest,
        normalized.activeOutpointBefore?.txid ?? null,
        normalized.activeOutpointBefore?.index ?? null,
        normalized.maximumAuthorizedAtomic ?? null,
        normalized.voucherCeilingAtomic ?? null,
        normalized.preparedDigest ?? null,
        now, now
      );
      this.inject("batch_movement.after_insert");
      return this.requireBatchTreasuryMovement(normalized.movementId);
    });
    return plan.immediate();
  }

  requireBatchTreasuryMovement(movementId: string): BatchTreasuryMovementRecord {
    requireBatchText(movementId, "batch Treasury Movement ID", 256);
    const row = this.db
      .prepare("SELECT * FROM batch_treasury_movements WHERE movement_id = ?")
      .get(movementId) as BatchTreasuryMovementRow | undefined;
    if (!row) throw new JournalNotFoundError(`Batch Treasury Movement ${movementId} does not exist`);
    return batchMovementFromRow(row);
  }

  /**
   * Close only the Purchase-bound voucher intent whose Merchant submission is
   * proven not to have started. The channel's monotonic signed ceiling is not
   * rewound: a signature may already exist even though no external effect did.
   */
  private terminalizeNeverSubmittedBatchVoucherMovement(
    purchaseId: PurchaseId,
    now: number
  ): void {
    const rows = this.db.prepare(
      `SELECT * FROM batch_treasury_movements
        WHERE purchase_id = ? AND kind = 'voucher'
        ORDER BY movement_id`
    ).all(purchaseId) as BatchTreasuryMovementRow[];
    if (rows.length > 1) {
      throw new JournalInvariantError(
        `Purchase ${purchaseId} owns multiple batch voucher Movements`
      );
    }
    const row = rows[0];
    if (!row) return;
    const movement = batchMovementFromRow(row);
    if (movement.state === "failed_terminal") return;
    if (movement.state !== "planned") {
      throw new JournalEffectBusyError(
        `Purchase ${purchaseId} has a possible batch voucher effect ${movement.movementId}`
      );
    }
    const updated = this.db.prepare(
      `UPDATE batch_treasury_movements
          SET state = 'failed_terminal', updated_at_ms = ?
        WHERE movement_id = ? AND state = 'planned'`
    ).run(now, movement.movementId);
    if (updated.changes !== 1) {
      throw new JournalFencingError(
        "batch voucher terminalization lost its compare-and-swap"
      );
    }
  }

  advanceBatchTreasuryMovement(input: Readonly<{
    movementId: string;
    expectedState: BatchTreasuryMovementState;
    state: BatchTreasuryMovementState;
    actualChargeAtomic?: string;
    activeOutpointAfter?: Readonly<{ txid: string; index: number }>;
    transactionId?: string;
    evidenceDigest?: Sha256Digest;
  }>): BatchTreasuryMovementRecord {
    const advance = this.db.transaction(() => {
      const current = this.requireBatchTreasuryMovement(input.movementId);
      if (current.state !== input.expectedState) {
        throw new JournalFencingError(`batch Treasury Movement is ${current.state}, expected ${input.expectedState}`);
      }
      assertBatchMovementTransition(current.state, input.state);
      const actual = input.actualChargeAtomic === undefined
        ? current.actualChargeAtomic
        : requireBatchAtomic(input.actualChargeAtomic, "batch actual charge").toString();
      if (current.kind === "voucher" && input.state === "accepted") {
        if (actual === undefined || current.maximumAuthorizedAtomic === undefined || current.voucherCeilingAtomic === undefined) {
          throw new JournalInvariantError("accepted voucher movement lacks authorized accounting");
        }
        if (BigInt(actual) <= 0n || BigInt(actual) > BigInt(current.maximumAuthorizedAtomic)) {
          throw new JournalInvariantError("batch actual charge exceeds the Purchase authorization");
        }
      }
      if (input.transactionId !== undefined) requireBatchHash(input.transactionId, "batch movement transaction ID");
      const after = input.activeOutpointAfter === undefined
        ? current.activeOutpointAfter
        : normalizeBatchOutpoint(input.activeOutpointAfter, "batch movement successor");
      if (input.state === "accepted") {
        if (input.transactionId === undefined || input.evidenceDigest === undefined) {
          throw new JournalInvariantError("accepted batch Movement lacks durable verified evidence");
        }
        if (["deposit", "topup", "claim"].includes(current.kind) && after === undefined) {
          throw new JournalInvariantError("accepted batch Movement lacks its successor outpoint");
        }
        this.assertBatchMovementEvidence(
          current.kind,
          input.transactionId,
          input.evidenceDigest,
        );
      }
      const result = this.db.prepare(
        `UPDATE batch_treasury_movements SET state = ?, actual_charge_atomic = ?,
           active_txid_after = ?, active_output_index_after = ?, transaction_id = ?,
           evidence_digest = ?, updated_at_ms = ?
         WHERE movement_id = ? AND state = ?`
      ).run(
        input.state, actual ?? null, after?.txid ?? null, after?.index ?? null,
        input.transactionId ?? current.transactionId ?? null,
        input.evidenceDigest ?? current.evidenceDigest ?? null,
        this.timestamp(), current.movementId, current.state
      );
      if (result.changes !== 1) throw new JournalFencingError("batch Treasury Movement update lost its compare-and-swap");
      return this.requireBatchTreasuryMovement(current.movementId);
    });
    return advance.immediate();
  }

  private requireAcceptedTreasuryMovementEvidence(transactionId: string): Sha256Digest {
    requireBatchHash(transactionId, "batch Treasury transaction ID");
    const row = this.db.prepare(
      `SELECT observation.detail_digest
         FROM treasury_operations operation
         JOIN treasury_operation_observations observation
           ON observation.operation_key = operation.operation_key
        WHERE operation.transaction_id = ?
          AND operation.state = 'completed'
          AND observation.status = 'observed'
        ORDER BY observation.sequence DESC LIMIT 1`,
    ).get(transactionId) as { detail_digest: Sha256Digest } | undefined;
    if (!row) {
      throw new JournalInvariantError("accepted batch deposit lacks Treasury observation evidence");
    }
    return row.detail_digest;
  }

  private assertBatchMovementEvidence(
    kind: BatchTreasuryMovementKind,
    transactionId: string,
    proofDigest: Sha256Digest,
  ): void {
    assertDigest(proofDigest, "batch Movement evidence digest");
    if (kind === "voucher") {
      this.requireEvidence(proofDigest);
      const verified = this.db.prepare(
        "SELECT 1 AS present FROM evidence_verifications WHERE digest = ? LIMIT 1",
      ).get(proofDigest) as { present: number } | undefined;
      if (!verified) {
        throw new JournalInvariantError("accepted batch voucher lacks verified Merchant evidence");
      }
      return;
    }
    if (kind === "deposit") {
      if (this.requireAcceptedTreasuryMovementEvidence(transactionId) !== proofDigest) {
        throw new JournalInvariantError("batch deposit evidence does not match Treasury observation");
      }
      return;
    }
    const evidence = this.db.prepare(
      `SELECT 1 AS present FROM chain_evidence
        WHERE detail_digest = ? AND transaction_id = ? AND status = 'present'
          AND level IN ('accepted', 'depth-confirmed', 'consensus-final')
        LIMIT 1`,
    ).get(proofDigest, transactionId) as { present: number } | undefined;
    if (!evidence) {
      throw new JournalInvariantError("accepted batch Movement lacks matching Chain Evidence");
    }
  }

  private requireAcceptedBatchMovementEvidence(
    movement: BatchTreasuryMovementRecord,
  ): BatchTreasuryMovementRecord {
    if (
      movement.state !== "accepted" ||
      movement.transactionId === undefined ||
      movement.evidenceDigest === undefined
    ) {
      throw new JournalInvariantError("accepted batch Movement lacks durable verified evidence");
    }
    this.assertBatchMovementEvidence(
      movement.kind,
      movement.transactionId,
      movement.evidenceDigest,
    );
    return movement;
  }

  private insertBatchChannelTransition(
    previous: BatchChannelJournalRecord | undefined,
    next: BatchChannelJournalRecord,
    reasonCode: string
  ): void {
    this.db.prepare(
      `INSERT INTO batch_channel_transitions (
         channel_id, from_status, to_status, epoch, active_txid,
         active_output_index, funding_amount_atomic, charged_cumulative_atomic,
         claimed_cumulative_atomic, signed_cumulative_atomic, reason_code,
         created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      next.channelId,
      previous?.status ?? null,
      next.status,
      next.epoch,
      next.activeOutpoint.txid,
      next.activeOutpoint.index,
      next.fundingAmountAtomic,
      next.chargedCumulativeAtomic,
      next.claimedCumulativeAtomic,
      next.signedCumulativeAtomic,
      reasonCode,
      next.updatedAtMs
    );
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
           (SELECT COUNT(*) FROM treasury_operations) +
           (SELECT COUNT(*) FROM transfers) AS count`
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
      const executionPlan = terms ? this.requireExecutionPlan(purchaseId) : undefined;
      const authorizationRequest = this.findAuthorizationRequest(purchaseId);
      const authorization = this.findAuthorization(purchaseId);
      const fulfilment = this.findFulfilment(purchaseId);
      const receipts = this.receipts(purchaseId);
      this.assertPurchaseStateFacts(purchaseId, purchase.state);
      const requiresTerms = !["created", "cancelled"].includes(purchase.state);
      if (requiresTerms && !terms) {
        throw new JournalInvariantError(`Purchase ${purchase.id} state requires immutable Checkout Terms`);
      }
      if (terms) {
        if (
          !executionPlan ||
          executionPlan.requirementsDigest !== terms.paymentRequirementsDigest ||
          executionPlan.maximumChargeAtomic !== terms.amountAtomic ||
          this.requireEvidenceAttachment(
            purchaseId,
            executionPlan.evidenceDigest,
            "execution-plan"
          ).profile !== "urn:sompi:purchase-execution-plan:1" ||
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
      if (purchase.state === "receipted" && receipts.length !== 1) {
        throw new JournalInvariantError(`Purchase ${purchase.id} state requires one canonical Receipt`);
      }
      if (purchase.state !== "receipted" && receipts.length !== 0) {
        throw new JournalInvariantError(`Purchase ${purchase.id} has a canonical Receipt in state ${purchase.state}`);
      }
    }

    const transfers = this.db.prepare("SELECT * FROM transfers ORDER BY id").all() as TransferRow[];
    for (const row of transfers) {
      const transitions = this.db.prepare(
        "SELECT * FROM transfer_transitions WHERE transfer_id = ? ORDER BY sequence"
      ).all(row.id) as Array<{
        from_state: TransferState | null;
        to_state: TransferState;
        reason_code: string;
        detail_digest: string | null;
        created_at_ms: number;
      }>;
      if (transitions.length === 0 || transitions[0].from_state !== null || transitions[0].to_state !== "created") {
        throw new JournalInvariantError(`Transfer ${row.id} has invalid initial history`);
      }
      let state: TransferState = "created";
      let timestamp = transitions[0].created_at_ms;
      for (const transition of transitions.slice(1)) {
        if (transition.from_state !== state || transition.created_at_ms < timestamp) {
          throw new JournalInvariantError(`Transfer ${row.id} history is inconsistent`);
        }
        try { assertTransferTransition(state, transition.to_state); }
        catch { throw new JournalInvariantError(`Transfer ${row.id} history contains an invalid transition`); }
        state = transition.to_state;
        timestamp = transition.created_at_ms;
      }
      if (state !== row.state || row.version !== transitions.length - 1) {
        throw new JournalInvariantError(`Transfer ${row.id} state does not match immutable history`);
      }
      const transfer = transferFromRow(row);
      const authorization = this.findTransferAuthorization(transfer.id);
      const receipt = this.findTransferReceipt(transfer.id);
      if (["authorised", "funds_reserved", "prepared", "submitted", "settled", "receipted", "denied", "failed_recoverable"].includes(state) && !authorization) {
        throw new JournalInvariantError(`Transfer ${row.id} state requires an Authority decision`);
      }
      if (["authorised", "funds_reserved", "prepared", "submitted", "settled", "receipted", "failed_recoverable"].includes(state) && authorization?.decision !== "approved") {
        throw new JournalInvariantError(`Transfer ${row.id} state requires approved Authority evidence`);
      }
      if (state === "denied" && authorization?.decision !== "denied") {
        throw new JournalInvariantError(`Transfer ${row.id} denial lacks Authority evidence`);
      }
      if (authorization) assertTransferFactsMatchIntent(authorization.facts, transfer);
      if (["funds_reserved", "prepared", "submitted", "settled", "receipted", "failed_recoverable"].includes(state) && !transfer.treasuryOperationKey) {
        throw new JournalInvariantError(`Transfer ${row.id} state requires a Treasury operation`);
      }
      if (state === "receipted" && !receipt) {
        throw new JournalInvariantError(`Transfer ${row.id} state requires one receipt`);
      }
      if (state !== "receipted" && receipt) {
        throw new JournalInvariantError(`Transfer ${row.id} has a receipt before receipting`);
      }
      if (receipt) assertTransferReceiptMatches(receipt, transfer);
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
        this.requirePaymentAttempt(effect.purchaseId, effect.attempt);
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
      const spend = this.findSettlement(reservation.id);
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

    const settlements = this.db.prepare("SELECT * FROM purchase_settlements").all() as PurchaseSettlementRow[];
    for (const row of settlements) {
      const settlement = purchaseSettlementFromRow(row);
      const preparation = this.requirePaymentPreparation(settlement.purchaseId, settlement.attempt);
      const effect = this.requireEffect(settlement.effectId);
      const amountMatchesPreparation = settlement.mechanism === "single-transaction"
        ? settlement.actualAmountAtomic === preparation.amountAtomic
        : BigInt(settlement.actualAmountAtomic) > 0n &&
          BigInt(settlement.actualAmountAtomic) <= BigInt(preparation.amountAtomic);
      if (
        settlement.reservationId !== preparation.reservationId ||
        settlement.executionId !== preparation.executionId ||
        settlement.mechanism !== preparation.mechanism ||
        settlement.profile !== preparation.profile ||
        settlement.transactionId !== preparation.transactionId ||
        !amountMatchesPreparation ||
        settlement.asset !== preparation.asset ||
        settlement.payee !== preparation.payee ||
        settlement.network !== preparation.network ||
        !settlementAssuranceMeets(settlement.settlementAssurance, preparation.requiredAssurance) ||
        settlement.fundingSource !== preparation.fundingSource ||
        effect.state !== "observed" ||
        effect.resultDigest !== settlement.evidenceDigest
      ) {
        throw new JournalInvariantError(`Purchase Settlement ${settlement.id} is inconsistent with immutable preparation`);
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
      const spend = this.findSettlementForPurchase(receipt.purchaseId);
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
      if (operation.preparationFenced && operation.state !== "intent") {
        throw new JournalInvariantError(
          `Treasury Operation ${operation.operationKey} preparation fence is bound to the wrong state`
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

    const acceptedBatchMovements = this.db.prepare(
      "SELECT * FROM batch_treasury_movements WHERE state = 'accepted' ORDER BY movement_id",
    ).all() as BatchTreasuryMovementRow[];
    for (const row of acceptedBatchMovements) {
      this.requireAcceptedBatchMovementEvidence(batchMovementFromRow(row));
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
    const executionPlan = terms ? this.requireExecutionPlan(purchaseId) : undefined;
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
    const spend = this.findSettlementForPurchase(purchaseId);
    const fulfilment = this.findFulfilment(purchaseId);
    const receipts = this.receipts(purchaseId);
    if (["cancelled", "expired", "denied", "failed_terminal"].includes(state)) {
      const openVoucher = this.db.prepare(
        `SELECT movement_id FROM batch_treasury_movements
          WHERE purchase_id = ? AND kind = 'voucher'
            AND state IN ('planned', 'submitted', 'ambiguous')
          LIMIT 1`
      ).get(purchaseId) as { movement_id: string } | undefined;
      if (openVoucher) {
        throw new JournalInvariantError(
          `terminal Purchase ${purchaseId} retains open batch voucher Movement ${openVoucher.movement_id}`
        );
      }
    }

    if (state === "terms_bound" && (!terms || !executionPlan)) {
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
    if (state === "receipted" && receipts.length !== 1) {
      throw new JournalInvariantError(`Purchase ${purchaseId} cannot enter receipted without one canonical Receipt`);
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
      executionPlanDigest: request.executionPlanDigest,
      executionMechanism: request.executionMechanism,
      executionProfile: request.executionProfile,
      settlementAssurance: request.settlementAssurance,
      maximumAuthorizedChargeAtomic: request.maximumAuthorizedChargeAtomic,
      ...(request.channelId === undefined ? {} : { channelId: request.channelId }),
      ...(request.channelEpochDigest === undefined
        ? {}
        : { channelEpochDigest: request.channelEpochDigest }),
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

  private findSettlement(reservationId: string): PurchaseSettlementRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM purchase_settlements WHERE reservation_id = ?")
      .get(reservationId) as PurchaseSettlementRow | undefined;
    return row ? purchaseSettlementFromRow(row) : undefined;
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

  private preparedMaterialHasDurableOwner(digest: Sha256Digest): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS owner FROM treasury_operations
          WHERE prepared_digest = ? LIMIT 1`
      )
      .get(digest) as { owner: number } | undefined;
    return row?.owner === 1;
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

  private activatePolicySnapshotIfCurrent(
    expectedDigest: Sha256Digest,
    expectedGeneration: number,
    canonical: PolicyDefinition,
  ): PolicySnapshotRecord {
    const active = this.requireActivePolicy();
    const activation = this.requireActivePolicyActivation();
    if (active.digest !== expectedDigest || activation.activationGeneration !== expectedGeneration) {
      throw new PolicyReservationError(
        "active treasury policy changed before this approved revision could be applied"
      );
    }
    const digest = evidenceDigest(JSON.stringify(canonical));
    let snapshot = this.findPolicy(digest);
    const now = this.timestamp();
    if (!snapshot) {
      const version = Number(
        (this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM policy_snapshots").get() as {
          version: number;
        }).version
      );
      this.db.prepare(
        `INSERT INTO policy_snapshots
           (digest, version, max_per_payment_atomic, max_per_hour_atomic, activated_at_ms)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        digest,
        version,
        canonical.maxPerPaymentAtomic,
        canonical.maxPerHourAtomic,
        now,
      );
      for (const payee of canonical.allowlist) {
        this.db.prepare(
          "INSERT INTO policy_allowlist (policy_digest, payee) VALUES (?, ?)"
        ).run(digest, payee);
      }
      snapshot = this.requirePolicy(digest);
    }
    const updated = this.db.prepare(
      `UPDATE journal_policy
          SET active_digest = ?, updated_at_ms = ?, activation_generation = activation_generation + 1
        WHERE singleton = 1 AND active_digest = ? AND activation_generation = ?`
    ).run(digest, now, expectedDigest, expectedGeneration);
    if (updated.changes !== 1) {
      throw new PolicyReservationError(
        "active treasury policy changed before this approved revision could be applied"
      );
    }
    return snapshot;
  }

  private transitionPolicyChange(
    id: string,
    fromState: PolicyChangeJournalState,
    toState: PolicyChangeJournalState,
    reasonCode: string,
  ): PolicyChangeJournalRecord {
    assertPolicyChangeId(id);
    assertPolicyChangeTransition(fromState, toState);
    assertCode(reasonCode, "Policy Change transition reason code");
    const transition = this.db.transaction(() => {
      const current = this.policyChange(id);
      if (current.state === toState) return current;
      if (current.state !== fromState) {
        throw new JournalInvariantError(
          `Policy Change ${id} expected ${fromState}, found ${current.state}`
        );
      }
      const now = this.timestamp();
      const updated = this.db.prepare(
        "UPDATE policy_changes SET state = ?, updated_at_ms = ? WHERE id = ? AND state = ?"
      ).run(toState, now, id, fromState);
      if (updated.changes !== 1) {
        throw new JournalInvariantError(`concurrent Policy Change transition for ${id}`);
      }
      this.insertPolicyChangeTransition(id, fromState, toState, reasonCode, now);
      return this.policyChange(id);
    });
    return transition.immediate();
  }

  private completePolicyChangeDecision(
    id: string,
    toState: "denied",
    decision: Readonly<{ authorityId: string; evidenceDigest: Sha256Digest; evidence: Uint8Array }>,
  ): PolicyChangeJournalRecord {
    validatePolicyDecision(decision);
    const complete = this.db.transaction(() => {
      const current = this.policyChange(id);
      if (current.state === toState) {
        if (current.authorityEvidenceDigest !== decision.evidenceDigest) {
          throw new JournalInvariantError(`Policy Change ${id} has a different authority decision`);
        }
        return current;
      }
      if (current.state !== "awaiting_authority") {
        throw new JournalInvariantError(
          `Policy Change ${id} cannot be denied from ${current.state}`
        );
      }
      if (this.timestamp() >= current.expiresAtMs) {
        return this.transitionPolicyChange(id, "awaiting_authority", "expired", "authority_expired");
      }
      this.writePolicyChangeDecision(current, toState, decision);
      return this.policyChange(id);
    });
    return complete.immediate();
  }

  private writePolicyChangeDecision(
    current: PolicyChangeJournalRecord,
    toState: "authorised" | "denied",
    decision: Readonly<{ authorityId: string; evidenceDigest: Sha256Digest; evidence: Uint8Array }>,
  ): void {
    validatePolicyDecision(decision);
    assertPolicyChangeTransition(current.state, toState);
    const now = this.timestamp();
    const updated = this.db.prepare(
      `UPDATE policy_changes
          SET state = ?, authority_id = ?, authority_evidence_digest = ?,
              authority_evidence = ?, updated_at_ms = ?
        WHERE id = ? AND state = 'awaiting_authority'`
    ).run(
      toState,
      decision.authorityId,
      decision.evidenceDigest,
      Buffer.from(decision.evidence),
      now,
      current.id,
    );
    if (updated.changes !== 1) {
      throw new JournalInvariantError(`concurrent Policy Change decision for ${current.id}`);
    }
    this.insertPolicyChangeTransition(
      current.id,
      "awaiting_authority",
      toState,
      toState === "authorised" ? "authority_approved" : "authority_denied",
      now,
    );
  }

  private insertPolicyChangeTransition(
    id: string,
    fromState: PolicyChangeJournalState | null,
    toState: PolicyChangeJournalState,
    reasonCode: string,
    now: number,
  ): void {
    assertPolicyChangeId(id);
    assertCode(reasonCode, "Policy Change transition reason code");
    this.db.prepare(
      `INSERT INTO policy_change_transitions
         (policy_change_id, from_state, to_state, reason_code, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, fromState, toState, reasonCode, now);
  }

  private transitionVaultMigration(
    id: string,
    fromState: VaultMigrationJournalState,
    toState: VaultMigrationJournalState,
    reasonCode: string,
    failureCode?: string,
  ): VaultMigrationJournalRecord {
    assertVaultMigrationId(id);
    assertVaultMigrationTransition(fromState, toState);
    assertCode(reasonCode, "Vault Migration transition reason code");
    if (failureCode !== undefined) assertSafeIdentity(failureCode, "Vault Migration failure code", 100);
    if ((toState === "failed") !== (failureCode !== undefined)) {
      throw new JournalInvariantError("failed Vault Migration transition must carry exactly one failure code");
    }
    const transition = this.db.transaction(() => {
      const current = this.vaultMigration(id);
      if (current.state === toState) return current;
      if (current.state !== fromState) {
        throw new JournalInvariantError(`Vault Migration ${id} expected ${fromState}, found ${current.state}`);
      }
      const now = this.timestamp();
      const updated = this.db.prepare(
        "UPDATE vault_migrations SET state = ?, failure_code = ?, updated_at_ms = ? WHERE id = ? AND state = ?"
      ).run(toState, failureCode ?? null, now, id, fromState);
      if (updated.changes !== 1) throw new JournalInvariantError(`concurrent Vault Migration transition for ${id}`);
      this.insertVaultMigrationTransition(id, fromState, toState, reasonCode, now);
      return this.vaultMigration(id);
    });
    return transition.immediate();
  }

  private insertVaultMigrationTransition(
    id: string,
    fromState: VaultMigrationJournalState | null,
    toState: VaultMigrationJournalState,
    reasonCode: string,
    now: number,
  ): void {
    assertVaultMigrationId(id);
    assertCode(reasonCode, "Vault Migration transition reason code");
    this.db.prepare(
      `INSERT INTO vault_migration_transitions
         (vault_migration_id, from_state, to_state, reason_code, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, fromState, toState, reasonCode, now);
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
    excludeOperationKey?: string,
  ): void {
    if (
      kind !== "vault_deposit" && kind !== "batch_refund" &&
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
    const policyAmount = kind === "vault_deposit" || kind === "batch_refund" ? 0n : amount;
    const gross = policyAmount + fee;
    const maxPerPayment = decimalBigInt(policy.maxPerPaymentAtomic, "per-payment limit");
    const maxPerHour = decimalBigInt(policy.maxPerHourAtomic, "hourly limit");
    if (policyAmount > maxPerPayment) {
      throw new PolicyReservationError(
        `direct Treasury amount ${policyAmount} exceeds per-payment limit ${maxPerPayment}`
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
        `SELECT actual_amount_atomic, actual_additional_cost_atomic FROM purchase_settlements
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
        const amount = row.kind === "vault_deposit" || row.kind === "batch_refund"
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

  private commitPurchaseAdmissionIntent(admissionId: string, owner: string): PurchaseRecord {
    if (!this.evidenceStore) {
      throw new JournalInvariantError("an evidence directory is required for immutable evidence storage");
    }
    const pending = this.db.prepare(
      "SELECT * FROM purchase_admission_intents WHERE admission_id = ?"
    ).get(admissionId) as PurchaseAdmissionIntentRow | undefined;
    if (!pending) throw new JournalInvariantError("Purchase admission intent is missing");
    if (pending.state === "committed") return this.requirePurchase(pending.purchase_id as PurchaseId);
    if (pending.owner !== owner && pending.deadline_at_ms > this.timestamp()) {
      throw new JournalInvariantError("Purchase admission intent is owned by another live driver");
    }
    const staged = this.evidenceStore.verify(
      pending.evidence_digest as Sha256Digest,
      pending.evidence_byte_length,
    );
    const commit = this.db.transaction(() => {
      const current = this.db.prepare(
        "SELECT * FROM purchase_admission_intents WHERE admission_id = ?"
      ).get(admissionId) as PurchaseAdmissionIntentRow | undefined;
      if (!current) throw new JournalInvariantError("Purchase admission intent is missing");
      if (current.state === "committed") return this.requirePurchase(current.purchase_id as PurchaseId);
      if (current.owner !== owner && current.deadline_at_ms > this.timestamp()) {
        throw new JournalInvariantError("Purchase admission intent owner is still live");
      }
      const now = this.timestamp();
      const purchaseInput: CreatePurchaseInput = {
        id: current.purchase_id as PurchaseId,
        requestKey: current.request_key as PurchaseRequestKey,
        resourceUrl: current.resource_url,
        method: current.method,
        resourceFingerprint: current.resource_fingerprint as Sha256Digest,
        ...(current.expected_merchant_id === null ? {} : { expectedMerchantId: current.expected_merchant_id }),
        ...(current.expected_merchant_origin === null ? {} : { expectedMerchantOrigin: current.expected_merchant_origin }),
      };
      const existingPurchase = this.findPurchaseByRequestKey(purchaseInput.requestKey);
      if (existingPurchase) {
        assertSamePurchaseIntent(existingPurchase, purchaseInput);
        if (existingPurchase.id !== purchaseInput.id) {
          throw new JournalInvariantError("Purchase admission request key is bound to another Purchase");
        }
      } else {
        this.db.prepare(
          `INSERT INTO purchases (
             id, request_key, state, resource_url, method, resource_fingerprint,
             expected_merchant_id, expected_merchant_origin, version, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 'created', ?, ?, ?, ?, ?, 0, ?, ?)`
        ).run(
          purchaseInput.id,
          purchaseInput.requestKey,
          purchaseInput.resourceUrl,
          purchaseInput.method,
          purchaseInput.resourceFingerprint,
          purchaseInput.expectedMerchantId ?? null,
          purchaseInput.expectedMerchantOrigin ?? null,
          now,
          now,
        );
        this.inject("purchase.after_insert");
        this.insertPurchaseTransition(
          purchaseInput.id,
          undefined,
          "created",
          "purchase_created",
          undefined,
          now,
        );
      }

      // Convert the compound admission's reserved count into the same
      // durable completed lease used by ordinary Purchase creation. The
      // reservation is retained for the Purchase lifetime; it is not a
      // temporary counter to decrement after the row is published.
      const purchaseLeaseId = `purchase:${purchaseInput.id}`;
      const purchaseLease = this.db.prepare(
        `SELECT purchase_id, state FROM admission_leases WHERE lease_id = ?`
      ).get(purchaseLeaseId) as { purchase_id: string | null; state: string } | undefined;
      if (!purchaseLease) {
        this.db.prepare(
          `INSERT INTO admission_leases
             (lease_id, owner, resource, purchase_id, quantity, state,
              deadline_at_ms, outcome, created_at_ms, updated_at_ms)
           VALUES (?, ?, 'prevalidation_purchase', ?, 1, 'completed', NULL,
                   'purchase_retained', ?, ?)`
        ).run(purchaseLeaseId, current.owner, purchaseInput.id, now, now);
      } else if (purchaseLease.purchase_id !== purchaseInput.id || purchaseLease.state !== "completed") {
        throw new JournalInvariantError("Purchase admission count lease is inconsistent");
      }

      const artifact = this.findEvidence(pending.evidence_digest as Sha256Digest);
      if (artifact) {
        assertSameEvidenceBlob(artifact, staged.byteLength, staged.storageRef);
      } else {
        this.db.prepare(
          `INSERT INTO evidence_artifacts
             (digest, media_type, profile, issuer, byte_length, storage_ref, created_at_ms)
           VALUES (?, 'application/octet-stream', 'urn:sompi:evidence-blob:1', NULL, ?, ?, ?)`
        ).run(pending.evidence_digest, staged.byteLength, staged.storageRef, now);
        this.inject("evidence.after_metadata_insert");
      }
      this.db.prepare(
        `INSERT OR IGNORE INTO evidence_links
           (purchase_id, digest, kind, attempt, media_type, profile, issuer, attached_at_ms)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
      ).run(
        purchaseInput.id,
        pending.evidence_digest,
        pending.evidence_kind,
        pending.evidence_media_type,
        pending.evidence_profile,
        pending.evidence_issuer,
        now,
      );

      const evidenceLease = this.db.prepare(
        `SELECT quantity, state FROM admission_leases
          WHERE lease_id = ?`
      ).get(`evidence:${admissionId}`) as { quantity: number; state: string } | undefined;
      if (!evidenceLease) throw new JournalInvariantError("Purchase evidence admission lease is missing");
      this.db.prepare(
        `UPDATE admission_leases SET purchase_id = ?
          WHERE lease_id = ? AND purchase_id IS NULL AND state = 'active'`
      ).run(purchaseInput.id, `evidence:${admissionId}`);
      if (evidenceLease.state === "active") {
        this.db.prepare(
          `UPDATE admission_leases SET state = 'completed', outcome = ?, updated_at_ms = ?
            WHERE lease_id = ? AND state = 'active'`
        ).run(artifact ? "blob_deduplicated" : "blob_committed", now, `evidence:${admissionId}`);
        if (evidenceLease.quantity > 0) {
          this.db.prepare(
            `UPDATE journal_admission_budget
                SET reserved_evidence_bytes = reserved_evidence_bytes - ?,
                    committed_evidence_bytes = committed_evidence_bytes + ?,
                    updated_at_ms = ?
              WHERE singleton = 1`
          ).run(evidenceLease.quantity, artifact ? 0 : evidenceLease.quantity, now);
        }
      } else if (evidenceLease.state !== "completed") {
        throw new JournalInvariantError("Evidence admission lease is not active");
      }
      const updated = this.db.prepare(
        `UPDATE purchase_admission_intents
            SET state = 'committed', outcome = 'purchase_and_evidence_retained', updated_at_ms = ?
          WHERE admission_id = ? AND state IN ('offered', 'staged')`
      ).run(now, admissionId);
      if (updated.changes !== 1) {
        throw new JournalInvariantError("Purchase admission intent committed more than once");
      }
      return this.requirePurchase(purchaseInput.id);
    });
    return commit.immediate();
  }

  private cancelPurchaseAdmission(admissionId: string, outcome: string): void {
    if (!this.admission) return;
    const cancel = this.db.transaction(() => {
      const pending = this.db.prepare(
        "SELECT * FROM purchase_admission_intents WHERE admission_id = ?"
      ).get(admissionId) as PurchaseAdmissionIntentRow | undefined;
      if (!pending || pending.state === "committed" || pending.state === "cancelled") return;
      const now = this.timestamp();
      const evidenceLease = this.db.prepare(
        "SELECT quantity, state, digest FROM admission_leases WHERE lease_id = ?"
      ).get(`evidence:${admissionId}`) as { quantity: number; state: string; digest: string | null } | undefined;
      this.db.prepare(
        `UPDATE purchase_admission_intents
            SET state = 'cancelled', outcome = ?, updated_at_ms = ?
          WHERE admission_id = ? AND state IN ('offered', 'staged')`
      ).run(outcome, now, admissionId);
      this.db.prepare(
        `UPDATE journal_admission_budget
            SET reserved_purchase_count = reserved_purchase_count - 1, updated_at_ms = ?
          WHERE singleton = 1`
      ).run(now);
      if (evidenceLease?.state === "active") {
        this.db.prepare(
          `UPDATE admission_leases SET state = 'cancelled', outcome = ?, updated_at_ms = ?
            WHERE lease_id = ? AND state = 'active'`
        ).run(outcome, now, `evidence:${admissionId}`);
        if (evidenceLease.quantity > 0) {
          this.db.prepare(
            `UPDATE journal_admission_budget
                SET reserved_evidence_bytes = reserved_evidence_bytes - ?, updated_at_ms = ?
              WHERE singleton = 1`
          ).run(evidenceLease.quantity, now);
        }
      }
      const digest = evidenceLease?.digest as Sha256Digest | null | undefined;
      if (digest && !this.evidenceHasDurableOwner(digest)) {
        this.evidenceStore?.removeUnreferenced(digest);
      }
    });
    cancel.immediate();
  }

  private reconcilePurchaseAdmissionIntents(): void {
    if (!this.admission || !this.evidenceStore) return;
    const now = this.timestamp();
    const pending = this.db.prepare(
      `SELECT admission_id, owner, evidence_digest, evidence_byte_length, deadline_at_ms, state
         FROM purchase_admission_intents WHERE state IN ('offered', 'staged')`
    ).all() as Array<{
      admission_id: string;
      owner: string;
      evidence_digest: string;
      evidence_byte_length: number;
      deadline_at_ms: number;
      state: string;
    }>;
    for (const intent of pending) {
      // An unexpired foreign owner may still be writing. Startup must not
      // steal or cancel that lease merely because another handle opened.
      if (intent.deadline_at_ms > now) continue;
      try {
        this.evidenceStore.verify(intent.evidence_digest as Sha256Digest, intent.evidence_byte_length);
        this.commitPurchaseAdmissionIntent(intent.admission_id, intent.owner);
      } catch {
        this.cancelPurchaseAdmission(intent.admission_id, "restart_recovery");
      }
    }
  }

  private evidenceHasDurableOwner(digest: Sha256Digest): boolean {
    const artifact = this.db.prepare(
      "SELECT 1 FROM evidence_artifacts WHERE digest = ? LIMIT 1"
    ).get(digest);
    if (artifact) return true;
    const link = this.db.prepare(
      "SELECT 1 FROM evidence_links WHERE digest = ? LIMIT 1"
    ).get(digest);
    if (link) return true;
    const lease = this.db.prepare(
      `SELECT 1 FROM admission_leases
        WHERE digest = ? AND state IN ('offered', 'admitted', 'active') LIMIT 1`
    ).get(digest);
    if (lease) return true;
    return Boolean(this.db.prepare(
      `SELECT 1 FROM purchase_admission_intents
        WHERE evidence_digest = ? AND state IN ('offered', 'staged') LIMIT 1`
    ).get(digest));
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
    const cancel = this.db.transaction(() => {
      const lease = this.db.prepare(
        "SELECT quantity, state, storage_ref, digest FROM admission_leases WHERE lease_id = ?"
      ).get(leaseId) as { quantity: number; state: string; storage_ref: string | null; digest: string | null } | undefined;
      if (!lease) return;
      if (lease.state !== "active") return;
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
      const digest = lease.digest as Sha256Digest | null;
      if (digest && !this.evidenceHasDurableOwner(digest)) {
        // Keep the ownership check and unlink under the same SQLite write
        // transaction. A failed duplicate writer can never remove a sibling
        // writer's live digest between its check and filesystem cleanup.
        this.evidenceStore?.removeUnreferenced(digest);
      }
    });
    cancel.immediate();
  }

  private reconcileAdmissionLeases(): void {
    if (!this.admission || !this.evidenceStore) return;
    const reconcile = this.db.transaction(() => {
      const leases = this.db.prepare(
        `SELECT lease_id, resource, purchase_id, digest, quantity, state, deadline_at_ms
           FROM admission_leases WHERE state IN ('offered', 'admitted', 'active')`
      ).all() as Array<{
        lease_id: string;
        resource: string;
        purchase_id: string | null;
        digest: string | null;
        quantity: number;
        state: string;
        deadline_at_ms: number;
      }>;
      const now = this.timestamp();
      for (const lease of leases) {
        // An unexpired foreign owner may still be in the reversible staging
        // window. Only expired leases are eligible for deterministic takeover.
        if (lease.deadline_at_ms > now) continue;
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
          if (lease.digest && !artifact && !this.evidenceHasDurableOwner(lease.digest as Sha256Digest)) {
            this.evidenceStore?.removeUnreferenced(lease.digest as Sha256Digest);
          }
        }
      }
      this.db.prepare(
                `UPDATE journal_admission_budget
            SET reserved_purchase_count = (
                  SELECT COUNT(*) FROM admission_leases
                   WHERE resource = 'prevalidation_purchase'
                     AND state NOT IN ('cancelled', 'expired', 'failed_terminal')
                ) + (
                  SELECT COUNT(*) FROM purchase_admission_intents
                   WHERE state IN ('offered', 'staged')
                ),
                reserved_evidence_bytes = (
                  SELECT COALESCE(SUM(quantity), 0) FROM admission_leases
                   WHERE resource = 'evidence_bytes' AND state IN ('offered', 'admitted', 'active')
                ),
                committed_evidence_bytes = (
                  SELECT COALESCE(SUM(byte_length), 0) FROM evidence_artifacts
                ),
                updated_at_ms = ?
          WHERE singleton = 1`
      ).run(now);
    });
    reconcile.immediate();
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
  authorization_evidence_digest: string | null;
  retry_limit: number;
  cancellation_requested: number;
  preparation_fenced: number;
  driver_owner: string | null;
  driver_generation: number;
  driver_lease_expires_at_ms: number | null;
  effect_capability_generation: number | null;
  submission_in_flight: number;
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

interface PurchaseExecutionPlanRow {
  purchase_id: string;
  plan_digest: string;
  mechanism: "single-transaction" | "channel-voucher";
  profile: string;
  requirements_digest: string;
  maximum_charge_atomic: string;
  settlement_assurance: "accepted" | "confirmed" | "channel-commitment";
  channel_id: string | null;
  active_txid: string | null;
  active_output_index: number | null;
  active_script_public_key: string | null;
  channel_funding_amount_atomic: string | null;
  refund_timeout_daa: string | null;
  claim_fee_reserve_atomic: string | null;
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
  execution_plan_digest: string;
  execution_mechanism: PurchaseExecutionMechanism;
  execution_profile: string;
  settlement_assurance: PurchaseExecutionAssurance;
  maximum_authorized_charge_atomic: string;
  channel_id: string | null;
  channel_epoch_digest: string | null;
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
  purchase_id: string;
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

interface PurchaseAdmissionIntentRow {
  admission_id: string;
  purchase_id: string;
  request_key: string;
  resource_url: string;
  method: string;
  resource_fingerprint: string;
  expected_merchant_id: string | null;
  expected_merchant_origin: string | null;
  evidence_digest: string;
  evidence_byte_length: number;
  evidence_storage_ref: string;
  evidence_media_type: string;
  evidence_profile: string;
  evidence_issuer: string | null;
  evidence_kind: string;
  state: string;
  owner: string;
  deadline_at_ms: number;
  outcome: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface PolicySnapshotRow {
  digest: string;
  version: number;
  max_per_payment_atomic: string;
  max_per_hour_atomic: string;
  activated_at_ms: number;
}

interface PolicyChangeRow {
  id: string;
  request_key: string;
  state: PolicyChangeJournalState;
  expected_policy_digest: string;
  expected_policy_generation: number;
  expected_vault_digest: string;
  previous_max_per_payment_atomic: string;
  previous_max_per_hour_atomic: string;
  proposed_max_per_payment_atomic: string;
  proposed_max_per_hour_atomic: string;
  vault_maximum_outflow_atomic: string;
  manifest_revision: number;
  manifest_digest: string;
  expires_at_ms: number;
  authority_id: string | null;
  authority_evidence_digest: string | null;
  authority_evidence: Uint8Array | null;
  applied_policy_digest: string | null;
  applied_policy_version: number | null;
  failure_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface VaultMigrationRow {
  id: string;
  request_key: string;
  state: VaultMigrationJournalState;
  old_vault_digest: string;
  expected_policy_digest: string;
  expected_policy_generation: number;
  old_maximum_outflow_atomic: string;
  new_maximum_outflow_atomic: string;
  window_size_daa: string;
  window_start_daa: string;
  spent_in_window_atomic: string;
  stable_receive_address: string;
  manifest_revision: number;
  manifest_digest: string;
  expires_at_ms: number;
  authority_id: string | null;
  authority_evidence_digest: string | null;
  authority_evidence: Uint8Array | null;
  recovery_transaction_id: string | null;
  replacement_transaction_id: string | null;
  receipt_digest: string | null;
  failure_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
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
  execution_id: string;
  mechanism: PurchaseExecutionMechanism;
  profile: string;
  transaction_id: string | null;
  amount_atomic: string;
  asset: string;
  network: string;
  payee: string;
  required_assurance: PurchaseExecutionAssurance;
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

interface PurchaseSettlementRow {
  id: number;
  effect_id: string;
  reservation_id: string;
  purchase_id: string;
  attempt: number;
  execution_id: string;
  mechanism: PurchaseExecutionMechanism;
  profile: string;
  transaction_id: string | null;
  commitment_id: string | null;
  outpoint: string | null;
  actual_amount_atomic: string;
  actual_additional_cost_atomic: string;
  asset: string;
  payee: string;
  network: string;
  settlement_assurance: PurchaseExecutionAssurance;
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
    preparationFenced: row.preparation_fenced === 1,
    ...(row.driver_owner === null ? {} : { driverOwner: row.driver_owner }),
    driverGeneration: row.driver_generation,
    ...(row.driver_lease_expires_at_ms === null
      ? {}
      : { driverLeaseExpiresAtMs: row.driver_lease_expires_at_ms }),
    ...(row.effect_capability_generation === null
      ? {}
      : { effectCapabilityGeneration: row.effect_capability_generation }),
    submissionInFlight: row.submission_in_flight === 1,
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
    ...(row.authorization_evidence_digest === null
      ? {}
      : { authorizationEvidenceDigest: row.authorization_evidence_digest }),
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
    authorizationEvidenceDigest: operation.authorizationEvidenceDigest,
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
  if (
    (operation.driverOwner === undefined) !== (operation.driverLeaseExpiresAtMs === undefined) ||
    !Number.isSafeInteger(operation.driverGeneration) ||
    operation.driverGeneration < 0
  ) {
    throw new JournalInvariantError("direct Treasury driver lease shape is invalid");
  }
  const driverLeaseExpiry = operation.driverLeaseExpiresAtMs;
  if (
    operation.driverOwner !== undefined &&
    (driverLeaseExpiry === undefined || !Number.isSafeInteger(driverLeaseExpiry) || driverLeaseExpiry <= 0)
  ) {
    throw new JournalInvariantError("direct Treasury driver lease expiry is invalid");
  }
  if (
    operation.effectCapabilityGeneration !== undefined &&
    (operation.effectCapabilityGeneration < 1 ||
      operation.effectCapabilityGeneration > operation.driverGeneration ||
      !["submission_planned", "submitted", "observed", "completed"].includes(operation.state))
  ) {
      throw new JournalInvariantError("direct Treasury effect capability generation is invalid");
  }
  if (
    operation.submissionInFlight &&
    (operation.state !== "submission_planned" ||
      operation.effectCapabilityGeneration === undefined ||
      operation.preparedDigest === undefined)
  ) {
    throw new JournalInvariantError("direct Treasury submission-in-flight fence is invalid");
  }
  if (operation.state !== "submission_planned" && operation.submissionInFlight) {
    throw new JournalInvariantError("direct Treasury submission-in-flight fence has an invalid state");
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

function purchaseExecutionPlanFromRow(row: PurchaseExecutionPlanRow): PurchaseExecutionPlanRecord {
  const plan = canonicalPurchaseExecutionPlan({
    mechanism: row.mechanism,
    profile: row.profile,
    requirementsDigest: row.requirements_digest as Sha256Digest,
    maximumChargeAtomic: row.maximum_charge_atomic,
    settlementAssurance: row.settlement_assurance,
    ...(row.channel_id === null ? {} : {
      channelEpoch: {
        channelId: row.channel_id,
        activeOutpoint: {
          txid: row.active_txid!,
          index: row.active_output_index!,
        },
        activeScriptPublicKey: row.active_script_public_key!,
        fundingAmountAtomic: row.channel_funding_amount_atomic!,
        refundTimeoutDaa: row.refund_timeout_daa!,
      },
      claimFeeReserveAtomic: row.claim_fee_reserve_atomic!,
    }),
  });
  if (plan.digest !== row.plan_digest) {
    throw new JournalInvariantError("persisted Purchase execution plan digest is invalid");
  }
  return Object.freeze({
    ...plan,
    purchaseId: row.purchase_id as PurchaseId,
    evidenceDigest: row.plan_digest as Sha256Digest,
    createdAtMs: row.created_at_ms,
  });
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
    executionPlanDigest: row.execution_plan_digest as Sha256Digest,
    executionMechanism: row.execution_mechanism,
    executionProfile: row.execution_profile,
    settlementAssurance: row.settlement_assurance,
    maximumAuthorizedChargeAtomic: row.maximum_authorized_charge_atomic,
    ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
    ...(row.channel_epoch_digest === null
      ? {}
      : { channelEpochDigest: row.channel_epoch_digest as Sha256Digest }),
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
    purchaseId: row.purchase_id as PurchaseId,
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
    allowlist,
    activatedAtMs: row.activated_at_ms,
  };
}

function policyChangeFromRow(row: PolicyChangeRow): PolicyChangeJournalRecord {
  return Object.freeze({
    id: row.id,
    requestKey: row.request_key,
    state: row.state,
    expectedPolicyDigest: row.expected_policy_digest as Sha256Digest,
    expectedPolicyGeneration: row.expected_policy_generation,
    expectedVaultDigest: row.expected_vault_digest as Sha256Digest,
    previousMaximumPerPaymentAtomic: row.previous_max_per_payment_atomic,
    previousMaximumPerHourAtomic: row.previous_max_per_hour_atomic,
    proposedMaximumPerPaymentAtomic: row.proposed_max_per_payment_atomic,
    proposedMaximumPerHourAtomic: row.proposed_max_per_hour_atomic,
    vaultMaximumOutflowAtomic: row.vault_maximum_outflow_atomic,
    manifestRevision: row.manifest_revision,
    manifestDigest: row.manifest_digest as Sha256Digest,
    expiresAtMs: row.expires_at_ms,
    ...(row.authority_id === null ? {} : { authorityId: row.authority_id }),
    ...(row.authority_evidence_digest === null
      ? {}
      : { authorityEvidenceDigest: row.authority_evidence_digest as Sha256Digest }),
    ...(row.authority_evidence === null
      ? {}
      : { authorityEvidence: new Uint8Array(row.authority_evidence) }),
    ...(row.applied_policy_digest === null
      ? {}
      : { appliedPolicyDigest: row.applied_policy_digest as Sha256Digest }),
    ...(row.applied_policy_version === null
      ? {}
      : { appliedPolicyVersion: row.applied_policy_version }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  });
}

function vaultMigrationFromRow(row: VaultMigrationRow): VaultMigrationJournalRecord {
  return Object.freeze({
    id: row.id,
    requestKey: row.request_key,
    state: row.state,
    oldVaultDigest: row.old_vault_digest as Sha256Digest,
    expectedPolicyDigest: row.expected_policy_digest as Sha256Digest,
    expectedPolicyGeneration: row.expected_policy_generation,
    oldMaximumOutflowAtomic: row.old_maximum_outflow_atomic,
    newMaximumOutflowAtomic: row.new_maximum_outflow_atomic,
    windowSizeDaa: row.window_size_daa,
    windowStartDaa: row.window_start_daa,
    spentInWindowAtomic: row.spent_in_window_atomic,
    stableReceiveAddress: row.stable_receive_address,
    manifestRevision: row.manifest_revision,
    manifestDigest: row.manifest_digest as Sha256Digest,
    expiresAtMs: row.expires_at_ms,
    ...(row.authority_id === null ? {} : { authorityId: row.authority_id }),
    ...(row.authority_evidence_digest === null ? {} : { authorityEvidenceDigest: row.authority_evidence_digest as Sha256Digest }),
    ...(row.authority_evidence === null ? {} : { authorityEvidence: new Uint8Array(row.authority_evidence) }),
    ...(row.recovery_transaction_id === null ? {} : { recoveryTransactionId: row.recovery_transaction_id }),
    ...(row.replacement_transaction_id === null ? {} : { replacementTransactionId: row.replacement_transaction_id }),
    ...(row.receipt_digest === null ? {} : { receiptDigest: row.receipt_digest as Sha256Digest }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  });
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
    executionId: row.execution_id,
    mechanism: row.mechanism,
    profile: row.profile,
    ...(row.transaction_id === null ? {} : { transactionId: row.transaction_id }),
    amountAtomic: row.amount_atomic,
    asset: row.asset,
    network: row.network,
    payee: row.payee,
    requiredAssurance: row.required_assurance,
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

function purchaseSettlementFromRow(row: PurchaseSettlementRow): PurchaseSettlementRecord {
  return {
    id: row.id,
    effectId: row.effect_id,
    reservationId: row.reservation_id,
    purchaseId: row.purchase_id as PurchaseId,
    attempt: row.attempt,
    executionId: row.execution_id,
    mechanism: row.mechanism,
    profile: row.profile,
    ...(row.transaction_id === null ? {} : { transactionId: row.transaction_id }),
    ...(row.commitment_id === null ? {} : { commitmentId: row.commitment_id }),
    outpoint: row.outpoint ?? undefined,
    actualAmountAtomic: row.actual_amount_atomic,
    actualAdditionalCostAtomic: row.actual_additional_cost_atomic,
    asset: row.asset,
    payee: row.payee,
    network: row.network,
    settlementAssurance: row.settlement_assurance,
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
  const executionPlan = canonicalPurchaseExecutionPlan(input.executionPlan);
  assertDigest(input.executionPlanEvidenceDigest, "Purchase execution plan evidence digest");
  if (
    executionPlan.digest !== input.executionPlanEvidenceDigest ||
    executionPlan.requirementsDigest !== input.paymentRequirementsDigest ||
    executionPlan.maximumChargeAtomic !== input.terms.amountAtomic
  ) {
    throw new JournalInvariantError("Purchase execution plan does not match Checkout Terms");
  }
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
    profile: PURCHASE_RECEIPT_PROFILE,
    purchaseId,
    attempt,
    paymentIdentifier,
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

function validateReceiptInput(input: RecordReceiptInput): void {
  assertDigest(input.evidenceDigest, "Receipt evidence digest");
  assertSafeIdentity(input.profile, "Receipt profile", 200);
  if (input.issuer !== undefined) assertBoundedText(input.issuer, "Receipt issuer", 200);
  assertSafeIdentity(input.verifierId, "Receipt verifier identity", 200);
  assertDigest(input.checkoutDigest, "Receipt Checkout Terms digest");
  assertDigest(input.authorizationEvidenceDigest, "Receipt authorization evidence digest");
  assertDigest(input.settlementEvidenceDigest, "Receipt Settlement evidence digest");
  assertDigest(input.fulfilmentDigest, "Receipt Fulfilment digest");
  if (input.profile !== PURCHASE_RECEIPT_PROFILE) {
    throw new JournalInvariantError("canonical Receipt verification profile is unsupported");
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
  const allowlist = [...new Set(definition.allowlist)];
  for (const payee of allowlist) assertBoundedText(payee, "policy allowlist payee", 300);
  allowlist.sort();
  return {
    maxPerPaymentAtomic: definition.maxPerPaymentAtomic,
    maxPerHourAtomic: definition.maxPerHourAtomic,
    allowlist,
  };
}

function validatePolicyChangeJournalInput(input: CreatePolicyChangeJournalInput): void {
  assertPolicyChangeId(input.id);
  assertPolicyChangeRequestKey(input.requestKey);
  assertDigest(input.expectedPolicyDigest, "expected Policy Change policy digest");
  if (!Number.isSafeInteger(input.expectedPolicyGeneration) || input.expectedPolicyGeneration < 1) {
    throw new JournalInvariantError("expected Policy Change policy generation is invalid");
  }
  assertDigest(input.expectedVaultDigest, "expected Policy Change vault digest");
  const previousPerPayment = decimalBigInt(
    input.previousMaximumPerPaymentAtomic,
    "previous per-payment limit",
  );
  const previousPerHour = decimalBigInt(
    input.previousMaximumPerHourAtomic,
    "previous hourly limit",
  );
  const proposedPerPayment = decimalBigInt(
    input.proposedMaximumPerPaymentAtomic,
    "proposed per-payment limit",
  );
  const proposedPerHour = decimalBigInt(
    input.proposedMaximumPerHourAtomic,
    "proposed hourly limit",
  );
  const vaultMaximum = decimalBigInt(
    input.vaultMaximumOutflowAtomic,
    "vault maximum outflow",
  );
  if (previousPerPayment > previousPerHour || proposedPerPayment > proposedPerHour) {
    throw new PolicyReservationError("per-payment limit cannot exceed the hourly limit");
  }
  if (proposedPerPayment > vaultMaximum || proposedPerHour > vaultMaximum) {
    throw new PolicyReservationError(
      "everyday limits cannot exceed the current vault protection maximum"
    );
  }
  if (!Number.isSafeInteger(input.manifestRevision) || input.manifestRevision < 1) {
    throw new JournalInvariantError("Policy Change manifest revision is invalid");
  }
  assertDigest(input.manifestDigest, "Policy Change manifest digest");
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
    throw new JournalInvariantError("Policy Change expiry is invalid");
  }
}

function policyChangeIntentMatches(
  existing: PolicyChangeJournalRecord,
  input: CreatePolicyChangeJournalInput,
): boolean {
  return existing.id === input.id &&
    existing.expectedPolicyDigest === input.expectedPolicyDigest &&
    existing.expectedPolicyGeneration === input.expectedPolicyGeneration &&
    existing.expectedVaultDigest === input.expectedVaultDigest &&
    existing.previousMaximumPerPaymentAtomic === input.previousMaximumPerPaymentAtomic &&
    existing.previousMaximumPerHourAtomic === input.previousMaximumPerHourAtomic &&
    existing.proposedMaximumPerPaymentAtomic === input.proposedMaximumPerPaymentAtomic &&
    existing.proposedMaximumPerHourAtomic === input.proposedMaximumPerHourAtomic &&
    existing.vaultMaximumOutflowAtomic === input.vaultMaximumOutflowAtomic &&
    existing.manifestRevision === input.manifestRevision &&
    existing.manifestDigest === input.manifestDigest &&
    existing.expiresAtMs === input.expiresAtMs;
}

function validatePolicyDecision(
  decision: Readonly<{ authorityId: string; evidenceDigest: Sha256Digest; evidence: Uint8Array }>,
): void {
  assertSafeIdentity(decision.authorityId, "Policy Change authority identity", 200);
  assertDigest(decision.evidenceDigest, "Policy Change authority evidence digest");
  if (
    !(decision.evidence instanceof Uint8Array) ||
    decision.evidence.byteLength === 0 ||
    decision.evidence.byteLength > 128_000
  ) {
    throw new JournalInvariantError("Policy Change authority evidence is invalid");
  }
  if (evidenceDigest(decision.evidence) !== decision.evidenceDigest) {
    throw new JournalInvariantError("Policy Change authority evidence digest does not match its bytes");
  }
}

function assertPolicyChangeTransition(
  from: PolicyChangeJournalState,
  to: PolicyChangeJournalState,
): void {
  const allowed: Readonly<Record<PolicyChangeJournalState, readonly PolicyChangeJournalState[]>> = {
    created: ["awaiting_authority", "failed"],
    awaiting_authority: ["authorised", "denied", "expired", "failed"],
    authorised: ["applied", "failed"],
    applied: [],
    denied: [],
    expired: [],
    failed: [],
  };
  if (from !== to && !allowed[from].includes(to)) {
    throw new JournalInvariantError(`invalid Policy Change transition ${from} -> ${to}`);
  }
}

function assertPolicyChangeId(value: string): void {
  if (!/^pcg_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new JournalInvariantError("invalid Policy Change identity");
  }
}

function assertPolicyChangeRequestKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new JournalInvariantError("invalid Policy Change request key");
  }
}

function validateVaultMigrationInput(input: CreateVaultMigrationJournalInput): void {
  assertVaultMigrationId(input.id);
  assertPolicyChangeRequestKey(input.requestKey);
  assertDigest(input.oldVaultDigest, "old Vault Migration vault digest");
  assertDigest(input.expectedPolicyDigest, "Vault Migration policy digest");
  if (!Number.isSafeInteger(input.expectedPolicyGeneration) || input.expectedPolicyGeneration < 1) {
    throw new JournalInvariantError("Vault Migration policy generation is invalid");
  }
  decimalBigInt(input.oldMaximumOutflowAtomic, "old vault maximum");
  decimalBigInt(input.newMaximumOutflowAtomic, "new vault maximum");
  decimalBigInt(input.windowSizeDaa, "vault window size");
  decimalBigInt(input.windowStartDaa, "vault window start", true);
  decimalBigInt(input.spentInWindowAtomic, "vault spent in window", true);
  if (!/^kaspatest:[a-z0-9]+$/.test(input.stableReceiveAddress)) {
    throw new JournalInvariantError("Vault Migration receive address is invalid");
  }
  if (!Number.isSafeInteger(input.manifestRevision) || input.manifestRevision < 1) {
    throw new JournalInvariantError("Vault Migration manifest revision is invalid");
  }
  assertDigest(input.manifestDigest, "Vault Migration manifest digest");
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
    throw new JournalInvariantError("Vault Migration expiry is invalid");
  }
}

function vaultMigrationIntentMatches(existing: VaultMigrationJournalRecord, input: CreateVaultMigrationJournalInput): boolean {
  return existing.id === input.id &&
    existing.oldVaultDigest === input.oldVaultDigest &&
    existing.expectedPolicyDigest === input.expectedPolicyDigest &&
    existing.expectedPolicyGeneration === input.expectedPolicyGeneration &&
    existing.oldMaximumOutflowAtomic === input.oldMaximumOutflowAtomic &&
    existing.newMaximumOutflowAtomic === input.newMaximumOutflowAtomic &&
    existing.windowSizeDaa === input.windowSizeDaa &&
    existing.windowStartDaa === input.windowStartDaa &&
    existing.spentInWindowAtomic === input.spentInWindowAtomic &&
    existing.stableReceiveAddress === input.stableReceiveAddress &&
    existing.manifestRevision === input.manifestRevision &&
    existing.manifestDigest === input.manifestDigest &&
    existing.expiresAtMs === input.expiresAtMs;
}

function assertVaultMigrationTransition(from: VaultMigrationJournalState, to: VaultMigrationJournalState): void {
  const allowed: Readonly<Record<VaultMigrationJournalState, readonly VaultMigrationJournalState[]>> = {
    created: ["awaiting_authority", "failed"],
    awaiting_authority: ["awaiting_owner", "denied", "expired", "failed"],
    awaiting_owner: ["executing", "expired", "failed"],
    executing: ["applied", "reconciliation_required", "failed"],
    reconciliation_required: ["applied", "failed"],
    applied: [], denied: [], expired: [], failed: [],
  };
  if (from !== to && !allowed[from].includes(to)) {
    throw new JournalInvariantError(`invalid Vault Migration transition ${from} -> ${to}`);
  }
}

function assertVaultMigrationId(value: string): void {
  if (!/^vmg_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new JournalInvariantError("invalid Vault Migration identity");
  }
}

function validateTreasuryOperationPreflight(input: TreasuryOperationPreflight): void {
  if (!(["wallet_send", "vault_send", "vault_deposit", "batch_refund"] as const).includes(input.kind)) {
    throw new JournalInvariantError("direct Treasury operation kind is invalid");
  }
  assertBoundedText(input.destination, "direct Treasury destination", 300);
  decimalBigInt(
    input.amountAtomic,
    "direct Treasury amount",
    input.kind === "vault_deposit",
  );
  decimalBigInt(input.feeCeilingAtomic, "direct Treasury fee ceiling", true);
  assertDigest(input.policyDigest, "direct Treasury policy digest");
  if (typeof input.humanApprovalExpected !== "boolean") {
    throw new JournalInvariantError("direct Treasury approval expectation is invalid");
  }
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
  assertTransactionId(input.executionId);
  assertSafeIdentity(input.profile, "payment execution profile", 160);
  if (input.mechanism === "single-transaction") {
    if (input.transactionId === undefined || input.requiredAssurance === "channel-commitment") {
      throw new JournalInvariantError("single-transaction preparation has invalid execution facts");
    }
    assertTransactionId(input.transactionId);
    if (input.executionId !== input.transactionId) {
      throw new JournalInvariantError("single-transaction execution identity must equal its transaction identity");
    }
  } else if (input.mechanism === "channel-voucher") {
    if (input.transactionId !== undefined || input.requiredAssurance !== "channel-commitment") {
      throw new JournalInvariantError("channel-voucher preparation has invalid execution facts");
    }
  } else {
    throw new JournalInvariantError("payment execution mechanism is invalid");
  }
  decimalBigInt(input.amountAtomic, "prepared payment amount");
  assertSafeIdentity(input.asset, "prepared payment asset", 40);
  assertSafeIdentity(input.network, "prepared payment network", 100);
  assertBoundedText(input.payee, "prepared payment payee", 300);
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

function validatePurchaseSettlementInput(input: RecordPurchaseSettlementInput): void {
  assertCode(input.reservationId, "reservation id");
  assertTransactionId(input.executionId);
  assertSafeIdentity(input.profile, "Settlement execution profile", 160);
  if (input.mechanism === "single-transaction") {
    if (
      input.transactionId === undefined ||
      input.commitmentId !== undefined ||
      input.settlementAssurance === "channel-commitment"
    ) {
      throw new JournalInvariantError("single-transaction Settlement has invalid execution facts");
    }
    assertTransactionId(input.transactionId);
    if (input.executionId !== input.transactionId) {
      throw new JournalInvariantError("single-transaction Settlement identity is invalid");
    }
  } else if (input.mechanism === "channel-voucher") {
    if (
      input.transactionId !== undefined ||
      input.commitmentId === undefined ||
      input.settlementAssurance !== "channel-commitment"
    ) {
      throw new JournalInvariantError("channel-voucher Settlement has invalid execution facts");
    }
    assertTransactionId(input.commitmentId);
  } else {
    throw new JournalInvariantError("Settlement execution mechanism is invalid");
  }
  if (input.outpoint !== undefined) {
    if (input.transactionId === undefined) {
      throw new JournalInvariantError("channel-voucher Settlement cannot contain an outpoint");
    }
    assertSafeIdentity(input.outpoint, "Settlement outpoint", 200);
    if (!new RegExp(`^${input.transactionId}:[0-9]+$`).test(input.outpoint)) {
      throw new JournalInvariantError("Settlement outpoint must be bound to the canonical transaction identity");
    }
  }
  decimalBigInt(input.actualAmountAtomic, "actual Settlement amount");
  decimalBigInt(input.actualAdditionalCostAtomic, "actual additional treasury cost", true);
  assertSafeIdentity(input.asset, "Settlement asset", 40);
  assertBoundedText(input.payee, "Settlement payee", 300);
  assertSafeIdentity(input.network, "Settlement network", 100);
  assertVaultFundingSource(input.fundingSource);
  assertDigest(input.evidenceDigest, "Settlement evidence digest");
  assertSafeIdentity(input.evidenceVerificationProfile, "Settlement evidence verification profile", 200);
  assertSafeIdentity(input.evidenceVerifierId, "Settlement evidence verifier identity", 200);
}

function settlementAssuranceMeets(
  actual: PurchaseExecutionAssurance,
  required: PurchaseExecutionAssurance
): boolean {
  if (required === "channel-commitment" || actual === "channel-commitment") {
    return actual === required;
  }
  return paymentFinalityMeets(actual, required);
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

function assertSameExecutionPlan(
  existing: PurchaseExecutionPlanRecord,
  input: PurchaseExecutionPlan,
  evidenceDigestValue: Sha256Digest
): void {
  const candidate = canonicalPurchaseExecutionPlan(input);
  if (
    existing.digest !== candidate.digest ||
    existing.evidenceDigest !== evidenceDigestValue ||
    JSON.stringify({ ...existing, purchaseId: undefined, evidenceDigest: undefined, createdAtMs: undefined }) !==
      JSON.stringify({ ...candidate, purchaseId: undefined, evidenceDigest: undefined, createdAtMs: undefined })
  ) {
    throw new JournalInvariantError("immutable Purchase execution plan conflict");
  }
}

function assertSameAuthorizationRequest(
  existing: AuthorizationRequestRecord,
  input: RecordAuthorizationRequestInput,
  executionPlan: PurchaseExecutionPlanRecord
): void {
  if (
    existing.checkoutDigest !== input.checkoutDigest ||
    existing.requestDigest !== input.requestDigest ||
    existing.nonceDigest !== input.nonceDigest ||
    existing.requestMediaType !== input.requestMediaType ||
    existing.requestBodyDigest !== input.requestBodyDigest ||
    existing.additionalCostCeilingAtomic !== input.additionalCostCeilingAtomic ||
    existing.effectiveFinalityFloor !== input.effectiveFinalityFloor ||
    existing.executionPlanDigest !== executionPlan.digest ||
    existing.executionMechanism !== executionPlan.mechanism ||
    existing.executionProfile !== executionPlan.profile ||
    existing.settlementAssurance !== executionPlan.settlementAssurance ||
    existing.maximumAuthorizedChargeAtomic !== executionPlan.maximumChargeAtomic ||
    existing.channelId !== executionPlan.channelEpoch?.channelId ||
    existing.channelEpochDigest !== channelEpochDigest(executionPlan) ||
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
    existing.executionId !== input.executionId ||
    existing.mechanism !== input.mechanism ||
    existing.profile !== input.profile ||
    existing.transactionId !== input.transactionId ||
    existing.amountAtomic !== input.amountAtomic ||
    existing.asset !== input.asset ||
    existing.network !== input.network ||
    existing.payee !== input.payee ||
    existing.requiredAssurance !== input.requiredAssurance ||
    existing.fundingSource !== input.fundingSource
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

function assertSameSettlement(existing: PurchaseSettlementRecord, input: RecordPurchaseSettlementInput): void {
  if (
    existing.effectId !== input.effectId ||
    existing.reservationId !== input.reservationId ||
    existing.executionId !== input.executionId ||
    existing.mechanism !== input.mechanism ||
    existing.profile !== input.profile ||
    existing.transactionId !== input.transactionId ||
    existing.commitmentId !== input.commitmentId ||
    existing.outpoint !== input.outpoint ||
    existing.actualAmountAtomic !== input.actualAmountAtomic ||
    existing.actualAdditionalCostAtomic !== input.actualAdditionalCostAtomic ||
    existing.asset !== input.asset ||
    existing.payee !== input.payee ||
    existing.network !== input.network ||
    existing.settlementAssurance !== input.settlementAssurance ||
    existing.fundingSource !== input.fundingSource ||
    existing.evidenceDigest !== input.evidenceDigest ||
    existing.evidenceVerificationProfile !== input.evidenceVerificationProfile ||
    existing.evidenceVerifierId !== input.evidenceVerifierId
  ) {
    throw new JournalInvariantError(`conflicting Settlement finalization for Reservation ${input.reservationId}`);
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
    input.kind !== "vault_deposit" &&
    input.kind !== "batch_refund"
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
  if (input.authorizationEvidenceDigest !== undefined) {
    assertDigest(input.authorizationEvidenceDigest, "Transfer authorization evidence digest");
    if (input.kind !== "vault_send") {
      throw new JournalInvariantError(
        "human-present Transfer authorization applies only to vault sends"
      );
    }
  }
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
    existing.retryLimit !== input.retryLimit ||
    existing.authorizationEvidenceDigest !== input.authorizationEvidenceDigest
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

function driverOwns(
  operation: TreasuryOperationRecord,
  driver: TreasuryDriverLease,
  now: number,
): boolean {
  return operation.driverOwner === driver.owner &&
    operation.driverGeneration === driver.generation &&
    operation.driverLeaseExpiresAtMs !== undefined &&
    operation.driverLeaseExpiresAtMs > now;
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
      (to === "prepared" || to === "submitted" || to === "observed" || to === "failed_terminal")) ||
    (from === "submitted" && (to === "prepared" || to === "observed" || to === "failed_terminal")) ||
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
