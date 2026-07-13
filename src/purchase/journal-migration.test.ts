import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { JournalInvariantError, PurchaseJournal } from "./journal.js";
import {
  JOURNAL_APPLICATION_ID,
  JOURNAL_SCHEMA_V1_CHECKSUM,
  JOURNAL_SCHEMA_V2_SQL,
  JOURNAL_SCHEMA_V3_SQL,
  JOURNAL_SCHEMA_V4_SQL,
  JOURNAL_SCHEMA_V5_SQL,
  JOURNAL_SCHEMA_V6_SQL,
  JOURNAL_SCHEMA_V1_SQL,
  JOURNAL_SCHEMA_VERSION,
} from "./journal-schema.js";

test("clean cutover rejects every superseded journal schema without mutation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-migrate-"));
  fs.chmodSync(directory, 0o700);
  try {
    const schemas = [JOURNAL_SCHEMA_V1_SQL, JOURNAL_SCHEMA_V2_SQL, JOURNAL_SCHEMA_V3_SQL, JOURNAL_SCHEMA_V4_SQL, JOURNAL_SCHEMA_V5_SQL, JOURNAL_SCHEMA_V6_SQL];
    for (let index = 0; index < schemas.length; index += 1) {
      const version = index + 1;
      const filename = path.join(directory, `v${version}.sqlite`);
      const db = new Database(filename);
      db.exec(schemas[index]);
      db.pragma(`application_id = ${JOURNAL_APPLICATION_ID}`);
      db.pragma(`user_version = ${version}`);
      db.close();
      assert.throws(
        () => new PurchaseJournal(filename),
        new RegExp(`clean cutover refuses Purchase Journal schema ${version}`)
      );
      const untouched = new Database(filename, { readonly: true });
      assert.equal(untouched.pragma("user_version", { simple: true }), version);
      untouched.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clean cutover initializes only a fresh schema epoch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-migrate-reject-"));
  fs.chmodSync(directory, 0o700);
  try {
    const freshPath = path.join(directory, "fresh.sqlite");
    const journal = new PurchaseJournal(freshPath);
    assert.equal(journal.schemaVersion(), JOURNAL_SCHEMA_VERSION);
    journal.close();

    const foreignPath = path.join(directory, "foreign.sqlite");
    const foreign = new Database(foreignPath);
    foreign.exec("CREATE TABLE injected_state (id INTEGER)");
    foreign.close();
    assert.throws(() => new PurchaseJournal(foreignPath), JournalInvariantError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
