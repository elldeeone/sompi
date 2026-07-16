import * as assert from "node:assert/strict";
import test from "node:test";

import { evidenceDigest } from "./identity.js";
import { canonicalPurchaseExecutionPlan, channelEpochDigest } from "./execution-plan.js";

const requirementsDigest = evidenceDigest(Buffer.from("requirements"));

test("canonical execution plans distinguish exact settlement from a bound channel voucher", () => {
  const exact = canonicalPurchaseExecutionPlan({
    mechanism: "single-transaction",
    profile: "kaspa-exact-v2:standard-native",
    requirementsDigest,
    maximumChargeAtomic: "20",
    settlementAssurance: "accepted",
  });
  assert.equal(exact.channelEpoch, undefined);
  assert.equal(channelEpochDigest(exact), undefined);

  const batch = canonicalPurchaseExecutionPlan({
    mechanism: "channel-voucher",
    profile: "kaspa-escrow-v1:batch-settlement",
    requirementsDigest,
    maximumChargeAtomic: "20",
    settlementAssurance: "channel-commitment",
    claimFeeReserveAtomic: "10",
    channelEpoch: {
      channelId: "11".repeat(32),
      activeOutpoint: { txid: "22".repeat(32), index: 0 },
      activeScriptPublicKey: `000020${"33".repeat(32)}`,
      fundingAmountAtomic: "100",
      refundTimeoutDaa: "499999999",
    },
  });
  assert.match(batch.digest, /^sha256:/);
  assert.match(channelEpochDigest(batch)!, /^sha256:/);
});

test("execution plans reject unbound or underfunded channel authorization", () => {
  assert.throws(() => canonicalPurchaseExecutionPlan({
    mechanism: "channel-voucher",
    profile: "kaspa-escrow-v1:batch-settlement",
    requirementsDigest,
    maximumChargeAtomic: "20",
    settlementAssurance: "channel-commitment",
  }), /bound channel epoch/);
  assert.throws(() => canonicalPurchaseExecutionPlan({
    mechanism: "channel-voucher",
    profile: "kaspa-escrow-v1:batch-settlement",
    requirementsDigest,
    maximumChargeAtomic: "20",
    settlementAssurance: "channel-commitment",
    claimFeeReserveAtomic: "10",
    channelEpoch: {
      channelId: "11".repeat(32),
      activeOutpoint: { txid: "22".repeat(32), index: 0 },
      activeScriptPublicKey: `000020${"33".repeat(32)}`,
      fundingAmountAtomic: "29",
      refundTimeoutDaa: "499999999",
    },
  }), /exceeds the channel funding/);
});
