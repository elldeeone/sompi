import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
  paymentIdentifierExtension,
  type PaymentPayload,
} from "@kaspa-x402/core";
import type {
  AddressCodec,
  ExactBorrowReservationProvider,
  ExactTransactionVerifier,
  ServerChainProvider,
  VoucherVerifier,
} from "@kaspa-x402/server";

import {
  AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE,
  issueHumanPresentMandates,
  SOMPI_MERCHANT_RECEIPT_PROFILE,
  SOMPI_PAYMENT_RECEIPT_PROFILE,
  type VerifiedMerchantCheckout,
} from "../adapters/ap2/index.js";
import {
  AUTHORITY_SIGNER,
  FIXED_AUDIENCE,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_NOW,
  MERCHANT_RECEIPT_SIGNER,
  MERCHANT_SIGNER,
  PAYMENT_RECEIPT_SIGNER,
  fixedTrustStore,
} from "../adapters/ap2/test-fixtures.js";
import {
  assertPurchaseId,
  createPaymentIdentifier,
  evidenceDigest,
} from "../purchase/identity.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { SqliteExactServerStateStore } from "./exact-server-store.js";
import { SqliteDemoCommerceAuthorizationStore } from "./commerce-authorization-store.js";
import {
  DEMO_NETWORK,
  DemoMerchantError,
  DemoMerchantFixture,
  type DemoMerchantFixtureConfig,
  type DemoMerchantOffer,
  type DemoMerchantPaidRequest,
} from "./merchant-fixture.js";

const NOW_MS = FIXED_NOW * 1000;
const PAY_TO = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
const TRANSACTION_ID = "44".repeat(32);
const BORROW_TXID = "66".repeat(32);
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const SECOND_PURCHASE_ID = assertPurchaseId("pur_AQEBAQEBAQEBAQEBAQEBAQ");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const RESOURCE_BODY = Buffer.from("deterministic paid resource\n", "utf8");

test("demo Merchant joins real AP2 Checkout, mandates, exact settlement, resource, and receipts", async () => {
  const store = new SqliteExactServerStateStore(":memory:");
  const merchant = await DemoMerchantFixture.create(config(store));
  try {
    const offer = await merchant.offer(PURCHASE_ID);
    const requiredHeader = offer.paymentRequired.headers["PAYMENT-REQUIRED"];
    const required = decodePaymentRequiredHeader(requiredHeader);
    assert.equal(offer.paymentRequired.status, 402);
    assert.equal(offer.purchaseId, PURCHASE_ID);
    assert.equal(offer.checkout.purchaseId, PURCHASE_ID);
    assert.equal(offer.checkout.terms.resourceFingerprint.startsWith("sha256:"), true);
    assert.equal(offer.checkout.terms.amountAtomic, "20000000");
    assert.equal(offer.checkout.terms.payTo, PAY_TO);
    assert.equal(offer.checkout.terms.network, DEMO_NETWORK);
    assert.equal(
      offer.paymentRequirementsDigest,
      evidenceDigest(Buffer.from(requiredHeader, "utf8"))
    );
    assert.equal(offer.checkout.paymentRequirementsDigest, offer.paymentRequirementsDigest);
    assert.equal(required.accepts.length, 1);
    assert.equal(required.accepts[0].scheme, "exact");
    assert.equal((required as Record<string, unknown>).ap2, undefined);

    const commerceEvidence = await authorise(offer.checkout);
    await presentAuthorization(merchant, offer, commerceEvidence, PAYMENT_IDENTIFIER);
    const request = paidRequest(offer, commerceEvidence, PAYMENT_IDENTIFIER);
    const decodedPayment = decodePaymentSignatureHeader(request.headers["PAYMENT-SIGNATURE"]);
    assert.deepEqual(Object.keys(decodedPayment.extensions ?? {}), ["payment-identifier"]);
    assert.equal((decodedPayment.extensions as Record<string, unknown>).ap2, undefined);

    const paid = await merchant.handlePaid(request);
    assert.equal(paid.response.status, 200);
    assert.equal(Buffer.from(paid.resource!.body).toString("utf8"), RESOURCE_BODY.toString("utf8"));
    assert.equal(paid.resource?.digest, evidenceDigest(RESOURCE_BODY));
    assert.equal(paid.settlement?.transaction, TRANSACTION_ID);
    assert.equal(paid.settlement?.network, DEMO_NETWORK);
    assert.equal(paid.ap2Receipts?.checkout.profile, SOMPI_MERCHANT_RECEIPT_PROFILE);
    assert.equal(paid.ap2Receipts?.checkout.orderId, PURCHASE_ID);
    assert.equal(
      paid.ap2Receipts?.checkout.reference,
      paid.evidence?.checkoutMandateReference
    );
    assert.equal(paid.ap2Receipts?.payment.profile, SOMPI_PAYMENT_RECEIPT_PROFILE);
    assert.equal(paid.ap2Receipts?.payment.paymentId, PAYMENT_IDENTIFIER);
    assert.equal(paid.ap2Receipts?.payment.pspConfirmationId, PAYMENT_IDENTIFIER);
    assert.equal(paid.ap2Receipts?.payment.networkConfirmationId, TRANSACTION_ID);
    assert.equal(
      paid.ap2Receipts?.payment.reference,
      paid.evidence?.paymentMandateReference
    );
    assert.equal(paid.evidence?.purchaseId, PURCHASE_ID);
    assert.equal(paid.evidence?.merchantCheckoutDigest, offer.checkout.checkoutDigest);
    assert.equal(paid.evidence?.paymentRequirementsDigest, offer.paymentRequirementsDigest);
    assert.equal(
      paid.evidence?.checkoutMandateDigest,
      evidenceDigest(commerceEvidence.checkoutMandate)
    );
    assert.equal(
      paid.evidence?.paymentMandateDigest,
      evidenceDigest(commerceEvidence.paymentMandate)
    );
    assert.equal(paid.evidence?.paymentIdentifier, PAYMENT_IDENTIFIER);
    assert.equal(paid.evidence?.transactionId, TRANSACTION_ID);
    assert.equal(paid.evidence?.paymentOutputIndex, 1);
    assert.equal(paid.evidence?.resourceDigest, paid.resource?.digest);
    assert.match(paid.evidence!.x402PaymentRequirementsHash, /^[a-f0-9]{64}$/);
    assert.match(paid.evidence!.x402PaymentPayloadHash, /^[a-f0-9]{64}$/);

    const replay = await merchant.handlePaid(request);
    assert.deepEqual(replay.response, paid.response);
    assert.deepEqual(replay.settlement, paid.settlement);
    assert.deepEqual(replay.ap2Receipts, paid.ap2Receipts);
    assert.deepEqual(replay.evidence, paid.evidence);
  } finally {
    store.close();
  }
});

