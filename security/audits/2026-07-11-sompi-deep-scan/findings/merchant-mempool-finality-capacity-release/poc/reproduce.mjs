#!/usr/bin/env node

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const EXPECTED_REVISION = "4ebb82d4f82bac46ae3addd112c4752f29630a8a";
const EXPECTED_SOURCE_HASHES = Object.freeze({
  "src/adapters/kaspa-x402/payment-requirements-verifier.ts":
    "dcb98595a28d77e41436e9eff9dbf174abb983ee28d04e7fb5aa947c508c1c73",
  "src/authority/protocol.ts":
    "f219a412078b4fc4c590a130caa43ccb6733f2ee44bbeec2bd75eaa887a3e4b1",
  "src/adapters/ap2/human-authority.ts":
    "41813742ee40f1aec39ebd63ce527e9a7d696cc3851070fa3e81d1c78870755e",
  "src/adapters/kaspa-x402/staging-recovery-module.ts":
    "d08741180dc6279f362f2542015a81335c1f67dfe1537e29f4fdadf0da8fb874",
  "src/adapters/kaspa-x402/abandoned-staging-recovery.ts":
    "937213a65c090669378e80f0a73bea8fd0de5970f291de72965824f62af98ad1",
  "src/purchase/journal.ts":
    "3a9b4448e873b7226de95f822cfd1caefc25a30d6b012853b69d55e747f8cd90",
});

const target = path.resolve(process.argv[2] ?? "../../../sompi");
const moduleUrl = (relativePath) => pathToFileURL(path.join(target, relativePath)).href;

assertTargetSource();

const { encodePaymentRequiredHeader } = await import(
  moduleUrl("node_modules/@kaspa-x402/core/dist/index.js")
);
const {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} = await import(moduleUrl("dist/purchase/identity.js"));
const { authorizationFactsDigest } = await import(
  moduleUrl("dist/purchase/contracts.js")
);
const {
  MERCHANT_AUTHORIZATION_EVIDENCE_KIND,
  PurchaseJournal,
  TREASURY_STAGING_EVIDENCE_KIND,
} = await import(moduleUrl("dist/purchase/journal.js"));
const { KaspaX402PaymentRequirementsVerifier } = await import(
  moduleUrl("dist/adapters/kaspa-x402/payment-requirements-verifier.js")
);
const { KaspaStagingRecoveryModule } = await import(
  moduleUrl("dist/adapters/kaspa-x402/staging-recovery-module.js")
);
const { AbandonedStagingRecovery } = await import(
  moduleUrl("dist/adapters/kaspa-x402/abandoned-staging-recovery.js")
);

const NOW = 1_800_000_000_000;
const PURCHASE_ID = createPurchaseId(new Uint8Array(16).fill(30));
const RESOURCE_URL = "https://merchant.example/resource/30";
const PAY_TO = "kaspatest:merchant";
const STAGING_TXID = "3e".repeat(32);
const RECOVERY_TXID = "5e".repeat(32);
const EXACT_TXID = "7e".repeat(32);
const STAGING_OUTPOINT = `${STAGING_TXID}:0`;
const STAGING_SCRIPT = "000051";
const STAGING_EVIDENCE = evidenceDigest("staging-observation-30");

const terms = Object.freeze({
  merchant: Object.freeze({
    id: "merchant:test",
    name: "Test Merchant",
    origin: "https://merchant.example",
  }),
  resourceFingerprint: requestFingerprint({ url: RESOURCE_URL, method: "GET" }),
  amountAtomic: "60",
  asset: "KAS",
  network: "kaspa:testnet-10",
  payTo: PAY_TO,
  expiresAt: "2099-01-01T00:00:00.000Z",
  checkoutDigest: evidenceDigest("checkout-30"),
});

const paymentHeader = encodePaymentRequiredHeader(paymentRequiredWire("mempool"));
const paymentBytes = Buffer.from(paymentHeader, "ascii");
const verifier = new KaspaX402PaymentRequirementsVerifier();
await verifier.verify({
  artifact: paymentBytes,
  expectedDigest: evidenceDigest(paymentBytes),
  terms,
  additionalCostCeilingAtomic: "10",
  finalHop: { url: RESOURCE_URL },
  nowMs: NOW,
});
console.log("[+] Merchant PAYMENT-REQUIRED with finality=mempool passed verification");

