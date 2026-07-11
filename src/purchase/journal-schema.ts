import { createHash } from "node:crypto";
import Database from "better-sqlite3";

export const JOURNAL_APPLICATION_ID = 0x534f4d50; // SOMP
export const JOURNAL_SCHEMA_VERSION = 1;

export const JOURNAL_SCHEMA_SQL = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE purchases (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN (
      'created', 'terms_bound', 'awaiting_authority', 'authorised',
      'execution_prepared', 'submitted', 'settled', 'fulfilled', 'receipted',
      'denied', 'cancelled', 'expired', 'failed_recoverable', 'failed_terminal'
    )),
    resource_url TEXT NOT NULL,
    method TEXT NOT NULL,
    resource_fingerprint TEXT NOT NULL,
    expected_merchant_id TEXT,
    expected_merchant_origin TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE purchase_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    detail_digest TEXT,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE evidence_artifacts (
    digest TEXT PRIMARY KEY,
    media_type TEXT NOT NULL,
    profile TEXT NOT NULL,
    issuer TEXT,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    storage_ref TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE evidence_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    verifier_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    detail_digest TEXT NOT NULL,
    verified_at_ms INTEGER NOT NULL,
    UNIQUE (digest, verifier_id, profile, detail_digest)
  ) STRICT;

  CREATE TABLE policy_snapshots (
    digest TEXT PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
    max_per_payment_atomic TEXT NOT NULL,
    max_per_hour_atomic TEXT NOT NULL,
    approval_above_atomic TEXT NOT NULL,
    activated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE policy_allowlist (
    policy_digest TEXT NOT NULL REFERENCES policy_snapshots(digest) ON DELETE RESTRICT,
    payee TEXT NOT NULL,
    PRIMARY KEY (policy_digest, payee)
  ) STRICT;

  CREATE TABLE journal_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_digest TEXT NOT NULL REFERENCES policy_snapshots(digest) ON DELETE RESTRICT,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE treasury_reservations (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    policy_digest TEXT NOT NULL REFERENCES policy_snapshots(digest) ON DELETE RESTRICT,
    approval_evidence_digest TEXT REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    approval_verification_profile TEXT,
    approval_verifier_id TEXT,
    payee TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    fee_ceiling_atomic TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'in_flight', 'spent', 'released', 'expired')),
    expires_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    in_flight_at_ms INTEGER,
    spent_at_ms INTEGER,
    release_evidence_digest TEXT,
    UNIQUE (id, purchase_id)
  ) STRICT;

  CREATE UNIQUE INDEX one_payment_reservation_per_purchase
    ON treasury_reservations(purchase_id)
    WHERE state IN ('active', 'in_flight', 'spent');
  CREATE INDEX reservation_capacity_window
    ON treasury_reservations(state, created_at_ms, in_flight_at_ms, spent_at_ms, expires_at_ms);

  CREATE TABLE payment_attempts (
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    identifier TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('planned', 'prepared', 'submitted', 'observed', 'failed')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    failure_code TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (purchase_id, attempt)
  ) STRICT;

  CREATE TABLE payment_attempt_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    detail_digest TEXT,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE payment_preparations (
    purchase_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    reservation_id TEXT NOT NULL UNIQUE REFERENCES treasury_reservations(id) ON DELETE RESTRICT,
    requirements_digest TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    prepared_ref TEXT NOT NULL,
    prepared_byte_length INTEGER NOT NULL CHECK (prepared_byte_length >= 0),
    transaction_id TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    asset TEXT NOT NULL,
    network TEXT NOT NULL,
    payee TEXT NOT NULL,
    required_finality TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (purchase_id, attempt),
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE evidence_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    attempt INTEGER,
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT,
    CHECK (attempt IS NULL OR attempt >= 1)
  ) STRICT;

  CREATE UNIQUE INDEX one_purchase_evidence_link
    ON evidence_links(purchase_id, digest, kind) WHERE attempt IS NULL;
  CREATE UNIQUE INDEX one_attempt_evidence_link
    ON evidence_links(purchase_id, attempt, digest, kind) WHERE attempt IS NOT NULL;

  CREATE TABLE leases (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    expires_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE effects (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    attempt INTEGER,
    kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN (
      'planned', 'executing', 'submitted', 'ambiguous', 'retryable', 'observed', 'failed_terminal'
    )),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    payload_digest TEXT NOT NULL,
    prepared_ref TEXT NOT NULL,
    prepared_byte_length INTEGER NOT NULL CHECK (prepared_byte_length >= 0),
    claim_lease_name TEXT REFERENCES leases(name) ON DELETE RESTRICT,
    claim_generation INTEGER,
    submission_digest TEXT,
    result_digest TEXT,
    error_code TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    executing_at_ms INTEGER,
    submitted_at_ms INTEGER,
    observed_at_ms INTEGER,
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT,
    CHECK (attempt IS NULL OR attempt >= 1),
    CHECK ((claim_lease_name IS NULL) = (claim_generation IS NULL)),
    CHECK (state = 'planned' OR claim_lease_name IS NOT NULL),
    CHECK (state <> 'submitted' OR submission_digest IS NOT NULL),
    CHECK (state <> 'observed' OR result_digest IS NOT NULL),
    CHECK (state <> 'failed_terminal' OR error_code IS NOT NULL)
  ) STRICT;

  CREATE INDEX recoverable_effects ON effects(state, created_at_ms);

  CREATE TABLE effect_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    effect_id TEXT NOT NULL REFERENCES effects(id) ON DELETE RESTRICT,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    detail_digest TEXT,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE effect_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    effect_id TEXT NOT NULL REFERENCES effects(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN (
      'observed', 'pending', 'not_found_retryable', 'not_found_ambiguous',
      'conflict', 'failed_terminal'
    )),
    result_digest TEXT,
    detail_digest TEXT,
    lease_name TEXT NOT NULL,
    lease_generation INTEGER NOT NULL,
    observed_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX one_effect_observation_fact
    ON effect_observations(
      effect_id,
      status,
      COALESCE(result_digest, ''),
      COALESCE(detail_digest, '')
    );

  CREATE TABLE treasury_spends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    effect_id TEXT NOT NULL UNIQUE REFERENCES effects(id) ON DELETE RESTRICT,
    reservation_id TEXT NOT NULL UNIQUE REFERENCES treasury_reservations(id) ON DELETE RESTRICT,
    purchase_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    transaction_id TEXT NOT NULL UNIQUE,
    outpoint TEXT,
    actual_amount_atomic TEXT NOT NULL,
    actual_fee_atomic TEXT NOT NULL,
    asset TEXT NOT NULL,
    payee TEXT NOT NULL,
    network TEXT NOT NULL,
    finality TEXT NOT NULL,
    evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    evidence_verification_profile TEXT NOT NULL,
    evidence_verifier_id TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT,
    FOREIGN KEY (reservation_id, purchase_id)
      REFERENCES treasury_reservations(id, purchase_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE reconciliation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    effect_id TEXT REFERENCES effects(id) ON DELETE RESTRICT,
    outcome TEXT NOT NULL,
    detail_digest TEXT,
    lease_name TEXT NOT NULL,
    lease_generation INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TRIGGER immutable_schema_migrations_update BEFORE UPDATE ON schema_migrations
    BEGIN SELECT RAISE(ABORT, 'schema_migrations is immutable'); END;
  CREATE TRIGGER immutable_schema_migrations_delete BEFORE DELETE ON schema_migrations
    BEGIN SELECT RAISE(ABORT, 'schema_migrations is immutable'); END;
  CREATE TRIGGER immutable_purchase_transitions_update BEFORE UPDATE ON purchase_transitions
    BEGIN SELECT RAISE(ABORT, 'purchase_transitions is immutable'); END;
  CREATE TRIGGER immutable_purchase_transitions_delete BEFORE DELETE ON purchase_transitions
    BEGIN SELECT RAISE(ABORT, 'purchase_transitions is immutable'); END;
  CREATE TRIGGER immutable_evidence_artifacts_update BEFORE UPDATE ON evidence_artifacts
    BEGIN SELECT RAISE(ABORT, 'evidence_artifacts is immutable'); END;
  CREATE TRIGGER immutable_evidence_artifacts_delete BEFORE DELETE ON evidence_artifacts
    BEGIN SELECT RAISE(ABORT, 'evidence_artifacts is immutable'); END;
  CREATE TRIGGER immutable_evidence_verifications_update BEFORE UPDATE ON evidence_verifications
    BEGIN SELECT RAISE(ABORT, 'evidence_verifications is immutable'); END;
  CREATE TRIGGER immutable_evidence_verifications_delete BEFORE DELETE ON evidence_verifications
    BEGIN SELECT RAISE(ABORT, 'evidence_verifications is immutable'); END;
  CREATE TRIGGER immutable_policy_snapshots_update BEFORE UPDATE ON policy_snapshots
    BEGIN SELECT RAISE(ABORT, 'policy_snapshots is immutable'); END;
  CREATE TRIGGER immutable_policy_snapshots_delete BEFORE DELETE ON policy_snapshots
    BEGIN SELECT RAISE(ABORT, 'policy_snapshots is immutable'); END;
  CREATE TRIGGER immutable_policy_allowlist_update BEFORE UPDATE ON policy_allowlist
    BEGIN SELECT RAISE(ABORT, 'policy_allowlist is immutable'); END;
  CREATE TRIGGER immutable_policy_allowlist_delete BEFORE DELETE ON policy_allowlist
    BEGIN SELECT RAISE(ABORT, 'policy_allowlist is immutable'); END;
  CREATE TRIGGER immutable_payment_transitions_update BEFORE UPDATE ON payment_attempt_transitions
    BEGIN SELECT RAISE(ABORT, 'payment_attempt_transitions is immutable'); END;
  CREATE TRIGGER immutable_payment_transitions_delete BEFORE DELETE ON payment_attempt_transitions
    BEGIN SELECT RAISE(ABORT, 'payment_attempt_transitions is immutable'); END;
  CREATE TRIGGER immutable_payment_preparations_update BEFORE UPDATE ON payment_preparations
    BEGIN SELECT RAISE(ABORT, 'payment_preparations is immutable'); END;
  CREATE TRIGGER immutable_payment_preparations_delete BEFORE DELETE ON payment_preparations
    BEGIN SELECT RAISE(ABORT, 'payment_preparations is immutable'); END;
  CREATE TRIGGER immutable_effect_observations_update BEFORE UPDATE ON effect_observations
    BEGIN SELECT RAISE(ABORT, 'effect_observations is immutable'); END;
  CREATE TRIGGER immutable_effect_observations_delete BEFORE DELETE ON effect_observations
    BEGIN SELECT RAISE(ABORT, 'effect_observations is immutable'); END;
  CREATE TRIGGER immutable_effect_transitions_update BEFORE UPDATE ON effect_transitions
    BEGIN SELECT RAISE(ABORT, 'effect_transitions is immutable'); END;
  CREATE TRIGGER immutable_effect_transitions_delete BEFORE DELETE ON effect_transitions
    BEGIN SELECT RAISE(ABORT, 'effect_transitions is immutable'); END;
  CREATE TRIGGER immutable_treasury_spends_update BEFORE UPDATE ON treasury_spends
    BEGIN SELECT RAISE(ABORT, 'treasury_spends is immutable'); END;
  CREATE TRIGGER immutable_treasury_spends_delete BEFORE DELETE ON treasury_spends
    BEGIN SELECT RAISE(ABORT, 'treasury_spends is immutable'); END;
`;

export const JOURNAL_SCHEMA_CHECKSUM = sha256Text(JOURNAL_SCHEMA_SQL);

export function schemaFingerprint(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return sha256Text(JSON.stringify(rows));
}

let expectedFingerprint: string | undefined;

export function expectedSchemaFingerprint(): string {
  if (expectedFingerprint) return expectedFingerprint;
  const expected = new Database(":memory:");
  try {
    expected.exec(JOURNAL_SCHEMA_SQL);
    expectedFingerprint = schemaFingerprint(expected);
    return expectedFingerprint;
  } finally {
    expected.close();
  }
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}
