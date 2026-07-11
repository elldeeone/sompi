import assert from "node:assert/strict";
import test from "node:test";

import { SignJWT, importJWK } from "jose";

import {
  createPaymentIdentifier,
  evidenceDigest,
} from "../../purchase/identity.js";
import type {
  SettlementResult,
  VerifiedArtifact,
} from "../../purchase/coordinator.js";
import type { Sha256Digest } from "../../purchase/types.js";
import type { PaidResourceResponse } from "../../purchase/paid-resource-response.js";
import {
  issueCheckoutReceipt,
  issuePaymentReceipt,
} from "./receipts.js";
import {
  AUTHORITY_SIGNER,
  FIXED_NOW,
  MERCHANT_RECEIPT_SIGNER,
  PAYMENT_RECEIPT_SIGNER,
  fixedTrustStore,
  fixedVerifiedCheckout,
  fixedVerifiedMandates,
} from "./test-fixtures.js";
import type {
  VerifiedHumanPresentMandates,
  VerifiedMerchantCheckout,
} from "./types.js";
import {
  Ap2PaidResponseVerificationError,
  Ap2PaidResponseVerifier,
  SOMPI_CHECKOUT_RECEIPT_HEADER,
  SOMPI_PAYMENT_RECEIPT_HEADER,
  type Ap2CommerceEvidenceSource,
  type VerifiedAp2CommerceEvidence,
} from "./paid-response-verifier.js";

const TRANSACTION_ID = "44".repeat(32);
const BODY = Buffer.from("fixed-resource", "utf8");
const MEDIA_TYPE = "application/octet-stream";
const AUTHORIZATION_DIGEST = evidenceDigest("verified-authority-decision");
const SETTLEMENT_BYTES = Buffer.from("verified-exact-settlement", "utf8");

test("paid-response verifier returns copied Fulfilment and exact AP2 evidence joins", async () => {
  const fixture = await makeFixture();
  let release!: (value: VerifiedAp2CommerceEvidence) => void;
  const source: Ap2CommerceEvidenceSource = {
    load: () => new Promise((resolve) => {
      release = resolve;
    }),
  };
  const verifier = makeVerifier(source);
  const mutableBody = Uint8Array.from(fixture.input.body);
  const mutableHeaders = fixture.input.headers.map(([name, value]) => [name, value] as [string, string]);
  const input: PaidResourceResponse = {
    ...fixture.input,
    body: mutableBody,
    headers: mutableHeaders,
  };

  const pending = verifier.verify(input);
  mutableBody.fill(0);
  mutableHeaders[1][1] = "mutated-after-call";
  release(fixture.evidence);
  const result = await pending;

  assert.ok(result);
  assert.equal(result.status, "fulfilled");
  assert.equal(result.httpStatus, 200);
  assert.equal(Buffer.from(result.body).toString("utf8"), BODY.toString("utf8"));
  assert.notEqual(result.body, mutableBody);
  assert.equal(result.mediaType, MEDIA_TYPE);
  assert.equal(result.resourceFingerprint, fixture.checkout.terms.resourceFingerprint);
  assert.equal(
    Buffer.from(result.merchantEvidence.bytes).toString("utf8"),
    fixture.checkout.artifact
  );
  assert.equal(result.merchantEvidence.declaredDigest, fixture.checkout.checkoutDigest);
  assert.equal(
    result.merchantEvidence.verification.profile,
    result.merchantEvidence.profile
  );
  assert.deepEqual(result.receipts.map((receipt) => receipt.role), ["merchant", "payment"]);
  for (const receipt of result.receipts) {
    assert.equal(receipt.checkoutDigest, fixture.checkout.checkoutDigest);
    assert.equal(receipt.authorizationEvidenceDigest, AUTHORIZATION_DIGEST);
    assert.equal(receipt.settlementEvidenceDigest, evidenceDigest(SETTLEMENT_BYTES));
    assert.equal(receipt.fulfilmentDigest, evidenceDigest(BODY));
    assert.equal(receipt.evidence.verification.profile, receipt.evidence.profile);
    assert.notEqual(receipt.evidence.bytes, mutableBody);
  }
  mutableBody.fill(0xff);
  assert.equal(Buffer.from(result.body).toString("utf8"), BODY.toString("utf8"));
  assert.equal(SOMPI_CHECKOUT_RECEIPT_HEADER.startsWith("SOMPI-"), true);
  assert.equal(SOMPI_PAYMENT_RECEIPT_HEADER.startsWith("SOMPI-"), true);
});

