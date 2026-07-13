import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createPurchaseId, evidenceDigest, requestFingerprint } from "./identity.js";
import {
  EvidenceAdmissionError,
  PurchaseAdmissionError,
  PurchaseJournal,
  type PurchaseJournalOptions,
} from "./journal.js";
import type { PurchaseId } from "./types.js";

const NOW = 1_900_000_000_000;
const ADMISSION = Object.freeze({
  authorityPreauthSockets: 32,
  authorityPrompts: 4,
  prevalidationPurchases: 2,
  evidenceBytes: 10,
  directTreasuryRetries: 3,
});

test("Purchase Admission Lease enforces the exact count cap and survives restart", () => {
  withJournal((journal) => {
    journal.createPurchase(input(1));
    journal.createPurchase(input(2));
    assert.throws(() => journal.createPurchase(input(3)), PurchaseAdmissionError);
    assert.deepEqual(journal.admissionStatus()?.prevalidationPurchases, {
      used: 2,
      budget: 2,
      saturated: true,
    });
  });
});

test("evidence Admission Lease counts unique bytes, deduplicates identical blobs, and releases write faults", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-admission-evidence-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  let journal = new PurchaseJournal(filename, options());
  try {
    const first = journal.createPurchase(input(10));
    const second = journal.createPurchase(input(11));
    journal.storeEvidence(first.id, {
      bytes: Buffer.from("123456"),
      mediaType: "text/plain",
      profile: "test:evidence:1",
      kind: "test-body",
    });
    journal.storeEvidence(second.id, {
      bytes: Buffer.from("123456"),
      mediaType: "text/plain",
      profile: "test:evidence:1",
      kind: "test-body",
    });
    assert.equal(journal.admissionStatus()?.evidenceBytes.used, 6);
    assert.equal(journal.admissionStatus()?.evidenceBytes.reserved, 0);

    assert.throws(
      () => journal.storeEvidence(second.id, {
        bytes: Buffer.from("1234567"),
        mediaType: "text/plain",
        profile: "test:evidence:1",
        kind: "second-body",
      }),
      EvidenceAdmissionError,
    );
    assert.equal(journal.admissionStatus()?.evidenceBytes.used, 6);
    journal.close();
    journal = new PurchaseJournal(filename, options());
    assert.equal(journal.admissionStatus()?.evidenceBytes.used, 6);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent Journal handles compete atomically for Purchase admission", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-admission-race-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const first = new PurchaseJournal(filename, {
    ...options(),
    admission: { ...ADMISSION, prevalidationPurchases: 1 },
  });
  const second = new PurchaseJournal(filename, {
    ...options(),
    admission: { ...ADMISSION, prevalidationPurchases: 1 },
  });
  try {
    first.createPurchase(input(20));
    assert.throws(() => second.createPurchase(input(21)), PurchaseAdmissionError);
    assert.equal(second.admissionStatus()?.prevalidationPurchases.used, 1);
  } finally {
    first.close();
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("evidence fault at publication/link boundary leaves no quota drift or orphan", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-admission-fault-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const base = new PurchaseJournal(filename, options());
  const purchase = base.createPurchase(input(30));
  base.close();
  const faulted = new PurchaseJournal(filename, {
    ...options(),
    faultInjector(point) {
      if (point === "evidence.after_metadata_insert") throw new Error("injected evidence edge failure");
    },
  });
  try {
    assert.throws(
      () => faulted.storeEvidence(purchase.id, {
        bytes: Buffer.from("fault-edge"),
        mediaType: "text/plain",
        profile: "test:evidence:1",
        kind: "fault-body",
      }),
      /injected evidence edge failure/,
    );
    assert.equal(faulted.admissionStatus()?.evidenceBytes.used, 0);
    assert.deepEqual(fs.readdirSync(`${filename}.evidence`), []);
  } finally {
    faulted.close();
    const restarted = new PurchaseJournal(filename, options());
    try {
      assert.equal(restarted.admissionStatus()?.evidenceBytes.used, 0);
      assert.equal(restarted.findEvidence(evidenceDigest("fault-edge")), undefined);
    } finally {
      restarted.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

function options(overrides: Partial<PurchaseJournalOptions> = {}): PurchaseJournalOptions {
  return {
    now: () => NOW,
    admission: ADMISSION,
    ...overrides,
  };
}

function input(seed: number) {
  const url = `https://merchant.example/admission/${seed}`;
  return {
    id: createPurchaseId(new Uint8Array(16).fill(seed)) as PurchaseId,
    requestKey: `admission:test:${seed}` as any,
    resourceUrl: url,
    method: "GET",
    resourceFingerprint: requestFingerprint({ url, method: "GET" }),
  };
}

function withJournal(run: (journal: PurchaseJournal) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-admission-count-"));
  fs.chmodSync(directory, 0o700);
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), options());
  try {
    run(journal);
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
