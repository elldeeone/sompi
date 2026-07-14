import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_MAC_KEY_BYTES,
  createAuthorityNonce,
  createAuthorityRequestId,
  parseAuthorityApprovalRequest,
  sealAuthorityApprovalRequest,
  type AuthorityApprovalFacts,
  type AuthorityDecisionEvidenceVerificationInput,
} from "../../authority/protocol.js";
import { SqliteAuthorityReplayStore } from "../../authority/replay-store.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { Sha256Digest } from "../../purchase/types.js";
import {
  AUTHORITY_SIGNER,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_NOW,
  fixedTrustStore,
  fixedVerifiedCheckout,
} from "./test-fixtures.js";
import {
  Ap2AuthorityDecisionEvidenceVerifier,
  SOMPI_AP2_AUTHORITY_DECISION_PROFILE,
  issueAp2AuthorityDecisionEvidence,
} from "./authority-decision.js";

const KEY = new Uint8Array(AUTHORITY_MAC_KEY_BYTES).fill(0x7b);

test("authority decision evidence signs exact local facts and encloses a verified AP2 mandate pair", async () => {
  const { request, facts, checkout } = await verifiedRequest();
  const evidence = await issueAp2AuthorityDecisionEvidence({
    request,
    checkout,
    choice: { decision: "approved", instrumentId: FIXED_INSTRUMENT_ID },
    issuedAtSec: FIXED_NOW + 10,
  }, AUTHORITY_SIGNER);
  const expected = expectedInput(evidence, request, facts, "approved");
  const verifier = decisionVerifier(FIXED_NOW + 11);
  const detailed = await verifier.verifyDetailed(expected);

  assert.equal(detailed.evidence.decision, "approved");
  assert.equal(detailed.evidence.verificationProfile, SOMPI_AP2_AUTHORITY_DECISION_PROFILE);
  assert.equal(detailed.checkout.artifact, checkout.artifact);
  assert.equal(detailed.mandates?.checkout.content.checkout_jwt, checkout.artifact);
  assert.equal(detailed.mandates?.payment.amountAtomic, facts.amountAtomic);
  assert.equal(detailed.mandates?.payment.content.payment_instrument.id, FIXED_INSTRUMENT_ID);
});

test("authority denial remains independently signed without pretending to be an AP2 mandate", async () => {
  const { request, facts, checkout } = await verifiedRequest();
  const evidence = await issueAp2AuthorityDecisionEvidence({
    request,
    checkout,
    choice: { decision: "denied", denialCode: "user_denied" },
    issuedAtSec: FIXED_NOW + 10,
  }, AUTHORITY_SIGNER);
  const detailed = await decisionVerifier(FIXED_NOW + 11).verifyDetailed(
    expectedInput(evidence, request, facts, "denied"),
  );
  assert.equal(detailed.evidence.decision, "denied");
  assert.equal(detailed.denialCode, "user_denied");
  assert.equal(detailed.mandates, undefined);
});

test("authority decision verification rejects byte tampering and fact substitution", async () => {
  const { request, facts, checkout } = await verifiedRequest();
  const evidence = await issueAp2AuthorityDecisionEvidence({
    request,
    checkout,
    choice: { decision: "approved", instrumentId: FIXED_INSTRUMENT_ID },
    issuedAtSec: FIXED_NOW + 10,
  }, AUTHORITY_SIGNER);
  const verifier = decisionVerifier(FIXED_NOW + 11);
  const tampered = Uint8Array.from(evidence);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(
    verifier.verify(expectedInput(tampered, request, facts, "approved")),
    /signature is invalid|compact JWS/,
  );

  const substituted = expectedInput(evidence, request, facts, "approved");
  await assert.rejects(
    verifier.verify({
      ...substituted,
      expected: {
        ...substituted.expected,
        facts: { ...substituted.expected.facts, amountAtomic: "20000001" },
      },
    }),
    /exact authority facts|different facts|does not match|was substituted/,
  );
});

async function verifiedRequest(): Promise<{
  request: ReturnType<typeof parseAuthorityApprovalRequest>;
  facts: AuthorityApprovalFacts;
  checkout: Awaited<ReturnType<typeof fixedVerifiedCheckout>>;
}> {
  const checkout = await fixedVerifiedCheckout();
  const facts: AuthorityApprovalFacts = {
    purchaseId: checkout.purchaseId,
    merchantId: checkout.terms.merchant.id,
    merchantName: checkout.terms.merchant.name,
    merchantOrigin: checkout.terms.merchant.origin,
    resourceUrl: checkout.resourceUrl,
    method: checkout.method,
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    resourceFingerprint: checkout.terms.resourceFingerprint,
    amountAtomic: checkout.terms.amountAtomic,
    asset: checkout.terms.asset,
    network: checkout.terms.network,
    payTo: checkout.terms.payTo,
    termsExpiresAt: checkout.terms.expiresAt,
    checkoutDigest: checkout.checkoutDigest,
    purchaseAuthorizationRequestDigest: evidenceDigest("authorization-request"),
    purchaseAuthorizationNonceDigest: evidenceDigest("authorization-nonce"),
    purchaseAuthorizationFactsDigest: evidenceDigest("authorization-facts"),
    additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
    effectiveFinalityFloor: "accepted",
  };
  const sealed = sealAuthorityApprovalRequest({
    kind: "approval_request",
    requestId: createAuthorityRequestId(new Uint8Array(16).fill(1)),
    nonce: createAuthorityNonce(new Uint8Array(32).fill(2)),
    issuedAtMs: (FIXED_NOW + 1) * 1_000,
    expiresAtMs: checkout.expiresAtSec * 1_000,
    facts,
    checkoutEvidence: {
      artifact: checkout.artifact,
      digest: checkout.checkoutDigest,
      mediaType: "application/jwt",
      profile: checkout.profile,
      issuer: checkout.issuer,
    },
  }, { keyId: "authority-ipc:test", keyBytes: KEY });
  const replay = new SqliteAuthorityReplayStore(":memory:");
  const request = parseAuthorityApprovalRequest(sealed.wire, {
    keyId: "authority-ipc:test",
    keyBytes: KEY,
    replayStore: replay,
    now: () => (FIXED_NOW + 2) * 1_000,
  });
  return { request, facts, checkout };
}

function expectedInput(
  evidence: Uint8Array,
  request: ReturnType<typeof parseAuthorityApprovalRequest>,
  facts: AuthorityApprovalFacts,
  decision: "approved" | "denied",
): AuthorityDecisionEvidenceVerificationInput {
  return {
    evidence,
    expected: {
      decision,
      authorityId: FIXED_AUTHORITY_ISSUER,
      purchaseId: facts.purchaseId,
      checkoutDigest: facts.checkoutDigest,
      requestDigest: request.requestDigest,
      factsDigest: request.factsDigest,
      nonceDigest: request.nonceDigest,
      evidenceDigest: digestBytes(evidence),
      facts,
      checkoutEvidence: request.message.checkoutEvidence,
    },
  };
}

function decisionVerifier(nowSec: number): Ap2AuthorityDecisionEvidenceVerifier {
  return new Ap2AuthorityDecisionEvidenceVerifier({
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    nowSec,
    clockSkewSec: 0,
  });
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return evidenceDigest(bytes);
}
