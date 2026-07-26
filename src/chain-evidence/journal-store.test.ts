import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";

import { PurchaseJournal } from "../purchase/journal.js";
import { ChainEvidenceModule, digest, outputsDigest } from "./module.js";
import { JournalChainEvidenceStore } from "./journal-store.js";
import {
  CHAIN_EVIDENCE_OPERATOR_PROFILE,
  CHAIN_EVIDENCE_PROFILE,
  CHAIN_EVIDENCE_WITNESS_PROFILE,
  type ChainEvidenceFinalityPolicy,
  type ChainEvidenceRecord,
  type ChainEvidenceRequest,
} from "./types.js";

const ACCEPTED_POLICY: ChainEvidenceFinalityPolicy = Object.freeze({
  settlement: "accepted",
  "direct-treasury": "accepted",
  vault: "accepted",
  staging: "accepted",
  "recovery-release": "accepted",
});
const DEPTH_POLICY: ChainEvidenceFinalityPolicy = Object.freeze({
  ...ACCEPTED_POLICY,
  settlement: "depth-confirmed",
});

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
    effectiveFloor: "accepted", primaryProfile: CHAIN_EVIDENCE_OPERATOR_PROFILE,
    witnessProfile: CHAIN_EVIDENCE_WITNESS_PROFILE,
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
    const invalidRecords: ReadonlyArray<Readonly<{
      label: string;
      record: ChainEvidenceRecord;
    }>> = [
      {
        label: "unknown operation",
        record: { ...record, operation: "other" as ChainEvidenceRecord["operation"] },
      },
      {
        label: "unknown mechanism",
        record: { ...record, mechanism: "other" as ChainEvidenceRecord["mechanism"] },
      },
      {
        label: "weakened Merchant confirmation",
        record: {
          ...record,
          protocolFinality: "confirmed",
          effectiveFloor: "accepted",
        },
      },
      {
        label: "invented effective strength",
        record: { ...record, effectiveFloor: "depth-confirmed" },
      },
      {
        label: "unknown operator source profile",
        record: { ...record, primaryProfile: "kaspa-operator-wrpc-v2" },
      },
      {
        label: "unknown witness source profile",
        record: { ...record, witnessProfile: "kaspa-rest-accepted-history-v2" },
      },
    ];
    for (const candidate of invalidRecords) {
      assert.throws(
        () => store.record(candidate.record),
        /Chain Evidence/,
        candidate.label
      );
    }
    assert.deepEqual(store.record(record), record);
    assert.deepEqual(store.record(record), record);
    const exactQuery = {
      profile: CHAIN_EVIDENCE_PROFILE,
      operationId: record.operationId,
      operation: record.operation,
      transactionId: record.transactionId,
      outputsDigest: record.outputsDigest,
      mechanism: record.mechanism,
      protocolFinality: record.protocolFinality,
      operatorFloor: record.operatorFloor,
      effectiveFloor: record.effectiveFloor,
    } as const;
    assert.throws(
      () => store.findRetained({
        ...exactQuery,
        effectiveFloor: "depth-confirmed",
      }),
      /accepted Chain Evidence query is invalid/
    );
    assert.throws(
      () => store.findRetained({
        ...exactQuery,
        profile: "urn:sompi:chain-evidence:testnet-10:2" as typeof CHAIN_EVIDENCE_PROFILE,
      }),
      /accepted Chain Evidence query is invalid/
    );
    const belowFloor = {
      ...record,
      detailDigest: "sha256:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      operatorFloor: "depth-confirmed" as const,
      effectiveFloor: "depth-confirmed" as const,
    };
    assert.deepEqual(store.record(belowFloor), belowFloor);
    assert.deepEqual(
      store.findRetained({
        ...exactQuery,
        operatorFloor: "depth-confirmed",
        effectiveFloor: "depth-confirmed",
      }),
      [belowFloor]
    );
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
    assert.deepEqual(
      new JournalChainEvidenceStore(restarted).findRetained(exactQuery),
      [record]
    );
    restarted.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained Chain Evidence profiles are matched exactly and never fabricated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-chain-profile-"));
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
  const record: ChainEvidenceRecord = {
    profile: CHAIN_EVIDENCE_PROFILE,
    operationId: "settlement:profile",
    operation: "settlement",
    transactionId: "11".repeat(32),
    status: "present",
    level: "accepted",
    view: "historical",
    mechanism: "kip10-script-template",
    protocolFinality: "accepted",
    operatorFloor: "accepted",
    effectiveFloor: "accepted",
    primaryProfile: CHAIN_EVIDENCE_OPERATOR_PROFILE,
    witnessProfile: CHAIN_EVIDENCE_WITNESS_PROFILE,
    blockHash: "22".repeat(32),
    acceptingBlockHash: "33".repeat(32),
    acceptingBlockDaaScore: "100",
    virtualDaaScore: "101",
    outputsDigest: "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    detailDigest: "sha256:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    observedAtMs: 1_800_000_000_000,
  };
  try {
    new PurchaseJournal(filename, options).close();
    const database = new Database(filename);
    database.prepare(
      `INSERT INTO chain_evidence (
         detail_digest, profile, operation_id, operation, transaction_id, status,
         level, view, mechanism, protocol_finality, operator_floor, effective_floor,
         primary_profile, witness_profile, block_hash, accepting_block_hash,
         accepting_block_daa_score, virtual_daa_score, outputs_digest, observed_at_ms,
         manifest_revision, manifest_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.detailDigest,
      "urn:sompi:chain-evidence:testnet-10:2",
      record.operationId,
      record.operation,
      record.transactionId,
      record.status,
      record.level,
      record.view,
      record.mechanism,
      record.protocolFinality,
      record.operatorFloor,
      record.effectiveFloor,
      record.primaryProfile,
      record.witnessProfile,
      record.blockHash,
      record.acceptingBlockHash,
      record.acceptingBlockDaaScore,
      record.virtualDaaScore,
      record.outputsDigest,
      record.observedAtMs,
      identity.revision,
      identity.digest
    );
    database.close();

    const journal = new PurchaseJournal(filename, options);
    const store = new JournalChainEvidenceStore(journal);
    assert.deepEqual(
      store.findRetained({
        profile: CHAIN_EVIDENCE_PROFILE,
        operationId: record.operationId,
        operation: record.operation,
        transactionId: record.transactionId,
        outputsDigest: record.outputsDigest,
        mechanism: record.mechanism,
        protocolFinality: record.protocolFinality,
        operatorFloor: record.operatorFloor,
        effectiveFloor: record.effectiveFloor,
      }),
      []
    );
    assert.throws(
      () => store.record(record),
      /Chain Evidence profile is unsupported/
    );
    journal.close();
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
      depthConfirmationDaa: "10",
      observe: async () => {
        liveSourceCalls += 1;
        throw new Error("live Chain Evidence source must not be used");
      },
    };
    const result = await new ChainEvidenceModule(
      unavailable,
      unavailable,
      new JournalChainEvidenceStore(restarted),
      ACCEPTED_POLICY,
      () => 1_800_000_100_000
    ).observe(matchingRequest);

    assert.equal(result.interpretation, "accepted");
    assert.equal(result.evidence.detailDigest, matching.evidence.detailDigest);
    assert.equal(result.evidence.level, "accepted");
    assert.equal(result.evidence.view, "historical");
    assert.equal(liveSourceCalls, 0);
    restarted.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retained depth evidence is re-evaluated against the current DAA meaning after restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-chain-depth-restart-"));
  fs.chmodSync(root, 0o700);
  const filename = path.join(root, "purchase.sqlite");
  const options = {
    operatorManifestIdentity: {
      revision: 1,
      digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
  } as const;
  const insufficient = fixtureRequest();
  const sufficient = {
    ...fixtureRequest(),
    operationId: "purchase:selection:settlement:sufficient",
    transactionId: "12".repeat(32),
  };
  const newlySufficient = {
    ...fixtureRequest(),
    operationId: "purchase:selection:settlement:newly-sufficient",
    transactionId: "13".repeat(32),
  };
  const multipleRetained = {
    ...fixtureRequest(),
    operationId: "purchase:selection:settlement:multiple-retained",
    transactionId: "14".repeat(32),
  };
  const acceptedFloorStaleStrong = {
    ...fixtureRequest(),
    operationId: "purchase:selection:settlement:accepted-floor-stale-strong",
    transactionId: "15".repeat(32),
  };
  const acceptedFloorStaleWeak = {
    ...fixtureRequest(),
    operationId: "purchase:selection:settlement:accepted-floor-stale-weak",
    transactionId: "16".repeat(32),
  };
  try {
    const journal = new PurchaseJournal(filename, options);
    const store = new JournalChainEvidenceStore(journal);
    assert.equal(
      (await depthModule(store, insufficient, "10", "110").observe(insufficient))
        .interpretation,
      "accepted"
    );
    assert.equal(
      (await depthModule(store, sufficient, "10", "120").observe(sufficient))
        .interpretation,
      "accepted"
    );
    const belowOldDepth = await depthModule(
      store,
      newlySufficient,
      "20",
      "115"
    ).observe(newlySufficient);
    assert.equal(
      belowOldDepth.interpretation,
      "unknown",
      "raw depth below the old threshold must remain nonterminal"
    );
    assert.equal(
      (
        await depthModule(
          store,
          multipleRetained,
          "10",
          "110",
          1_800_000_000_001
        ).observe(multipleRetained)
      ).interpretation,
      "accepted"
    );
    assert.equal(
      (
        await depthModule(
          store,
          multipleRetained,
          "20",
          "115",
          1_800_000_000_002
        ).observe(multipleRetained)
      ).interpretation,
      "unknown"
    );
    const staleStrong = await depthModule(
      store,
      acceptedFloorStaleStrong,
      "10",
      "110",
      1_800_000_000_003,
      ACCEPTED_POLICY
    ).observe(acceptedFloorStaleStrong);
    assert.equal(staleStrong.interpretation, "accepted");
    assert.equal(staleStrong.evidence.level, "depth-confirmed");
    const staleWeak = await depthModule(
      store,
      acceptedFloorStaleWeak,
      "20",
      "115",
      1_800_000_000_004,
      ACCEPTED_POLICY
    ).observe(acceptedFloorStaleWeak);
    assert.equal(staleWeak.interpretation, "accepted");
    assert.equal(staleWeak.evidence.level, "accepted");
    journal.close();

    const restarted = new PurchaseJournal(filename, options);
    const restartedStore = new JournalChainEvidenceStore(restarted);
    let liveCalls = 0;
    const unavailable = {
      depthConfirmationDaa: "20",
      observe: async (): Promise<never> => {
        liveCalls += 1;
        throw new Error("live source unavailable");
      },
    };
    const underDepth = await new ChainEvidenceModule(
      unavailable,
      unavailable,
      restartedStore,
      DEPTH_POLICY,
      () => 1_800_000_100_000
    ).observe(insufficient);
    assert.equal(underDepth.interpretation, "unavailable");
    assert.equal(liveCalls, 2, "under-depth retained evidence must fall through to live sources");

    const atDepth = await new ChainEvidenceModule(
      unavailable,
      unavailable,
      restartedStore,
      DEPTH_POLICY,
      () => 1_800_000_100_001
    ).observe(sufficient);
    assert.equal(atDepth.interpretation, "accepted");
    assert.equal(atDepth.evidence.view, "historical");
    assert.equal(liveCalls, 2, "raw DAA facts that meet the new depth remain reusable");

    const underLoweredDepth = await new ChainEvidenceModule(
      { ...unavailable, depthConfirmationDaa: "10" },
      { ...unavailable, depthConfirmationDaa: "10" },
      restartedStore,
      DEPTH_POLICY,
      () => 1_800_000_100_002
    ).observe(newlySufficient);
    assert.equal(underLoweredDepth.interpretation, "accepted");
    assert.equal(underLoweredDepth.evidence.view, "historical");
    assert.equal(underLoweredDepth.evidence.level, "depth-confirmed");
    assert.notEqual(
      underLoweredDepth.evidence.detailDigest,
      belowOldDepth.evidence.detailDigest,
      "the current derived level must have a new exact evidence digest"
    );
    assert.equal(
      liveCalls,
      2,
      "raw DAA facts must be re-evaluated even when the stored derived level was accepted"
    );

    const selectedAcrossRows = await new ChainEvidenceModule(
      { ...unavailable, depthConfirmationDaa: "12" },
      { ...unavailable, depthConfirmationDaa: "12" },
      restartedStore,
      DEPTH_POLICY,
      () => 1_800_000_100_003
    ).observe(multipleRetained);
    assert.equal(selectedAcrossRows.interpretation, "accepted");
    assert.equal(selectedAcrossRows.evidence.level, "depth-confirmed");
    assert.equal(selectedAcrossRows.evidence.virtualDaaScore, "115");
    assert.equal(
      liveCalls,
      2,
      "an old derived level must not hide another exact retained row that meets the current depth"
    );

    const weakenedAtAcceptedFloor = await new ChainEvidenceModule(
      { ...unavailable, depthConfirmationDaa: "20" },
      { ...unavailable, depthConfirmationDaa: "20" },
      restartedStore,
      ACCEPTED_POLICY,
      () => 1_800_000_100_004
    ).observe(acceptedFloorStaleStrong);
    assert.equal(weakenedAtAcceptedFloor.interpretation, "accepted");
    assert.equal(weakenedAtAcceptedFloor.evidence.level, "accepted");
    assert.notEqual(
      weakenedAtAcceptedFloor.evidence.detailDigest,
      staleStrong.evidence.detailDigest
    );

    const strengthenedAtAcceptedFloor = await new ChainEvidenceModule(
      { ...unavailable, depthConfirmationDaa: "10" },
      { ...unavailable, depthConfirmationDaa: "10" },
      restartedStore,
      ACCEPTED_POLICY,
      () => 1_800_000_100_005
    ).observe(acceptedFloorStaleWeak);
    assert.equal(strengthenedAtAcceptedFloor.interpretation, "accepted");
    assert.equal(strengthenedAtAcceptedFloor.evidence.level, "depth-confirmed");
    assert.notEqual(
      strengthenedAtAcceptedFloor.evidence.detailDigest,
      staleWeak.evidence.detailDigest
    );
    assert.equal(
      liveCalls,
      2,
      "retained levels must be honest under an accepted minimum floor"
    );
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
    signal: new AbortController().signal,
  };
}

function acceptedModule(
  store: JournalChainEvidenceStore,
  request: ChainEvidenceRequest,
  level: "accepted" | "depth-confirmed"
): ChainEvidenceModule {
  const source = (sourceProfile: typeof CHAIN_EVIDENCE_OPERATOR_PROFILE | typeof CHAIN_EVIDENCE_WITNESS_PROFILE) => ({
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
    { depthConfirmationDaa: "10", observe: async () => source(CHAIN_EVIDENCE_OPERATOR_PROFILE) },
    { depthConfirmationDaa: "10", observe: async () => source(CHAIN_EVIDENCE_WITNESS_PROFILE) },
    store,
    ACCEPTED_POLICY,
    () => 1_800_000_000_000
  );
}

function depthModule(
  store: JournalChainEvidenceStore,
  request: ChainEvidenceRequest,
  depthConfirmationDaa: string,
  virtualDaaScore: string,
  observedAtMs = 1_800_000_000_000,
  policy: ChainEvidenceFinalityPolicy = DEPTH_POLICY
): ChainEvidenceModule {
  const level =
    BigInt(virtualDaaScore) - 100n >= BigInt(depthConfirmationDaa)
      ? "depth-confirmed" as const
      : "accepted" as const;
  const source = (
    sourceProfile:
      | typeof CHAIN_EVIDENCE_OPERATOR_PROFILE
      | typeof CHAIN_EVIDENCE_WITNESS_PROFILE
  ) => ({
    status: "present" as const,
    level,
    view: "current" as const,
    sourceProfile,
    transactionId: request.transactionId,
    blockHash: "22".repeat(32),
    acceptingBlockHash: "33".repeat(32),
    acceptingBlockDaaScore: "100",
    virtualDaaScore,
    outputsDigest: outputsDigest(request),
    detailDigest: digest({
      sourceProfile,
      virtualDaaScore,
      outputsDigest: outputsDigest(request),
    }),
    observedAtMs,
  });
  return new ChainEvidenceModule(
    {
      depthConfirmationDaa,
      observe: async () => source(CHAIN_EVIDENCE_OPERATOR_PROFILE),
    },
    {
      depthConfirmationDaa,
      observe: async () => source(CHAIN_EVIDENCE_WITNESS_PROFILE),
    },
    store,
    policy,
    () => observedAtMs
  );
}