test("paid-response verifier rejects missing, duplicate, and unbounded Receipt headers", async () => {
  const fixture = await makeFixture();
  const verifier = makeVerifier(sourceFor(fixture.evidence));
  const withoutCheckout = withHeaders(
    fixture.input,
    fixture.input.headers.filter(([name]) => name !== SOMPI_CHECKOUT_RECEIPT_HEADER)
  );
  const withoutPayment = withHeaders(
    fixture.input,
    fixture.input.headers.filter(([name]) => name !== SOMPI_PAYMENT_RECEIPT_HEADER)
  );
  const duplicateCheckout = withHeaders(fixture.input, [
    ...fixture.input.headers,
    [SOMPI_CHECKOUT_RECEIPT_HEADER.toLowerCase(), fixture.checkoutReceipt],
  ]);
  const oversizedPayment = withHeaders(fixture.input, fixture.input.headers.map(([name, value]) =>
    name === SOMPI_PAYMENT_RECEIPT_HEADER
      ? [name, "A".repeat(64 * 1024 + 1)] as const
      : [name, value] as const
  ));

  for (const candidate of [withoutCheckout, withoutPayment, duplicateCheckout, oversizedPayment]) {
    await assert.rejects(verifier.verify(candidate), isVerifierError("receipt_invalid"));
  }
});

test("paid-response verifier rejects wrong role, reference, issuer, payment ID, and transaction joins", async () => {
  const fixture = await makeFixture();
  const verifier = makeVerifier(sourceFor(fixture.evidence));
  const swapped = replaceReceiptHeaders(
    fixture.input,
    fixture.paymentReceipt,
    fixture.checkoutReceipt
  );
  await assert.rejects(verifier.verify(swapped), isVerifierError("receipt_invalid"));

  const otherMandates = await fixedVerifiedMandates(fixture.checkout);
  const wrongReference = await issueCheckoutReceipt({
    status: "Success",
    mandate: otherMandates.checkout,
    orderId: fixture.checkout.purchaseId,
    issuedAtSec: FIXED_NOW + 20,
  }, MERCHANT_RECEIPT_SIGNER);
  await assert.rejects(
    verifier.verify(replaceReceiptHeaders(
      fixture.input,
      wrongReference,
      fixture.paymentReceipt
    )),
    isVerifierError("receipt_invalid")
  );

  const wrongPaymentId = createPaymentIdentifier(fixture.checkout.purchaseId, 2);
  const wrongPaymentReceipt = await issuePaymentReceipt({
    status: "Success",
    mandate: fixture.mandates.payment,
    paymentId: wrongPaymentId,
    pspConfirmationId: wrongPaymentId,
    networkConfirmationId: TRANSACTION_ID,
    issuedAtSec: FIXED_NOW + 20,
  }, PAYMENT_RECEIPT_SIGNER);
  await assert.rejects(
    verifier.verify(replaceReceiptHeaders(
      fixture.input,
      fixture.checkoutReceipt,
      wrongPaymentReceipt
    )),
    isVerifierError("receipt_invalid")
  );

  const wrongTransactionReceipt = await issuePaymentReceipt({
    status: "Success",
    mandate: fixture.mandates.payment,
    paymentId: fixture.paymentIdentifier,
    pspConfirmationId: fixture.paymentIdentifier,
    networkConfirmationId: "55".repeat(32),
    issuedAtSec: FIXED_NOW + 20,
  }, PAYMENT_RECEIPT_SIGNER);
  await assert.rejects(
    verifier.verify(replaceReceiptHeaders(
      fixture.input,
      fixture.checkoutReceipt,
      wrongTransactionReceipt
    )),
    isVerifierError("receipt_invalid")
  );

  const wrongIssuerVerifier = new Ap2PaidResponseVerifier({
    evidenceSource: sourceFor(fixture.evidence),
    trust: fixedTrustStore(),
    expectedMerchantReceiptIssuer: MERCHANT_RECEIPT_SIGNER.issuer,
    expectedPaymentReceiptIssuer: "https://wrong-payments.example",
    now: () => (FIXED_NOW + 21) * 1000,
  });
  await assert.rejects(
    wrongIssuerVerifier.verify(fixture.input),
    isVerifierError("receipt_invalid")
  );
});

test("paid-response verifier rejects body, Receipt tampering, and signed unknown fields", async () => {
  const fixture = await makeFixture();
  const verifier = makeVerifier(sourceFor(fixture.evidence));
  await assert.rejects(
    verifier.verify({ ...fixture.input, body: Buffer.from("wrong-resource", "utf8") }),
    isVerifierError("fulfilment_invalid")
  );

  await assert.rejects(
    verifier.verify(replaceReceiptHeaders(
      fixture.input,
      tamperCompact(fixture.checkoutReceipt),
      fixture.paymentReceipt
    )),
    isVerifierError("receipt_invalid")
  );

  const unknownFieldReceipt = await resignWithUnknownField(
    fixture.paymentReceipt,
    "unexpected_field",
    PAYMENT_RECEIPT_SIGNER
  );
  await assert.rejects(
    verifier.verify(replaceReceiptHeaders(
      fixture.input,
      fixture.checkoutReceipt,
      unknownFieldReceipt
    )),
    isVerifierError("receipt_invalid")
  );
});

