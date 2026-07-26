import assert from "node:assert/strict";
import test from "node:test";

import { ChainEvidenceExactOutputSource } from "./exact-output-source.js";
import {
  CHAIN_EVIDENCE_PROFILE,
  type ChainEvidenceObservation,
  type ChainEvidenceRecord,
  type ChainEvidenceRequest,
} from "./types.js";

const TRANSACTION_ID = "11".repeat(32);
const SCRIPT = `000020${"22".repeat(32)}ac`;

test("exact Chain Evidence records the selected alpha.9 profile mechanism", async () => {
  const requests: ChainEvidenceRequest[] = [];
  const source = new ChainEvidenceExactOutputSource({
    async observe(request: ChainEvidenceRequest) {
      requests.push(request);
      return observation(request, "absent");
    },
  } as never);

  for (const profile of ["standard-native", "additive"] as const) {
    const result = await source.observeExactOutput(
      exactRequest(profile, "accepted")
    );
    assert.equal(result.status, "pending");
  }

  assert.deepEqual(
    requests.map((request) => request.mechanism),
    ["ordinary", "kip10-script-template"]
  );
  assert.equal(
    requests.every(
      (request) => !Object.prototype.hasOwnProperty.call(request, "operatorFloor")
    ),
    true
  );
});

test("provisional Chain Evidence always remains pending, including Merchant mempool minimum", async () => {
  const requests: ChainEvidenceRequest[] = [];
  const source = new ChainEvidenceExactOutputSource({
    async observe(request: ChainEvidenceRequest) {
      requests.push(request);
      return observation(request, "provisional");
    },
  } as never);

  for (const minimumFinality of [
    "mempool",
    "accepted",
    "confirmed",
  ] as const) {
    const result = await source.observeExactOutput(
      exactRequest("standard-native", minimumFinality)
    );
    assert.deepEqual(
      result,
      {
        status: "pending",
        detailDigest: `sha256:${"B".repeat(43)}`,
      },
      minimumFinality
    );
  }

  assert.deepEqual(
    requests.map((request) => request.protocolFinality),
    ["mempool", "accepted", "confirmed"]
  );
});

function exactRequest(
  profile: "standard-native" | "additive",
  minimumFinality: "mempool" | "accepted" | "confirmed"
) {
  return {
    network: "kaspa:testnet-10" as const,
    profile,
    transactionId: TRANSACTION_ID,
    outpoint: `${TRANSACTION_ID}:0`,
    outputIndex: 0,
    merchantAddress: "kaspatest:qmerchant",
    expectedAmountAtomic: "20000000",
    expectedScriptPublicKey: SCRIPT,
    minimumFinality,
    deadlineAtMs: 2,
    signal: new AbortController().signal,
  };
}

function observation(
  request: ChainEvidenceRequest,
  interpretation: "provisional" | "absent"
): ChainEvidenceObservation {
  const evidence: ChainEvidenceRecord = {
    profile: CHAIN_EVIDENCE_PROFILE,
    operationId: request.operationId,
    operation: request.operation,
    transactionId: request.transactionId,
    status: interpretation === "provisional" ? "present" : "absent",
    ...(interpretation === "provisional"
      ? { level: "provisional" as const, view: "current" as const }
      : {}),
    mechanism: request.mechanism,
    protocolFinality: request.protocolFinality,
    operatorFloor: "accepted",
    effectiveFloor:
      request.protocolFinality === "confirmed"
        ? "depth-confirmed"
        : "accepted",
    primaryProfile: "test-primary",
    witnessProfile: "test-witness",
    outputsDigest: `sha256:${"A".repeat(43)}`,
    detailDigest: `sha256:${"B".repeat(43)}`,
    observedAtMs: 1,
  };
  return {
    interpretation,
    evidence,
    finality: {
      operation: request.operation,
      protocolFinality: request.protocolFinality,
      operatorFloor: "accepted",
      effectiveFloor:
        request.protocolFinality === "confirmed"
          ? "depth-confirmed"
          : "accepted",
      depthConfirmationDaa: "10",
    },
  };
}
