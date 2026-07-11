import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import type {
  BatchCommitmentRecord,
  ClaimAttemptRecord,
  ExactPaymentRecord,
  ExactReservationRecord,
  ExactSettlementCommit,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
} from "@kaspa-x402/server";
import { prepareSecureSqlitePath, validateSecureSqlitePath } from "./secure-sqlite-path.js";

const APPLICATION_ID = 0x53445845;
const SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const SOMPI_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const SCHEMA_SQL = `
CREATE TABLE demo_exact_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;

CREATE TABLE exact_reservations (
  reservation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed')),
  transaction_id TEXT,
  record_json TEXT NOT NULL,
  CHECK (
    (status = 'reserved' AND transaction_id IS NULL) OR
    (status = 'consumed' AND transaction_id IS NOT NULL)
  )
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
`;

const SCHEMA_CHECKSUM = digestText(SCHEMA_SQL);

interface JsonRow {
  record_json: string;
}

interface ReservationRow extends JsonRow {
  reservation_id: string;
  status: "reserved" | "consumed";
  transaction_id: string | null;
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

export class DemoExactStoreError extends Error {
  readonly code: "invalid_record" | "conflict" | "unsupported_operation" | "store_unavailable";

  constructor(code: DemoExactStoreError["code"] = "store_unavailable") {
    const messages = {
      invalid_record: "demo exact store record is invalid",
      conflict: "demo exact store write conflicts with durable state",
      unsupported_operation: "demo exact store operation is outside exact mode",
      store_unavailable: "demo exact store is unavailable",
    } as const;
    super(messages[code]);
    this.name = "DemoExactStoreError";
    this.code = code;
  }
}

export interface SqliteExactServerStateStoreOptions {
  readonly busyTimeoutMs?: number;
}

/** Exact-only durable implementation of the Kaspa-x402 ServerStateStore. */
export class SqliteExactServerStateStore implements ServerStateStore {
  private readonly db: Database.Database;

  constructor(readonly filename: string, options: SqliteExactServerStateStoreOptions = {}) {
    let pathInfo;
    try {
      pathInfo = prepareSecureSqlitePath(filename, "demo exact store");
    } catch {
      throw new DemoExactStoreError("store_unavailable");
    }
    this.db = new Database(filename);
    try {
      this.configure(options.busyTimeoutMs ?? 5_000);
      validateSecureSqlitePath(pathInfo);
      this.initialize();
      this.verifyStartup();
    } catch (error) {
      if (this.db.open) this.db.close();
      if (error instanceof DemoExactStoreError) throw error;
      throw new DemoExactStoreError("store_unavailable");
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
      throw new DemoExactStoreError("store_unavailable");
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
        if (existingPayment.record_json !== paymentJson) throw new DemoExactStoreError("conflict");
        if (
          (record.paymentIdentifier === undefined) !== (existingIdentifier === undefined) ||
          (identifierJson !== undefined && existingIdentifier?.record_json !== identifierJson)
        ) {
          throw new DemoExactStoreError("conflict");
        }
        return;
      }
      if (existingIdentifier) {
        throw new DemoExactStoreError("conflict");
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
    });
    this.runWrite(commit);
  }

