import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PurchaseJournal } from "../purchase/journal.js";
import { JournalChainEvidenceStore } from "./journal-store.js";
import { CHAIN_EVIDENCE_PROFILE, type ChainEvidenceRecord } from "./types.js";

test("accepted Chain Evidence is immutable, manifest-bound, and retained after restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-chain-journal-"));
  fs.chmodSync(root, 0o700);
  const filename = path.join(root, "purchase.sqlite");
  const identity = { revision: 1, digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  const record: ChainEvidenceRecord = {
    profile: CHAIN_EVIDENCE_PROFILE, operationId: "settlement:test", operation: "settlement",
    transactionId: "11".repeat(32), status: "present", level: "accepted", view: "historical",
    mechanism: "kip10-script-template", protocolFinality: "mempool", operatorFloor: "accepted",
    effectiveFloor: "accepted", primaryProfile: "primary", witnessProfile: "witness",
    blockHash: "22".repeat(32), acceptingBlockHash: "33".repeat(32),
    acceptingBlockDaaScore: "100", virtualDaaScore: "101",
    outputsDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    detailDigest: "sha256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    observedAtMs: 1_800_000_000_000,
  };
  try {
    const journal = new PurchaseJournal(filename, {
      operatorManifestIdentity: identity,
      admission: {
        authorityPreauthSockets: 32,
        authorityPrompts: 4,
        prevalidationPurchases: 128,
        evidenceBytes: 67_108_864,
        directTreasuryRetries: 3,
      },
    });
    const store = new JournalChainEvidenceStore(journal);
    assert.deepEqual(store.record(record), record);
    assert.deepEqual(store.record(record), record);
    journal.close();
    const restarted = new PurchaseJournal(filename, {
      operatorManifestIdentity: identity,
      admission: {
        authorityPreauthSockets: 32,
        authorityPrompts: 4,
        prevalidationPurchases: 128,
        evidenceBytes: 67_108_864,
        directTreasuryRetries: 3,
      },
    });
    assert.deepEqual(new JournalChainEvidenceStore(restarted).findAccepted(record.transactionId), record);
    restarted.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
