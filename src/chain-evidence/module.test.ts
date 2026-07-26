import assert from "node:assert/strict";
import test from "node:test";

import { ChainEvidenceModule, digest, outputsDigest } from "./module.js";
import {
  CHAIN_EVIDENCE_OPERATOR_PROFILE,
  CHAIN_EVIDENCE_OPERATIONS,
  CHAIN_EVIDENCE_PROFILE,
  CHAIN_EVIDENCE_WITNESS_PROFILE,
  type AcceptedChainEvidenceQuery,
  type ChainEvidenceFinalityPolicy,
  type ChainEvidenceOperation,
  type ChainEvidenceRecord,
  type ChainEvidenceRequest,
  type ChainEvidenceStore,
  type ChainSourceEvidence,
  type FinalityFloor,
} from "./types.js";

const NOW = 1_800_000_000_000;
const POLICY = Object.freeze({
  settlement: "accepted",
  "direct-treasury": "depth-confirmed",
  vault: "accepted",
  staging: "depth-confirmed",
  "recovery-release": "accepted",
} satisfies ChainEvidenceFinalityPolicy);

test("Chain Evidence owns the Finality Floor for all five operations", () => {
  const module = policyModule(POLICY);
  const expected: Readonly<Record<ChainEvidenceOperation, FinalityFloor>> = {
    settlement: "accepted",
    "direct-treasury": "depth-confirmed",
    vault: "accepted",
    staging: "depth-confirmed",
    "recovery-release": "accepted",
  };

  assert.deepEqual(
    CHAIN_EVIDENCE_OPERATIONS.map((operation) => {
      const selected = module.selectFinality(operation, "accepted");
      return {
        operation,
        operatorFloor: selected.operatorFloor,
        effectiveFloor: selected.effectiveFloor,
        depthConfirmationDaa: selected.depthConfirmationDaa,
      };
    }),
    CHAIN_EVIDENCE_OPERATIONS.map((operation) => ({
      operation,
      operatorFloor: expected[operation],
      effectiveFloor: expected[operation],
      depthConfirmationDaa: "10",
    }))
  );
});

test("effective Finality Floor strengthens in both Merchant and operator directions", () => {
  const module = policyModule(POLICY);

  assert.deepEqual(
    module.selectFinality("settlement", "confirmed"),
    {
      operation: "settlement",
      protocolFinality: "confirmed",
      operatorFloor: "accepted",
      effectiveFloor: "depth-confirmed",
      depthConfirmationDaa: "10",
    }
  );
  assert.deepEqual(
    module.selectFinality("direct-treasury", "accepted"),
    {
      operation: "direct-treasury",
      protocolFinality: "accepted",
      operatorFloor: "depth-confirmed",
      effectiveFloor: "depth-confirmed",
      depthConfirmationDaa: "10",
    }
  );
  assert.deepEqual(
    module.selectFinality("vault", "mempool"),
    {
      operation: "vault",
      protocolFinality: "mempool",
      operatorFloor: "accepted",
      effectiveFloor: "accepted",
      depthConfirmationDaa: "10",
    }
  );
});

test("invalid Finality Floor policies and selections fail closed", () => {
  const invalidPolicies: unknown[] = [
    undefined,
    null,
    {},
    { ...POLICY, settlement: "mempool" },
    Object.fromEntries(
      Object.entries(POLICY).filter(([operation]) => operation !== "staging")
    ),
    { ...POLICY, extra: "accepted" },
  ];

  for (const policy of invalidPolicies) {
    assert.throws(
      () => policyModule(policy as ChainEvidenceFinalityPolicy),
      /finality policy is invalid/
    );
  }

  const module = policyModule(POLICY);
  assert.throws(
    () => module.selectFinality("unknown" as ChainEvidenceOperation, "accepted"),
    /finality request is invalid/
  );
  assert.throws(
    () => module.selectFinality("settlement", "final" as never),
    /finality request is invalid/
  );
});

