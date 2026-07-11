import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import {
  AUTHORITY_MAX_DECISION_EVIDENCE_BYTES,
  AUTHORITY_MAX_WIRE_BYTES,
} from "./protocol.js";

const FRAME_HEADER_BYTES = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const SOCKET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
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
  readonly handle: (authenticatedRequestWire: string) => string | Promise<string>;
  readonly timeoutMs?: number;
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
  private started = false;
  private socketIdentity?: { dev: bigint; ino: bigint };

  constructor(private readonly options: AuthorityUnixServerOptions) {
    validateSocketPath(options.socketPath);
    if (typeof options.handle !== "function") {
      throw new AuthorityTransportError("invalid_configuration");
    }
    this.timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server.on("error", () => {
      // `start` and active sockets surface fixed public errors. Never emit a
      // raw server error through this API or log request bytes.
    });
  }

  async start(): Promise<void> {
    if (this.started) throw new AuthorityTransportError("invalid_configuration");
    prepareSocketDirectory(this.options.socketPath);
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
      fs.chmodSync(this.options.socketPath, SOCKET_MODE);
      const stat = secureSocketStat(this.options.socketPath);
      this.socketIdentity = { dev: BigInt(stat.dev), ino: BigInt(stat.ino) };
      this.started = true;
    } catch {
      await closeNetServer(this.server);
      removeOwnedSocket(this.options.socketPath, this.socketIdentity);
      throw new AuthorityTransportError("unavailable");
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server.listening) await closeNetServer(this.server);
    removeOwnedSocket(this.options.socketPath, this.socketIdentity);
    this.socketIdentity = undefined;
    this.started = false;
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(this.timeoutMs);
    let chunks: Buffer[] = [];
    let total = 0;
    let expected: number | undefined;
    let failed = false;

    const fail = () => {
      if (failed) return;
      failed = true;
      chunks = [];
      socket.destroy();
    };

    socket.on("timeout", fail);
    socket.on("error", () => {
      failed = true;
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      chunks = [];
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
      void Promise.resolve()
        .then(() => this.options.handle(requestWire))
        .then((responseWire) => {
          if (failed || socket.destroyed) return;
          const response = encodeFrame(responseWire, AUTHORITY_MAX_RESPONSE_FRAME_BYTES);
          socket.end(response);
        })
        .catch(fail);
    });
  }
}

export interface AuthorityUnixClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}

export class AuthorityUnixClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthorityUnixClientOptions) {
    validateSocketPath(options.socketPath);
    this.timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  request(authenticatedRequestWire: string): Promise<string> {
    const request = encodeFrame(authenticatedRequestWire);
    try {
      secureSocketStat(this.options.socketPath);
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

function prepareSocketDirectory(socketPath: string): void {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new AuthorityTransportError("invalid_configuration");
  }
}

function secureSocketStat(socketPath: string): fs.Stats {
  const stat = fs.lstatSync(socketPath);
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new AuthorityTransportError("unavailable");
  }
  return stat;
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
