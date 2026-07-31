import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PolicyEngine } from "../policy.js";
import { PurchaseJournal } from "../purchase/journal.js";
import type { TreasuryOperationAdapter } from "./operation-adapters.js";
import type {
  TreasuryOperationRecord,
} from "./operation-journal.js";
import { TreasuryOperationModule } from "./operations.js";

const NOW = 1_900_000_000_000;

test("Treasury returns the exact Purchase quote and fails readiness closed", async () => {
  await withTreasury(async ({ module, vault, stagingCapacity }) => {
    assert.deepEqual(
      await module.quote({
        purchaseId: "pur_test" as never,
        fundingMode: "staged-payment",
        terms: {
          asset: "KAS",
          network: "kaspa:testnet-10",
          expiresAt: "2099-01-01T00:00:00.000Z",
        } as never,
      }),
      {
        additionalCostCeilingAtomic: "15000000",
        reservationTtlMs: 120000,
        ready: true,
      },
    );

    vault.configured = false;
    assert.equal(
      (await module.quote({
        purchaseId: "pur_test" as never,
        fundingMode: "staged-payment",
        terms: {
          asset: "KAS",
          network: "kaspa:testnet-10",
        } as never,
      })).blockerCode,
      "vault_not_configured",
    );
    assert.equal(
      (await module.quote({
        purchaseId: "pur_test" as never,
        fundingMode: "staged-payment",
        terms: { asset: "BTC", network: "other" } as never,
      })).blockerCode,
      "unsupported_asset_or_network",
    );

    vault.configured = true;
    stagingCapacity.ready = false;
    stagingCapacity.blockerCode = "vault_insufficient_funds";
    assert.deepEqual(
      await module.quote({
        purchaseId: "pur_test" as never,
        fundingMode: "staged-payment",
        terms: {
          amountAtomic: "20000000",
          asset: "KAS",
          network: "kaspa:testnet-10",
        } as never,
      }),
      {
        additionalCostCeilingAtomic: "15000000",
        reservationTtlMs: 120000,
        ready: false,
        blockerCode: "vault_insufficient_funds",
      },
    );
  });
});

test("Treasury turns unavailable or malformed vault state into a closed quote", async () => {
  await withTreasury(async ({ module, vault }) => {
    vault.throwOnConfig = true;
    assert.equal(
      (await module.quote({
        purchaseId: "pur_test" as never,
        fundingMode: "staged-payment",
        terms: {
          asset: "KAS",
          network: "kaspa:testnet-10",
        } as never,
      })).blockerCode,
      "vault_unavailable",
    );

    vault.throwOnConfig = false;
    vault.covenantId = "not-a-covenant-id";
    assert.equal(
      (await module.quote({
        purchaseId: "pur_test" as never,
        fundingMode: "staged-payment",
        terms: {
          asset: "KAS",
          network: "kaspa:testnet-10",
        } as never,
      })).blockerCode,
      "vault_unavailable",
    );
  });
});

test("precapitalized channel capacity does not require a new staging quote", async () => {
  await withTreasury(async ({ module, vault }) => {
    vault.configured = false;
    assert.deepEqual(
      await module.quote({
        purchaseId: "pur_test" as never,
        fundingMode: "precapitalized-channel",
        terms: {
          expiresAt: new Date(NOW + 60_000).toISOString(),
        } as never,
      }),
      {
        additionalCostCeilingAtomic: "0",
        reservationTtlMs: 60_000,
        ready: true,
      },
    );
  });
});

async function withTreasury(
  run: (fixture: {
    module: TreasuryOperationModule;
    vault: MutableVault;
    stagingCapacity: MutableStagingCapacity;
  }) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sompi-purchase-treasury-"),
  );
  fs.chmodSync(directory, 0o700);
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: () => NOW,
  });
  const vault = new MutableVault();
  const stagingCapacity = new MutableStagingCapacity();
  const module = new TreasuryOperationModule({
    journal,
    policy: new PolicyEngine({
      maxSompiPerTx: 1_000_000_000n,
      maxSompiPerHour: 5_000_000_000n,
      allowlist: [],
    }),
    adapters: directAdapters(),
    feeCeilingAtomic: "1",
    purchase: {
      vault,
      additionalCostCeilingAtomic: "15000000",
      staging: unavailableStaging(),
      stagingCapacity,
      stagingRecovery: unavailableStagingRecovery(),
      now: () => NOW,
    },
  });
  try {
    await run({ module, vault, stagingCapacity });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

class MutableStagingCapacity {
  ready = true;
  blockerCode:
    | "vault_insufficient_funds"
    | "vault_fee_exceeds_ceiling"
    | "vault_policy_capacity_unavailable"
    | "vault_unavailable"
    | undefined;

  async quoteStagingCapacity() {
    return {
      ready: this.ready,
      ...(this.blockerCode === undefined
        ? {}
        : { blockerCode: this.blockerCode }),
    };
  }
}

class MutableVault {
  configured = true;
  covenantId = "aa".repeat(32);
  throwOnConfig = false;

  config(): { covenantId: string } {
    if (this.throwOnConfig) throw new Error("vault unavailable");
    return { covenantId: this.covenantId };
  }
}

function directAdapters(): readonly TreasuryOperationAdapter[] {
  return ([
    "wallet_send",
    "vault_send",
    "vault_deposit",
  ] as const).map((kind) => ({
    kind,
    async prepare(record: TreasuryOperationRecord) {
      throw new Error(`unexpected ${record.kind} preparation`);
    },
    async submit() {
      throw new Error("unexpected Treasury submission");
    },
    async observe() {
      throw new Error("unexpected Treasury observation");
    },
    async commit() {
      throw new Error("unexpected Treasury commit");
    },
  }));
}

function unavailableStaging() {
  return {
    async prepareStaging() {
      throw new Error("unexpected staging preparation");
    },
    async submitStaging() {
      throw new Error("unexpected staging submission");
    },
    async observeStaging() {
      throw new Error("unexpected staging observation");
    },
  };
}

function unavailableStagingRecovery() {
  return {
    async prepare() {
      throw new Error("unexpected staging recovery preparation");
    },
    async observe() {
      throw new Error("unexpected staging recovery observation");
    },
    async submit() {
      throw new Error("unexpected staging recovery submission");
    },
  };
}
