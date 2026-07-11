import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { AUTHORITY_MAC_KEY_BYTES } from "./protocol.js";
import { AP2_AUTHORITY_REQUEST_TTL_MS } from "../adapters/ap2/authority-module.js";
import { AuthorityKeyProviderError, AuthorityMacKeyFile } from "./key-provider.js";
import {
  AuthorityTransportError,
  AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
  AuthorityUnixClient,
  AuthorityUnixServer,
} from "./transport.js";

test("production decision transport outlives the human authority request window", () => {
  assert(AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS > AP2_AUTHORITY_REQUEST_TTL_MS);
  assert(AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS <= 5 * 60_000);
});

test("Unix authority transport carries exactly one bounded frame with secure permissions", async () => {
  const fixture = fixtureDirectory();
  const socketPath = path.join(fixture, "authority.sock");
  let calls = 0;
  const server = new AuthorityUnixServer({
    socketPath,
    handle: async (wire) => {
      calls += 1;
      return `response:${wire}`;
    },
  });
  try {
    await server.start();
    assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
    const client = new AuthorityUnixClient({ socketPath, timeoutMs: 1_000 });
    assert.equal(await client.request("authenticated-request"), "response:authenticated-request");
    assert.equal(calls, 1);

    await sendTrailingFrame(socketPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "trailing bytes must be rejected before invoking the authority");
  } finally {
    await server.close();
    assert.equal(fs.existsSync(socketPath), false);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Unix authority client times out with a fixed secret-free error", async () => {
  const fixture = fixtureDirectory();
  const socketPath = path.join(fixture, "authority.sock");
  const server = new AuthorityUnixServer({
    socketPath,
    timeoutMs: 500,
    handle: () => new Promise<string>(() => undefined),
  });
  try {
    await server.start();
    const client = new AuthorityUnixClient({ socketPath, timeoutMs: 30 });
    await assert.rejects(
      client.request("authenticated-request"),
      (error: unknown) =>
        error instanceof AuthorityTransportError &&
        error.code === "timeout" &&
        !String(error).includes("authenticated-request")
    );
  } finally {
    await server.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Unix authority transport supports an explicitly pinned shared IPC group", async () => {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return;
  }
  const fixture = fixtureDirectory();
  const socketPath = path.join(fixture, "authority.sock");
  const groupId = process.getgid();
  const userId = process.getuid();
  const server = new AuthorityUnixServer({
    socketPath,
    socketGroupId: groupId,
    handle: async (wire) => `group-response:${wire}`,
  });
  try {
    await server.start();
    const socket = fs.lstatSync(socketPath);
    assert.equal(socket.uid, userId);
    assert.equal(socket.gid, groupId);
    assert.equal(socket.mode & 0o777, 0o660);
    assert.equal(fs.lstatSync(fixture).mode & 0o777, 0o710);
    const client = new AuthorityUnixClient({
      socketPath,
      expectedSocketOwnerUserId: userId,
      socketGroupId: groupId,
    });
    assert.equal(await client.request("authenticated"), "group-response:authenticated");
    fs.chmodSync(fixture, 0o770);
    await assert.rejects(
      client.request("must-not-cross-a-group-writable-directory"),
      (error: unknown) =>
        error instanceof AuthorityTransportError && error.code === "unavailable",
    );
    fs.chmodSync(fixture, 0o710);
    assert.throws(
      () =>
        new AuthorityUnixClient({
          socketPath,
          expectedSocketOwnerUserId: userId,
        }),
      AuthorityTransportError,
    );
  } finally {
    await server.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("authority key files are permission checked and operation copies are zeroized", async () => {
  const fixture = fixtureDirectory();
  const keyPath = path.join(fixture, "authority.key");
  fs.writeFileSync(keyPath, Buffer.alloc(AUTHORITY_MAC_KEY_BYTES, 0xa5), { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  const provider = new AuthorityMacKeyFile(keyPath, "authority-ipc:test:1");
  let observed: Uint8Array | undefined;
  const result = await provider.withAuthentication(async (authentication) => {
    observed = authentication.keyBytes;
    assert(authentication.keyBytes.every((byte) => byte === 0xa5));
    return "ok";
  });
  assert.equal(result, "ok");
  assert(observed?.every((byte) => byte === 0), "operation-owned key bytes must be wiped");

  fs.chmodSync(keyPath, 0o644);
  await assert.rejects(
    provider.withAuthentication(() => undefined),
    (error: unknown) =>
      error instanceof AuthorityKeyProviderError && !String(error).includes(keyPath)
  );
  fs.rmSync(fixture, { recursive: true, force: true });
});

function sendTrailingFrame(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
    socket.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
      else reject(error);
    });
    socket.on("close", () => resolve());
    socket.on("connect", () => {
      socket.end(Buffer.concat([frame("first"), frame("second")]));
    });
  });
}

function frame(value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  const framed = Buffer.allocUnsafe(4 + payload.byteLength);
  framed.writeUInt32BE(payload.byteLength, 0);
  payload.copy(framed, 4);
  return framed;
}

function fixtureDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-authority-transport-"));
  fs.chmodSync(directory, 0o700);
  return directory;
}
