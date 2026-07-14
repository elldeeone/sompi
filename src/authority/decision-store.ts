import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import Database from "better-sqlite3";

import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import {
  AUTHORITY_DENIAL_CODES,
  AUTHORITY_MAX_DECISION_EVIDENCE_BYTES,
  type AuthorityDenialCode,
} from "./protocol.js";

const APPLICATION_ID = 0x53414450;
const SCHEMA_VERSION = 1;
const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const PURCHASE_ID_PATTERN = /^pur_[A-Za-z0-9_-]{22}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const SCHEMA_SQL = `
CREATE TABLE authority_decision_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;

CREATE TABLE authority_decisions (
  request_digest TEXT PRIMARY KEY,
  facts_digest TEXT NOT NULL,
  nonce_digest TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  checkout_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  authority_id TEXT NOT NULL,
  denial_code TEXT,
  evidence_digest TEXT NOT NULL,
  evidence BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  CHECK (
    (decision = 'approved' AND denial_code IS NULL) OR
    (decision = 'denied' AND denial_code IS NOT NULL)
  )
) STRICT;
`;

const SCHEMA_CHECKSUM = `sha256:${createHash("sha256")
  .update(SCHEMA_SQL, "utf8")
  .digest("base64url")}`;

export type StoredAuthorityDecision = Readonly<{
  requestDigest: Sha256Digest;
  factsDigest: Sha256Digest;
  nonceDigest: Sha256Digest;
  purchaseId: PurchaseId;
  checkoutDigest: Sha256Digest;
  decision: "approved" | "denied";
  authorityId: string;
  denialCode?: AuthorityDenialCode;
  evidenceDigest: Sha256Digest;
  evidence: Uint8Array;
  createdAtMs: number;
}>;

export interface AuthorityDecisionStore {
  find(requestDigest: Sha256Digest): StoredAuthorityDecision | undefined;
  persist(decision: StoredAuthorityDecision): StoredAuthorityDecision;
  /** Removes a decision that was persisted after its transport lifetime ended. */
  discard?(requestDigest: Sha256Digest): void;
}

export interface SqliteAuthorityDecisionStoreOptions {
  readonly busyTimeoutMs?: number;
}

export class AuthorityDecisionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityDecisionStoreError";
  }
}

/** Durable, idempotent storage for signed authority decision evidence. */
export class SqliteAuthorityDecisionStore implements AuthorityDecisionStore {
  private readonly db: Database.Database;

  constructor(readonly filename: string, options: SqliteAuthorityDecisionStoreOptions = {}) {
    prepareSecureDatabasePath(filename);
    this.db = new Database(filename);
    try {
      if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
      this.configure(options.busyTimeoutMs ?? 5_000);
      this.initialize();
      this.verifyStartup();
    } catch (error) {
      if (this.db.open) this.db.close();
      if (error instanceof AuthorityDecisionStoreError) throw error;
      throw new AuthorityDecisionStoreError("authority decision store failed its startup checks");
    }
  }

