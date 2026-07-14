import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import {
  AUTHORITY_MAX_DECISION_EVIDENCE_BYTES,
  AUTHORITY_MAX_WIRE_BYTES,
} from "./protocol.js";
import type { AdmissionBudgetProjection } from "../admission.js";

const FRAME_HEADER_BYTES = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
export const AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS = 150_000;
export const AUTHORITY_PREAUTH_FRAME_DEADLINE_MS = 2_000;
const SOCKET_MODE = 0o600;
const GROUP_SOCKET_MODE = 0o660;
const DIRECTORY_MODE = 0o700;
// A socket client needs directory traversal and rw access to the socket. It
// does not need directory write access. Keeping the shared group execute-only
// prevents a compromised MCP process from unlinking or replacing the socket.
const GROUP_DIRECTORY_MODE = 0o710;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
export const AUTHORITY_MAX_RESPONSE_FRAME_BYTES =
  AUTHORITY_MAX_WIRE_BYTES + Math.ceil((AUTHORITY_MAX_DECISION_EVIDENCE_BYTES * 4) / 3) + 1_024;

export type AuthorityTransportErrorCode =
  | "invalid_configuration"
  | "unavailable"
  | "timeout"
  | "malformed_frame";

const ERROR_MESSAGES: Readonly<Record<AuthorityTransportErrorCode, string>> = Object.freeze({
  invalid_configuration: "authority transport configuration is invalid",
  unavailable: "authority transport is unavailable",
  timeout: "authority transport timed out",
  malformed_frame: "authority transport frame is malformed",
});

export class AuthorityTransportError extends Error {
  readonly code: AuthorityTransportErrorCode;

  constructor(code: AuthorityTransportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AuthorityTransportError";
    this.code = code;
  }
}

export interface AuthorityUnixServerOptions {
  readonly socketPath: string;
  readonly handle: (authenticatedRequestWire: string, signal?: AbortSignal) => string | Promise<string>;
  readonly timeoutMs?: number;
  /** Manifest projection in production; explicit values are used by hermetic tests. */
  readonly admission?: Pick<AdmissionBudgetProjection, "authorityPreauthSockets">;
  readonly preauthFrameDeadlineMs?: number;
  /** Shared IPC group for a distinct authority UID and MCP UID. */
  readonly socketGroupId?: number;
}

/**
 * One length-prefixed authority request per Unix-domain-socket connection.
 * The handler is not invoked until the peer half-closes, proving there are no
 * trailing bytes or second frame on the connection.
 */
