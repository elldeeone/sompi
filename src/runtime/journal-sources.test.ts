import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  AP2_HUMAN_PRESENT_PROFILE,
  issueCheckoutReceipt,
  issueMerchantCheckout,
  issuePaymentReceipt,
  verifyMerchantCheckout,
  type VerifiedMerchantCheckout,
} from "../adapters/ap2/index.js";
import {
  FIXED_AUDIENCE,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_MERCHANT_ISSUER,
  FIXED_NOW,
  MERCHANT_RECEIPT_SIGNER,
  MERCHANT_SIGNER,
  PAYMENT_RECEIPT_SIGNER,
  fixedMerchantClaims,
  fixedTrustStore,
  fixedVerifiedCheckout,
  fixedVerifiedMandates,
} from "../adapters/ap2/test-fixtures.js";
import {
  Ap2PaidResponseVerifier,
  SOMPI_CHECKOUT_RECEIPT_HEADER,
  SOMPI_PAYMENT_RECEIPT_HEADER,
} from "../adapters/ap2/paid-response-verifier.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  evidenceDigest,
} from "../purchase/identity.js";
import {
  authorizationFacts,
  authorizationFactsDigest as canonicalAuthorizationFactsDigest,
} from "../purchase/contracts.js";
import {
  PurchaseCoordinator,
  type AuthorityModule,
  type CheckoutTermsModule,
  type CommerceAuthorizationModule,
  type FulfilmentModule,
  type KaspaPaymentModule,
  type SettlementResult,
  type TreasuryModule,
  type VerifiedArtifact,
} from "../purchase/coordinator.js";
import type { PaidResourceResponse } from "../purchase/paid-resource-response.js";
import { EgressPolicy } from "../purchase/egress-policy.js";
import { PurchaseJournal } from "../purchase/journal.js";
import type { Sha256Digest } from "../purchase/types.js";
import {
  JournalAp2CommerceEvidenceSource,
  JournalSourceError,
} from "./journal-sources.js";

const NOW_MS = (FIXED_NOW + 20) * 1000;
const POST_EXPIRY_MS = (FIXED_NOW + 360) * 1000;
const TRANSACTION_ID = "44".repeat(32);
const CHECKOUT_KIND = "checkout-terms";
const PAYMENT_REQUIREMENTS_KIND = "payment-requirements";
const AUTHORIZATION_REQUEST_KIND = "authorization-request";
const REQUEST_BODY_KIND = "purchase-request-body";
const AUTHORIZATION_KIND = "purchase-authorization";
const SUPPORT_KIND = "authorization-supporting-evidence";
const CHECKOUT_MEDIA_TYPE = "application/jwt";
const MANDATE_MEDIA_TYPE = "application/sd-jwt";
const PAYMENT_REQUIREMENTS_PROFILE = "kaspa-x402-alpha.6-exact-test";
const AUTHORIZATION_PROFILE = "sompi-ap2-authority-decision-test";
const VERIFIER_ID = "journal-source-test-verifier";

test("journal AP2 source reconstructs and re-verifies exact signed Checkout and mandate bytes", async () => {
  const fixture = await createFixture();
  try {
    // Reopen first to prove reconstruction uses durable evidence, not setup objects.
    fixture.journal.close();
    fixture.journal = openJournal(fixture);
    const source = sourceFor(fixture.journal);
    const loaded = await source.load(fixture.checkout.purchaseId);

    assert.ok(loaded);
    assert.equal(loaded.checkout.artifact, fixture.checkout.artifact);
    assert.equal(loaded.checkout.checkoutDigest, fixture.checkout.checkoutDigest);
    assert.equal(loaded.checkout.purchaseId, fixture.checkout.purchaseId);
    assert.equal(
      loaded.checkout.paymentRequirementsDigest,
      fixture.checkout.paymentRequirementsDigest
    );
    assert.equal(loaded.authorizationEvidenceDigest, fixture.authorizationEvidenceDigest);
    assert.deepEqual(
      new Set([
        loaded.mandates.checkout.artifact,
        loaded.mandates.payment.artifact,
      ]),
      new Set([
        fixture.mandates.checkout.artifact,
        fixture.mandates.payment.artifact,
      ])
    );
    assert.equal(
      loaded.mandates.checkout.content.checkout_jwt,
      fixture.checkout.artifact
    );
    assert.equal(
      loaded.mandates.payment.content.transaction_id,
      fixture.checkout.checkoutHash
    );
    assert.equal(Object.isFrozen(loaded), true);
  } finally {
    fixture.dispose();
  }
});

