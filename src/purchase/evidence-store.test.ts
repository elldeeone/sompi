import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { EvidenceStore, EvidenceStoreError } from "./evidence-store.js";
import { evidenceDigest } from "./identity.js";
import type { Sha256Digest } from "./types.js";

test("stores content by digest with secure modes and a relative reference", () => {
  withStore(({ directory, store }) => {
    const bytes = Buffer.from("signed protocol evidence\n", "utf8");
    const stored = store.store(bytes);

    assert.equal(stored.digest, evidenceDigest(bytes));
    assert.equal(stored.byteLength, bytes.byteLength);
    assert.equal(path.isAbsolute(stored.storageRef), false);
    assert.equal(path.dirname(stored.storageRef), ".");
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, stored.storageRef)).mode & 0o777, 0o600);
    assert.deepEqual(store.read(stored.digest, stored.byteLength), bytes);
    assert.deepEqual(store.verify(stored.digest, stored.byteLength), stored);
  });
});

test("storing identical bytes is idempotent and leaves no temporary files", () => {
  withStore(({ directory, store }) => {
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const first = store.store(bytes);
    const second = store.store(bytes);

    assert.deepEqual(second, first);
    assert.deepEqual(fs.readdirSync(directory), [first.storageRef]);
  });
});

test("read fails closed for missing evidence and invalid expected lengths", () => {
  withStore(({ store }) => {
    const missing = evidenceDigest("missing");
    assert.throws(() => store.read(missing), EvidenceStoreError);

    const stored = store.store(Buffer.from("present"));
    assert.throws(() => store.read(stored.digest, stored.byteLength + 1), EvidenceStoreError);
    assert.throws(() => store.read(stored.digest, -1), EvidenceStoreError);
    assert.throws(() => store.read("sha256:not-a-digest" as Sha256Digest), EvidenceStoreError);
  });
});

test("read detects byte tampering, truncation, and insecure file modes", () => {
  withStore(({ directory, store }) => {
    const original = Buffer.from("original-evidence");
    const stored = store.store(original);
    const filename = path.join(directory, stored.storageRef);

    fs.writeFileSync(filename, Buffer.from("tampered-evidence"), { mode: 0o600 });
    assert.throws(() => store.read(stored.digest, stored.byteLength), EvidenceStoreError);

    fs.writeFileSync(filename, original.subarray(0, 4), { mode: 0o600 });
    assert.throws(() => store.read(stored.digest, stored.byteLength), EvidenceStoreError);

    fs.writeFileSync(filename, original, { mode: 0o600 });
    fs.chmodSync(filename, 0o640);
    assert.throws(() => store.read(stored.digest, stored.byteLength), EvidenceStoreError);
  });
});

test("constructor rejects symlinked and group-accessible evidence directories", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-evidence-dir-guard-"));
  try {
    const target = path.join(parent, "target");
    fs.mkdirSync(target, { mode: 0o700 });
    const link = path.join(parent, "link");
    fs.symlinkSync(target, link);
    assert.throws(() => new EvidenceStore(link), EvidenceStoreError);

    const permissive = path.join(parent, "permissive");
    fs.mkdirSync(permissive, { mode: 0o750 });
    fs.chmodSync(permissive, 0o750);
    assert.throws(() => new EvidenceStore(permissive), EvidenceStoreError);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("read rejects symlinked evidence files and a replaced store directory", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-evidence-link-guard-"));
  const directory = path.join(parent, "evidence");
  try {
    const store = new EvidenceStore(directory);
    const stored = store.store(Buffer.from("protected"));
    const filename = path.join(directory, stored.storageRef);
    const outside = path.join(parent, "outside");
    fs.writeFileSync(outside, "protected", { mode: 0o600 });
    fs.unlinkSync(filename);
    fs.symlinkSync(outside, filename);
    assert.throws(() => store.read(stored.digest, stored.byteLength), EvidenceStoreError);

    fs.unlinkSync(filename);
    fs.rmdirSync(directory);
    fs.symlinkSync(parent, directory);
    assert.throws(() => store.read(stored.digest, stored.byteLength), EvidenceStoreError);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

function withStore(run: (context: { directory: string; store: EvidenceStore }) => void): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-evidence-store-test-"));
  const directory = path.join(parent, "evidence");
  try {
    run({ directory, store: new EvidenceStore(directory) });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}