test("Chain Evidence rejects missing, malformed, or different source depth meanings", () => {
  const source = (depthConfirmationDaa: string) => ({
    depthConfirmationDaa,
    observe: async (): Promise<ChainSourceEvidence> => ({
      status: "unavailable",
      sourceProfile: "test",
      detailDigest: digest("unavailable"),
      observedAtMs: NOW,
    }),
  });
  assert.throws(
    () => new ChainEvidenceModule(
      source("10"),
      source("20"),
      memoryStore(),
      POLICY,
      () => NOW
    ),
    /different depth-confirmation DAA/
  );
  assert.throws(
    () => new ChainEvidenceModule(
      source("010"),
      source("010"),
      memoryStore(),
      POLICY,
      () => NOW
    ),
    /operator depth-confirmation DAA is invalid/
  );
});

test("two independent exact sources are required before evidence is accepted", async () => {
  const request = fixtureRequest();
  const store = memoryStore();
  const module = acceptedModule(store, request, "accepted", POLICY);
  const result = await module.observe(request);

  assert.equal(result.interpretation, "accepted");
  assert.equal(result.evidence.status, "present");
  assert.equal(result.evidence.level, "accepted");
  assert.equal(result.finality.protocolFinality, "mempool");
  assert.equal(result.finality.operatorFloor, "accepted");
  assert.equal(result.finality.effectiveFloor, "accepted");
  assert.equal(result.finality.depthConfirmationDaa, "10");
  assert.equal(store.records.length, 1);

  const accepted = sourceAccepted(request, "accepted");
  const lying = new ChainEvidenceModule(
    { depthConfirmationDaa: "10", observe: async () => accepted("primary") },
    {
      depthConfirmationDaa: "10",
      observe: async () => ({
        ...accepted("witness"),
        acceptingBlockHash: "44".repeat(32),
      }),
    },
    memoryStore(),
    POLICY,
    () => NOW
  );
  assert.equal((await lying.observe(request)).interpretation, "unknown");

  const unsupportedProfile = new ChainEvidenceModule(
    {
      depthConfirmationDaa: "10",
      observe: async () => ({
        ...accepted("primary"),
        sourceProfile: "kaspa-operator-wrpc-v2",
      }),
    },
    { depthConfirmationDaa: "10", observe: async () => accepted("witness") },
    memoryStore(),
    POLICY,
    () => NOW
  );
  const unsupported = await unsupportedProfile.observe(request);
  assert.equal(unsupported.interpretation, "unknown");
  assert.equal(unsupported.evidence.status, "unknown");
  assert.equal(unsupported.evidence.level, undefined);
});

test("single-source, provisional, unavailable, and contradictory evidence stay nonterminal", async () => {
  const request = fixtureRequest();
  const unavailable: ChainSourceEvidence = {
    status: "unavailable",
    sourceProfile: "witness",
    detailDigest: digest("unavailable"),
    observedAtMs: 1,
  };
  const provisional: ChainSourceEvidence = {
    status: "present",
    level: "provisional",
    view: "current",
    sourceProfile: "primary",
    transactionId: request.transactionId,
    outputsDigest: outputsDigest(request),
    detailDigest: digest("mempool"),
    observedAtMs: 1,
  };
  const module = new ChainEvidenceModule(
    { depthConfirmationDaa: "10", observe: async () => provisional },
    { depthConfirmationDaa: "10", observe: async () => unavailable },
    memoryStore(),
    POLICY,
    () => NOW
  );
  assert.equal((await module.observe(request)).interpretation, "provisional");

  const absent = {
    status: "absent",
    sourceProfile: "witness",
    detailDigest: digest("absent"),
    observedAtMs: 1,
  } as const;
  const conflict = new ChainEvidenceModule(
    { depthConfirmationDaa: "10", observe: async () => sourceAccepted(request, "accepted")("primary") },
    { depthConfirmationDaa: "10", observe: async () => absent },
    memoryStore(),
    POLICY,
    () => NOW
  );
  assert.equal((await conflict.observe(request)).interpretation, "provisional");
});

