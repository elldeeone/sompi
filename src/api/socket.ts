import * as fs from "node:fs";
import * as path from "node:path";

const SOCKET_MODE = 0o660;
const DIRECTORY_MODE = 0o710;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export interface SompiApiSocketAccess {
  readonly expectedServerUserId: number;
  readonly runtimeGroupId: number;
}

export class SompiApiSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SompiApiSocketError";
  }
}

export function validateSompiApiSocketPath(socketPath: string): void {
  if (
    process.platform === "win32" ||
    typeof socketPath !== "string" ||
    socketPath.length === 0 ||
    !path.isAbsolute(socketPath) ||
    path.resolve(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new SompiApiSocketError("Sompi API socket path is invalid");
  }
}

export function prepareSompiApiSocketDirectory(
  socketPath: string,
  access: SompiApiSocketAccess
): void {
  validateAccess(access);
  validateSompiApiSocketPath(socketPath);
  if (currentUserId() !== access.expectedServerUserId) {
    throw new SompiApiSocketError("Sompi API server must run as the configured socket owner");
  }
  const directory = path.dirname(socketPath);
  const stat = fs.lstatSync(directory);
  assertSecureDirectory(directory, stat, access);
}

export function installAndVerifySompiApiSocket(
  socketPath: string,
  access: SompiApiSocketAccess,
  expectedIdentity: Readonly<{ dev: bigint; ino: bigint }>
): void {
  fs.chownSync(socketPath, access.expectedServerUserId, access.runtimeGroupId);
  fs.chmodSync(socketPath, SOCKET_MODE);
  const stat = verifySompiApiSocketForClient(socketPath, access);
  if (BigInt(stat.dev) !== expectedIdentity.dev || BigInt(stat.ino) !== expectedIdentity.ino) {
    throw new SompiApiSocketError("Sompi API socket identity changed during startup");
  }
}

export function verifySompiApiSocketForClient(
  socketPath: string,
  access: SompiApiSocketAccess
): fs.Stats {
  validateAccess(access);
  validateSompiApiSocketPath(socketPath);
  const directory = path.dirname(socketPath);
  const directoryStat = fs.lstatSync(directory);
  assertSecureDirectory(directory, directoryStat, access);
  const stat = fs.lstatSync(socketPath);
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== access.expectedServerUserId ||
    stat.gid !== access.runtimeGroupId ||
    (stat.mode & 0o777) !== SOCKET_MODE
  ) {
    throw new SompiApiSocketError("Sompi API socket is not securely installed");
  }
  return stat;
}

export function removeOwnedSompiApiSocket(
  socketPath: string,
  identity: Readonly<{ dev: bigint; ino: bigint }> | undefined
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

function assertSecureDirectory(
  directory: string,
  stat: fs.Stats,
  access: SompiApiSocketAccess
): void {
  let realDirectory: string;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch {
    throw new SompiApiSocketError("Sompi API socket directory is unavailable");
  }
  if (
    realDirectory !== directory ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== access.expectedServerUserId ||
    stat.gid !== access.runtimeGroupId ||
    (stat.mode & 0o777) !== DIRECTORY_MODE ||
    !currentGroupIds().includes(access.runtimeGroupId)
  ) {
    throw new SompiApiSocketError("Sompi API socket directory is not securely installed");
  }
}

function validateAccess(access: SompiApiSocketAccess): void {
  for (const value of [access.expectedServerUserId, access.runtimeGroupId]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
      throw new SompiApiSocketError("Sompi API socket access configuration is invalid");
    }
  }
}

function currentUserId(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function currentGroupIds(): readonly number[] {
  if (typeof process.getgroups === "function") return process.getgroups();
  return typeof process.getgid === "function" ? [process.getgid()] : [0];
}