test("expired AP2 evidence remains historical evidence but cannot start new payment execution", async () => {
  const fixture = await createFixture();
  const unexpectedCalls: string[] = [];
  const unexpected = (name: string) => async (..._args: unknown[]): Promise<never> => {
    unexpectedCalls.push(name);
    throw new Error(`unexpected post-expiry ${name} call`);
  };
  try {
    fixture.journal.close();
    fixture.journal = openJournal(fixture, POST_EXPIRY_MS);

    await assert.rejects(
      verifyMerchantCheckout(fixture.checkout.artifact, {
        trust: fixedTrustStore(),
        expectedIssuer: FIXED_MERCHANT_ISSUER,
        expectedAudience: FIXED_AUTHORITY_ISSUER,
        expectedPurchaseId: fixture.checkout.purchaseId,
        expectedResourceFingerprint: fixture.checkout.terms.resourceFingerprint,
        expectedPaymentRequirementsDigest: fixture.checkout.paymentRequirementsDigest,
        nowSec: Math.floor(POST_EXPIRY_MS / 1_000),
        clockSkewSec: 0,
      })
    );
    assert.ok(await sourceFor(fixture.journal, POST_EXPIRY_MS).load(
      fixture.checkout.purchaseId
    ));

    const coordinator = new PurchaseCoordinator(
      fixture.journal,
      new EgressPolicy({
        allowRules: [{ hostname: "merchant.example", ports: [443] }],
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
        now: () => POST_EXPIRY_MS,
      }),
      { discover: unexpected("Checkout discovery") } as CheckoutTermsModule,
      { request: unexpected("authority") } as AuthorityModule,
      {
        present: unexpected("Merchant authorization presentation"),
        observe: unexpected("Merchant authorization observation"),
      } as CommerceAuthorizationModule,
      {
        currentPolicy: unexpected("Treasury policy"),
        quote: unexpected("Treasury quote"),
      } as TreasuryModule,
      {
        prepareStaging: unexpected("Treasury staging preparation/signing"),
        submitStaging: unexpected("Treasury staging submission"),
        observeStaging: unexpected("Treasury staging observation"),
        prepare: unexpected("exact payment preparation/signing"),
        submit: unexpected("exact payment submission"),
        observe: unexpected("exact payment observation"),
      } as KaspaPaymentModule,
      {
        prepare: unexpected("staging recovery preparation"),
        observe: unexpected("staging recovery observation"),
        submit: unexpected("staging recovery submission"),
      },
      { obtain: unexpected("Fulfilment") } as FulfilmentModule,
      {
        now: () => POST_EXPIRY_MS,
        workerId: "historical-evidence-expiry-test",
      }
    );
    const recovered = await coordinator.recover(fixture.checkout.purchaseId);
    assert.equal(recovered.state, "expired");
    assert.deepEqual(unexpectedCalls, []);
    assert.equal(fixture.journal.paymentAttempts(fixture.checkout.purchaseId).length, 0);
    assert.equal(fixture.journal.effectsForPurchase(fixture.checkout.purchaseId).length, 0);
  } finally {
    fixture.dispose();
  }
});