test("paid-response verifier rejects unavailable or substituted AP2 source evidence and ignores non-2xx", async () => {
  const fixture = await makeFixture();
  const unavailable = makeVerifier({ load: async () => undefined });
  await assert.rejects(
    unavailable.verify(fixture.input),
    isVerifierError("evidence_unavailable")
  );

  const wrongAuthorization = {
    ...fixture.evidence,
    authorizationEvidenceDigest: evidenceDigest("other-authority"),
  };
  await assert.rejects(
    makeVerifier(sourceFor(wrongAuthorization)).verify(fixture.input),
    isVerifierError("binding_mismatch")
  );

  const unknownSourceField = {
    ...fixture.evidence,
    unexpected: true,
  } as unknown as VerifiedAp2CommerceEvidence;
  await assert.rejects(
    makeVerifier(sourceFor(unknownSourceField)).verify(fixture.input),
    isVerifierError("binding_mismatch")
  );

  await assert.rejects(
    makeVerifier(sourceFor(fixture.evidence)).verify({
      ...fixture.input,
      context: {
        ...fixture.input.context,
        paymentRequirements: Buffer.from("substituted-payment-requirements", "utf8"),
      },
    }),
    isVerifierError("binding_mismatch")
  );

  let loads = 0;
  const nonSuccessVerifier = makeVerifier({
    load: async () => {
      loads += 1;
      return fixture.evidence;
    },
  });
  assert.equal(await nonSuccessVerifier.verify({ ...fixture.input, status: 402 }), undefined);
  assert.equal(loads, 0);
});

interface Fixture {
  readonly checkout: VerifiedMerchantCheckout;
  readonly mandates: VerifiedHumanPresentMandates;
  readonly evidence: VerifiedAp2CommerceEvidence;
  readonly paymentIdentifier: string;
  readonly checkoutReceipt: string;
  readonly paymentReceipt: string;
  readonly input: PaidResourceResponse;
}

async function makeFixture(): Promise<Fixture> {
  const checkout = await fixedVerifiedCheckout();
  const mandates = await fixedVerifiedMandates(checkout);
  const paymentIdentifier = createPaymentIdentifier(checkout.purchaseId, 1);
  const [checkoutReceipt, paymentReceipt] = await Promise.all([
    issueCheckoutReceipt({
      status: "Success",
      mandate: mandates.checkout,
      orderId: checkout.purchaseId,
      issuedAtSec: FIXED_NOW + 20,
    }, MERCHANT_RECEIPT_SIGNER),
    issuePaymentReceipt({
      status: "Success",
      mandate: mandates.payment,
      paymentId: paymentIdentifier,
      pspConfirmationId: paymentIdentifier,
      networkConfirmationId: TRANSACTION_ID,
      issuedAtSec: FIXED_NOW + 20,
    }, PAYMENT_RECEIPT_SIGNER),
  ]);
  const settlementEvidence = artifact(SETTLEMENT_BYTES, "test-exact-settlement");
  const settlement: SettlementResult = {
    evidence: settlementEvidence,
    transactionId: TRANSACTION_ID,
    outpoint: `${TRANSACTION_ID}:1`,
    amountAtomic: checkout.terms.amountAtomic,
    additionalCostAtomic: "1000000",
    asset: checkout.terms.asset,
    network: checkout.terms.network,
    payTo: checkout.terms.payTo,
    finality: "accepted",
    fundingSource: "vault-treasury",
  };
  const authorizationRequest = {
    purchaseId: checkout.purchaseId,
    resourceUrl: checkout.resourceUrl,
    method: checkout.method,
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    terms: checkout.terms,
    requestDigest: evidenceDigest("authority-request"),
    nonceDigest: evidenceDigest("authority-nonce"),
    additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
    createdAtMs: FIXED_NOW * 1_000,
    expiresAtMs: Date.parse(checkout.terms.expiresAt),
  };
  const context: PaidResourceResponse["context"] = {
    purchaseId: checkout.purchaseId,
    terms: checkout.terms,
    authorizationRequest,
    authorization: {
      purchaseId: checkout.purchaseId,
      checkoutDigest: checkout.checkoutDigest,
      decision: "approved",
      authorityId: AUTHORITY_SIGNER.issuer,
      evidenceDigest: AUTHORIZATION_DIGEST,
      facts: {
        purchaseId: checkout.purchaseId,
        resourceUrl: checkout.resourceUrl,
        method: checkout.method,
        requestMediaType: "",
        requestBodyDigest: authorizationRequest.requestBodyDigest,
        resourceFingerprint: checkout.terms.resourceFingerprint,
        merchantId: checkout.terms.merchant.id,
        merchantOrigin: checkout.terms.merchant.origin,
        amountAtomic: checkout.terms.amountAtomic,
        asset: checkout.terms.asset,
        network: checkout.terms.network,
        payTo: checkout.terms.payTo,
        expiresAt: checkout.terms.expiresAt,
        checkoutDigest: checkout.checkoutDigest,
        requestDigest: authorizationRequest.requestDigest,
        nonceDigest: authorizationRequest.nonceDigest,
        additionalCostCeilingAtomic: checkout.additionalCostCeilingAtomic,
      },
    },
    paymentIdentifier,
    request: {
      url: checkout.resourceUrl,
      method: checkout.method,
      requestFingerprint: checkout.terms.resourceFingerprint,
    },
    paymentRequirements: Buffer.from("fixed-payment-requirements", "utf8"),
    preparedTransactionId: TRANSACTION_ID,
  };
  const evidence: VerifiedAp2CommerceEvidence = Object.freeze({
    checkout,
    mandates,
    authorizationEvidenceDigest: AUTHORIZATION_DIGEST,
  });
  return {
    checkout,
    mandates,
    evidence,
    paymentIdentifier,
    checkoutReceipt,
    paymentReceipt,
    input: {
      context,
      status: 200,
      headers: [
        ["content-type", MEDIA_TYPE],
        [SOMPI_CHECKOUT_RECEIPT_HEADER, checkoutReceipt],
        [SOMPI_PAYMENT_RECEIPT_HEADER, paymentReceipt],
      ],
      body: Uint8Array.from(BODY),
      mediaType: MEDIA_TYPE,
      settlement,
    },
  };
}

