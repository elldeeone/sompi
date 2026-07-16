import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import {
  BatchCommitmentRecord,
  ClaimAttemptRecord,
  ExactHeadLineageApply,
  ExactHeadRecord,
  ExactHeadSelectionRequest,
  ExactHeadUnavailableApply,
  ExactHeadUnavailableResult,
  ExactPaymentRecord,
  ExactSettlementAttemptRecord,
  ExactSettlementClaimResult,
  ExactSettlementCommit,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
  acceptExactHead,
  applyExactHeadLineage,
  claimExactHead,
  exactHeadMatchesSelection,
  exactSettlementAttemptsMatch,
  normalizeExactHeadRecord,
  normalizeExactSettlementAttempt,
  releaseExactHeadClaim,
} from "@kaspa-x402/server";
import { prepareSecureSqlitePath, validateSecureSqlitePath } from "./secure-sqlite-path.js";

const APPLICATION_ID = 0x53445845;
const SCHEMA_VERSION = 3;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const SOMPI_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const SCHEMA_SQL = `
CREATE TABLE merchant_server_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;

CREATE TABLE exact_heads (
  head_id TEXT PRIMARY KEY,
  current_txid TEXT NOT NULL,
  current_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE(current_txid, current_index)
) STRICT;

CREATE TABLE exact_settlement_attempts (
  transaction_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  head_id TEXT,
  record_json TEXT NOT NULL,
  FOREIGN KEY(head_id) REFERENCES exact_heads(head_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE exact_payments (
  transaction_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  payment_requirements_hash TEXT NOT NULL,
  payment_payload_hash TEXT NOT NULL,
  payment_output_index INTEGER NOT NULL CHECK (payment_output_index >= 0),
  record_json TEXT NOT NULL
) STRICT;

CREATE TABLE payment_identifiers (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  payment_payload_hash TEXT NOT NULL,
  payment_scope_id TEXT NOT NULL,
  transaction_id TEXT,
  payment_output_index INTEGER,
  record_json TEXT NOT NULL,
  CHECK (
    (transaction_id IS NULL AND payment_output_index IS NULL) OR
    (transaction_id IS NOT NULL AND payment_output_index IS NOT NULL)
  )
) STRICT;

CREATE TABLE batch_channels (
  channel_id TEXT PRIMARY KEY,
  active_txid TEXT NOT NULL,
  active_output_index INTEGER NOT NULL CHECK (active_output_index >= 0),
  status TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE TABLE batch_commitments (
  commitment_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES batch_channels(channel_id) ON DELETE RESTRICT,
  record_json TEXT NOT NULL
) STRICT;

CREATE TABLE batch_claim_attempts (
  attempt_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES batch_channels(channel_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'broadcast', 'accepted', 'applied')),
  transaction_id TEXT,
  record_json TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_open_batch_claim_attempt
  ON batch_claim_attempts(channel_id)
  WHERE status <> 'applied';
`;

const SCHEMA_CHECKSUM = digestText(SCHEMA_SQL);

interface JsonRow {
  record_json: string;
}

interface ExactHeadRow extends JsonRow {
  head_id: string;
  current_txid: string;
  current_index: number;
  status: string;
}

interface ExactAttemptRow extends JsonRow {
  transaction_id: string;
  status: string;
  head_id: string | null;
}

interface ExactPaymentRow extends JsonRow {
  transaction_id: string;
  request_fingerprint: string;
  payment_requirements_hash: string;
  payment_payload_hash: string;
  payment_output_index: number;
}

interface PaymentIdentifierRow extends JsonRow {
  id: string;
  fingerprint: string;
  payment_payload_hash: string;
  payment_scope_id: string;
  transaction_id: string | null;
  payment_output_index: number | null;
}

interface BatchChannelRow extends JsonRow {
  channel_id: string;
  active_txid: string;
  active_output_index: number;
  status: string;
}

interface BatchCommitmentRow extends JsonRow {
  commitment_id: string;
  channel_id: string;
}

interface BatchClaimAttemptRow extends JsonRow {
  attempt_id: string;
  channel_id: string;
  status: ClaimAttemptRecord["status"];
  transaction_id: string | null;
}

export class DemoMerchantStoreError extends Error {
  readonly code: "invalid_record" | "conflict" | "store_unavailable";

  constructor(
    code: DemoMerchantStoreError["code"] = "store_unavailable",
    options?: { cause?: unknown }
  ) {
    const messages = {
      invalid_record: "merchant server store record is invalid",
      conflict: "merchant server store write conflicts with durable state",
      store_unavailable: "merchant server store is unavailable",
    } as const;
    super(messages[code], options);
    this.name = "DemoMerchantStoreError";
    this.code = code;
  }
}

export interface SqliteMerchantServerStateStoreOptions {
  readonly busyTimeoutMs?: number;
}

/** Durable alpha.8 Merchant state for exact and batch-settlement. */
export class SqliteMerchantServerStateStore implements ServerStateStore {
  private readonly db: Database.Database;

  constructor(readonly filename: string, options: SqliteMerchantServerStateStoreOptions = {}) {
    let pathInfo;
    try {
      pathInfo = prepareSecureSqlitePath(filename, "merchant server store");
    } catch {
      throw new DemoMerchantStoreError("store_unavailable");
    }
    this.db = new Database(filename);
    try {
      this.configure(options.busyTimeoutMs ?? 5_000);
      validateSecureSqlitePath(pathInfo);
      this.initialize();
      this.verifyStartup();
    } catch (error) {
      if (this.db.open) this.db.close();
      if (error instanceof DemoMerchantStoreError) throw error;
      throw new DemoMerchantStoreError("store_unavailable");
    }
  }

