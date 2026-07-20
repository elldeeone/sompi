import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { PolicyEngine } from "../policy.js";
import { PurchaseJournal } from "../purchase/journal.js";
import { PolicyChangeModule, policyChangeFactsDigest } from "./module.js";
import type { PolicyChangeAuthorityModule, PolicyChangeFacts } from "./types.js";
import type { Sha256Digest } from "../purchase/types.js";

const MANIFEST = Object.freeze({
  revision: 1,
  digest: `sha256:${createHash("sha256").update("manifest").digest("base64url")}`,
});

test("owner-approved Policy Change atomically activates new everyday limits", async (t) => {
  const { journal, policy, module } = fixture();
  t.after(() => journal.close());

  const result = await module.propose({
    requestKey: "telegram:update-limits:1",
    maximumPerPaymentAtomic: "200000000",
    maximumPerHourAtomic: "400000000",
  });

  assert.equal(result.state, "applied");
  assert.equal(policy.policy.maxSompiPerTx, 200000000n);
  assert.equal(policy.policy.maxSompiPerHour, 400000000n);
  assert.equal(journal.requireActivePolicy().version, 2);
  assert.equal(result.everyPaymentRequiresApproval, true);
});

test("a denied or substituted Policy Change cannot alter policy", async (t) => {
  const denied = fixture("denied");
  t.after(() => denied.journal.close());
  const result = await denied.module.propose({
    requestKey: "telegram:update-limits:denied",
    maximumPerPaymentAtomic: "200000000",
    maximumPerHourAtomic: "400000000",
  });
  assert.equal(result.state, "denied");
  assert.equal(denied.policy.policy.maxSompiPerTx, 100000000n);

  const substituted = fixture("substitute");
  t.after(() => substituted.journal.close());
  await assert.rejects(
    substituted.module.propose({
      requestKey: "telegram:update-limits:substituted",
      maximumPerPaymentAtomic: "200000000",
      maximumPerHourAtomic: "400000000",
    }),
    /not bound to the displayed limits/,
  );
  assert.equal(substituted.journal.requireActivePolicy().version, 1);
});

test("Policy Change request keys are idempotent and stale policy CAS fails closed", async (t) => {
  const { journal, module } = fixture();
  t.after(() => journal.close());
  const initialDigest = journal.requireActivePolicy().digest;
  const first = await module.propose({
    requestKey: "telegram:update-limits:repeat",
    maximumPerPaymentAtomic: "200000000",
    maximumPerHourAtomic: "400000000",
  });
  const repeated = await module.propose({
    requestKey: "telegram:update-limits:repeat",
    maximumPerPaymentAtomic: "200000000",
    maximumPerHourAtomic: "400000000",
  });
  assert.equal(repeated.id, first.id);
  await assert.rejects(
    module.propose({
      requestKey: "telegram:update-limits:repeat",
      maximumPerPaymentAtomic: "300000000",
      maximumPerHourAtomic: "400000000",
    }),
    /request key is already bound to different limits/,
  );
  assert.equal(journal.requireActivePolicy().version, 2);

  assert.throws(() => journal.activatePolicyIfCurrent(initialDigest, {
    maxPerPaymentAtomic: "300000000",
    maxPerHourAtomic: "400000000",
    allowlist: [],
  }), /active treasury policy changed/);
});

test("a stale approval cannot replay after an A-B-A policy activation cycle", () => {
  const { journal } = fixture();
  try {
    const initial = journal.requireActivePolicyActivation();
    const vaultDigest = digest(Buffer.from("vault"));
    const id = "pcg_AAAAAAAAAAAAAAAAAAAAAA";
    journal.createPolicyChange({
      id,
      requestKey: "telegram:update-limits:aba",
      expectedPolicyDigest: initial.policy.digest,
      expectedPolicyGeneration: initial.activationGeneration,
      expectedVaultDigest: vaultDigest,
      previousMaximumPerPaymentAtomic: initial.policy.maxPerPaymentAtomic,
      previousMaximumPerHourAtomic: initial.policy.maxPerHourAtomic,
      proposedMaximumPerPaymentAtomic: "300000000",
      proposedMaximumPerHourAtomic: "500000000",
      vaultMaximumOutflowAtomic: "500000000",
      manifestRevision: MANIFEST.revision,
      manifestDigest: MANIFEST.digest as Sha256Digest,
      expiresAtMs: 2_000,
    });
    journal.markPolicyChangeAwaitingAuthority(id);
    const b = journal.activatePolicyIfCurrent(initial.policy.digest, {
      maxPerPaymentAtomic: "50000000", maxPerHourAtomic: "400000000", allowlist: [],
    });
    journal.activatePolicyIfCurrent(b.digest, {
      maxPerPaymentAtomic: initial.policy.maxPerPaymentAtomic,
      maxPerHourAtomic: initial.policy.maxPerHourAtomic,
      allowlist: [],
    });
    const restored = journal.requireActivePolicyActivation();
    assert.equal(restored.policy.digest, initial.policy.digest);
    assert.equal(restored.activationGeneration, initial.activationGeneration + 2);
    assert.throws(() => journal.authorizeAndActivatePolicyChange(
      id,
      { authorityId: "owner", evidenceDigest: digest(Buffer.from("approved")), evidence: Buffer.from("approved") },
      { maxPerPaymentAtomic: "300000000", maxPerHourAtomic: "500000000", allowlist: [] },
      {
        expectedPolicyGeneration: initial.activationGeneration,
        expectedVaultDigest: vaultDigest,
        currentVaultDigest: vaultDigest,
        currentVaultMaximumOutflowAtomic: "500000000",
      },
    ), /active treasury policy changed/);
  } finally {
    journal.close();
  }
});