assertAuthorityOmitsFinality();
console.log("[+] authority facts and display omit decoded finality");

const recoveryModule = new KaspaStagingRecoveryModule({
  metadata: {
    async read() {
      return Object.freeze({
        transactionId: STAGING_TXID,
        outpoint: STAGING_OUTPOINT,
        stagingAmountAtomic: "70",
        address: "kaspatest:staging",
        scriptPublicKey: STAGING_SCRIPT,
        additionalCostCeilingAtomic: "10",
        priceAtomic: "60",
        keyReference: "staging-key-30",
        stagingFeeAtomic: "2",
      });
    },
  },
  observedStaging: {
    async read() {
      return Object.freeze({
        transactionId: STAGING_TXID,
        outpoint: STAGING_OUTPOINT,
        amountAtomic: "70",
        address: "kaspatest:staging",
        scriptPublicKey: STAGING_SCRIPT,
        blockDaaScore: "100",
        evidenceDigest: STAGING_EVIDENCE,
      });
    },
  },
  recovery: {
    async prepare() {
      const preparedBytes = Buffer.from("immutable-recovery-30", "utf8");
      return Object.freeze({
        preparedBytes,
        preparedDigest: evidenceDigest(preparedBytes),
        transactionId: RECOVERY_TXID,
        recoveryAmountAtomic: "67",
        feeAtomic: "3",
      });
    },
  },
});

const prepared = await recoveryModule.prepare({
  purchaseId: PURCHASE_ID,
  paymentIdentifier: createPaymentIdentifier(PURCHASE_ID, 1),
  stagingEvidenceDigest: STAGING_EVIDENCE,
  authorizedAdditionalCostCeilingAtomic: "10",
  terms,
  paymentRequirements: paymentBytes,
});
assert.equal(prepared.requiredFinality, "mempool");
console.log("[+] recovery plan copied requiredFinality=mempool");

const provisional = classifyProvisionalRecovery();
assert.equal(provisional.status, "recovery_won");
assert.equal(provisional.finality, "mempool");
console.log(
  "[+] classifier returned recovery_won at mempool while staging status=unspent"
);

const outcome = exerciseJournalRelease(prepared, provisional);
console.log(
  `[+] journal state before observation: reservation=${outcome.beforeState}, ` +
    `capacity=${outcome.beforeCapacity}`
);
console.log(
  `[+] journal state after observation: reservation=${outcome.afterState}, ` +
    `capacity=${outcome.afterCapacity}, purchase=${outcome.purchaseState}`
);
console.log("[+] durable reopen preserved released reservation and recovery accounting");
console.log(
  `[+] primitive reproduced: provisional recovery released ${outcome.releasedCapacity} ` +
    "units of policy capacity"
);
console.log("[!] not claimed: no dual acceptance or direct theft; one-spend consensus still applies");
console.log("[!] not exercised: eviction, later exact winner, and capacity reuse");

function assertTargetSource() {
  for (const [relativePath, expected] of Object.entries(EXPECTED_SOURCE_HASHES)) {
    const bytes = fs.readFileSync(path.join(target, relativePath));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actual, expected, `${relativePath} does not match the reviewed revision`);
  }
  for (const relativePath of [
    "dist/purchase/journal.js",
    "dist/adapters/kaspa-x402/payment-requirements-verifier.js",
    "dist/adapters/kaspa-x402/staging-recovery-module.js",
    "dist/adapters/kaspa-x402/abandoned-staging-recovery.js",
  ]) {
    assert.ok(fs.statSync(path.join(target, relativePath)).isFile(), `${relativePath} is not built`);
  }
  console.log(`[+] exact source hashes match vulnerable revision ${EXPECTED_REVISION}`);
}

