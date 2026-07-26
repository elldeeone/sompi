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
  JOURNAL_SCHEMA_V7_SQL,
  JOURNAL_SCHEMA_V8_SQL,
  JOURNAL_SCHEMA_V9_SQL,
  JOURNAL_SCHEMA_V10_SQL,
  JOURNAL_SCHEMA_V11_SQL,
  JOURNAL_SCHEMA_V12_SQL,
  JOURNAL_SCHEMA_V13_SQL,
  JOURNAL_SCHEMA_V15_SQL,
  JOURNAL_SCHEMA_V16_SQL,
  JOURNAL_SCHEMA_V17_SQL,
  JOURNAL_SCHEMA_V18_SQL,
  JOURNAL_SCHEMA_V19_SQL,
  JOURNAL_SCHEMA_V1_SQL,
  JOURNAL_SCHEMA_VERSION,
} from "./journal-schema.js";

test("clean cutover rejects every superseded journal schema without mutation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-migrate-"));
  fs.chmodSync(directory, 0o700);
  try {
    const schemas: ReadonlyArray<readonly [number, string]> = [
      [1, JOURNAL_SCHEMA_V1_SQL], [2, JOURNAL_SCHEMA_V2_SQL], [3, JOURNAL_SCHEMA_V3_SQL],
      [4, JOURNAL_SCHEMA_V4_SQL], [5, JOURNAL_SCHEMA_V5_SQL], [6, JOURNAL_SCHEMA_V6_SQL],
      [7, JOURNAL_SCHEMA_V7_SQL], [8, JOURNAL_SCHEMA_V8_SQL], [9, JOURNAL_SCHEMA_V9_SQL],
      [10, JOURNAL_SCHEMA_V10_SQL], [11, JOURNAL_SCHEMA_V11_SQL], [12, JOURNAL_SCHEMA_V12_SQL],
      [13, JOURNAL_SCHEMA_V13_SQL], [14, JOURNAL_SCHEMA_V15_SQL], [15, JOURNAL_SCHEMA_V15_SQL],
      [16, JOURNAL_SCHEMA_V16_SQL], [17, JOURNAL_SCHEMA_V17_SQL], [18, JOURNAL_SCHEMA_V18_SQL],
      [19, JOURNAL_SCHEMA_V19_SQL],
    ];
    for (const [version, schema] of schemas) {
      const filename = path.join(directory, `v${version}.sqlite`);
      const db = new Database(filename);
      db.exec(schema);
      db.pragma(`application_id = ${JOURNAL_APPLICATION_ID}`);
      db.pragma(`user_version = ${version}`);
      db.close();
      // better-sqlite3 honours the process umask. Make the legacy fixture meet
      // the Journal's 0600 precondition so this test reaches the schema-epoch
      // rejection under both developer and GitHub Actions umasks.
      fs.chmodSync(filename, 0o600);
      const before = fs.readFileSync(filename);
      assert.equal(fs.existsSync(`${filename}-wal`), false);
      assert.equal(fs.existsSync(`${filename}-shm`), false);
      assert.throws(
        () => new PurchaseJournal(filename),
        new RegExp(`clean cutover refuses Purchase Journal schema ${version}`)
      );
      assert.deepEqual(fs.readFileSync(filename), before);
      assert.equal(fs.existsSync(`${filename}-wal`), false);
      assert.equal(fs.existsSync(`${filename}-shm`), false);
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
