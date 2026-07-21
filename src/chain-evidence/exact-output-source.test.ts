import assert from "node:assert/strict";
import test from "node:test";

import { ChainEvidenceExactOutputSource } from "./exact-output-source.js";
import type { ChainEvidenceRequest } from "./types.js";

const TRANSACTION_ID = "11".repeat(32);
const SCRIPT = `000020${"22".repeat(32)}ac`;

test("exact Chain Evidence records the selected alpha.9 profile mechanism", async () => {
  const requests: ChainEvidenceRequest[] = [];
  const source = new ChainEvidenceExactOutputSource(
    {
      async observe(request: ChainEvidenceRequest) {
        requests.push(request);
        return {
          profile: "urn:sompi:chain-evidence:testnet-10:1",
          operationId: request.operationId,
          operation: request.operation,
          transactionId: request.transactionId,
          status: "absent",
          mechanism: request.mechanism,
          protocolFinality: request.protocolFinality,
          operatorFloor: request.operatorFloor,
          effectiveFloor: request.operatorFloor,
          primaryProfile: "test-primary",
          witnessProfile: "test-witness",
          outputsDigest: `sha256:${"A".repeat(43)}`,
          detailDigest: `sha256:${"B".repeat(43)}`,
          observedAtMs: 1,
        };
      },
    } as never,
    "accepted"
  );

  for (const profile of ["standard-native", "additive"] as const) {
    await source.observeExactOutput({
      network: "kaspa:testnet-10",
      profile,
      transactionId: TRANSACTION_ID,
      outpoint: `${TRANSACTION_ID}:0`,
      outputIndex: 0,
      merchantAddress: "kaspatest:qmerchant",
      expectedAmountAtomic: "20000000",
      expectedScriptPublicKey: SCRIPT,
      minimumFinality: "accepted",
      deadlineAtMs: 2,
      signal: new AbortController().signal,
    });
  }

  assert.deepEqual(
    requests.map((request) => request.mechanism),
    ["ordinary", "kip10-script-template"]
  );
});