test("demo Merchant rejects Checkout, Payment Requirements, and mandate substitution or replay", async () => {
  const store = new SqliteExactServerStateStore(":memory:");
  const merchant = await DemoMerchantFixture.create(config(store));
  try {
    const first = await merchant.offer(PURCHASE_ID);
    const second = await merchant.offer(SECOND_PURCHASE_ID);
    const firstEvidence = await authorise(first.checkout);
    const secondEvidence = await authorise(second.checkout);
    await presentAuthorization(merchant, first, firstEvidence, PAYMENT_IDENTIFIER);
    const secondPaymentId = createPaymentIdentifier(SECOND_PURCHASE_ID, 1);
    await presentAuthorization(merchant, second, secondEvidence, secondPaymentId);

    await assert.rejects(
      merchant.handlePaid({
        ...paidRequest(first, firstEvidence, PAYMENT_IDENTIFIER),
        merchantCheckout: tamperCompact(first.checkout.artifact),
      }),
      isDemoError("invalid_checkout")
    );

    await assert.rejects(
      merchant.handlePaid({
        ...paidRequest(first, firstEvidence, PAYMENT_IDENTIFIER),
        paymentRequiredHeader: second.paymentRequired.headers["PAYMENT-REQUIRED"],
      }),
      isDemoError("invalid_checkout")
    );

    await assert.rejects(merchant.presentPaymentMandate({
      profile: AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE,
      version: 1,
      stage: "payment",
      purchaseId: SECOND_PURCHASE_ID,
      paymentIdentifier: secondPaymentId,
      checkoutDigest: second.checkout.checkoutDigest,
      authorizationEvidenceDigest: evidenceDigest("test-authority-decision"),
      mandate: firstEvidence.paymentMandate,
      mandateDigest: evidenceDigest(firstEvidence.paymentMandate),
    }));

    await assert.rejects(
      merchant.handlePaid({
        ...paidRequest(first, secondEvidence, PAYMENT_IDENTIFIER),
        purchaseId: SECOND_PURCHASE_ID,
      }),
      isDemoError("invalid_checkout")
    );
  } finally {
    store.close();
  }
});

