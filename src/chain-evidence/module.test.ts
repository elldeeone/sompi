import assert from "node:assert/strict";
import test from "node:test";

import { ChainEvidenceModule, digest, outputsDigest } from "./module.js";
import type {
  AcceptedChainEvidenceQuery,
  ChainEvidenceRecord,
  ChainEvidenceRequest,
  ChainSourceEvidence,
} from "./types.js";

test("two independent exact sources are required before accepted or depth evidence", async () => {
  const request = fixtureRequest();
  const store = memoryStore();
  const accepted = sourceAccepted(request, "accepted");
  const module = new ChainEvidenceModule(
    { observe: async () => accepted("primary") },
    { observe: async () => accepted("witness") },
    store,
    () => 1_800_000_000_000
  );
  const result = await module.observe(request);
  assert.equal(result.status, "present");
  assert.equal(result.level, "accepted");
  assert.equal(result.protocolFinality, "mempool");
  assert.equal(result.operatorFloor, "accepted");
  assert.equal(result.effectiveFloor, "accepted");
  assert.equal(store.records.length, 1);

  const lying = new ChainEvidenceModule(
    { observe: async () => accepted("primary") },
    { observe: async () => ({ ...accepted("witness"), acceptingBlockHash: "44".repeat(32) }) },
    memoryStore(),
    () => 1_800_000_000_000
  );
  assert.equal((await lying.observe(request)).status, "unknown");
});

test("single-source, mempool, errors, and contradictory absence never mint accepted evidence", async () => {
  const request = fixtureRequest();
  const unavailable: ChainSourceEvidence = { status: "unavailable", sourceProfile: "witness", detailDigest: digest("unavailable"), observedAtMs: 1 };
  const provisional: ChainSourceEvidence = { status: "present", level: "provisional", view: "current", sourceProfile: "primary", transactionId: request.transactionId, outputsDigest: outputsDigest(request), detailDigest: digest("mempool"), observedAtMs: 1 };
  const module = new ChainEvidenceModule(
    { observe: async () => provisional },
    { observe: async () => unavailable },
    memoryStore(),
    () => 1_800_000_000_000
  );
  assert.deepEqual(pick(await module.observe(request)), { status: "present", level: "provisional" });

  const absent = { status: "absent", sourceProfile: "witness", detailDigest: digest("absent"), observedAtMs: 1 } as const;
  const conflict = new ChainEvidenceModule(
    { observe: async () => sourceAccepted(request, "accepted")("primary") },
    { observe: async () => absent },
    memoryStore(),
    () => 1_800_000_000_000
  );
  assert.deepEqual(pick(await conflict.observe(request)), { status: "present", level: "provisional" });
});

test("corroborated absence requires a second observation after the propagation interval", async () => {
  const request = fixtureRequest();
  let now = 1_800_000_000_000;
  const absent = (sourceProfile: string): ChainSourceEvidence => ({
    status: "absent",
    sourceProfile,
    detailDigest: digest({ sourceProfile, now }),
    observedAtMs: now,
  });
  const module = new ChainEvidenceModule(
    { observe: async () => absent("primary") },
    { observe: async () => absent("witness") },
    memoryStore(),
    () => now
  );
  assert.equal((await module.observe(request)).status, "unknown");
  now += 999;
  assert.equal((await module.observe(request)).status, "unknown");
  now += 1;
  assert.equal((await module.observe(request)).status, "absent");
  assert.equal(
    (await module.observe(request)).status,
    "absent",
    "a fresh effect-fenced check must reuse the established propagation window"
  );

  now += 30_001;
  assert.equal(
    (await module.observe(request)).status,
    "unknown",
    "a stale absence window must be established again"
  );
});

test("effective floor strengthens Merchant requirements and retained accepted evidence survives spent outputs", async () => {
  const request = { ...fixtureRequest(), protocolFinality: "mempool" as const, operatorFloor: "depth-confirmed" as const };
  const store = memoryStore();
  const depth = sourceAccepted(request, "depth-confirmed");
  const first = new ChainEvidenceModule(
    { observe: async () => depth("primary") },
    { observe: async () => depth("witness") },
    store,
    () => 1_800_000_000_000
  );
  const accepted = await first.observe(request);
  assert.equal(accepted.level, "depth-confirmed");
  assert.equal(accepted.effectiveFloor, "depth-confirmed");

  let called = false;
  const restarted = new ChainEvidenceModule(
    { observe: async () => { called = true; throw new Error("spent and pruned"); } },
    { observe: async () => { called = true; throw new Error("offline"); } },
    store,
    () => 1_800_000_100_000
  );
  const retained = await restarted.observe(request);
  assert.equal(called, false);
  assert.equal(retained.status, "present");
  assert.equal(retained.view, "historical");
});