  async saveExactReservation(record: ExactReservationRecord): Promise<void> {
    validateReservation(record);
    const json = stableJson(record);
    const save = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT status, transaction_id, record_json FROM exact_reservations WHERE reservation_id = ?"
        )
        .get(record.reservationId) as ReservationRow | undefined;
      if (existing) {
        const current = parseJson<ExactReservationRecord>(existing.record_json);
        if (!sameReservationTerms(current, record)) {
          throw new DemoExactStoreError("conflict");
        }
        // The pinned server may recreate the same reservation response after a
        // crash with a later reservedAt. Preserve the first durable timestamp
        // and any consumed transaction instead of treating that as new terms.
        return;
      }
      this.db
        .prepare(
          `INSERT INTO exact_reservations (reservation_id, status, transaction_id, record_json)
           VALUES (?, ?, ?, ?)`
        )
        .run(record.reservationId, record.status, record.transactionId ?? null, json);
    });
    this.runWrite(save);
  }

  async loadExactReservation(reservationId: string): Promise<ExactReservationRecord | undefined> {
    requireHash(reservationId);
    return this.loadJson<ExactReservationRecord>(
      "SELECT record_json FROM exact_reservations WHERE reservation_id = ?",
      reservationId
    );
  }

  async consumeExactReservation(reservationId: string, transactionId: string): Promise<void> {
    requireHash(reservationId);
    requireHash(transactionId);
    const consume = this.db.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT status, transaction_id, record_json FROM exact_reservations WHERE reservation_id = ?"
        )
        .get(reservationId) as ReservationRow | undefined;
      if (!current) throw new DemoExactStoreError("conflict");
      if (current.status === "consumed") {
        if (current.transaction_id === transactionId) return;
        throw new DemoExactStoreError("conflict");
      }
      const parsed = parseJson<ExactReservationRecord>(current.record_json);
      const consumed: ExactReservationRecord = {
        ...parsed,
        status: "consumed",
        transactionId,
      };
      validateReservation(consumed);
      const updated = this.db
        .prepare(
          `UPDATE exact_reservations
             SET status = 'consumed', transaction_id = ?, record_json = ?
           WHERE reservation_id = ? AND status = 'reserved'`
        )
        .run(transactionId, stableJson(consumed), reservationId);
      if (updated.changes !== 1) throw new DemoExactStoreError("conflict");
    });
    this.runWrite(consume);
  }

  async loadChannel(_channelId: string): Promise<ServerChannelRecord | undefined> {
    return undefined;
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return [];
  }

  async loadCommitment(_commitmentId: string): Promise<BatchCommitmentRecord | undefined> {
    return undefined;
  }

  async loadOpenClaimAttempt(_channelId: string): Promise<ClaimAttemptRecord | undefined> {
    return undefined;
  }

  async saveChannel(_channel: ServerChannelRecord): Promise<void> {
    throw new DemoExactStoreError("unsupported_operation");
  }

  async retireChannel(_channelId: string, _reason?: string): Promise<void> {
    throw new DemoExactStoreError("unsupported_operation");
  }

  async commitSettlement(_record: SettlementCommit): Promise<void> {
    throw new DemoExactStoreError("unsupported_operation");
  }

  async saveClaimAttempt(_record: ClaimAttemptRecord): Promise<void> {
    throw new DemoExactStoreError("unsupported_operation");
  }

  async applyClaimAttempt(
    _channel: ServerChannelRecord,
    _attempt: ClaimAttemptRecord
  ): Promise<void> {
    throw new DemoExactStoreError("unsupported_operation");
  }

  async abandonClaimAttempt(_attemptId: string, _reason?: string): Promise<void> {
    throw new DemoExactStoreError("unsupported_operation");
  }

  integrityCheck(): true {
    const integrity = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const foreignKeys = this.db.pragma("foreign_key_check") as unknown[];
    if (
      integrity.length !== 1 ||
      integrity[0].integrity_check !== "ok" ||
      foreignKeys.length !== 0
    ) {
      throw new DemoExactStoreError("store_unavailable");
    }
    return true;
  }

  private loadJson<T>(sql: string, key: string): T | undefined {
    try {
      const row = this.db.prepare(sql).get(key) as JsonRow | undefined;
      return row ? parseJson<T>(row.record_json) : undefined;
    } catch (error) {
      if (error instanceof DemoExactStoreError) throw error;
      throw new DemoExactStoreError("store_unavailable");
    }
  }

  private runWrite(transaction: Database.Transaction<() => void>): void {
    try {
      transaction.immediate();
    } catch (error) {
      if (error instanceof DemoExactStoreError) throw error;
      throw new DemoExactStoreError("store_unavailable");
    }
  }

  private configure(busyTimeoutMs: number): void {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new DemoExactStoreError("invalid_record");
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
    if (version !== 0 || applicationId !== 0) throw new DemoExactStoreError("store_unavailable");
    const objects = this.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get() as { count: number };
    if (objects.count !== 0) throw new DemoExactStoreError("store_unavailable");
    const initialize = this.db.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare("INSERT INTO demo_exact_store_meta (singleton, schema_checksum) VALUES (1, ?)")
        .run(SCHEMA_CHECKSUM);
      this.db.pragma(`application_id = ${APPLICATION_ID}`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();
  }

  private verifyStartup(): void {
    const meta = this.db
      .prepare("SELECT schema_checksum FROM demo_exact_store_meta WHERE singleton = 1")
      .get() as { schema_checksum: string } | undefined;
    if (
      (this.db.pragma("application_id", { simple: true }) as number) !== APPLICATION_ID ||
      (this.db.pragma("user_version", { simple: true }) as number) !== SCHEMA_VERSION ||
      meta?.schema_checksum !== SCHEMA_CHECKSUM ||
      schemaFingerprint(this.db) !== expectedSchemaFingerprint()
    ) {
      throw new DemoExactStoreError("store_unavailable");
    }
    this.integrityCheck();
    this.verifySemanticConsistency();
  }

  private verifySemanticConsistency(): void {
    const reservations = this.db
      .prepare("SELECT * FROM exact_reservations")
      .all() as ReservationRow[];
    for (const row of reservations) {
      const record = parseJson<ExactReservationRecord>(row.record_json);
      validateReservation(record);
      if (
        record.reservationId !== row.reservation_id ||
        record.status !== row.status ||
        (record.transactionId ?? null) !== row.transaction_id
      ) {
        throw new DemoExactStoreError("store_unavailable");
      }
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
        throw new DemoExactStoreError("store_unavailable");
      }
      paymentByTransaction.set(record.transactionId, record);
    }

    const identifiers = this.db
      .prepare("SELECT * FROM payment_identifiers")
      .all() as PaymentIdentifierRow[];
    for (const row of identifiers) {
      const record = parseJson<PaymentIdentifierRecord>(row.record_json);
      const payment = record.transactionId
        ? paymentByTransaction.get(record.transactionId)
        : undefined;
      if (!payment) throw new DemoExactStoreError("store_unavailable");
      validateExactPaymentIdentifier(record, payment);
      if (
        record.id !== row.id ||
        record.fingerprint !== row.fingerprint ||
        record.paymentPayloadHash !== row.payment_payload_hash ||
        record.paymentScopeId !== row.payment_scope_id ||
        (record.transactionId ?? null) !== row.transaction_id ||
        (record.paymentOutputIndex ?? null) !== row.payment_output_index
      ) {
        throw new DemoExactStoreError("store_unavailable");
      }
    }
  }
}

