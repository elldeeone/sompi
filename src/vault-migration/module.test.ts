import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SompiOperationFailure } from "../operation-failure.js";
import { PurchaseJournal } from "../purchase/journal.js";
import { vaultMigrationFactsDigest, VaultMigrationModule } from "./module.js";
import type { VaultMigrationDecision, VaultMigrationFacts, VaultMigrationExecutionResult } from "./types.js";
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
      operationFailure("VAULT_MIGRATION_CONFLICT"),
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
      operationFailure("INVALID_VAULT_MIGRATION"),
    );
  } finally { fixture.close(); }
});

test("a malformed everyday-limit projection stays an internal failure", async () => {
  const fixture = createFixture();
  try {
    fixture.setEverydayMaximumProjection("not-an-atomic-amount");
    await assert.rejects(
      () => fixture.module.propose({
        requestKey: "vault:malformed-everyday-limit",
        newMaximumOutflowAtomic: "200000000",
      }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof SompiOperationFailure) &&
        error.message === "Vault Migration everyday maximum is invalid",
    );
  } finally { fixture.close(); }
});

test("Vault Migration absence is stable and Journal faults stay internal", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => fixture.module.status("vmg_AAAAAAAAAAAAAAAAAAAAAA"),
      operationFailure("VAULT_MIGRATION_NOT_FOUND"),
    );

    fixture.journal.vaultMigration = () => {
      throw new Error("injected Journal storage fault");
    };
    assert.throws(
      () => fixture.module.status("vmg_AAAAAAAAAAAAAAAAAAAAAA"),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof SompiOperationFailure) &&
        error.message === "injected Journal storage fault",
    );
  } finally { fixture.close(); }
});

test("a same-intent Vault Migration creation race returns the Journal winner", async () => {
  const fixture = createFixture();
  try {
    const intent = {
      requestKey: "vault:create-race:same-intent",
      newMaximumOutflowAtomic: "200000000",
    };
    const winner = await fixture.module.propose(intent);
    hideNextVaultMigrationRequestLookup(fixture.journal);

    const loser = await fixture.module.propose(intent);
    assert.equal(loser.id, winner.id);
    assert.equal(loser.state, winner.state);
  } finally { fixture.close(); }
});

test("a changed-intent Vault Migration creation race maps the Journal conflict", async () => {
  const fixture = createFixture();
  try {
    await fixture.module.propose({
      requestKey: "vault:create-race:changed-intent",
      newMaximumOutflowAtomic: "200000000",
    });
    hideNextVaultMigrationRequestLookup(fixture.journal);

    await assert.rejects(
      fixture.module.propose({
        requestKey: "vault:create-race:changed-intent",
        newMaximumOutflowAtomic: "300000000",
      }),
      operationFailure("VAULT_MIGRATION_CONFLICT"),
    );
  } finally { fixture.close(); }
});

test("an active-policy digest CAS race maps the Journal conflict", async () => {
  const fixture = createFixture();
  try {
    const createVaultMigration = fixture.journal.createVaultMigration.bind(fixture.journal);
    fixture.journal.createVaultMigration = (input) => {
      fixture.journal.installPolicy({
        maxPerPaymentAtomic: "110000000",
        maxPerHourAtomic: "110000000",
        allowlist: [],
      });
      return createVaultMigration(input);
    };

    await assert.rejects(
      fixture.module.propose({
        requestKey: "vault:create-race:policy-digest",
        newMaximumOutflowAtomic: "200000000",
      }),
      operationFailure("VAULT_MIGRATION_CONFLICT"),
    );
  } finally { fixture.close(); }
});

test("an active-policy generation CAS race maps the Journal conflict", async () => {
  const fixture = createFixture();
  try {
    const initial = fixture.journal.requireActivePolicyActivation();
    const createVaultMigration = fixture.journal.createVaultMigration.bind(fixture.journal);
    let racedGeneration: number | undefined;
    fixture.journal.createVaultMigration = (input) => {
      fixture.journal.installPolicy({
        maxPerPaymentAtomic: "50000000",
        maxPerHourAtomic: "50000000",
        allowlist: [],
      });
      fixture.journal.installPolicy({
        maxPerPaymentAtomic: initial.policy.maxPerPaymentAtomic,
        maxPerHourAtomic: initial.policy.maxPerHourAtomic,
        allowlist: initial.policy.allowlist,
      });
      const restored = fixture.journal.requireActivePolicyActivation();
      assert.equal(restored.policy.digest, initial.policy.digest);
      racedGeneration = restored.activationGeneration;
      return createVaultMigration(input);
    };

    await assert.rejects(
      fixture.module.propose({
        requestKey: "vault:create-race:policy-generation",
        newMaximumOutflowAtomic: "200000000",
      }),
      operationFailure("VAULT_MIGRATION_CONFLICT"),
    );
    assert.equal(racedGeneration, initial.activationGeneration + 2);
  } finally { fixture.close(); }
});

