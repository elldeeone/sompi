import * as assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_INLINE_FULFILMENT_BYTES,
  PurchaseProjectionError,
  projectPurchaseSummary,
  projectPurchaseView,
  type PurchaseProjectionSnapshot,
} from "./projection.js";
import { createPaymentIdentifier, createPurchaseId, evidenceDigest } from "./identity.js";
import { PURCHASE_STATES } from "./types.js";
import type { PurchaseRequestKey, PurchaseState } from "./types.js";

test("projects every Purchase state with a concise deterministic summary and stable user action", () => {
  const expectedActions = {
    created: "none",
    terms_bound: "none",
    awaiting_authority: "Approve or deny the exact purchase in the trusted authority.",
    authorised: "none",
    execution_prepared: "none",
    submitted: "none",
    settled: "none",
    fulfilled: "none",
    receipted: "none",
    denied: "Start a new purchase only if the terms or operator decision change.",
    cancelled: "none",
    expired: "Start a new purchase to obtain fresh merchant terms and authorization.",
    failed_recoverable: "Run purchase_recover for this Purchase; do not submit another payment.",
    failed_terminal: "Ask the operator to review the Purchase record; do not retry or pay again.",
  } satisfies Record<PurchaseState, string>;

  for (const state of PURCHASE_STATES) {
    const snapshot = makeSnapshot(state);
    const first = projectPurchaseView(snapshot);
    const second = projectPurchaseView(snapshot);
    assert.deepEqual(second, first);
    assert.equal(first.state, state);
    assert.equal(first.userAction, expectedActions[state]);
    assert.ok(first.summary.length > 0 && first.summary.length <= 240);
    assert.equal(first.summary, projectPurchaseSummary(snapshot));
  }
});

test("amount summaries lead with deterministic testnet KAS projections", () => {
  const snapshot = makeSnapshot("authorised");
  const summary = projectPurchaseSummary(snapshot);

  assert.equal(
    summary,
    "Purchase approved for 0.2 tKAS, with additional costs capped at 0.02 tKAS, from Test Merchant with whitespace. Payment has not been submitted."
  );
  assert.equal(summary.includes("20000000 KAS"), false);
  assert.equal(summary.includes("2000000 KAS"), false);
  assert.equal(projectPurchaseView(snapshot).terms?.amountAtomic, "20000000");
  assert.equal(projectPurchaseView(snapshot).treasury.additionalCostCeilingAtomic, "2000000");
  assert.equal(projectPurchaseView(snapshot).display?.price.display, "0.2 tKAS");
  assert.equal(projectPurchaseView(snapshot).display?.maximumCharge.display, "0.22 tKAS");
});

test("an external effect awaiting reconciliation overrides an otherwise passive state action", () => {
  const snapshot = { ...makeSnapshot("authorised"), recoveryRequired: true };
  const view = projectPurchaseView(snapshot);

  assert.equal(view.state, "authorised");
  assert.equal(
    view.summary,
    "Purchase needs recovery. An existing external effect must be reconciled before any retry."
  );
  assert.equal(
    view.userAction,
    "Run purchase_recover for this Purchase; do not submit another payment."
  );
  assert.equal(projectPurchaseSummary(snapshot), view.summary);
});

