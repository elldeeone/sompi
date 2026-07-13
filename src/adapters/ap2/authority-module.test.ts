import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SqliteAuthorityDecisionStore } from "../../authority/decision-store.js";
import { AuthorityDecisionEndpoint, AuthorityUnixDecisionClient, AuthorityUnixDecisionServer } from "../../authority/endpoint.js";
import type { AuthorityAuthenticationProvider } from "../../authority/key-provider.js";
import {
  AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
  AUTHORITY_MAC_KEY_BYTES,
  authorityFactsDigest,
  bindAuthorityApprovalResponse,
  createAuthorityResponseId,
  parseAuthorityApprovalRequest,
  sealAuthorityApprovalResponse,
  type AuthorityAuthenticationInput,
} from "../../authority/protocol.js";
import { SqliteAuthorityReplayStore } from "../../authority/replay-store.js";
import { AuthorityService } from "../../authority/service.js";
import type { PurchaseAuthorizationRequest } from "../../purchase/contracts.js";
import { evidenceDigest } from "../../purchase/identity.js";
import {
  AUTHORITY_SIGNER,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_NOW,
  fixedTrustStore,
  fixedVerifiedCheckout,
} from "./test-fixtures.js";
import { Ap2AuthorityDecisionEvidenceVerifier } from "./authority-decision.js";
import { Ap2AuthorityModule } from "./authority-module.js";
import {
  Ap2HumanAuthorityDecisionProvider,
  type AuthorityApprovalDisplay,
  type AuthorityApprovalPrompt,
} from "./human-authority.js";

const KEY = new Uint8Array(AUTHORITY_MAC_KEY_BYTES).fill(0x9d);

test("separate Unix authority completes and independently verifies an AP2 approval", async () => {
  const fixture = await authoritySystem(true);
  try {
    const result = await fixture.module.request(fixture.input);
    assert.equal(result.status, "decision");
    if (result.status !== "decision") return;
    assert.equal(result.decision.evidence.decision, "approved");
    assert.equal(result.decision.evidence.authorityId, FIXED_AUTHORITY_ISSUER);
    assert.equal(result.supportingEvidence?.length, 2);
    assert.deepEqual(fixture.displayed?.price, {
      amountAtomic: fixture.input.request.terms.amountAtomic,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: fixture.input.request.terms.payTo,
    });
    assert(!Buffer.from(result.decisionEvidenceBytes).includes(Buffer.from("ALSko8")));
  } finally {
    await fixture.close();
  }
});

test("the human display is exactly the independently signed Purchase decision", async () => {
  const fixture = await authoritySystem(true);
  try {
    const result = await fixture.module.request(fixture.input);
    assert.equal(result.status, "decision");
    if (result.status !== "decision") return;
    const facts = result.decision.facts;
    assert.deepEqual(fixture.displayed, {
      purchaseId: facts.purchaseId,
      merchant: {
        id: facts.merchantId,
        name: facts.merchantName,
        origin: facts.merchantOrigin,
      },
      request: {
        url: facts.resourceUrl,
        method: facts.method,
        mediaType: facts.requestMediaType,
        bodyDigest: facts.requestBodyDigest,
        fingerprint: facts.resourceFingerprint,
      },
      price: {
        amountAtomic: facts.amountAtomic,
        asset: facts.asset,
        network: facts.network,
        payTo: facts.payTo,
      },
      checkoutDigest: facts.checkoutDigest,
      termsExpiresAt: facts.termsExpiresAt,
      additionalCostCeilingAtomic: facts.additionalCostCeilingAtomic,
      effectiveFinalityFloor: "accepted",
      recoveryRetry: false,
    });
    assert.equal(
      result.decision.evidence.factsDigest,
      authorityFactsDigest(facts),
      "the verified signature must bind the exact facts rendered to the human",
    );
    assert.equal(result.decision.evidence.purchaseId, fixture.displayed?.purchaseId);
    assert.equal(result.decision.evidence.checkoutDigest, fixture.displayed?.checkoutDigest);
  } finally {
    await fixture.close();
  }
});

