import assert from "node:assert/strict";
import test from "node:test";

import type { StagingRecoveryRaceRequest } from "../adapters/kaspa-x402/abandoned-staging-recovery.js";
import type { Sha256Digest } from "../purchase/types.js";
import {
  ChainEvidenceModule,
  digest,
  nonPresent,
  outputsDigest,
} from "./module.js";
import { ChainEvidenceStagingRecoveryRaceSource } from "./staging-recovery-source.js";
import type {
  ChainEvidenceRecord,
  ChainEvidenceRequest,
  ChainSourceEvidence,
} from "./types.js";

const EXACT_ID = "11".repeat(32);
const RECOVERY_ID = "22".repeat(32);
const STAGING_ID = "33".repeat(32);
const SCRIPT = `000020${"44".repeat(32)}ac`;

test("staging recovery uses accepted Chain Evidence to identify a spent winner", async () => {
  const calls: string[] = [];
  const chainEvidence = {
    observe: async (request: { transactionId: string }): Promise<ChainEvidenceRecord> => {
      calls.push(request.transactionId);
      return request.transactionId === EXACT_ID
        ? present(request.transactionId, "accepted")
        : absent(request.transactionId);
    },
  } as unknown as ChainEvidenceModule;
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }) as never },
    "accepted"
  );

  const evidence = await source.observeRace(request());
  assert.deepEqual(calls.sort(), [EXACT_ID, RECOVERY_ID].sort());
  assert.equal(evidence.exactPayment?.status, "observed");
  assert.equal(evidence.exactPayment?.status === "observed" ? evidence.exactPayment.finality : undefined, "accepted");
  assert.equal(evidence.recovery.status, "absent");
  assert.equal(evidence.staging.status, "spent");
  assert.equal(
    evidence.staging.status === "spent" ? evidence.staging.spendingTransactionId : undefined,
    EXACT_ID
  );
});

test("provisional candidates and unavailable staging state remain non-terminal", async () => {
  const chainEvidence = {
    observe: async (request: { transactionId: string }): Promise<ChainEvidenceRecord> =>
      request.transactionId === RECOVERY_ID
        ? present(request.transactionId, "provisional")
        : absent(request.transactionId),
  } as unknown as ChainEvidenceModule;
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => { throw new Error("RPC capability unavailable"); } },
    "accepted"
  );

  const evidence = await source.observeRace(request());
  assert.equal(evidence.recovery.status, "observed");
  assert.equal(evidence.recovery.status === "observed" ? evidence.recovery.finality : undefined, "mempool");
  assert.equal(evidence.staging.status, "unknown");
});

test("uncorroborated candidate absence remains unknown rather than conflicting", async () => {
  const chainEvidence = {
    observe: async (request: { transactionId: string }): Promise<ChainEvidenceRecord> => ({
      ...absent(request.transactionId),
      status: "unknown",
    }),
  } as unknown as ChainEvidenceModule;
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }) as never },
    "accepted"
  );

  const evidence = await source.observeRace(request());
  assert.equal(evidence.exactPayment?.status, "unknown");
  assert.equal(evidence.recovery.status, "unknown");
  assert.equal(evidence.staging.status, "spent");
});

test("a confirmed exact winner corroborates recovery absence in one observation call", async () => {
  const calls = new Map<string, number>();
  const sourceEvidence = (request: Readonly<ChainEvidenceRequest>): ChainSourceEvidence => {
    calls.set(request.transactionId, (calls.get(request.transactionId) ?? 0) + 1);
    if (request.transactionId !== EXACT_ID) {
      return nonPresent("absent", "test-source", digest(`absent:${request.transactionId}`), Date.now());
    }
    return {
      status: "present",
      level: "accepted",
      view: "historical",
      sourceProfile: "test-source",
      transactionId: request.transactionId,
      blockHash: "55".repeat(32),
      acceptingBlockHash: "66".repeat(32),
      acceptingBlockDaaScore: "100",
      virtualDaaScore: "101",
      outputsDigest: outputsDigest(request),
      detailDigest: digest(`present:${request.transactionId}`),
      observedAtMs: Date.now(),
    };
  };
  const chainEvidence = new ChainEvidenceModule(
    { observe: async (request) => sourceEvidence(request) },
    { observe: async (request) => sourceEvidence(request) },
    {
      findAccepted: () => undefined,
      record: (record) => Object.freeze({ ...record }),
    },
  );
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }) as never },
    "accepted"
  );

  const evidence = await source.observeRace(request());
  assert.equal(calls.get(EXACT_ID), 2);
  assert.equal(calls.get(RECOVERY_ID), 4);
  assert.equal(evidence.exactPayment?.status, "observed");
  assert.equal(evidence.recovery.status, "absent");
  assert.equal(evidence.staging.status, "spent");
  assert.equal(
    evidence.staging.status === "spent" ? evidence.staging.spendingTransactionId : undefined,
    EXACT_ID
  );
});

function request(): StagingRecoveryRaceRequest {
  return {
    network: "kaspa:testnet-10",
    staging: {
      outpoint: `${STAGING_ID}:0`,
      address: "kaspatest:qstaging",
      amountAtomic: "1000",
      scriptPublicKey: SCRIPT,
      blockDaaScore: "90",
    },
    exactPayment: {
      ...candidate(EXACT_ID, "kaspatest:qmerchant"),
      profile: "standard-native",
    },
    recovery: candidate(RECOVERY_ID, "kaspatest:qrecovery"),
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  };
}

function candidate(transactionId: string, outputAddress: string) {
  return {
    transactionId,
    transactionArtifactDigest: `sha256:${"A".repeat(43)}` as Sha256Digest,
    inputOutpoint: `${STAGING_ID}:0`,
    outputOutpoint: `${transactionId}:0`,
    outputIndex: 0,
    outputAddress,
    outputAmountAtomic: "900",
    outputScriptPublicKey: SCRIPT,
  };
}

function present(
  transactionId: string,
  level: "provisional" | "accepted"
): ChainEvidenceRecord {
  return {
    profile: "urn:sompi:chain-evidence:testnet-10:1",
    operationId: `test:${transactionId}`,
    operation: "recovery-release",
    transactionId,
    mechanism: "ordinary",
    protocolFinality: "accepted",
    operatorFloor: "accepted",
    effectiveFloor: "accepted",
    status: "present",
    level,
    view: "current",
    primaryProfile: "test-primary",
    witnessProfile: "test-witness",
    outputsDigest: `sha256:${"B".repeat(43)}`,
    ...(level === "provisional" ? {} : {
      blockHash: "55".repeat(32),
      acceptingBlockHash: "66".repeat(32),
      acceptingBlockDaaScore: "100",
      virtualDaaScore: "101",
    }),
    detailDigest: `sha256:${"C".repeat(43)}`,
    observedAtMs: Date.now(),
  };
}

function absent(transactionId: string): ChainEvidenceRecord {
  return {
    profile: "urn:sompi:chain-evidence:testnet-10:1",
    operationId: `test:${transactionId}`,
    operation: "recovery-release",
    transactionId,
    mechanism: "ordinary",
    protocolFinality: "accepted",
    operatorFloor: "accepted",
    effectiveFloor: "accepted",
    status: "absent",
    primaryProfile: "test-primary",
    witnessProfile: "test-witness",
    outputsDigest: `sha256:${"B".repeat(43)}`,
    detailDigest: `sha256:${"D".repeat(43)}`,
    observedAtMs: Date.now(),
  };
}