test("demo Merchant rejects missing and expired closed mandate evidence before fulfilment", async () => {
  const clock = { now: NOW_MS };
  const store = new SqliteExactServerStateStore(":memory:");
  const merchant = await DemoMerchantFixture.create(config(store, () => clock.now));
  try {
    const offer = await merchant.offer(PURCHASE_ID);
    const evidence = await authorise(offer.checkout, FIXED_NOW + 5);
    const base = paidRequest(offer, evidence, PAYMENT_IDENTIFIER);

    await assert.rejects(
      merchant.handlePaid(base),
      isDemoError("invalid_authorization")
    );

    await merchant.presentCheckoutMandate({
      profile: AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE,
      version: 1,
      stage: "checkout",
      purchaseId: offer.purchaseId,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      checkoutDigest: offer.checkout.checkoutDigest,
      authorizationEvidenceDigest: evidenceDigest("test-authority-decision"),
      mandate: evidence.checkoutMandate,
      mandateDigest: evidenceDigest(evidence.checkoutMandate),
    });
    await assert.rejects(
      merchant.handlePaid(base),
      isDemoError("invalid_authorization")
    );

    await merchant.presentPaymentMandate({
      profile: AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE,
      version: 1,
      stage: "payment",
      purchaseId: offer.purchaseId,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      checkoutDigest: offer.checkout.checkoutDigest,
      authorizationEvidenceDigest: evidenceDigest("test-authority-decision"),
      mandate: evidence.paymentMandate,
      mandateDigest: evidenceDigest(evidence.paymentMandate),
    });

    clock.now = (FIXED_NOW + 6) * 1000;
    await assert.rejects(
      merchant.handlePaid(base),
      isDemoError("invalid_authorization")
    );
    assert.equal(await store.loadPaymentIdentifier(PAYMENT_IDENTIFIER), undefined);
  } finally {
    store.close();
  }
});