test("human denial is signed, verified, and carries no fabricated AP2 mandate", async () => {
  const fixture = await authoritySystem(false);
  try {
    const result = await fixture.module.request(fixture.input);
    assert.equal(result.status, "decision");
    if (result.status !== "decision") return;
    assert.equal(result.decision.evidence.decision, "denied");
    assert.equal(result.decision.ipc.message.result.decision, "denied");
    assert.equal(result.supportingEvidence, undefined);
  } finally {
    await fixture.close();
  }
});

test("MCP-side module rejects substituted Checkout bytes before IPC", async () => {
  const fixture = await authoritySystem(true);
  try {
    const bytes = Uint8Array.from(fixture.input.checkoutEvidence.bytes);
    bytes[bytes.length - 1] ^= 1;
    await assert.rejects(
      fixture.module.request({
        ...fixture.input,
        checkoutEvidence: { ...fixture.input.checkoutEvidence, bytes },
      }),
      /Checkout evidence bytes are invalid/,
    );
    assert.equal(fixture.promptCalls(), 0);
  } finally {
    await fixture.close();
  }
});

test("an MCP process with the shared IPC MAC still cannot forge authority approval evidence", async () => {
  const fixture = await authoritySystem(true);
  const nowMs = (FIXED_NOW + 5) * 1_000;
  const attackerReplay = new SqliteAuthorityReplayStore(":memory:", {
    now: () => nowMs,
  });
  const clientReplay = new SqliteAuthorityReplayStore(":memory:", {
    now: () => nowMs,
  });
  const forgedEvidence = Buffer.from(
    "agent-forged-authority-decision-without-authority-signing-key",
    "utf8",
  );
  const verifier = new Ap2AuthorityDecisionEvidenceVerifier({
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    nowSec: Math.floor(nowMs / 1_000),
    clockSkewSec: 0,
  });
  const forgedModule = new Ap2AuthorityModule({
    authenticationProvider: new StaticAuthenticationProvider(),
    replayStore: clientReplay,
    transport: {
      async request(requestWire) {
        const authentication = staticAuthentication();
        try {
          const request = parseAuthorityApprovalRequest(requestWire, {
            ...authentication,
            replayStore: attackerReplay,
            now: () => nowMs,
          });
          const response = bindAuthorityApprovalResponse(request, {
            responseId: createAuthorityResponseId(new Uint8Array(16).fill(0x44)),
            respondedAtMs: nowMs,
            expiresAtMs: Math.min(nowMs + 20_000, request.message.expiresAtMs),
            result: {
              decision: "approved",
              authorityId: FIXED_AUTHORITY_ISSUER,
              decisionEvidenceDigest: evidenceDigest(forgedEvidence),
              evidenceVerification: AUTHORITY_EVIDENCE_VERIFICATION_REQUIREMENT,
            },
          });
          return {
            responseWire: sealAuthorityApprovalResponse(
              response,
              request,
              authentication,
            ).wire,
            decisionEvidence: Uint8Array.from(forgedEvidence),
          };
        } finally {
          authentication.keyBytes.fill(0);
        }
      },
    },
    verifier,
    now: () => nowMs,
  });
  try {
    await assert.rejects(
      forgedModule.request(fixture.input),
      /authority decision evidence|compact JWS|signature/i,
    );
    assert.equal(
      fixture.promptCalls(),
      0,
      "an MCP-side forgery must not reach or imitate the authority prompt",
    );
  } finally {
    attackerReplay.close();
    clientReplay.close();
    await fixture.close();
  }
});

test("durable authorization retries reconstruct one IPC request and do not prompt twice", async () => {
  const fixture = await authoritySystem(true);
  try {
    const first = await fixture.module.request(fixture.input);
    const recovered = await fixture.module.request(fixture.input);
    assert.equal(first.status, "decision");
    assert.equal(recovered.status, "decision");
    assert.equal(fixture.promptCalls(), 1);
    if (first.status === "decision" && recovered.status === "decision") {
      assert.equal(
        recovered.decision.evidence.evidenceDigest,
        first.decision.evidence.evidenceDigest,
      );
      assert.notEqual(
        recovered.decision.ipc.message.responseId,
        first.decision.ipc.message.responseId,
      );
    }
  } finally {
    await fixture.close();
  }
});

