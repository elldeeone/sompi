import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { PurchaseJournal } from "../purchase/journal.js";
import type { TreasuryOperationView } from "../treasury/operations.js";
import { TransferModule, TransferModuleError } from "./module.js";
import type { TransferAuthorizationFacts, TransferAuthorityModule } from "./types.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const MANIFEST = Object.freeze({ revision: 1, digest: digest("manifest") });
const ADMISSION = Object.freeze({
  authorityPreauthSockets: 32,
  authorityPrompts: 4,
  prevalidationPurchases: 128,
  evidenceBytes: 67_108_864,
  directTreasuryRetries: 3,
});

test("Transfer records approval before one exact vault Treasury movement and receipts it", async (t) => {
  const fixture = setup(t);
  const first = await fixture.module.transfer({
    requestKey: "telegram:send:1",
    destination: ADDRESS,
    amountAtomic: "20000000",
  });
  assert.equal(first.state, "receipted");
  assert.equal(first.authorization?.decision, "approved");
  assert.equal(first.receipt?.amountAtomic, "20000000");
  assert.equal(first.receipt?.feeAtomic, "1200");
  assert.equal(first.receipt?.transactionId, "ab".repeat(32));
  assert.equal(fixture.authority.calls, 1);
  assert.equal(fixture.treasury.calls, 1);
  assert.equal(
    fixture.treasury.lastAuthorization?.authorizationEvidenceDigest,
    first.authorization?.evidenceDigest,
  );

  const retry = await fixture.module.transfer({
    requestKey: "telegram:send:1",
    destination: ADDRESS,
    amountAtomic: "20000000",
  });
  assert.equal(retry.id, first.id);
  assert.equal(fixture.authority.calls, 1);
  assert.equal(fixture.treasury.calls, 1);
  assert.throws(
    () => fixture.module.status("trf_invalid"),
    (error: unknown) => error instanceof TransferModuleError && error.code === "TRANSFER_NOT_FOUND",
  );
});

test("approved Transfer evidence satisfies only the approval threshold", async (t) => {
  const fixture = setup(t, "approved", false, "1");
  const transfer = await fixture.module.transfer({
    requestKey: "telegram:send:threshold",
    destination: ADDRESS,
    amountAtomic: "5000",
  });
  const operationKey = `transfer:${transfer.id}`;
  const accepted = fixture.journal.claimTreasuryOperationIntent({
    operationKey,
    requestDigest: digest("approved-transfer-operation"),
    kind: "vault_send",
    destination: ADDRESS,
    requestedAmountAtomic: "5000",
    feeCeilingAtomic: "200000",
    retryLimit: 3,
    policyDigest: fixture.policyDigest,
    authorizationEvidenceDigest: transfer.authorization!.evidenceDigest,
  });
  assert.equal(accepted.authorizationEvidenceDigest, transfer.authorization?.evidenceDigest);
  assert.throws(
    () => fixture.journal.claimTreasuryOperationIntent({
      operationKey: "transfer:unbound",
      requestDigest: digest("forged-transfer-operation"),
      kind: "vault_send",
      destination: ADDRESS,
      requestedAmountAtomic: "5000",
      feeCeilingAtomic: "200000",
      retryLimit: 3,
      policyDigest: fixture.policyDigest,
      authorizationEvidenceDigest: digest("forged-approval"),
    }),
    /no matching approved Transfer authorization/,
  );
});

test("denial is durable and cannot reach Treasury", async (t) => {
  const fixture = setup(t, "denied");
  await assert.rejects(
    fixture.module.transfer({ requestKey: "telegram:send:deny", destination: ADDRESS, amountAtomic: "1" }),
    (error: unknown) => error instanceof TransferModuleError && error.code === "TRANSFER_DENIED",
  );
  const record = fixture.journal.findTransferByRequestKey("telegram:send:deny");
  assert.equal(record?.state, "denied");
  assert.equal(fixture.treasury.calls, 0);
});

test("invalid recipients and pre-effect Treasury rejection fail without a retry capability", async (t) => {
  const fixture = setup(t);
  await assert.rejects(
    fixture.module.transfer({
      requestKey: "telegram:send:mainnet",
      destination: ADDRESS.replace("kaspatest:", "kaspa:"),
      amountAtomic: "5000",
    }),
    (error: unknown) => error instanceof TransferModuleError && error.code === "INVALID_TRANSFER",
  );
  assert.equal(fixture.authority.calls, 0);

  const rejectingTreasury = new FakeTreasury(fixture.policyDigest, false);
  rejectingTreasury.rejectBeforeIntent = true;
  const module = new TransferModule({
    journal: fixture.journal,
    authority: fixture.authority,
    treasury: rejectingTreasury,
    source: () => ({ vaultAddress: ADDRESS, vaultDigest: digest("vault") }),
    manifest: () => MANIFEST,
    finalityFloor: "depth-confirmed",
  });
  await assert.rejects(
    module.transfer({
      requestKey: "telegram:send:policy-rejected",
      destination: ADDRESS,
      amountAtomic: "5000",
    }),
    /rejected before Treasury execution/,
  );
  const record = fixture.journal.findTransferByRequestKey("telegram:send:policy-rejected");
  assert.equal(record?.state, "failed_terminal");
  assert.equal(rejectingTreasury.calls, 1);
  assert.equal(fixture.authority.calls, 1);
});