  close(): void {
    if (!this.db.open) return;
    if (this.filename !== ":memory:") this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  find(requestDigest: Sha256Digest): StoredAuthorityDecision | undefined {
    validateDigest(requestDigest);
    try {
      const row = this.db
        .prepare("SELECT * FROM authority_decisions WHERE request_digest = ?")
        .get(requestDigest) as DecisionRow | undefined;
      return row ? decisionFromRow(row) : undefined;
    } catch (error) {
      if (error instanceof AuthorityDecisionStoreError) throw error;
      throw new AuthorityDecisionStoreError("authority decision lookup failed");
    }
  }

  persist(decision: StoredAuthorityDecision): StoredAuthorityDecision {
    validateDecision(decision);
    const persist = this.db.transaction(() => {
      const existing = this.find(decision.requestDigest);
      if (existing) {
        if (!sameDecision(existing, decision)) {
          throw new AuthorityDecisionStoreError("authority decision conflicts with persisted evidence");
        }
        return existing;
      }
      this.db
        .prepare(
          `INSERT INTO authority_decisions (
             request_digest, facts_digest, nonce_digest, purchase_id,
             checkout_digest, decision, authority_id, denial_code,
             evidence_digest, evidence, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          decision.requestDigest,
          decision.factsDigest,
          decision.nonceDigest,
          decision.purchaseId,
          decision.checkoutDigest,
          decision.decision,
          decision.authorityId,
          decision.denialCode ?? null,
          decision.evidenceDigest,
          Buffer.from(decision.evidence),
          decision.createdAtMs
        );
      const readBack = this.find(decision.requestDigest);
      if (!readBack || !sameDecision(readBack, decision)) {
        throw new AuthorityDecisionStoreError("authority decision persistence verification failed");
      }
      return readBack;
    });
    try {
      return persist.immediate();
    } catch (error) {
      if (error instanceof AuthorityDecisionStoreError) throw error;
      throw new AuthorityDecisionStoreError("authority decision persistence failed");
    }
  }

  discard(requestDigest: Sha256Digest): void {
    validateDigest(requestDigest);
    try {
      this.db.prepare("DELETE FROM authority_decisions WHERE request_digest = ?").run(requestDigest);
    } catch (error) {
      if (error instanceof AuthorityDecisionStoreError) throw error;
      throw new AuthorityDecisionStoreError("authority decision discard failed");
    }
  }

  integrityCheck(): true {
    const integrity = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new AuthorityDecisionStoreError("authority decision store integrity check failed");
    }
    return true;
  }

  private configure(busyTimeoutMs: number): void {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new AuthorityDecisionStoreError("authority decision busy timeout is invalid");
    }
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
      throw new AuthorityDecisionStoreError("authority decision schema is unsupported");
    }
    const existing = this.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get() as { count: number };
    if (existing.count !== 0) {
      throw new AuthorityDecisionStoreError("refusing an unversioned authority decision schema");
    }
    const initialize = this.db.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare("INSERT INTO authority_decision_meta (singleton, schema_checksum) VALUES (1, ?)")
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
      throw new AuthorityDecisionStoreError("authority decision schema identity is invalid");
    }
    const meta = this.db
      .prepare("SELECT schema_checksum FROM authority_decision_meta WHERE singleton = 1")
      .get() as { schema_checksum: string } | undefined;
    if (meta?.schema_checksum !== SCHEMA_CHECKSUM) {
      throw new AuthorityDecisionStoreError("authority decision schema checksum is invalid");
    }
    if (schemaFingerprint(this.db) !== expectedSchemaFingerprint()) {
      throw new AuthorityDecisionStoreError("authority decision schema fingerprint is invalid");
    }
    this.integrityCheck();
  }
}

interface DecisionRow {
  request_digest: string;
  facts_digest: string;
  nonce_digest: string;
  purchase_id: string;
  checkout_digest: string;
  decision: "approved" | "denied";
  authority_id: string;
  denial_code: string | null;
  evidence_digest: string;
  evidence: Buffer;
  created_at_ms: number;
}

function decisionFromRow(row: DecisionRow): StoredAuthorityDecision {
  const decision: StoredAuthorityDecision = Object.freeze({
    requestDigest: row.request_digest as Sha256Digest,
    factsDigest: row.facts_digest as Sha256Digest,
    nonceDigest: row.nonce_digest as Sha256Digest,
    purchaseId: row.purchase_id as PurchaseId,
    checkoutDigest: row.checkout_digest as Sha256Digest,
    decision: row.decision,
    authorityId: row.authority_id,
    ...(row.denial_code === null ? {} : { denialCode: row.denial_code as AuthorityDenialCode }),
    evidenceDigest: row.evidence_digest as Sha256Digest,
    evidence: Uint8Array.from(row.evidence),
    createdAtMs: row.created_at_ms,
  });
  validateDecision(decision);
  return decision;
}

function validateDecision(decision: StoredAuthorityDecision): void {
  validateDigest(decision.requestDigest);
  validateDigest(decision.factsDigest);
  validateDigest(decision.nonceDigest);
  validateDigest(decision.checkoutDigest);
  validateDigest(decision.evidenceDigest);
  if (
    !PURCHASE_ID_PATTERN.test(decision.purchaseId) ||
    !IDENTITY_PATTERN.test(decision.authorityId) ||
    decision.authorityId.length > 160 ||
    !Number.isSafeInteger(decision.createdAtMs) ||
    decision.createdAtMs <= 0 ||
    !(decision.evidence instanceof Uint8Array) ||
    decision.evidence.byteLength === 0 ||
    decision.evidence.byteLength > AUTHORITY_MAX_DECISION_EVIDENCE_BYTES ||
    digestBytes(decision.evidence) !== decision.evidenceDigest
  ) {
    throw new AuthorityDecisionStoreError("authority decision evidence is invalid");
  }
  if (
    (decision.decision === "approved" && decision.denialCode !== undefined) ||
    (decision.decision === "denied" &&
      !(AUTHORITY_DENIAL_CODES as readonly string[]).includes(decision.denialCode ?? ""))
  ) {
    throw new AuthorityDecisionStoreError("authority decision result is invalid");
  }
}

function sameDecision(left: StoredAuthorityDecision, right: StoredAuthorityDecision): boolean {
  return (
    left.requestDigest === right.requestDigest &&
    left.factsDigest === right.factsDigest &&
    left.nonceDigest === right.nonceDigest &&
    left.purchaseId === right.purchaseId &&
    left.checkoutDigest === right.checkoutDigest &&
    left.decision === right.decision &&
    left.authorityId === right.authorityId &&
    left.denialCode === right.denialCode &&
    left.evidenceDigest === right.evidenceDigest &&
    left.createdAtMs === right.createdAtMs &&
    Buffer.from(left.evidence).equals(Buffer.from(right.evidence))
  );
}

function validateDigest(value: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new AuthorityDecisionStoreError("authority decision digest is invalid");
  }
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function schemaFingerprint(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all();
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(rows), "utf8")
    .digest("base64url")}`;
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
    throw new AuthorityDecisionStoreError("authority decision directory is unsafe");
  }
  if (fs.existsSync(filename)) {
    const fileStat = fs.lstatSync(filename);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      (typeof process.getuid === "function" && fileStat.uid !== process.getuid())
    ) {
      throw new AuthorityDecisionStoreError("authority decision database path is unsafe");
    }
  }
}
