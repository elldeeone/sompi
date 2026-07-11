import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as core from "@kaspa-x402/core";

import {
  assertPurchaseId,
  createPaymentIdentifier,
  requestFingerprint,
} from "../../purchase/identity.js";
import { KaspaX402ExactPaymentModule } from "./exact-payment-module.js";

const PURCHASE_ID = assertPurchaseId("pur_AQEBAQEBAQEBAQEBAQEBAQ");
const PAYMENT_ID = createPaymentIdentifier(PURCHASE_ID, 1);
const RESOURCE_URL = "https://merchant.example/resource";
const MERCHANT_ORIGIN = "https://merchant.example";
const MERCHANT_ID = "merchant:test";
const PAY_TO = "kaspatest:test-payee";
const AMOUNT = "20000000";
const ADDITIONAL_COST = "10001000";
const STAGING_TX = "11".repeat(32);
const EXACT_TX = "22".repeat(32);
const BORROW_TX = "33".repeat(32);
const RESERVATION_ID = "44".repeat(32);
const CHECKOUT_DIGEST = digest("checkout");
const REQUEST_BODY = Buffer.from("request-body", "utf8");
const REQUEST_FINGERPRINT = requestFingerprint({
  url: RESOURCE_URL,
  method: "POST",
  mediaType: "application/json",
  body: REQUEST_BODY,
});
const REQUEST_BODY_DIGEST = digest(REQUEST_BODY);
const AUTH_REQUEST_DIGEST = digest("authority-request");
const AUTH_NONCE_DIGEST = digest("authority-nonce");
const AUTH_EVIDENCE_DIGEST = digest("authority-evidence");
const STAGING_EVIDENCE_DIGEST = digest("staging-evidence");
const SETTLEMENT_DETAIL_DIGEST = digest("settlement-verified");
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