test("corroborated absence requires a second observation after the propagation interval", async () => {
  const request = fixtureRequest();
  let now = NOW;
  const absent = (sourceProfile: string): ChainSourceEvidence => ({
    status: "absent",
    sourceProfile,
    detailDigest: digest({ sourceProfile, now }),
    observedAtMs: now,
  });
  const module = new ChainEvidenceModule(
    {
      depthConfirmationDaa: "10",
      observe: async () => absent(CHAIN_EVIDENCE_OPERATOR_PROFILE),
    },
    {
      depthConfirmationDaa: "10",
      observe: async () => absent(CHAIN_EVIDENCE_WITNESS_PROFILE),
    },
    memoryStore(),
    POLICY,
    () => now
  );

  assert.equal((await module.observe(request)).interpretation, "unknown");
  now += 999;
  assert.equal((await module.observe(request)).interpretation, "unknown");
  now += 1;
  assert.equal((await module.observe(request)).interpretation, "absent");
  assert.equal(
    (await module.observe(request)).interpretation,
    "absent",
    "a fresh effect-fenced check must reuse the established propagation window"
  );

  const unpinned = new ChainEvidenceModule(
    {
      depthConfirmationDaa: "10",
      observe: async () => absent("generic-operator-source"),
    },
    {
      depthConfirmationDaa: "10",
      observe: async () => absent(CHAIN_EVIDENCE_WITNESS_PROFILE),
    },
    memoryStore(),
    POLICY,
    () => now
  );
  assert.equal((await unpinned.observe(request)).interpretation, "unknown");
  now += 1_000;
  const unpinnedAgain = await unpinned.observe(request);
  assert.equal(unpinnedAgain.interpretation, "unknown");
  assert.equal(unpinnedAgain.evidence.status, "unknown");

  now += 30_001;
  assert.equal(
    (await module.observe(request)).interpretation,
    "unknown",
    "a stale absence window must be established again"
  );
});

test("accepted evidence remains nonterminal below the selected operator floor", async () => {
  const request = {
    ...fixtureRequest(),
    operation: "direct-treasury" as const,
    operationId: "treasury:direct:1",
    protocolFinality: "accepted" as const,
  };
  const result = await acceptedModule(
    memoryStore(),
    request,
    "accepted",
    POLICY
  ).observe(request);

  assert.equal(result.interpretation, "unknown");
  assert.equal(result.evidence.status, "present");
  assert.equal(result.evidence.level, "accepted");
  assert.equal(result.evidence.blockHash, "22".repeat(32));
  assert.equal(result.evidence.acceptingBlockHash, "33".repeat(32));
  assert.equal(result.finality.operatorFloor, "depth-confirmed");
  assert.equal(result.finality.effectiveFloor, "depth-confirmed");
});

test("retained exact evidence survives spent outputs without live source calls", async () => {
  const request = fixtureRequest();
  const store = memoryStore();
  const first = await acceptedModule(
    store,
    request,
    "accepted",
    POLICY
  ).observe(request);
  assert.equal(first.interpretation, "accepted");

  let liveSourceCalls = 0;
  const restarted = unavailableModule(store, POLICY, () => {
    liveSourceCalls += 1;
  });
  const retained = await restarted.observe(request);

  assert.equal(liveSourceCalls, 0);
  assert.equal(retained.interpretation, "accepted");
  assert.equal(retained.evidence.detailDigest, first.evidence.detailDigest);
  assert.equal(retained.evidence.view, "historical");
});

test("retained evidence must match every request and selected-policy fact", async () => {
  const request = fixtureRequest();
  const store = memoryStore();
  await acceptedModule(store, request, "accepted", POLICY).observe(request);

  const cases: ReadonlyArray<{
    readonly label: string;
    readonly request: ChainEvidenceRequest;
    readonly policy?: ChainEvidenceFinalityPolicy;
  }> = [
    {
      label: "operation ID",
      request: { ...request, operationId: "purchase:2:settlement" },
    },
    {
      label: "operation",
      request: {
        ...request,
        operation: "vault",
        operationId: "vault:purchase:1",
      },
    },
    {
      label: "output",
      request: {
        ...request,
        expectedOutputs: [
          { ...request.expectedOutputs[0], amountAtomic: "124" },
        ],
      },
    },
    {
      label: "input",
      request: {
        ...request,
        expectedInputs: [{ transactionId: "bb".repeat(32), index: 0 }],
      },
    },
    {
      label: "mechanism",
      request: { ...request, mechanism: "ordinary" },
    },
    {
      label: "protocol finality",
      request: { ...request, protocolFinality: "accepted" },
    },
    {
      label: "operator floor",
      request,
      policy: { ...POLICY, settlement: "depth-confirmed" },
    },
  ];

  for (const candidate of cases) {
    let liveSourceCalls = 0;
    const result = await unavailableModule(
      store,
      candidate.policy ?? POLICY,
      () => {
        liveSourceCalls += 1;
      }
    ).observe(candidate.request);
    assert.equal(result.interpretation, "unavailable", candidate.label);
    assert.equal(liveSourceCalls, 2, candidate.label);
  }
});

