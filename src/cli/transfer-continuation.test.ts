import assert from "node:assert/strict";
import test from "node:test";

import type { TransferCreateRequest } from "../api/contracts.js";
import type { TransferView } from "../transfer/types.js";
import {
  runTransferCommand,
  runTransferRecoveryCommand,
  type TransferContinuationClient,
} from "./transfer-continuation.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const DESTINATION = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
const request = Object.freeze({
  requestKey: "transfer-one",
  destination: DESTINATION,
  amountKas: "0.5",
}) satisfies TransferCreateRequest;

test("transfer command completes one durable Transfer without replacement", async () => {
  const submitted = view("submitted");
  const settled = view("settled");
  const receipted = view("receipted");
  const client = fakeClient(submitted, [settled, receipted]);

  const result = await runTransferCommand(client, request, { wait: async () => {} });

  assert.equal(result.state, "receipted");
  assert.equal(client.transferCalls, 1);
  assert.deepEqual(client.recoverIds, [submitted.id, submitted.id]);
});

test("unchanged Transfer recovery backs off while retaining one identity", async () => {
  const submitted = view("submitted");
  const client = fakeClient(submitted, [submitted, submitted, view("receipted")]);
  const waits: number[] = [];

  const result = await runTransferCommand(client, request, {
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result.state, "receipted");
  assert.deepEqual(client.recoverIds, [submitted.id, submitted.id, submitted.id]);
  assert.deepEqual(waits, [250, 500]);
});

test("terminal Transfer returns without a recovery call", async () => {
  const denied = view("denied");
  const client = fakeClient(denied, []);

  assert.equal((await runTransferCommand(client, request)).state, "denied");
  assert.deepEqual(client.recoverIds, []);
});

test("Transfer recovery limit returns the last honest view", async () => {
  const submitted = view("submitted");
  const client = fakeClient(submitted, [submitted, submitted]);

  const result = await runTransferCommand(client, request, {
    maxRecoveryCalls: 2,
    wait: async () => {},
  });

  assert.equal(result.state, "submitted");
  assert.deepEqual(client.recoverIds, [submitted.id, submitted.id]);
});

test("Transfer deadline aborts a hanging recovery and returns the last honest view", async () => {
  const submitted = view("submitted");
  let recoveryCalls = 0;
  const client: TransferContinuationClient = {
    async transfer() { return submitted; },
    async transferRecover(_transferId, signal) {
      recoveryCalls += 1;
      return new Promise<TransferView>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };

  const result = await runTransferCommand(client, request, { deadlineMs: 10 });

  assert.equal(result.state, "submitted");
  assert.equal(recoveryCalls, 1);
});

test("explicit Transfer recovery includes its first request in its bounds", async () => {
  const submitted = view("submitted");
  const signals: Array<AbortSignal | undefined> = [];
  const client: TransferContinuationClient = {
    async transfer() { throw new Error("transfer must not be called"); },
    async transferRecover(_transferId, signal) {
      signals.push(signal);
      return submitted;
    },
  };

  const result = await runTransferRecoveryCommand(client, submitted.id, {
    maxRecoveryCalls: 1,
    wait: async () => {},
  });

  assert.equal(result.state, "submitted");
  assert.equal(signals.length, 1);
  assert.ok(signals[0]);
});

test("explicit Transfer recovery aborts a hanging first request", async () => {
  const client: TransferContinuationClient = {
    async transfer() { throw new Error("transfer must not be called"); },
    async transferRecover(_transferId, signal) {
      assert.ok(signal);
      return new Promise<TransferView>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };

  await assert.rejects(
    runTransferRecoveryCommand(client, "trf_1111111111111111111111", { deadlineMs: 10 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "DEADLINE_EXCEEDED",
  );
});

test("Transfer continuation rejects changed identity or request key", async () => {
  const submitted = view("submitted");
  const otherId = view("receipted", "trf_2222222222222222222222");
  const changedRequest = { ...view("receipted"), requestKey: "other-transfer" };

  await assert.rejects(
    runTransferCommand(fakeClient(submitted, [otherId]), request),
    /unexpected Transfer identity/,
  );
  await assert.rejects(
    runTransferCommand(fakeClient(changedRequest, []), request),
    /unexpected Transfer identity/,
  );
});

function fakeClient(initial: TransferView, recovery: TransferView[]): TransferContinuationClient & {
  transferCalls: number;
  recoverIds: string[];
} {
  return {
    transferCalls: 0,
    recoverIds: [],
    async transfer() {
      this.transferCalls += 1;
      return initial;
    },
    async transferRecover(transferId) {
      this.recoverIds.push(transferId);
      const next = recovery.shift();
      assert.ok(next, "unexpected recovery call");
      return next;
    },
  };
}

function view(
  state: TransferView["state"],
  id = "trf_1111111111111111111111",
): TransferView {
  const receipted = state === "receipted";
  const inProgress = ["funds_reserved", "prepared", "submitted", "settled"].includes(state);
  return {
    id,
    requestKey: request.requestKey,
    requestDigest: `sha256:${"A".repeat(43)}`,
    state,
    summary: state,
    display: {
      amount: amount("50000000"),
      feeCeiling: amount("25000000"),
      maximumTotal: amount("75000000"),
      ...(state === "settled" || receipted ? { actualFee: amount("100000") } : {}),
    },
    destination: DESTINATION,
    amountAtomic: "50000000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    sourceVaultAddress: ADDRESS,
    sourceVaultDigest: `sha256:${"B".repeat(43)}`,
    feeCeilingAtomic: "25000000",
    maximumTotalAtomic: "75000000",
    expiresAtMs: 2_000_000_000_000,
    policyDigest: `sha256:${"C".repeat(43)}`,
    manifestRevision: 1,
    manifestDigest: `sha256:${"D".repeat(43)}`,
    finalityFloor: "accepted",
    ...(state === "settled" || receipted
      ? { transactionId: "1".repeat(64), actualFeeAtomic: "100000" }
      : {}),
    ...(receipted ? {
      receipt: {
        profile: "urn:sompi:receipt:transfer:1",
        transferId: id,
        requestKey: request.requestKey,
        destination: DESTINATION,
        amountAtomic: "50000000",
        feeAtomic: "100000",
        network: "kaspa:testnet-10",
        fundingSource: "vault-treasury",
        fundingSummary: "Sent securely from your protected Sompi wallet.",
        transactionId: "1".repeat(64),
        finality: "accepted",
        settledAt: "2030-01-01T00:00:00.000Z",
      },
    } : {}),
    version: receipted ? 6 : 4,
    createdAtMs: 1_900_000_000_000,
    updatedAtMs: 1_900_000_000_000,
    recoveryRequired: state === "failed_recoverable",
    safeToRetry: state === "created" || state === "awaiting_authority",
    userAction: state === "failed_recoverable"
      ? "recover"
      : inProgress
        ? "wait"
        : state === "awaiting_authority"
          ? "approve_or_deny"
          : "none",
  };
}

function amount(atomic: string) {
  const kas = atomic === "0"
    ? "0"
    : `${BigInt(atomic) / 100_000_000n}.${(BigInt(atomic) % 100_000_000n).toString().padStart(8, "0")}`.replace(/\.0+$/, "").replace(/(\.[0-9]*?)0+$/, "$1");
  return { atomic, kas, unit: "tKAS" as const, display: `${kas} tKAS` };
}
