import assert from "node:assert/strict";
import test from "node:test";

import type { StagingRecoveryRaceRequest } from "../adapters/kaspa-x402/abandoned-staging-recovery.js";
import type { Sha256Digest } from "../purchase/types.js";
import {
  ABSENCE_PROPAGATION_INTERVAL_MS,
  ChainEvidenceModule,
  digest,
  nonPresent,
  outputsDigest,
} from "./module.js";
import { ChainEvidenceStagingRecoveryRaceSource } from "./staging-recovery-source.js";
import {
  CHAIN_EVIDENCE_OPERATOR_PROFILE,
  CHAIN_EVIDENCE_PROFILE,
  CHAIN_EVIDENCE_WITNESS_PROFILE,
  type AcceptedChainEvidenceRecord,
  type ChainEvidenceFinalityPolicy,
  type ChainEvidenceObservation,
  type ChainEvidenceRecord,
  type ChainEvidenceRequest,
  type ChainSourceEvidence,
} from "./types.js";

const EXACT_ID = "11".repeat(32);
const RECOVERY_ID = "22".repeat(32);
const STAGING_ID = "33".repeat(32);
const SCRIPT = `000020${"44".repeat(32)}ac`;
const ACCEPTED_POLICY: ChainEvidenceFinalityPolicy = Object.freeze({
  settlement: "accepted",
  "direct-treasury": "accepted",
  vault: "accepted",
  staging: "accepted",
  "recovery-release": "accepted",
});

test("staging recovery uses accepted Chain Evidence to identify a spent winner", async () => {
  const calls: string[] = [];
  const chainEvidence = {
    observe: async (
      request: ChainEvidenceRequest,
    ): Promise<ChainEvidenceObservation> => {
      calls.push(request.transactionId);
      return request.transactionId === EXACT_ID
        ? acceptedObservation(request.transactionId)
        : absentObservation(request.transactionId);
    },
  } as unknown as ChainEvidenceModule;
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }) as never }
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

test("provisional candidates and unavailable staging state remain unknown and non-terminal", async () => {
  const chainEvidence = {
    observe: async (
      request: ChainEvidenceRequest,
    ): Promise<ChainEvidenceObservation> =>
      request.transactionId === RECOVERY_ID
        ? provisionalObservation(request.transactionId)
        : absentObservation(request.transactionId),
  } as unknown as ChainEvidenceModule;
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => { throw new Error("RPC capability unavailable"); } }
  );

  const evidence = await source.observeRace(request());
  assert.equal(evidence.recovery.status, "unknown");
  assert.equal(evidence.staging.status, "unknown");
});

test("uncorroborated candidate absence remains unknown rather than conflicting", async () => {
  const chainEvidence = {
    observe: async (
      request: ChainEvidenceRequest,
    ): Promise<ChainEvidenceObservation> =>
      unknownObservation(request.transactionId),
  } as unknown as ChainEvidenceModule;
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }) as never }
  );

  const evidence = await source.observeRace(request());
  assert.equal(evidence.exactPayment?.status, "unknown");
  assert.equal(evidence.recovery.status, "unknown");
  assert.equal(evidence.staging.status, "spent");
});

test("a confirmed exact winner corroborates recovery absence in one observation call", async () => {
  const calls = new Map<string, number>();
  let observedAtMs = 0;
  const sourceEvidence = (
    request: Readonly<ChainEvidenceRequest>,
    sourceProfile: string
  ): ChainSourceEvidence => {
    calls.set(request.transactionId, (calls.get(request.transactionId) ?? 0) + 1);
    if (request.transactionId !== EXACT_ID) {
      return nonPresent("absent", sourceProfile, digest(`absent:${request.transactionId}`), Date.now());
    }
    return {
      status: "present",
      level: "accepted",
      view: "historical",
      sourceProfile,
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
    { depthConfirmationDaa: "10", observe: async (request) => sourceEvidence(request, CHAIN_EVIDENCE_OPERATOR_PROFILE) },
    { depthConfirmationDaa: "10", observe: async (request) => sourceEvidence(request, CHAIN_EVIDENCE_WITNESS_PROFILE) },
    {
      findRetained: () => [],
      record: (record) => Object.freeze({ ...record }),
    },
    ACCEPTED_POLICY,
    () => {
      observedAtMs += 1_001;
      return observedAtMs;
    },
  );
  const source = new ChainEvidenceStagingRecoveryRaceSource(
    chainEvidence,
    { client: async () => ({ getUtxosByAddresses: async () => ({ entries: [] }) }) as never },
    ABSENCE_PROPAGATION_INTERVAL_MS + 10
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

function acceptedObservation(transactionId: string): ChainEvidenceObservation {
  return Object.freeze({
    interpretation: "accepted" as const,
    evidence: present(transactionId, "accepted"),
    finality: finalitySelection(),
  });
}

function provisionalObservation(transactionId: string): ChainEvidenceObservation {
  return Object.freeze({
    interpretation: "provisional" as const,
    evidence: present(transactionId, "provisional"),
    finality: finalitySelection(),
  });
}

function absentObservation(transactionId: string): ChainEvidenceObservation {
  return Object.freeze({
    interpretation: "absent" as const,
    evidence: absent(transactionId),
    finality: finalitySelection(),
  });
}

function unknownObservation(transactionId: string): ChainEvidenceObservation {
  return Object.freeze({
    interpretation: "unknown" as const,
    evidence: Object.freeze({
      ...absent(transactionId),
      status: "unknown" as const,
    }),
    finality: finalitySelection(),
  });
}

function finalitySelection() {
  return Object.freeze({
    operation: "recovery-release" as const,
    protocolFinality: "accepted" as const,
    operatorFloor: "accepted" as const,
    effectiveFloor: "accepted" as const,
    depthConfirmationDaa: "10",
  });
}

function present(
  transactionId: string,
  level: "accepted"
): AcceptedChainEvidenceRecord;
function present(
  transactionId: string,
  level: "provisional"
): ChainEvidenceRecord;
function present(
  transactionId: string,
  level: "provisional" | "accepted"
): ChainEvidenceRecord {
  return {
    profile: CHAIN_EVIDENCE_PROFILE,
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
    primaryProfile: CHAIN_EVIDENCE_OPERATOR_PROFILE,
    witnessProfile: CHAIN_EVIDENCE_WITNESS_PROFILE,
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
    profile: CHAIN_EVIDENCE_PROFILE,
    operationId: `test:${transactionId}`,
    operation: "recovery-release",
    transactionId,
    mechanism: "ordinary",
    protocolFinality: "accepted",
    operatorFloor: "accepted",
    effectiveFloor: "accepted",
    status: "absent",
    primaryProfile: CHAIN_EVIDENCE_OPERATOR_PROFILE,
    witnessProfile: CHAIN_EVIDENCE_WITNESS_PROFILE,
    outputsDigest: `sha256:${"B".repeat(43)}`,
    detailDigest: `sha256:${"D".repeat(43)}`,
    observedAtMs: Date.now(),
  };
}
