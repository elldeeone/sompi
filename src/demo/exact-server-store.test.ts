import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import type {
  ExactPaymentRecord,
  ExactReservationRecord,
  ExactSettlementCommit,
  PaymentIdentifierRecord,
} from "@kaspa-x402/server";

import {
  DemoExactStoreError,
  SqliteExactServerStateStore,
} from "./exact-server-store.js";

test("exact reservations are immutable, consumable once, and durable across restart", async () => {
  const fixture = fixtureDirectory();
  const filename = path.join(fixture, "exact.sqlite");
  let store = new SqliteExactServerStateStore(filename);
  const reservation = makeReservation();
  await store.saveExactReservation(reservation);
  await store.saveExactReservation(reservation);
  await store.saveExactReservation({
    ...reservation,
    reservedAt: "2032-01-01T00:00:01.000Z",
  });
  assert.deepEqual(await store.loadExactReservation(reservation.reservationId), reservation);
  await store.consumeExactReservation(reservation.reservationId, HASH_B);
  await store.saveExactReservation({
    ...reservation,
    reservedAt: "2032-01-01T00:00:02.000Z",
  });
  await store.consumeExactReservation(reservation.reservationId, HASH_B);
  await assert.rejects(
    store.consumeExactReservation(reservation.reservationId, HASH_C),
    (error: unknown) => error instanceof DemoExactStoreError && error.code === "conflict"
  );
  store.close();

  assert.equal(fs.statSync(fixture).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  store = new SqliteExactServerStateStore(filename);
  try {
    const recovered = await store.loadExactReservation(reservation.reservationId);
    assert.equal(recovered?.status, "consumed");
    assert.equal(recovered?.transactionId, HASH_B);
    assert.equal(store.integrityCheck(), true);
  } finally {
    store.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("exact payment and payment identifier commit atomically and reject replay conflicts", async () => {
  const store = new SqliteExactServerStateStore(":memory:");
  try {
    const first = makeCommit(HASH_B, "purchase-payment-1");
    await store.commitExactPayment(first);
    await store.commitExactPayment(first);
    assert.equal(store.exactPaymentCount(), 1);
    assert.deepEqual(await store.loadExactPayment(HASH_B), first.payment);
    assert.deepEqual(
      await store.loadPaymentIdentifier("purchase-payment-1"),
      first.paymentIdentifier
    );

    const conflictingPayment = makeCommit(HASH_C, "purchase-payment-1");
    await assert.rejects(
      store.commitExactPayment(conflictingPayment),
      (error: unknown) => error instanceof DemoExactStoreError && error.code === "conflict"
    );
    assert.equal(await store.loadExactPayment(HASH_C), undefined, "conflicting commit must be atomic");

    await assert.rejects(
      store.commitExactPayment({
        payment: { ...first.payment, requestFingerprint: HASH_C },
        paymentIdentifier: first.paymentIdentifier,
      }),
      (error: unknown) =>
        error instanceof DemoExactStoreError &&
        (error.code === "invalid_record" || error.code === "conflict")
    );
  } finally {
    store.close();
  }
});

test("exact store rejects hard-linked and permissive database files instead of repairing them", () => {
  const fixture = fixtureDirectory();
  const filename = path.join(fixture, "exact.sqlite");
  const store = new SqliteExactServerStateStore(filename);
  store.close();
  const alias = path.join(fixture, "exact-alias.sqlite");
  fs.linkSync(filename, alias);
  assert.throws(() => new SqliteExactServerStateStore(filename), DemoExactStoreError);
  fs.unlinkSync(alias);
  fs.chmodSync(filename, 0o644);
  assert.throws(() => new SqliteExactServerStateStore(filename), DemoExactStoreError);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("batch, channel, and claim surfaces fail closed in exact-only storage", async () => {
  const store = new SqliteExactServerStateStore(":memory:");
  try {
    assert.deepEqual(await store.listChannels(), []);
    assert.equal(await store.loadChannel(HASH_A), undefined);
    assert.equal(await store.loadCommitment(HASH_A), undefined);
    assert.equal(await store.loadOpenClaimAttempt(HASH_A), undefined);
    await assert.rejects(
      store.retireChannel(HASH_A),
      (error: unknown) =>
        error instanceof DemoExactStoreError && error.code === "unsupported_operation"
    );
  } finally {
    store.close();
  }
});

test("restart rejects semantically tampered exact payment state", async () => {
  const fixture = fixtureDirectory();
  const filename = path.join(fixture, "exact.sqlite");
  const store = new SqliteExactServerStateStore(filename);
  await store.commitExactPayment(makeCommit(HASH_B, "tamper_test_1"));
  store.close();

  const raw = new Database(filename);
  raw.prepare("UPDATE exact_payments SET request_fingerprint = ? WHERE transaction_id = ?")
    .run(HASH_C, HASH_B);
  raw.close();

  assert.throws(
    () => new SqliteExactServerStateStore(filename),
    (error: unknown) => error instanceof DemoExactStoreError
  );
  fs.rmSync(fixture, { recursive: true, force: true });
});

const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const HASH_C = "33".repeat(32);

function makeReservation(): ExactReservationRecord {
  return {
    reservationId: HASH_A,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    borrowOutpoint: { txid: HASH_C, index: 0 },
    borrowAmount: "30000000",
    borrowScriptPublicKey: "000051",
    borrowRedeemScript: "51",
    additiveThresholdSompi: "10000000",
    paymentOutputIndex: 1,
    expiresAt: "2032-01-01T00:05:00.000Z",
    status: "reserved",
    reservedAt: "2032-01-01T00:00:00.000Z",
  };
}

function makeCommit(transactionId: string, paymentIdentifier: string): ExactSettlementCommit {
  const settlement = {
    success: true,
    transaction: transactionId,
    network: "kaspa:testnet-10" as const,
    amount: "20000000",
  };
  const response = {
    status: 200,
    headers: { "PAYMENT-RESPONSE": "settled" },
    body: "deterministic-resource",
  };
  const payment: ExactPaymentRecord = {
    transactionId,
    paymentOutputIndex: 1,
    requestFingerprint: HASH_A,
    paymentRequirementsHash: HASH_B,
    paymentPayloadHash: HASH_C,
    amount: "20000000",
    finality: "accepted",
    settlement,
    response,
  };
  const identifier: PaymentIdentifierRecord = {
    id: paymentIdentifier,
    fingerprint: payment.requestFingerprint,
    paymentPayloadHash: payment.paymentPayloadHash,
    response,
    settlement,
    paymentScopeId: HASH_B,
    transactionId,
    paymentOutputIndex: 1,
  };
  return { payment, paymentIdentifier: identifier };
}

function fixtureDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-demo-exact-store-"));
  fs.chmodSync(directory, 0o700);
  return directory;
}
