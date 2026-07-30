import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import type {
  ChainEvidenceFinalitySelector,
  FinalityFloor,
} from "../chain-evidence/types.js";
import { SompiOperationFailure } from "../operation-failure.js";
import { PurchaseJournal } from "../purchase/journal.js";
import {
  PolicyReservationError,
  type TreasuryOperationView,
} from "../treasury/operation-journal.js";
import {
  TreasuryOperationError,
  TreasuryOperationNotFoundError,
} from "../treasury/operations.js";
import type { TransferJournal } from "./journal.js";
import { TransferModule } from "./module.js";
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
    operationFailure("INVALID_TRANSFER"),
  );
  assert.throws(
    () => fixture.module.status("trf_AAAAAAAAAAAAAAAAAAAAAA"),
    operationFailure("TRANSFER_NOT_FOUND"),
  );
});

test("approved Transfer evidence authorizes only its exact direct vault movement", async (t) => {
  const fixture = setup(t, "approved", false);
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
    operationFailure("TRANSFER_DENIED"),
  );
  const record = fixture.journal.findTransferByRequestKey("telegram:send:deny");
  assert.equal(record?.state, "denied");
  assert.equal(fixture.treasury.calls, 0);
});

test("expired Transfer approval is one stable terminal failure", async (t) => {
  const fixture = setup(t);
  const timestamps = [1_000, 1_001];
  const module = new TransferModule({
    journal: fixture.journal,
    authority: fixture.authority,
    treasury: fixture.treasury,
    source: () => ({ vaultAddress: ADDRESS, vaultDigest: digest("vault") }),
    manifest: () => MANIFEST,
    finality: finalitySelector("depth-confirmed"),
    authorityTtlMs: 1,
    now: () => timestamps.shift() ?? 1_001,
  });
  await assert.rejects(
    module.transfer({
      requestKey: "telegram:send:expired",
      destination: ADDRESS,
      amountAtomic: "1",
    }),
    operationFailure("TRANSFER_EXPIRED"),
  );
  assert.equal(fixture.authority.calls, 0);
  assert.equal(fixture.treasury.calls, 0);
});

test("invalid recipients and Treasury preflight rejection never reach Authority", async (t) => {
  const fixture = setup(t);
  await assert.rejects(
    fixture.module.transfer({
      requestKey: "telegram:send:mainnet",
      destination: ADDRESS.replace("kaspatest:", "kaspa:"),
      amountAtomic: "5000",
    }),
    operationFailure("INVALID_TRANSFER"),
  );
  assert.equal(fixture.authority.calls, 0);

  fixture.treasury.preflightError = new TreasuryOperationError(
    "recipient amount exceeds the per-transfer limit",
  );
  await assert.rejects(
    fixture.module.transfer({
      requestKey: "telegram:send:policy-preflight",
      destination: ADDRESS,
      amountAtomic: "5000",
    }),
    operationFailure("INVALID_TRANSFER"),
  );
  assert.equal(fixture.journal.findTransferByRequestKey("telegram:send:policy-preflight"), undefined);
  assert.equal(fixture.treasury.preflightCalls, 1);
  assert.equal(fixture.treasury.calls, 0);
  assert.equal(fixture.authority.calls, 0);

  fixture.treasury.preflightError = new PolicyReservationError(
    "Treasury capacity is unavailable",
  );
  await assert.rejects(
    fixture.module.transfer({
      requestKey: "telegram:send:capacity-preflight",
      destination: ADDRESS,
      amountAtomic: "5000",
    }),
    operationFailure("INVALID_TRANSFER"),
  );

  fixture.treasury.preflightError = new Error("injected Treasury storage fault");
  await assert.rejects(
    fixture.module.transfer({
      requestKey: "telegram:send:faulted-preflight",
      destination: ADDRESS,
      amountAtomic: "5000",
    }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof SompiOperationFailure) &&
      error.message === "injected Treasury storage fault",
  );
});

test("a post-approval Treasury race fails terminally without a retry capability", async (t) => {
  const fixture = setup(t);

  const rejectingTreasury = new FakeTreasury(fixture.policyDigest, false);
  rejectingTreasury.rejectBeforeIntent = true;
  const module = new TransferModule({
    journal: fixture.journal,
    authority: fixture.authority,
    treasury: rejectingTreasury,
    source: () => ({ vaultAddress: ADDRESS, vaultDigest: digest("vault") }),
    manifest: () => MANIFEST,
    finality: finalitySelector("depth-confirmed"),
  });
  const result = await module.transfer({
    requestKey: "telegram:send:policy-rejected",
    destination: ADDRESS,
    amountAtomic: "5000",
  });
  assert.equal(result.state, "failed_terminal");
  assert.equal(result.safeToRetry, false);
  assert.equal(result.recoveryRequired, false);
  const record = fixture.journal.findTransferByRequestKey("telegram:send:policy-rejected");
  assert.equal(record?.state, "failed_terminal");
  assert.equal(rejectingTreasury.preflightCalls, 1);
  assert.equal(rejectingTreasury.calls, 1);
  assert.equal(fixture.authority.calls, 1);

  const recovered = await module.recover(result.id);
  assert.equal(recovered.id, result.id);
  assert.equal(recovered.state, "failed_terminal");
  assert.equal(recovered.safeToRetry, false);
  assert.equal(recovered.recoveryRequired, false);
  assert.equal(rejectingTreasury.calls, 1);
});