function makeVerifier(source: Ap2CommerceEvidenceSource): Ap2PaidResponseVerifier {
  return new Ap2PaidResponseVerifier({
    evidenceSource: source,
    trust: fixedTrustStore(),
    expectedMerchantReceiptIssuer: MERCHANT_RECEIPT_SIGNER.issuer,
    expectedPaymentReceiptIssuer: PAYMENT_RECEIPT_SIGNER.issuer,
    now: () => (FIXED_NOW + 21) * 1000,
  });
}

function sourceFor(evidence: VerifiedAp2CommerceEvidence): Ap2CommerceEvidenceSource {
  return { load: async () => evidence };
}

function withHeaders(
  input: PaidResourceResponse,
  headers: readonly (readonly [string, string])[]
): PaidResourceResponse {
  return { ...input, headers };
}

function replaceReceiptHeaders(
  input: PaidResourceResponse,
  checkoutReceipt: string,
  paymentReceipt: string
): PaidResourceResponse {
  return withHeaders(input, input.headers.map(([name, value]) => {
    if (name === SOMPI_CHECKOUT_RECEIPT_HEADER) return [name, checkoutReceipt] as const;
    if (name === SOMPI_PAYMENT_RECEIPT_HEADER) return [name, paymentReceipt] as const;
    return [name, value] as const;
  }));
}

function artifact(bytes: Uint8Array, profile: string): VerifiedArtifact {
  const digest = evidenceDigest(bytes);
  return {
    bytes: Uint8Array.from(bytes),
    mediaType: "application/json",
    profile,
    issuer: "merchant:test",
    declaredDigest: digest,
    verification: {
      verifierId: "test-verifier",
      profile,
      detailDigest: digest,
    },
  };
}

async function resignWithUnknownField(
  artifactValue: string,
  field: string,
  signer: typeof PAYMENT_RECEIPT_SIGNER
): Promise<string> {
  const payload = JSON.parse(
    Buffer.from(artifactValue.split(".")[1], "base64url").toString("utf8")
  ) as Record<string, unknown>;
  const { key_ops: keyOperations, ...jwk } = signer.privateJwk;
  const key = await importJWK({
    ...jwk,
    ...(keyOperations === undefined ? {} : { key_ops: [...keyOperations] }),
  }, "ES256");
  return new SignJWT({ ...payload, [field]: true })
    .setProtectedHeader({ alg: "ES256", kid: signer.kid, typ: "JWT" })
    .sign(key);
}

function tamperCompact(value: string): string {
  const segments = value.split(".");
  const signature = segments[2];
  segments[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  return segments.join(".");
}

function isVerifierError(
  code: Ap2PaidResponseVerificationError["code"]
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Ap2PaidResponseVerificationError && error.code === code;
}
