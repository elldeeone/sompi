#!/usr/bin/env node

import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_REVISION = "4ebb82d4f82bac46ae3addd112c4752f29630a8a";
const EXPECTED_TARGET_HASHES = Object.freeze({
  "src/purchase/journal.ts":
    "3a9b4448e873b7226de95f822cfd1caefc25a30d6b012853b69d55e747f8cd90",
  "src/purchase/coordinator.ts":
    "a5e2aeb21e51279cb600417f5c0104eb0fac875ffd9c9a7d03b819976041aa73",
  "dist/purchase/journal.js":
    "9d3ba466efb496ba6a8b7ba5dfeb985dac47f9908963b63e749833a033b22aed",
  "dist/purchase/coordinator.js":
    "8b983de69d50584120f0de1d20b7bfa44915c1a6e29c0035601fa2ba5de02343",
});

const targetRoot = path.resolve(process.argv[2] ?? process.env.SOMPI_ROOT ?? "");
if (!process.argv[2] && !process.env.SOMPI_ROOT) {
  console.error("usage: ./run.sh <path-to-built-sompi-checkout>");
  process.exit(2);
}

verifyTarget(targetRoot);

const journalModule = await importFromTarget("dist/purchase/journal.js");
const identityModule = await importFromTarget("dist/purchase/identity.js");
const contractsModule = await importFromTarget("dist/purchase/contracts.js");
const coordinatorModule = await importFromTarget("dist/purchase/coordinator.js");

const {
  MERCHANT_AUTHORIZATION_EVIDENCE_KIND,
  TREASURY_STAGING_EVIDENCE_KIND,
  PurchaseJournal,
} = journalModule;
const {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} = identityModule;
const { authorizationFactsDigest } = contractsModule;
const { PurchaseCoordinator } = coordinatorModule;

const NOW = 1_800_000_000_000;
const seed = 20;
const exactTransactionId = "ab".repeat(32);
const recoveryTransactionId = "cd".repeat(32);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-can020-poc-"));
fs.chmodSync(directory, 0o700);
const filename = path.join(directory, "purchase.sqlite");
let journal;

