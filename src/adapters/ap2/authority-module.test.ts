import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SqliteAuthorityDecisionStore } from "../../authority/decision-store.js";
import { AuthorityDecisionEndpoint, AuthorityUnixDecisionClient, AuthorityUnixDecisionServer } from "../../authority/endpoint.js";
import type { AuthorityAuthenticationProvider } from "../../authority/key-provider.js";
import {
  AUTHORITY_MAC_KEY_BYTES,
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
    const copy = Uint8Array.from(KEY);
    try {
      return await operation({ keyId: "authority-ipc:test", keyBytes: copy });
    } finally {
      copy.fill(0);
    }
  }
}