test("an approved Policy Change cannot compose with a different vault generation", () => {
  const { journal } = fixture();
  try {
    const active = journal.requireActivePolicyActivation();
    const reviewedVault = digest(Buffer.from("vault-before"));
    const currentVault = digest(Buffer.from("vault-after"));
    const id = "pcg_BBBBBBBBBBBBBBBBBBBBBB";
    journal.createPolicyChange({
      id,
      requestKey: "telegram:update-limits:vault-race",
      expectedPolicyDigest: active.policy.digest,
      expectedPolicyGeneration: active.activationGeneration,
      expectedVaultDigest: reviewedVault,
      previousMaximumPerPaymentAtomic: active.policy.maxPerPaymentAtomic,
      previousMaximumPerHourAtomic: active.policy.maxPerHourAtomic,
      proposedMaximumPerPaymentAtomic: "200000000",
      proposedMaximumPerHourAtomic: "400000000",
      vaultMaximumOutflowAtomic: "500000000",
      manifestRevision: MANIFEST.revision,
      manifestDigest: MANIFEST.digest as Sha256Digest,
      expiresAtMs: 2_000,
    });
    journal.markPolicyChangeAwaitingAuthority(id);
    assert.throws(() => journal.authorizeAndActivatePolicyChange(
      id,
      { authorityId: "owner", evidenceDigest: digest(Buffer.from("approved-vault-race")), evidence: Buffer.from("approved-vault-race") },
      { maxPerPaymentAtomic: "200000000", maxPerHourAtomic: "400000000", allowlist: [] },
      {
        expectedPolicyGeneration: active.activationGeneration,
        expectedVaultDigest: reviewedVault,
        currentVaultDigest: currentVault,
        currentVaultMaximumOutflowAtomic: "600000000",
      },
    ), /protection state changed/);
  } finally {
    journal.close();
  }
});

function fixture(mode: "approved" | "denied" | "substitute" = "approved") {
  const journal = new PurchaseJournal(":memory:", {
    now: () => 1_000,
    operatorManifestIdentity: MANIFEST,
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67_108_864,
      directTreasuryRetries: 3,
    },
  });
  journal.installPolicy({
    maxPerPaymentAtomic: "100000000",
    maxPerHourAtomic: "500000000",
    allowlist: [],
  });
  const policy = new PolicyEngine({
    maxSompiPerTx: 100000000n,
    maxSompiPerHour: 500000000n,
    allowlist: [],
  });
  const authority: PolicyChangeAuthorityModule = {
    async request(facts: PolicyChangeFacts) {
      const evidence = Buffer.from(JSON.stringify({ facts, decision: mode }), "utf8");
      return Object.freeze({
        decision: mode === "denied" ? "denied" as const : "approved" as const,
        authorityId: "https://authority.example.test",
        evidence: Uint8Array.from(evidence),
        evidenceDigest: digest(evidence),
        factsDigest: mode === "substitute" ? digest(Buffer.from("wrong")) : policyChangeFactsDigest(facts),
        decidedAtMs: 1_000,
      });
    },
  };
  const module = new PolicyChangeModule({
    journal,
    policy,
    authority,
    manifest: () => MANIFEST,
    vaultProtection: () => Object.freeze({
      digest: digest(Buffer.from("vault")),
      maximumOutflowAtomic: "500000000",
    }),
    now: () => 1_000,
  });
  return { journal, policy, module };
}

function digest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}` as Sha256Digest;
}
