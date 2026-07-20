import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { exportJWK, generateKeyPair } from "jose";

import { LocalAp2TrustStore } from "../adapters/ap2/crypto.js";
import type { AnyAuthorityApprovalDisplay, AuthorityApprovalPrompt } from "../adapters/ap2/human-authority.js";
import type { Ap2SigningIdentity } from "../adapters/ap2/types.js";
import type { AuthorityAuthenticationProvider } from "../authority/key-provider.js";
import {
  OwnerAuthorityClient,
  OwnerAuthorityDecisionStore,
  OwnerAuthorityService,
} from "../authority/owner-authority.js";
import { AuthorityPromptAdmission } from "../authority/prompt-admission.js";
import type { TransferAuthorizationFacts } from "./types.js";
import type { PolicyChangeFacts } from "../policy-change/types.js";
import type { VaultMigrationFacts } from "../vault-migration/types.js";

test("Transfer Authority signs exact non-AP2 facts and replays one durable decision", async (t) => {
  const signer = await signingIdentity();
  const authentication = new MemoryAuthentication();
  const decisions = new OwnerAuthorityDecisionStore(":memory:");
  t.after(() => decisions.close());
  const prompt = new CapturingPrompt(true);
  const service = new OwnerAuthorityService({ authenticationProvider: authentication, signer, prompt, decisions });
  const trust = new LocalAp2TrustStore([{
    role: "authority",
    issuer: signer.issuer,
    kid: signer.kid,
    publicJwk: {
      kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y,
    },
  }]);
  const client = new OwnerAuthorityClient({
    authenticationProvider: authentication,
    transport: { request: (wire) => service.handleDecision(wire) },
    trust,
    expectedAuthorityIssuer: signer.issuer,
  });
  const facts = transferFacts();
  const first = await client.request(facts);
  const retry = await client.request(facts);
  assert.equal(first.decision, "approved");
  assert.equal(first.evidenceDigest, retry.evidenceDigest);
  assert.equal(first.factsDigest, digestJson(facts));
  assert.equal(prompt.calls, 1);
  assert.equal(prompt.display?.kind, "transfer");
  if (prompt.display?.kind === "transfer") {
    assert.equal(prompt.display.destination, facts.destination);
    assert.equal(prompt.display.maximumTotalAtomic, facts.maximumTotalAtomic);
  }
});

test("Transfer Authority denial stays exact and evidence substitution fails", async (t) => {
  const signer = await signingIdentity();
  const authentication = new MemoryAuthentication();
  const decisions = new OwnerAuthorityDecisionStore(":memory:");
  t.after(() => decisions.close());
  const service = new OwnerAuthorityService({
    authenticationProvider: authentication,
    signer,
    prompt: new CapturingPrompt(false),
    decisions,
  });
  const trust = new LocalAp2TrustStore([{
    role: "authority", issuer: signer.issuer, kid: signer.kid,
    publicJwk: { kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y },
  }]);
  const client = new OwnerAuthorityClient({
    authenticationProvider: authentication,
    transport: {
      async request(wire) {
        const result = await service.handleDecision(wire);
        return { ...result, decisionEvidence: Uint8Array.from([...result.decisionEvidence, 0]) };
      },
    },
    trust,
    expectedAuthorityIssuer: signer.issuer,
  });
  await assert.rejects(client.request(transferFacts()), /evidence|bound/);
});

test("Owner Authority signs and displays exact Policy Change facts", async (t) => {
  const signer = await signingIdentity();
  const authentication = new MemoryAuthentication();
  const decisions = new OwnerAuthorityDecisionStore(":memory:");
  t.after(() => decisions.close());
  const prompt = new CapturingPrompt(true);
  const service = new OwnerAuthorityService({ authenticationProvider: authentication, signer, prompt, decisions });
  const trust = new LocalAp2TrustStore([{
    role: "authority", issuer: signer.issuer, kid: signer.kid,
    publicJwk: { kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y },
  }]);
  const client = new OwnerAuthorityClient({
    authenticationProvider: authentication,
    transport: { request: (wire) => service.handleDecision(wire) },
    trust,
    expectedAuthorityIssuer: signer.issuer,
  });
  const facts = policyChangeFacts();
  const decision = await client.request(facts);
  assert.equal(decision.decision, "approved");
  assert.equal(decision.factsDigest, digestJson(facts));
  assert.equal(prompt.display?.kind, "policy-change");
  if (prompt.display?.kind === "policy-change") {
    assert.equal(prompt.display.proposedMaximumPerPaymentAtomic, "200000000");
    assert.equal(prompt.display.everyPaymentRequiresApproval, true);
  }
});