test("alpha.6 exact module uses official lower-level flow and durable staging seams", async () => {
  const fixture = makeFixture();

  const preparedStaging = await fixture.module.prepareStaging({
    execution: fixture.execution,
    request: fixture.request,
    paymentRequirements: fixture.paymentRequirements,
    additionalCostCeilingAtomic: ADDITIONAL_COST,
  });
  assert.equal(preparedStaging.transactionId, STAGING_TX);
  assert.equal(fixture.calls.stagingPrepare, 1);

  const stagingContext = fixture.stagingContext(preparedStaging);
  const staged = await fixture.module.submitStaging({
    context: stagingContext,
    effect: fixture.effect("treasury-staging", preparedStaging.preparedDigest),
    signal: new AbortController().signal,
  });
  assert.equal(staged.status, "staged");
  assert.equal(fixture.calls.stagingSubmit, 1);

  const prepared = await fixture.module.prepare({
    execution: fixture.execution,
    request: fixture.request,
    paymentRequirements: fixture.paymentRequirements,
    staging: fixture.observedStaging,
    additionalCostCeilingAtomic: ADDITIONAL_COST,
  });
  assert.equal(prepared.transactionId, EXACT_TX);
  assert.equal(prepared.executionId, EXACT_TX);
  assert.equal(prepared.fundingSource, "vault-treasury");
  assert.equal(fixture.calls.payExact, 1);
  assert.deepEqual(fixture.calls.providerPurposes, ["prepare"]);

  const envelopeText = Buffer.from(prepared.preparedBytes).toString("utf8");
  const envelope = JSON.parse(envelopeText);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "paymentPayload",
    "paymentRequired",
    "transactionId",
  ]);
  assert.equal(core.stableStringify(envelope), envelopeText);
  assert.equal(envelope.paymentPayload.payload.type, "exact-transaction");
  assert.equal(envelope.paymentPayload.extensions["payment-identifier"].info.id, PAYMENT_ID);
  assert.equal(envelope.transactionId, EXACT_TX);

  const source = fs.readFileSync(
    path.join(process.cwd(), "src/adapters/kaspa-x402/exact-payment-module.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /\.paidFetch\s*\(/);
  assert.match(source, /\.createPayment\s*\(/);
  assert.match(source, /\.applySettlement\s*\(/);
});

test("paid retry is address-pinned, bounded, settlement-verified, and replay-identical", async () => {
  const fixture = makeFixture();
  const prepared = await fixture.prepareExact();
  const context = fixture.preparedContext(prepared);
  const effect = fixture.effect("kaspa-x402-exact", prepared.preparedDigest);

  const first = await fixture.module.submit({
    context,
    effect,
    egress: fixture.egress,
    signal: new AbortController().signal,
  });
  const second = await fixture.module.submit({
    context,
    effect,
    egress: fixture.egress,
    signal: new AbortController().signal,
  });

  assert.equal(first.status, "settled");
  assert.equal(second.status, "settled");
  assert.equal(first.submissionDigest, second.submissionDigest);
  if (first.status !== "settled") throw new Error("expected Settlement");
  assert.equal(first.settlement.transactionId, EXACT_TX);
  assert.equal(first.settlement.outpoint, `${EXACT_TX}:1`);
  assert.equal(first.settlement.amountAtomic, AMOUNT);
  assert.equal(first.settlement.additionalCostAtomic, "10000002");
  assert.equal(first.settlement.finality, "accepted");
  assert.equal(first.settlement.evidence.declaredDigest, digest(fixture.paymentResponseHeader));

  assert.equal(fixture.calls.payExact, 1, "replay must not construct another exact transaction");
  assert.equal(fixture.calls.transport, 2);
  assert.equal(fixture.calls.settlementVerify, 2);
  assert.deepEqual(fixture.calls.providerPurposes, ["prepare"]);
  assert.equal(fixture.paymentSignatures.length, 2);
  assert.equal(fixture.paymentSignatures[0], fixture.paymentSignatures[1]);
  assert.equal(fixture.transportRequests[0].hop.connection.addresses[0].address, "203.0.113.10");
  assert.deepEqual(Buffer.from(fixture.transportRequests[0].body), REQUEST_BODY);
});

test("post-Settlement fulfilment recovery replays the same keyless payment payload", async () => {
  const fixture = makeFixture();
  const prepared = await fixture.prepareExact();
  const result = await fixture.module.recoverFulfilment({
    context: fixture.preparedContext(prepared),
    egress: fixture.egress,
  });
  assert.deepEqual(result, { status: "pending" });
  assert.equal(fixture.calls.payExact, 1, "recovery must not construct another payment");
  assert.equal(fixture.calls.transport, 1);
  assert.equal(fixture.paymentSignatures.length, 1);
});

test("canonical rehydration rejects tampering, payment-id replay, and provider reuse", async () => {
  const fixture = makeFixture();
  const prepared = await fixture.prepareExact();
  const originalContext = fixture.preparedContext(prepared);
  const effect = fixture.effect("kaspa-x402-exact", prepared.preparedDigest);

  const tampered = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
  tampered.paymentPayload.payload.requestHash = "ff".repeat(32);
  const tamperedBytes = Buffer.from(core.stableStringify(tampered), "utf8");
  const tamperedContext = {
    ...originalContext,
    preparation: {
      ...originalContext.preparation,
      preparedBytes: tamperedBytes,
      preparedDigest: digest(tamperedBytes),
    },
  };
  await assert.rejects(
    fixture.module.submit({
      context: tamperedContext,
      effect: { ...effect, payloadDigest: digest(tamperedBytes) },
      egress: fixture.egress,
      signal: new AbortController().signal,
    }),
    /request facts|requestHash|request hash|immutable request/
  );

  const replayContext = {
    ...originalContext,
    execution: { ...originalContext.execution, paymentIdentifier: "pay_other_1" },
  };
  await assert.rejects(
    fixture.module.submit({
      context: replayContext,
      effect: { ...effect, idempotencyKey: "payment:pay_other_1" },
      egress: fixture.egress,
      signal: new AbortController().signal,
    }),
    /payment identifier/
  );
  assert.equal(fixture.calls.transport, 0);

  await assert.rejects(
    fixture.module.prepareStaging({
      execution: fixture.execution,
      request: fixture.request,
      paymentRequirements: Buffer.from(`${fixture.paymentRequirements.toString("ascii")}\n`, "ascii"),
      additionalCostCeilingAtomic: ADDITIONAL_COST,
    }),
    /canonical ASCII base64/
  );

  const sharedProvider = fixture.makeProvider();
  const sharedFixture = makeFixture({
    providerFactory: async () => sharedProvider,
  });
  await sharedFixture.prepareExact();
  await assert.rejects(sharedFixture.prepareExact(), /reused a provider/);
});

test("ambiguous recovery observes first and retries only the same immutable payload", async () => {
  const fixture = makeFixture({ recoveryStatus: "transaction_observed" });
  const prepared = await fixture.prepareExact();
  const context = fixture.preparedContext(prepared);
  const effect = fixture.effect("kaspa-x402-exact", prepared.preparedDigest);

  const recovered = await fixture.module.observe({
    context,
    effect,
    egress: fixture.egress,
  });
  assert.equal(recovered.status, "settled");
  assert.equal(fixture.calls.recoveryObserve, 1);
  assert.equal(fixture.calls.transport, 1);
  assert.equal(fixture.calls.payExact, 1);
  assert.deepEqual(fixture.calls.providerPurposes, ["prepare"]);

  const pending = makeFixture({ recoveryStatus: "pending" });
  const pendingPrepared = await pending.prepareExact();
  const pendingResult = await pending.module.observe({
    context: pending.preparedContext(pendingPrepared),
    effect: pending.effect("kaspa-x402-exact", pendingPrepared.preparedDigest),
    egress: pending.egress,
  });
  assert.equal(pendingResult.status, "pending");
  assert.equal(pending.calls.transport, 0);
});

test("Settlement substitutions rejected beyond alpha.6 applySettlement checks", async () => {
  const fixture = makeFixture({ settlementReservationId: "55".repeat(32) });
  const prepared = await fixture.prepareExact();
  await assert.rejects(
    fixture.module.submit({
      context: fixture.preparedContext(prepared),
      effect: fixture.effect("kaspa-x402-exact", prepared.preparedDigest),
      egress: fixture.egress,
      signal: new AbortController().signal,
    }),
    /reservation facts/
  );
});

test("restart rejects misbound Effects and a supplied fingerprint unrelated to the request", async () => {
  const fixture = makeFixture();
  const prepared = await fixture.prepareExact();
  const context = fixture.preparedContext(prepared);
  const effect = fixture.effect("kaspa-x402-exact", prepared.preparedDigest);

  for (const changed of [
    { ...effect, payloadDigest: digest("different-preparation") },
    { ...effect, idempotencyKey: `payment:${createPaymentIdentifier(PURCHASE_ID, 2)}` },
    { ...effect, state: "planned" },
  ]) {
    await assert.rejects(
      fixture.module.submit({
        context,
        effect: changed,
        egress: fixture.egress,
        signal: new AbortController().signal,
      }),
      /Effect is not bound/
    );
  }
  assert.equal(fixture.calls.transport, 0);

  const unrelated = digest("unrelated-request-fingerprint");
  const changedTerms = { ...fixture.execution.terms, resourceFingerprint: unrelated };
  const changedExecution = {
    ...fixture.execution,
    terms: changedTerms,
    authorizationRequest: {
      ...fixture.execution.authorizationRequest,
      terms: changedTerms,
    },
    authorization: {
      ...fixture.execution.authorization,
      facts: {
        ...fixture.execution.authorization.facts,
        resourceFingerprint: unrelated,
      },
    },
  };
  await assert.rejects(
    fixture.module.prepareStaging({
      execution: changedExecution,
      request: { ...fixture.request, requestFingerprint: unrelated },
      paymentRequirements: fixture.paymentRequirements,
      additionalCostCeilingAtomic: ADDITIONAL_COST,
    }),
    /fingerprint is not derived/
  );
  assert.equal(fixture.calls.stagingPrepare, 0);
});

test("restart rechecks usable staging bounds and the pinned destination index", async () => {
  const fixture = makeFixture();
  const stagingContext = fixture.stagingContext(fixture.preparedStaging);
  for (const staging of [
    { ...stagingContext.staging, amountAtomic: "29999999" },
    { ...stagingContext.staging, amountAtomic: "30001001" },
    { ...stagingContext.staging, expectedOutpoint: `${STAGING_TX}:1` },
  ]) {
    await assert.rejects(
      fixture.module.submitStaging({
        context: { ...stagingContext, staging },
        effect: fixture.effect("treasury-staging", staging.preparedDigest),
        signal: new AbortController().signal,
      }),
      /Treasury staging|staging plan/
    );
  }
  assert.equal(fixture.calls.stagingSubmit, 0);

  const prepared = await fixture.prepareExact();
  const paymentContext = fixture.preparedContext(prepared);
  await assert.rejects(
    fixture.module.submit({
      context: {
        ...paymentContext,
        staging: { ...paymentContext.staging, amountAtomic: "29999999" },
      },
      effect: fixture.effect("kaspa-x402-exact", prepared.preparedDigest),
      egress: fixture.egress,
      signal: new AbortController().signal,
    }),
    /cannot fund the Merchant price/
  );
  assert.equal(fixture.calls.transport, 0);
});

test("Settlement requires an exact chain-attested outpoint and authorized total cost", async () => {
  for (const settlementOutpoint of [null, `${EXACT_TX}:2`]) {
    const fixture = makeFixture({ settlementOutpoint });
    const prepared = await fixture.prepareExact();
    await assert.rejects(
      fixture.module.submit({
        context: fixture.preparedContext(prepared),
        effect: fixture.effect("kaspa-x402-exact", prepared.preparedDigest),
        egress: fixture.egress,
        signal: new AbortController().signal,
      }),
      /outpoint/
    );
  }

  const excessive = makeFixture({ settlementAdditionalCostAtomic: "10001001" });
  const prepared = await excessive.prepareExact();
  await assert.rejects(
    excessive.module.submit({
      context: excessive.preparedContext(prepared),
      effect: excessive.effect("kaspa-x402-exact", prepared.preparedDigest),
      egress: excessive.egress,
      signal: new AbortController().signal,
    }),
    /complete additional cost exceeds the Purchase authorization/
  );
});

test("recovery is deadline-bounded and snapshots observer-owned Settlement bytes", async () => {
  const hung = makeFixture({ recoveryStatus: "hung" });
  const hungPrepared = await hung.prepareExact();
  const expiringEgress = {
    ...hung.egress,
    request: { ...hung.egress.request, deadlineAtMs: NOW + 5 },
  };
  await assert.rejects(
    hung.module.observe({
      context: hung.preparedContext(hungPrepared),
      effect: hung.effect("kaspa-x402-exact", hungPrepared.preparedDigest),
      egress: expiringEgress,
    }),
    /deadline has expired/
  );
  assert.equal(hung.calls.recoveryObserve, 1);

  const mutating = makeFixture({
    recoveryStatus: "payment_response",
    mutateRecoveryHeader: true,
  });
  const mutatingPrepared = await mutating.prepareExact();
  const recovered = await mutating.module.observe({
    context: mutating.preparedContext(mutatingPrepared),
    effect: mutating.effect("kaspa-x402-exact", mutatingPrepared.preparedDigest),
    egress: mutating.egress,
  });
  assert.equal(recovered.status, "settled");
  assert.equal(
    recovered.settlement.evidence.declaredDigest,
    digest(mutating.paymentResponseHeader)
  );
  assert.deepEqual(mutating.calls.providerPurposes, ["prepare"]);
});

function makeFixture(
  options: {
    recoveryStatus?: "transaction_observed" | "payment_response" | "hung" | "pending";
    settlementReservationId?: string;
    settlementOutpoint?: string | null;
    settlementAdditionalCostAtomic?: string;
    mutateRecoveryHeader?: boolean;
    providerFactory?: (context: any) => Promise<any>;
  } = {}
) {
  const calls = {
    stagingPrepare: 0,
    stagingSubmit: 0,
    stagingObserve: 0,
    payExact: 0,
    transport: 0,
    settlementVerify: 0,
    recoveryObserve: 0,
    providerPurposes: [] as string[],
  };
  const paymentSignatures: string[] = [];
  const transportRequests: any[] = [];
  const paymentRequired = paymentRequiredWire();
  const paymentRequirements = Buffer.from(
    core.encodePaymentRequiredHeader(paymentRequired as any),
    "ascii"
  );
  const requestHash = requestHashHex(REQUEST_FINGERPRINT);
  const settlementResponse = {
    success: true,
    transaction: EXACT_TX,
    network: "kaspa:testnet-10",
    amount: AMOUNT,
    extensions: {
      kaspa: {
        paymentOutputIndex: 1,
        finality: "accepted",
        requestHash,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        templateId: "kaspa-x402-kip10-additive-v1",
        reservationId: options.settlementReservationId ?? RESERVATION_ID,
        borrowOutpoint: { txid: BORROW_TX, index: 0 },
      },
    },
  };
  const paymentResponseHeader = Buffer.from(
    core.encodePaymentResponseHeader(settlementResponse as any),
    "ascii"
  );

  const terms = {
    merchant: { id: MERCHANT_ID, name: "Test Merchant", origin: MERCHANT_ORIGIN },
    resourceFingerprint: REQUEST_FINGERPRINT,
    amountAtomic: AMOUNT,
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: PAY_TO,
    expiresAt: "2099-01-01T00:00:00.000Z",
    checkoutDigest: CHECKOUT_DIGEST,
  };
  const authorizationRequest = {
    purchaseId: PURCHASE_ID,
    resourceUrl: RESOURCE_URL,
    method: "POST",
    requestMediaType: "application/json",
    requestBodyDigest: REQUEST_BODY_DIGEST,
    terms,
    requestDigest: AUTH_REQUEST_DIGEST,
    nonceDigest: AUTH_NONCE_DIGEST,
    additionalCostCeilingAtomic: ADDITIONAL_COST,
    expiresAtMs: Date.parse(terms.expiresAt),
  };
  const facts = {
    purchaseId: PURCHASE_ID,
    resourceUrl: RESOURCE_URL,
    method: "POST",
    requestMediaType: "application/json",
    requestBodyDigest: REQUEST_BODY_DIGEST,
    resourceFingerprint: REQUEST_FINGERPRINT,
    merchantId: MERCHANT_ID,
    merchantOrigin: MERCHANT_ORIGIN,
    amountAtomic: AMOUNT,
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: PAY_TO,
    expiresAt: terms.expiresAt,
    checkoutDigest: CHECKOUT_DIGEST,
    requestDigest: AUTH_REQUEST_DIGEST,
    nonceDigest: AUTH_NONCE_DIGEST,
    additionalCostCeilingAtomic: ADDITIONAL_COST,
  };
  const execution = {
    purchaseId: PURCHASE_ID,
    terms,
    authorizationRequest,
    authorization: {
      purchaseId: PURCHASE_ID,
      checkoutDigest: CHECKOUT_DIGEST,
      decision: "approved",
      authorityId: "authority:test",
      evidenceDigest: AUTH_EVIDENCE_DIGEST,
      facts,
    },
    paymentIdentifier: PAYMENT_ID,
  };
  const request = {
    url: RESOURCE_URL,
    method: "POST",
    mediaType: "application/json",
    body: Uint8Array.from(REQUEST_BODY),
    requestFingerprint: REQUEST_FINGERPRINT,
  };
  const observedStaging = {
    transactionId: STAGING_TX,
    outpoint: `${STAGING_TX}:0`,
    amountAtomic: "30001000",
    evidenceDigest: STAGING_EVIDENCE_DIGEST,
    fundingSource: "vault-treasury",
  };
  const stagingBytes = Buffer.from(
    JSON.stringify({ id: STAGING_TX, destinationOutpoint: `${STAGING_TX}:0` }),
    "utf8"
  );
  const preparedStaging = {
    preparedBytes: stagingBytes,
    preparedDigest: digest(stagingBytes),
    transactionId: STAGING_TX,
    expectedOutpoint: `${STAGING_TX}:0`,
    stagingAmountAtomic: observedStaging.amountAtomic,
    fundingSource: "vault-treasury" as const,
  };
  const stagingEvidence = verifiedArtifact(
    "staging-observed",
    "test-staging-v1",
    "treasury:test"
  );

  const makeProvider = () => ({
    networkId: "kaspa:testnet-10",
    sourceKind: "vault-treasury",
    getPublicIdentity: async () => ({ address: "kaspatest:test-payer" }),
    fundEscrowDeposit: async () => { throw new Error("batch disabled"); },
    payExactTransaction: async (payment: any) => {
      calls.payExact += 1;
      assert.equal(payment.network, "kaspa:testnet-10");
      assert.equal(payment.amount, AMOUNT);
      assert.equal(payment.payTo, PAY_TO);
      assert.equal(payment.requestHash, requestHash);
      assert.equal(payment.fundingSource, "vault-treasury");
      return {
        // Official alpha.6 vector shape: transaction identity is returned by
        // the provider, not invented as a root field inside the wire payload.
        transaction: JSON.stringify({ transaction: "signed-kip10-exact" }),
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        transactionId: EXACT_TX,
        paymentOutputIndex: 1,
        payerAddress: "kaspatest:test-payer",
        fundingSource: "vault-treasury",
      };
    },
    getUtxos: async () => [],
    getVirtualDaaScore: async () => "1",
    sendTransaction: async () => { throw new Error("broadcast disabled"); },
    estimateFees: async () => ({ feeSompi: "1" }),
  });

  const providerFactory = options.providerFactory ?? (async () => makeProvider());
  const staging = {
    prepare: async () => {
      calls.stagingPrepare += 1;
      return preparedStaging;
    },
    submit: async ({ context }: any) => {
      calls.stagingSubmit += 1;
      return {
        status: "staged" as const,
        submissionDigest: digest("staging-submitted"),
        staging: {
          evidence: stagingEvidence,
          transactionId: context.staging.transactionId,
          outpoint: context.staging.expectedOutpoint,
          stagingAmountAtomic: context.staging.amountAtomic,
          fundingSource: "vault-treasury" as const,
        },
      };
    },
    observe: async () => {
      calls.stagingObserve += 1;
      return { status: "pending" as const, detailDigest: digest("staging-pending") };
    },
  };

  const transport = {
    send: async (transportRequest: any) => {
      calls.transport += 1;
      transportRequests.push(transportRequest);
      const signature = transportRequest.headers.find(
        ([name]: [string, string]) => name.toLowerCase() === "payment-signature"
      )?.[1];
      assert.equal(typeof signature, "string");
      paymentSignatures.push(signature);
      return {
        status: 200,
        headers: [
          ["PAYMENT-RESPONSE", paymentResponseHeader.toString("ascii")],
          ["content-type", "application/octet-stream"],
        ],
        body: (async function* () {
          yield Buffer.from("paid-resource", "utf8");
        })(),
      };
    },
  };

  const module: any = new KaspaX402ExactPaymentModule({
    staging,
    funding: {
      createProvider: async (context: any) => {
        calls.providerPurposes.push(context.purpose);
        assert.equal(context.purchaseId, PURCHASE_ID);
        if (context.purpose === "prepare") assert.equal(context.paymentIdentifier, PAYMENT_ID);
        assert.equal(context.requestHash, requestHash);
        assert.equal(context.staging.outpoint, `${STAGING_TX}:0`);
        return providerFactory(context);
      },
    },
    channelSigner: {
      generateChannelKey: async () => { throw new Error("batch disabled"); },
      randomSalt: async () => { throw new Error("batch disabled"); },
      signVoucher: async () => { throw new Error("batch disabled"); },
    },
    channelStore: {
      loadChannels: async () => [],
      saveChannel: async () => { throw new Error("batch disabled"); },
      retireChannel: async () => { throw new Error("batch disabled"); },
      deleteChannel: async () => { throw new Error("batch disabled"); },
      listRefundableChannels: async () => [],
    },
    addressCodec: {
      scriptPublicKeyForAddress: () => "000051",
      encodeScriptAddress: () => "kaspatest:test",
    },
    transport,
    settlementVerifier: {
      verify: async (input: any) => {
        calls.settlementVerify += 1;
        assert.equal(input.transactionId, EXACT_TX);
        assert.equal(
          input.response.extensions.kaspa.reservationId,
          options.settlementReservationId ?? RESERVATION_ID
        );
        if (options.mutateRecoveryHeader) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return {
          additionalCostAtomic: options.settlementAdditionalCostAtomic ?? "10000002",
          ...(options.settlementOutpoint === null
            ? {}
            : { outpoint: options.settlementOutpoint ?? `${EXACT_TX}:1` }),
          verification: {
            verifierId: "kaspa-chain-observer:test",
            profile: "kaspa-x402-0.1.0-alpha.6-exact-settlement",
            detailDigest: SETTLEMENT_DETAIL_DIGEST,
          },
        };
      },
    },
    recoveryObserver: {
      observe: async ({ signal }: any) => {
        calls.recoveryObserve += 1;
        const status = options.recoveryStatus ?? "pending";
        if (status === "transaction_observed") {
          return { status: "transaction_observed" as const };
        }
        if (status === "payment_response") {
          const retained = Buffer.from(paymentResponseHeader);
          if (options.mutateRecoveryHeader) {
            setTimeout(() => retained.fill(0x41), 0).unref();
          }
          return {
            status: "payment_response" as const,
            paymentResponseHeader: retained,
          };
        }
        if (status === "hung") {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason ?? new Error("aborted")),
              { once: true }
            );
          });
        }
        return { status: "pending" as const, detailDigest: digest("payment-pending") };
      },
    },
    now: () => NOW,
  } as any);

  const egress = {
    request: {
      url: RESOURCE_URL,
      protocol: "https:",
      hostname: "merchant.example",
      port: 443,
      method: "POST",
      body: Uint8Array.from(REQUEST_BODY),
      requestFingerprintInput: {},
      requestFingerprint: REQUEST_FINGERPRINT,
      redirectCount: 0,
      startedAtMs: NOW,
      deadlineAtMs: NOW + 60_000,
      limits: {
        maxRedirects: 1,
        maxResolvedAddresses: 1,
        maxResponseHeaderBytes: 32 * 1024,
        maxResponseBodyBytes: 1024,
        requestTimeoutMs: 60_000,
      },
      connection: {
        addresses: [{ address: "203.0.113.10", family: 4 }],
        port: 443,
        authority: "merchant.example",
        serverName: "merchant.example",
      },
    },
    redirect: async () => { throw new Error("redirect not expected"); },
    responseGuard: () => {
      let headersAccepted = false;
      let bodyBytes = 0;
      return {
        acceptHeaders: (headers: any[]) => {
          assert.equal(headersAccepted, false);
          headersAccepted = true;
          return JSON.stringify(headers).length;
        },
        acceptBodyChunk: (chunk: Uint8Array) => {
          bodyBytes += chunk.byteLength;
          assert.ok(bodyBytes <= 1024);
          return bodyBytes;
        },
        checkTime: () => undefined,
      };
    },
  };

  return {
    module,
    calls,
    execution,
    request,
    paymentRequirements,
    paymentResponseHeader,
    observedStaging,
    preparedStaging,
    stagingEvidence,
    egress,
    paymentSignatures,
    transportRequests,
    makeProvider,
    effect(kind: string, payloadDigest: string) {
      return {
        id: `effect-${kind}`,
        purchaseId: PURCHASE_ID,
        attempt: 1,
        kind,
        idempotencyKey:
          kind === "kaspa-x402-exact"
            ? `payment:${PAYMENT_ID}`
            : `${kind}:${PAYMENT_ID}`,
        state: "executing",
        version: 0,
        payloadDigest,
        preparedRef: payloadDigest,
        preparedByteLength: 1,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      };
    },
    stagingContext(prepared: any) {
      return {
        execution,
        request,
        paymentRequirements,
        staging: {
          preparedBytes: prepared.preparedBytes,
          preparedDigest: prepared.preparedDigest,
          transactionId: prepared.transactionId,
          expectedOutpoint: prepared.expectedOutpoint,
          amountAtomic: prepared.stagingAmountAtomic,
          fundingSource: prepared.fundingSource,
        },
      };
    },
    async prepareExact() {
      return module.prepare({
        execution,
        request,
        paymentRequirements,
        staging: observedStaging,
        additionalCostCeilingAtomic: ADDITIONAL_COST,
      });
    },
    preparedContext(prepared: any) {
      return {
        execution,
        request,
        paymentRequirements,
        staging: observedStaging,
        preparation: {
          preparedBytes: prepared.preparedBytes,
          preparedDigest: prepared.preparedDigest,
          transactionId: prepared.transactionId,
          requiredFinality: prepared.requiredFinality,
          fundingSource: prepared.fundingSource,
        },
      };
    },
  };
}