export class AuthorityUnixServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly timeoutMs: number;
  private readonly preauthCapacity: number;
  private readonly preauthFrameDeadlineMs: number;
  private preauthCount = 0;
  private overloadRejections = 0;
  private readonly lifetimes = new Map<net.Socket, AbortController>();
  private started = false;
  private socketIdentity?: { dev: bigint; ino: bigint };

  constructor(private readonly options: AuthorityUnixServerOptions) {
    validateSocketPath(options.socketPath);
    validateOptionalId(options.socketGroupId);
    if (typeof options.handle !== "function") {
      throw new AuthorityTransportError("invalid_configuration");
    }
    this.timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.preauthCapacity = validatePreauthCapacity(options.admission?.authorityPreauthSockets ?? 32);
    this.preauthFrameDeadlineMs = requirePreauthDeadline(
      options.preauthFrameDeadlineMs ?? AUTHORITY_PREAUTH_FRAME_DEADLINE_MS
    );
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server.on("error", () => {
      // `start` and active sockets surface fixed public errors. Never emit a
      // raw server error through this API or log request bytes.
    });
  }

  async start(): Promise<void> {
    if (this.started) throw new AuthorityTransportError("invalid_configuration");
    prepareSocketDirectory(this.options.socketPath, this.options.socketGroupId);
    if (fs.existsSync(this.options.socketPath)) {
      throw new AuthorityTransportError("unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = () => {
        cleanup();
        reject(new AuthorityTransportError("unavailable"));
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.server.off("error", onError);
        this.server.off("listening", onListening);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.socketPath);
    });
    try {
      const created = fs.lstatSync(this.options.socketPath);
      this.socketIdentity = {
        dev: BigInt(created.dev),
        ino: BigInt(created.ino),
      };
      if (this.options.socketGroupId !== undefined) {
        fs.chownSync(
          this.options.socketPath,
          created.uid,
          this.options.socketGroupId
        );
      }
      fs.chmodSync(
        this.options.socketPath,
        this.options.socketGroupId === undefined ? SOCKET_MODE : GROUP_SOCKET_MODE
      );
      const stat = secureSocketStat(this.options.socketPath, {
        expectedOwnerUserId: currentUserId(),
        ...(this.options.socketGroupId === undefined
          ? {}
          : { expectedGroupId: this.options.socketGroupId }),
      });
      if (
        BigInt(stat.dev) !== this.socketIdentity.dev ||
        BigInt(stat.ino) !== this.socketIdentity.ino
      ) {
        throw new AuthorityTransportError("unavailable");
      }
      this.started = true;
    } catch {
      await closeNetServer(this.server);
      removeOwnedSocket(this.options.socketPath, this.socketIdentity);
      throw new AuthorityTransportError("unavailable");
    }
  }

  async close(): Promise<void> {
    const sockets = [...this.sockets];
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.once("close", resolve);
      socket.destroy();
    })));
    for (const controller of this.lifetimes.values()) controller.abort();
    this.lifetimes.clear();
    this.sockets.clear();
    if (this.server.listening) await closeNetServer(this.server);
    removeOwnedSocket(this.options.socketPath, this.socketIdentity);
    this.socketIdentity = undefined;
    this.started = false;
  }

  private accept(socket: net.Socket): void {
    if (this.preauthCount >= this.preauthCapacity) {
      this.overloadRejections += 1;
      socket.destroy();
      return;
    }
    this.preauthCount += 1;
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let preauth = true;
    let deadline: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;
    let chunks: Buffer[] = [];
    let total = 0;
    let expected: number | undefined;
    let failed = false;

    const fail = () => {
      if (failed) return;
      failed = true;
      chunks = [];
      releasePreauth();
      controller?.abort();
      socket.destroy();
    };

    const releasePreauth = () => {
      if (!preauth) return;
      preauth = false;
      this.preauthCount -= 1;
      if (deadline) clearTimeout(deadline);
    };

    deadline = setTimeout(fail, this.preauthFrameDeadlineMs);
    deadline.unref();
    socket.on("timeout", fail);
    socket.on("error", fail);
    socket.on("close", () => {
      this.sockets.delete(socket);
      chunks = [];
      releasePreauth();
      controller?.abort();
      this.lifetimes.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.byteLength;
      if (total > FRAME_HEADER_BYTES + AUTHORITY_MAX_WIRE_BYTES) {
        fail();
        return;
      }
      chunks.push(Buffer.from(chunk));
      const buffered = Buffer.concat(chunks, total);
      if (expected === undefined && buffered.byteLength >= FRAME_HEADER_BYTES) {
        expected = buffered.readUInt32BE(0);
        if (expected === 0 || expected > AUTHORITY_MAX_WIRE_BYTES) {
          fail();
          return;
        }
      }
      if (expected !== undefined && total > FRAME_HEADER_BYTES + expected) fail();
    });
    socket.on("end", () => {
      if (failed || expected === undefined || total !== FRAME_HEADER_BYTES + expected) {
        fail();
        return;
      }
      const frame = Buffer.concat(chunks, total);
      chunks = [];
      let requestWire: string;
      try {
        requestWire = strictUtf8(frame.subarray(FRAME_HEADER_BYTES));
      } catch {
        fail();
        return;
      }
      releasePreauth();
      controller = new AbortController();
      this.lifetimes.set(socket, controller);
      socket.setTimeout(this.timeoutMs);
      void Promise.resolve()
        .then(() => this.options.handle(requestWire, controller!.signal))
        .then((responseWire) => {
          if (failed || socket.destroyed || controller?.signal.aborted) return;
          const response = encodeFrame(responseWire, AUTHORITY_MAX_RESPONSE_FRAME_BYTES);
          socket.end(response);
        })
        .catch(fail);
    });
  }

  admissionStatus(): Readonly<{
    readonly preauthSockets: number;
    readonly budget: number;
    readonly overloadRejections: number;
  }> {
    return Object.freeze({
      preauthSockets: this.preauthCount,
      budget: this.preauthCapacity,
      overloadRejections: this.overloadRejections,
    });
  }
}