test("Settlement, Fulfilment, and Receipt verification recover after Checkout expiry", async () => {
  const fixture = await createFixture();
  try {
    fixture.journal.close();
    fixture.journal = openJournal(fixture, POST_EXPIRY_MS);
    const input = await postExpiryPaidResponse(fixture);
    const verifier = new Ap2PaidResponseVerifier({
      evidenceSource: sourceFor(fixture.journal, POST_EXPIRY_MS),
      trust: fixedTrustStore(),
      expectedMerchantReceiptIssuer: MERCHANT_RECEIPT_SIGNER.issuer,
      expectedPaymentReceiptIssuer: PAYMENT_RECEIPT_SIGNER.issuer,
      now: () => POST_EXPIRY_MS,
    });

    const recovered = await verifier.verify(input);
    assert.ok(recovered);
    assert.equal(recovered.status, "fulfilled");
    assert.equal(Buffer.from(recovered.body).toString("utf8"), "fixed-resource");
    assert.deepEqual(recovered.receipts.map((receipt) => receipt.role), [
      "merchant",
      "payment",
    ]);
    for (const receipt of recovered.receipts) {
      assert.equal(receipt.checkoutDigest, fixture.checkout.checkoutDigest);
      assert.equal(
        receipt.authorizationEvidenceDigest,
        fixture.authorizationEvidenceDigest
      );
      assert.equal(
        receipt.settlementEvidenceDigest,
        input.settlement.evidence.declaredDigest
      );
      assert.equal(receipt.fulfilmentDigest, evidenceDigest("fixed-resource"));
    }
  } finally {
    fixture.dispose();
  }
});

test("journal AP2 source returns no authority for missing or denied durable decisions", async () => {
  const noAuthorization = await createFixture({ authorization: "none", support: "none" });
  const denied = await createFixture({ authorization: "denied", support: "none" });
  const empty = emptyJournal();
  try {
    assert.equal(
      await sourceFor(noAuthorization.journal).load(noAuthorization.checkout.purchaseId),
      undefined
    );
    assert.equal(
      await sourceFor(denied.journal).load(denied.checkout.purchaseId),
      undefined
    );
    assert.equal(
      await sourceFor(empty.journal).load(noAuthorization.checkout.purchaseId),
      undefined
    );
  } finally {
    noAuthorization.dispose();
    denied.dispose();
    empty.dispose();
  }
});

test("journal AP2 source fails closed when either signed mandate is missing", async () => {
  const missingCheckout = await createFixture({ support: "payment-only" });
  const missingPayment = await createFixture({ support: "checkout-only" });
  try {
    await assert.rejects(
      sourceFor(missingCheckout.journal).load(missingCheckout.checkout.purchaseId),
      (error: unknown) =>
        error instanceof JournalSourceError &&
        /mandates are incomplete/.test(error.message)
    );
    await assert.rejects(
      sourceFor(missingPayment.journal).load(missingPayment.checkout.purchaseId),
      (error: unknown) =>
        error instanceof JournalSourceError &&
        /mandates are incomplete/.test(error.message)
    );
  } finally {
    missingCheckout.dispose();
    missingPayment.dispose();
  }
});

test("journal AP2 source rejects a different real signed mandate ceremony", async () => {
  const canonicalCheckout = await fixedVerifiedCheckout();
  const substitutedClaims = {
    ...fixedMerchantClaims(),
    jti: "checkout:test:substituted-ceremony",
  };
  const substitutedArtifact = await issueMerchantCheckout(
    substitutedClaims,
    MERCHANT_SIGNER,
    { nowSec: FIXED_NOW }
  );
  const substitutedCheckout = await verifyMerchantCheckout(substitutedArtifact, {
    trust: fixedTrustStore(),
    expectedIssuer: FIXED_MERCHANT_ISSUER,
    expectedAudience: FIXED_AUDIENCE,
    expectedPurchaseId: canonicalCheckout.purchaseId,
    expectedResourceFingerprint: canonicalCheckout.terms.resourceFingerprint,
    expectedPaymentRequirementsDigest: canonicalCheckout.paymentRequirementsDigest,
    nowSec: FIXED_NOW + 1,
  });
  assert.notEqual(substitutedCheckout.artifact, canonicalCheckout.artifact);
  const substitutedMandates = await fixedVerifiedMandates(substitutedCheckout);
  const fixture = await createFixture({
    checkout: canonicalCheckout,
    supportArtifacts: {
      checkoutMandate: substitutedMandates.checkout.artifact,
      paymentMandate: substitutedMandates.payment.artifact,
    },
  });
  try {
    await assert.rejects(
      sourceFor(fixture.journal).load(fixture.checkout.purchaseId),
      (error: unknown) =>
        error instanceof JournalSourceError &&
        /does not verify uniquely/.test(error.message)
    );
  } finally {
    fixture.dispose();
  }
});

