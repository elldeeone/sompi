import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { Sha256Digest } from "../purchase/types.js";
import type {
  AuthorityReplayAcquireInput,
  AuthorityReplayCompleteInput,
} from "./protocol.js";
import { AuthorityReplayStoreError, SqliteAuthorityReplayStore } from "./replay-store.js";

test("SQLite authority replay store fences leases, token conflicts, and stale owners", () => {
  const fixture = fixtureDirectory();
  let now = 1_000;
  const store = new SqliteAuthorityReplayStore(path.join(fixture, "replay.sqlite"), {
    now: () => now,
  });
  try {
    const firstInput = acquireInput("request-one", ["nonce-one", "id-one"], now, 2_000, 10_000);
    const first = store.acquire(firstInput);
    assert.equal(first.status, "acquired");
    if (first.status !== "acquired") return;

    const existing = store.acquire({ ...firstInput, nowMs: 1_500, leaseExpiresAtMs: 2_500 });
    assert.deepEqual(existing, { status: "existing", leaseExpiresAtMs: 2_000 });

    const conflict = store.acquire(
      acquireInput("request-other", ["nonce-one", "id-other"], 1_500, 2_500, 10_000)
    );
    assert.deepEqual(conflict, { status: "conflict" });

    store.renew({
      scope: "approval_request",
      messageDigest: digest("request-one"),
      acquisitionId: first.acquisitionId,
      nowMs: 1_500,
      leaseExpiresAtMs: 3_000,
      expiresAtMs: 10_000,
    });
    assert.deepEqual(
      store.acquire({ ...firstInput, nowMs: 2_500, leaseExpiresAtMs: 3_500 }),
      { status: "existing", leaseExpiresAtMs: 3_000 }
    );

    now = 3_001;
    const takeover = store.acquire({ ...firstInput, nowMs: now, leaseExpiresAtMs: 4_001 });
    assert.equal(takeover.status, "acquired");
    if (takeover.status !== "acquired") return;
    assert.notEqual(takeover.acquisitionId, first.acquisitionId);

    assert.throws(
      () => store.complete(completion(first.acquisitionId, "request-one", 10_000)),
      AuthorityReplayStoreError
    );
    store.complete(completion(takeover.acquisitionId, "request-one", 10_000));
    assert.equal(store.lookup({ scope: "approval_request", messageDigest: digest("request-one") })?.result, RESULT);
  } finally {
    store.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("completed replay output survives close and crash-style reopen with secure modes", () => {
  const fixture = fixtureDirectory();
  const filename = path.join(fixture, "replay.sqlite");
  let now = 10_000;
  let store = new SqliteAuthorityReplayStore(filename, { now: () => now });
  const input = acquireInput("durable-request", ["durable-nonce", "durable-id"], now, 20_000, 60_000);
  const acquired = store.acquire(input);
  assert.equal(acquired.status, "acquired");
  if (acquired.status !== "acquired") return;
  store.complete(completion(acquired.acquisitionId, "durable-request", 60_000));
  store.close();

  assert.equal(fs.statSync(fixture).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);

  now = 30_000;
  store = new SqliteAuthorityReplayStore(filename, { now: () => now });
  try {
    assert.deepEqual(
      store.lookup({ scope: "approval_request", messageDigest: digest("durable-request") }),
      {
        scope: "approval_request",
        messageDigest: digest("durable-request"),
        resultDigest: digest(RESULT),
        result: RESULT,
        expiresAtMs: 60_000,
      }
    );
    const replay = store.acquire({ ...input, nowMs: now, leaseExpiresAtMs: 40_000 });
    assert.equal(replay.status, "existing");
    assert.equal(store.integrityCheck(), true);
  } finally {
    store.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("expired acquisitions cannot complete until a fenced takeover", () => {
  const fixture = fixtureDirectory();
  let now = 1_000;
  const store = new SqliteAuthorityReplayStore(path.join(fixture, "replay.sqlite"), {
    now: () => now,
  });
  try {
    const input = acquireInput("expired-request", ["expired-nonce", "expired-id"], now, 2_000, 10_000);
    const acquired = store.acquire(input);
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") return;
    now = 2_001;
    assert.throws(
      () => store.complete(completion(acquired.acquisitionId, "expired-request", 10_000)),
      AuthorityReplayStoreError
    );
    const takeover = store.acquire({ ...input, nowMs: now, leaseExpiresAtMs: 3_001 });
    assert.equal(takeover.status, "acquired");
  } finally {
    store.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

const RESULT = '{"status":"recorded"}';

function acquireInput(
  message: string,
  tokens: readonly string[],
  nowMs: number,
  leaseExpiresAtMs: number,
  expiresAtMs: number
): AuthorityReplayAcquireInput {
  return {
    scope: "approval_request",
    messageDigest: digest(message),
    tokenDigests: tokens.map(digest),
    nowMs,
    leaseExpiresAtMs,
    expiresAtMs,
  };
}

function completion(
  acquisitionId: string,
  message: string,
  expiresAtMs: number
): AuthorityReplayCompleteInput {
  return {
    scope: "approval_request",
    messageDigest: digest(message),
    acquisitionId,
    resultDigest: digest(RESULT),
    result: RESULT,
    expiresAtMs,
  };
}

function digest(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}` as Sha256Digest;
}

function fixtureDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-authority-replay-"));
  fs.chmodSync(directory, 0o700);
  return directory;
}
