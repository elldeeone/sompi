import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PurchaseJournal } from "../purchase/journal.js";
import { vaultMigrationFactsDigest, VaultMigrationModule } from "./module.js";
import type { VaultMigrationFacts, VaultMigrationExecutionResult } from "./types.js";
import { generateOwnerKey, VaultManager } from "../vault.js";
import type { Sha256Digest } from "../purchase/types.js";

const DIGEST = `sha256:${"A".repeat(43)}` as Sha256Digest;
const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";

test("Vault Migration requires owner approval, preserves the receive identity and carries rolling spend", async () => {
  const fixture = createFixture();
  try {
    const proposed = await fixture.module.propose({ requestKey: "vault:raise:one", newMaximumOutflowAtomic: "200000000" });
    assert.equal(proposed.state, "awaiting_owner");
    assert.equal(proposed.receiveAddressUnchanged, true);
    assert.equal(fixture.vault.config().spentInWindowSompi, "0");
    const applied = await fixture.module.execute(proposed.id, fixture.executor);
    assert.equal(applied.state, "applied");
    assert.equal(applied.summary, "Vault protection updated; your receive address has not changed.");
    assert.equal(fixture.executedFacts?.stableReceiveAddress, ADDRESS);
    assert.equal(fixture.executedFacts?.spentInWindowAtomic, "0");
    assert.deepEqual(fixture.vault.calls, ["begin", "finish"]);
  } finally { fixture.close(); }
});

test("denial, request substitution and ambiguous owner execution fail closed", async () => {
  const denied = createFixture(false);
  try {
    const view = await denied.module.propose({ requestKey: "vault:deny", newMaximumOutflowAtomic: "200000000" });
    assert.equal(view.state, "denied");
    await assert.rejects(() => denied.module.execute(view.id, denied.executor), /not ready/);
  } finally { denied.close(); }

  const fixture = createFixture();
  try {
    const first = await fixture.module.propose({ requestKey: "vault:ambiguous", newMaximumOutflowAtomic: "200000000" });
    await assert.rejects(
      () => fixture.module.propose({ requestKey: "vault:ambiguous", newMaximumOutflowAtomic: "300000000" }),
      /different protection/,
    );
    await assert.rejects(() => fixture.module.execute(first.id, {
      ...fixture.executor,
      async execute() { throw new Error("connection lost after submit"); },
    }), /needs operator reconciliation/);
    assert.equal(fixture.module.status(first.id).state, "reconciliation_required");
    assert.equal((await fixture.module.recover(first.id, fixture.executor)).state, "applied");
  } finally { fixture.close(); }
});

test("vault protection cannot be lowered below the active everyday hourly limit", async () => {
  const fixture = createFixture(true, "150000000");
  try {
    await assert.rejects(
      () => fixture.module.propose({ requestKey: "vault:too-low", newMaximumOutflowAtomic: "100000000" }),
      /lower the everyday hourly limit/,
    );
  } finally { fixture.close(); }
});

test("execution rechecks everyday limits changed after vault approval", async () => {
  const fixture = createFixture();
  try {
    const proposed = await fixture.module.propose({ requestKey: "vault:policy-race", newMaximumOutflowAtomic: "200000000" });
    fixture.setEverydayMaximumAtomic("300000000");
    await assert.rejects(() => fixture.module.execute(proposed.id, fixture.executor), /lower the everyday hourly limit/);
    assert.deepEqual(fixture.vault.calls, []);
  } finally { fixture.close(); }
});

test("execution rejects any policy generation change after vault approval", async () => {
  const fixture = createFixture();
  try {
    const proposed = await fixture.module.propose({
      requestKey: "vault:policy-generation-race",
      newMaximumOutflowAtomic: "200000000",
    });
    fixture.setEverydayMaximumAtomic("150000000");
    await assert.rejects(
      () => fixture.module.execute(proposed.id, fixture.executor),
      /everyday policy changed after Vault Migration approval/,
    );
    assert.deepEqual(fixture.vault.calls, []);
  } finally { fixture.close(); }
});