export interface AuthorityUnixClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  /** Required together for a socket owned by the separate authority UID. */
  readonly expectedSocketOwnerUserId?: number;
  readonly socketGroupId?: number;
}

export class AuthorityUnixClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthorityUnixClientOptions) {
    validateSocketPath(options.socketPath);
    validateOptionalId(options.expectedSocketOwnerUserId);
    validateOptionalId(options.socketGroupId);
    if (
      (options.expectedSocketOwnerUserId === undefined) !==
      (options.socketGroupId === undefined)
    ) {
      throw new AuthorityTransportError("invalid_configuration");
    }
    this.timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  request(authenticatedRequestWire: string): Promise<string> {
    const request = encodeFrame(authenticatedRequestWire);
    try {
      secureSocketDirectoryForClient(
        this.options.socketPath,
        this.options.socketGroupId
      );
      secureSocketStat(this.options.socketPath, {
        expectedOwnerUserId:
          this.options.expectedSocketOwnerUserId ?? currentUserId(),
        ...(this.options.socketGroupId === undefined
          ? {}
          : { expectedGroupId: this.options.socketGroupId }),
      });
    } catch {
      return Promise.reject(new AuthorityTransportError("unavailable"));
    }

    return new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ path: this.options.socketPath, allowHalfOpen: true });
      let settled = false;
      let chunks: Buffer[] = [];
      let total = 0;
      let expected: number | undefined;

      const finishError = (code: AuthorityTransportErrorCode) => {
        if (settled) return;
        settled = true;
        chunks = [];
        socket.destroy();
        reject(new AuthorityTransportError(code));
      };

      socket.setTimeout(this.timeoutMs);
      socket.on("timeout", () => finishError("timeout"));
      socket.on("error", () => finishError("unavailable"));
      socket.on("connect", () => socket.end(request));
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > FRAME_HEADER_BYTES + AUTHORITY_MAX_RESPONSE_FRAME_BYTES) {
          finishError("malformed_frame");
          return;
        }
        chunks.push(Buffer.from(chunk));
        const buffered = Buffer.concat(chunks, total);
        if (expected === undefined && buffered.byteLength >= FRAME_HEADER_BYTES) {
          expected = buffered.readUInt32BE(0);
          if (expected === 0 || expected > AUTHORITY_MAX_RESPONSE_FRAME_BYTES) {
            finishError("malformed_frame");
            return;
          }
        }
        if (expected !== undefined && total > FRAME_HEADER_BYTES + expected) {
          finishError("malformed_frame");
        }
      });
      socket.on("end", () => {
        if (settled) return;
        if (expected === undefined || total !== FRAME_HEADER_BYTES + expected) {
          finishError("malformed_frame");
          return;
        }
        try {
          const frame = Buffer.concat(chunks, total);
          const response = strictUtf8(frame.subarray(FRAME_HEADER_BYTES));
          settled = true;
          chunks = [];
          resolve(response);
        } catch {
          finishError("malformed_frame");
        }
      });
      socket.on("close", () => {
        if (!settled) finishError("unavailable");
      });
    });
  }
}