function sameReservationTerms(
  left: ExactReservationRecord,
  right: ExactReservationRecord
): boolean {
  const stableTerms = (value: ExactReservationRecord) => ({
    reservationId: value.reservationId,
    templateId: value.templateId,
    transactionEncoding: value.transactionEncoding,
    borrowOutpoint: value.borrowOutpoint,
    borrowAmount: value.borrowAmount,
    borrowScriptPublicKey: value.borrowScriptPublicKey,
    borrowRedeemScript: value.borrowRedeemScript,
    additiveThresholdSompi: value.additiveThresholdSompi,
    paymentOutputIndex: value.paymentOutputIndex,
    expiresAt: value.expiresAt,
  });
  return stableJson(stableTerms(left)) === stableJson(stableTerms(right));
}

function validateExactCommit(record: ExactSettlementCommit): void {
  if (!record || !record.payment) throw new DemoExactStoreError("invalid_record");
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
  requireOutputIndex(payment.paymentOutputIndex);
  requireSompi(payment.amount, false);
  if (!['mempool', 'accepted', 'confirmed'].includes(payment.finality)) {
    throw new DemoExactStoreError("invalid_record");
  }
  stableJson(payment);
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
    throw new DemoExactStoreError("invalid_record");
  }
  stableJson(identifier);
}

function validateReservation(record: ExactReservationRecord): void {
  if (!record) throw new DemoExactStoreError("invalid_record");
  requireHash(record.reservationId);
  requireHash(record.borrowOutpoint.txid);
  requireOutputIndex(record.borrowOutpoint.index);
  requireSompi(record.borrowAmount, false);
  requireSompi(record.additiveThresholdSompi, true);
  requireOutputIndex(record.paymentOutputIndex);
  const reservedAtMs = Date.parse(record.reservedAt);
  const expiresAtMs = record.expiresAt === undefined ? undefined : Date.parse(record.expiresAt);
  if (
    record.templateId !== "kaspa-x402-kip10-additive-v1" ||
    record.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    !/^0000(?:[0-9a-f]{2})+$/.test(record.borrowScriptPublicKey) ||
    !/^(?:[0-9a-f]{2})+$/.test(record.borrowRedeemScript) ||
    (record.status === "reserved" && record.transactionId !== undefined) ||
    (record.status === "consumed" &&
      (record.transactionId === undefined || !HASH_PATTERN.test(record.transactionId))) ||
    !Number.isFinite(reservedAtMs) ||
    new Date(reservedAtMs).toISOString() !== record.reservedAt ||
    (record.expiresAt !== undefined &&
      (!Number.isFinite(expiresAtMs) ||
        new Date(expiresAtMs!).toISOString() !== record.expiresAt ||
        expiresAtMs! <= reservedAtMs))
  ) {
    throw new DemoExactStoreError("invalid_record");
  }
  stableJson(record);
}

function requireHash(value: string): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new DemoExactStoreError("invalid_record");
  }
}

function requireIdentifier(value: string): void {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new DemoExactStoreError("invalid_record");
  }
}

function requireOutputIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new DemoExactStoreError("invalid_record");
  }
}

function requireSompi(value: string, allowZero: boolean): void {
  if (
    typeof value !== "string" ||
    !SOMPI_PATTERN.test(value) ||
    (!allowZero && value === "0") ||
    BigInt(value) > 0xffff_ffff_ffff_ffffn
  ) {
    throw new DemoExactStoreError("invalid_record");
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
    if (!Number.isFinite(value)) throw new DemoExactStoreError("invalid_record");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new DemoExactStoreError("invalid_record");
  if (ancestors.has(value)) throw new DemoExactStoreError("invalid_record");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableSerialize(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DemoExactStoreError("invalid_record");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) {
      throw new DemoExactStoreError("invalid_record");
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
    if (error instanceof DemoExactStoreError) throw error;
    throw new DemoExactStoreError("store_unavailable");
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