test("projection reconstructs safe fields without leaking errors, evidence bytes, or keys", () => {
  const snapshot = makeSnapshot("failed_recoverable") as PurchaseProjectionSnapshot & Record<string, unknown>;
  snapshot.rawError = "secret raw failure";
  snapshot.privateKey = "private-key-material";
  snapshot.evidenceBytes = Buffer.from("signed-secret-evidence");
  (snapshot.terms!.merchant as unknown as Record<string, unknown>).signingKey = "merchant-private-key";
  (snapshot.authorization as unknown as Record<string, unknown>).rawCredential = "raw-authority-credential";
  (snapshot.paymentAttempts[0] as unknown as Record<string, unknown>).preparedBytes = "raw-payment-payload";

  const serialized = JSON.stringify(projectPurchaseView(snapshot));
  for (const forbidden of [
    "secret raw failure",
    "private-key-material",
    "signed-secret-evidence",
    "merchant-private-key",
    "raw-authority-credential",
    "raw-payment-payload",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("small explicitly UTF-8 text fulfilment is inline and exact byte limits are deterministic", () => {
  const atLimit = Buffer.from("x".repeat(MAX_INLINE_FULFILMENT_BYTES), "utf8");
  const snapshot = {
    ...makeSnapshot("fulfilled"),
    fulfilment: {
      digest: evidenceDigest(atLimit),
      bodyBytes: atLimit,
      mediaType: "text/plain; charset=utf-8",
      byteLength: MAX_INLINE_FULFILMENT_BYTES,
      handle: "fulfilment/unused-safe-handle",
    },
  } satisfies PurchaseProjectionSnapshot;

  const view = projectPurchaseView(snapshot);
  assert.equal(view.fulfilmentBody, atLimit.toString("utf8"));
  assert.equal(view.fulfilmentHandle, undefined);
  assert.equal(view.fulfilmentDigest, evidenceDigest(atLimit));
});

test("large fulfilment uses only a validated handle and never returns a partial body", () => {
  const body = Buffer.from("é".repeat(MAX_INLINE_FULFILMENT_BYTES), "utf8");
  const snapshot = {
    ...makeSnapshot("fulfilled"),
    fulfilment: {
      digest: evidenceDigest(body),
      bodyBytes: body,
      mediaType: "text/plain; charset=utf8",
      byteLength: Buffer.byteLength(body),
      handle: "fulfilment/pur_test/resource-1",
    },
  } satisfies PurchaseProjectionSnapshot;

  const view = projectPurchaseView(snapshot);
  assert.equal(view.fulfilmentBody, undefined);
  assert.equal(view.fulfilmentHandle, "fulfilment/pur_test/resource-1");
  assert.equal(view.fulfilmentDigest, evidenceDigest(body));

  assert.throws(
    () => projectPurchaseView({ ...snapshot, fulfilment: { ...snapshot.fulfilment, handle: undefined } }),
    PurchaseProjectionError
  );
  assert.throws(
    () => projectPurchaseView({ ...snapshot, fulfilment: { ...snapshot.fulfilment, handle: "../secret" } }),
    PurchaseProjectionError
  );
});

test("invalid UTF-8 fulfilment bytes return only the opaque handle", () => {
  const body = Buffer.from([0xc3, 0x28]);
  const view = projectPurchaseView({
    ...makeSnapshot("fulfilled"),
    fulfilment: {
      digest: evidenceDigest(body),
      bodyBytes: body,
      mediaType: "text/plain; charset=utf-8",
      byteLength: body.byteLength,
      handle: "fulfilment/invalid-utf8",
    },
  });

  assert.equal(view.fulfilmentBody, undefined);
  assert.equal(view.fulfilmentHandle, "fulfilment/invalid-utf8");
});

test("text without an explicit charset and non-UTF charsets return only opaque handles", () => {
  const body = Buffer.from("merchant response", "utf8");
  for (const mediaType of ["text/plain", "text/plain; charset=iso-8859-1"]) {
    const view = projectPurchaseView({
      ...makeSnapshot("fulfilled"),
      fulfilment: {
        digest: evidenceDigest(body),
        bodyBytes: body,
        mediaType,
        byteLength: body.byteLength,
        handle: "fulfilment/not-explicitly-utf8",
      },
    });
    assert.equal(view.fulfilmentBody, undefined);
    assert.equal(view.fulfilmentHandle, "fulfilment/not-explicitly-utf8");
  }
});

test("UTF-8 aliases are accepted only for textual media types and raw bytes", () => {
  const body = Buffer.from("hello, merchant", "utf8");
  for (const mediaType of [
    "text/plain; charset=utf8",
    "application/json; charset=\"UTF-8\"",
    "application/problem+json; charset=UTF8",
  ]) {
    const view = projectPurchaseView({
      ...makeSnapshot("fulfilled"),
      fulfilment: {
        digest: evidenceDigest(body),
        bodyBytes: body,
        mediaType,
        byteLength: body.byteLength,
        handle: "fulfilment/unused",
      },
    });
    assert.equal(view.fulfilmentBody, "hello, merchant");
    assert.equal(view.fulfilmentHandle, undefined);
  }

  const opaque = projectPurchaseView({
    ...makeSnapshot("fulfilled"),
    fulfilment: {
      digest: evidenceDigest(body),
      bodyBytes: body,
      mediaType: "application/octet-stream; charset=utf-8",
      byteLength: body.byteLength,
      handle: "fulfilment/binary",
    },
  });
  assert.equal(opaque.fulfilmentBody, undefined);
  assert.equal(opaque.fulfilmentHandle, "fulfilment/binary");
});

test("projection rejects inconsistent fulfilment lengths and duplicate payment attempts", () => {
  const snapshot = makeSnapshot("fulfilled");
  assert.throws(
    () =>
      projectPurchaseView({
        ...snapshot,
        fulfilment: { bodyBytes: Buffer.from("hello", "utf8"), byteLength: 4 },
      }),
    PurchaseProjectionError
  );
  assert.throws(
    () =>
      projectPurchaseView({
        ...snapshot,
        paymentAttempts: [snapshot.paymentAttempts[0], snapshot.paymentAttempts[0]],
      }),
    PurchaseProjectionError
  );
});

test("attempts and digest collections are copied into deterministic order", () => {
  const snapshot = makeSnapshot("submitted");
  const purchaseId = snapshot.id;
  const later = {
    attempt: 2,
    identifier: createPaymentIdentifier(purchaseId, 2),
    status: "submitted" as const,
    evidenceDigests: [evidenceDigest("z"), evidenceDigest("a")],
  };
  const projected = projectPurchaseView({
    ...snapshot,
    paymentAttempts: [later, snapshot.paymentAttempts[0]],
    receiptEvidence: [evidenceDigest("receipt-z"), evidenceDigest("receipt-a")],
  });

  assert.deepEqual(projected.paymentAttempts.map((attempt) => attempt.attempt), [1, 2]);
  assert.deepEqual(
    projected.paymentAttempts[1].evidenceDigests,
    [...later.evidenceDigests].sort(compareStrings)
  );
  assert.deepEqual(
    projected.receiptEvidence,
    [...projected.receiptEvidence].sort(compareStrings)
  );
});

function makeSnapshot(state: PurchaseState): PurchaseProjectionSnapshot {
  const id = createPurchaseId(new Uint8Array(16).fill(PURCHASE_STATES.indexOf(state) + 1));
  return {
    id,
    requestKey: `projection:${state}` as PurchaseRequestKey,
    state,
    resourceFingerprint: evidenceDigest(`resource:${state}`),
    terms: {
      merchant: {
        id: "merchant:test",
        name: "Test Merchant\nwith whitespace",
        origin: "https://merchant.example",
      },
      resourceFingerprint: evidenceDigest(`resource:${state}`),
      amountAtomic: "20000000",
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: "kaspatest:merchant",
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest: evidenceDigest(`checkout:${state}`),
    },
    authorization: {
      status: state === "denied" ? "denied" : state === "awaiting_authority" ? "pending" : "approved",
      authorityId: "authority:test",
      evidenceDigest: evidenceDigest(`authority:${state}`),
    },
    treasury: {
      status: state === "receipted" ? "committed" : "reserved",
      amountAtomic: "20000000",
      additionalCostCeilingAtomic: "2000000",
      reservationId: `reservation:${state}`,
      fundingSource: "vault-treasury",
    },
    paymentAttempts: [
      {
        attempt: 1,
        identifier: createPaymentIdentifier(id, 1),
        status: state === "submitted" ? "submitted" : "planned",
        evidenceDigests: [evidenceDigest(`payment:${state}`)],
      },
    ],
    settlementEvidence: state === "settled" ? evidenceDigest("settlement") : undefined,
    fulfilment: state === "fulfilled" || state === "receipted"
      ? { digest: evidenceDigest(`fulfilment:${state}`), handle: `fulfilment/${state}`, byteLength: 10_000 }
      : undefined,
    receiptEvidence: state === "receipted" ? [evidenceDigest("receipt")] : [],
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
