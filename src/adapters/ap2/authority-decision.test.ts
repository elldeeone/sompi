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
  fixedGenericCheckout,
  fixedTrustStore,
} from "./authority-test-fixtures.js";
import {
  Ap2AuthorityDecisionEvidenceVerifier,
  SOMPI_AP2_AUTHORITY_DECISION_PROFILE,
  issueAp2AuthorityDecisionEvidence,
} from "./authority-decision.js";

const KEY = new Uint8Array(AUTHORITY_MAC_KEY_BYTES).fill(0x7b);

test("authority decision evidence signs the exact canonical purchase facts", async () => {
  const { request, facts } = await verifiedRequest();
  const evidence = await issueAp2AuthorityDecisionEvidence({
    request,
    choice: { decision: "approved", instrumentId: FIXED_INSTRUMENT_ID },
    issuedAtSec: FIXED_NOW + 10,
  }, AUTHORITY_SIGNER);
  const expected = expectedInput(evidence, request, facts, "approved");
  const verifier = decisionVerifier(FIXED_NOW + 11);
  const detailed = await verifier.verifyDetailed(expected);

  assert.equal(detailed.evidence.decision, "approved");
  assert.equal(detailed.evidence.verificationProfile, SOMPI_AP2_AUTHORITY_DECISION_PROFILE);
  assert.equal(detailed.instrumentId, FIXED_INSTRUMENT_ID);
});

test("authority denial remains independently signed without pretending to be an AP2 mandate", async () => {
  const { request, facts } = await verifiedRequest();
  const evidence = await issueAp2AuthorityDecisionEvidence({
    request,
    choice: { decision: "denied", denialCode: "user_denied" },
    issuedAtSec: FIXED_NOW + 10,
  }, AUTHORITY_SIGNER);
  const detailed = await decisionVerifier(FIXED_NOW + 11).verifyDetailed(
    expectedInput(evidence, request, facts, "denied"),
  );
  assert.equal(detailed.evidence.decision, "denied");
  assert.equal(detailed.denialCode, "user_denied");
  assert.equal(detailed.instrumentId, undefined);
});

test("authority decision verification rejects byte tampering and fact substitution", async () => {
  const { request, facts } = await verifiedRequest();
  const evidence = await issueAp2AuthorityDecisionEvidence({
    request,
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

test("batch authority evidence rejects execution profile, channel epoch, ceiling, or finality substitution", async () => {
  const channelId = "ab".repeat(32);
  const channelEpochDigest = evidenceDigest("batch-channel-epoch");
  const { request, facts } = await verifiedRequest({
    effectiveFinalityFloor: "depth-confirmed",
    executionPlanDigest: evidenceDigest("batch-execution-plan"),
    executionMechanism: "channel-voucher",
    executionProfile: "kaspa-escrow-v1:batch-settlement",
    settlementAssurance: "channel-commitment",
    maximumAuthorizedChargeAtomic: "12000000",
    channelId,
    channelEpochDigest,
  });
  const evidence = await issueAp2AuthorityDecisionEvidence({
    request,
    choice: { decision: "approved", instrumentId: FIXED_INSTRUMENT_ID },
    issuedAtSec: FIXED_NOW + 10,
  }, AUTHORITY_SIGNER);
  const verifier = decisionVerifier(FIXED_NOW + 11);
  const expected = expectedInput(evidence, request, facts, "approved");
  await verifier.verify(expected);

  const substitutions: ReadonlyArray<Partial<AuthorityApprovalFacts>> = [
    { executionProfile: "kaspa-exact-v2:standard-native" },
    { maximumAuthorizedChargeAtomic: "12000001" },
    { channelId: "cd".repeat(32) },
    { channelEpochDigest: evidenceDigest("other-batch-channel-epoch") },
    { effectiveFinalityFloor: "accepted" },
  ];
  for (const substitution of substitutions) {
    await assert.rejects(
      verifier.verify({
        ...expected,
        expected: {
          ...expected.expected,
          facts: { ...facts, ...substitution },
        },
      }),
      /exact authority facts|different facts|does not match|was substituted/,
    );
  }
});

async function verifiedRequest(
  factOverrides: Partial<AuthorityApprovalFacts> = {},
): Promise<{
  request: ReturnType<typeof parseAuthorityApprovalRequest>;
  facts: AuthorityApprovalFacts;
}> {
  const checkout = fixedGenericCheckout();
  const checkoutArtifact = "generic-x402-payment-required";
  const checkoutDigest = evidenceDigest(checkoutArtifact);
  const facts: AuthorityApprovalFacts = {
    purchaseId: checkout.purchaseId,
    merchantId: checkout.terms.merchant.origin,
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
    checkoutDigest,
    purchaseAuthorizationRequestDigest: evidenceDigest("authorization-request"),
    purchaseAuthorizationNonceDigest: evidenceDigest("authorization-nonce"),
    purchaseAuthorizationFactsDigest: evidenceDigest("authorization-facts"),
    additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
    effectiveFinalityFloor: "accepted",
    executionPlanDigest: evidenceDigest("execution-plan"),
    executionMechanism: "single-transaction",
    executionProfile: "kaspa-exact-v2:standard-native",
    settlementAssurance: "accepted",
    maximumAuthorizedChargeAtomic: checkout.terms.amountAtomic,
    channelId: null,
    channelEpochDigest: null,
    ...factOverrides,
  };
  const sealed = sealAuthorityApprovalRequest({
    kind: "approval_request",
    requestId: createAuthorityRequestId(new Uint8Array(16).fill(1)),
    nonce: createAuthorityNonce(new Uint8Array(32).fill(2)),
    issuedAtMs: (FIXED_NOW + 1) * 1_000,
    expiresAtMs: Date.parse(checkout.terms.expiresAt),
    facts,
    checkoutEvidence: {
      artifact: checkoutArtifact,
      digest: checkoutDigest,
      mediaType: "application/x402-payment-required",
      profile: "kaspa-x402-0.1.0-alpha.9-payment-required",
      issuer: checkout.terms.merchant.origin,
    },
  }, { keyId: "authority-ipc:test", keyBytes: KEY });
  const replay = new SqliteAuthorityReplayStore(":memory:");
  const request = parseAuthorityApprovalRequest(sealed.wire, {
    keyId: "authority-ipc:test",
    keyBytes: KEY,
    replayStore: replay,
    now: () => (FIXED_NOW + 2) * 1_000,
  });
  return { request, facts };
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
