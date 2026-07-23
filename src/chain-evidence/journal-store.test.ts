import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PurchaseJournal } from "../purchase/journal.js";
import { ChainEvidenceModule, digest, outputsDigest } from "./module.js";
import { JournalChainEvidenceStore } from "./journal-store.js";
import {
  CHAIN_EVIDENCE_PROFILE,
  type ChainEvidenceRecord,
  type ChainEvidenceRequest,
} from "./types.js";

test("the Journal store requires the exact accepted-evidence lookup", () => {
  assert.throws(
    () => new JournalChainEvidenceStore({
      recordChainEvidence: (record: ChainEvidenceRecord) => record,
    } as unknown as PurchaseJournal),
    /Purchase Journal Chain Evidence store is required/
  );
});

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
    assert.deepEqual(new JournalChainEvidenceStore(restarted).findAccepted({
      transactionId: record.transactionId,
      outputsDigest: record.outputsDigest,
      mechanism: record.mechanism,
      minimumLevel: "accepted",
    }), record);
    restarted.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the module selects matching retained evidence before stronger unrelated evidence after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-chain-selection-"));
  fs.chmodSync(root, 0o700);
  const filename = path.join(root, "purchase.sqlite");
  const identity = { revision: 1, digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  const options = {
    operatorManifestIdentity: identity,
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
  } as const;
  const matchingRequest = fixtureRequest();
  const unrelatedRequest = {
    ...matchingRequest,
    expectedOutputs: [
      { ...matchingRequest.expectedOutputs[0], amountAtomic: "124" },
    ],
  };
  try {
    const journal = new PurchaseJournal(filename, options);
    const store = new JournalChainEvidenceStore(journal);
    const matching = await acceptedModule(store, matchingRequest, "accepted").observe(
      matchingRequest
    );
    await acceptedModule(store, unrelatedRequest, "depth-confirmed").observe(
      unrelatedRequest
    );
    journal.close();

    const restarted = new PurchaseJournal(filename, options);
    let liveSourceCalls = 0;
    const unavailable = {
      observe: async () => {
        liveSourceCalls += 1;
        throw new Error("live Chain Evidence source must not be used");
      },
    };
    const result = await new ChainEvidenceModule(
      unavailable,
      unavailable,
      new JournalChainEvidenceStore(restarted),
      () => 1_800_000_100_000
    ).observe(matchingRequest);

    assert.equal(result.detailDigest, matching.detailDigest);
    assert.equal(result.level, "accepted");
    assert.equal(result.view, "historical");
    assert.equal(liveSourceCalls, 0);
    restarted.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRequest(): ChainEvidenceRequest {
  return {
    operationId: "purchase:selection:settlement",
    operation: "settlement",
    network: "kaspa:testnet-10",
    transactionId: "11".repeat(32),
    expectedOutputs: [{
      index: 1,
      amountAtomic: "123",
      scriptPublicKey: "000020" + "22".repeat(32) + "ac",
      address: "kaspatest:qfixture",
    }],
    expectedInputs: [{ transactionId: "aa".repeat(32), index: 0 }],
    watchedAddresses: ["kaspatest:qfixture"],
    mechanism: "kip10-script-template",
    protocolFinality: "mempool",
    operatorFloor: "accepted",
    signal: new AbortController().signal,
  };
}

function acceptedModule(
  store: JournalChainEvidenceStore,
  request: ChainEvidenceRequest,
  level: "accepted" | "depth-confirmed"
): ChainEvidenceModule {
  const source = (sourceProfile: string) => ({
    status: "present" as const,
    level,
    view: "current" as const,
    sourceProfile,
    transactionId: request.transactionId,
    blockHash: "22".repeat(32),
    acceptingBlockHash: "33".repeat(32),
    acceptingBlockDaaScore: "100",
    virtualDaaScore: level === "depth-confirmed" ? "120" : "101",
    outputsDigest: outputsDigest(request),
    detailDigest: digest({ sourceProfile, level, outputsDigest: outputsDigest(request) }),
    observedAtMs: 1_800_000_000_000,
  });
  return new ChainEvidenceModule(
    { observe: async () => source("primary") },
    { observe: async () => source("witness") },
    store,
    () => 1_800_000_000_000
  );
}