test("fresh accepted evidence remains nonterminal below the operator finality floor", async () => {
  const request = {
    ...fixtureRequest(),
    protocolFinality: "accepted" as const,
    operatorFloor: "depth-confirmed" as const,
  };
  const accepted = sourceAccepted(request, "accepted");
  const result = await new ChainEvidenceModule(
    { observe: async () => accepted("primary") },
    { observe: async () => accepted("witness") },
    memoryStore(),
    () => 1_800_000_000_000
  ).observe(request);

  assert.equal(result.status, "unknown");
  assert.equal(result.level, undefined);
  assert.equal(result.effectiveFloor, "depth-confirmed");
});

test("retained evidence refuses mismatched output, input, mechanism, or minimum floor", async () => {
  const request = fixtureRequest();
  const store = memoryStore();
  const accepted = sourceAccepted(request, "accepted");
  await new ChainEvidenceModule(
    { observe: async () => accepted("primary") },
    { observe: async () => accepted("witness") },
    store,
    () => 1_800_000_000_000
  ).observe(request);

  let observed = 0;
  const restarted = new ChainEvidenceModule(
    { observe: async () => { observed += 1; return { status: "unavailable", sourceProfile: "primary", detailDigest: digest("primary-unavailable"), observedAtMs: 1_800_000_001_000 }; } },
    { observe: async () => { observed += 1; return { status: "unavailable", sourceProfile: "witness", detailDigest: digest("witness-unavailable"), observedAtMs: 1_800_000_001_000 }; } },
    store,
    () => 1_800_000_001_000
  );
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly request: ChainEvidenceRequest;
  }> = [
    {
      label: "different output",
      request: {
        ...request,
        expectedOutputs: [
          { ...request.expectedOutputs[0], amountAtomic: "124" },
        ],
      },
    },
    {
      label: "different input",
      request: {
        ...request,
        expectedInputs: [{ transactionId: "bb".repeat(32), index: 0 }],
      },
    },
    {
      label: "different mechanism",
      request: { ...request, mechanism: "ordinary" },
    },
    {
      label: "insufficient minimum floor",
      request: { ...request, operatorFloor: "depth-confirmed" },
    },
  ];

  for (const candidate of cases) {
    assert.equal(
      (await restarted.observe(candidate.request)).status,
      "unavailable",
      candidate.label
    );
  }
  assert.equal(observed, cases.length * 2);
});

function fixtureRequest(): ChainEvidenceRequest {
  return {
    operationId: "purchase:1:settlement",
    operation: "settlement",
    network: "kaspa:testnet-10",
    transactionId: "11".repeat(32),
    expectedOutputs: [{ index: 1, amountAtomic: "123", scriptPublicKey: "000020" + "22".repeat(32) + "ac", address: "kaspatest:qfixture" }],
    expectedInputs: [{ transactionId: "aa".repeat(32), index: 0 }],
    watchedAddresses: ["kaspatest:qfixture"],
    mechanism: "kip10-script-template",
    protocolFinality: "mempool",
    operatorFloor: "accepted",
    signal: new AbortController().signal,
  };
}

function sourceAccepted(request: ChainEvidenceRequest, level: "accepted" | "depth-confirmed") {
  return (source: string) => ({
    status: "present" as const,
    level,
    view: "current" as const,
    sourceProfile: source,
    transactionId: request.transactionId,
    blockHash: "22".repeat(32),
    acceptingBlockHash: "33".repeat(32),
    acceptingBlockDaaScore: "100",
    virtualDaaScore: level === "depth-confirmed" ? "120" : "101",
    outputsDigest: outputsDigest(request),
    detailDigest: digest({ source, level }),
    observedAtMs: 1_800_000_000_000,
  });
}

function memoryStore() {
  const records: ChainEvidenceRecord[] = [];
  return {
    records,
    findAccepted(query: AcceptedChainEvidenceQuery) {
      return [...records].reverse().find((record) =>
        record.transactionId === query.transactionId &&
        record.outputsDigest === query.outputsDigest &&
        record.mechanism === query.mechanism &&
        record.status === "present" &&
        record.level !== "provisional" &&
        meetsFloor(record.level, query.minimumLevel)
      );
    },
    record(record: ChainEvidenceRecord) {
      records.push(record);
      return record;
    },
  };
}

function meetsFloor(
  level: ChainEvidenceRecord["level"],
  floor: AcceptedChainEvidenceQuery["minimumLevel"]
): boolean {
  const rank = {
    provisional: 0,
    accepted: 1,
    "depth-confirmed": 2,
    "consensus-final": 3,
  } as const;
  return level !== undefined && rank[level] >= rank[floor];
}

function pick(record: ChainEvidenceRecord) {
  return { status: record.status, ...(record.level ? { level: record.level } : {}) };
}
