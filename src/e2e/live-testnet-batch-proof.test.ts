import * as assert from "node:assert/strict";
import test from "node:test";

import type { ChainEvidenceModule } from "../chain-evidence/module.js";
import { evidenceDigest } from "../purchase/identity.js";
import {
  observeAcceptedBatchClaim,
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
            status: "unavailable",
            detailDigest: evidenceDigest("single-node-only"),
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
          status: "present",
          level: "accepted",
          detailDigest: evidenceDigest("dual-source-accepted"),
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