test("Transfer keeps Treasury status and recovery faults internal", async (t) => {
  const execution = setup(t);
  execution.treasury.executeError = new Error("injected Treasury execution fault");
  execution.treasury.statusError = new Error("injected Treasury status fault");
  await assert.rejects(
    execution.module.transfer({
      requestKey: "telegram:send:execution-status-fault",
      destination: ADDRESS,
      amountAtomic: "5000",
    }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof SompiOperationFailure) &&
      error.message === "injected Treasury status fault",
  );

  const recovery = setup(t, "approved", true);
  await assert.rejects(
    recovery.module.transfer({
      requestKey: "telegram:send:recovery-status-fault",
      destination: ADDRESS,
      amountAtomic: "5000",
    }),
    operationFailure("TRANSFER_FAILED"),
  );
  const transfer = recovery.journal.findTransferByRequestKey(
    "telegram:send:recovery-status-fault",
  )!;
  recovery.treasury.recoverError = new Error("injected Treasury recovery fault");
  recovery.treasury.statusError = new Error("injected Treasury recovery status fault");
  await assert.rejects(
    recovery.module.recover(transfer.id),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof SompiOperationFailure) &&
      error.message === "injected Treasury recovery status fault",
  );
});

test("request keys, Authority facts, policy snapshots, and restart recovery stay exact", async (t) => {
  const fixture = setup(t, "approved", true);
  await assert.rejects(
    fixture.module.transfer({ requestKey: "telegram:send:recover", destination: ADDRESS, amountAtomic: "5000" }),
    operationFailure("TRANSFER_FAILED"),
  );
  const before = fixture.journal.findTransferByRequestKey("telegram:send:recover")!;
  assert.equal(before.state, "failed_recoverable");
  assert.equal(before.policyDigest, fixture.policyDigest);
  const beforeRestartJournal: TransferJournal = fixture.journal;
  const authorizationEvidence =
    beforeRestartJournal.readTransferAuthorizationEvidence(before.id);
  await assert.rejects(
    fixture.module.transfer({ requestKey: "telegram:send:recover", destination: ADDRESS, amountAtomic: "5001" }),
    operationFailure("TRANSFER_CONFLICT"),
  );

  fixture.journal.close();
  const restarted = new PurchaseJournal(fixture.filename, {
    operatorManifestIdentity: MANIFEST,
    admission: ADMISSION,
  });
  t.after(() => restarted.close());
  const afterRestartJournal: TransferJournal = restarted;
  assert.deepEqual(
    afterRestartJournal.readTransferAuthorizationEvidence(before.id),
    authorizationEvidence,
  );
  const recoveredTreasury = new FakeTreasury(fixture.policyDigest, false);
  const recovered = new TransferModule({
    journal: restarted,
    authority: fixture.authority,
    treasury: recoveredTreasury,
    source: () => ({ vaultAddress: ADDRESS, vaultDigest: digest("vault") }),
    manifest: () => MANIFEST,
    finality: finalitySelector("depth-confirmed"),
  });
  const view = await recovered.recover(before.id);
  assert.equal(view.state, "receipted");
  assert.equal(fixture.authority.calls, 1, "recovery must not request replacement authority");
});

test("Transfer absence is stable but Journal faults are not rewritten as not-found", (t) => {
  const fixture = setup(t);
  assert.throws(
    () => fixture.module.status("trf_AAAAAAAAAAAAAAAAAAAAAA"),
    operationFailure("TRANSFER_NOT_FOUND"),
  );

  fixture.journal.findTransfer = () => {
    throw new Error("injected Journal storage fault");
  };
  assert.throws(
    () => fixture.module.status("trf_AAAAAAAAAAAAAAAAAAAAAA"),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof SompiOperationFailure) &&
      error.message === "injected Journal storage fault",
  );
});