test("malformed or mismatched retained present records fail closed", async () => {
  const request = fixtureRequest();
  const valid = acceptedRecord(request);
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly retained: ChainEvidenceRecord;
  }> = [
    {
      label: "wrong evidence profile",
      retained: {
        ...valid,
        profile: "urn:sompi:chain-evidence:testnet-10:2" as typeof CHAIN_EVIDENCE_PROFILE,
      },
    },
    {
      label: "wrong operator source profile",
      retained: { ...valid, primaryProfile: "kaspa-operator-wrpc-v2" },
    },
    {
      label: "wrong witness source profile",
      retained: { ...valid, witnessProfile: "kaspa-rest-accepted-history-v2" },
    },
    {
      label: "missing accepted proof fields",
      retained: {
        ...valid,
        blockHash: undefined,
      },
    },
    {
      label: "impossible DAA score order",
      retained: {
        ...valid,
        acceptingBlockDaaScore: "101",
        virtualDaaScore: "100",
      },
    },
    {
      label: "wrong transaction",
      retained: { ...valid, transactionId: "ff".repeat(32) },
    },
    {
      label: "wrong operation ID",
      retained: { ...valid, operationId: "purchase:other:settlement" },
    },
    {
      label: "wrong operation",
      retained: { ...valid, operation: "vault" },
    },
    {
      label: "wrong protocol finality",
      retained: { ...valid, protocolFinality: "confirmed" },
    },
    {
      label: "wrong operator floor",
      retained: { ...valid, operatorFloor: "depth-confirmed" },
    },
    {
      label: "wrong effective floor",
      retained: { ...valid, effectiveFloor: "depth-confirmed" },
    },
    {
      label: "wrong output digest",
      retained: { ...valid, outputsDigest: digest("wrong outputs") },
    },
    {
      label: "wrong mechanism",
      retained: { ...valid, mechanism: "ordinary" },
    },
  ];

  for (const candidate of cases) {
    let liveSourceCalls = 0;
    const store: ChainEvidenceStore = {
      findRetained: () => [candidate.retained],
      record: (record) => record,
    };
    const result = await unavailableModule(store, POLICY, () => {
      liveSourceCalls += 1;
    }).observe(request);

    assert.notEqual(result.interpretation, "accepted", candidate.label);
    assert.equal(
      result.interpretation === "unknown" ||
        result.interpretation === "unavailable",
      true,
      candidate.label
    );
    assert.equal(
      liveSourceCalls === 0 || liveSourceCalls === 2,
      true,
      candidate.label
    );
  }
});

function fixtureRequest(): ChainEvidenceRequest {
  return {
    operationId: "purchase:1:settlement",
    operation: "settlement",
    network: "kaspa:testnet-10",
    transactionId: "11".repeat(32),
    expectedOutputs: [{
      index: 1,
      amountAtomic: "123",
      scriptPublicKey: `000020${"22".repeat(32)}ac`,
      address: "kaspatest:qfixture",
    }],
    expectedInputs: [{ transactionId: "aa".repeat(32), index: 0 }],
    watchedAddresses: ["kaspatest:qfixture"],
    mechanism: "kip10-script-template",
    protocolFinality: "mempool",
    signal: new AbortController().signal,
  };
}