test("request keys, Authority facts, policy snapshots, and restart recovery stay exact", async (t) => {
  const fixture = setup(t, "approved", true);
  await assert.rejects(
    fixture.module.transfer({ requestKey: "telegram:send:recover", destination: ADDRESS, amountAtomic: "5000" }),
    /requires recovery/,
  );
  const before = fixture.journal.findTransferByRequestKey("telegram:send:recover")!;
  assert.equal(before.state, "failed_recoverable");
  assert.equal(before.policyDigest, fixture.policyDigest);
  await assert.rejects(
    fixture.module.transfer({ requestKey: "telegram:send:recover", destination: ADDRESS, amountAtomic: "5001" }),
    (error: unknown) => error instanceof TransferModuleError && error.code === "TRANSFER_CONFLICT",
  );

  fixture.journal.close();
  const restarted = new PurchaseJournal(fixture.filename, {
    operatorManifestIdentity: MANIFEST,
    admission: ADMISSION,
  });
  t.after(() => restarted.close());
  const recoveredTreasury = new FakeTreasury(fixture.policyDigest, false);
  const recovered = new TransferModule({
    journal: restarted,
    authority: fixture.authority,
    treasury: recoveredTreasury,
    source: () => ({ vaultAddress: ADDRESS, vaultDigest: digest("vault") }),
    manifest: () => MANIFEST,
    finalityFloor: "depth-confirmed",
  });
  const view = await recovered.recover(before.id);
  assert.equal(view.state, "receipted");
  assert.equal(fixture.authority.calls, 1, "recovery must not request replacement authority");
});

function setup(
  t: TestContext,
  decision: "approved" | "denied" = "approved",
  failFirst = false,
  approvalAboveAtomic = "0",
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-transfer-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "journal.sqlite");
  const journal = new PurchaseJournal(filename, {
    operatorManifestIdentity: MANIFEST,
    admission: ADMISSION,
  });
  t.after(() => { if ((journal as unknown as { db?: { open: boolean } }).db?.open !== false) journal.close(); });
  const policyDigest = journal.installPolicy({
    maxPerPaymentAtomic: "1000000000",
    maxPerHourAtomic: "5000000000",
    approvalAboveAtomic,
    allowlist: [],
  }).digest;
  const authority = new FakeAuthority(decision);
  const treasury = new FakeTreasury(policyDigest, failFirst);
  const module = new TransferModule({
    journal,
    authority,
    treasury,
    source: () => ({ vaultAddress: ADDRESS, vaultDigest: digest("vault") }),
    manifest: () => MANIFEST,
    finalityFloor: "depth-confirmed",
  });
  return { directory, filename, journal, policyDigest, authority, treasury, module };
}

class FakeAuthority implements TransferAuthorityModule {
  calls = 0;
  constructor(private readonly result: "approved" | "denied") {}
  async request(facts: TransferAuthorizationFacts) {
    this.calls += 1;
    const factsDigest = digestJson(facts);
    const evidence = Buffer.from(JSON.stringify({ factsDigest, decision: this.result }), "utf8");
    return Object.freeze({
      decision: this.result,
      authorityId: "did:web:authority.example",
      ...(this.result === "denied" ? { denialCode: "user_denied" as const } : {}),
      evidence: Uint8Array.from(evidence),
      evidenceDigest: digestBytes(evidence),
      factsDigest,
      verificationProfile: "urn:sompi:transfer-test:1",
      verifierId: "test-authority-verifier",
      decidedAtMs: Date.now(),
    });
  }
}

class FakeTreasury {
  calls = 0;
  rejectBeforeIntent = false;
  lastAuthorization?: Readonly<{
    expectedPolicyDigest?: string;
    authorizationEvidenceDigest?: string;
  }>;
  private failed = false;
  constructor(readonly policyDigest: string, private readonly failFirst: boolean) {}
  authorizationContext() { return { policyDigest: this.policyDigest, feeCeilingAtomic: "200000" }; }
  async executeUnderPolicy(
    request: { operationKey: string; destination: string; amountAtomic: string },
    authorization: Readonly<{
      expectedPolicyDigest?: string;
      authorizationEvidenceDigest?: string;
    }>,
  ) {
    this.calls += 1;
    this.lastAuthorization = authorization;
    if (this.rejectBeforeIntent) throw new Error("policy rejected before intent");
    if (this.failFirst && !this.failed) {
      this.failed = true;
      throw new Error("ambiguous RPC");
    }
    return operation(request, "completed");
  }
  status(operationKey: string) {
    if (this.rejectBeforeIntent) throw new Error("Treasury operation does not exist");
    return operation({ operationKey, destination: ADDRESS, amountAtomic: "5000" }, this.failed ? "submitted" : "completed");
  }
  async recover(operationKey: string) {
    this.calls += 1;
    return operation({ operationKey, destination: ADDRESS, amountAtomic: "5000" }, "completed");
  }
}

function operation(
  request: { operationKey: string; destination: string; amountAtomic: string },
  state: TreasuryOperationView["state"],
): TreasuryOperationView {
  return Object.freeze({
    operationKey: request.operationKey,
    kind: "vault_send",
    state,
    summary: "test",
    destination: request.destination,
    requestedAmountAtomic: request.amountAtomic,
    feeCeilingAtomic: "200000",
    amountAtomic: request.amountAtomic,
    feeAtomic: "1200",
    transactionId: "ab".repeat(32),
    retryCount: 0,
    recoveryRequired: state === "submitted",
    safeToRetry: false,
    cancellationRequested: false,
    preparationFenced: false,
  });
}

function digest(value: string): string { return digestBytes(Buffer.from(value)); }
function digestJson(value: unknown): string { return digestBytes(Buffer.from(JSON.stringify(value))); }
function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}
