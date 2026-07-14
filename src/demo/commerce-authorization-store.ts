import { createHash } from "node:crypto";

import Database from "better-sqlite3";

import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { prepareSecureSqlitePath, validateSecureSqlitePath } from "./secure-sqlite-path.js";

const APPLICATION_ID = 0x53444341;
const SCHEMA_VERSION = 1;
const PURCHASE_ID = /^pur_[A-Za-z0-9_-]{22}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9_-]{43}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const REFERENCE = /^[A-Za-z0-9_-]{43}$/;
const MAX_ARTIFACT_BYTES = 64 * 1024;

const SCHEMA_SQL = `
CREATE TABLE demo_commerce_authorization_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_checksum TEXT NOT NULL
) STRICT;

CREATE TABLE checkout_authorizations (
  purchase_id TEXT PRIMARY KEY,
  checkout_digest TEXT NOT NULL,
  authorization_evidence_digest TEXT NOT NULL,
  checkout_artifact TEXT NOT NULL,
  mandate_artifact TEXT NOT NULL,
  mandate_digest TEXT NOT NULL,
  mandate_reference TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms > 0)
) STRICT;

CREATE TABLE payment_authorizations (
  payment_identifier TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE,
  checkout_digest TEXT NOT NULL,
  authorization_evidence_digest TEXT NOT NULL,
  mandate_artifact TEXT NOT NULL,
  mandate_digest TEXT NOT NULL,
  mandate_reference TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms > 0),
  FOREIGN KEY (purchase_id) REFERENCES checkout_authorizations(purchase_id)
) STRICT;
`;

const SCHEMA_CHECKSUM = digestText(SCHEMA_SQL);

export interface DemoCheckoutAuthorizationInput {
  readonly purchaseId: PurchaseId;
  readonly checkoutDigest: Sha256Digest;
  readonly authorizationEvidenceDigest: Sha256Digest;
  readonly checkoutArtifact: string;
  readonly mandateArtifact: string;
  readonly mandateDigest: Sha256Digest;
  readonly mandateReference: string;
}

export interface DemoCheckoutAuthorizationRecord
  extends DemoCheckoutAuthorizationInput {
  readonly acceptedAtMs: number;
}

export interface DemoPaymentAuthorizationInput {
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly checkoutDigest: Sha256Digest;
  readonly authorizationEvidenceDigest: Sha256Digest;
  readonly mandateArtifact: string;
  readonly mandateDigest: Sha256Digest;
  readonly mandateReference: string;
}

export interface DemoPaymentAuthorizationRecord
  extends DemoPaymentAuthorizationInput {
  readonly acceptedAtMs: number;
}

export interface DemoCommerceAuthorizationStore {
  saveCheckout(
    input: Readonly<DemoCheckoutAuthorizationInput>
  ): DemoCheckoutAuthorizationRecord;
  savePayment(
    input: Readonly<DemoPaymentAuthorizationInput>
  ): DemoPaymentAuthorizationRecord;
  loadCheckout(purchaseId: PurchaseId): DemoCheckoutAuthorizationRecord | undefined;
  loadPayment(paymentIdentifier: string): DemoPaymentAuthorizationRecord | undefined;
}

export class DemoCommerceAuthorizationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoCommerceAuthorizationStoreError";
  }
}