test("expiry between readiness and Journal execution clears the durable vault fence", async () => {
  const fixture = createFixture();
  try {
    const proposed = await fixture.module.propose({
      requestKey: "vault:expiry-boundary",
      newMaximumOutflowAtomic: "200000000",
    });
    const assertReady = fixture.journal.assertVaultMigrationExecutionReady.bind(fixture.journal);
    fixture.journal.assertVaultMigrationExecutionReady = (id: string) => {
      const ready = assertReady(id);
      fixture.setNow(Date.parse(proposed.expiresAt));
      return ready;
    };
    await assert.rejects(
      fixture.module.execute(proposed.id, fixture.executor),
      /approval expired before offline-owner execution/,
    );
    assert.equal(fixture.realVault.migrationFence(), undefined);
    assert.deepEqual(fixture.vault.calls, ["begin", "abort"]);
  } finally { fixture.close(); }
});

function createFixture(approve = true, everydayMaximumAtomic = "100000000") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-migration-"));
  let now = 1_800_000_000_000;
  const journal = new PurchaseJournal(path.join(directory, "journal.sqlite"), { now: () => now });
  journal.installPolicy({
    maxPerPaymentAtomic: everydayMaximumAtomic,
    maxPerHourAtomic: everydayMaximumAtomic,
    allowlist: [],
  });
  const realVault = new VaultManager(directory, "testnet-10");
  realVault.create(100_000_000n, generateOwnerKey().publicKey, 36_000n);
  const vault = {
    calls: [] as string[],
    config: () => realVault.config(),
    beginMigration(id: string, digest: string) { vault.calls.push("begin"); realVault.beginMigration(id, digest); },
    finishMigration(id: string, digest: string) { vault.calls.push("finish"); realVault.finishMigration(id, digest); },
    abortMigration(id: string, digest: string) { vault.calls.push("abort"); realVault.abortMigration(id, digest); },
  };
  let executedFacts: VaultMigrationFacts | undefined;
  const result: VaultMigrationExecutionResult = {
    recoveryTransactionId: "33".repeat(32), replacementTransactionId: "44".repeat(32),
    stableReceiveAddress: ADDRESS, newMaximumOutflowAtomic: "200000000",
    windowStartDaa: "0", spentInWindowAtomic: "0", receiptDigest: DIGEST,
  };
  const executor = {
    async execute(facts: VaultMigrationFacts) { executedFacts = facts; return result; },
    async reconcile(facts: VaultMigrationFacts) { executedFacts = facts; return result; },
  };
  let activeEverydayMaximumAtomic = everydayMaximumAtomic;
  const module = new VaultMigrationModule({
    journal, vault: vault as unknown as VaultManager, wallet: { address: ADDRESS },
    authority: { async request(facts) {
      const evidence = Buffer.from("owner decision");
      return {
        decision: approve ? "approved" as const : "denied" as const,
        authorityId: "owner", evidence,
        evidenceDigest: `sha256:${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(evidence).digest("base64url"))}` as Sha256Digest,
        factsDigest: vaultMigrationFactsDigest(facts), decidedAtMs: 1_800_000_000_000,
      };
    } },
    everydayMaximumAtomic: () => activeEverydayMaximumAtomic,
    manifest: () => ({ revision: 1, digest: DIGEST }), now: () => now,
  });
  return {
    module,
    journal,
    vault,
    realVault,
    executor,
    setEverydayMaximumAtomic(value: string) {
      activeEverydayMaximumAtomic = value;
      journal.installPolicy({
        maxPerPaymentAtomic: value,
        maxPerHourAtomic: value,
        allowlist: [],
      });
    },
    setNow(value: number) { now = value; },
    get executedFacts() { return executedFacts; },
    close() { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