test("demo Merchant durably replays the exact response and AP2 Receipt bytes after restart", async () => {
  const directory = fixtureDirectory();
  const filename = path.join(directory, "merchant.sqlite");
  const authorizationFilename = path.join(directory, "merchant-authorization.sqlite");
  let store = new SqliteExactServerStateStore(filename);
  let authorizationStore = new SqliteDemoCommerceAuthorizationStore(
    authorizationFilename,
    { now: () => NOW_MS }
  );
  let merchant = await DemoMerchantFixture.create(config(store, () => NOW_MS, authorizationStore));
  const offer = await merchant.offer(PURCHASE_ID);
  const commerceEvidence = await authorise(offer.checkout);
  await presentAuthorization(merchant, offer, commerceEvidence, PAYMENT_IDENTIFIER);
  const request = paidRequest(offer, commerceEvidence, PAYMENT_IDENTIFIER);
  const first = await merchant.handlePaid(request);
  store.close();
  authorizationStore.close();

  store = new SqliteExactServerStateStore(filename);
  authorizationStore = new SqliteDemoCommerceAuthorizationStore(
    authorizationFilename,
    { now: () => NOW_MS }
  );
  merchant = await DemoMerchantFixture.create(config(store, () => NOW_MS, authorizationStore));
  try {
    const recovered = await merchant.handlePaid(request);
    assert.deepEqual(recovered.response, first.response);
    assert.deepEqual(recovered.settlement, first.settlement);
    assert.equal(
      recovered.ap2Receipts?.checkout.artifact,
      first.ap2Receipts?.checkout.artifact
    );
    assert.equal(
      recovered.ap2Receipts?.payment.artifact,
      first.ap2Receipts?.payment.artifact
    );
    assert.deepEqual(recovered.evidence, first.evidence);
  } finally {
    store.close();
    authorizationStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function authorise(
  checkout: VerifiedMerchantCheckout,
  expiresAtSec = checkout.expiresAtSec
): Promise<Awaited<ReturnType<typeof issueHumanPresentMandates>>> {
  return issueHumanPresentMandates({
    checkout,
    instrumentId: FIXED_INSTRUMENT_ID,
    issuedAtSec: checkout.issuedAtSec,
    expiresAtSec,
  }, AUTHORITY_SIGNER);
}

async function presentAuthorization(
  merchant: DemoMerchantFixture,
  offer: DemoMerchantOffer,
  evidence: Awaited<ReturnType<typeof issueHumanPresentMandates>>,
  paymentIdentifier: string
): Promise<void> {
  const authorizationEvidenceDigest = evidenceDigest("test-authority-decision");
  await merchant.presentCheckoutMandate({
    profile: AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE,
    version: 1,
    stage: "checkout",
    purchaseId: offer.purchaseId,
    paymentIdentifier,
    checkoutDigest: offer.checkout.checkoutDigest,
    authorizationEvidenceDigest,
    mandate: evidence.checkoutMandate,
    mandateDigest: evidenceDigest(evidence.checkoutMandate),
  });
  await merchant.presentPaymentMandate({
    profile: AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE,
    version: 1,
    stage: "payment",
    purchaseId: offer.purchaseId,
    paymentIdentifier,
    checkoutDigest: offer.checkout.checkoutDigest,
    authorizationEvidenceDigest,
    mandate: evidence.paymentMandate,
    mandateDigest: evidenceDigest(evidence.paymentMandate),
  });
}

function paidRequest(
  offer: DemoMerchantOffer,
  _commerceEvidence: Awaited<ReturnType<typeof issueHumanPresentMandates>>,
  paymentIdentifier: string
): DemoMerchantPaidRequest {
  const accepted = decodePaymentRequiredHeader(
    offer.paymentRequired.headers["PAYMENT-REQUIRED"]
  ).accepts[0];
  const paymentHeader = encodePaymentSignatureHeader(
    paymentPayload(accepted, requestHashHex(offer.checkout.terms.resourceFingerprint), paymentIdentifier)
  );
  return {
    purchaseId: offer.purchaseId,
    merchantCheckout: offer.checkout.artifact,
    paymentRequiredHeader: offer.paymentRequired.headers["PAYMENT-REQUIRED"],
    paymentIdentifier,
    headers: { "PAYMENT-SIGNATURE": paymentHeader },
  };
}

function paymentPayload(
  accepted: PaymentPayload["accepted"],
  requestHash: string,
  paymentIdentifier: string
): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: {
      type: "exact-transaction",
      transaction: "prepared-exact-transaction",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 1,
      requestHash,
    },
    extensions: {
      "payment-identifier": paymentIdentifierExtension({
        required: true,
        id: paymentIdentifier,
      }),
    },
  };
}

function config(
  store: SqliteExactServerStateStore,
  now: () => number = () => NOW_MS,
  authorizationStore = new SqliteDemoCommerceAuthorizationStore(":memory:", { now })
): DemoMerchantFixtureConfig {
  const addressCodec: AddressCodec = {
    scriptPublicKeyForAddress: () => "000051",
    encodeScriptAddress: () => PAY_TO,
  };
  let reservationSequence = 0;
  const exactReservationProvider: ExactBorrowReservationProvider = {
    reserveExactPayment: () => ({
      reservationId: (++reservationSequence).toString(16).padStart(64, "0"),
      templateId: "kaspa-x402-kip10-additive-v1",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      borrowOutpoint: { txid: BORROW_TXID, index: 0 },
      borrowAmount: "30000000",
      borrowScriptPublicKey: "000051",
      borrowRedeemScript: "51",
      additiveThresholdSompi: "10000000",
      paymentOutputIndex: 1,
      expiresAt: new Date((FIXED_NOW + 240) * 1000).toISOString(),
    }),
  };
  const exactTransactionVerifier: ExactTransactionVerifier = {
    verifyExactPayment: (request) => ({
      transactionId: TRANSACTION_ID,
      paymentOutput: {
        amount: request.amount,
        scriptPublicKey: request.payToScriptPublicKey,
        address: request.payTo,
      },
      finality: "accepted",
      payerAddress: PAY_TO,
    }),
  };
  const chainProvider: ServerChainProvider = {
    getUtxo: async () => null,
    getVirtualDaaScore: async () => "1",
    estimateClaimFee: async () => "1",
    sendTransaction: async () => ({ transactionId: TRANSACTION_ID, finality: "accepted" }),
  };
  const voucherVerifier: VoucherVerifier = { verifyVoucher: () => false };
  return {
    merchantId: "merchant:demo",
    merchantName: "Sompi Demo Merchant",
    merchantOrigin: "https://merchant.example",
    merchantWebsite: "https://merchant.example/store",
    payTo: PAY_TO,
    amountAtomic: "20000000",
    additionalCostCeilingAtomic: "11050000",
    checkoutTtlMs: 2 * 60_000,
    authorityAudience: FIXED_AUDIENCE,
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    resource: {
      identity: "resource:demo:paid-resource",
      url: "https://merchant.example/paid-resource",
      method: "GET",
      mediaType: "text/plain; charset=utf-8",
      body: RESOURCE_BODY,
    },
    store,
    authorizationStore,
    addressCodec,
    chainProvider,
    voucherVerifier,
    exactTransactionVerifier,
    exactReservationProvider,
    serverPublicKey: `02${"11".repeat(32)}`,
    merchantCheckoutSigner: MERCHANT_SIGNER,
    merchantReceiptSigner: MERCHANT_RECEIPT_SIGNER,
    paymentReceiptSigner: PAYMENT_RECEIPT_SIGNER,
    ap2Trust: fixedTrustStore(),
    now,
  };
}

function requestHashHex(value: Sha256Digest): string {
  return Buffer.from(value.slice("sha256:".length), "base64url").toString("hex");
}

function tamperCompact(value: string): string {
  const segments = value.split(".");
  const signature = segments[2];
  segments[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  return segments.join(".");
}

function isDemoError(code: DemoMerchantError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DemoMerchantError && error.code === code;
}

function fixtureDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-demo-merchant-"));
  fs.chmodSync(directory, 0o700);
  return directory;
}
