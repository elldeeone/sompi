import * as assert from "node:assert/strict";
import test from "node:test";
import {
  PurchaseContractError,
  authorizationFacts,
  validateAuthorizationDecision,
  validateCheckoutTerms,
  validatePreparedPayment,
  type CheckoutTermsExpectation,
  type PreparedPurchasePayment,
  type PurchaseAuthorizationDecision,
  type PurchaseAuthorizationRequest,
  type PurchaseAuthorizer,
  type PurchaseExecutionRequest,
  type PurchaseExecutor,
} from "./contracts.js";
import { createPaymentIdentifier, createPurchaseId, evidenceDigest } from "./identity.js";
import type { CheckoutTerms } from "./types.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const now = () => NOW;

test("canonical Checkout Terms bind the exact Purchase resource and expected merchant", () => {
  const expectation = makeExpectation();
  const candidate = makeTerms();
  const canonical = validateCheckoutTerms(expectation, candidate, now);

  assert.deepEqual(canonical, candidate);
  assert.notEqual(canonical, candidate);
  assert.notEqual(canonical.merchant, candidate.merchant);
});

test("Checkout Terms reject resource and expected merchant substitution", () => {
  const expectation = makeExpectation();
  assert.throws(
    () => validateCheckoutTerms(expectation, { ...makeTerms(), resourceFingerprint: evidenceDigest("other-resource") }, now),
    PurchaseContractError
  );
  assert.throws(
    () => validateCheckoutTerms(expectation, { ...makeTerms(), merchant: { ...makeTerms().merchant, id: "merchant:other" } }, now),
    PurchaseContractError
  );
  assert.throws(
    () => validateCheckoutTerms(expectation, { ...makeTerms(), merchant: { ...makeTerms().merchant, origin: "https://other.example" } }, now),
    PurchaseContractError
  );
  assert.throws(
    () => validateCheckoutTerms(expectation, { ...makeTerms(), merchant: { ...makeTerms().merchant, origin: "https://merchant.example/" } }, now),
    PurchaseContractError
  );
});

test("amount must be a canonical positive decimal integer", () => {
  for (const amountAtomic of ["", "0", "00", "01", "+1", "-1", "1.0", " 1", "1 ", "1e3"]) {
    assert.throws(
      () => validateCheckoutTerms(makeExpectation(), { ...makeTerms(), amountAtomic }, now),
      PurchaseContractError,
      amountAtomic
    );
  }
  assert.equal(validateCheckoutTerms(makeExpectation(), { ...makeTerms(), amountAtomic: "1" }, now).amountAtomic, "1");
});

test("asset, network, payee, merchant and digest identities are bounded and canonical", () => {
  const cases: CheckoutTerms[] = [
    { ...makeTerms(), asset: "KAS SECRET" },
    { ...makeTerms(), network: "kaspa:testnet-10\n" },
    { ...makeTerms(), payTo: "kaspatest:" + "x".repeat(300) },
    { ...makeTerms(), merchant: { ...makeTerms().merchant, id: " merchant:test" } },
    { ...makeTerms(), merchant: { ...makeTerms().merchant, name: " Merchant" } },
    { ...makeTerms(), checkoutDigest: "sha256:bad" as CheckoutTerms["checkoutDigest"] },
  ];
  for (const candidate of cases) {
    assert.throws(() => validateCheckoutTerms(makeExpectation(), candidate, now), PurchaseContractError);
  }
});

test("expiry is strict RFC3339 and strictly future according to the injected clock", () => {
  const rejected = [
    "2030-01-01T00:00:00.000Z",
    "2029-12-31T23:59:59Z",
    "2031-02-29T00:00:00Z",
    "2032-13-01T00:00:00Z",
    "2032-01-01 00:00:00Z",
    "2032-01-01T00:00:00",
    "2032-01-01T24:00:00Z",
    "2032-01-01T00:00:60Z",
    "2032-01-01t00:00:00z",
  ];
  for (const expiresAt of rejected) {
    assert.throws(
      () => validateCheckoutTerms(makeExpectation(), { ...makeTerms(), expiresAt }, now),
      PurchaseContractError,
      expiresAt
    );
  }
  assert.equal(
    validateCheckoutTerms(makeExpectation(), { ...makeTerms(), expiresAt: "2032-02-29T12:34:56.123456789+10:30" }, now).expiresAt,
    "2032-02-29T12:34:56.123456789+10:30"
  );
});

test("authorization decision is bound to the exact Purchase and Checkout digest", () => {
  const request = makeAuthorizationRequest();
  const decision = makeDecision(request);
  assert.deepEqual(validateAuthorizationDecision(request, decision), decision);

  assert.throws(
    () => validateAuthorizationDecision(request, { ...decision, purchaseId: createPurchaseId(new Uint8Array(16).fill(9)) }),
    PurchaseContractError
  );
  assert.throws(
    () => validateAuthorizationDecision(request, { ...decision, checkoutDigest: evidenceDigest("other-checkout") }),
    PurchaseContractError
  );
  assert.throws(
    () => validateAuthorizationDecision(request, { ...decision, authorityId: "authority with spaces" }),
    PurchaseContractError
  );
});

