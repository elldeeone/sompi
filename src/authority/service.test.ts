import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createPurchaseId, evidenceDigest, requestFingerprint } from "../purchase/identity.js";
import { SqliteAuthorityDecisionStore } from "./decision-store.js";
import { AuthorityMacKeyFile } from "./key-provider.js";
import {
  AUTHORITY_MAC_KEY_BYTES,
  createAuthorityNonce,
  createAuthorityRequestId,
  parseAuthorityApprovalResponse,
  sealAuthorityApprovalRequest,
  type AuthorityApprovalFacts,
  type AuthorityApprovalRequest,
} from "./protocol.js";
import { SqliteAuthorityReplayStore } from "./replay-store.js";
import {
  AuthorityService,
  AuthorityServiceError,
  type AuthorityHumanDecision,
} from "./service.js";

const NOW = Date.parse("2032-01-01T00:00:00.000Z");
const KEY_ID = "authority-ipc:test:1";
const KEY = new Uint8Array(AUTHORITY_MAC_KEY_BYTES).fill(0xa5);
const TESTNET_PAYEE = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";

test("authority service persists signed evidence before response and renews a long decision lease", async () => {
  const fixture = authorityFixture();
  let now = NOW;
  const replay = new SqliteAuthorityReplayStore(path.join(fixture.directory, "replay.sqlite"), {
    now: () => now,
  });
  const decisions = new SqliteAuthorityDecisionStore(path.join(fixture.directory, "decisions.sqlite"));
  let decisionCalls = 0;
  const service = new AuthorityService({
    replayStore: replay,
    decisionStore: decisions,
    authenticationProvider: fixture.keyProvider,
    now: () => now,
    humanDecision: {
      async decide(context) {
        decisionCalls += 1;
        now += 10_000;
        context.renewLease();
        return {
          decision: "approved",
          authorityId: "authority:test",
          signedEvidence: Buffer.from("signed-authority-decision", "utf8"),
        };
      },
    },
  });
  const sealedRequest = sealAuthorityApprovalRequest(makeRequest(), authentication());
  try {
    const handled = await service.handleDecision(sealedRequest.wire);
    const responseWire = handled.responseWire;
    const persisted = decisions.find(sealedRequest.requestDigest);
    assert(persisted, "signed evidence must be durable before handle returns");
    assert.equal(Buffer.from(persisted.evidence).toString("utf8"), "signed-authority-decision");
    assert.deepEqual(handled.decisionEvidence, persisted.evidence);
    assert.notEqual(handled.decisionEvidence, persisted.evidence, "service returns an isolated evidence copy");
    assert.equal(decisionCalls, 1);

    const responseReplay = new SqliteAuthorityReplayStore(":memory:", { now: () => now });
    try {
      const response = parseAuthorityApprovalResponse(responseWire, sealedRequest, {
        ...authentication(),
        now: () => now,
        replayStore: responseReplay,
      });
      assert.equal(response.message.result.decision, "approved");
      assert.equal(response.message.result.decisionEvidenceDigest, persisted.evidenceDigest);
    } finally {
      responseReplay.close();
    }
  } finally {
    replay.close();
    decisions.close();
    fixture.cleanup();
  }
});

test("authority service recovers persisted evidence after a crash without repeating the human decision", async () => {
  const fixture = authorityFixture();
  const replayPath = path.join(fixture.directory, "replay.sqlite");
  const decisionsPath = path.join(fixture.directory, "decisions.sqlite");
  let now = NOW;
  let decisionCalls = 0;
  let replay = new SqliteAuthorityReplayStore(replayPath, { now: () => now });
  let decisions = new SqliteAuthorityDecisionStore(decisionsPath);
  const humanDecision = {
    async decide() {
      decisionCalls += 1;
      return {
        decision: "approved" as const,
        authorityId: "authority:test",
        signedEvidence: Buffer.from("durable-signed-decision", "utf8"),
      };
    },
  };
  const request = sealAuthorityApprovalRequest(makeRequest(), authentication());
  const crashing = new AuthorityService({
    replayStore: replay,
    decisionStore: decisions,
    authenticationProvider: fixture.keyProvider,
    humanDecision,
    now: () => now,
    faultInjector: () => {
      throw new Error("simulated abrupt stop");
    },
  });
  await assert.rejects(
    crashing.handle(request.wire),
    (error: unknown) => error instanceof AuthorityServiceError && error.code === "unavailable"
  );
  assert.equal(decisionCalls, 1);
  assert(decisions.find(request.requestDigest));
  replay.close();
  decisions.close();

  now += 16_000;
  replay = new SqliteAuthorityReplayStore(replayPath, { now: () => now });
  decisions = new SqliteAuthorityDecisionStore(decisionsPath);
  const recovered = new AuthorityService({
    replayStore: replay,
    decisionStore: decisions,
    authenticationProvider: fixture.keyProvider,
    humanDecision,
    now: () => now,
  });
  try {
    const response = await recovered.handle(request.wire);
    assert.equal(decisionCalls, 1, "crash recovery must use persisted signed evidence");
    assert.match(response, /approval_response/);

    now += 40_000;
    const freshTransport = await recovered.handle(request.wire);
    assert.equal(decisionCalls, 1, "completed recovery must only reissue transport");
    assert.notEqual(freshTransport, response);
  } finally {
    replay.close();
    decisions.close();
    fixture.cleanup();
  }
});