test("Vault Migration creation storage faults stay internal", async () => {
  const fixture = createFixture();
  try {
    fixture.journal.createVaultMigration = () => {
      throw new Error("injected Vault Migration storage fault");
    };
    await assert.rejects(
      fixture.module.propose({
        requestKey: "vault:create-storage-fault",
        newMaximumOutflowAtomic: "200000000",
      }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof SompiOperationFailure) &&
        error.message === "injected Vault Migration storage fault",
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

test("expired pre-execution plans terminalize before a changed vault snapshot is inspected", async () => {
  const fixture = createFixture();
  try {
    const proposed = await fixture.module.propose({
      requestKey: "vault:expired-and-stale",
      newMaximumOutflowAtomic: "200000000",
    });
    fixture.wallet.address = "kaspatest:qp5sl6ftjprrxl7d7vl5qp78rl3a08q06sg3w84wx2w5s39zenxsnfuc970g4";
    fixture.setNow(Date.parse(proposed.expiresAt));

    const expired = await fixture.module.execute(proposed.id, fixture.executor);
    assert.equal(expired.state, "expired");
    assert.deepEqual(fixture.vault.calls, []);

    fixture.wallet.address = ADDRESS;
    const replacement = await fixture.module.propose({
      requestKey: "vault:replacement-after-expiry",
      newMaximumOutflowAtomic: "200000000",
    });
    assert.equal(replacement.state, "awaiting_owner");
  } finally { fixture.close(); }
});

test("changed pre-execution vault snapshots fail terminally and release the migration slot", async () => {
  const fixture = createFixture();
  try {
    const proposed = await fixture.module.propose({
      requestKey: "vault:stale-before-owner",
      newMaximumOutflowAtomic: "200000000",
    });
    fixture.wallet.address = "kaspatest:qp5sl6ftjprrxl7d7vl5qp78rl3a08q06sg3w84wx2w5s39zenxsnfuc970g4";

    const failed = await fixture.module.execute(proposed.id, fixture.executor);
    assert.equal(failed.state, "failed");
    assert.equal(fixture.journal.vaultMigration(proposed.id).failureCode, "plan_stale_before_owner_execution");
    assert.deepEqual(fixture.vault.calls, []);

    fixture.wallet.address = ADDRESS;
    const replacement = await fixture.module.propose({
      requestKey: "vault:replacement-after-stale",
      newMaximumOutflowAtomic: "200000000",
    });
    assert.equal(replacement.state, "awaiting_owner");
  } finally { fixture.close(); }
});

test("expired Authority requests terminalize and cannot block a replacement proposal", async () => {
  let authorityCalls = 0;
  const fixture = createFixture(true, "100000000", async (facts) => {
    authorityCalls += 1;
    if (authorityCalls === 1) throw new Error("Authority transport timed out");
    return authorityDecision(facts, true);
  });
  try {
    await assert.rejects(
      () => fixture.module.propose({
        requestKey: "vault:authority-timeout",
        newMaximumOutflowAtomic: "200000000",
      }),
      /transport timed out/,
    );
    const timedOut = fixture.journal.findVaultMigrationByRequestKey("vault:authority-timeout");
    assert.equal(timedOut?.state, "awaiting_authority");
    fixture.setNow(timedOut!.expiresAtMs);

    const replacement = await fixture.module.propose({
      requestKey: "vault:replacement-after-authority-timeout",
      newMaximumOutflowAtomic: "200000000",
    });
    assert.equal(fixture.module.status(timedOut!.id).state, "expired");
    assert.equal(replacement.state, "awaiting_owner");
    assert.equal(authorityCalls, 2);
  } finally { fixture.close(); }
});

function createFixture(
  approve = true,
  everydayMaximumAtomic = "100000000",
  authorityRequest?: (facts: VaultMigrationFacts) => Promise<VaultMigrationDecision>,
) {
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
  const wallet = { address: ADDRESS };
  const module = new VaultMigrationModule({
    journal, vault: vault as unknown as VaultManager, wallet,
    authority: { request: authorityRequest ?? ((facts) => authorityDecision(facts, approve)) },
    everydayMaximumAtomic: () => activeEverydayMaximumAtomic,
    manifest: () => ({ revision: 1, digest: DIGEST }), now: () => now,
  });
  return {
    module,
    journal,
    vault,
    wallet,
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
    setEverydayMaximumProjection(value: string) {
      activeEverydayMaximumAtomic = value;
    },
    setNow(value: number) { now = value; },
    get executedFacts() { return executedFacts; },
    close() { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

function hideNextVaultMigrationRequestLookup(journal: PurchaseJournal): void {
  const findVaultMigrationByRequestKey = journal.findVaultMigrationByRequestKey.bind(journal);
  journal.findVaultMigrationByRequestKey = () => {
    journal.findVaultMigrationByRequestKey = findVaultMigrationByRequestKey;
    return undefined;
  };
}

async function authorityDecision(facts: VaultMigrationFacts, approve: boolean): Promise<VaultMigrationDecision> {
  const evidence = Buffer.from(`owner decision:${facts.vaultMigrationId}`);
  return {
    decision: approve ? "approved" : "denied",
    authorityId: "owner", evidence,
    evidenceDigest: `sha256:${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(evidence).digest("base64url"))}` as Sha256Digest,
    factsDigest: vaultMigrationFactsDigest(facts), decidedAtMs: 1_800_000_000_000,
  };
}

function operationFailure(code: SompiOperationFailure["code"]): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof SompiOperationFailure &&
    error.code === code;
}