  close(): void {
    if (!this.db.open) return;
    if (this.filename !== ":memory:") this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  exactPaymentCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM exact_payments").get() as {
      count: number;
    };
    if (!Number.isSafeInteger(row.count) || row.count < 0) {
      throw new DemoMerchantStoreError("store_unavailable");
    }
    return row.count;
  }

  async loadExactPayment(transactionId: string): Promise<ExactPaymentRecord | undefined> {
    requireHash(transactionId);
    return this.loadJson<ExactPaymentRecord>(
      "SELECT record_json FROM exact_payments WHERE transaction_id = ?",
      transactionId
    );
  }

  async loadPaymentIdentifier(id: string): Promise<PaymentIdentifierRecord | undefined> {
    requireIdentifier(id);
    return this.loadJson<PaymentIdentifierRecord>(
      "SELECT record_json FROM payment_identifiers WHERE id = ?",
      id
    );
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    validateExactCommit(record);
    const paymentJson = stableJson(record.payment);
    const identifierJson = record.paymentIdentifier
      ? stableJson(record.paymentIdentifier)
      : undefined;
    const commit = this.db.transaction(() => {
      const existingPayment = this.db
        .prepare("SELECT record_json FROM exact_payments WHERE transaction_id = ?")
        .get(record.payment.transactionId) as JsonRow | undefined;
      const existingIdentifier = record.paymentIdentifier
        ? (this.db
            .prepare("SELECT record_json FROM payment_identifiers WHERE id = ?")
            .get(record.paymentIdentifier.id) as JsonRow | undefined)
        : undefined;

      if (existingPayment) {
        if (existingPayment.record_json !== paymentJson) throw new DemoMerchantStoreError("conflict");
        if (
          (record.paymentIdentifier === undefined) !== (existingIdentifier === undefined) ||
          (identifierJson !== undefined && existingIdentifier?.record_json !== identifierJson)
        ) {
          throw new DemoMerchantStoreError("conflict");
        }
        return;
      }
      if (existingIdentifier) {
        throw new DemoMerchantStoreError("conflict");
      }

      const attempt = this.loadAttemptRow(record.payment.transactionId);
      if (
        !attempt ||
        attempt.status !== "accepted" ||
        !attempt.handlerStartedAt ||
        !attempt.handlerResult
      ) {
        throw new DemoMerchantStoreError("conflict");
      }

      this.db
        .prepare(
          `INSERT INTO exact_payments (
             transaction_id, request_fingerprint, payment_requirements_hash,
             payment_payload_hash, payment_output_index, record_json
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.payment.transactionId,
          record.payment.requestFingerprint,
          record.payment.paymentRequirementsHash,
          record.payment.paymentPayloadHash,
          record.payment.paymentOutputIndex,
          paymentJson
        );
      if (record.paymentIdentifier && identifierJson) {
        this.db
          .prepare(
            `INSERT INTO payment_identifiers (
               id, fingerprint, payment_payload_hash, payment_scope_id,
               transaction_id, payment_output_index, record_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            record.paymentIdentifier.id,
            record.paymentIdentifier.fingerprint,
            record.paymentIdentifier.paymentPayloadHash,
            record.paymentIdentifier.paymentScopeId,
            record.paymentIdentifier.transactionId ?? null,
            record.paymentIdentifier.paymentOutputIndex ?? null,
            identifierJson
          );
      }
      this.writeAttempt({
        ...attempt,
        status: "applied",
        updatedAt: new Date().toISOString(),
      });
    });
    this.runWrite(commit);
  }

  async registerExactHead(input: ExactHeadRecord): Promise<ExactHeadRecord> {
    const record = canonicalExactHeadRecord(input);
    const write = this.db.transaction(() => {
      const existing = this.loadHeadRow(record.headId);
      if (existing) {
        if (stableJson(existing) !== stableJson(record)) throw new DemoMerchantStoreError("conflict");
        return existing;
      }
      this.db.prepare(
        `INSERT INTO exact_heads (head_id, current_txid, current_index, status, record_json)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        record.headId,
        record.currentOutpoint.txid,
        record.currentOutpoint.index,
        record.status,
        stableJson(record)
      );
      return record;
    });
    try { return structuredClone(write.immediate()); } catch (error) {
      if (error instanceof DemoMerchantStoreError) throw error;
      throw new DemoMerchantStoreError("conflict");
    }
  }

  async loadExactHead(headId: string): Promise<ExactHeadRecord | undefined> {
    requireHash(headId);
    const record = this.loadHeadRow(headId);
    return record ? structuredClone(record) : undefined;
  }

  async listExactHeads(): Promise<ExactHeadRecord[]> {
    return (this.db.prepare("SELECT record_json FROM exact_heads ORDER BY head_id").all() as JsonRow[])
      .map((row) => parseJson<ExactHeadRecord>(row.record_json));
  }

  async selectExactHead(request: ExactHeadSelectionRequest): Promise<ExactHeadRecord | undefined> {
    const candidates = (await this.listExactHeads()).filter((head) =>
      exactHeadMatchesSelection(head, request)
    );
    if (candidates.length === 0) return undefined;
    const index = Number(BigInt(`0x${request.selectionKey}`) % BigInt(candidates.length));
    return structuredClone(candidates[index]!);
  }

  async claimExactSettlement(input: ExactSettlementAttemptRecord): Promise<ExactSettlementClaimResult> {
    const attempt = normalizeExactSettlementAttempt(input);
    const claim = this.db.transaction(() => {
      const existing = this.loadAttemptRow(attempt.transactionId);
      if (existing) {
        if (!exactSettlementAttemptsMatch(existing, attempt)) throw new DemoMerchantStoreError("conflict");
        return { attempt: existing, created: false };
      }
      if (attempt.profile === "additive") {
        if (!attempt.head) throw new DemoMerchantStoreError("invalid_record");
        const head = this.loadHeadRow(attempt.head.headId);
        if (!head) throw new DemoMerchantStoreError("conflict");
        this.writeHead(claimExactHead(head, attempt));
      } else if (attempt.head) {
        throw new DemoMerchantStoreError("invalid_record");
      }
      this.db.prepare(
        `INSERT INTO exact_settlement_attempts (transaction_id, status, head_id, record_json)
         VALUES (?, ?, ?, ?)`
      ).run(attempt.transactionId, attempt.status, attempt.head?.headId ?? null, stableJson(attempt));
      return { attempt, created: true };
    });
    try { return structuredClone(claim.immediate()); } catch (error) {
      if (error instanceof DemoMerchantStoreError) throw error;
      throw new DemoMerchantStoreError("conflict");
    }
  }

  async loadExactSettlementAttempt(transactionId: string): Promise<ExactSettlementAttemptRecord | undefined> {
    requireHash(transactionId);
    const attempt = this.loadAttemptRow(transactionId);
    return attempt ? structuredClone(attempt) : undefined;
  }

  async recordExactSettlementBroadcast(
    transactionId: string,
    finality: "broadcast" | "accepted" | "confirmed",
    observedAt: string
  ): Promise<void> {
    this.updateAttempt(transactionId, (attempt) =>
      attempt.status === "accepted" || attempt.status === "applied"
        ? attempt
        : { ...attempt, status: "broadcast", finality, updatedAt: observedAt }
    );
  }

  async acceptExactSettlement(
    transactionId: string,
    finality: "accepted" | "confirmed",
    observedAt: string
  ): Promise<void> {
    const accept = this.db.transaction(() => {
      const attempt = this.requireAttempt(transactionId);
      if (attempt.status === "applied") return;
      if (attempt.head) {
        const head = this.loadHeadRow(attempt.head.headId);
        if (!head) throw new DemoMerchantStoreError("conflict");
        this.writeHead(acceptExactHead(head, attempt, observedAt));
      }
      this.writeAttempt({ ...attempt, status: "accepted", finality, updatedAt: observedAt });
    });
    this.runWrite(accept);
  }

  async beginExactHandler(transactionId: string, startedAt: string): Promise<boolean> {
    let began = false;
    this.updateAttempt(transactionId, (attempt) => {
      if (attempt.status !== "accepted" || attempt.handlerStartedAt) return attempt;
      began = true;
      return { ...attempt, handlerStartedAt: startedAt, updatedAt: startedAt };
    });
    return began;
  }

  async recordExactHandlerResult(
    transactionId: string,
    result: ExactSettlementAttemptRecord["handlerResult"],
    completedAt: string
  ): Promise<void> {
    if (!result) throw new DemoMerchantStoreError("invalid_record");
    this.updateAttempt(transactionId, (attempt) => {
      if (attempt.status !== "accepted" || !attempt.handlerStartedAt) {
        throw new DemoMerchantStoreError("conflict");
      }
      if (attempt.handlerResult && stableJson(attempt.handlerResult) !== stableJson(result)) {
        throw new DemoMerchantStoreError("conflict");
      }
      const { recoveryReason: _recoveryReason, ...withoutRecoveryReason } = attempt;
      return {
        ...withoutRecoveryReason,
        handlerResult: structuredClone(result),
        handlerCompletedAt: completedAt,
        updatedAt: completedAt,
      };
    });
  }

  async markExactHandlerRecoveryRequired(
    transactionId: string,
    reason: string,
    observedAt: string
  ): Promise<void> {
    this.updateAttempt(transactionId, (attempt) => {
      if (attempt.status !== "accepted" || !attempt.handlerStartedAt || attempt.handlerResult) {
        throw new DemoMerchantStoreError("conflict");
      }
      return { ...attempt, recoveryReason: reason, updatedAt: observedAt };
    });
  }

  async abandonExactSettlement(transactionId: string, _reason: string, observedAt: string): Promise<void> {
    const abandon = this.db.transaction(() => {
      const attempt = this.requireAttempt(transactionId);
      if (attempt.status === "accepted" || attempt.status === "applied") {
        throw new DemoMerchantStoreError("conflict");
      }
      if (attempt.head) {
        const head = this.loadHeadRow(attempt.head.headId);
        if (head) this.writeHead(releaseExactHeadClaim(head, attempt, observedAt));
      }
      this.db.prepare("DELETE FROM exact_settlement_attempts WHERE transaction_id = ?")
        .run(attempt.transactionId);
    });
    this.runWrite(abandon);
  }

  async markExactHeadUnavailable(input: ExactHeadUnavailableApply): Promise<ExactHeadUnavailableResult> {
    const update = this.db.transaction(() => {
      const head = this.loadHeadRow(input.headId);
      if (!head) throw new DemoMerchantStoreError("conflict");
      const matches =
        head.version === input.expectedVersion &&
        head.currentOutpoint.txid === input.expectedOutpoint.txid &&
        head.currentOutpoint.index === input.expectedOutpoint.index &&
        head.currentAmount === input.expectedAmount &&
        head.status === input.expectedStatus;
      if (!matches) return { applied: false, head };
      const unavailable: ExactHeadRecord = {
        ...head,
        status: "unavailable",
        unavailableReason: input.reason,
        updatedAt: input.observedAt,
      };
      this.writeHead(unavailable);
      return { applied: true, head: unavailable };
    });
    try { return structuredClone(update.immediate()); } catch (error) {
      if (error instanceof DemoMerchantStoreError) throw error;
      throw new DemoMerchantStoreError("conflict");
    }
  }

  async applyExactHeadLineage(input: ExactHeadLineageApply): Promise<ExactHeadRecord> {
    const update = this.db.transaction(() => {
      const head = this.loadHeadRow(input.headId);
      if (!head) throw new DemoMerchantStoreError("conflict");
      const advanced = applyExactHeadLineage(head, input);
      this.writeHead(advanced);
      return advanced;
    });
    try { return structuredClone(update.immediate()); } catch (error) {
      if (error instanceof DemoMerchantStoreError) throw error;
      throw new DemoMerchantStoreError("conflict");
    }
  }

  async loadChannel(channelId: string): Promise<ServerChannelRecord | undefined> {
    requireHash(channelId);
    return this.loadJson<ServerChannelRecord>(
      "SELECT record_json FROM batch_channels WHERE channel_id = ?",
      channelId,
    );
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return (this.db.prepare("SELECT record_json FROM batch_channels ORDER BY channel_id").all() as JsonRow[])
      .map((row) => validateServerChannel(parseJson<ServerChannelRecord>(row.record_json)));
  }

  async loadCommitment(commitmentId: string): Promise<BatchCommitmentRecord | undefined> {
    requireHash(commitmentId);
    return this.loadJson<BatchCommitmentRecord>(
      "SELECT record_json FROM batch_commitments WHERE commitment_id = ?",
      commitmentId,
    );
  }

  async loadOpenClaimAttempt(channelId: string): Promise<ClaimAttemptRecord | undefined> {
    requireHash(channelId);
    return this.loadJson<ClaimAttemptRecord>(
      "SELECT record_json FROM batch_claim_attempts WHERE channel_id = ? AND status <> 'applied'",
      channelId,
    );
  }

  async saveChannel(input: ServerChannelRecord): Promise<void> {
    const channel = validateServerChannel(input);
    const save = this.db.transaction(() => {
      const existing = this.loadBatchChannelRow(channel.channelId);
      if (!existing) {
        this.db.prepare(
          `INSERT INTO batch_channels
             (channel_id, active_txid, active_output_index, status, record_json)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          channel.channelId,
          channel.activeOutpoint.txid,
          channel.activeOutpoint.index,
          channel.status,
          stableJson(channel),
        );
        return;
      }
      assertBatchChannelTransition(existing, channel);
      this.writeBatchChannel(channel);
    });
    this.runWrite(save);
  }

  async retireChannel(channelId: string, _reason?: string): Promise<void> {
    requireHash(channelId);
    const retire = this.db.transaction(() => {
      const current = this.requireBatchChannelRow(channelId);
      if (current.status === "retired") return;
      this.writeBatchChannel({ ...current, status: "retired" });
    });
    this.runWrite(retire);
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    const channel = validateServerChannel(record.channel);
    const commitment = validateBatchCommitment(record.commitment, channel);
    const identifier = record.paymentIdentifier
      ? validateBatchPaymentIdentifier(record.paymentIdentifier, commitment)
      : undefined;
    const commit = this.db.transaction(() => {
      const current = this.requireBatchChannelRow(record.expected.channelId);
      if (!matchesExpectedBatchChannel(current, record.expected)) {
        throw new DemoMerchantStoreError("conflict");
      }
      const existingCommitment = this.db.prepare(
        "SELECT record_json FROM batch_commitments WHERE commitment_id = ?",
      ).get(commitment.commitmentId) as JsonRow | undefined;
      const existingIdentifier = identifier
        ? this.db.prepare("SELECT record_json FROM payment_identifiers WHERE id = ?")
            .get(identifier.id) as JsonRow | undefined
        : undefined;
      if (existingCommitment) {
        if (
          existingCommitment.record_json !== stableJson(commitment) ||
          stableJson(current) !== stableJson(channel) ||
          (identifier === undefined) !== (existingIdentifier === undefined) ||
          (identifier && existingIdentifier?.record_json !== stableJson(identifier))
        ) throw new DemoMerchantStoreError("conflict");
        return;
      }
      if (existingIdentifier) throw new DemoMerchantStoreError("conflict");
      this.db.prepare(
        "INSERT INTO batch_commitments (commitment_id, channel_id, record_json) VALUES (?, ?, ?)",
      ).run(commitment.commitmentId, commitment.channelId, stableJson(commitment));
      if (identifier) this.insertPaymentIdentifier(identifier);
      this.writeBatchChannel(channel);
    });
    this.runWrite(commit);
  }

  async saveClaimAttempt(input: ClaimAttemptRecord): Promise<void> {
    const attempt = validateClaimAttempt(input);
    const save = this.db.transaction(() => {
      this.requireBatchChannelRow(attempt.channelId);
      const existing = this.db.prepare(
        "SELECT record_json FROM batch_claim_attempts WHERE attempt_id = ?",
      ).get(attempt.attemptId) as JsonRow | undefined;
      const open = this.db.prepare(
        "SELECT attempt_id, record_json FROM batch_claim_attempts WHERE channel_id = ? AND status <> 'applied'",
      ).get(attempt.channelId) as (JsonRow & { attempt_id: string }) | undefined;
      if (open && open.attempt_id !== attempt.attemptId) throw new DemoMerchantStoreError("conflict");
      if (!existing) {
        this.db.prepare(
          `INSERT INTO batch_claim_attempts
             (attempt_id, channel_id, status, transaction_id, record_json)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          attempt.attemptId,
          attempt.channelId,
          attempt.status,
          attempt.transactionId ?? null,
          stableJson(attempt),
        );
        return;
      }
      const previous = validateClaimAttempt(parseJson<ClaimAttemptRecord>(existing.record_json));
      assertClaimAttemptProgress(previous, attempt);
      this.writeClaimAttempt(attempt);
    });
    this.runWrite(save);
  }

  async applyClaimAttempt(
    input: ServerChannelRecord,
    attemptInput: ClaimAttemptRecord
  ): Promise<void> {
    const channel = validateServerChannel(input);
    const attempt = validateClaimAttempt(attemptInput);
    const apply = this.db.transaction(() => {
      const currentAttempt = this.requireClaimAttempt(attempt.attemptId);
      if (currentAttempt.status === "applied") {
        const currentChannel = this.requireBatchChannelRow(channel.channelId);
        if (stableJson(currentChannel) !== stableJson(channel)) throw new DemoMerchantStoreError("conflict");
        return;
      }
      if (attempt.status !== "accepted" || stableJson(currentAttempt) !== stableJson(attempt)) {
        throw new DemoMerchantStoreError("conflict");
      }
      const current = this.requireBatchChannelRow(channel.channelId);
      if (!claimAttemptMatchesChannelSnapshot(current, attempt)) {
        throw new DemoMerchantStoreError("conflict");
      }
      this.writeBatchChannel(channel);
      this.writeClaimAttempt({ ...attempt, status: "applied" });
    });
    this.runWrite(apply);
  }

  async abandonClaimAttempt(attemptId: string, _reason?: string): Promise<void> {
    requireHash(attemptId);
    const abandon = this.db.transaction(() => {
      const current = this.db.prepare(
        "SELECT status FROM batch_claim_attempts WHERE attempt_id = ?",
      ).get(attemptId) as { status: string } | undefined;
      if (!current || current.status === "applied") return;
      this.db.prepare("DELETE FROM batch_claim_attempts WHERE attempt_id = ?").run(attemptId);
    });
    this.runWrite(abandon);
  }

  private loadBatchChannelRow(channelId: string): ServerChannelRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM batch_channels WHERE channel_id = ?")
      .get(channelId) as JsonRow | undefined;
    return row ? validateServerChannel(parseJson<ServerChannelRecord>(row.record_json)) : undefined;
  }

  private requireBatchChannelRow(channelId: string): ServerChannelRecord {
    const channel = this.loadBatchChannelRow(channelId);
    if (!channel) throw new DemoMerchantStoreError("conflict");
    return channel;
  }

  private writeBatchChannel(input: ServerChannelRecord): void {
    const channel = validateServerChannel(input);
    const updated = this.db.prepare(
      `UPDATE batch_channels SET active_txid = ?, active_output_index = ?, status = ?, record_json = ?
        WHERE channel_id = ?`,
    ).run(
      channel.activeOutpoint.txid,
      channel.activeOutpoint.index,
      channel.status,
      stableJson(channel),
      channel.channelId,
    );
    if (updated.changes !== 1) throw new DemoMerchantStoreError("conflict");
  }

  private requireClaimAttempt(attemptId: string): ClaimAttemptRecord {
    const row = this.db.prepare("SELECT record_json FROM batch_claim_attempts WHERE attempt_id = ?")
      .get(attemptId) as JsonRow | undefined;
    if (!row) throw new DemoMerchantStoreError("conflict");
    return validateClaimAttempt(parseJson<ClaimAttemptRecord>(row.record_json));
  }

  private writeClaimAttempt(input: ClaimAttemptRecord): void {
    const attempt = validateClaimAttempt(input);
    const updated = this.db.prepare(
      `UPDATE batch_claim_attempts SET status = ?, transaction_id = ?, record_json = ?
        WHERE attempt_id = ?`,
    ).run(
      attempt.status,
      attempt.transactionId ?? null,
      stableJson(attempt),
      attempt.attemptId,
    );
    if (updated.changes !== 1) throw new DemoMerchantStoreError("conflict");
  }

  private insertPaymentIdentifier(record: PaymentIdentifierRecord): void {
    this.db.prepare(
      `INSERT INTO payment_identifiers (
         id, fingerprint, payment_payload_hash, payment_scope_id,
         transaction_id, payment_output_index, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.fingerprint,
      record.paymentPayloadHash,
      record.paymentScopeId,
      record.transactionId ?? null,
      record.paymentOutputIndex ?? null,
      stableJson(record),
    );
  }

  private loadHeadRow(headId: string): ExactHeadRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM exact_heads WHERE head_id = ?")
      .get(headId.toLowerCase()) as JsonRow | undefined;
    return row ? canonicalExactHeadRecord(parseJson<ExactHeadRecord>(row.record_json)) : undefined;
  }

  private loadAttemptRow(transactionId: string): ExactSettlementAttemptRecord | undefined {
    const row = this.db.prepare(
      "SELECT record_json FROM exact_settlement_attempts WHERE transaction_id = ?"
    ).get(transactionId.toLowerCase()) as JsonRow | undefined;
    return row
      ? validateStoredExactAttempt(parseJson<ExactSettlementAttemptRecord>(row.record_json))
      : undefined;
  }

  private requireAttempt(transactionId: string): ExactSettlementAttemptRecord {
    requireHash(transactionId);
    const attempt = this.loadAttemptRow(transactionId);
    if (!attempt) throw new DemoMerchantStoreError("conflict");
    return attempt;
  }

  private writeHead(record: ExactHeadRecord): void {
    const normalized = canonicalExactHeadRecord(record);
    const updated = this.db.prepare(
      `UPDATE exact_heads
          SET current_txid = ?, current_index = ?, status = ?, record_json = ?
        WHERE head_id = ?`
    ).run(
      normalized.currentOutpoint.txid,
      normalized.currentOutpoint.index,
      normalized.status,
      stableJson(normalized),
      normalized.headId
    );
    if (updated.changes !== 1) throw new DemoMerchantStoreError("conflict");
  }

  private writeAttempt(record: ExactSettlementAttemptRecord): void {
    const normalized = validateStoredExactAttempt(record);
    const updated = this.db.prepare(
      `UPDATE exact_settlement_attempts
          SET status = ?, head_id = ?, record_json = ?
        WHERE transaction_id = ?`
    ).run(
      normalized.status,
      normalized.head?.headId ?? null,
      stableJson(normalized),
      normalized.transactionId
    );
    if (updated.changes !== 1) throw new DemoMerchantStoreError("conflict");
  }

  private updateAttempt(
    transactionId: string,
    transform: (attempt: ExactSettlementAttemptRecord) => ExactSettlementAttemptRecord
  ): void {
    const update = this.db.transaction(() => {
      const current = this.requireAttempt(transactionId);
      this.writeAttempt(transform(current));
    });
    this.runWrite(update);
  }

  integrityCheck(): true {
    const integrity = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const foreignKeys = this.db.pragma("foreign_key_check") as unknown[];
    if (
      integrity.length !== 1 ||
      integrity[0].integrity_check !== "ok" ||
      foreignKeys.length !== 0
    ) {
      throw new DemoMerchantStoreError("store_unavailable");
    }
    return true;
  }

  private loadJson<T>(sql: string, key: string): T | undefined {
    try {
      const row = this.db.prepare(sql).get(key) as JsonRow | undefined;
      return row ? parseJson<T>(row.record_json) : undefined;
    } catch (error) {
      if (error instanceof DemoMerchantStoreError) throw error;
      throw new DemoMerchantStoreError("store_unavailable");
    }
  }

  private runWrite(transaction: Database.Transaction<() => void>): void {
    try {
      transaction.immediate();
    } catch (error) {
      if (error instanceof DemoMerchantStoreError) throw error;
      throw new DemoMerchantStoreError("store_unavailable", { cause: error });
    }
  }

  private configure(busyTimeoutMs: number): void {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new DemoMerchantStoreError("invalid_record");
    }
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("trusted_schema = OFF");
    this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (this.filename !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
  }

  private initialize(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const applicationId = this.db.pragma("application_id", { simple: true }) as number;
    if (version === SCHEMA_VERSION && applicationId === APPLICATION_ID) return;
    if (version !== 0 || applicationId !== 0) throw new DemoMerchantStoreError("store_unavailable");
    const objects = this.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get() as { count: number };
    if (objects.count !== 0) throw new DemoMerchantStoreError("store_unavailable");
    const initialize = this.db.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare("INSERT INTO merchant_server_store_meta (singleton, schema_checksum) VALUES (1, ?)")
        .run(SCHEMA_CHECKSUM);
      this.db.pragma(`application_id = ${APPLICATION_ID}`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();
  }

  private verifyStartup(): void {
    const meta = this.db
      .prepare("SELECT schema_checksum FROM merchant_server_store_meta WHERE singleton = 1")
      .get() as { schema_checksum: string } | undefined;
    if (
      (this.db.pragma("application_id", { simple: true }) as number) !== APPLICATION_ID ||
      (this.db.pragma("user_version", { simple: true }) as number) !== SCHEMA_VERSION ||
      meta?.schema_checksum !== SCHEMA_CHECKSUM ||
      schemaFingerprint(this.db) !== expectedSchemaFingerprint()
    ) {
      throw new DemoMerchantStoreError("store_unavailable");
    }
    this.integrityCheck();
    this.verifySemanticConsistency();
  }

  private verifySemanticConsistency(): void {
    const heads = this.db.prepare("SELECT * FROM exact_heads").all() as ExactHeadRow[];
    for (const row of heads) {
      const record = canonicalExactHeadRecord(parseJson<ExactHeadRecord>(row.record_json));
      if (
        record.headId !== row.head_id ||
        record.currentOutpoint.txid !== row.current_txid ||
        record.currentOutpoint.index !== row.current_index ||
        record.status !== row.status
      ) throw new DemoMerchantStoreError("store_unavailable");
    }

    const attempts = this.db.prepare("SELECT * FROM exact_settlement_attempts").all() as ExactAttemptRow[];
    for (const row of attempts) {
      const record = validateStoredExactAttempt(
        parseJson<ExactSettlementAttemptRecord>(row.record_json)
      );
      if (
        record.transactionId !== row.transaction_id ||
        record.status !== row.status ||
        (record.head?.headId ?? null) !== row.head_id
      ) throw new DemoMerchantStoreError("store_unavailable");
    }

    const payments = this.db.prepare("SELECT * FROM exact_payments").all() as ExactPaymentRow[];
    const paymentByTransaction = new Map<string, ExactPaymentRecord>();
    for (const row of payments) {
      const record = parseJson<ExactPaymentRecord>(row.record_json);
      validateExactPaymentRecord(record);
      if (
        record.transactionId !== row.transaction_id ||
        record.requestFingerprint !== row.request_fingerprint ||
        record.paymentRequirementsHash !== row.payment_requirements_hash ||
        record.paymentPayloadHash !== row.payment_payload_hash ||
        record.paymentOutputIndex !== row.payment_output_index
      ) {
        throw new DemoMerchantStoreError("store_unavailable");
      }
      paymentByTransaction.set(record.transactionId, record);
    }

    const channels = this.db.prepare("SELECT * FROM batch_channels").all() as BatchChannelRow[];
    const channelById = new Map<string, ServerChannelRecord>();
    for (const row of channels) {
      const record = validateServerChannel(parseJson<ServerChannelRecord>(row.record_json));
      if (
        record.channelId !== row.channel_id ||
        record.activeOutpoint.txid !== row.active_txid ||
        record.activeOutpoint.index !== row.active_output_index ||
        record.status !== row.status
      ) throw new DemoMerchantStoreError("store_unavailable");
      channelById.set(record.channelId, record);
    }
    const commitments = this.db.prepare("SELECT * FROM batch_commitments").all() as BatchCommitmentRow[];
    const commitmentByChannel = new Map<string, BatchCommitmentRecord[]>();
    for (const row of commitments) {
      const channel = channelById.get(row.channel_id);
      if (!channel) throw new DemoMerchantStoreError("store_unavailable");
      const record = validateBatchCommitment(
        parseJson<BatchCommitmentRecord>(row.record_json),
        undefined,
      );
      if (record.commitmentId !== row.commitment_id || record.channelId !== row.channel_id) {
        throw new DemoMerchantStoreError("store_unavailable");
      }
      commitmentByChannel.set(record.channelId, [
        ...(commitmentByChannel.get(record.channelId) ?? []),
        record,
      ]);
    }
    const claimAttempts = this.db.prepare("SELECT * FROM batch_claim_attempts").all() as BatchClaimAttemptRow[];
    for (const row of claimAttempts) {
      if (!channelById.has(row.channel_id)) throw new DemoMerchantStoreError("store_unavailable");
      const record = validateClaimAttempt(parseJson<ClaimAttemptRecord>(row.record_json));
      if (
        record.attemptId !== row.attempt_id || record.channelId !== row.channel_id ||
        record.status !== row.status || (record.transactionId ?? null) !== row.transaction_id
      ) throw new DemoMerchantStoreError("store_unavailable");
    }

    const identifiers = this.db
      .prepare("SELECT * FROM payment_identifiers")
      .all() as PaymentIdentifierRow[];
    for (const row of identifiers) {
      const record = parseJson<PaymentIdentifierRecord>(row.record_json);
      if (record.transactionId) {
        const payment = paymentByTransaction.get(record.transactionId);
        if (!payment) throw new DemoMerchantStoreError("store_unavailable");
        validateExactPaymentIdentifier(record, payment);
      } else {
        const candidates = commitmentByChannel.get(record.channelId ?? "") ?? [];
        if (
          candidates.length === 0 ||
          !candidates.some((commitment) =>
            commitment.requestFingerprint === record.fingerprint &&
            stableJson(commitment.settlement) === stableJson(record.settlement)
          )
        ) throw new DemoMerchantStoreError("store_unavailable");
        validateBatchPaymentIdentifier(record, candidates.find((commitment) =>
          commitment.requestFingerprint === record.fingerprint &&
          stableJson(commitment.settlement) === stableJson(record.settlement)
        )!);
      }
      if (
        record.id !== row.id ||
        record.fingerprint !== row.fingerprint ||
        record.paymentPayloadHash !== row.payment_payload_hash ||
        record.paymentScopeId !== row.payment_scope_id ||
        (record.transactionId ?? null) !== row.transaction_id ||
        (record.paymentOutputIndex ?? null) !== row.payment_output_index
      ) {
        throw new DemoMerchantStoreError("store_unavailable");
      }
    }
  }
}

function validateStoredExactAttempt(
  record: ExactSettlementAttemptRecord
): ExactSettlementAttemptRecord {
  requireHash(record.transactionId);
  requireHash(record.requestFingerprint);
  requireHash(record.paymentRequirementsHash);
  requireHash(record.paymentPayloadHash);
  requireHash(record.requestAuthorizationId);
  requireSompi(record.amount, false);
  if (
    (record.profile !== "standard-native" && record.profile !== "additive") ||
    record.paymentOutputIndex !== 0 ||
    typeof record.transaction !== "string" ||
    record.transaction.length === 0 ||
    !/^(?:[0-9a-f]{2})+$/i.test(record.payToScriptPublicKey) ||
    (record.requiredFinality !== "accepted" && record.requiredFinality !== "confirmed") ||
    !["pending", "broadcast", "accepted", "applied"].includes(record.status) ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    Number.isNaN(Date.parse(record.updatedAt))
  ) {
    throw new DemoMerchantStoreError("invalid_record");
  }
  if (
    (record.status === "pending" && record.finality !== undefined) ||
    (record.status === "broadcast" && record.finality === undefined) ||
    ((record.status === "accepted" || record.status === "applied") &&
      record.finality !== "accepted" && record.finality !== "confirmed") ||
    (record.handlerResult === undefined) !== (record.handlerCompletedAt === undefined) ||
    (record.recoveryReason !== undefined &&
      (record.handlerStartedAt === undefined || record.handlerResult !== undefined))
  ) {
    throw new DemoMerchantStoreError("invalid_record");
  }
  return structuredClone(record);
}

function canonicalExactHeadRecord(input: ExactHeadRecord): ExactHeadRecord {
  const normalized = normalizeExactHeadRecord(input);
  const {
    claimTransactionId,
    lastTransactionId,
    unavailableReason,
    ...required
  } = normalized;
  return {
    ...required,
    ...(claimTransactionId === undefined ? {} : { claimTransactionId }),
    ...(lastTransactionId === undefined ? {} : { lastTransactionId }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

function validateExactCommit(record: ExactSettlementCommit): void {
  if (!record || !record.payment) throw new DemoMerchantStoreError("invalid_record");
  validateExactPaymentRecord(record.payment);
  if (record.paymentIdentifier) {
    validateExactPaymentIdentifier(record.paymentIdentifier, record.payment);
  }
}

function validateExactPaymentRecord(payment: ExactPaymentRecord): void {
  requireHash(payment.transactionId);
  requireHash(payment.requestFingerprint);
  requireHash(payment.paymentRequirementsHash);
  requireHash(payment.paymentPayloadHash);
  requireHash(payment.requestAuthorizationId);
  if (payment.profile !== "standard-native" && payment.profile !== "additive") {
    throw new DemoMerchantStoreError("invalid_record");
  }
  requireOutputIndex(payment.paymentOutputIndex);
  requireSompi(payment.amount, false);
  if (!['mempool', 'accepted', 'confirmed'].includes(payment.finality)) {
    throw new DemoMerchantStoreError("invalid_record");
  }
  stableJson(payment);
}

function validateServerChannel(input: ServerChannelRecord): ServerChannelRecord {
  if (!input || typeof input !== "object") throw new DemoMerchantStoreError("invalid_record");
  requireHash(input.channelId);
  requireHash(input.channelConfig?.clientPublicKey);
  requireHash(input.channelConfig?.serverPublicKey);
  requireHash(input.channelConfig?.salt);
  requireHash(input.activeOutpoint?.txid);
  requireOutputIndex(input.activeOutpoint?.index);
  requireSompi(input.fundingAmount, false);
  requireSompi(input.chargedCumulativeAmount, true);
  requireSompi(input.claimedCumulativeAmount, true);
  requireSompi(input.signedMaxClaimable, true);
  if (
    input.channelConfig.network !== "kaspa:testnet-10" ||
    input.channelConfig.asset !== "KAS" ||
    input.channelConfig.templateId !== "kaspa-x402-escrow-v1" ||
    typeof input.escrowAddress !== "string" || input.escrowAddress.length > 256 ||
    typeof input.channelConfig.payTo !== "string" || input.channelConfig.payTo.length > 256 ||
    typeof input.channelConfig.refundAddress !== "string" || input.channelConfig.refundAddress.length > 256 ||
    !SOMPI_PATTERN.test(input.channelConfig.refundTimeoutDaa) ||
    !/^(?:[a-f0-9]{2})+$/.test(input.activeScriptPublicKey) ||
    !["active", "suspicious", "refunded", "retired"].includes(input.status)
  ) throw new DemoMerchantStoreError("invalid_record");
  const funding = BigInt(input.fundingAmount);
  const charged = BigInt(input.chargedCumulativeAmount);
  const claimed = BigInt(input.claimedCumulativeAmount);
  const signed = BigInt(input.signedMaxClaimable);
  if (claimed > charged || charged - claimed > signed || signed > funding) {
    throw new DemoMerchantStoreError("invalid_record");
  }
  if ((input.voucherSignature === undefined) !== (signed === 0n)) {
    throw new DemoMerchantStoreError("invalid_record");
  }
  if (input.voucherSignature !== undefined && !/^[a-f0-9]{128}$/.test(input.voucherSignature)) {
    throw new DemoMerchantStoreError("invalid_record");
  }
  const normalized: ServerChannelRecord = {
    channelId: input.channelId,
    channelConfig: input.channelConfig,
    escrowAddress: input.escrowAddress,
    activeOutpoint: input.activeOutpoint,
    activeScriptPublicKey: input.activeScriptPublicKey,
    fundingAmount: input.fundingAmount,
    chargedCumulativeAmount: input.chargedCumulativeAmount,
    claimedCumulativeAmount: input.claimedCumulativeAmount,
    signedMaxClaimable: input.signedMaxClaimable,
    ...(input.voucherSignature !== undefined ? { voucherSignature: input.voucherSignature } : {}),
    ...(input.lastCommitmentId !== undefined ? { lastCommitmentId: input.lastCommitmentId } : {}),
    status: input.status,
  };
  stableJson(normalized);
  return structuredClone(normalized);
}

function assertBatchChannelTransition(previous: ServerChannelRecord, next: ServerChannelRecord): void {
  if (
    previous.channelId !== next.channelId ||
    stableJson(previous.channelConfig) !== stableJson(next.channelConfig) ||
    previous.escrowAddress !== next.escrowAddress ||
    BigInt(next.chargedCumulativeAmount) < BigInt(previous.chargedCumulativeAmount) ||
    BigInt(next.claimedCumulativeAmount) < BigInt(previous.claimedCumulativeAmount) ||
    (previous.status === "retired" && next.status !== "retired") ||
    (previous.status === "refunded" && next.status !== "refunded")
  ) throw new DemoMerchantStoreError("conflict");
}

function validateBatchCommitment(
  input: BatchCommitmentRecord,
  channel: ServerChannelRecord | undefined,
): BatchCommitmentRecord {
  if (!input || typeof input !== "object") throw new DemoMerchantStoreError("invalid_record");
  requireHash(input.commitmentId);
  requireHash(input.channelId);
  requireHash(input.requestFingerprint);
  requireHash(input.paymentRequirementsHash);
  requireHash(input.activeOutpoint?.txid);
  requireOutputIndex(input.activeOutpoint?.index);
  requireSompi(input.chargedAmount, false);
  requireSompi(input.chargedCumulativeBefore, true);
  requireSompi(input.chargedCumulativeAfter, false);
  requireSompi(input.claimedCumulativeAmount, true);
  if (
    !/^(?:[a-f0-9]{2})+$/.test(input.activeScriptPublicKey) ||
    BigInt(input.chargedCumulativeAfter) !==
      BigInt(input.chargedCumulativeBefore) + BigInt(input.chargedAmount) ||
    input.settlement.success !== true ||
    input.settlement.network !== "kaspa:testnet-10" ||
    input.settlement.amount !== input.chargedAmount ||
    (channel && (
      channel.channelId !== input.channelId ||
      channel.chargedCumulativeAmount !== input.chargedCumulativeAfter ||
      channel.claimedCumulativeAmount !== input.claimedCumulativeAmount
    ))
  ) throw new DemoMerchantStoreError("invalid_record");
  stableJson(input);
  return structuredClone(input);
}

function validateBatchPaymentIdentifier(
  input: PaymentIdentifierRecord,
  commitment: BatchCommitmentRecord,
): PaymentIdentifierRecord {
  requireIdentifier(input.id);
  requireHash(input.fingerprint);
  requireHash(input.paymentPayloadHash);
  requireHash(input.paymentScopeId);
  if (
    input.transactionId !== undefined || input.paymentOutputIndex !== undefined ||
    input.channelId !== commitment.channelId ||
    input.paymentScopeId !== commitment.channelId ||
    input.fingerprint !== commitment.requestFingerprint ||
    stableJson(input.settlement) !== stableJson(commitment.settlement) ||
    stableJson(input.response) !== stableJson(commitment.response)
  ) throw new DemoMerchantStoreError("invalid_record");
  return structuredClone(input);
}

function matchesExpectedBatchChannel(
  current: ServerChannelRecord,
  expected: SettlementCommit["expected"],
): boolean {
  return (
    current.channelId === expected.channelId &&
    current.chargedCumulativeAmount === expected.chargedCumulativeAmount &&
    current.claimedCumulativeAmount === expected.claimedCumulativeAmount &&
    current.signedMaxClaimable === expected.signedMaxClaimable &&
    current.activeOutpoint.txid === expected.activeOutpoint.txid &&
    current.activeOutpoint.index === expected.activeOutpoint.index &&
    current.activeScriptPublicKey === expected.activeScriptPublicKey &&
    current.status === expected.status
  );
}

function validateClaimAttempt(input: ClaimAttemptRecord): ClaimAttemptRecord {
  if (!input || typeof input !== "object") throw new DemoMerchantStoreError("invalid_record");
  requireHash(input.attemptId);
  requireHash(input.channelId);
  requireHash(input.activeOutpoint?.txid);
  requireOutputIndex(input.activeOutpoint?.index);
  requireSompi(input.fundingAmount, false);
  requireSompi(input.claimAmount, false);
  requireSompi(input.chargedCumulativeAmount, true);
  requireSompi(input.claimedCumulativeAmount, true);
  requireSompi(input.signedMaxClaimable, true);
  if (
    !/^(?:[a-f0-9]{2})+$/.test(input.activeScriptPublicKey) ||
    input.channelStatus !== "active" ||
    typeof input.transaction !== "string" || input.transaction.length === 0 ||
    !["pending", "broadcast", "accepted", "applied"].includes(input.status) ||
    (input.status === "pending") !== (input.transactionId === undefined) ||
    (input.transactionId !== undefined && !HASH_PATTERN.test(input.transactionId)) ||
    ((input.status === "accepted" || input.status === "applied") &&
      (!input.continuationOutpoint || !input.continuationScriptPublicKey || !input.continuationFundingAmount))
  ) throw new DemoMerchantStoreError("invalid_record");
  if (input.continuationOutpoint) {
    requireHash(input.continuationOutpoint.txid);
    requireOutputIndex(input.continuationOutpoint.index);
    requireSompi(input.continuationFundingAmount!, false);
    if (!/^(?:[a-f0-9]{2})+$/.test(input.continuationScriptPublicKey!)) {
      throw new DemoMerchantStoreError("invalid_record");
    }
  }
  stableJson(input);
  return structuredClone(input);
}

function assertClaimAttemptProgress(previous: ClaimAttemptRecord, next: ClaimAttemptRecord): void {
  const mutable = (value: ClaimAttemptRecord) => {
    const {
      status: _status,
      transactionId: _transactionId,
      finality: _finality,
      ...identity
    } = value;
    return identity;
  };
  const order = { pending: 0, broadcast: 1, accepted: 2, applied: 3 } as const;
  if (
    stableJson(mutable(previous)) !== stableJson(mutable(next)) ||
    order[next.status] < order[previous.status] ||
    (previous.transactionId !== undefined && previous.transactionId !== next.transactionId)
  ) throw new DemoMerchantStoreError("conflict");
}

function claimAttemptMatchesChannelSnapshot(
  channel: ServerChannelRecord,
  attempt: ClaimAttemptRecord,
): boolean {
  return (
    channel.channelId === attempt.channelId &&
    channel.activeOutpoint.txid === attempt.activeOutpoint.txid &&
    channel.activeOutpoint.index === attempt.activeOutpoint.index &&
    channel.activeScriptPublicKey === attempt.activeScriptPublicKey &&
    channel.fundingAmount === attempt.fundingAmount &&
    channel.chargedCumulativeAmount === attempt.chargedCumulativeAmount &&
    channel.claimedCumulativeAmount === attempt.claimedCumulativeAmount &&
    channel.signedMaxClaimable === attempt.signedMaxClaimable &&
    channel.voucherSignature === attempt.voucherSignature &&
    channel.status === attempt.channelStatus
  );
}

function validateExactPaymentIdentifier(
  identifier: PaymentIdentifierRecord,
  payment: ExactPaymentRecord
): void {
  requireIdentifier(identifier.id);
  requireHash(identifier.fingerprint);
  requireHash(identifier.paymentPayloadHash);
  requireHash(identifier.paymentScopeId);
  if (
    identifier.fingerprint !== payment.requestFingerprint ||
    identifier.paymentPayloadHash !== payment.paymentPayloadHash ||
    identifier.transactionId !== payment.transactionId ||
    identifier.paymentOutputIndex !== payment.paymentOutputIndex ||
    stableJson(identifier.response) !== stableJson(payment.response) ||
    stableJson(identifier.settlement) !== stableJson(payment.settlement)
  ) {
    throw new DemoMerchantStoreError("invalid_record");
  }
  stableJson(identifier);
}

function requireHash(value: string): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new DemoMerchantStoreError("invalid_record");
  }
}

function requireIdentifier(value: string): void {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new DemoMerchantStoreError("invalid_record");
  }
}

function requireOutputIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new DemoMerchantStoreError("invalid_record");
  }
}

function requireSompi(value: string, allowZero: boolean): void {
  if (
    typeof value !== "string" ||
    !SOMPI_PATTERN.test(value) ||
    (!allowZero && value === "0") ||
    BigInt(value) > 0xffff_ffff_ffff_ffffn
  ) {
    throw new DemoMerchantStoreError("invalid_record");
  }
}

function stableJson(value: unknown): string {
  return stableSerialize(value, new Set<object>());
}

function stableSerialize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DemoMerchantStoreError("invalid_record");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new DemoMerchantStoreError("invalid_record");
  if (ancestors.has(value)) throw new DemoMerchantStoreError("invalid_record");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableSerialize(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DemoMerchantStoreError("invalid_record");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) {
      throw new DemoMerchantStoreError("invalid_record");
    }
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function parseJson<T>(value: string): T {
  try {
    const parsed = JSON.parse(value) as T;
    if (stableJson(parsed) !== value) throw new Error("non-canonical record");
    return parsed;
  } catch (error) {
    if (error instanceof DemoMerchantStoreError) throw error;
    throw new DemoMerchantStoreError("store_unavailable");
  }
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function schemaFingerprint(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all();
  return digestText(JSON.stringify(rows));
}

function expectedSchemaFingerprint(): string {
  const expected = new Database(":memory:");
  try {
    expected.exec(SCHEMA_SQL);
    return schemaFingerprint(expected);
  } finally {
    expected.close();
  }
}
