import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  encodePaymentResponseHeader,
  paymentIdentifierExtension,
  sha256Hex,
  stableStringify,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "@kaspa-x402/core";
import {
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import {
  assertPurchaseId,
  createPaymentIdentifier,
  requestFingerprint,
} from "../../purchase/identity.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import {
  KaspaExactChainVerifier,
  KaspaExactChainVerifierError,
  KaspaX402ServerStorePaymentResponseLookup,
  type ChainObservation,
  type ChainObservationRequest,
} from "./chain-verifier.js";
import { ExactTransactionBuilder } from "./exact-transaction-builder.js";
import { StagingKeyStore } from "./staging-key-store.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const PAYMENT_IDENTIFIER = createPaymentIdentifier(PURCHASE_ID, 1);
const MERCHANT_ID = "merchant:test";
const MERCHANT_ORIGIN = "https://merchant.example";
const RESOURCE_URL = `${MERCHANT_ORIGIN}/resource`;
const OWNER_PUBLIC_KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const FIXED_PRIVATE_KEY = "01".padStart(64, "0");
const BORROW_TXID = "22".repeat(32);
const STAGING_TXID = "33".repeat(32);
const AMOUNT = "20000000";
const BORROW_AMOUNT = "100000000";
const THRESHOLD = "10000000";
const STAGING_FEE = "50000";
const ADDITIONAL_COST = "2050000";
const REQUEST_BODY = Buffer.from("request-body", "utf8");