test("journal AP2 source rejects content-address tampering and wrong instrument trust", async () => {
  const tampered = await createFixture();
  const tamperedAuthorization = await createFixture();
  const wrongInstrument = await createFixture();
  try {
    const checkoutAttachment = tampered.journal.requireEvidenceAttachment(
      tampered.checkout.purchaseId,
      tampered.checkout.checkoutDigest,
      CHECKOUT_KIND
    );
    const checkoutPath = path.join(
      tampered.evidenceDirectory,
      checkoutAttachment.storageRef
    );
    fs.writeFileSync(
      checkoutPath,
      Buffer.from(tamperCompact(tampered.checkout.artifact), "ascii")
    );
    await assert.rejects(
      sourceFor(tampered.journal).load(tampered.checkout.purchaseId)
    );

    const authorizationAttachment =
      tamperedAuthorization.journal.requireEvidenceAttachment(
        tamperedAuthorization.checkout.purchaseId,
        tamperedAuthorization.authorizationEvidenceDigest,
        AUTHORIZATION_KIND
      );
    fs.writeFileSync(
      path.join(
        tamperedAuthorization.evidenceDirectory,
        authorizationAttachment.storageRef
      ),
      Buffer.from("tampered-authority-decision", "utf8")
    );
    await assert.rejects(
      sourceFor(tamperedAuthorization.journal).load(
        tamperedAuthorization.checkout.purchaseId
      )
    );

    const source = new JournalAp2CommerceEvidenceSource({
      journal: wrongInstrument.journal,
      trust: fixedTrustStore(),
      expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
      expectedInstrumentId: "instrument:testnet:substituted",
      now: () => NOW_MS,
    });
    await assert.rejects(
      source.load(wrongInstrument.checkout.purchaseId),
      (error: unknown) =>
        error instanceof JournalSourceError &&
        /does not verify uniquely/.test(error.message)
    );
  } finally {
    tampered.dispose();
    tamperedAuthorization.dispose();
    wrongInstrument.dispose();
  }
});

type SupportMode = "both" | "checkout-only" | "payment-only" | "none";

interface CreateFixtureOptions {
  readonly checkout?: VerifiedMerchantCheckout;
  readonly authorization?: "approved" | "denied" | "none";
  readonly support?: SupportMode;
  readonly supportArtifacts?: {
    readonly checkoutMandate: string;
    readonly paymentMandate: string;
  };
}

interface JournalFixture {
  journal: PurchaseJournal;
  readonly directory: string;
  readonly filename: string;
  readonly evidenceDirectory: string;
  readonly checkout: VerifiedMerchantCheckout;
  readonly mandates: Awaited<ReturnType<typeof fixedVerifiedMandates>>;
  readonly authorizationEvidenceDigest: Sha256Digest;
  dispose(): void;
}