function assertAuthorityOmitsFinality() {
  const protocol = fs.readFileSync(path.join(target, "src/authority/protocol.ts"), "utf8");
  const display = fs.readFileSync(
    path.join(target, "src/adapters/ap2/human-authority.ts"),
    "utf8"
  );
  const factsBlock = between(
    protocol,
    "export interface AuthorityApprovalFacts",
    "export interface AuthorityCheckoutEvidence"
  );
  const displayBlock = between(display, "function displayFacts", "function assertIndependentCheckout");
  assert.doesNotMatch(factsBlock, /finality/i);
  assert.doesNotMatch(displayBlock, /finality/i);
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source block ${start} is unavailable`);
  return source.slice(from, to);
}

function paymentRequiredWire(finality) {
  return {
    x402Version: 2,
    resource: { url: RESOURCE_URL, mimeType: "application/octet-stream" },
    accepts: [
      {
        scheme: "exact",
        network: "kaspa:testnet-10",
        amount: "60",
        asset: "KAS",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v1",
          finality,
          templateId: "kaspa-x402-kip10-additive-v1",
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          borrowOutpoint: { txid: "44".repeat(32), index: 0 },
          borrowAmount: "100000000",
          borrowScriptPublicKey: "000051",
          borrowRedeemScript: "51",
          additiveThresholdSompi: "10",
          paymentOutputIndex: 1,
          reservationId: "55".repeat(32),
          reservationExpiresAt: "2099-01-01T00:00:00.000Z",
          assetKind: "native",
          assetDecimals: 8,
        },
      },
    ],
    extensions: {},
  };
}

function classifyProvisionalRecovery() {
  const detailDigest = evidenceDigest("provisional-rpc-detail");
  const envelope = Object.freeze({
    staging: Object.freeze({
      outpoint: STAGING_OUTPOINT,
      amountAtomic: "70",
      scriptPublicKey: STAGING_SCRIPT,
      blockDaaScore: "100",
    }),
    exactPayment: Object.freeze({
      transactionId: EXACT_TXID,
      transactionArtifactDigest: evidenceDigest("exact-artifact"),
      inputOutpoint: STAGING_OUTPOINT,
      outputOutpoint: `${EXACT_TXID}:1`,
      outputIndex: 1,
      outputAddress: PAY_TO,
      outputAmountAtomic: "60",
      outputScriptPublicKey: "000052",
    }),
    recovery: Object.freeze({
      transactionId: RECOVERY_TXID,
      transactionArtifactDigest: evidenceDigest("recovery-artifact"),
      outputOutpoint: `${RECOVERY_TXID}:0`,
      outputIndex: 0,
      outputAddress: "kaspatest:recovery",
      outputAmountAtomic: "67",
      outputScriptPublicKey: "000053",
    }),
  });
  const raw = Object.freeze({
    staging: Object.freeze({
      status: "unspent",
      outpoint: STAGING_OUTPOINT,
      amountAtomic: "70",
      scriptPublicKey: STAGING_SCRIPT,
      blockDaaScore: "100",
      detailDigest,
    }),
    exactPayment: Object.freeze({ status: "absent", detailDigest }),
    recovery: Object.freeze({
      status: "observed",
      transactionId: RECOVERY_TXID,
      inputOutpoint: STAGING_OUTPOINT,
      outputOutpoint: `${RECOVERY_TXID}:0`,
      outputAmountAtomic: "67",
      outputScriptPublicKey: "000053",
      finality: "mempool",
      detailDigest,
    }),
  });
  const classifier = AbandonedStagingRecovery.prototype.classifyObservation;
  assert.equal(typeof classifier, "function");
  return classifier.call(
    Object.create(AbandonedStagingRecovery.prototype),
    envelope,
    evidenceDigest("prepared-recovery"),
    raw
  );
}

function exerciseJournalRelease(preparedRecovery, observation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-finality-poc-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  let journal;
  try {
    journal = new PurchaseJournal(filename, {
      now: () => NOW,
      evidenceDirectory,
    });
    authorizePurchase(journal);
    const policy = journal.installPolicy({
      maxPerPaymentAtomic: "1000",
      maxPerHourAtomic: "10000",
      approvalAboveAtomic: "1000",
      allowlist: [PAY_TO],
    });
    const authorization = journal.requireAuthorization(PURCHASE_ID);
    const reservation = journal.reservePolicy({
      id: "poc-reservation-30",
      purchaseId: PURCHASE_ID,
      policyDigest: policy.digest,
      payee: PAY_TO,
      amountAtomic: "60",
      additionalCostCeilingAtomic: "10",
      fundingSource: "vault-treasury",
      expiresAtMs: NOW + 60_000,
      approvalEvidenceDigest: authorization.evidenceDigest,
      approvalVerificationProfile: authorization.verificationProfile,
      approvalVerifierId: authorization.verifierId,
    });
    const paymentIdentifier = createPaymentIdentifier(PURCHASE_ID, 1);
    journal.createPaymentAttempt({ purchaseId: PURCHASE_ID, attempt: 1, identifier: paymentIdentifier });
    observeMerchantAuthorization(journal, paymentIdentifier);

    const stagingBytes = Buffer.from("treasury-staging-30", "utf8");
    const stagingPlan = journal.planTreasuryStaging({
      purchaseId: PURCHASE_ID,
      attempt: 1,
      reservationId: reservation.id,
      idempotencyKey: `treasury-staging:${paymentIdentifier}`,
      payloadDigest: evidenceDigest(stagingBytes),
      preparedBytes: stagingBytes,
      plannedTransactionId: STAGING_TXID,
      expectedOutpoint: STAGING_OUTPOINT,
      stagingAmountAtomic: "70",
      fundingSource: "vault-treasury",
    });
    journal.transitionPurchase(
      PURCHASE_ID,
      "authorised",
      "execution_prepared",
      "treasury_staging_prepared"
    );
    const stagingClaim = journal.beginTreasuryStaging(
      stagingPlan.effectId,
      reservation.id,
      "poc-staging-holder",
      60_000
    );
    assert.ok(stagingClaim);
    const stagingObservationDigest = verifiedLinkedEvidence(
      journal,
      "staging-observation-30",
      TREASURY_STAGING_EVIDENCE_KIND,
      1
    );
    journal.recordObservedTreasuryStaging(stagingClaim.lease, {
      effectId: stagingPlan.effectId,
      reservationId: reservation.id,
      transactionId: STAGING_TXID,
      outpoint: STAGING_OUTPOINT,
      stagingAmountAtomic: "70",
      fundingSource: "vault-treasury",
      evidenceDigest: stagingObservationDigest,
      evidenceVerificationProfile: "poc-v1",
      evidenceVerifierId: "poc-verifier",
    });
    journal.transitionPurchase(
      PURCHASE_ID,
      "execution_prepared",
      "failed_recoverable",
      "staging_requires_recovery"
    );

    const recoveryPlan = journal.planTreasuryStagingRecovery({
      purchaseId: PURCHASE_ID,
      attempt: 1,
      reservationId: reservation.id,
      stagingEffectId: stagingPlan.effectId,
      idempotencyKey: `treasury-staging-recovery:${paymentIdentifier}`,
      payloadDigest: preparedRecovery.preparedDigest,
      preparedBytes: preparedRecovery.preparedBytes,
      recoveryTransactionId: preparedRecovery.recoveryTransactionId,
      recoveryOutpoint: preparedRecovery.recoveryOutpoint,
      recoveryAmountAtomic: preparedRecovery.recoveryAmountAtomic,
      stagingFeeAtomic: preparedRecovery.stagingFeeAtomic,
      recoveryFeeAtomic: preparedRecovery.recoveryFeeAtomic,
      requiredFinality: preparedRecovery.requiredFinality,
      authorizedAdditionalCostCeilingAtomic: "10",
    });
    const recoveryClaim = journal.beginTreasuryStagingRecovery(
      recoveryPlan.effectId,
      "poc-recovery-holder",
      60_000
    );
    assert.ok(recoveryClaim);

    const before = journal.treasuryStagingRecoveryJournalContext(PURCHASE_ID, 1);
    assert.ok(before);
    const beforeCapacity = journal.treasuryPolicyCapacityUsed();
    assert.equal(before.reservation.state, "in_flight");
    assert.equal(beforeCapacity, 70n);

    journal.recordTreasuryStagingRecoveryObservation(
      recoveryPlan.effectId,
      recoveryClaim.lease,
      {
        status: "recovery_won",
        evidenceDigest: observation.evidenceDigest,
        winningTransactionId: observation.transactionId,
        winningFinality: observation.finality,
        recoveryOutpoint: observation.recoveryOutpoint,
        recoveryAmountAtomic: observation.recoveryAmountAtomic,
      }
    );

    const after = journal.treasuryStagingRecoveryJournalContext(PURCHASE_ID, 1);
    assert.ok(after?.accounting);
    const afterCapacity = journal.treasuryPolicyCapacityUsed();
    const purchaseState = journal.requirePurchase(PURCHASE_ID).state;
    assert.equal(after.reservation.state, "released");
    assert.equal(after.accounting.finality, "mempool");
    assert.equal(after.effect.state, "observed");
    assert.equal(after.attempt.state, "failed");
    assert.equal(afterCapacity, 5n);
    assert.equal(purchaseState, "failed_terminal");
    journal.integrityCheck();

    journal.close();
    journal = undefined;
    journal = new PurchaseJournal(filename, {
      now: () => NOW,
      evidenceDirectory,
    });
    const reopened = journal.treasuryStagingRecoveryJournalContext(PURCHASE_ID, 1);
    assert.ok(reopened?.accounting);
    assert.equal(reopened.reservation.state, "released");
    assert.equal(reopened.accounting.finality, "mempool");

    return Object.freeze({
      beforeState: before.reservation.state,
      beforeCapacity,
      afterState: after.reservation.state,
      afterCapacity,
      purchaseState,
      releasedCapacity: beforeCapacity - afterCapacity,
    });
  } finally {
    journal?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function authorizePurchase(journal) {
  const resource = { url: RESOURCE_URL, method: "GET" };
  journal.createPurchase({
    id: PURCHASE_ID,
    requestKey: assertPurchaseRequestKey("poc:purchase:30"),
    resourceUrl: resource.url,
    method: resource.method,
    resourceFingerprint: requestFingerprint(resource),
    expectedMerchantId: "merchant:test",
    expectedMerchantOrigin: "https://merchant.example",
  });
  const checkoutDigest = verifiedLinkedEvidence(
    journal,
    "checkout-30",
    "checkout-terms",
    undefined,
    "poc-v1",
    "merchant:test"
  );
  const requirementsDigest = verifiedLinkedEvidence(
    journal,
    paymentBytes,
    "payment-requirements",
    undefined,
    "poc-v1",
    "merchant:test"
  );
  journal.bindCheckoutTerms(PURCHASE_ID, {
    terms: { ...terms, checkoutDigest },
    checkoutEvidenceDigest: checkoutDigest,
    checkoutVerificationProfile: "poc-v1",
    checkoutVerifierId: "poc-verifier",
    paymentRequirementsDigest: requirementsDigest,
    paymentRequirementsVerificationProfile: "poc-v1",
    paymentRequirementsVerifierId: "poc-verifier",
  });
  const requestDigest = verifiedLinkedEvidence(
    journal,
    "authorization-request-30",
    "authorization-request"
  );
  const body = new Uint8Array();
  journal.storeEvidence(PURCHASE_ID, {
    bytes: body,
    mediaType: "application/octet-stream",
    profile: "urn:sompi:purchase-request-body:1",
    kind: "purchase-request-body",
  });
  const nonceDigest = evidenceDigest("authorization-nonce-30");
  journal.recordAuthorizationRequest(PURCHASE_ID, {
    checkoutDigest,
    requestDigest,
    nonceDigest,
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(body),
    additionalCostCeilingAtomic: "10",
    expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  const evidence = verifiedLinkedEvidence(
    journal,
    "authorization-30",
    "purchase-authorization"
  );
  const purchase = journal.requirePurchase(PURCHASE_ID);
  const storedTerms = journal.requireCheckoutTerms(PURCHASE_ID);
  const request = journal.requireAuthorizationRequest(PURCHASE_ID);
  journal.recordAuthorizationDecision(PURCHASE_ID, {
    decision: "approved",
    authorityId: "authority:test",
    checkoutDigest,
    approvedFactsDigest: authorizationFactsDigest({
      purchaseId: PURCHASE_ID,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      requestMediaType: request.requestMediaType,
      requestBodyDigest: request.requestBodyDigest,
      terms: storedTerms,
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
}

function observeMerchantAuthorization(journal, paymentIdentifier) {
  const bytes = Buffer.from(`merchant-authorization:${paymentIdentifier}`, "utf8");
  const effect = journal.planEffect({
    purchaseId: PURCHASE_ID,
    kind: "merchant-authorization",
    idempotencyKey: `merchant-authorization:${paymentIdentifier}`,
    payloadDigest: evidenceDigest(bytes),
    preparedBytes: bytes,
  });
  const claim = journal.claimEffect(effect.id, "poc-merchant-authorization", 60_000);
  assert.ok(claim);
  const digest = verifiedLinkedEvidence(
    journal,
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
  value,
  kind,
  attempt,
  profile = "poc-v1",
  issuer = "poc-issuer"
) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Uint8Array.from(value);
  const artifact = journal.storeEvidence(PURCHASE_ID, {
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
