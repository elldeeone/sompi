import { createHash } from "node:crypto";
import Database from "better-sqlite3";

export const JOURNAL_APPLICATION_ID = 0x534f4d50; // SOMP
export const JOURNAL_SCHEMA_VERSION = 9;

export const JOURNAL_SCHEMA_V1_SQL = `
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
      'planned', 'executing', 'submitted', 'ambiguous', 'retryable', 'observed', 'failed_terminal', 'abandoned'
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
    CHECK (state IN ('planned', 'abandoned') OR claim_lease_name IS NOT NULL),
    CHECK (state <> 'submitted' OR submission_digest IS NOT NULL),
    CHECK (state <> 'observed' OR result_digest IS NOT NULL),
    CHECK (state <> 'failed_terminal' OR error_code IS NOT NULL),
    CHECK (state <> 'abandoned' OR error_code IS NOT NULL)
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
      'conflict', 'application_failure'
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

/**
 * Version 2 adds the protocol-neutral facts needed to reconstruct a Purchase.
 * Raw AP2/x402/Merchant artifacts remain in the evidence store; these tables
 * contain only verified canonical fields and immutable joins.
 */
export const JOURNAL_SCHEMA_V2_MIGRATION_SQL = `
  ALTER TABLE treasury_reservations
    RENAME COLUMN fee_ceiling_atomic TO additional_cost_ceiling_atomic;
  ALTER TABLE treasury_spends
    RENAME COLUMN actual_fee_atomic TO actual_additional_cost_atomic;
  ALTER TABLE evidence_links ADD COLUMN media_type TEXT NOT NULL DEFAULT 'application/octet-stream';
  ALTER TABLE evidence_links ADD COLUMN profile TEXT NOT NULL DEFAULT 'urn:sompi:evidence:legacy-v1';
  ALTER TABLE evidence_links ADD COLUMN issuer TEXT;
  ALTER TABLE evidence_links ADD COLUMN attached_at_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE treasury_reservations
    ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'vault-treasury'
      CHECK (funding_source = 'vault-treasury');
  ALTER TABLE payment_preparations
    ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'vault-treasury'
      CHECK (funding_source = 'vault-treasury');
  ALTER TABLE treasury_spends
    ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'vault-treasury'
      CHECK (funding_source = 'vault-treasury');

  CREATE TABLE checkout_terms (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT,
    merchant_id TEXT NOT NULL,
    merchant_name TEXT NOT NULL,
    merchant_origin TEXT NOT NULL,
    resource_fingerprint TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    asset TEXT NOT NULL,
    network TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    checkout_digest TEXT NOT NULL,
    checkout_evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    checkout_verification_profile TEXT NOT NULL,
    checkout_verifier_id TEXT NOT NULL,
    payment_requirements_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    payment_requirements_verification_profile TEXT NOT NULL,
    payment_requirements_verifier_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE authorization_requests (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT,
    checkout_digest TEXT NOT NULL,
    request_digest TEXT NOT NULL UNIQUE,
    nonce_digest TEXT NOT NULL UNIQUE,
    request_media_type TEXT NOT NULL,
    request_body_digest TEXT NOT NULL,
    additional_cost_ceiling_atomic TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE purchase_authorizations (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied', 'expired')),
    authority_id TEXT NOT NULL,
    checkout_digest TEXT NOT NULL,
    approved_facts_digest TEXT NOT NULL,
    evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    verification_profile TEXT NOT NULL,
    verifier_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    nonce_digest TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    decided_at_ms INTEGER NOT NULL,
    FOREIGN KEY (purchase_id) REFERENCES authorization_requests(purchase_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE fulfilments (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT,
    attempt INTEGER NOT NULL,
    http_status INTEGER NOT NULL CHECK (http_status BETWEEN 100 AND 599),
    resource_fingerprint TEXT NOT NULL,
    body_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    body_byte_length INTEGER NOT NULL CHECK (body_byte_length >= 0),
    media_type TEXT NOT NULL,
    merchant_evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    merchant_verification_profile TEXT NOT NULL,
    merchant_verifier_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE purchase_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    role TEXT NOT NULL,
    canonical_digest TEXT NOT NULL,
    evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    profile TEXT NOT NULL,
    issuer TEXT,
    verifier_id TEXT NOT NULL,
    checkout_digest TEXT NOT NULL,
    authorization_evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    settlement_evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    fulfilment_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (purchase_id, role)
  ) STRICT;

  CREATE TABLE purchase_receipt_sets (
    purchase_id TEXT PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT,
    profile TEXT NOT NULL,
    canonical_digest TEXT NOT NULL UNIQUE,
    completed_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE treasury_staging_plans (
    effect_id TEXT PRIMARY KEY REFERENCES effects(id) ON DELETE RESTRICT,
    purchase_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    reservation_id TEXT NOT NULL UNIQUE,
    payload_digest TEXT NOT NULL,
    prepared_ref TEXT NOT NULL,
    prepared_byte_length INTEGER NOT NULL CHECK (prepared_byte_length > 0),
    planned_transaction_id TEXT NOT NULL UNIQUE,
    expected_outpoint TEXT NOT NULL UNIQUE,
    staging_amount_atomic TEXT NOT NULL,
    funding_source TEXT NOT NULL CHECK (funding_source = 'vault-treasury'),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (purchase_id, attempt),
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT,
    FOREIGN KEY (reservation_id, purchase_id)
      REFERENCES treasury_reservations(id, purchase_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE treasury_staging_observations (
    effect_id TEXT PRIMARY KEY REFERENCES treasury_staging_plans(effect_id) ON DELETE RESTRICT,
    purchase_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    reservation_id TEXT NOT NULL UNIQUE,
    transaction_id TEXT NOT NULL UNIQUE,
    outpoint TEXT NOT NULL UNIQUE,
    staging_amount_atomic TEXT NOT NULL,
    funding_source TEXT NOT NULL CHECK (funding_source = 'vault-treasury'),
    evidence_digest TEXT NOT NULL REFERENCES evidence_artifacts(digest) ON DELETE RESTRICT,
    evidence_verification_profile TEXT NOT NULL,
    evidence_verifier_id TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    UNIQUE (purchase_id, attempt),
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT,
    FOREIGN KEY (reservation_id, purchase_id)
      REFERENCES treasury_reservations(id, purchase_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TRIGGER immutable_checkout_terms_update BEFORE UPDATE ON checkout_terms
    BEGIN SELECT RAISE(ABORT, 'checkout_terms is immutable'); END;
  CREATE TRIGGER immutable_checkout_terms_delete BEFORE DELETE ON checkout_terms
    BEGIN SELECT RAISE(ABORT, 'checkout_terms is immutable'); END;
  CREATE TRIGGER immutable_authorization_requests_update BEFORE UPDATE ON authorization_requests
    BEGIN SELECT RAISE(ABORT, 'authorization_requests is immutable'); END;
  CREATE TRIGGER immutable_authorization_requests_delete BEFORE DELETE ON authorization_requests
    BEGIN SELECT RAISE(ABORT, 'authorization_requests is immutable'); END;
  CREATE TRIGGER immutable_purchase_authorizations_update BEFORE UPDATE ON purchase_authorizations
    BEGIN SELECT RAISE(ABORT, 'purchase_authorizations is immutable'); END;
  CREATE TRIGGER immutable_purchase_authorizations_delete BEFORE DELETE ON purchase_authorizations
    BEGIN SELECT RAISE(ABORT, 'purchase_authorizations is immutable'); END;
  CREATE TRIGGER immutable_fulfilments_update BEFORE UPDATE ON fulfilments
    BEGIN SELECT RAISE(ABORT, 'fulfilments is immutable'); END;
  CREATE TRIGGER immutable_fulfilments_delete BEFORE DELETE ON fulfilments
    BEGIN SELECT RAISE(ABORT, 'fulfilments is immutable'); END;
  CREATE TRIGGER immutable_purchase_receipts_update BEFORE UPDATE ON purchase_receipts
    BEGIN SELECT RAISE(ABORT, 'purchase_receipts is immutable'); END;
  CREATE TRIGGER immutable_purchase_receipts_delete BEFORE DELETE ON purchase_receipts
    BEGIN SELECT RAISE(ABORT, 'purchase_receipts is immutable'); END;
  CREATE TRIGGER immutable_purchase_receipt_sets_update BEFORE UPDATE ON purchase_receipt_sets
    BEGIN SELECT RAISE(ABORT, 'purchase_receipt_sets is immutable'); END;
  CREATE TRIGGER immutable_purchase_receipt_sets_delete BEFORE DELETE ON purchase_receipt_sets
    BEGIN SELECT RAISE(ABORT, 'purchase_receipt_sets is immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_plans_update BEFORE UPDATE ON treasury_staging_plans
    BEGIN SELECT RAISE(ABORT, 'treasury_staging_plans is immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_plans_delete BEFORE DELETE ON treasury_staging_plans
    BEGIN SELECT RAISE(ABORT, 'treasury_staging_plans is immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_observations_update BEFORE UPDATE ON treasury_staging_observations
    BEGIN SELECT RAISE(ABORT, 'treasury_staging_observations is immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_observations_delete BEFORE DELETE ON treasury_staging_observations
    BEGIN SELECT RAISE(ABORT, 'treasury_staging_observations is immutable'); END;
`;

/**
 * Version 3 makes retained non-Purchase Treasury Movements first-class journal
 * effects. Their capacity is counted in the same SQLite transaction as
 * Purchase reservations, eliminating the former split JSON accounting race.
 */
export const JOURNAL_SCHEMA_V3_MIGRATION_SQL = `
  CREATE TABLE treasury_operations (
    operation_key TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('wallet_send', 'vault_send', 'vault_deposit')),
    destination TEXT NOT NULL,
    requested_amount_atomic TEXT NOT NULL,
    keep_float_atomic TEXT,
    fee_ceiling_atomic TEXT NOT NULL,
    resolved_amount_atomic TEXT,
    fee_atomic TEXT,
    transaction_id TEXT UNIQUE,
    prepared_digest TEXT,
    prepared_ref TEXT UNIQUE,
    prepared_byte_length INTEGER,
    policy_digest TEXT NOT NULL REFERENCES policy_snapshots(digest) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN (
      'intent', 'prepared', 'submission_planned', 'submitted',
      'observed', 'completed', 'failed_terminal'
    )),
    retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    CHECK ((kind = 'vault_deposit') OR keep_float_atomic IS NULL),
    CHECK ((prepared_digest IS NULL AND prepared_ref IS NULL
            AND prepared_byte_length IS NULL AND transaction_id IS NULL
            AND fee_atomic IS NULL)
           OR
           (prepared_digest IS NOT NULL AND prepared_ref IS NOT NULL
            AND prepared_byte_length > 0 AND transaction_id IS NOT NULL
            AND resolved_amount_atomic IS NOT NULL AND fee_atomic IS NOT NULL))
  ) STRICT;

  CREATE UNIQUE INDEX one_unresolved_treasury_operation
    ON treasury_operations ((1))
    WHERE state NOT IN ('completed', 'failed_terminal');
  CREATE INDEX treasury_operation_capacity_window
    ON treasury_operations(state, completed_at_ms);

  CREATE TABLE treasury_operation_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_key TEXT NOT NULL REFERENCES treasury_operations(operation_key) ON DELETE RESTRICT,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE treasury_operation_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_key TEXT NOT NULL REFERENCES treasury_operations(operation_key) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('observed', 'not_submitted', 'pending')),
    detail_digest TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    UNIQUE (operation_key, status, detail_digest)
  ) STRICT;

  CREATE TRIGGER immutable_treasury_operation_preparation
    BEFORE UPDATE OF operation_key, request_digest, kind, destination,
                     requested_amount_atomic, keep_float_atomic, fee_ceiling_atomic,
                     resolved_amount_atomic, fee_atomic,
                     transaction_id, prepared_digest, prepared_ref,
                     prepared_byte_length, policy_digest
    ON treasury_operations
    WHEN OLD.prepared_digest IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Treasury operation intent and preparation are immutable'); END;
  CREATE TRIGGER immutable_treasury_operations_delete BEFORE DELETE ON treasury_operations
    BEGIN SELECT RAISE(ABORT, 'Treasury operations are immutable history'); END;
  CREATE TRIGGER immutable_treasury_operation_transitions_update BEFORE UPDATE ON treasury_operation_transitions
    BEGIN SELECT RAISE(ABORT, 'Treasury operation transitions are immutable'); END;
  CREATE TRIGGER immutable_treasury_operation_transitions_delete BEFORE DELETE ON treasury_operation_transitions
    BEGIN SELECT RAISE(ABORT, 'Treasury operation transitions are immutable'); END;
  CREATE TRIGGER immutable_treasury_operation_observations_update BEFORE UPDATE ON treasury_operation_observations
    BEGIN SELECT RAISE(ABORT, 'Treasury operation observations are immutable'); END;
  CREATE TRIGGER immutable_treasury_operation_observations_delete BEFORE DELETE ON treasury_operation_observations
    BEGIN SELECT RAISE(ABORT, 'Treasury operation observations are immutable'); END;
`;

/**
 * Version 4 makes abandoned staging recovery a dedicated durable effect. The
 * immutable sweep is persisted before observation or submission, and actual
 * recovery fees remain in the shared software-policy accounting window after
 * the reserved Merchant principal is returned.
 */
export const JOURNAL_SCHEMA_V4_MIGRATION_SQL = `
  CREATE TABLE treasury_staging_recovery_plans (
    effect_id TEXT PRIMARY KEY REFERENCES effects(id) ON DELETE RESTRICT,
    purchase_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    reservation_id TEXT NOT NULL UNIQUE,
    staging_effect_id TEXT NOT NULL UNIQUE REFERENCES treasury_staging_plans(effect_id) ON DELETE RESTRICT,
    payload_digest TEXT NOT NULL,
    prepared_ref TEXT NOT NULL,
    prepared_byte_length INTEGER NOT NULL CHECK (prepared_byte_length > 0),
    exact_transaction_id TEXT,
    recovery_transaction_id TEXT NOT NULL UNIQUE,
    recovery_outpoint TEXT NOT NULL UNIQUE,
    recovery_amount_atomic TEXT NOT NULL,
    staging_fee_atomic TEXT NOT NULL,
    recovery_fee_atomic TEXT NOT NULL,
    required_finality TEXT NOT NULL,
    authorized_additional_cost_ceiling_atomic TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (purchase_id, attempt),
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT,
    FOREIGN KEY (reservation_id, purchase_id)
      REFERENCES treasury_reservations(id, purchase_id) ON DELETE RESTRICT,
    CHECK (exact_transaction_id IS NULL OR exact_transaction_id <> recovery_transaction_id)
  ) STRICT;

  CREATE TABLE treasury_staging_recovery_observations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    effect_id TEXT NOT NULL REFERENCES treasury_staging_recovery_plans(effect_id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN (
      'safe_to_submit', 'pending', 'exact_payment_won', 'recovery_won', 'conflict'
    )),
    evidence_digest TEXT NOT NULL,
    readiness_proof_digest TEXT,
    readiness_observed_at_ms INTEGER,
    readiness_expires_at_ms INTEGER,
    winning_transaction_id TEXT,
    winning_finality TEXT,
    recovery_outpoint TEXT,
    recovery_amount_atomic TEXT,
    conflict_reason TEXT,
    lease_name TEXT NOT NULL,
    lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
    observed_at_ms INTEGER NOT NULL,
    CHECK (
      (status = 'safe_to_submit' AND readiness_proof_digest IS NOT NULL
        AND readiness_observed_at_ms IS NOT NULL AND readiness_expires_at_ms IS NOT NULL)
      OR
      (status <> 'safe_to_submit' AND readiness_proof_digest IS NULL
        AND readiness_observed_at_ms IS NULL AND readiness_expires_at_ms IS NULL)
    ),
    CHECK ((status = 'conflict') = (conflict_reason IS NOT NULL)),
    UNIQUE (effect_id, status, evidence_digest)
  ) STRICT;

  CREATE TABLE treasury_staging_recovery_accounting (
    effect_id TEXT PRIMARY KEY REFERENCES treasury_staging_recovery_plans(effect_id) ON DELETE RESTRICT,
    reservation_id TEXT NOT NULL UNIQUE,
    purchase_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    recovery_transaction_id TEXT NOT NULL UNIQUE,
    recovery_outpoint TEXT NOT NULL UNIQUE,
    returned_amount_atomic TEXT NOT NULL,
    staging_fee_atomic TEXT NOT NULL,
    recovery_fee_atomic TEXT NOT NULL,
    actual_additional_cost_atomic TEXT NOT NULL,
    finality TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    FOREIGN KEY (purchase_id, attempt)
      REFERENCES payment_attempts(purchase_id, attempt) ON DELETE RESTRICT,
    FOREIGN KEY (reservation_id, purchase_id)
      REFERENCES treasury_reservations(id, purchase_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX treasury_staging_recovery_policy_window
    ON treasury_staging_recovery_accounting(observed_at_ms);

  CREATE TRIGGER immutable_treasury_staging_recovery_plans_update
    BEFORE UPDATE ON treasury_staging_recovery_plans
    BEGIN SELECT RAISE(ABORT, 'treasury staging recovery plans are immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_recovery_plans_delete
    BEFORE DELETE ON treasury_staging_recovery_plans
    BEGIN SELECT RAISE(ABORT, 'treasury staging recovery plans are immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_recovery_observations_update
    BEFORE UPDATE ON treasury_staging_recovery_observations
    BEGIN SELECT RAISE(ABORT, 'treasury staging recovery observations are immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_recovery_observations_delete
    BEFORE DELETE ON treasury_staging_recovery_observations
    BEGIN SELECT RAISE(ABORT, 'treasury staging recovery observations are immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_recovery_accounting_update
    BEFORE UPDATE ON treasury_staging_recovery_accounting
    BEGIN SELECT RAISE(ABORT, 'treasury staging recovery accounting is immutable'); END;
  CREATE TRIGGER immutable_treasury_staging_recovery_accounting_delete
    BEFORE DELETE ON treasury_staging_recovery_accounting
    BEGIN SELECT RAISE(ABORT, 'treasury staging recovery accounting is immutable'); END;
`;

/** Clean-cutover schema epoch for immutable Operator Manifest provenance. */
export const JOURNAL_SCHEMA_V5_MIGRATION_SQL = `
  CREATE TABLE operator_manifest_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    digest TEXT NOT NULL CHECK (length(digest) = 50 AND digest GLOB 'sha256:*'),
    bound_at_ms INTEGER NOT NULL,
    UNIQUE (revision, digest)
  ) STRICT;

  CREATE TRIGGER immutable_operator_manifest_binding_update
    BEFORE UPDATE ON operator_manifest_binding
    BEGIN SELECT RAISE(ABORT, 'Operator Manifest binding is immutable'); END;
  CREATE TRIGGER immutable_operator_manifest_binding_delete
    BEFORE DELETE ON operator_manifest_binding
    BEGIN SELECT RAISE(ABORT, 'Operator Manifest binding is immutable'); END;
`;

/** Clean-cutover epoch for durable, source-separated Chain Evidence. */
export const JOURNAL_SCHEMA_V6_MIGRATION_SQL = `
  ALTER TABLE authorization_requests
    ADD COLUMN effective_finality_floor TEXT NOT NULL DEFAULT 'accepted'
    CHECK (effective_finality_floor IN ('accepted', 'depth-confirmed'));

  CREATE TABLE chain_evidence (
    detail_digest TEXT PRIMARY KEY CHECK (length(detail_digest) = 50 AND detail_digest GLOB 'sha256:*'),
    profile TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('settlement', 'direct-treasury', 'vault', 'staging', 'recovery-release')),
    transaction_id TEXT NOT NULL CHECK (length(transaction_id) = 64),
    status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'unknown', 'unavailable')),
    level TEXT CHECK (level IN ('provisional', 'accepted', 'depth-confirmed', 'consensus-final')),
    view TEXT CHECK (view IN ('current', 'historical')),
    mechanism TEXT NOT NULL CHECK (mechanism IN ('ordinary', 'native-covenant', 'kip10-script-template')),
    protocol_finality TEXT NOT NULL CHECK (protocol_finality IN ('mempool', 'accepted', 'confirmed')),
    operator_floor TEXT NOT NULL CHECK (operator_floor IN ('accepted', 'depth-confirmed')),
    effective_floor TEXT NOT NULL CHECK (effective_floor IN ('accepted', 'depth-confirmed')),
    primary_profile TEXT NOT NULL,
    witness_profile TEXT NOT NULL,
    block_hash TEXT,
    accepting_block_hash TEXT,
    accepting_block_daa_score TEXT,
    virtual_daa_score TEXT,
    outputs_digest TEXT NOT NULL CHECK (length(outputs_digest) = 50 AND outputs_digest GLOB 'sha256:*'),
    observed_at_ms INTEGER NOT NULL,
    manifest_revision INTEGER NOT NULL,
    manifest_digest TEXT NOT NULL,
    FOREIGN KEY (manifest_revision, manifest_digest)
      REFERENCES operator_manifest_binding(revision, digest) ON DELETE RESTRICT,
    CHECK ((status = 'present') = (level IS NOT NULL AND view IS NOT NULL)),
    CHECK ((level IN ('accepted', 'depth-confirmed', 'consensus-final')) = (block_hash IS NOT NULL AND accepting_block_hash IS NOT NULL AND accepting_block_daa_score IS NOT NULL AND virtual_daa_score IS NOT NULL))
  ) STRICT;

  CREATE INDEX accepted_chain_evidence
    ON chain_evidence(transaction_id, level, observed_at_ms)
    WHERE status = 'present' AND level IN ('accepted', 'depth-confirmed', 'consensus-final');

  CREATE TRIGGER immutable_chain_evidence_update BEFORE UPDATE ON chain_evidence
    BEGIN SELECT RAISE(ABORT, 'Chain Evidence is immutable'); END;
  CREATE TRIGGER immutable_chain_evidence_delete BEFORE DELETE ON chain_evidence
    BEGIN SELECT RAISE(ABORT, 'Chain Evidence is immutable'); END;
`;

/** Clean-cutover epoch for boundary-owned durable Admission Leases. */
export const JOURNAL_SCHEMA_V7_MIGRATION_SQL = `
  ALTER TABLE treasury_operations
    ADD COLUMN retry_limit INTEGER NOT NULL DEFAULT 3 CHECK (retry_limit > 0);
  ALTER TABLE treasury_operations
    ADD COLUMN cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1));
  ALTER TABLE treasury_operations
    ADD COLUMN preparation_fenced INTEGER NOT NULL DEFAULT 0 CHECK (preparation_fenced IN (0, 1));

  CREATE TABLE journal_admission_budget (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    prevalidation_purchase_limit INTEGER NOT NULL CHECK (prevalidation_purchase_limit > 0),
    evidence_byte_limit INTEGER NOT NULL CHECK (evidence_byte_limit > 0),
    direct_treasury_retry_limit INTEGER NOT NULL CHECK (direct_treasury_retry_limit > 0),
    reserved_purchase_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_purchase_count >= 0),
    reserved_evidence_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_evidence_bytes >= 0),
    committed_evidence_bytes INTEGER NOT NULL DEFAULT 0 CHECK (committed_evidence_bytes >= 0),
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE admission_leases (
    lease_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    resource TEXT NOT NULL CHECK (resource IN ('prevalidation_purchase', 'evidence_bytes')),
    purchase_id TEXT REFERENCES purchases(id) ON DELETE RESTRICT,
    digest TEXT,
    storage_ref TEXT,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    state TEXT NOT NULL CHECK (state IN (
      'offered', 'admitted', 'active', 'completed', 'cancelled', 'expired', 'failed_terminal'
    )),
    deadline_at_ms INTEGER,
    outcome TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    CHECK (resource <> 'prevalidation_purchase' OR purchase_id IS NOT NULL),
    CHECK (resource <> 'evidence_bytes' OR digest IS NOT NULL),
    CHECK (state IN ('offered', 'admitted', 'active') OR outcome IS NOT NULL)
  ) STRICT;

  CREATE INDEX active_admission_leases
    ON admission_leases(resource, state, deadline_at_ms);

  CREATE TRIGGER immutable_admission_leases_delete
    BEFORE DELETE ON admission_leases
    BEGIN SELECT RAISE(ABORT, 'Admission Leases are immutable history'); END;
`;

/** Clean-cutover epoch for Journal-owned Treasury driver generations. */
export const JOURNAL_SCHEMA_V8_MIGRATION_SQL = `
  ALTER TABLE treasury_operations
    ADD COLUMN driver_owner TEXT;
  ALTER TABLE treasury_operations
    ADD COLUMN driver_generation INTEGER NOT NULL DEFAULT 0 CHECK (driver_generation >= 0);
  ALTER TABLE treasury_operations
    ADD COLUMN driver_lease_expires_at_ms INTEGER;
  ALTER TABLE treasury_operations
    ADD COLUMN effect_capability_generation INTEGER;

  CREATE INDEX treasury_operation_driver_lease
    ON treasury_operations(driver_owner, driver_generation, driver_lease_expires_at_ms);

  CREATE TABLE purchase_admission_intents (
    admission_id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL UNIQUE,
    request_key TEXT NOT NULL UNIQUE,
    resource_url TEXT NOT NULL,
    method TEXT NOT NULL,
    resource_fingerprint TEXT NOT NULL,
    expected_merchant_id TEXT,
    expected_merchant_origin TEXT,
    evidence_digest TEXT NOT NULL,
    evidence_byte_length INTEGER NOT NULL CHECK (evidence_byte_length >= 0),
    evidence_storage_ref TEXT NOT NULL,
    evidence_media_type TEXT NOT NULL,
    evidence_profile TEXT NOT NULL,
    evidence_issuer TEXT,
    evidence_kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('offered', 'staged', 'committed', 'cancelled', 'expired', 'failed_terminal')),
    owner TEXT NOT NULL,
    deadline_at_ms INTEGER NOT NULL,
    outcome TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    CHECK (state IN ('offered', 'staged') OR outcome IS NOT NULL)
  ) STRICT;

  CREATE INDEX active_purchase_admission_intents
    ON purchase_admission_intents(state, deadline_at_ms, evidence_digest);

  CREATE TRIGGER immutable_purchase_admission_intents_delete
    BEFORE DELETE ON purchase_admission_intents
    BEGIN SELECT RAISE(ABORT, 'Purchase admission intent history is immutable'); END;
`;

export const JOURNAL_SCHEMA_V2_SQL = `${JOURNAL_SCHEMA_V1_SQL}\n${JOURNAL_SCHEMA_V2_MIGRATION_SQL}`;
export const JOURNAL_SCHEMA_V3_SQL = `${JOURNAL_SCHEMA_V2_SQL}\n${JOURNAL_SCHEMA_V3_MIGRATION_SQL}`;
export const JOURNAL_SCHEMA_V4_SQL = `${JOURNAL_SCHEMA_V3_SQL}\n${JOURNAL_SCHEMA_V4_MIGRATION_SQL}`;
export const JOURNAL_SCHEMA_V5_SQL = `${JOURNAL_SCHEMA_V4_SQL}\n${JOURNAL_SCHEMA_V5_MIGRATION_SQL}`;
export const JOURNAL_SCHEMA_V6_SQL = `${JOURNAL_SCHEMA_V5_SQL}\n${JOURNAL_SCHEMA_V6_MIGRATION_SQL}`;
export const JOURNAL_SCHEMA_V7_SQL = `${JOURNAL_SCHEMA_V6_SQL}\n${JOURNAL_SCHEMA_V7_MIGRATION_SQL}`;
export const JOURNAL_SCHEMA_V8_SQL = `${JOURNAL_SCHEMA_V7_SQL}\n${JOURNAL_SCHEMA_V8_MIGRATION_SQL}`;
export const JOURNAL_SCHEMA_SQL = JOURNAL_SCHEMA_V8_SQL;

export const JOURNAL_SCHEMA_V1_CHECKSUM = sha256Text(JOURNAL_SCHEMA_V1_SQL);
export const JOURNAL_SCHEMA_V2_CHECKSUM = sha256Text(JOURNAL_SCHEMA_V2_SQL);
export const JOURNAL_SCHEMA_V3_CHECKSUM = sha256Text(JOURNAL_SCHEMA_V3_SQL);
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
let expectedV1Fingerprint: string | undefined;
let expectedV2Fingerprint: string | undefined;
let expectedV3Fingerprint: string | undefined;

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

export function expectedV1SchemaFingerprint(): string {
  if (expectedV1Fingerprint) return expectedV1Fingerprint;
  const expected = new Database(":memory:");
  try {
    expected.exec(JOURNAL_SCHEMA_V1_SQL);
    expectedV1Fingerprint = schemaFingerprint(expected);
    return expectedV1Fingerprint;
  } finally {
    expected.close();
  }
}

export function expectedV2SchemaFingerprint(): string {
  if (expectedV2Fingerprint) return expectedV2Fingerprint;
  const expected = new Database(":memory:");
  try {
    expected.exec(JOURNAL_SCHEMA_V2_SQL);
    expectedV2Fingerprint = schemaFingerprint(expected);
    return expectedV2Fingerprint;
  } finally {
    expected.close();
  }
}

export function expectedV3SchemaFingerprint(): string {
  if (expectedV3Fingerprint) return expectedV3Fingerprint;
  const expected = new Database(":memory:");
  try {
    expected.exec(JOURNAL_SCHEMA_V3_SQL);
    expectedV3Fingerprint = schemaFingerprint(expected);
    return expectedV3Fingerprint;
  } finally {
    expected.close();
  }
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}
