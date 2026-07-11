import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import Database from "better-sqlite3";

import {
  AUTHORITY_MAX_REPLAY_RESULT_BYTES,
  type AuthorityReplayAcquireInput,
  type AuthorityReplayAcquireResult,
  type AuthorityReplayCompleteInput,
  type AuthorityReplayCompletion,
  type AuthorityReplayLookupInput,
  type AuthorityReplayRenewInput,
  type AuthorityReplayStore,
} from "./protocol.js";

const APPLICATION_ID = 0x53415250;
const SCHEMA_VERSION = 1;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const ACQUISITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const SCHEMA_SQL = `
CREATE TABLE authority_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;

CREATE TABLE replay_messages (
  scope TEXT NOT NULL CHECK (scope IN ('approval_request', 'approval_response')),
  message_digest TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  acquisition_id TEXT NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms > 0),
  result_digest TEXT,
  result TEXT,
  PRIMARY KEY (scope, message_digest),
  CHECK ((result_digest IS NULL) = (result IS NULL))
) STRICT;

CREATE TABLE replay_tokens (
  token_digest TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  message_digest TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  FOREIGN KEY (scope, message_digest)
    REFERENCES replay_messages(scope, message_digest) ON DELETE CASCADE
) STRICT;

CREATE INDEX replay_tokens_message_idx
  ON replay_tokens(scope, message_digest);
`;

const SCHEMA_CHECKSUM = `sha256:${createHash("sha256")
  .update(SCHEMA_SQL, "utf8")
  .digest("base64url")}`;

interface ReplayMessageRow {
  scope: "approval_request" | "approval_response";
  message_digest: string;
  expires_at_ms: number;
  acquisition_id: string;
  lease_expires_at_ms: number;
  result_digest: string | null;
  result: string | null;
}

interface ReplayTokenRow {
  token_digest: string;
  scope: "approval_request" | "approval_response";
  message_digest: string;
}

export interface SqliteAuthorityReplayStoreOptions {
  readonly now?: () => number;
  readonly busyTimeoutMs?: number;
}

export class AuthorityReplayStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityReplayStoreError";
  }
}

/**
 * Crash-safe replay acquisition and completion store for the authority IPC.
 *
 * Acquisition, every replay token, and the fencing lease are committed in one
 * IMMEDIATE transaction. A superseded owner can never renew or complete.
 */