function paymentRequiredWire() {
  return {
    x402Version: 2,
    resource: { url: RESOURCE_URL, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "kaspa:testnet-10",
        amount: AMOUNT,
        asset: "KAS",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v1",
          finality: "accepted",
          templateId: "kaspa-x402-kip10-additive-v1",
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          borrowOutpoint: { txid: BORROW_TX, index: 0 },
          borrowAmount: "100000000",
          borrowScriptPublicKey: "000051",
          borrowRedeemScript: "51",
          additiveThresholdSompi: "10000000",
          paymentOutputIndex: 1,
          reservationId: RESERVATION_ID,
          reservationExpiresAt: "2099-01-01T00:00:00.000Z",
          assetKind: "native",
          assetDecimals: 8,
        },
      },
    ],
    extensions: {
      "payment-identifier": core.paymentIdentifierExtension({ required: true }),
    },
  };
}

function verifiedArtifact(value: string, profile: string, issuer: string) {
  const bytes = Buffer.from(value, "utf8");
  return {
    bytes,
    mediaType: "application/octet-stream",
    profile,
    issuer,
    declaredDigest: digest(bytes),
    verification: {
      verifierId: "test-verifier",
      profile,
      detailDigest: digest(`verified:${value}`),
    },
  };
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function requestHashHex(value: string): string {
  return Buffer.from(value.slice("sha256:".length), "base64url").toString("hex");
}
