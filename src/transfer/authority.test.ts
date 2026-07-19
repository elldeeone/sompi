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
  TransferAuthorityClient,
  TransferAuthorityDecisionStore,
  TransferAuthorityService,
} from "./authority.js";
import type { TransferAuthorizationFacts } from "./types.js";

test("Transfer Authority signs exact non-AP2 facts and replays one durable decision", async (t) => {
  const signer = await signingIdentity();
  const authentication = new MemoryAuthentication();
  const decisions = new TransferAuthorityDecisionStore(":memory:");
  t.after(() => decisions.close());
  const prompt = new CapturingPrompt(true);
  const service = new TransferAuthorityService({ authenticationProvider: authentication, signer, prompt, decisions });
  const trust = new LocalAp2TrustStore([{
    role: "authority",
    issuer: signer.issuer,
    kid: signer.kid,
    publicJwk: {
      kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y,
    },
  }]);
  const client = new TransferAuthorityClient({
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
  const decisions = new TransferAuthorityDecisionStore(":memory:");
  t.after(() => decisions.close());
  const service = new TransferAuthorityService({
    authenticationProvider: authentication,
    signer,
    prompt: new CapturingPrompt(false),
    decisions,
  });
  const trust = new LocalAp2TrustStore([{
    role: "authority", issuer: signer.issuer, kid: signer.kid,
    publicJwk: { kty: "EC", crv: "P-256", x: signer.privateJwk.x, y: signer.privateJwk.y },
  }]);
  const client = new TransferAuthorityClient({
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

test("Transfer Authority decision store rejects schema tampering and symlink paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-transfer-authority-store-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "decisions.sqlite");
  new TransferAuthorityDecisionStore(filename).close();
  const database = new Database(filename);
  database.exec("ALTER TABLE transfer_authority_decisions ADD COLUMN injected TEXT");
  database.close();
  assert.throws(() => new TransferAuthorityDecisionStore(filename), /startup checks/);

  const target = path.join(directory, "target.sqlite");
  fs.writeFileSync(target, "not sqlite", { mode: 0o600 });
  const linked = path.join(directory, "linked.sqlite");
  fs.symlinkSync(target, linked);
  assert.throws(() => new TransferAuthorityDecisionStore(linked), /unsafe/);
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

function transferFacts(): TransferAuthorizationFacts {
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
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    policyDigest: digest("policy"),
    operatorManifestRevision: 1,
    operatorManifestDigest: digest("manifest"),
    finalityFloor: "depth-confirmed",
  });
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("base64url")}`; }
function digestJson(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`; }
