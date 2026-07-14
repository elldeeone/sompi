import assert from "node:assert/strict";
import test from "node:test";

import type {
  PinnedHttpTransport,
  PinnedHttpTransportRequest,
  PinnedHttpTransportResponse,
} from "../../http/pinned-transport.js";
import { EgressPolicy, EgressPolicyError } from "../../purchase/egress-policy.js";
import { createPaymentIdentifier, evidenceDigest } from "../../purchase/identity.js";
import type {
  CommerceAuthorizationContext,
  PurchaseEgressSession,
} from "../../purchase/coordinator.js";
import {
  FIXED_NOW,
  fixedVerifiedCheckout,
  fixedVerifiedMandates,
} from "./test-fixtures.js";
import {
  Ap2HttpCommerceAuthorizationModule,
} from "./commerce-authorization-module.js";
import type { VerifiedAp2CommerceEvidence } from "./paid-response-verifier.js";

const NOW_MS = (FIXED_NOW + 20) * 1_000;

test("Merchant authorization refuses redirects and propagates egress header/body limits", async () => {
  const redirect = await fixture(async () => response(302, [], new Uint8Array()));
  await assert.rejects(
    redirect.present(),
    /must not redirect/
  );

  const headers = await fixture(
    async () => response(200, [["x-long", "a".repeat(64)]], new Uint8Array()),
    { maxResponseHeaderBytes: 32 }
  );
  await assert.rejects(
    headers.present(),
    (error: unknown) =>
      error instanceof EgressPolicyError && error.code === "response_headers_too_large"
  );

  const body = await fixture(
    async () => response(200, [], Buffer.from("123456", "ascii")),
    { maxResponseBodyBytes: 5 }
  );
  await assert.rejects(
    body.present(),
    (error: unknown) =>
      error instanceof EgressPolicyError && error.code === "response_body_too_large"
  );
});

test("Merchant authorization enforces its adapter-local body cap", async () => {
  let transportSignal: AbortSignal | undefined;
  const oversized = await fixture(async (request) => {
    transportSignal = request.signal;
    return response(200, [], Buffer.alloc(256 * 1024 + 1, 0x61));
  }, { maxResponseBodyBytes: 512 * 1024 });
  await assert.rejects(oversized.present(), /body is oversized/);
  assert.equal(transportSignal?.aborted, true);
});

test("Merchant authorization links caller cancellation into the active transport", async () => {
  const controller = new AbortController();
  let transportStarted!: () => void;
  const started = new Promise<void>((resolve) => { transportStarted = resolve; });
  let transportAborted = false;
  const active = await fixture((request) => {
    transportStarted();
    return new Promise<PinnedHttpTransportResponse>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        transportAborted = true;
        reject(request.signal.reason);
      }, { once: true });
    });
  });
  const pending = active.present(controller.signal);
  await started;
  controller.abort(new Error("caller cancelled the Purchase"));
  await assert.rejects(pending, /caller cancelled/);
  assert.equal(transportAborted, true);
});

test("Merchant authorization aborts an unresponsive transport at the egress deadline", async () => {
  let transportAborted = false;
  const stalled = await fixture((request) =>
    new Promise<PinnedHttpTransportResponse>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        transportAborted = true;
        reject(request.signal.reason);
      }, { once: true });
    }),
  { requestTimeoutMs: 5 });
  await assert.rejects(
    stalled.present(),
    /deadline exceeded/
  );
  assert.equal(transportAborted, true);
});

test("Merchant authorization observation returns retry permission only for an exact 404", async () => {
  const missing = await fixture(async () => response(404, [], new Uint8Array()));
  const observation = await missing.module.observe({
    context: missing.context,
    effect: {} as never,
    egress: missing.egress,
  });
  assert.deepEqual(observation, {
    status: "not_found",
    safeToRetry: true,
    detailDigest: evidenceDigest("ap2-commerce-authorization:not-found"),
  });

  const unavailable = await fixture(async () => response(503, [], Buffer.from("pending")));
  const pending = await unavailable.module.observe({
    context: unavailable.context,
    effect: {} as never,
    egress: unavailable.egress,
  });
  assert.equal(pending.status, "pending");
  assert.equal("safeToRetry" in pending, false);
});

async function fixture(
  send: PinnedHttpTransport["send"],
  limits: Partial<{
    maxResponseHeaderBytes: number;
    maxResponseBodyBytes: number;
    requestTimeoutMs: number;
  }> = {}
) {
  const checkout = await fixedVerifiedCheckout();
  const mandates = await fixedVerifiedMandates(checkout);
  const authorizationEvidenceDigest = evidenceDigest("commerce-authorization-test");
  const evidence: VerifiedAp2CommerceEvidence = Object.freeze({
    checkout,
    mandates,
    authorizationEvidenceDigest,
  });
  const policy = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    limits,
    now: () => NOW_MS,
  });
  const request = await policy.validateRequest({
    url: checkout.resourceUrl,
    method: checkout.method,
  });
  const egress: PurchaseEgressSession = Object.freeze({
    request,
    requestFor: (
      input: Parameters<PurchaseEgressSession["requestFor"]>[0]
    ) => policy.validateRequest(input),
    redirect: (
      previous: Parameters<PurchaseEgressSession["redirect"]>[0],
      location: Parameters<PurchaseEgressSession["redirect"]>[1],
      override?: Parameters<PurchaseEgressSession["redirect"]>[2]
    ) =>
      policy.validateRedirect(previous, location, override),
    responseGuard: (
      hop: Parameters<PurchaseEgressSession["responseGuard"]>[0],
      abort: Parameters<PurchaseEgressSession["responseGuard"]>[1]
    ) => policy.createResponseGuard(hop, abort),
  });
  const context: CommerceAuthorizationContext = Object.freeze({
    purchaseId: checkout.purchaseId,
    paymentIdentifier: createPaymentIdentifier(checkout.purchaseId, 1),
    resourceUrl: checkout.resourceUrl,
    method: checkout.method,
    checkoutDigest: checkout.checkoutDigest,
    authorizationEvidenceDigest,
    resourceFingerprint: checkout.terms.resourceFingerprint,
    merchantId: checkout.terms.merchant.id,
    merchantOrigin: checkout.terms.merchant.origin,
    amountAtomic: checkout.terms.amountAtomic,
    asset: checkout.terms.asset,
    network: checkout.terms.network,
    payTo: checkout.terms.payTo,
  });
  const module = new Ap2HttpCommerceAuthorizationModule({
    evidenceSource: { load: async () => evidence },
    transport: { send },
    now: () => NOW_MS,
  });
  return {
    module,
    context,
    egress,
    present: (signal = new AbortController().signal) => module.present({
      context,
      effect: {} as never,
      egress,
      signal,
    }),
  };
}

function response(
  status: number,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array
): PinnedHttpTransportResponse {
  return {
    status,
    headers,
    body: (async function* () {
      if (body.byteLength > 0) yield Uint8Array.from(body);
    })(),
  };
}