test("prepared payment must exactly match all authorized Checkout Terms", () => {
  const request = makeExecutionRequest();
  const prepared = makePrepared(request);
  assert.deepEqual(validatePreparedPayment(request, prepared, now), prepared);

  const substitutions: Array<Partial<PreparedPurchasePayment>> = [
    { purchaseId: createPurchaseId(new Uint8Array(16).fill(8)) },
    { checkoutDigest: evidenceDigest("other-checkout") },
    { resourceFingerprint: evidenceDigest("other-resource") },
    { amountAtomic: "20000001" },
    { asset: "OTHER" },
    { network: "kaspa:other" },
    { payTo: "kaspatest:other" },
    { paymentIdentifier: createPaymentIdentifier(request.purchaseId, 2) },
  ];
  for (const substitution of substitutions) {
    assert.throws(
      () => validatePreparedPayment(request, { ...prepared, ...substitution }, now),
      PurchaseContractError
    );
  }
});

test("payment preparation rejects denied authority and terms that expired before preparation", () => {
  const request = makeExecutionRequest();
  assert.throws(
    () => validatePreparedPayment({ ...request, authorization: { ...request.authorization, decision: "denied" } }, makePrepared(request), now),
    PurchaseContractError
  );
  assert.throws(
    () => validatePreparedPayment(request, makePrepared(request), () => Date.parse(request.terms.expiresAt)),
    PurchaseContractError
  );
});

test("authorization and execution seam interfaces remain protocol-neutral", async () => {
  const authorizationRequest = makeAuthorizationRequest();
  const authorizer: PurchaseAuthorizer = {
    async authorize(request) {
      return makeDecision(request);
    },
  };
  const decision = validateAuthorizationDecision(
    authorizationRequest,
    await authorizer.authorize(authorizationRequest)
  );
  const executionRequest = makeExecutionRequest(decision);
  const executor: PurchaseExecutor = {
    async prepare(request) {
      return makePrepared(request);
    },
  };
  assert.deepEqual(
    validatePreparedPayment(executionRequest, await executor.prepare(executionRequest), now),
    makePrepared(executionRequest)
  );
});

function makeExpectation(): CheckoutTermsExpectation {
  return {
    purchaseId: createPurchaseId(new Uint8Array(16).fill(1)),
    resourceFingerprint: evidenceDigest("resource"),
    expectedMerchant: {
      id: "merchant:test",
      origin: "https://merchant.example",
    },
  };
}

function makeTerms(): CheckoutTerms {
  return {
    merchant: {
      id: "merchant:test",
      name: "Test Merchant",
      origin: "https://merchant.example",
    },
    resourceFingerprint: evidenceDigest("resource"),
    amountAtomic: "20000000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: "kaspatest:merchant",
    expiresAt: "2032-01-01T00:00:00.000Z",
    checkoutDigest: evidenceDigest("checkout"),
  };
}

function makeAuthorizationRequest(): PurchaseAuthorizationRequest {
  return {
    purchaseId: makeExpectation().purchaseId,
    resourceUrl: "https://merchant.example/resource",
    method: "GET",
    requestMediaType: "",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    terms: validateCheckoutTerms(makeExpectation(), makeTerms(), now),
    requestDigest: evidenceDigest("authorization-request"),
    nonceDigest: evidenceDigest("authorization-nonce"),
    additionalCostCeilingAtomic: "10",
    expiresAtMs: Date.parse(makeTerms().expiresAt),
  };
}

function makeDecision(request: PurchaseAuthorizationRequest): PurchaseAuthorizationDecision {
  return {
    purchaseId: request.purchaseId,
    checkoutDigest: request.terms.checkoutDigest,
    decision: "approved",
    authorityId: "authority:test",
    evidenceDigest: evidenceDigest("authority-decision"),
    facts: authorizationFacts(request),
  };
}

function makeExecutionRequest(decision?: PurchaseAuthorizationDecision): PurchaseExecutionRequest {
  const authorizationRequest = makeAuthorizationRequest();
  return {
    purchaseId: authorizationRequest.purchaseId,
    terms: authorizationRequest.terms,
    authorizationRequest,
    authorization: decision ?? makeDecision(authorizationRequest),
    paymentIdentifier: createPaymentIdentifier(authorizationRequest.purchaseId, 1),
  };
}

function makePrepared(request: PurchaseExecutionRequest): PreparedPurchasePayment {
  return {
    purchaseId: request.purchaseId,
    checkoutDigest: request.terms.checkoutDigest,
    resourceFingerprint: request.terms.resourceFingerprint,
    amountAtomic: request.terms.amountAtomic,
    asset: request.terms.asset,
    network: request.terms.network,
    payTo: request.terms.payTo,
    paymentIdentifier: request.paymentIdentifier,
    executionId: "execution:test:1",
    preparedDigest: evidenceDigest("prepared-payment"),
    fundingSource: "vault-treasury",
  };
}
