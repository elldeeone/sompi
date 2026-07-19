import assert from "node:assert/strict";
import test from "node:test";

import { WalletViewModule } from "./module.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";

test("Wallet View reports authoritative vault balance, reservations, and policy limits", async () => {
  const module = fixture();
  const view = await module.wallet();
  assert.equal(view.network, "kaspa:testnet-10");
  assert.equal(view.balance.observedAtomic, "5000");
  assert.equal(view.balance.reservedAtomic, "1200");
  assert.equal(view.balance.availableAtomic, "3800");
  assert.equal(view.limits.maxPerTransferAtomic, "2000");
  assert.equal(view.chainStatus, "observed");
});

test("Wallet View fails read-only balance closed and bounds merged activity", async () => {
  const module = fixture({ unavailable: true });
  const view = await module.wallet();
  assert.equal(view.chainStatus, "unavailable");
  assert.equal(view.balance.availableAtomic, "0");
  assert.deepEqual(module.activity(2).map((entry) => [entry.kind, entry.id]), [
    ["transfer", "trf_0123456789ABCDEFGHIJKL"],
    ["purchase", "pur_0123456789ABCDEFGHIJKL"],
  ]);
  assert.throws(() => module.activity(101), /between 1 and 100/);
});

function fixture(input: { unavailable?: boolean } = {}): WalletViewModule {
  return new WalletViewModule({
    wallet: { address: ADDRESS } as any,
    vault: {
      config: () => ({
        template: "vault", agentPublic: "a", ownerPublic: "b", maxOutflowSompi: "10000",
        windowSizeDaa: "100", windowStartDaa: "1", spentInWindowSompi: "250", address: ADDRESS,
        covenantId: "00".repeat(32), currentOutpoint: { txid: "11".repeat(32), index: 0 },
      }),
      balanceBreakdown: async () => {
        if (input.unavailable) throw new Error("node unavailable");
        return { spendableSompi: 5000n, unboundSompi: 300n };
      },
    } as any,
    treasury: { pendingCapacityUsed: () => 1200n } as any,
    policy: { policy: { maxSompiPerTx: 2000n, maxSompiPerHour: 8000n, requireApprovalAboveSompi: 1n, allowlist: [ADDRESS] } } as any,
    journal: {
      listTransfers: () => [{
        id: "trf_0123456789ABCDEFGHIJKL", requestKey: "send:one", state: "receipted",
        amountAtomic: "1000", destination: ADDRESS, transactionId: "22".repeat(32),
        createdAtMs: 1_900_000_000_200, updatedAtMs: 1_900_000_000_300,
      }],
      listPurchases: () => [{
        id: "pur_0123456789ABCDEFGHIJKL", requestKey: "buy:one", state: "receipted",
        createdAtMs: 1_900_000_000_100, updatedAtMs: 1_900_000_000_400,
      }],
      findCheckoutTerms: () => ({ amountAtomic: "2000", payTo: ADDRESS }),
      findSettlementForPurchase: () => ({ transactionId: "33".repeat(32) }),
    } as any,
    now: () => 1_900_000_000_500,
  });
}