/** Durable, immutable AP2 presentation records for the demo Merchant fixture. */
export class SqliteDemoCommerceAuthorizationStore
implements DemoCommerceAuthorizationStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(
    readonly filename: string,
    options: { readonly now?: () => number; readonly busyTimeoutMs?: number } = {}
  ) {
    this.now = options.now ?? Date.now;
    let pathInfo;
    try {
      pathInfo = prepareSecureSqlitePath(filename, "demo commerce authorization store");
    } catch {
      throw new DemoCommerceAuthorizationStoreError(
        "demo commerce authorization store is unavailable"
      );
    }
    this.db = new Database(filename);
    try {
      const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
      if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
        throw new DemoCommerceAuthorizationStoreError("invalid busy timeout");
      }
      this.db.pragma("trusted_schema = OFF");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      if (filename !== ":memory:") this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      validateSecureSqlitePath(pathInfo);
      this.initialize();
      this.verify();
    } catch (error) {
      if (this.db.open) this.db.close();
      if (error instanceof DemoCommerceAuthorizationStoreError) throw error;
      throw new DemoCommerceAuthorizationStoreError(
        "demo commerce authorization store is unavailable"
      );
    }
  }

  close(): void {
    if (!this.db.open) return;
    if (this.filename !== ":memory:") this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  saveCheckout(
    input: Readonly<DemoCheckoutAuthorizationInput>
  ): DemoCheckoutAuthorizationRecord {
    validateCheckout(input);
    const save = this.db.transaction(() => {
      const existing = this.loadCheckout(input.purchaseId);
      if (existing) {
        assertSameCheckout(existing, input);
        return existing;
      }
      const acceptedAtMs = timestamp(this.now);
      this.db.prepare(
        `INSERT INTO checkout_authorizations (
           purchase_id, checkout_digest, authorization_evidence_digest,
           checkout_artifact, mandate_artifact, mandate_digest,
           mandate_reference, accepted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.purchaseId,
        input.checkoutDigest,
        input.authorizationEvidenceDigest,
        input.checkoutArtifact,
        input.mandateArtifact,
        input.mandateDigest,
        input.mandateReference,
        acceptedAtMs
      );
      return this.loadCheckout(input.purchaseId)!;
    });
    return save.immediate();
  }

  savePayment(
    input: Readonly<DemoPaymentAuthorizationInput>
  ): DemoPaymentAuthorizationRecord {
    validatePayment(input);
    const save = this.db.transaction(() => {
      const checkout = this.loadCheckout(input.purchaseId);
      if (!checkout || checkout.checkoutDigest !== input.checkoutDigest) {
        throw new DemoCommerceAuthorizationStoreError(
          "Payment Mandate cannot precede its exact Checkout Mandate"
        );
      }
      const existing = this.loadPayment(input.paymentIdentifier);
      if (existing) {
        assertSamePayment(existing, input);
        return existing;
      }
      const acceptedAtMs = timestamp(this.now);
      this.db.prepare(
        `INSERT INTO payment_authorizations (
           payment_identifier, purchase_id, checkout_digest,
           authorization_evidence_digest, mandate_artifact, mandate_digest,
           mandate_reference, accepted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.paymentIdentifier,
        input.purchaseId,
        input.checkoutDigest,
        input.authorizationEvidenceDigest,
        input.mandateArtifact,
        input.mandateDigest,
        input.mandateReference,
        acceptedAtMs
      );
      return this.loadPayment(input.paymentIdentifier)!;
    });
    return save.immediate();
  }

  loadCheckout(
    purchaseId: PurchaseId
  ): DemoCheckoutAuthorizationRecord | undefined {
    requirePurchaseId(purchaseId);
    const row = this.db.prepare(
      "SELECT * FROM checkout_authorizations WHERE purchase_id = ?"
    ).get(purchaseId) as CheckoutRow | undefined;
    return row ? Object.freeze({
      purchaseId: row.purchase_id as PurchaseId,
      checkoutDigest: row.checkout_digest as Sha256Digest,
      authorizationEvidenceDigest: row.authorization_evidence_digest as Sha256Digest,
      checkoutArtifact: row.checkout_artifact,
      mandateArtifact: row.mandate_artifact,
      mandateDigest: row.mandate_digest as Sha256Digest,
      mandateReference: row.mandate_reference,
      acceptedAtMs: row.accepted_at_ms,
    }) : undefined;
  }

  loadPayment(
    paymentIdentifier: string
  ): DemoPaymentAuthorizationRecord | undefined {
    requirePaymentId(paymentIdentifier);
    const row = this.db.prepare(
      "SELECT * FROM payment_authorizations WHERE payment_identifier = ?"
    ).get(paymentIdentifier) as PaymentRow | undefined;
    return row ? Object.freeze({
      purchaseId: row.purchase_id as PurchaseId,
      paymentIdentifier: row.payment_identifier,
      checkoutDigest: row.checkout_digest as Sha256Digest,
      authorizationEvidenceDigest: row.authorization_evidence_digest as Sha256Digest,
      mandateArtifact: row.mandate_artifact,
      mandateDigest: row.mandate_digest as Sha256Digest,
      mandateReference: row.mandate_reference,
      acceptedAtMs: row.accepted_at_ms,
    }) : undefined;
  }

  private initialize(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    const applicationId = this.db.pragma("application_id", { simple: true }) as number;
    if (version === SCHEMA_VERSION && applicationId === APPLICATION_ID) return;
    if (version !== 0 || applicationId !== 0) {
      throw new DemoCommerceAuthorizationStoreError("unsupported store schema");
    }
    const count = this.db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
    ).get() as { count: number };
    if (count.count !== 0) {
      throw new DemoCommerceAuthorizationStoreError("refusing unversioned store schema");
    }
    const initialize = this.db.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare(
        "INSERT INTO demo_commerce_authorization_meta (singleton, schema_checksum) VALUES (1, ?)"
      ).run(SCHEMA_CHECKSUM);
      this.db.pragma(`application_id = ${APPLICATION_ID}`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();
  }

  private verify(): void {
    const meta = this.db.prepare(
      "SELECT schema_checksum FROM demo_commerce_authorization_meta WHERE singleton = 1"
    ).get() as { schema_checksum: string } | undefined;
    const integrity = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (
      (this.db.pragma("application_id", { simple: true }) as number) !== APPLICATION_ID ||
      (this.db.pragma("user_version", { simple: true }) as number) !== SCHEMA_VERSION ||
      meta?.schema_checksum !== SCHEMA_CHECKSUM ||
      integrity.length !== 1 ||
      integrity[0].integrity_check !== "ok" ||
      (this.db.pragma("foreign_key_check") as unknown[]).length !== 0
    ) {
      throw new DemoCommerceAuthorizationStoreError("store failed integrity checks");
    }
  }
}

interface CheckoutRow {
  purchase_id: string;
  checkout_digest: string;
  authorization_evidence_digest: string;
  checkout_artifact: string;
  mandate_artifact: string;
  mandate_digest: string;
  mandate_reference: string;
  accepted_at_ms: number;
}

interface PaymentRow {
  payment_identifier: string;
  purchase_id: string;
  checkout_digest: string;
  authorization_evidence_digest: string;
  mandate_artifact: string;
  mandate_digest: string;
  mandate_reference: string;
  accepted_at_ms: number;
}

function validateCheckout(input: DemoCheckoutAuthorizationInput): void {
  requirePurchaseId(input.purchaseId);
  requireDigest(input.checkoutDigest);
  requireDigest(input.authorizationEvidenceDigest);
  requireArtifact(input.checkoutArtifact, "Merchant Checkout");
  requireArtifact(input.mandateArtifact, "Checkout Mandate");
  requireDigest(input.mandateDigest);
  requireReference(input.mandateReference);
}

function validatePayment(input: DemoPaymentAuthorizationInput): void {
  requirePurchaseId(input.purchaseId);
  requirePaymentId(input.paymentIdentifier);
  requireDigest(input.checkoutDigest);
  requireDigest(input.authorizationEvidenceDigest);
  requireArtifact(input.mandateArtifact, "Payment Mandate");
  requireDigest(input.mandateDigest);
  requireReference(input.mandateReference);
}

function assertSameCheckout(
  actual: DemoCheckoutAuthorizationRecord,
  expected: DemoCheckoutAuthorizationInput
): void {
  const fields: ReadonlyArray<keyof DemoCheckoutAuthorizationInput> = [
    "purchaseId", "checkoutDigest", "authorizationEvidenceDigest", "checkoutArtifact", "mandateArtifact",
    "mandateDigest", "mandateReference",
  ];
  if (fields.some((field) => actual[field] !== expected[field])) {
    throw new DemoCommerceAuthorizationStoreError("conflicting Checkout authorization replay");
  }
}

function assertSamePayment(
  actual: DemoPaymentAuthorizationRecord,
  expected: DemoPaymentAuthorizationInput
): void {
  const fields: ReadonlyArray<keyof DemoPaymentAuthorizationInput> = [
    "purchaseId", "paymentIdentifier", "checkoutDigest", "authorizationEvidenceDigest", "mandateArtifact",
    "mandateDigest", "mandateReference",
  ];
  if (fields.some((field) => actual[field] !== expected[field])) {
    throw new DemoCommerceAuthorizationStoreError("conflicting Payment authorization replay");
  }
}

function requirePurchaseId(value: string): void {
  if (!PURCHASE_ID.test(value)) throw new DemoCommerceAuthorizationStoreError("invalid Purchase identity");
}

function requirePaymentId(value: string): void {
  if (!PAYMENT_ID.test(value)) throw new DemoCommerceAuthorizationStoreError("invalid Payment identity");
}

function requireDigest(value: string): void {
  if (!DIGEST.test(value)) throw new DemoCommerceAuthorizationStoreError("invalid evidence digest");
}

function requireReference(value: string): void {
  if (!REFERENCE.test(value)) throw new DemoCommerceAuthorizationStoreError("invalid mandate reference");
}

function requireArtifact(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ARTIFACT_BYTES ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new DemoCommerceAuthorizationStoreError(`${label} is invalid`);
  }
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DemoCommerceAuthorizationStoreError("store clock is unavailable");
  }
  return value;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}