export class SqliteAuthorityReplayStore implements AuthorityReplayStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(readonly filename: string, options: SqliteAuthorityReplayStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    prepareSecureDatabasePath(filename);
    this.db = new Database(filename);
    try {
      if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
      this.configure(options.busyTimeoutMs ?? 5_000);
      this.initialize();
      this.verifyStartup();
    } catch (error) {
      if (this.db.open) this.db.close();
      if (error instanceof AuthorityReplayStoreError) throw error;
      throw new AuthorityReplayStoreError("authority replay store failed its startup checks");
    }
  }

  close(): void {
    if (!this.db.open) return;
    if (this.filename !== ":memory:") this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  acquire(input: AuthorityReplayAcquireInput): AuthorityReplayAcquireResult {
    validateAcquireInput(input);
    const acquire = this.db.transaction((): AuthorityReplayAcquireResult => {
      this.db.prepare("DELETE FROM replay_messages WHERE expires_at_ms <= ?").run(input.nowMs);

      const tokenRows = selectTokenRows(this.db, input.tokenDigests);
      if (tokenRows.length > 0) {
        if (
          tokenRows.length !== input.tokenDigests.length ||
          tokenRows.some(
            (row) => row.scope !== input.scope || row.message_digest !== input.messageDigest
          )
        ) {
          return Object.freeze({ status: "conflict" });
        }
        const message = this.requireMessage(input.scope, input.messageDigest);
        const tokenCount = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM replay_tokens WHERE scope = ? AND message_digest = ?"
          )
          .get(input.scope, input.messageDigest) as { count: number };
        if (
          tokenCount.count !== input.tokenDigests.length ||
          message.expires_at_ms !== input.expiresAtMs
        ) {
          return Object.freeze({ status: "conflict" });
        }
        if (message.result !== null) {
          return Object.freeze({
            status: "existing",
            leaseExpiresAtMs: message.lease_expires_at_ms,
          });
        }
        if (message.lease_expires_at_ms <= input.nowMs) {
          const acquisitionId = newAcquisitionId();
          const updated = this.db
            .prepare(
              `UPDATE replay_messages
                 SET acquisition_id = ?, lease_expires_at_ms = ?
               WHERE scope = ? AND message_digest = ? AND acquisition_id = ?
                 AND lease_expires_at_ms <= ? AND result IS NULL`
            )
            .run(
              acquisitionId,
              input.leaseExpiresAtMs,
              input.scope,
              input.messageDigest,
              message.acquisition_id,
              input.nowMs
            );
          if (updated.changes !== 1) {
            throw new AuthorityReplayStoreError("authority replay acquisition lost its fence");
          }
          return Object.freeze({
            status: "acquired",
            acquisitionId,
            leaseExpiresAtMs: input.leaseExpiresAtMs,
          });
        }
        return Object.freeze({
          status: "existing",
          leaseExpiresAtMs: message.lease_expires_at_ms,
        });
      }

      const orphan = this.db
        .prepare("SELECT 1 AS present FROM replay_messages WHERE scope = ? AND message_digest = ?")
        .get(input.scope, input.messageDigest) as { present: number } | undefined;
      if (orphan) throw new AuthorityReplayStoreError("authority replay tokens are inconsistent");

      const acquisitionId = newAcquisitionId();
      this.db
        .prepare(
          `INSERT INTO replay_messages (
             scope, message_digest, expires_at_ms, acquisition_id, lease_expires_at_ms
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.scope,
          input.messageDigest,
          input.expiresAtMs,
          acquisitionId,
          input.leaseExpiresAtMs
        );
      const insertToken = this.db.prepare(
        `INSERT INTO replay_tokens (token_digest, scope, message_digest, expires_at_ms)
         VALUES (?, ?, ?, ?)`
      );
      for (const token of input.tokenDigests) {
        insertToken.run(token, input.scope, input.messageDigest, input.expiresAtMs);
      }
      return Object.freeze({
        status: "acquired",
        acquisitionId,
        leaseExpiresAtMs: input.leaseExpiresAtMs,
      });
    });

    try {
      return acquire.immediate();
    } catch (error) {
      if (error instanceof AuthorityReplayStoreError) throw error;
      throw new AuthorityReplayStoreError("authority replay acquisition failed");
    }
  }

  renew(input: AuthorityReplayRenewInput): void {
    validateRenewInput(input);
    try {
      const updated = this.db
        .prepare(
          `UPDATE replay_messages
             SET lease_expires_at_ms = ?
           WHERE scope = ? AND message_digest = ? AND acquisition_id = ?
             AND expires_at_ms = ? AND lease_expires_at_ms > ? AND result IS NULL`
        )
        .run(
          input.leaseExpiresAtMs,
          input.scope,
          input.messageDigest,
          input.acquisitionId,
          input.expiresAtMs,
          input.nowMs
        );
      if (updated.changes !== 1) {
        throw new AuthorityReplayStoreError("authority replay lease is stale or superseded");
      }
    } catch (error) {
      if (error instanceof AuthorityReplayStoreError) throw error;
      throw new AuthorityReplayStoreError("authority replay lease renewal failed");
    }
  }

  lookup(input: AuthorityReplayLookupInput): AuthorityReplayCompletion | undefined {
    validateScope(input.scope);
    validateDigest(input.messageDigest);
    try {
      const row = this.db
        .prepare("SELECT * FROM replay_messages WHERE scope = ? AND message_digest = ?")
        .get(input.scope, input.messageDigest) as ReplayMessageRow | undefined;
      if (!row || row.result === null || row.result_digest === null) return undefined;
      validatePersistedMessage(row);
      return Object.freeze({
        scope: row.scope,
        messageDigest: row.message_digest as AuthorityReplayCompletion["messageDigest"],
        resultDigest: row.result_digest as AuthorityReplayCompletion["resultDigest"],
        result: row.result,
        expiresAtMs: row.expires_at_ms,
      });
    } catch (error) {
      if (error instanceof AuthorityReplayStoreError) throw error;
      throw new AuthorityReplayStoreError("authority replay lookup failed");
    }
  }

  complete(input: AuthorityReplayCompleteInput): void {
    validateCompleteInput(input);
    const complete = this.db.transaction(() => {
      const row = this.requireMessage(input.scope, input.messageDigest);
      if (
        row.acquisition_id !== input.acquisitionId ||
        row.expires_at_ms !== input.expiresAtMs
      ) {
        throw new AuthorityReplayStoreError("authority replay completion is stale or superseded");
      }
      if (row.result !== null || row.result_digest !== null) {
        if (row.result === input.result && row.result_digest === input.resultDigest) return;
        throw new AuthorityReplayStoreError("authority replay completion conflicts with prior output");
      }
      if (row.lease_expires_at_ms <= this.timestamp()) {
        throw new AuthorityReplayStoreError("authority replay completion lease has expired");
      }
      const updated = this.db
        .prepare(
          `UPDATE replay_messages SET result_digest = ?, result = ?
           WHERE scope = ? AND message_digest = ? AND acquisition_id = ? AND result IS NULL`
        )
        .run(
          input.resultDigest,
          input.result,
          input.scope,
          input.messageDigest,
          input.acquisitionId
        );
      if (updated.changes !== 1) {
        throw new AuthorityReplayStoreError("authority replay completion lost its fence");
      }
    });
    try {
      complete.immediate();
    } catch (error) {
      if (error instanceof AuthorityReplayStoreError) throw error;
      throw new AuthorityReplayStoreError("authority replay completion failed");
    }
  }

  integrityCheck(): true {
    const integrity = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const foreignKeys = this.db.pragma("foreign_key_check") as unknown[];
    if (
      integrity.length !== 1 ||
      integrity[0].integrity_check !== "ok" ||
      foreignKeys.length !== 0
    ) {
      throw new AuthorityReplayStoreError("authority replay store integrity check failed");
    }
    return true;
  }

  private requireMessage(
    scope: AuthorityReplayAcquireInput["scope"],
    messageDigest: string
  ): ReplayMessageRow {
    const row = this.db
      .prepare("SELECT * FROM replay_messages WHERE scope = ? AND message_digest = ?")
      .get(scope, messageDigest) as ReplayMessageRow | undefined;
    if (!row) throw new AuthorityReplayStoreError("authority replay record is missing");
    validatePersistedMessage(row);
    return row;
  }

  private configure(busyTimeoutMs: number): void {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new AuthorityReplayStoreError("authority replay busy timeout is invalid");
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
    if (version !== 0 || applicationId !== 0) {
      throw new AuthorityReplayStoreError("authority replay schema is unsupported");
    }
    const existing = this.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get() as { count: number };
    if (existing.count !== 0) {
      throw new AuthorityReplayStoreError("refusing an unversioned authority replay schema");
    }
    const initialize = this.db.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare("INSERT INTO authority_store_meta (singleton, schema_checksum) VALUES (1, ?)")
        .run(SCHEMA_CHECKSUM);
      this.db.pragma(`application_id = ${APPLICATION_ID}`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();
  }

  private verifyStartup(): void {
    if (
      (this.db.pragma("application_id", { simple: true }) as number) !== APPLICATION_ID ||
      (this.db.pragma("user_version", { simple: true }) as number) !== SCHEMA_VERSION
    ) {
      throw new AuthorityReplayStoreError("authority replay schema identity is invalid");
    }
    const meta = this.db
      .prepare("SELECT schema_checksum FROM authority_store_meta WHERE singleton = 1")
      .get() as { schema_checksum: string } | undefined;
    if (meta?.schema_checksum !== SCHEMA_CHECKSUM) {
      throw new AuthorityReplayStoreError("authority replay schema checksum is invalid");
    }
    if (schemaFingerprint(this.db) !== expectedSchemaFingerprint()) {
      throw new AuthorityReplayStoreError("authority replay schema fingerprint is invalid");
    }
    this.integrityCheck();
  }

  private timestamp(): number {
    let value: number;
    try {
      value = this.now();
    } catch {
      throw new AuthorityReplayStoreError("authority replay clock is unavailable");
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AuthorityReplayStoreError("authority replay clock is invalid");
    }
    return value;
  }
}

function selectTokenRows(
  db: Database.Database,
  tokenDigests: readonly string[]
): ReplayTokenRow[] {
  const placeholders = tokenDigests.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT token_digest, scope, message_digest FROM replay_tokens
       WHERE token_digest IN (${placeholders})`
    )
    .all(...tokenDigests) as ReplayTokenRow[];
}

function validateAcquireInput(input: AuthorityReplayAcquireInput): void {
  validateScope(input.scope);
  validateDigest(input.messageDigest);
  if (
    !Array.isArray(input.tokenDigests) ||
    input.tokenDigests.length === 0 ||
    input.tokenDigests.length > 8 ||
    new Set(input.tokenDigests).size !== input.tokenDigests.length
  ) {
    throw new AuthorityReplayStoreError("authority replay token set is invalid");
  }
  for (const token of input.tokenDigests) validateDigest(token);
  validateTimestamp(input.nowMs);
  validateTimestamp(input.leaseExpiresAtMs);
  validateTimestamp(input.expiresAtMs);
  if (
    input.leaseExpiresAtMs <= input.nowMs ||
    input.leaseExpiresAtMs > input.expiresAtMs
  ) {
    throw new AuthorityReplayStoreError("authority replay acquisition lifetime is invalid");
  }
}

function validateRenewInput(input: AuthorityReplayRenewInput): void {
  validateScope(input.scope);
  validateDigest(input.messageDigest);
  validateAcquisitionId(input.acquisitionId);
  validateTimestamp(input.nowMs);
  validateTimestamp(input.leaseExpiresAtMs);
  validateTimestamp(input.expiresAtMs);
  if (
    input.leaseExpiresAtMs <= input.nowMs ||
    input.leaseExpiresAtMs > input.expiresAtMs
  ) {
    throw new AuthorityReplayStoreError("authority replay renewal lifetime is invalid");
  }
}

function validateCompleteInput(input: AuthorityReplayCompleteInput): void {
  validateScope(input.scope);
  validateDigest(input.messageDigest);
  validateDigest(input.resultDigest);
  validateAcquisitionId(input.acquisitionId);
  validateTimestamp(input.expiresAtMs);
  if (
    typeof input.result !== "string" ||
    Buffer.byteLength(input.result, "utf8") === 0 ||
    Buffer.byteLength(input.result, "utf8") > AUTHORITY_MAX_REPLAY_RESULT_BYTES ||
    digestText(input.result) !== input.resultDigest
  ) {
    throw new AuthorityReplayStoreError("authority replay completion output is invalid");
  }
}

function validatePersistedMessage(row: ReplayMessageRow): void {
  validateScope(row.scope);
  validateDigest(row.message_digest);
  validateTimestamp(row.expires_at_ms);
  validateTimestamp(row.lease_expires_at_ms);
  validateAcquisitionId(row.acquisition_id);
  if ((row.result === null) !== (row.result_digest === null)) {
    throw new AuthorityReplayStoreError("authority replay completion is inconsistent");
  }
  if (row.result !== null && row.result_digest !== null) {
    validateDigest(row.result_digest);
    if (
      Buffer.byteLength(row.result, "utf8") === 0 ||
      Buffer.byteLength(row.result, "utf8") > AUTHORITY_MAX_REPLAY_RESULT_BYTES ||
      digestText(row.result) !== row.result_digest
    ) {
      throw new AuthorityReplayStoreError("authority replay completion digest is invalid");
    }
  }
}

function validateScope(value: string): asserts value is AuthorityReplayAcquireInput["scope"] {
  if (value !== "approval_request" && value !== "approval_response") {
    throw new AuthorityReplayStoreError("authority replay scope is invalid");
  }
}

function validateDigest(value: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new AuthorityReplayStoreError("authority replay digest is invalid");
  }
}

function validateAcquisitionId(value: string): void {
  if (typeof value !== "string" || !ACQUISITION_ID_PATTERN.test(value)) {
    throw new AuthorityReplayStoreError("authority replay acquisition identity is invalid");
  }
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AuthorityReplayStoreError("authority replay timestamp is invalid");
  }
}

function newAcquisitionId(): string {
  return `authority-acquisition:${randomBytes(16).toString("base64url")}`;
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

function prepareSecureDatabasePath(filename: string): void {
  if (filename === ":memory:") return;
  const directory = path.resolve(path.dirname(filename));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
  ) {
    throw new AuthorityReplayStoreError("authority replay directory is unsafe");
  }
  if (fs.existsSync(filename)) {
    const fileStat = fs.lstatSync(filename);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      (typeof process.getuid === "function" && fileStat.uid !== process.getuid())
    ) {
      throw new AuthorityReplayStoreError("authority replay database path is unsafe");
    }
  }
}
