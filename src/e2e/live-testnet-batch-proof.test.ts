import * as assert from "node:assert/strict";
import test from "node:test";

import type { ChainEvidenceModule } from "../chain-evidence/module.js";
import { evidenceDigest } from "../purchase/identity.js";
import {
  observeAcceptedBatchClaim,
  recoverLiveBatchClaim,
  resumeOrStartLiveBatchRefund,
  type LiveBatchClaimEvidenceChannel,
} from "./live-testnet-batch-proof.js";

const TRANSACTION_ID = "66".repeat(32);
const MERCHANT = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const CHANNEL: LiveBatchClaimEvidenceChannel = Object.freeze({
  id: "55".repeat(32),
  activeOutpoint: Object.freeze({ txid: "44".repeat(32), index: 0 }),
  activeScriptPublicKey: `0000${"aa".repeat(34)}`,
  escrowAddress: "kaspatest:pppppppppppppppppppppppppppppppppppppppppppppppppppppppp6r49vl",
});

test("live batch restart promotes a pending claim only after independent evidence", async () => {
  const order: string[] = [];
  const result = await recoverLiveBatchClaim({
    merchant: {
      async recoverBatchClaim(_channelId: string, input: unknown) {
        order.push("recover");
        assert.deepEqual(input, {
          transactionId: TRANSACTION_ID,
          finality: "accepted",
        });
        return {
          channel: {},
          transactionId: TRANSACTION_ID,
          finality: "accepted",
          accepted: true,
        };
      },
    } as never,
    chainEvidence: {
      async observe() {
        order.push("evidence");
        return {
          interpretation: "accepted",
          evidence: {
            status: "present",
            level: "accepted",
            detailDigest: evidenceDigest("restart-accepted"),
          },
        };
      },
    } as unknown as ChainEvidenceModule,
    channel: CHANNEL,
    transaction: "unused because the durable attempt has a transaction ID",
    transactionId: TRANSACTION_ID,
    merchantAddress: MERCHANT,
    chainProvider: {
      acceptIndependentEvidence(transactionId: string) {
        order.push("provider");
        assert.equal(transactionId, TRANSACTION_ID);
      },
    } as never,
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(order, ["evidence", "provider", "recover"]);
});

interface CapturedEvidenceRequest {
  readonly transactionId: string;
  readonly expectedInputs: readonly Readonly<{ transactionId: string; index: number }>[];
  readonly expectedOutputs: readonly Readonly<{
    amountAtomic: string;
    scriptPublicKey: string;
  }>[];
}

test("live batch claim promotion requires central accepted Chain Evidence", async () => {
  let unavailableRequest: unknown;
  await assert.rejects(
    observeAcceptedBatchClaim({
      chainEvidence: {
        observe: async (request: unknown) => {
          unavailableRequest = request;
          return {
            interpretation: "unavailable",
            evidence: {
              status: "unavailable",
              detailDigest: evidenceDigest("single-node-only"),
            },
          };
        },
      } as unknown as ChainEvidenceModule,
      channel: CHANNEL,
      transactionId: TRANSACTION_ID,
      merchantAddress: MERCHANT,
    }),
    /lacks independent accepted Chain Evidence/,
  );
  assert.ok(unavailableRequest);

  let acceptedRequest: CapturedEvidenceRequest | undefined;
  const accepted = await observeAcceptedBatchClaim({
    chainEvidence: {
      observe: async (request: unknown) => {
        acceptedRequest = request as CapturedEvidenceRequest;
        return {
          interpretation: "accepted",
          evidence: {
            status: "present",
            level: "accepted",
            detailDigest: evidenceDigest("dual-source-accepted"),
          },
        };
      },
    } as unknown as ChainEvidenceModule,
    channel: CHANNEL,
    transactionId: TRANSACTION_ID,
    merchantAddress: MERCHANT,
  });
  assert.equal(accepted.level, "accepted");
  assert.ok(acceptedRequest);
  assert.equal(acceptedRequest.transactionId, TRANSACTION_ID);
  assert.deepEqual(acceptedRequest.expectedInputs, [{
    transactionId: CHANNEL.activeOutpoint.txid,
    index: CHANNEL.activeOutpoint.index,
  }]);
  assert.equal(acceptedRequest.expectedOutputs[0].amountAtomic, "10000000");
  assert.equal(acceptedRequest.expectedOutputs[1].amountAtomic, "28000000");
  assert.equal(acceptedRequest.expectedOutputs[1].scriptPublicKey, CHANNEL.activeScriptPublicKey);
});

test("live batch proof resumes a durably completed refund without submitting again", async () => {
  let refundCalls = 0;
  const completed = {
    operationKey: `batch.refund.${CHANNEL.id}`,
    state: "completed",
    transactionId: TRANSACTION_ID,
  };
  const result = await resumeOrStartLiveBatchRefund({
    channelId: CHANNEL.id,
    channelStatus: "refunded",
    treasury: {
      status(operationKey: string) {
        assert.equal(operationKey, completed.operationKey);
        return completed as never;
      },
    },
    refund: {
      async refund() {
        refundCalls += 1;
        return completed as never;
      },
    },
  });
  assert.equal(result.transactionId, TRANSACTION_ID);
  assert.equal(refundCalls, 0);
});

test("live batch proof starts a refund while the channel remains refundable", async () => {
  let statusCalls = 0;
  let refundCalls = 0;
  const result = await resumeOrStartLiveBatchRefund({
    channelId: CHANNEL.id,
    channelStatus: "refundable",
    treasury: {
      status() {
        statusCalls += 1;
        throw new Error("unexpected status lookup");
      },
    },
    refund: {
      async refund(channelId: string) {
        assert.equal(channelId, CHANNEL.id);
        refundCalls += 1;
        return {
          state: "completed",
          transactionId: TRANSACTION_ID,
        } as never;
      },
    },
  });
  assert.equal(result.transactionId, TRANSACTION_ID);
  assert.equal(statusCalls, 0);
  assert.equal(refundCalls, 1);
});