test("Owner Authority preserves a configured approval lifetime longer than the default", async (t) => {
  const nowMs = 1_800_000_000_000;
  const signer = await signingIdentity();
  const authentication = new MemoryAuthentication();
  const decisions = new OwnerAuthorityDecisionStore(":memory:");
  t.after(() => decisions.close());
  const prompt = new CapturingPrompt(true);
  const service = new OwnerAuthorityService({
    authenticationProvider: authentication,
    signer,
    prompt,
    decisions,
    now: () => nowMs,
  });
  const trust = new LocalAp2TrustStore([{
    role: "authority", issuer: signer.issuer, kid: signer.kid,
    publicJwk: { kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y },
  }]);
  const client = new OwnerAuthorityClient({
    authenticationProvider: authentication,
    transport: { request: (wire) => service.handleDecision(wire) },
    trust,
    expectedAuthorityIssuer: signer.issuer,
    now: () => nowMs,
  });
  const decision = await client.request(policyChangeFacts(nowMs, 600_000));
  assert.equal(decision.decision, "approved");
  assert.equal(prompt.calls, 1);
});

test("Owner Authority signs the exact vault protection change and keeps the receive address stable", async (t) => {
  const signer = await signingIdentity();
  const authentication = new MemoryAuthentication();
  const decisions = new OwnerAuthorityDecisionStore(":memory:");
  t.after(() => decisions.close());
  const prompt = new CapturingPrompt(true);
  const service = new OwnerAuthorityService({ authenticationProvider: authentication, signer, prompt, decisions });
  const trust = new LocalAp2TrustStore([{
    role: "authority", issuer: signer.issuer, kid: signer.kid,
    publicJwk: { kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y },
  }]);
  const client = new OwnerAuthorityClient({
    authenticationProvider: authentication,
    transport: { request: (wire) => service.handleDecision(wire) },
    trust,
    expectedAuthorityIssuer: signer.issuer,
  });
  const facts = vaultMigrationFacts();
  const decision = await client.request(facts);
  assert.equal(decision.decision, "approved");
  assert.equal(decision.factsDigest, digestJson(facts));
  assert.equal(prompt.display?.kind, "vault-migration");
  if (prompt.display?.kind === "vault-migration") {
    assert.equal(prompt.display.newMaximumOutflowAtomic, "1000000000");
    assert.equal(prompt.display.stableReceiveAddressWillNotChange, true);
    assert.equal(prompt.display.requiresOfflineOwnerKey, true);
  }
});

test("one shared Authority prompt budget covers Transfer and Policy Change prompts", async (t) => {
  const signer = await signingIdentity();
  const authentication = new MemoryAuthentication();
  const admission = new AuthorityPromptAdmission(1);
  const transferDecisions = new OwnerAuthorityDecisionStore(":memory:");
  const policyDecisions = new OwnerAuthorityDecisionStore(":memory:");
  t.after(() => { transferDecisions.close(); policyDecisions.close(); });
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const transferPrompt: AuthorityApprovalPrompt = {
    async approve() { firstStarted(); await gate; return true; },
  };
  const policyPrompt = new CapturingPrompt(true);
  const transferService = new OwnerAuthorityService({
    authenticationProvider: authentication, signer, prompt: transferPrompt,
    decisions: transferDecisions, promptAdmission: admission,
  });
  const policyService = new OwnerAuthorityService({
    authenticationProvider: authentication, signer, prompt: policyPrompt,
    decisions: policyDecisions, promptAdmission: admission,
  });
  const trust = new LocalAp2TrustStore([{
    role: "authority", issuer: signer.issuer, kid: signer.kid,
    publicJwk: { kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y },
  }]);
  const transferClient = new OwnerAuthorityClient({
    authenticationProvider: authentication,
    transport: { request: (wire) => transferService.handleDecision(wire) },
    trust, expectedAuthorityIssuer: signer.issuer,
  });
  const policyClient = new OwnerAuthorityClient({
    authenticationProvider: authentication,
    transport: { request: (wire) => policyService.handleDecision(wire) },
    trust, expectedAuthorityIssuer: signer.issuer,
  });

  const first = transferClient.request(transferFacts());
  await started;
  await assert.rejects(policyClient.request(policyChangeFacts()), /prompt capacity is exhausted/);
  assert.equal(policyPrompt.calls, 0);
  assert.deepEqual(admission.status(), { activePrompts: 1, budget: 1, saturated: true });
  releaseFirst();
  assert.equal((await first).decision, "approved");
  assert.deepEqual(admission.status(), { activePrompts: 0, budget: 1, saturated: false });
});

