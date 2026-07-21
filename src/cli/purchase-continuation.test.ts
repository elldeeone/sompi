import assert from "node:assert/strict";
import test from "node:test";

import type { PurchaseCreateRequest } from "../api/contracts.js";
import type { PurchaseId, PurchaseRequestKey, PurchaseView, Sha256Digest } from "../purchase/types.js";
import {
  runPurchaseCommand,
  runPurchaseRecoveryCommand,
  type PurchaseContinuationClient,
} from "./purchase-continuation.js";

const request = Object.freeze({
  requestKey: "purchase-one",
  url: "https://merchant.example/report",
  method: "GET",
}) satisfies PurchaseCreateRequest;

test("purchase command completes one durable Purchase without replacement", async () => {
  const planned = view("failed_recoverable", "planned");
  const submitted = view("failed_recoverable", "submitted");
  const receipted = view("receipted", "observed");
  const client = fakeClient(planned, [submitted, receipted]);
  const waits: number[] = [];

  const result = await runPurchaseCommand(client, request, {
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result.state, "receipted");
  assert.equal(client.purchaseCalls, 1);
  assert.deepEqual(client.recoverIds, [planned.id, planned.id]);
  assert.deepEqual(waits, []);
});

test("unchanged recovery backs off while retaining the same Purchase", async () => {
  const unchanged = view("failed_recoverable", "submitted");
  const client = fakeClient(unchanged, [unchanged, unchanged, view("receipted", "observed")]);
  const waits: number[] = [];

  const result = await runPurchaseCommand(client, request, {
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result.state, "receipted");
  assert.deepEqual(client.recoverIds, [unchanged.id, unchanged.id, unchanged.id]);
  assert.deepEqual(waits, [250, 500]);
});

test("terminal Purchase returns without a recovery call", async () => {
  const denied = view("denied", "planned");
  const client = fakeClient(denied, []);

  const result = await runPurchaseCommand(client, request);

  assert.equal(result.state, "denied");
  assert.equal(client.purchaseCalls, 1);
  assert.deepEqual(client.recoverIds, []);
});

test("recovery limit returns the last honest recoverable view", async () => {
  const unchanged = view("failed_recoverable", "submitted");
  const client = fakeClient(unchanged, [unchanged, unchanged, unchanged]);

  const result = await runPurchaseCommand(client, request, {
    maxRecoveryCalls: 3,
    wait: async () => {},
  });

  assert.equal(result.state, "failed_recoverable");
  assert.equal(client.purchaseCalls, 1);
  assert.deepEqual(client.recoverIds, [unchanged.id, unchanged.id, unchanged.id]);
});

test("deadline stops polling without another recovery", async () => {
  const unchanged = view("failed_recoverable", "submitted");
  const client = fakeClient(unchanged, [unchanged, view("receipted", "observed")]);
  let now = 0;

  const result = await runPurchaseCommand(client, request, {
    deadlineMs: 100,
    now: () => now,
    wait: async (milliseconds) => { now += milliseconds; },
  });

  assert.equal(result.state, "failed_recoverable");
  assert.deepEqual(client.recoverIds, [unchanged.id]);
});

test("deadline aborts a hanging recovery and returns the last honest view", async () => {
  const unchanged = view("failed_recoverable", "submitted");
  let recoveryCalls = 0;
  const client: PurchaseContinuationClient = {
    async purchase() {
      return unchanged;
    },
    async recover(_purchaseId, signal) {
      recoveryCalls += 1;
      return new Promise<PurchaseView>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };

  const result = await runPurchaseCommand(client, request, { deadlineMs: 10 });

  assert.equal(result.state, "failed_recoverable");
  assert.equal(recoveryCalls, 1);
});

test("non-deadline recovery errors remain visible", async () => {
  const unchanged = view("failed_recoverable", "submitted");
  const client: PurchaseContinuationClient = {
    async purchase() {
      return unchanged;
    },
    async recover() {
      throw new Error("recovery transport failed");
    },
  };

  await assert.rejects(
    runPurchaseCommand(client, request),
    /recovery transport failed/,
  );
});

test("explicit recover command also completes through the same bounded path", async () => {
  const planned = view("failed_recoverable", "planned");
  const submitted = view("failed_recoverable", "submitted");
  const receipted = view("receipted", "observed");
  const client = fakeClient(planned, [submitted, receipted]);

  const result = await runPurchaseRecoveryCommand(client, planned.id, {
    wait: async () => {},
  });

  assert.equal(result.state, "receipted");
  assert.equal(client.purchaseCalls, 0);
  assert.deepEqual(client.recoverIds, [planned.id, planned.id]);
});

test("explicit recovery includes its first request in the deadline and call limit", async () => {
  const unchanged = view("failed_recoverable", "submitted");
  const signals: Array<AbortSignal | undefined> = [];
  const client: PurchaseContinuationClient = {
    async purchase() {
      throw new Error("purchase must not be called");
    },
    async recover(_purchaseId, signal) {
      signals.push(signal);
      return unchanged;
    },
  };

  const result = await runPurchaseRecoveryCommand(client, unchanged.id, {
    maxRecoveryCalls: 1,
    wait: async () => {},
  });

  assert.equal(result.state, "failed_recoverable");
  assert.equal(signals.length, 1);
  assert.ok(signals[0]);
});

test("explicit recovery aborts a hanging first request at its own deadline", async () => {
  let recoveryCalls = 0;
  const client: PurchaseContinuationClient = {
    async purchase() {
      throw new Error("purchase must not be called");
    },
    async recover(_purchaseId, signal) {
      recoveryCalls += 1;
      assert.ok(signal);
      return new Promise<PurchaseView>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };

  await assert.rejects(
    runPurchaseRecoveryCommand(client, "pur_1111111111111111111111", { deadlineMs: 10 }),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "DEADLINE_EXCEEDED",
  );
  assert.equal(recoveryCalls, 1);
});

test("recovery rejects an API response that changes Purchase identity", async () => {
  const planned = view("failed_recoverable", "planned");
  const other = view("receipted", "observed", "pur_2222222222222222222222");
  const client = fakeClient(planned, [other]);

  await assert.rejects(
    runPurchaseCommand(client, request),
    /unexpected Purchase identity/,
  );
  assert.equal(client.purchaseCalls, 1);
});

test("purchase command rejects an initial response with another request key", async () => {
  const wrong = {
    ...view("receipted", "observed"),
    requestKey: "another-request" as PurchaseRequestKey,
  };
  const client = fakeClient(wrong, []);

  await assert.rejects(
    runPurchaseCommand(client, request),
    /unexpected Purchase identity/,
  );
  assert.deepEqual(client.recoverIds, []);
});

test("explicit recovery rejects an initial response for another Purchase", async () => {
  const requested = view("failed_recoverable", "planned");
  const other = view("receipted", "observed", "pur_2222222222222222222222");
  const client = fakeClient(requested, [other]);

  await assert.rejects(
    runPurchaseRecoveryCommand(client, requested.id),
    /unexpected Purchase identity/,
  );
  assert.deepEqual(client.recoverIds, [requested.id]);
});

function fakeClient(initial: PurchaseView, recovery: PurchaseView[]): PurchaseContinuationClient & {
  purchaseCalls: number;
  recoverIds: string[];
} {
  return {
    purchaseCalls: 0,
    recoverIds: [],
    async purchase() {
      this.purchaseCalls += 1;
      return initial;
    },
    async recover(purchaseId) {
      this.recoverIds.push(purchaseId);
      const next = recovery.shift();
      assert.ok(next, "unexpected recovery call");
      return next;
    },
  };
}

function view(
  state: PurchaseView["state"],
  attemptStatus: PurchaseView["paymentAttempts"][number]["status"],
  id = "pur_1111111111111111111111",
): PurchaseView {
  return {
    id: id as PurchaseId,
    requestKey: request.requestKey as PurchaseRequestKey,
    state,
    summary: state,
    userAction: state === "failed_recoverable" ? "recover" : "none",
    resourceFingerprint: "sha256:1111111111111111111111111111111111111111111" as Sha256Digest,
    authorization: { status: state === "denied" ? "denied" : "approved" },
    treasury: { status: state === "receipted" ? "committed" : "reserved" },
    paymentAttempts: [{
      attempt: 1,
      identifier: "pay_1111111111111111111111" as PurchaseView["paymentAttempts"][number]["identifier"],
      status: attemptStatus,
      ...(attemptStatus === "submitted" || attemptStatus === "observed"
        ? { transactionId: "1".repeat(64), finality: "accepted" }
        : {}),
      evidenceDigests: [],
    }],
    ...(state === "receipted" ? {
      settlementEvidence: "sha256:2222222222222222222222222222222222222222222" as Sha256Digest,
      fulfilmentDigest: "sha256:3333333333333333333333333333333333333333333" as Sha256Digest,
      receiptEvidence: ["sha256:4444444444444444444444444444444444444444444" as Sha256Digest],
    } : { receiptEvidence: [] }),
  };
}
