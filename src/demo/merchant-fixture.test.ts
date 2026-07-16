import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  DirectModeClient,
  MemoryChannelStore,
  type DirectModeChannel,
  type FundingProvider,
} from "@kaspa-x402/client";
import {
  channelId,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  paymentIdentifierExtension,
  sha256Hex,
  stableStringify,
  type PaymentPayload,
  type ChannelConfig,
  type Hash32Hex,
  type SignatureHex,
} from "@kaspa-x402/core";
import type {
  AddressCodec,
  ExactHeadRecord,
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
import { KaspaTestnet10AddressCodec } from "../adapters/kaspa-x402/address-codec.js";
import { SqliteMerchantServerStateStore } from "./merchant-server-store.js";
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
const ADDITIVE_TRANSACTION_ID = "66".repeat(32) as Hash32Hex;
const ADDITIVE_HEAD_ID = "77".repeat(32) as Hash32Hex;
const ADDITIVE_HEAD_TXID = "99".repeat(32) as Hash32Hex;
const ADDITIVE_OWNER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const SECOND_PURCHASE_ID = assertPurchaseId("pur_AQEBAQEBAQEBAQEBAQEBAQ");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const RESOURCE_BODY = Buffer.from("deterministic paid resource\n", "utf8");
const CLIENT_PUBLIC_KEY = "22".repeat(32) as Hash32Hex;
const BATCH_SERVER_PUBLIC_KEY = "11".repeat(32) as Hash32Hex;
const ACTIVE_TX = "33".repeat(32) as Hash32Hex;
const CLAIM_TX = "88".repeat(32) as Hash32Hex;
const ACTIVE_SCRIPT = `000020${"55".repeat(32)}`;
const BATCH_TIMEOUT_DAA = "5000";
const BATCH_FUNDING = "100000000";
const BATCH_CHARGE = "12000000";

test("demo Merchant joins real AP2 Checkout, mandates, exact settlement, resource, and receipts", async () => {
  const store = new SqliteMerchantServerStateStore(":memory:");
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
    assert.equal(paid.response.status, 200, stableStringify(paid.response));
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
    assert.equal(paid.evidence?.executionProfile, "kaspa-exact-v2:standard-native");
    assert.equal(paid.evidence?.maximumAuthorizedChargeAtomic, "20000000");
    assert.equal(paid.evidence?.actualChargeAtomic, "20000000");
    assert.equal(paid.evidence?.paymentOutputIndex, 0);
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

test("demo Merchant joins AP2 authorization to a corrected additive head payment", async () => {
  const store = new SqliteMerchantServerStateStore(":memory:");
  const head = additiveHead();
  await store.registerExactHead(head);
  const merchant = await DemoMerchantFixture.create(additiveConfig(store, head));
  try {
    const offer = await merchant.offer(PURCHASE_ID);
    const requiredHeader = offer.paymentRequired.headers["PAYMENT-REQUIRED"];
    const required = decodePaymentRequiredHeader(requiredHeader);
    const accepted = required.accepts[0];
    assert.equal(accepted?.scheme, "exact");
    assert.equal(accepted?.extra.binding, "kaspa-exact-v2");
    assert.equal(accepted?.extra.profile, "additive");
    assert.equal(accepted?.extra.headId, head.headId);
    assert.equal(accepted?.extra.headAmount, head.currentAmount);

    const commerceEvidence = await authorise(offer.checkout);
    await presentAuthorization(merchant, offer, commerceEvidence, PAYMENT_IDENTIFIER);
    const paid = await merchant.handlePaid(
      paidRequest(offer, commerceEvidence, PAYMENT_IDENTIFIER)
    );

    assert.equal(paid.response.status, 200, stableStringify(paid.response));
    assert.equal(paid.evidence?.paymentScheme, "exact");
    assert.equal(paid.evidence?.transactionId, ADDITIVE_TRANSACTION_ID);
    assert.equal(paid.evidence?.executionProfile, "kaspa-exact-v2:additive");
    assert.equal(paid.evidence?.maximumAuthorizedChargeAtomic, "20000000");
    assert.equal(paid.evidence?.actualChargeAtomic, "20000000");
    const advanced = await store.loadExactHead(head.headId);
    assert.deepEqual(advanced?.currentOutpoint, { txid: ADDITIVE_TRANSACTION_ID, index: 0 });
    assert.equal(advanced?.currentAmount, "120000000");
    assert.equal(advanced?.status, "available");
  } finally {
    store.close();
  }
});

test("demo Merchant joins AP2 authorization to one durable batch commitment and receipt", async () => {
  const store = new SqliteMerchantServerStateStore(":memory:");
  const channel = batchChannel();
  await store.saveChannel(serverChannel(channel));
  const merchant = await DemoMerchantFixture.create(batchConfig(store));
  try {
    const offer = await merchant.offer(PURCHASE_ID);
    const requiredHeader = offer.paymentRequired.headers["PAYMENT-REQUIRED"];
    const required = decodePaymentRequiredHeader(requiredHeader);
    assert.equal(required.accepts.length, 1);
    assert.equal(required.accepts[0]?.scheme, "batch-settlement");
    assert.equal(required.accepts[0]?.extra.binding, "kaspa-escrow-v1");

    const commerceEvidence = await authorise(offer.checkout);
    await presentAuthorization(merchant, offer, commerceEvidence, PAYMENT_IDENTIFIER);
    const clientStore = new MemoryChannelStore([channel]);
    const client = batchClient(clientStore);
    const payment = await client.createPayment(requiredHeader, {
      url: offer.checkout.resourceUrl,
      method: offer.checkout.method,
      origin: new URL(offer.checkout.resourceUrl).origin,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      requestHash: requestHashHex(offer.checkout.terms.resourceFingerprint),
    });
    assert.equal(payment.scheme, "batch-settlement");
    const paid = await merchant.handlePaid({
      purchaseId: offer.purchaseId,
      merchantCheckout: offer.checkout.artifact,
      paymentRequiredHeader: requiredHeader,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      headers: {
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment.paymentPayload),
      },
    });

    assert.equal(paid.response.status, 200);
    assert.equal(paid.evidence?.paymentScheme, "batch-settlement");
    assert.equal(paid.evidence?.channelId, channel.id);
    assert.equal(paid.evidence?.commitmentId, paid.evidence?.networkConfirmationId);
    assert.equal(paid.evidence?.maximumAuthorizedChargeAtomic, "20000000");
    assert.equal(paid.evidence?.actualChargeAtomic, BATCH_CHARGE);
    assert.equal(paid.evidence?.executionProfile, "kaspa-escrow-v1:batch-settlement");
    assert.equal(
      paid.ap2Receipts?.payment.networkConfirmationId,
      paid.evidence?.commitmentId
    );
    const settlement = decodePaymentResponseHeader(paid.response.headers["PAYMENT-RESPONSE"]);
    await client.applySettlement(payment, settlement);
    assert.equal((await clientStore.loadChannels({}))[0]?.chargedCumulativeAmount, BATCH_CHARGE);

    const preview = await merchant.previewBatchClaim(channel.id);
    assert.equal(preview.claimable, true);
    assert.equal(preview.claimAmount, BATCH_CHARGE);
    const claim = await merchant.executeBatchClaim(channel.id);
    assert.equal(claim.accepted, true);
    assert.equal(claim.transactionId, CLAIM_TX);
    assert.equal(claim.channel.claimedCumulativeAmount, BATCH_CHARGE);
    assert.deepEqual(claim.channel.activeOutpoint, { txid: CLAIM_TX, index: 1 });

    const replay = await merchant.handlePaid({
      purchaseId: offer.purchaseId,
      merchantCheckout: offer.checkout.artifact,
      paymentRequiredHeader: requiredHeader,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      headers: {
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment.paymentPayload),
      },
    });
    assert.deepEqual(replay.response, paid.response);
    assert.deepEqual(replay.evidence, paid.evidence);
  } finally {
    store.close();
  }
});

test("demo Merchant rejects Checkout, Payment Requirements, and mandate substitution or replay", async () => {
  const store = new SqliteMerchantServerStateStore(":memory:");
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
        paymentRequiredHeader: encodePaymentRequiredHeader({
          ...decodePaymentRequiredHeader(first.paymentRequired.headers["PAYMENT-REQUIRED"]),
          accepts: [{
            ...decodePaymentRequiredHeader(first.paymentRequired.headers["PAYMENT-REQUIRED"]).accepts[0],
            amount: "20000001",
          }],
        }),
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
  const store = new SqliteMerchantServerStateStore(":memory:");
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
  let store = new SqliteMerchantServerStateStore(filename);
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

  store = new SqliteMerchantServerStateStore(filename);
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

test("demo Merchant restores exact offer bytes and continues one durably-started paid request after expiry", async () => {
  const clock = { now: NOW_MS };
  const store = new SqliteMerchantServerStateStore(":memory:");
  const authorizationStore = new SqliteDemoCommerceAuthorizationStore(":memory:", {
    now: () => clock.now,
  });
  let durableRequest: DemoMerchantPaidRequest | undefined;
  const presentedAtSec = FIXED_NOW + 10;
  const merchant = await DemoMerchantFixture.create({
    ...config(store, () => clock.now, authorizationStore),
    paidRequestContinuation: {
      authorizationPresentedAtSec(input) {
        if (
          !durableRequest ||
          input.purchaseId !== durableRequest.purchaseId ||
          input.paymentIdentifier !== durableRequest.paymentIdentifier ||
          input.merchantCheckout !== durableRequest.merchantCheckout ||
          input.paymentRequiredHeader !== durableRequest.paymentRequiredHeader ||
          input.paymentSignature !== durableRequest.headers["PAYMENT-SIGNATURE"]
        ) {
          throw new Error("continuation mismatch");
        }
        return presentedAtSec;
      },
    },
  });
  try {
    const offer = await merchant.offer(PURCHASE_ID);
    const restored = await merchant.restoreOffer({
      purchaseId: offer.purchaseId,
      merchantCheckout: offer.checkout.artifact,
      paymentRequiredHeader: offer.paymentRequired.headers["PAYMENT-REQUIRED"],
      issuedAtSec: offer.checkout.issuedAtSec,
    });
    assert.equal(restored.checkout.artifact, offer.checkout.artifact);
    assert.equal(
      restored.paymentRequired.headers["PAYMENT-REQUIRED"],
      offer.paymentRequired.headers["PAYMENT-REQUIRED"]
    );
    assert.equal(restored.paymentRequirementsDigest, offer.paymentRequirementsDigest);

    const evidence = await authorise(offer.checkout, offer.checkout.expiresAtSec);
    await presentAuthorization(merchant, offer, evidence, PAYMENT_IDENTIFIER);
    durableRequest = paidRequest(offer, evidence, PAYMENT_IDENTIFIER);
    clock.now = (offer.checkout.expiresAtSec + 30) * 1000;
    const paid = await merchant.handlePaid(durableRequest);
    assert.equal(paid.response.status, 200);
    assert.equal(paid.ap2Receipts?.payment.issuedAtSec, offer.checkout.expiresAtSec + 30);
  } finally {
    store.close();
    authorizationStore.close();
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
  const profile = accepted.extra.profile === "additive" ? "additive" : "standard-native";
  const transactionId = profile === "additive" ? ADDITIVE_TRANSACTION_ID : TRANSACTION_ID;
  const challengeId = profile === "additive"
    ? String(accepted.extra.challengeId) as Hash32Hex
    : undefined;
  const expiresAt = profile === "additive"
    ? String(accepted.extra.challengeExpiresAt)
    : new Date((FIXED_NOW + 120) * 1000).toISOString();
  const authorizationDigest = exactRequestAuthorizationDigest({
    network: accepted.network,
    profile,
    transactionId,
    paymentOutputIndex: 0,
    amount: accepted.amount,
    payTo: accepted.payTo,
    payToScriptPublicKey: String(accepted.extra.payToScriptPublicKey),
    paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    requestHash,
    ...(challengeId ? { challengeId } : {}),
    inputIndex: 0,
    expiresAt,
  });
  return {
    x402Version: 2,
    accepted,
    payload: {
      type: "exact-transaction",
      profile,
      ...(challengeId ? { challengeId } : {}),
      transaction: "prepared-exact-transaction",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      requestHash,
      authorization: {
        version: "kaspa-x402-exact-request-authorization-v1",
        inputIndex: 0,
        expiresAt,
        digest: authorizationDigest,
        signature: "cd".repeat(64),
      },
    },
    extensions: {
      "payment-identifier": paymentIdentifierExtension({
        required: true,
        id: paymentIdentifier,
      }),
    },
  };
}

function additiveHead(): ExactHeadRecord {
  const redeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey: ADDITIVE_OWNER,
    amount: "10000000",
  }).toLowerCase();
  const scriptPublicKey = serializedScriptPublicKey(
    kip10AdditiveScriptPublicKey({ ownerPublicKey: ADDITIVE_OWNER, amount: "10000000" })
  ).toLowerCase();
  const codec = new KaspaTestnet10AddressCodec();
  const payTo = codec.encodeScriptAddress({
    network: DEMO_NETWORK,
    scriptPublicKey: { version: 0, script: scriptPublicKey.slice(4) },
    serializedScriptPublicKey: scriptPublicKey,
  });
  return {
    headId: ADDITIVE_HEAD_ID,
    network: DEMO_NETWORK,
    payTo,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: ADDITIVE_HEAD_TXID, index: 0 },
    currentAmount: "100000000",
    scriptPublicKey,
    redeemScript,
    additiveThresholdSompi: "10000000",
    version: "0",
    status: "available",
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
  };
}

function additiveConfig(
  store: SqliteMerchantServerStateStore,
  head: ExactHeadRecord
): DemoMerchantFixtureConfig {
  const base = config(store);
  return {
    ...base,
    payTo: head.payTo,
    exactProfile: "additive",
    addressCodec: new KaspaTestnet10AddressCodec(),
    exactTransactionVerifier: {
      verifyExactPayment: (request) => {
        assert.equal(request.profile, "additive");
        assert.equal(request.head?.headId, head.headId);
        return {
          transactionId: ADDITIVE_TRANSACTION_ID,
          paymentOutput: {
            amount: request.amount,
            scriptPublicKey: head.scriptPublicKey,
            address: head.payTo,
          },
          finality: "accepted",
          payerAddress: PAY_TO,
          requestAuthorization: {
            authorizationId: exactRequestAuthorizationId(request.authorization),
            digest: request.authorization.digest,
            inputIndex: request.authorization.inputIndex,
            publicKey: "11".repeat(32),
          },
          continuation: {
            outpoint: { txid: ADDITIVE_TRANSACTION_ID, index: 0 },
            amount: "120000000",
            scriptPublicKey: head.scriptPublicKey,
          },
        };
      },
    },
    chainProvider: {
      ...base.chainProvider,
      sendTransaction: async () => ({
        transactionId: ADDITIVE_TRANSACTION_ID,
        finality: "accepted",
      }),
    },
  };
}

function config(
  store: SqliteMerchantServerStateStore,
  now: () => number = () => NOW_MS,
  authorizationStore = new SqliteDemoCommerceAuthorizationStore(":memory:", { now })
): DemoMerchantFixtureConfig {
  const addressCodec: AddressCodec = {
    scriptPublicKeyForAddress: () => "000051",
    encodeScriptAddress: () => PAY_TO,
  };
  const exactTransactionVerifier: ExactTransactionVerifier = {
    verifyExactPayment: (request) => {
      const authorizationId = exactRequestAuthorizationId(request.authorization);
      return {
        transactionId: TRANSACTION_ID,
        paymentOutput: {
          amount: request.amount,
          scriptPublicKey: request.payToScriptPublicKey,
          address: request.payTo,
        },
        finality: "accepted",
        payerAddress: PAY_TO,
        requestAuthorization: {
          authorizationId,
          digest: request.authorization.digest,
          inputIndex: request.authorization.inputIndex,
          publicKey: "11".repeat(32),
        },
      };
    },
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
    paymentScheme: "exact",
    exactProfile: "standard-native",
    amountAtomic: "20000000",
    additionalCostCeilingAtomic: "2050000",
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
    serverPublicKey: `02${"11".repeat(32)}`,
    merchantCheckoutSigner: MERCHANT_SIGNER,
    merchantReceiptSigner: MERCHANT_RECEIPT_SIGNER,
    paymentReceiptSigner: PAYMENT_RECEIPT_SIGNER,
    ap2Trust: fixedTrustStore(),
    now,
  };
}

function batchConfig(
  store: SqliteMerchantServerStateStore,
  now: () => number = () => NOW_MS,
  authorizationStore = new SqliteDemoCommerceAuthorizationStore(":memory:", { now })
): DemoMerchantFixtureConfig {
  const base = config(store, now, authorizationStore);
  const { exactProfile: _exactProfile, exactTransactionVerifier: _exactVerifier, ...shared } = base;
  return {
    ...shared,
    paymentScheme: "batch-settlement",
    serverPublicKey: BATCH_SERVER_PUBLIC_KEY,
    batchMinDepositSompi: "1",
    batchRefundTimeoutDaa: BATCH_TIMEOUT_DAA,
    batchChargeAtomic: BATCH_CHARGE,
    voucherVerifier: { verifyVoucher: () => true },
    chainProvider: {
      ...base.chainProvider,
      getUtxo: async (outpoint) => {
        if (outpoint.txid === ACTIVE_TX && outpoint.index === 0) {
          return {
            outpoint,
            amount: BATCH_FUNDING,
            scriptPublicKey: ACTIVE_SCRIPT,
            finality: "accepted" as const,
          };
        }
        if (outpoint.txid === CLAIM_TX && outpoint.index === 1) {
          return {
            outpoint,
            amount: "88000000",
            scriptPublicKey: ACTIVE_SCRIPT,
            finality: "accepted" as const,
          };
        }
        return null;
      },
      getVirtualDaaScore: async () => "1",
      sendTransaction: async () => ({ transactionId: CLAIM_TX, finality: "accepted" }),
    },
    claimBuilder: {
      buildClaimTransaction: async (request) => ({
        transaction: "prepared-merchant-claim",
        claimAmount: request.claimAmount,
        continuationOutpoint: { txid: CLAIM_TX, index: 1 },
        continuationScriptPublicKey: request.channel.activeScriptPublicKey,
        continuationFundingAmount: String(
          BigInt(request.channel.fundingAmount) - BigInt(request.claimAmount)
        ),
      }),
    },
  };
}

function batchChannelConfig(): ChannelConfig {
  return {
    network: DEMO_NETWORK,
    asset: "KAS",
    templateId: "kaspa-x402-escrow-v1",
    clientPublicKey: CLIENT_PUBLIC_KEY,
    serverPublicKey: BATCH_SERVER_PUBLIC_KEY,
    payTo: PAY_TO,
    refundAddress: "kaspatest:refund",
    refundTimeoutDaa: BATCH_TIMEOUT_DAA,
    salt: "77".repeat(32),
  };
}

function batchChannel(): DirectModeChannel {
  const config = batchChannelConfig();
  return {
    id: channelId(config),
    origin: "https://merchant.example",
    resourceUrl: "https://merchant.example/paid-resource",
    config,
    clientPublicKey: CLIENT_PUBLIC_KEY,
    serverPublicKey: config.serverPublicKey,
    activeOutpoint: { txid: ACTIVE_TX, index: 0 },
    activeScriptPublicKey: ACTIVE_SCRIPT,
    escrowAddress: "kaspatest:escrow",
    fundingSource: "vault-treasury",
    fundingAmount: BATCH_FUNDING,
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedCumulativeAmount: "0",
    refundTimeoutDaa: BATCH_TIMEOUT_DAA,
    templateId: "kaspa-x402-escrow-v1",
    status: "active",
  };
}

function serverChannel(channel: DirectModeChannel) {
  return {
    channelId: channel.id,
    channelConfig: channel.config,
    escrowAddress: channel.escrowAddress,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    chargedCumulativeAmount: channel.chargedCumulativeAmount,
    claimedCumulativeAmount: channel.claimedCumulativeAmount,
    signedMaxClaimable: "0",
    status: "active" as const,
  };
}

function batchClient(store: MemoryChannelStore): DirectModeClient {
  const fundingProvider: FundingProvider = {
    networkId: DEMO_NETWORK,
    sourceKind: "vault-treasury",
    getPublicIdentity: async () => ({ address: "kaspatest:refund", publicKey: CLIENT_PUBLIC_KEY }),
    authorizeExactPayment: async () => { throw new Error("exact is disabled"); },
    fundEscrowDeposit: async () => { throw new Error("implicit deposit is disabled"); },
    getUtxos: async () => [{
      outpoint: { txid: ACTIVE_TX, index: 0 },
      amount: BATCH_FUNDING,
      scriptPublicKey: ACTIVE_SCRIPT,
      address: "kaspatest:escrow",
    }],
    getVirtualDaaScore: async () => "1",
    sendTransaction: async () => { throw new Error("client broadcast is disabled"); },
    estimateFees: async () => ({ feeSompi: "1" }),
  };
  return new DirectModeClient({
    fundingProvider,
    signer: {
      generateChannelKey: async () => ({ publicKey: CLIENT_PUBLIC_KEY }),
      randomSalt: async () => "77".repeat(32) as Hash32Hex,
      signVoucher: async () => "99".repeat(64) as SignatureHex,
    },
    store,
    addressCodec: {
      scriptPublicKeyForAddress: () => ACTIVE_SCRIPT,
      encodeScriptAddress: () => "kaspatest:escrow",
    },
    refundAddress: "kaspatest:refund",
    supportedSchemes: ["batch-settlement"],
  });
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