function sourceAccepted(
  request: ChainEvidenceRequest,
  level: "accepted" | "depth-confirmed"
) {
  return (source: "primary" | "witness") => ({
    status: "present" as const,
    level,
    view: "current" as const,
    sourceProfile:
      source === "primary"
        ? CHAIN_EVIDENCE_OPERATOR_PROFILE
        : CHAIN_EVIDENCE_WITNESS_PROFILE,
    transactionId: request.transactionId,
    blockHash: "22".repeat(32),
    acceptingBlockHash: "33".repeat(32),
    acceptingBlockDaaScore: "100",
    virtualDaaScore: level === "depth-confirmed" ? "120" : "101",
    outputsDigest: outputsDigest(request),
    detailDigest: digest({ source, level }),
    observedAtMs: NOW,
  });
}

function acceptedModule(
  store: ChainEvidenceStore,
  request: ChainEvidenceRequest,
  level: "accepted" | "depth-confirmed",
  policy: ChainEvidenceFinalityPolicy
): ChainEvidenceModule {
  const accepted = sourceAccepted(request, level);
  return new ChainEvidenceModule(
    { depthConfirmationDaa: "10", observe: async () => accepted("primary") },
    { depthConfirmationDaa: "10", observe: async () => accepted("witness") },
    store,
    policy,
    () => NOW
  );
}

function policyModule(policy: ChainEvidenceFinalityPolicy): ChainEvidenceModule {
  const unavailable = {
    depthConfirmationDaa: "10",
    observe: async (): Promise<ChainSourceEvidence> => ({
      status: "unavailable",
      sourceProfile: "unavailable",
      detailDigest: digest("unavailable"),
      observedAtMs: NOW,
    }),
  };
  return new ChainEvidenceModule(
    unavailable,
    unavailable,
    memoryStore(),
    policy,
    () => NOW
  );
}

function unavailableModule(
  store: ChainEvidenceStore,
  policy: ChainEvidenceFinalityPolicy,
  called: () => void
): ChainEvidenceModule {
  const unavailable = (sourceProfile: string) => ({
    depthConfirmationDaa: "10",
    observe: async (): Promise<ChainSourceEvidence> => {
      called();
      return {
        status: "unavailable",
        sourceProfile,
        detailDigest: digest(`${sourceProfile}:unavailable`),
        observedAtMs: NOW + 1,
      };
    },
  });
  return new ChainEvidenceModule(
    unavailable("primary"),
    unavailable("witness"),
    store,
    policy,
    () => NOW + 1
  );
}

function acceptedRecord(request: ChainEvidenceRequest): ChainEvidenceRecord {
  return {
    profile: CHAIN_EVIDENCE_PROFILE,
    operationId: request.operationId,
    operation: request.operation,
    transactionId: request.transactionId,
    status: "present",
    level: "accepted",
    view: "historical",
    mechanism: request.mechanism,
    protocolFinality: request.protocolFinality,
    operatorFloor: "accepted",
    effectiveFloor: "accepted",
    primaryProfile: CHAIN_EVIDENCE_OPERATOR_PROFILE,
    witnessProfile: CHAIN_EVIDENCE_WITNESS_PROFILE,
    blockHash: "22".repeat(32),
    acceptingBlockHash: "33".repeat(32),
    acceptingBlockDaaScore: "100",
    virtualDaaScore: "101",
    outputsDigest: outputsDigest(request),
    detailDigest: digest("retained"),
    observedAtMs: NOW,
  };
}

function memoryStore() {
  const records: ChainEvidenceRecord[] = [];
  return {
    records,
    findRetained(query: AcceptedChainEvidenceQuery) {
      return [...records].reverse().filter((record) =>
        record.profile === query.profile &&
        record.operationId === query.operationId &&
        record.operation === query.operation &&
        record.transactionId === query.transactionId &&
        record.outputsDigest === query.outputsDigest &&
        record.mechanism === query.mechanism &&
        record.protocolFinality === query.protocolFinality &&
        record.operatorFloor === query.operatorFloor &&
        record.effectiveFloor === query.effectiveFloor &&
        record.status === "present" &&
        record.level !== undefined &&
        record.level !== "provisional"
      );
    },
    record(record: ChainEvidenceRecord) {
      records.push(record);
      return record;
    },
  };
}
