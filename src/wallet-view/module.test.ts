import assert from "node:assert/strict";
import test from "node:test";

import { WalletViewModule } from "./module.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";

test("Wallet View presents one address, one balance, and simple spending protection", async () => {
  const module = fixture();
  const view = await module.wallet();
  assert.equal(view.network, "kaspa:testnet-10");
  assert.equal(view.receive.address, ADDRESS);
  assert.equal(view.balance.total.display, "0.000053 tKAS");
  assert.equal(view.balance.incoming.atomic, "300");
  assert.equal(view.balance.pending.atomic, "1200");
  assert.equal(view.balance.available.atomic, "3800");
  assert.equal(view.spendingProtection.maximumPerPayment.atomic, "2000");
  assert.equal(view.spendingProtection.everyPaymentRequiresApproval, true);
  assert.equal(view.spendingProtection.vaultProtection.remainingInWindow.atomic, "9750");
  assert.equal("security" in view, false);
  assert.equal(view.securing.state, "detected");
  assert.equal(view.chainStatus, "observed");
});

test("technical wallet details are available only through the explicit view", () => {
  const module = fixture();
  const details = module.technical();
  assert.equal(details.receiveAddress, ADDRESS);
  assert.equal(details.activeVault.address, ADDRESS);
  assert.equal(details.activeVault.windowSizeDaa, "100");
  assert.deepEqual(details.allowlist, [ADDRESS]);
});

test("Wallet View fails read-only balance closed and bounds merged activity", async () => {
  const module = fixture({ unavailable: true });
  const view = await module.wallet();
  assert.equal(view.chainStatus, "unavailable");
  assert.equal(view.balance.available.atomic, "0");
  assert.deepEqual((await module.activity(2)).map((entry) => [entry.kind, entry.id]), [
    ["transfer", "trf_0123456789ABCDEFGHIJKL"],
    ["purchase", "pur_0123456789ABCDEFGHIJKL"],
  ]);
  await assert.rejects(() => module.activity(101), /between 1 and 100/);
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
    fundingIntake: {
      status: async () => ({
        state: "detected", automatic: true, incomingAtomic: "300", minimumToSecureAtomic: "101",
        summary: "Incoming funds were detected and are queued for automatic securing.", userAction: "wait",
        incomingUtxos: [],
      }),
    } as any,
    treasury: { pendingCapacityUsed: () => 1200n, recent: () => [] } as any,
    policy: { policy: { maxSompiPerTx: 2000n, maxSompiPerHour: 8000n,allowlist: [ADDRESS] } } as any,
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
      findCheckoutTerms: () => ({ amountAtomic: "2000", payTo: ADDRESS, merchant: { name: "Test merchant", origin: "https://merchant.example" } }),
      findSettlementForPurchase: () => ({ transactionId: "33".repeat(32), actualAdditionalCostAtomic: "50" }),
    } as any,
    now: () => 1_900_000_000_500,
  });
}