try {
  journal = new PurchaseJournal(filename, { now: () => NOW });
  const purchaseId = createAuthorizedPurchase(journal, seed);
  const policy = journal.installPolicy({
    maxPerPaymentAtomic: "1000",
    maxPerHourAtomic: "10000",
    approvalAboveAtomic: "1000",
    allowlist: ["kaspatest:merchant"],
  });
  const authorization = journal.requireAuthorization(purchaseId);
  const reservation = journal.reservePolicy({
    id: `can020-reservation-${seed}`,
    purchaseId,
    policyDigest: policy.digest,
    payee: "kaspatest:merchant",
    amountAtomic: "60",
    additionalCostCeilingAtomic: "10",
    fundingSource: "vault-treasury",
    expiresAtMs: NOW + 60_000,
    approvalEvidenceDigest: authorization.evidenceDigest,
    approvalVerificationProfile: authorization.verificationProfile,
    approvalVerifierId: authorization.verifierId,
  });
  const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
  journal.createPaymentAttempt({ purchaseId, attempt: 1, identifier: paymentIdentifier });
  observeMerchantAuthorization(journal, purchaseId, paymentIdentifier);

  const stagingBytes = Buffer.from("can020-staging-transaction", "utf8");
  const stagingTransactionId = "8a".repeat(32);
  const stagingPlan = journal.planTreasuryStaging({
    purchaseId,
    attempt: 1,
    reservationId: reservation.id,
    idempotencyKey: `treasury-staging:${paymentIdentifier}`,
    payloadDigest: evidenceDigest(stagingBytes),
    preparedBytes: stagingBytes,
    plannedTransactionId: stagingTransactionId,
    expectedOutpoint: `${stagingTransactionId}:0`,
    stagingAmountAtomic: "70",
    fundingSource: "vault-treasury",
  });
  journal.transitionPurchase(
    purchaseId,
    "authorised",
    "execution_prepared",
    "treasury_staging_prepared"
  );
  const stagingClaim = journal.beginTreasuryStaging(
    stagingPlan.effectId,
    reservation.id,
    "can020-staging-holder",
    60_000
  );
  assert.ok(stagingClaim);
  const stagingEvidence = verifiedLinkedEvidence(
    journal,
    purchaseId,
    "can020-staging-observation",
    TREASURY_STAGING_EVIDENCE_KIND,
    1
  );
  journal.recordObservedTreasuryStaging(stagingClaim.lease, {
    effectId: stagingPlan.effectId,
    reservationId: reservation.id,
    transactionId: stagingTransactionId,
    outpoint: `${stagingTransactionId}:0`,
    stagingAmountAtomic: "70",
    fundingSource: "vault-treasury",
    evidenceDigest: stagingEvidence,
    evidenceVerificationProfile: "poc-v1",
    evidenceVerifierId: "poc-verifier",
  });
  journal.releaseLease(stagingClaim.lease);

  const exactBytes = Buffer.from("can020-immutable-exact-payment", "utf8");
  journal.preparePaymentAttempt({
    purchaseId,
    attempt: 1,
    reservationId: reservation.id,
    requirementsDigest: journal.requireCheckoutTerms(purchaseId).paymentRequirementsDigest,
    payloadDigest: evidenceDigest(exactBytes),
    preparedBytes: exactBytes,
    transactionId: exactTransactionId,
    amountAtomic: "60",
    asset: "KAS",
    network: "kaspa:testnet-10",
    payee: "kaspatest:merchant",
    requiredFinality: "accepted",
    fundingSource: "vault-treasury",
  });
  journal.transitionPurchase(
    purchaseId,
    "execution_prepared",
    "failed_recoverable",
    "staging_requires_recovery"
  );

  const recoveryBytes = Buffer.from("can020-staging-recovery", "utf8");
  const recoveryPlan = journal.planTreasuryStagingRecovery({
    purchaseId,
    attempt: 1,
    reservationId: reservation.id,
    stagingEffectId: stagingPlan.effectId,
    idempotencyKey: `treasury-staging-recovery:${paymentIdentifier}`,
    payloadDigest: evidenceDigest(recoveryBytes),
    preparedBytes: recoveryBytes,
    exactTransactionId,
    recoveryTransactionId,
    recoveryOutpoint: `${recoveryTransactionId}:0`,
    recoveryAmountAtomic: "67",
    stagingFeeAtomic: "2",
    recoveryFeeAtomic: "3",
    requiredFinality: "accepted",
    authorizedAdditionalCostCeilingAtomic: "10",
  });
  const recoveryClaim = journal.beginTreasuryStagingRecovery(
    recoveryPlan.effectId,
    "can020-recovery-holder",
    60_000
  );
  assert.ok(recoveryClaim);

  const mempoolEvidence = evidenceDigest("rpc:mempool-only-exact-candidate");
  journal.recordTreasuryStagingRecoveryObservation(
    recoveryPlan.effectId,
    recoveryClaim.lease,
    {
      status: "exact_payment_won",
      evidenceDigest: mempoolEvidence,
      winningTransactionId: exactTransactionId,
      winningFinality: "mempool",
    }
  );
  journal.releaseLease(recoveryClaim.lease);

  let context = journal.treasuryStagingRecoveryJournalContext(purchaseId, 1);
  assert.ok(context);
  assert.equal(context.plan.requiredFinality, "accepted");
  assert.equal(context.observations.at(-1)?.winningFinality, "mempool");
  assert.equal(context.effect.state, "observed");
  assert.equal(context.reservation.state, "in_flight");
  assert.equal(context.accounting, undefined);
  assert.equal(journal.findSpendForPurchase(purchaseId), undefined);

  journal.close();
  journal = new PurchaseJournal(filename, { now: () => NOW });
  context = journal.treasuryStagingRecoveryJournalContext(purchaseId, 1);
  assert.ok(context);
  assert.equal(context.effect.state, "observed");

  let observerCalls = 0;
  const stagingRecovery = {
    async observe() {
      observerCalls += 1;
      return {
        status: "safe_to_submit",
        evidenceDigest: evidenceDigest("rpc:exact-absent-staging-unspent"),
        readiness: {
          proofDigest: evidenceDigest("readiness"),
          observedAtMs: NOW,
          expiresAtMs: NOW + 10_000,
          token: {},
        },
      };
    },
    async submit() {
      throw new Error("submit must not be reached by this PoC");
    },
  };
  const unused = Object.freeze({});
  const coordinator = new PurchaseCoordinator(
    journal,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    stagingRecovery,
    unused,
    { now: () => NOW, workerId: "can020-poc", effectLeaseTtlMs: 60_000 }
  );
  assert.equal(typeof coordinator.driveStagingRecovery, "function");
  const coordinatorOutcome = await coordinator.driveStagingRecovery(context);
  const newClaim = journal.beginTreasuryStagingRecovery(
    recoveryPlan.effectId,
    "can020-after-restart",
    60_000
  );

  assert.equal(coordinatorOutcome, "exact_payment_won");
  assert.equal(observerCalls, 0);
  assert.equal(newClaim, undefined);

  console.log(`[+] source and compiled hashes match revision ${EXPECTED_REVISION}`);
  console.log(`[+] required finality: ${context.plan.requiredFinality}`);
  console.log(
    `[+] recorded winner finality: ${context.observations.at(-1)?.winningFinality}`
  );
  console.log(`[+] durable effect after restart: ${context.effect.state}`);
  console.log(`[+] reservation after restart: ${context.reservation.state}`);
  console.log(`[+] settlement spend recorded: ${Boolean(journal.findSpendForPurchase(purchaseId))}`);
  console.log(`[+] recovery accounting recorded: ${Boolean(context.accounting)}`);
  console.log(`[+] coordinator result: ${coordinatorOutcome}`);
  console.log(`[+] observer calls after restart: ${observerCalls}`);
  console.log(`[+] new recovery claim possible: ${Boolean(newClaim)}`);
  console.log("[+] reproduced terminal recovery state from provisional mempool evidence");
} finally {
  try {
    journal?.close();
  } catch {
    // Preserve the primary PoC result.
  }
  if (process.env.KEEP_POC === "1") {
    console.error(`[i] retained temporary journal at ${directory}`);
  } else {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function verifyTarget(root) {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error(`Sompi package.json not found beneath ${root}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(packageJson.name, "@elldeeone/sompi");
  assert.equal(packageJson.version, "0.8.0");
  for (const [relativePath, expected] of Object.entries(EXPECTED_TARGET_HASHES)) {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actual, expected, `${relativePath} does not match ${EXPECTED_REVISION}`);
  }
  for (const relativePath of [
    "dist/purchase/journal.js",
    "dist/purchase/identity.js",
    "dist/purchase/contracts.js",
    "dist/purchase/coordinator.js",
  ]) {
    if (!fs.existsSync(path.join(root, relativePath))) {
      throw new Error(`${relativePath} is missing; run npm ci && npm run build in the target`);
    }
  }
}

async function importFromTarget(relativePath) {
  return import(pathToFileURL(path.join(targetRoot, relativePath)).href);
}

function createAuthorizedPurchase(journal, value) {
  const id = createPurchaseId(new Uint8Array(16).fill(value));
  const resource = {
    url: `https://merchant.example/resource/${value}`,
    method: "GET",
  };
  const purchase = journal.createPurchase({
    id,
    requestKey: assertPurchaseRequestKey(`can020:purchase:${value}`),
    resourceUrl: resource.url,
    method: resource.method,
    resourceFingerprint: requestFingerprint(resource),
    expectedMerchantId: "merchant:test",
    expectedMerchantOrigin: "https://merchant.example",
  });
  const checkoutDigest = verifiedLinkedEvidence(
    journal,
    purchase.id,
    `checkout-${value}`,
    "checkout-terms",
    undefined,
    "poc-v1",
    "merchant:test"
  );
  const requirementsDigest = verifiedLinkedEvidence(
    journal,
    purchase.id,
    `requirements-${value}`,
    "payment-requirements",
    undefined,
    "poc-v1",
    "merchant:test"
  );
  journal.bindCheckoutTerms(purchase.id, {
    terms: {
      merchant: {
        id: "merchant:test",
        name: "PoC Merchant",
        origin: "https://merchant.example",
      },
      resourceFingerprint: purchase.resourceFingerprint,
      amountAtomic: "60",
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: "kaspatest:merchant",
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest,
    },
    checkoutEvidenceDigest: checkoutDigest,
    checkoutVerificationProfile: "poc-v1",
    checkoutVerifierId: "poc-verifier",
    paymentRequirementsDigest: requirementsDigest,
    paymentRequirementsVerificationProfile: "poc-v1",
    paymentRequirementsVerifierId: "poc-verifier",
  });

  const requestDigest = verifiedLinkedEvidence(
    journal,
    purchase.id,
    `authorization-request-${value}`,
    "authorization-request"
  );
  const requestBody = new Uint8Array();
  journal.storeEvidence(purchase.id, {
    bytes: requestBody,
    mediaType: "application/octet-stream",
    profile: "urn:sompi:purchase-request-body:1",
    kind: "purchase-request-body",
  });
  journal.recordAuthorizationRequest(purchase.id, {
    checkoutDigest,
    requestDigest,
    nonceDigest: evidenceDigest(`authorization-nonce-${value}`),
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(requestBody),
    additionalCostCeilingAtomic: "10",
    expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });

  const evidence = verifiedLinkedEvidence(
    journal,
    purchase.id,
    `authorization-${value}`,
    "purchase-authorization"
  );
  const terms = journal.requireCheckoutTerms(purchase.id);
  const request = journal.requireAuthorizationRequest(purchase.id);
  journal.recordAuthorizationDecision(purchase.id, {
    decision: "approved",
    authorityId: "authority:test",
    checkoutDigest: terms.checkoutDigest,
    approvedFactsDigest: authorizationFactsDigest({
      purchaseId: purchase.id,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      requestMediaType: request.requestMediaType,
      requestBodyDigest: request.requestBodyDigest,
      terms,
      requestDigest: request.requestDigest,
      nonceDigest: request.nonceDigest,
      additionalCostCeilingAtomic: request.additionalCostCeilingAtomic,
      createdAtMs: request.createdAtMs,
      expiresAtMs: request.expiresAtMs,
    }),
    evidenceDigest: evidence,
    verificationProfile: "poc-v1",
    verifierId: "poc-verifier",
    requestDigest: request.requestDigest,
    nonceDigest: request.nonceDigest,
    expiresAtMs: request.expiresAtMs,
  });
  return purchase.id;
}

function observeMerchantAuthorization(journal, purchaseId, paymentIdentifier) {
  const bytes = Buffer.from(`merchant-authorization:${paymentIdentifier}`, "utf8");
  const effect = journal.planEffect({
    purchaseId,
    kind: "merchant-authorization",
    idempotencyKey: `merchant-authorization:${paymentIdentifier}`,
    payloadDigest: evidenceDigest(bytes),
    preparedBytes: bytes,
  });
  const claim = journal.claimEffect(effect.id, "can020-merchant-authorization", 60_000);
  assert.ok(claim);
  const digest = verifiedLinkedEvidence(
    journal,
    purchaseId,
    `merchant-authorization-acceptance:${paymentIdentifier}`,
    MERCHANT_AUTHORIZATION_EVIDENCE_KIND,
    1,
    "poc-merchant-authorization-v1",
    "merchant:test"
  );
  journal.markEffectSubmitted(claim, digest);
  journal.recordEffectObservation(effect.id, claim.lease, {
    status: "observed",
    resultDigest: digest,
    detailDigest: digest,
  });
  journal.releaseLease(claim.lease);
}

function verifiedLinkedEvidence(
  journal,
  purchaseId,
  value,
  kind,
  attempt,
  profile = "poc-v1",
  issuer = "poc-issuer"
) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Uint8Array.from(value);
  const artifact = journal.storeEvidence(purchaseId, {
    bytes,
    mediaType: "application/octet-stream",
    profile,
    issuer,
    kind,
    ...(attempt === undefined ? {} : { attempt }),
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "poc-verifier",
    profile,
    detailDigest: evidenceDigest(`verified:${artifact.digest}`),
  });
  return artifact.digest;
}