test("transactional Transfer request-key races return the same-intent winner and reject changed intent", async (t) => {
  const fixture = setup(t);
  const intent = Object.freeze({
    requestKey: "telegram:send:claim-race",
    destination: ADDRESS,
    amountAtomic: "1",
  });
  const winner = await fixture.module.transfer(intent);
  const realFind = fixture.journal.findTransferByRequestKey.bind(fixture.journal);
  const realClaim = fixture.journal.claimTransferIntent.bind(fixture.journal);
  const attemptedClaims: Array<
    Parameters<PurchaseJournal["claimTransferIntent"]>[0]
  > = [];
  let hideNextPrelookup = false;
  let stalePrelookups = 0;
  let transactionalLookups = 0;

  fixture.journal.findTransferByRequestKey = (requestKey) => {
    if (hideNextPrelookup) {
      hideNextPrelookup = false;
      stalePrelookups += 1;
      return undefined;
    }
    transactionalLookups += 1;
    return realFind(requestKey);
  };
  fixture.journal.claimTransferIntent = (input) => {
    attemptedClaims.push(input);
    return realClaim(input);
  };

  const contender = new TransferModule({
    journal: fixture.journal,
    authority: fixture.authority,
    treasury: fixture.treasury,
    source: () => ({ vaultAddress: ADDRESS, vaultDigest: digest("vault") }),
    manifest: () => MANIFEST,
    finality: finalitySelector("depth-confirmed"),
    now: () => winner.expiresAtMs + 1,
  });

  hideNextPrelookup = true;
  const sameIntentResult = await contender.transfer(intent);
  assert.equal(sameIntentResult.id, winner.id);
  assert.equal(attemptedClaims.length, 1);
  assert.notEqual(attemptedClaims[0]?.id, winner.id);
  assert.notEqual(attemptedClaims[0]?.expiresAtMs, winner.expiresAtMs);
  assert.equal(attemptedClaims[0]?.requestDigest, winner.requestDigest);
  assert.equal(attemptedClaims[0]?.destination, winner.destination);
  assert.equal(attemptedClaims[0]?.amountAtomic, winner.amountAtomic);

  hideNextPrelookup = true;
  await assert.rejects(
    contender.transfer({ ...intent, amountAtomic: "2" }),
    operationFailure("TRANSFER_CONFLICT"),
  );
  assert.equal(attemptedClaims.length, 2);
  assert.notEqual(attemptedClaims[1]?.requestDigest, winner.requestDigest);
  assert.equal(stalePrelookups, 2);
  assert.equal(transactionalLookups, 2);
  assert.equal(fixture.authority.calls, 1);
  assert.equal(fixture.treasury.calls, 1);
});

test("Transfer claim faults stay internal", async (t) => {
  const fixture = setup(t);
  fixture.journal.claimTransferIntent = () => {
    throw new Error("injected Transfer claim fault");
  };
  await assert.rejects(
    fixture.module.transfer({
      requestKey: "telegram:send:claim-fault",
      destination: ADDRESS,
      amountAtomic: "1",
    }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof SompiOperationFailure) &&
      error.message === "injected Transfer claim fault",
  );
});

function setup(
  t: TestContext,
  decision: "approved" | "denied" = "approved",
  failFirst = false,
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
    finality: finalitySelector("depth-confirmed"),
  });
  return { directory, filename, journal, policyDigest, authority, treasury, module };
}

function operationFailure(code: SompiOperationFailure["code"]): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof SompiOperationFailure &&
    error.code === code;
}

function finalitySelector(operatorFloor: FinalityFloor): ChainEvidenceFinalitySelector {
  const selector: ChainEvidenceFinalitySelector = {
    selectFinality(operation, protocolFinality) {
      return Object.freeze({
        operation,
        protocolFinality,
        operatorFloor,
        effectiveFloor:
          protocolFinality === "confirmed" || operatorFloor === "depth-confirmed"
            ? "depth-confirmed"
            : "accepted",
        depthConfirmationDaa: "10",
      });
    },
  };
  return Object.freeze(selector);
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
  preflightCalls = 0;
  preflightError?: Error;
  executeError?: Error;
  recoverError?: Error;
  statusError?: Error;
  rejectBeforeIntent = false;
  lastAuthorization?: Readonly<{
    expectedPolicyDigest?: string;
    authorizationEvidenceDigest?: string;
  }>;
  private failed = false;
  constructor(readonly policyDigest: string, private readonly failFirst: boolean) {}
  preflightHumanAuthorized() {
    this.preflightCalls += 1;
    if (this.preflightError) throw this.preflightError;
    return { policyDigest: this.policyDigest, feeCeilingAtomic: "200000" };
  }
  async executeUnderPolicy(
    request: { operationKey: string; destination: string; amountAtomic: string },
    authorization: Readonly<{
      expectedPolicyDigest?: string;
      authorizationEvidenceDigest?: string;
    }>,
  ) {
    this.calls += 1;
    this.lastAuthorization = authorization;
    if (this.executeError) throw this.executeError;
    if (this.rejectBeforeIntent) throw new Error("policy rejected before intent");
    if (this.failFirst && !this.failed) {
      this.failed = true;
      throw new Error("ambiguous RPC");
    }
    return operation(request, "completed");
  }
  status(operationKey: string) {
    if (this.statusError) throw this.statusError;
    if (this.rejectBeforeIntent) throw new TreasuryOperationNotFoundError();
    return operation({ operationKey, destination: ADDRESS, amountAtomic: "5000" }, this.failed ? "submitted" : "completed");
  }
  async recover(operationKey: string) {
    this.calls += 1;
    if (this.recoverError) throw this.recoverError;
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