test("Settlement verifier binds alpha.8 additive safe JSON, successor output, and Treasury cost", async () => {
  const fixture = await makeFixture();
  const calls: string[] = [];
  const verifier = fixture.verifier({
    stagingFee: async (request) => {
      calls.push("staging");
      assert.equal(request.purchaseId, PURCHASE_ID);
      assert.equal(request.paymentIdentifier, PAYMENT_IDENTIFIER);
      assert.equal(request.outpoint, `${STAGING_TXID}:1`);
      assert.equal(request.amountAtomic, "22000000");
      return STAGING_FEE;
    },
    chain: async (request) => {
      calls.push("chain");
      assert.deepEqual(
        {
          transactionId: request.transactionId,
          outpoint: request.outpoint,
          outputIndex: request.outputIndex,
          amount: request.expectedAmountAtomic,
          script: request.expectedScriptPublicKey,
          minimumFinality: request.minimumFinality,
        },
        {
          transactionId: fixture.transactionId,
          outpoint: `${fixture.transactionId}:0`,
          outputIndex: 0,
          amount: "120000000",
          script: fixture.merchantScript,
          minimumFinality: "accepted",
        }
      );
      return fixture.chainObservation("accepted");
    },
  });

  const result = await verifier.verify(fixture.verificationInput());
  assert.equal(result.additionalCostAtomic, ADDITIONAL_COST);
  assert.equal(result.outpoint, `${fixture.transactionId}:0`);
  assert.equal(result.verification.profile, "kaspa-x402-0.1.0-alpha.8-exact-settlement");
  assert.match(result.verification.detailDigest, /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(calls, ["staging", "chain"]);
});

test("Settlement verifier accepts Sompi-bound idempotency when the Merchant did not advertise it", async () => {
  const fixture = await makeFixture({ advertisePaymentIdentifier: false });
  const result = await fixture.verifier().verify(fixture.verificationInput());
  assert.equal(result.outpoint, `${fixture.transactionId}:0`);
  assert.equal(
    fixture.paymentPayload.extensions?.["payment-identifier"]?.info.id,
    PAYMENT_IDENTIFIER
  );
});

test("exact construction rejects optional staging change", async () => {
  await assert.rejects(
    makeFixture({
      stagingAmountAtomic: "22000001",
      additionalCostCeilingAtomic: "2050001",
    }),
    /must equal price plus the bounded fee/
  );
});

test("verifier fails closed on transaction, request, head, chain, cost, and finality substitutions", async () => {
  const fixture = await makeFixture();
  const cases: Array<{
    name: string;
    input?: ReturnType<Fixture["verificationInput"]>;
    verifier?: KaspaExactChainVerifier;
    pattern: RegExp;
  }> = [];

  const changedStaging = fixture.verificationInput();
  changedStaging.context = {
    ...changedStaging.context,
    staging: { ...changedStaging.context.staging, amountAtomic: "22000001" },
  };
  cases.push({ name: "staging amount", input: changedStaging, pattern: /input facts changed/ });

  const changedRequestHash = fixture.verificationInput();
  changedRequestHash.paymentPayload = structuredClone(changedRequestHash.paymentPayload);
  if (changedRequestHash.paymentPayload.payload.type !== "exact-transaction") throw new Error("fixture");
  changedRequestHash.paymentPayload.payload.requestHash = "ff".repeat(32);
  cases.push({ name: "request hash", input: changedRequestHash, pattern: /PaymentPayload|retry artifacts/ });

  const changedReservation = fixture.verificationInput();
  changedReservation.paymentRequired = structuredClone(changedReservation.paymentRequired);
  changedReservation.paymentPayload = structuredClone(changedReservation.paymentPayload);
  (changedReservation.paymentRequired.accepts[0] as any).extra.headId = "66".repeat(32);
  (changedReservation.paymentPayload.accepted as any).extra.headId = "66".repeat(32);
  cases.push({ name: "head", input: changedReservation, pattern: /head|artifact|retry|authorization/i });

  const unknownFinality = fixture.verificationInput();
  unknownFinality.response = structuredClone(unknownFinality.response);
  (unknownFinality.response.extensions!.kaspa as any).finality = "finalized";
  cases.push({ name: "unknown finality", input: unknownFinality, pattern: /finality is unknown/ });

  cases.push({
    name: "chain script",
    verifier: fixture.verifier({
      chain: async () => ({
        ...fixture.chainObservation("accepted"),
        scriptPublicKey: `0000${"aa".repeat(34)}`,
      }),
    }),
    pattern: /does not attest the exact Merchant output/,
  });
  cases.push({
    name: "full cost",
    verifier: fixture.verifier({ stagingFee: async () => "50001" }),
    pattern: /additional cost exceeds authorisation|gross bound/,
  });

  const responseConfirmed = fixture.verificationInput();
  responseConfirmed.response = structuredClone(responseConfirmed.response);
  responseConfirmed.response.extensions!.kaspa!.finality = "confirmed";
  cases.push({
    name: "chain finality downgrade",
    input: responseConfirmed,
    verifier: fixture.verifier({ chain: async () => fixture.chainObservation("accepted") }),
    pattern: /below required confirmed/,
  });

  for (const candidate of cases) {
    await assert.rejects(
      (candidate.verifier ?? fixture.verifier()).verify(candidate.input ?? fixture.verificationInput()),
      candidate.pattern,
      candidate.name
    );
  }
});

test("payment identifiers cannot replay a different immutable exact transaction", async () => {
  const first = await makeFixture();
  const second = await makeFixture({ stagingTransactionId: "77".repeat(32) });
  const chain = async (request: ChainObservationRequest): Promise<ChainObservation> => ({
    status: "observed",
    network: "kaspa:testnet-10",
    transactionId: request.transactionId,
    outpoint: request.outpoint,
    amountAtomic: request.expectedAmountAtomic,
    scriptPublicKey: request.expectedScriptPublicKey,
    finality: "confirmed",
    observedAtMs: NOW,
  });
  const verifier = first.verifier({ chain });
  await verifier.verify(first.verificationInput());
  await assert.rejects(
    verifier.verify(second.verificationInput()),
    (value: unknown) =>
      value instanceof KaspaExactChainVerifierError && value.code === "payment_replay"
  );
});

test("chain finality is monotonic across repeated observations", async () => {
  const fixture = await makeFixture();
  let finality: "accepted" | "confirmed" = "confirmed";
  const verifier = fixture.verifier({
    chain: async () => fixture.chainObservation(finality),
  });
  await verifier.verify(fixture.verificationInput());
  finality = "accepted";
  await assert.rejects(
    verifier.verify(fixture.verificationInput()),
    (value: unknown) =>
      value instanceof KaspaExactChainVerifierError && value.code === "finality_downgrade"
  );
});

test("Settlement observation is deadline bounded even when a source ignores abort", async () => {
  const fixture = await makeFixture();
  const verifier = fixture.verifier({
    observationTimeoutMs: 10,
    stagingFee: async () => new Promise<string>(() => undefined),
  });
  await assert.rejects(
    verifier.verify(fixture.verificationInput()),
    (value: unknown) =>
      value instanceof KaspaExactChainVerifierError && value.code === "deadline_exceeded"
  );
});

test("recovery queries Merchant by payment identifier first and snapshots its response", async () => {
  const fixture = await makeFixture();
  const order: string[] = [];
  const original = Uint8Array.from(fixture.paymentResponseHeader);
  const retained = Uint8Array.from(original);
  const verifier = fixture.verifier({
    merchant: async (request) => {
      order.push("merchant");
      assert.equal(request.paymentIdentifier, PAYMENT_IDENTIFIER);
      setTimeout(() => retained.fill(0x41), 0).unref();
      return retained;
    },
    chain: async () => {
      order.push("chain");
      return fixture.chainObservation("accepted");
    },
  });
  const result = await verifier.observe(fixture.recoveryInput());
  assert.equal(result.status, "payment_response");
  if (result.status !== "payment_response") throw new Error("expected payment response");
  assert.deepEqual(result.paymentResponseHeader, original);
  assert.deepEqual(order, ["merchant"]);
});

test("recovery probes the exact chain only after a Merchant miss and never submits", async () => {
  const fixture = await makeFixture();
  const order: string[] = [];
  const observed = fixture.verifier({
    merchant: async () => {
      order.push("merchant");
      return undefined;
    },
    chain: async (request) => {
      order.push("chain");
      assert.equal(request.minimumFinality, "mempool");
      return fixture.chainObservation("mempool");
    },
  });
  assert.deepEqual(await observed.observe(fixture.recoveryInput()), {
    status: "transaction_observed",
  });
  assert.deepEqual(order, ["merchant", "chain"]);

  const pending = fixture.verifier({
    merchant: async () => undefined,
    chain: async () => ({ status: "pending" }),
  });
  const pendingResult = await pending.observe(fixture.recoveryInput());
  assert.equal(pendingResult.status, "pending");
  if (pendingResult.status !== "pending") throw new Error("expected pending");
  assert.match(pendingResult.detailDigest ?? "", /^sha256:[A-Za-z0-9_-]{43}$/);

  const aborted = new AbortController();
  aborted.abort(new Error("caller stopped"));
  await assert.rejects(
    observed.observe(fixture.recoveryInput(aborted.signal)),
    /caller stopped/
  );
});

test("recovery rejects malformed Merchant evidence rather than falling back to chain", async () => {
  const fixture = await makeFixture();
  let chainCalls = 0;
  const verifier = fixture.verifier({
    merchant: async () => Buffer.from("not base64url!", "ascii"),
    chain: async () => {
      chainCalls += 1;
      return { status: "pending" };
    },
  });
  await assert.rejects(verifier.observe(fixture.recoveryInput()), /canonical ASCII base64/);
  assert.equal(chainCalls, 0);
});

test("alpha.8 Merchant-store lookup returns only the response durably bound to the payment identifier", async () => {
  const fixture = await makeFixture();
  const settlement = structuredClone(fixture.response);
  const responseHeader = Buffer.from(fixture.paymentResponseHeader).toString("ascii");
  const record = {
    id: PAYMENT_IDENTIFIER,
    fingerprint: "11".repeat(32),
    paymentPayloadHash: "22".repeat(32),
    response: {
      status: 200,
      headers: { "PAYMENT-RESPONSE": responseHeader },
      body: "resource",
    },
    settlement,
    paymentScopeId: "33".repeat(32),
    transactionId: fixture.transactionId,
    paymentOutputIndex: 0,
  };
  const lookup = new KaspaX402ServerStorePaymentResponseLookup({
    store: {
      loadPaymentIdentifier: async (id) => {
        assert.equal(id, PAYMENT_IDENTIFIER);
        return record;
      },
    },
    now: () => NOW,
  });
  const result = await lookup.findByPaymentIdentifier({
    purchaseId: PURCHASE_ID,
    paymentIdentifier: PAYMENT_IDENTIFIER,
    transactionId: fixture.transactionId,
    deadlineAtMs: NOW + 1_000,
    signal: new AbortController().signal,
  });
  assert.deepEqual(Buffer.from(result ?? []), Buffer.from(fixture.paymentResponseHeader));

  await assert.rejects(
    lookup.findByPaymentIdentifier({
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      transactionId: "99".repeat(32),
      deadlineAtMs: NOW + 1_000,
      signal: new AbortController().signal,
    }),
    (value: unknown) =>
      value instanceof KaspaExactChainVerifierError && value.code === "payment_replay"
  );
});

interface FixtureOptions {
  stagingTransactionId?: string;
  stagingAmountAtomic?: string;
  additionalCostCeilingAtomic?: string;
  advertisePaymentIdentifier?: boolean;
}

interface Fixture {
  transactionId: string;
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload;
  response: SettlementResponse;
  paymentResponseHeader: Uint8Array;
  context: any;
  merchantScript: string;
  stagingScript: string;
  verifier(options?: VerifierOverrides): KaspaExactChainVerifier;
  chainObservation(finality: "mempool" | "accepted" | "confirmed"): Extract<ChainObservation, { status: "observed" }>;
  verificationInput(): any;
  recoveryInput(signal?: AbortSignal): any;
  chainRequest(minimumFinality: "mempool" | "accepted" | "confirmed"): ChainObservationRequest;
}

interface VerifierOverrides {
  stagingFee?: (request: any) => Promise<string | undefined>;
  chain?: (request: ChainObservationRequest) => Promise<ChainObservation>;
  merchant?: (request: any) => Promise<Uint8Array | undefined>;
  observationTimeoutMs?: number;
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-chain-verifier-"));
  try {
    const stagingTransactionId = options.stagingTransactionId ?? STAGING_TXID;
    const stagingAmountAtomic = options.stagingAmountAtomic ?? "22000000";
    const additionalCostCeilingAtomic = options.additionalCostCeilingAtomic ?? ADDITIONAL_COST;
    const keyStore = new StagingKeyStore({
      directory: path.join(root, "keys"),
      now: () => NOW,
      generatePrivateKey: () => FIXED_PRIVATE_KEY,
    });
    const key = keyStore.create({ purchaseId: PURCHASE_ID, paymentIdentifier: PAYMENT_IDENTIFIER });
    const headRedeemScript = buildKip10AdditiveRedeemScript({
      ownerPublicKey: OWNER_PUBLIC_KEY,
      amount: THRESHOLD,
    }).toLowerCase();
    const headScriptPublicKey = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({ ownerPublicKey: OWNER_PUBLIC_KEY, amount: THRESHOLD })
    ).toLowerCase();
    const codec = new KaspaTestnet10AddressCodec();
    const merchantAddress = codec.encodeScriptAddress({
      network: "kaspa:testnet-10",
      scriptPublicKey: { version: 0, script: headScriptPublicKey.slice(4) },
      serializedScriptPublicKey: headScriptPublicKey,
    });
    const body = Uint8Array.from(REQUEST_BODY);
    const fingerprint = requestFingerprint({
      url: RESOURCE_URL,
      method: "POST",
      mediaType: "application/json",
      body,
    });
    const requestHash = Buffer.from(fingerprint.slice("sha256:".length), "base64url").toString("hex");
    const accepted = {
      scheme: "exact" as const,
      network: "kaspa:testnet-10" as const,
      amount: AMOUNT,
      asset: "KAS" as const,
      payTo: merchantAddress,
      maxTimeoutSeconds: 60,
      extra: {
        binding: "kaspa-exact-v2" as const,
        profile: "additive" as const,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
        payToScriptPublicKey: headScriptPublicKey,
        paymentOutputIndex: 0 as const,
        finality: "accepted" as const,
        templateId: "kaspa-x402-kip10-additive-v1" as const,
        headId: "55".repeat(32),
        headVersion: "0",
        expectedHeadOutpoint: { txid: BORROW_TXID, index: 0 },
        headAmount: BORROW_AMOUNT,
        headScriptPublicKey,
        headRedeemScript,
        challengeId: "56".repeat(32),
        challengeExpiresAt: "2099-01-01T00:00:00.000Z",
        additiveThresholdSompi: THRESHOLD,
        assetKind: "native" as const,
        assetDecimals: 8 as const,
      },
    };
    const builder = new ExactTransactionBuilder({ keyStore, now: () => NOW });
    const built = await builder.build({
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_IDENTIFIER,
      request: {
        network: "kaspa:testnet-10",
        profile: "additive",
        origin: MERCHANT_ORIGIN,
        resourceUrl: RESOURCE_URL,
        amount: AMOUNT,
        payTo: merchantAddress,
        payToScriptPublicKey: headScriptPublicKey,
        paymentOutputIndex: 0,
        requestHash,
        paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
        authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        requiredFinality: "accepted",
        fundingSource: "vault-treasury",
        head: {
          headId: accepted.extra.headId,
          headVersion: accepted.extra.headVersion,
          expectedHeadOutpoint: accepted.extra.expectedHeadOutpoint,
          headAmount: accepted.extra.headAmount,
          headScriptPublicKey: accepted.extra.headScriptPublicKey,
          headRedeemScript: accepted.extra.headRedeemScript,
          additiveThresholdSompi: accepted.extra.additiveThresholdSompi,
          challengeId: accepted.extra.challengeId,
          challengeExpiresAt: accepted.extra.challengeExpiresAt,
        },
      },
      staging: {
        outpoint: { txid: stagingTransactionId, index: 1 },
        amountAtomic: stagingAmountAtomic,
        scriptPublicKey: key.scriptPublicKey,
        address: key.address,
        blockDaaScore: "123",
        keyReference: key.keyReference,
      },
      additionalCostCeilingAtomic,
      stagingTransactionFeeAtomic: STAGING_FEE,
    });
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL, mimeType: "application/octet-stream" },
      accepts: [accepted],
      ...(options.advertisePaymentIdentifier === false
        ? {}
        : {
            extensions: {
              "payment-identifier": paymentIdentifierExtension({ required: true }),
            },
          }),
    };
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: structuredClone(accepted),
      payload: {
        type: "exact-transaction",
        profile: "additive",
        challengeId: accepted.extra.challengeId,
        payerAddress: built.payerAddress,
        transaction: built.transaction,
        transactionEncoding: built.transactionEncoding,
        paymentOutputIndex: built.paymentOutputIndex,
        requestHash,
        authorization: built.authorization,
      },
      extensions: {
        "payment-identifier": paymentIdentifierExtension({
          required: true,
          id: PAYMENT_IDENTIFIER,
        }),
      },
    };
    const response: SettlementResponse = {
      success: true,
      transaction: built.transactionId,
      network: "kaspa:testnet-10",
      payer: built.payerAddress,
      amount: AMOUNT,
      extensions: {
        kaspa: {
          paymentOutputIndex: 0,
          finality: "accepted",
          requestHash,
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          exactProfile: "additive",
          templateId: "kaspa-x402-kip10-additive-v1",
          headId: accepted.extra.headId,
          headVersion: accepted.extra.headVersion,
          headOutpoint: accepted.extra.expectedHeadOutpoint,
        },
      },
    };
    const checkoutDigest = digest("checkout");
    const requestBodyDigest = digest(body);
    const terms = {
      merchant: { id: MERCHANT_ID, name: "Test Merchant", origin: MERCHANT_ORIGIN },
      resourceFingerprint: fingerprint,
      amountAtomic: AMOUNT,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: merchantAddress,
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest,
    };
    const authorizationRequest = {
      purchaseId: PURCHASE_ID,
      resourceUrl: RESOURCE_URL,
      method: "POST",
      requestMediaType: "application/json",
      requestBodyDigest,
      terms,
      requestDigest: digest("authority-request"),
      nonceDigest: digest("authority-nonce"),
      additionalCostCeilingAtomic,
      executionPlanDigest: digest("additive-execution-plan"),
      executionMechanism: "single-transaction" as const,
      executionProfile: "additive",
      settlementAssurance: "accepted" as const,
      maximumAuthorizedChargeAtomic: (
        BigInt(AMOUNT) + BigInt(additionalCostCeilingAtomic)
      ).toString(10),
      expiresAtMs: Date.parse(terms.expiresAt),
    };
    const facts = {
      purchaseId: PURCHASE_ID,
      resourceUrl: RESOURCE_URL,
      method: "POST",
      requestMediaType: "application/json",
      requestBodyDigest,
      resourceFingerprint: fingerprint,
      merchantId: MERCHANT_ID,
      merchantOrigin: MERCHANT_ORIGIN,
      amountAtomic: AMOUNT,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: merchantAddress,
      expiresAt: terms.expiresAt,
      checkoutDigest,
      requestDigest: authorizationRequest.requestDigest,
      nonceDigest: authorizationRequest.nonceDigest,
      additionalCostCeilingAtomic,
      executionPlanDigest: authorizationRequest.executionPlanDigest,
      executionMechanism: authorizationRequest.executionMechanism,
      executionProfile: authorizationRequest.executionProfile,
      settlementAssurance: authorizationRequest.settlementAssurance,
      maximumAuthorizedChargeAtomic: authorizationRequest.maximumAuthorizedChargeAtomic,
    };
    const context = {
      execution: {
        purchaseId: PURCHASE_ID,
        terms,
        authorizationRequest,
        authorization: {
          purchaseId: PURCHASE_ID,
          checkoutDigest,
          decision: "approved",
          authorityId: "authority:test",
          evidenceDigest: digest("authority-evidence"),
          facts,
        },
        paymentIdentifier: PAYMENT_IDENTIFIER,
      },
      request: {
        url: RESOURCE_URL,
        method: "POST",
        mediaType: "application/json",
        body,
        requestFingerprint: fingerprint,
      },
      paymentRequirements: Buffer.from("unused-in-verifier"),
      staging: {
        transactionId: stagingTransactionId,
        outpoint: `${stagingTransactionId}:1`,
        amountAtomic: stagingAmountAtomic,
        evidenceDigest: digest("staging-evidence"),
        fundingSource: "vault-treasury",
      },
      preparation: {
        preparedBytes: Buffer.from("unused-in-verifier"),
        preparedDigest: digest("prepared"),
        executionId: built.transactionId,
        mechanism: "single-transaction" as const,
        profile: "additive",
        transactionId: built.transactionId,
        requiredAssurance: "accepted" as const,
        fundingSource: "vault-treasury",
      },
    };
    const merchantScript = codec.scriptPublicKeyForAddress(
      merchantAddress,
      "kaspa:testnet-10"
    ).toLowerCase();
    const paymentResponseHeader = Buffer.from(encodePaymentResponseHeader(response), "ascii");

    const fixture: Fixture = {
      transactionId: built.transactionId,
      paymentRequired,
      paymentPayload,
      response,
      paymentResponseHeader,
      context,
      merchantScript,
      stagingScript: key.scriptPublicKey,
      verifier(overrides: VerifierOverrides = {}) {
        const chain = overrides.chain ?? (async () => fixture.chainObservation("accepted"));
        return new KaspaExactChainVerifier({
          stagingMetadata: {
            actualTransactionFeeAtomic:
              overrides.stagingFee ?? (async () => STAGING_FEE),
          },
          chain: { observeExactOutput: chain },
          merchantResponses: {
            findByPaymentIdentifier: overrides.merchant ?? (async () => undefined),
          },
          observationTimeoutMs: overrides.observationTimeoutMs,
          now: () => NOW,
        });
      },
      chainObservation(finality) {
        return {
          status: "observed",
          network: "kaspa:testnet-10",
          transactionId: built.transactionId,
          outpoint: `${built.transactionId}:0`,
          amountAtomic: "120000000",
          scriptPublicKey: merchantScript,
          finality,
          observedAtMs: NOW,
        };
      },
      verificationInput() {
        return {
          source: "paid-http-response",
          context: structuredClone(context),
          paymentRequired: structuredClone(paymentRequired),
          paymentPayload: structuredClone(paymentPayload),
          response: structuredClone(response),
          transactionId: built.transactionId,
          evidenceBytes: Uint8Array.from(paymentResponseHeader),
        };
      },
      recoveryInput(signal = new AbortController().signal) {
        return {
          context: structuredClone(context),
          effect: {
            id: "effect-payment",
            purchaseId: PURCHASE_ID,
            attempt: 1,
            kind: "kaspa-x402-payment",
            idempotencyKey: `payment:${PAYMENT_IDENTIFIER}`,
            state: "ambiguous",
            version: 1,
            payloadDigest: digest("prepared"),
            preparedRef: digest("prepared"),
            preparedByteLength: 1,
            createdAtMs: NOW,
            updatedAtMs: NOW,
          },
          paymentRequired: structuredClone(paymentRequired),
          paymentPayload: structuredClone(paymentPayload),
          transactionId: built.transactionId,
          signal,
        };
      },
      chainRequest(minimumFinality) {
        return {
          network: "kaspa:testnet-10",
          transactionId: built.transactionId,
          outpoint: `${built.transactionId}:0`,
          outputIndex: 0,
          merchantAddress,
          expectedAmountAtomic: "120000000",
          expectedScriptPublicKey: merchantScript,
          minimumFinality,
          deadlineAtMs: NOW + 10_000,
          signal: new AbortController().signal,
        };
      },
    };
    return fixture;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}