test("Owner Authority decision store rejects schema tampering and symlink paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-transfer-authority-store-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "decisions.sqlite");
  new OwnerAuthorityDecisionStore(filename).close();
  const database = new Database(filename);
  database.exec("ALTER TABLE owner_authority_decisions ADD COLUMN injected TEXT");
  database.close();
  assert.throws(() => new OwnerAuthorityDecisionStore(filename), /startup checks/);

  const target = path.join(directory, "target.sqlite");
  fs.writeFileSync(target, "not sqlite", { mode: 0o600 });
  const linked = path.join(directory, "linked.sqlite");
  fs.symlinkSync(target, linked);
  assert.throws(() => new OwnerAuthorityDecisionStore(linked), /unsafe/);
});

class MemoryAuthentication implements AuthorityAuthenticationProvider {
  readonly key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  withAuthentication<T>(operation: (input: { keyId: string; keyBytes: Uint8Array }) => T | Promise<T>): Promise<T> {
    return Promise.resolve(operation({ keyId: "transfer-test-key", keyBytes: Uint8Array.from(this.key) }));
  }
}

class CapturingPrompt implements AuthorityApprovalPrompt {
  calls = 0;
  display?: AnyAuthorityApprovalDisplay;
  constructor(private readonly approved: boolean) {}
  async approve(display: AnyAuthorityApprovalDisplay): Promise<boolean> {
    this.calls += 1;
    this.display = display;
    return this.approved;
  }
}

async function signingIdentity(): Promise<Ap2SigningIdentity> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error("test key generation failed");
  return Object.freeze({
    role: "authority",
    issuer: "urn:sompi:authority:test",
    kid: "transfer-test-signing-key",
    privateJwk: Object.freeze({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }),
  });
}

function transferFacts(nowMs = Date.now()): TransferAuthorizationFacts {
  return Object.freeze({
    profile: "sompi.transfer.1",
    transferId: "trf_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "telegram:transfer:test",
    sourceVaultAddress: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    sourceVaultDigest: digest("vault"),
    destination: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    amountAtomic: "20000000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    feeCeilingAtomic: "200000",
    maximumTotalAtomic: "20200000",
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 120_000).toISOString(),
    policyDigest: digest("policy"),
    operatorManifestRevision: 1,
    operatorManifestDigest: digest("manifest"),
    finalityFloor: "depth-confirmed",
  });
}

function policyChangeFacts(nowMs = Date.now(), lifetimeMs = 120_000): PolicyChangeFacts {
  return Object.freeze({
    profile: "sompi.policy-change.1",
    policyChangeId: "pcg_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "telegram:policy-change:test",
    expectedPolicyDigest: digest("old-policy") as PolicyChangeFacts["expectedPolicyDigest"],
    expectedPolicyVersion: 1,
    expectedPolicyGeneration: 1,
    expectedVaultDigest: digest("vault") as PolicyChangeFacts["expectedVaultDigest"],
    previousMaximumPerPaymentAtomic: "100000000",
    previousMaximumPerHourAtomic: "500000000",
    proposedMaximumPerPaymentAtomic: "200000000",
    proposedMaximumPerHourAtomic: "400000000",
    vaultMaximumOutflowAtomic: "500000000",
    everyPaymentRequiresApproval: true,
    operatorManifestRevision: 1,
    operatorManifestDigest: digest("manifest") as PolicyChangeFacts["operatorManifestDigest"],
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + lifetimeMs).toISOString(),
  });
}

function vaultMigrationFacts(nowMs = Date.now()): VaultMigrationFacts {
  return Object.freeze({
    profile: "sompi.vault-migration.1",
    vaultMigrationId: "vmg_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "telegram:vault-migration:test",
    oldVaultDigest: digest("old-vault") as VaultMigrationFacts["oldVaultDigest"],
    expectedPolicyDigest: digest("policy") as VaultMigrationFacts["expectedPolicyDigest"],
    expectedPolicyGeneration: 1,
    oldMaximumOutflowAtomic: "500000000",
    newMaximumOutflowAtomic: "1000000000",
    windowSizeDaa: "36000",
    windowStartDaa: "123000",
    spentInWindowAtomic: "100000000",
    stableReceiveAddress: "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    stableReceiveAddressWillNotChange: true,
    requiresOfflineOwnerKey: true,
    operatorManifestRevision: 1,
    operatorManifestDigest: digest("manifest") as VaultMigrationFacts["operatorManifestDigest"],
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 120_000).toISOString(),
  });
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("base64url")}`; }
function digestJson(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`; }
