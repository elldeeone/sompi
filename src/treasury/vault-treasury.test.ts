import assert from "node:assert/strict";
import test from "node:test";

import { VaultTreasuryModule } from "./vault-treasury.js";

test("vault Treasury returns one stable policy and exact additional-cost ceiling", async () => {
  const treasury = new VaultTreasuryModule({
    vault: { configured: true, config: () => ({ configured: true, covenantId: "aa".repeat(32) }) },
    policy: {
      maxPerPaymentAtomic: "1000000000",
      maxPerHourAtomic: "5000000000",
      approvalAboveAtomic: "0",
      allowlist: [],
    },
    additionalCostCeilingAtomic: "15000000",
  });
  assert.equal((await treasury.currentPolicy()).maxPerPaymentAtomic, "1000000000");
  assert.deepEqual(await treasury.quote({ terms: { asset: "KAS", network: "kaspa:testnet-10" } as never }), {
    additionalCostCeilingAtomic: "15000000",
    reservationTtlMs: 120000,
    ready: true,
  });
});

test("vault Treasury reads and copies current operator policy on every call", async () => {
  let policy = {
    maxPerPaymentAtomic: "100",
    maxPerHourAtomic: "500",
    approvalAboveAtomic: "0",
    allowlist: ["merchant-b", "merchant-a"],
  };
  const treasury = new VaultTreasuryModule({
    vault: {
      configured: true,
      config: () => ({ covenantId: "aa".repeat(32) }),
    },
    policy: () => policy,
    additionalCostCeilingAtomic: "1",
  });
  const first = await treasury.currentPolicy();
  assert.deepEqual(first.allowlist, ["merchant-a", "merchant-b"]);

  policy = {
    maxPerPaymentAtomic: "250",
    maxPerHourAtomic: "1000",
    approvalAboveAtomic: "50",
    allowlist: ["merchant-c"],
  };
  const second = await treasury.currentPolicy();
  assert.equal(second.maxPerPaymentAtomic, "250");
  assert.equal(second.maxPerHourAtomic, "1000");
  assert.equal(second.approvalAboveAtomic, "50");
  assert.deepEqual(second.allowlist, ["merchant-c"]);
  assert.notEqual(second, first);
  assert.notEqual(second.allowlist, policy.allowlist);

  policy = { ...policy, allowlist: [" merchant-c"] };
  await assert.rejects(treasury.currentPolicy(), /allowlist entry is invalid/);
});

test("vault Treasury reports fail-closed readiness blockers", async () => {
  const treasury = new VaultTreasuryModule({
    vault: { configured: false, config: () => ({ configured: false }) },
    policy: {
      maxPerPaymentAtomic: "1",
      maxPerHourAtomic: "1",
      approvalAboveAtomic: "0",
      allowlist: [],
    },
    additionalCostCeilingAtomic: "1",
  });
  assert.equal((await treasury.quote({ terms: { asset: "KAS", network: "kaspa:testnet-10" } as never })).blockerCode, "vault_not_configured");
  assert.equal((await treasury.quote({ terms: { asset: "BTC", network: "other" } as never })).blockerCode, "unsupported_asset_or_network");
});

test("vault Treasury turns backend exceptions and malformed covenant identity into unavailable readiness", async () => {
  const policy = {
    maxPerPaymentAtomic: "1",
    maxPerHourAtomic: "1",
    approvalAboveAtomic: "0",
    allowlist: [],
  };
  const throwing = new VaultTreasuryModule({
    vault: {
      get configured(): boolean {
        throw new Error("backend unavailable");
      },
      config: () => ({ covenantId: "aa".repeat(32) }),
    },
    policy,
    additionalCostCeilingAtomic: "1",
  });
  assert.equal(
    (await throwing.quote({
      terms: { asset: "KAS", network: "kaspa:testnet-10" } as never,
    })).blockerCode,
    "vault_unavailable"
  );

  const malformed = new VaultTreasuryModule({
    vault: {
      configured: true,
      config: () => ({ covenantId: "not-a-covenant-id" }),
    },
    policy,
    additionalCostCeilingAtomic: "1",
  });
  assert.equal(
    (await malformed.quote({
      terms: { asset: "KAS", network: "kaspa:testnet-10" } as never,
    })).blockerCode,
    "vault_unavailable"
  );
});