function encodeFrame(wire: string, maximumBytes = AUTHORITY_MAX_WIRE_BYTES): Buffer {
  if (typeof wire !== "string") throw new AuthorityTransportError("malformed_frame");
  const payload = Buffer.from(wire, "utf8");
  if (
    payload.byteLength === 0 ||
    payload.byteLength > maximumBytes ||
    payload.toString("utf8") !== wire
  ) {
    throw new AuthorityTransportError("malformed_frame");
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

function strictUtf8(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(value, "utf8").equals(Buffer.from(bytes))) {
    throw new AuthorityTransportError("malformed_frame");
  }
  return value;
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 5 * 60_000) {
    throw new AuthorityTransportError("invalid_configuration");
  }
  return value;
}

function validatePreauthCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_024) {
    throw new AuthorityTransportError("invalid_configuration");
  }
  return value;
}

function requirePreauthDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    throw new AuthorityTransportError("invalid_configuration");
  }
  return value;
}

function validateSocketPath(socketPath: string): void {
  if (
    process.platform === "win32" ||
    typeof socketPath !== "string" ||
    socketPath.length === 0 ||
    !path.isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new AuthorityTransportError("invalid_configuration");
  }
}

function prepareSocketDirectory(socketPath: string, groupId?: number): void {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, {
    recursive: true,
    mode: groupId === undefined ? DIRECTORY_MODE : GROUP_DIRECTORY_MODE,
  });
  let stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AuthorityTransportError("invalid_configuration");
  }
  if (groupId === undefined) {
    if ((stat.mode & 0o077) !== 0 || stat.uid !== currentUserId()) {
      throw new AuthorityTransportError("invalid_configuration");
    }
    return;
  }
  if (stat.uid === currentUserId()) {
    fs.chownSync(directory, stat.uid, groupId);
    fs.chmodSync(directory, GROUP_DIRECTORY_MODE);
    stat = fs.lstatSync(directory);
  }
  if (
    stat.uid !== currentUserId() ||
    stat.gid !== groupId ||
    !currentGroupIds().includes(groupId) ||
    (stat.mode & 0o077) !== 0o010
  ) {
    throw new AuthorityTransportError("invalid_configuration");
  }
}

function secureSocketDirectoryForClient(
  socketPath: string,
  groupId?: number
): void {
  const stat = fs.lstatSync(path.dirname(socketPath));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o002) !== 0) {
    throw new AuthorityTransportError("unavailable");
  }
  if (groupId === undefined) {
    if ((stat.mode & 0o077) !== 0 || stat.uid !== currentUserId()) {
      throw new AuthorityTransportError("unavailable");
    }
    return;
  }
  if (
    stat.gid !== groupId ||
    !currentGroupIds().includes(groupId) ||
    (stat.mode & 0o077) !== 0o010
  ) {
    throw new AuthorityTransportError("unavailable");
  }
}

function secureSocketStat(
  socketPath: string,
  access: { expectedOwnerUserId: number; expectedGroupId?: number }
): fs.Stats {
  const stat = fs.lstatSync(socketPath);
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== access.expectedOwnerUserId ||
    (stat.mode & 0o007) !== 0
  ) {
    throw new AuthorityTransportError("unavailable");
  }
  if (access.expectedGroupId === undefined) {
    if ((stat.mode & 0o070) !== 0) {
      throw new AuthorityTransportError("unavailable");
    }
  } else if (
    stat.gid !== access.expectedGroupId ||
    (stat.mode & 0o060) !== 0o060
  ) {
    throw new AuthorityTransportError("unavailable");
  }
  return stat;
}

function validateOptionalId(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
  ) {
    throw new AuthorityTransportError("invalid_configuration");
  }
}

function currentUserId(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function currentGroupIds(): readonly number[] {
  if (typeof process.getgroups !== "function") {
    return typeof process.getgid === "function" ? [process.getgid()] : [0];
  }
  return process.getgroups();
}

function removeOwnedSocket(
  socketPath: string,
  identity?: { dev: bigint; ino: bigint }
): void {
  if (!identity || !fs.existsSync(socketPath)) return;
  try {
    const stat = fs.lstatSync(socketPath, { bigint: true });
    if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // Never remove a path whose identity cannot be proven.
  }
}

function closeNetServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