async function authoritySystem(approve: boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-ap2-authority-"));
  const socketPath = path.join(directory, "authority.sock");
  const authentication = new StaticAuthenticationProvider();
  const nowMs = (FIXED_NOW + 5) * 1_000;
  const checkout = await fixedVerifiedCheckout();
  const request: PurchaseAuthorizationRequest = {
    purchaseId: checkout.purchaseId,
    resourceUrl: checkout.resourceUrl,
    method: checkout.method,
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    terms: checkout.terms,
    requestDigest: evidenceDigest("purchase-authorization-request"),
    nonceDigest: evidenceDigest("purchase-authorization-nonce"),
    additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
    effectiveFinalityFloor: "accepted",
    createdAtMs: nowMs,
    expiresAtMs: checkout.expiresAtSec * 1_000,
  };
  let displayed: AuthorityApprovalDisplay | undefined;
  let calls = 0;
  const prompt = makePrompt(async (facts) => {
    calls += 1;
    displayed = facts;
    return approve;
  });
  const authorityReplay = new SqliteAuthorityReplayStore(path.join(directory, "authority-replay.sqlite"), {
    now: () => nowMs,
  });
  const decisions = new SqliteAuthorityDecisionStore(path.join(directory, "authority-decisions.sqlite"));
  const human = new Ap2HumanAuthorityDecisionProvider({
    signer: AUTHORITY_SIGNER,
    trust: fixedTrustStore(),
    instrumentId: FIXED_INSTRUMENT_ID,
    prompt,
    now: () => nowMs,
  });
  const service = new AuthorityService({
    replayStore: authorityReplay,
    decisionStore: decisions,
    authenticationProvider: authentication,
    humanDecision: human,
    now: () => nowMs,
  });
  const server = new AuthorityUnixDecisionServer({
    socketPath,
    endpoint: new AuthorityDecisionEndpoint(service),
    timeoutMs: 5_000,
  });
  await server.start();
  const clientReplay = new SqliteAuthorityReplayStore(path.join(directory, "client-replay.sqlite"), {
    now: () => nowMs,
  });
  const verifier = new Ap2AuthorityDecisionEvidenceVerifier({
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    nowSec: Math.floor(nowMs / 1_000),
    clockSkewSec: 0,
  });
  const module = new Ap2AuthorityModule({
    authenticationProvider: authentication,
    replayStore: clientReplay,
    transport: new AuthorityUnixDecisionClient({ socketPath, timeoutMs: 5_000 }),
    verifier,
    now: () => nowMs,
  });
  return {
    module,
    input: {
      request,
      checkoutEvidence: {
        bytes: Buffer.from(checkout.artifact, "ascii"),
        digest: checkout.checkoutDigest,
        mediaType: "application/jwt",
        profile: checkout.profile,
        issuer: checkout.issuer,
      },
    },
    get displayed() { return displayed; },
    promptCalls: () => calls,
    async close() {
      await server.close();
      clientReplay.close();
      authorityReplay.close();
      decisions.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function makePrompt(
  approve: (display: AuthorityApprovalDisplay) => Promise<boolean>,
): AuthorityApprovalPrompt {
  return { approve };
}

class StaticAuthenticationProvider implements AuthorityAuthenticationProvider {
  async withAuthentication<T>(
    operation: (authentication: AuthorityAuthenticationInput) => T | Promise<T>,
  ): Promise<T> {
    const copy = staticAuthentication().keyBytes;
    try {
      return await operation({ keyId: "authority-ipc:test", keyBytes: copy });
    } finally {
      copy.fill(0);
    }
  }
}

function staticAuthentication(): AuthorityAuthenticationInput {
  return {
    keyId: "authority-ipc:test",
    keyBytes: Uint8Array.from(KEY),
  };
}