test("authority decision cancellation aborts human work, releases admission, and cannot persist a decision", async () => {
  const fixture = authorityFixture();
  const replay = new SqliteAuthorityReplayStore(path.join(fixture.directory, "replay.sqlite"), {
    now: () => NOW,
  });
  const decisions = new SqliteAuthorityDecisionStore(path.join(fixture.directory, "decisions.sqlite"));
  let started!: () => void;
  const decisionStarted = new Promise<void>((resolve) => { started = resolve; });
  const service = new AuthorityService({
    replayStore: replay,
    decisionStore: decisions,
    authenticationProvider: fixture.keyProvider,
    now: () => NOW,
    admission: { authorityPrompts: 1 },
    humanDecision: {
      async decide(context) {
        started();
        return await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    },
  });
  const request = sealAuthorityApprovalRequest(makeRequest(), authentication());
  const transport = new AbortController();
  try {
    const pending = service.handleDecision(request.wire, transport.signal);
    await decisionStarted;
    transport.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof AuthorityServiceError && error.code === "unavailable",
    );
    assert.equal(decisions.find(request.requestDigest), undefined);
    assert.deepEqual(service.admissionStatus(), {
      activePrompts: 0,
      budget: 1,
      saturated: false,
    });
  } finally {
    service.close();
    replay.close();
    decisions.close();
    fixture.cleanup();
  }
});

test("prompt saturation occurs before replay retention and late answers are discarded", async () => {
  const fixture = authorityFixture();
  const replayPath = path.join(fixture.directory, "replay.sqlite");
  const replay = new SqliteAuthorityReplayStore(replayPath, { now: () => NOW });
  const decisions = new SqliteAuthorityDecisionStore(path.join(fixture.directory, "decisions.sqlite"));
  let started!: () => void;
  let answer!: (decision: AuthorityHumanDecision) => void;
  const decisionStarted = new Promise<void>((resolve) => { started = resolve; });
  const service = new AuthorityService({
    replayStore: replay,
    decisionStore: decisions,
    authenticationProvider: fixture.keyProvider,
    admission: { authorityPrompts: 1 },
    now: () => NOW,
    humanDecision: {
      decide: async () => {
        started();
        return await new Promise<AuthorityHumanDecision>((resolve) => { answer = resolve; });
      },
    },
  });
  const first = sealAuthorityApprovalRequest(makeRequest(1), authentication());
  const transport = new AbortController();
  const pending = service.handleDecision(first.wire, transport.signal);
  await decisionStarted;
  const saturated = await Promise.allSettled(
    [2, 3, 4, 5, 6, 7].map((seed) =>
      service.handleDecision(sealAuthorityApprovalRequest(makeRequest(seed), authentication()).wire)
    )
  );
  assert.equal(saturated.filter((result) => result.status === "rejected").length, 6);
  const db = new Database(replayPath, { readonly: true });
  try {
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replay_messages").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replay_tokens").get() as { count: number }).count, 2);
  } finally {
    db.close();
  }
  transport.abort();
  answer({
    decision: "approved",
    authorityId: "authority:late",
    signedEvidence: Buffer.from("late-answer", "utf8"),
  });
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AuthorityServiceError && error.code === "unavailable",
  );
  assert.equal(decisions.find(first.requestDigest), undefined);
  assert.equal(service.admissionStatus().activePrompts, 0);
  replay.close();
  decisions.close();
  fixture.cleanup();
});

function makeRequest(seed = 1): AuthorityApprovalRequest {
  const facts = makeFacts();
  return {
    kind: "approval_request",
    requestId: createAuthorityRequestId(new Uint8Array(16).fill(seed)),
    nonce: createAuthorityNonce(new Uint8Array(32).fill(seed + 2)),
    issuedAtMs: NOW - 100,
    expiresAtMs: NOW + 2 * 60_000,
    facts,
    checkoutEvidence: {
      artifact: "checkout",
      digest: facts.checkoutDigest,
      mediaType: "application/jwt",
      profile: "urn:sompi:checkout:test:1",
      issuer: facts.merchantId,
    },
  };
}

function makeFacts(): AuthorityApprovalFacts {
  const resource = { url: "https://merchant.example/resource", method: "GET" };
  return {
    purchaseId: createPurchaseId(new Uint8Array(16).fill(4)),
    merchantId: "merchant:test",
    merchantName: "Test Merchant",
    merchantOrigin: "https://merchant.example",
    resourceUrl: resource.url,
    method: resource.method,
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    resourceFingerprint: requestFingerprint(resource),
    amountAtomic: "20000000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: TESTNET_PAYEE,
    termsExpiresAt: "2032-01-01T00:05:00.000Z",
    checkoutDigest: evidenceDigest("checkout"),
    purchaseAuthorizationRequestDigest: evidenceDigest("purchase-authorization-request"),
    purchaseAuthorizationNonceDigest: evidenceDigest("purchase-authorization-nonce"),
    purchaseAuthorizationFactsDigest: evidenceDigest("purchase-authorization-facts"),
    additionalCostCeilingAtomic: "100",
    effectiveFinalityFloor: "accepted",
    executionPlanDigest: evidenceDigest("execution-plan"),
    executionMechanism: "single-transaction",
    executionProfile: "kaspa-exact-v2:standard-native",
    settlementAssurance: "accepted",
    maximumAuthorizedChargeAtomic: "20000000",
    channelId: null,
    channelEpochDigest: null,
  };
}

function authentication() {
  return { keyId: KEY_ID, keyBytes: KEY };
}

function authorityFixture(): {
  directory: string;
  keyProvider: AuthorityMacKeyFile;
  cleanup(): void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-authority-service-"));
  fs.chmodSync(directory, 0o700);
  const keyPath = path.join(directory, "authority.key");
  fs.writeFileSync(keyPath, KEY, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return {
    directory,
    keyProvider: new AuthorityMacKeyFile(keyPath, KEY_ID),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