async function createFixture(
  options: CreateFixtureOptions = {}
): Promise<JournalFixture> {
  const checkout = options.checkout ?? await fixedVerifiedCheckout();
  const mandates = await fixedVerifiedMandates(checkout);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-source-"));
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const fixture = {
    journal: new PurchaseJournal(filename, {
      now: () => NOW_MS,
      evidenceDirectory,
    }),
    directory,
    filename,
    evidenceDirectory,
    checkout,
    mandates,
    authorizationEvidenceDigest: evidenceDigest("unset"),
    dispose() {
      try {
        fixture.journal.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  } satisfies JournalFixture;

  const journal = fixture.journal;
  journal.createPurchase({
    id: checkout.purchaseId,
    requestKey: assertPurchaseRequestKey("journal-source:test"),
    resourceUrl: checkout.resourceUrl,
    method: checkout.method,
    resourceFingerprint: checkout.terms.resourceFingerprint,
    expectedMerchantId: checkout.terms.merchant.id,
    expectedMerchantOrigin: checkout.terms.merchant.origin,
  });

  const checkoutEvidence = verifiedEvidence(journal, checkout.purchaseId, {
    bytes: Buffer.from(checkout.artifact, "ascii"),
    mediaType: CHECKOUT_MEDIA_TYPE,
    profile: checkout.profile,
    issuer: checkout.terms.merchant.id,
    kind: CHECKOUT_KIND,
  });
  const paymentRequirements = verifiedEvidence(journal, checkout.purchaseId, {
    bytes: Buffer.from("fixed-payment-requirements", "utf8"),
    mediaType: "application/octet-stream",
    profile: PAYMENT_REQUIREMENTS_PROFILE,
    issuer: checkout.terms.merchant.id,
    kind: PAYMENT_REQUIREMENTS_KIND,
  });
  assert.equal(checkoutEvidence, checkout.checkoutDigest);
  assert.equal(paymentRequirements, checkout.paymentRequirementsDigest);
  journal.bindCheckoutTerms(checkout.purchaseId, {
    terms: checkout.terms,
    checkoutEvidenceDigest: checkoutEvidence,
    checkoutVerificationProfile: checkout.profile,
    checkoutVerifierId: VERIFIER_ID,
    paymentRequirementsDigest: paymentRequirements,
    paymentRequirementsVerificationProfile: PAYMENT_REQUIREMENTS_PROFILE,
    paymentRequirementsVerifierId: VERIFIER_ID,
  });

  const requestBytes = Buffer.from("journal-source-authorization-request", "utf8");
  const requestDigest = storeEvidence(journal, checkout.purchaseId, {
    bytes: requestBytes,
    mediaType: "application/json",
    profile: "urn:sompi:authorization-request:test",
    issuer: FIXED_AUTHORITY_ISSUER,
    kind: AUTHORIZATION_REQUEST_KIND,
  });
  const requestBodyDigest = storeEvidence(journal, checkout.purchaseId, {
    bytes: new Uint8Array(),
    mediaType: "application/octet-stream",
    profile: "urn:sompi:purchase-request-body:1",
    kind: REQUEST_BODY_KIND,
  });
  const nonceDigest = evidenceDigest("journal-source-nonce");
  const expiresAtMs = Date.parse(checkout.terms.expiresAt);
  journal.recordAuthorizationRequest(checkout.purchaseId, {
    checkoutDigest: checkout.checkoutDigest,
    requestDigest,
    nonceDigest,
    requestMediaType: "",
    requestBodyDigest,
    additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
    effectiveFinalityFloor: "accepted",
    expiresAtMs,
  });

  const decisionBytes = Buffer.from("journal-source-authority-decision", "utf8");
  const authorizationEvidenceDigest = verifiedEvidence(journal, checkout.purchaseId, {
    bytes: decisionBytes,
    mediaType: "application/jwt",
    profile: AUTHORIZATION_PROFILE,
    issuer: FIXED_AUTHORITY_ISSUER,
    kind: AUTHORIZATION_KIND,
  });
  fixture.authorizationEvidenceDigest = authorizationEvidenceDigest;
  const authorizationRequest = {
    purchaseId: checkout.purchaseId,
    resourceUrl: checkout.resourceUrl,
    method: checkout.method,
    requestMediaType: "",
    requestBodyDigest,
    terms: checkout.terms,
    requestDigest,
    nonceDigest,
    additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
    effectiveFinalityFloor: "accepted" as const,
    createdAtMs: journal.requireAuthorizationRequest(checkout.purchaseId).createdAtMs,
    expiresAtMs,
  };
  if (options.authorization !== "none") {
    journal.recordAuthorizationDecision(checkout.purchaseId, {
      decision: options.authorization ?? "approved",
      authorityId: FIXED_AUTHORITY_ISSUER,
      checkoutDigest: checkout.checkoutDigest,
      approvedFactsDigest: canonicalAuthorizationFactsDigest(authorizationRequest),
      evidenceDigest: authorizationEvidenceDigest,
      verificationProfile: AUTHORIZATION_PROFILE,
      verifierId: VERIFIER_ID,
      requestDigest,
      nonceDigest,
      expiresAtMs,
    });
  }

  const support = options.support ?? "both";
  const supportArtifacts = options.supportArtifacts ?? {
    checkoutMandate: mandates.checkout.artifact,
    paymentMandate: mandates.payment.artifact,
  };
  if (support === "both" || support === "checkout-only") {
    verifiedEvidence(journal, checkout.purchaseId, {
      bytes: Buffer.from(supportArtifacts.checkoutMandate, "ascii"),
      mediaType: MANDATE_MEDIA_TYPE,
      profile: AP2_HUMAN_PRESENT_PROFILE,
      issuer: FIXED_AUTHORITY_ISSUER,
      kind: SUPPORT_KIND,
    });
  }
  if (support === "both" || support === "payment-only") {
    verifiedEvidence(journal, checkout.purchaseId, {
      bytes: Buffer.from(supportArtifacts.paymentMandate, "ascii"),
      mediaType: MANDATE_MEDIA_TYPE,
      profile: AP2_HUMAN_PRESENT_PROFILE,
      issuer: FIXED_AUTHORITY_ISSUER,
      kind: SUPPORT_KIND,
    });
  }
  return fixture;
}

function sourceFor(
  journal: PurchaseJournal,
  nowMs: number = NOW_MS
): JournalAp2CommerceEvidenceSource {
  return new JournalAp2CommerceEvidenceSource({
    journal,
    trust: fixedTrustStore(),
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    now: () => nowMs,
  });
}

function openJournal(
  fixture: JournalFixture,
  nowMs: number = NOW_MS
): PurchaseJournal {
  return new PurchaseJournal(fixture.filename, {
    now: () => nowMs,
    evidenceDirectory: fixture.evidenceDirectory,
  });
}

function emptyJournal(): {
  journal: PurchaseJournal;
  dispose(): void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-source-empty-"));
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: () => NOW_MS,
    evidenceDirectory: path.join(directory, "evidence"),
  });
  return {
    journal,
    dispose() {
      journal.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function verifiedEvidence(
  journal: PurchaseJournal,
  purchaseId: VerifiedMerchantCheckout["purchaseId"],
  input: {
    bytes: Uint8Array;
    mediaType: string;
    profile: string;
    issuer?: string;
    kind: string;
  }
): Sha256Digest {
  const digest = storeEvidence(journal, purchaseId, input);
  journal.recordEvidenceVerification(digest, {
    verifierId: VERIFIER_ID,
    profile: input.profile,
    detailDigest: evidenceDigest(`verified:${digest}`),
  });
  return digest;
}

function storeEvidence(
  journal: PurchaseJournal,
  purchaseId: VerifiedMerchantCheckout["purchaseId"],
  input: {
    bytes: Uint8Array;
    mediaType: string;
    profile: string;
    issuer?: string;
    kind: string;
  }
): Sha256Digest {
  return journal.storeEvidence(purchaseId, input).digest;
}

async function postExpiryPaidResponse(
  fixture: JournalFixture
): Promise<PaidResourceResponse> {
  const paymentIdentifier = createPaymentIdentifier(fixture.checkout.purchaseId, 1);
  const [checkoutReceipt, paymentReceipt] = await Promise.all([
    issueCheckoutReceipt({
      status: "Success",
      mandate: fixture.mandates.checkout,
      orderId: fixture.checkout.purchaseId,
      issuedAtSec: FIXED_NOW + 20,
    }, MERCHANT_RECEIPT_SIGNER),
    issuePaymentReceipt({
      status: "Success",
      mandate: fixture.mandates.payment,
      paymentId: paymentIdentifier,
      pspConfirmationId: paymentIdentifier,
      networkConfirmationId: TRANSACTION_ID,
      issuedAtSec: FIXED_NOW + 20,
    }, PAYMENT_RECEIPT_SIGNER),
  ]);
  const authorizationRecord = fixture.journal.requireAuthorizationRequest(
    fixture.checkout.purchaseId
  );
  const authorizationRequest = {
    purchaseId: fixture.checkout.purchaseId,
    resourceUrl: fixture.checkout.resourceUrl,
    method: fixture.checkout.method,
    requestMediaType: authorizationRecord.requestMediaType,
    requestBodyDigest: authorizationRecord.requestBodyDigest,
    terms: fixture.checkout.terms,
    requestDigest: authorizationRecord.requestDigest,
    nonceDigest: authorizationRecord.nonceDigest,
    additionalCostCeilingAtomic:
      authorizationRecord.additionalCostCeilingAtomic,
    effectiveFinalityFloor: authorizationRecord.effectiveFinalityFloor,
    createdAtMs: authorizationRecord.createdAtMs,
    expiresAtMs: authorizationRecord.expiresAtMs,
  };
  const context: PaidResourceResponse["context"] = {
    purchaseId: fixture.checkout.purchaseId,
    terms: fixture.checkout.terms,
    authorizationRequest,
    authorization: {
      purchaseId: fixture.checkout.purchaseId,
      checkoutDigest: fixture.checkout.checkoutDigest,
      decision: "approved",
      authorityId: FIXED_AUTHORITY_ISSUER,
      evidenceDigest: fixture.authorizationEvidenceDigest,
      facts: authorizationFacts(authorizationRequest),
    },
    paymentIdentifier,
    request: {
      url: fixture.checkout.resourceUrl,
      method: fixture.checkout.method,
      requestFingerprint: fixture.checkout.terms.resourceFingerprint,
    },
    paymentRequirements: Buffer.from("fixed-payment-requirements", "utf8"),
    preparedTransactionId: TRANSACTION_ID,
  };
  const settlementEvidence = protocolArtifact(
    Buffer.from("historical-settlement", "utf8"),
    "test-exact-settlement",
    FIXED_MERCHANT_ISSUER
  );
  const settlement: SettlementResult = {
    evidence: settlementEvidence,
    transactionId: TRANSACTION_ID,
    outpoint: `${TRANSACTION_ID}:1`,
    amountAtomic: fixture.checkout.terms.amountAtomic,
    additionalCostAtomic: "1000000",
    asset: fixture.checkout.terms.asset,
    network: fixture.checkout.terms.network,
    payTo: fixture.checkout.terms.payTo,
    finality: "accepted",
    fundingSource: "vault-treasury",
  };
  return {
    context,
    status: 200,
    headers: [
      ["content-type", "application/octet-stream"],
      [SOMPI_CHECKOUT_RECEIPT_HEADER, checkoutReceipt],
      [SOMPI_PAYMENT_RECEIPT_HEADER, paymentReceipt],
    ],
    body: Buffer.from("fixed-resource", "utf8"),
    mediaType: "application/octet-stream",
    settlement,
  };
}

function protocolArtifact(
  bytes: Uint8Array,
  profile: string,
  issuer: string
): VerifiedArtifact {
  const digest = evidenceDigest(bytes);
  return {
    bytes: Uint8Array.from(bytes),
    mediaType: "application/json",
    profile,
    issuer,
    declaredDigest: digest,
    verification: {
      verifierId: `test-verifier:${profile}`,
      profile,
      detailDigest: digest,
    },
  };
}

function tamperCompact(value: string): string {
  const segments = value.split(".");
  const signature = segments[2];
  segments[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  return segments.join(".");
}
