import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { JournalInvariantError, PurchaseJournal } from "./journal.js";
import {
  JOURNAL_APPLICATION_ID,
  JOURNAL_SCHEMA_CHECKSUM,
  JOURNAL_SCHEMA_V1_CHECKSUM,
  JOURNAL_SCHEMA_V1_SQL,
  JOURNAL_SCHEMA_VERSION,
} from "./journal-schema.js";

test("a verified v1 journal migrates transactionally to canonical Purchase facts v2", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-migrate-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  try {
    createV1(filename);
    const journal = new PurchaseJournal(filename, { now: () => 1_800_000_000_000 });
    assert.equal(journal.schemaVersion(), JOURNAL_SCHEMA_VERSION);
    journal.close();
    const raw = new Database(filename, { readonly: true });
    const migrations = raw.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(migrations, [
      { version: 1, checksum: JOURNAL_SCHEMA_V1_CHECKSUM },
      { version: 2, checksum: JOURNAL_SCHEMA_CHECKSUM },
    ]);
    const tables = raw
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('checkout_terms', 'purchase_authorizations', 'fulfilments', 'purchase_receipts') ORDER BY name")
      .all();
    assert.deepEqual(tables, [
      { name: "checkout_terms" },
      { name: "fulfilments" },
      { name: "purchase_authorizations" },
      { name: "purchase_receipts" },
    ]);
    raw.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v1 migration rejects checksum or schema drift before applying v2", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-migrate-reject-"));
  fs.chmodSync(directory, 0o700);
  try {
    const checksumPath = path.join(directory, "checksum.sqlite");
    createV1(checksumPath, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.throws(() => new PurchaseJournal(checksumPath), JournalInvariantError);

    const driftPath = path.join(directory, "drift.sqlite");
    createV1(driftPath);
    const drift = new Database(driftPath);
    drift.exec("CREATE TABLE injected_state (id INTEGER)");
    drift.close();
    assert.throws(() => new PurchaseJournal(driftPath), JournalInvariantError);

    const nonEmptyPath = path.join(directory, "non-empty.sqlite");
    createV1(nonEmptyPath);
    const nonEmpty = new Database(nonEmptyPath);
    nonEmpty.prepare(
      `INSERT INTO purchases
         (id, request_key, state, resource_url, method, resource_fingerprint,
          expected_merchant_id, expected_merchant_origin, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'created', ?, 'GET', ?, NULL, NULL, 0, 1, 1)`
    ).run(
      "pur_AAAAAAAAAAAAAAAAAAAAAA",
      "migration:test",
      "https://merchant.example/resource",
      "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    nonEmpty.prepare(
      `INSERT INTO purchase_transitions
         (purchase_id, from_state, to_state, reason_code, created_at_ms)
       VALUES (?, NULL, 'created', 'purchase_created', 1)`
    ).run("pur_AAAAAAAAAAAAAAAAAAAAAA");
    nonEmpty.close();
    assert.throws(() => new PurchaseJournal(nonEmptyPath), /clean cutover refuses non-empty v1/);
    const stillV1 = new Database(nonEmptyPath, { readonly: true });
    assert.equal(stillV1.pragma("user_version", { simple: true }), 1);
    stillV1.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createV1(filename: string, checksum = JOURNAL_SCHEMA_V1_CHECKSUM): void {
  const db = new Database(filename);
  db.exec(JOURNAL_SCHEMA_V1_SQL);
  db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at_ms) VALUES (1, ?, ?)")
    .run(checksum, 1_700_000_000_000);
  db.pragma(`application_id = ${JOURNAL_APPLICATION_ID}`);
  db.pragma("user_version = 1");
  db.close();
}
