import * as fs from "node:fs";
import * as path from "node:path";

import { loadOperatorManifest } from "./manifest.js";

const MAX_ID = 0x7fffffff;

export class OfflineRuntimeIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OfflineRuntimeIdentityError";
  }
}

interface IdentityOperations {
  getuid(): number;
  getgid(): number;
  setgroups(groups: readonly number[]): void;
  setgid(gid: number): void;
  setuid(uid: number): void;
}

export function enterOfflineOwnerRuntime(env: NodeJS.ProcessEnv = process.env): void {
  const operatorUserId = numericEnvironment(env.SOMPI_OPERATOR_UID, "operator user ID");
  const runtimeUserId = numericEnvironment(env.SOMPI_API_UID, "API user ID");
  const runtimeGroupId = numericEnvironment(env.SOMPI_RUNTIME_GID, "runtime group ID");
  const authorityGroupId = numericEnvironment(env.SOMPI_AUTHORITY_SOCKET_GID, "authority socket group ID");
  const manifestPath = absolutePath(env.SOMPI_OPERATOR_MANIFEST, "Operator Manifest path");
  const manifest = loadOperatorManifest(manifestPath, {
    expectedOperatorUserId: operatorUserId,
    runtimeGroupId,
    readerRole: "operator",
  });
  dropToRuntimeIdentity({
    operatorUserId,
    runtimeUserId,
    runtimeGroupId,
    authorityGroupId,
    dataDirectory: manifest.manifest.dataDirectory,
  });
}

export function dropToRuntimeIdentity(
  input: Readonly<{
    operatorUserId: number;
    runtimeUserId: number;
    runtimeGroupId: number;
    authorityGroupId: number;
    dataDirectory: string;
  }>,
  operations: IdentityOperations = processIdentityOperations(),
): void {
  const operatorUserId = numericId(input.operatorUserId, "operator user ID");
  const runtimeUserId = numericId(input.runtimeUserId, "API user ID");
  const runtimeGroupId = numericId(input.runtimeGroupId, "runtime group ID");
  const authorityGroupId = numericId(input.authorityGroupId, "authority socket group ID");
  const dataDirectory = absolutePath(input.dataDirectory, "Sompi data directory");
  if (operatorUserId !== 0 || operations.getuid() !== operatorUserId) {
    throw new OfflineRuntimeIdentityError("offline owner execution must begin as the declared root operator");
  }
  if (runtimeUserId === 0 || runtimeUserId === operatorUserId) {
    throw new OfflineRuntimeIdentityError("offline owner execution requires a separate non-root API user");
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      dataDirectory,
      fs.constants.O_RDONLY | directoryFlag() | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor);
    const linked = fs.lstatSync(dataDirectory);
    if (
      !opened.isDirectory() ||
      !linked.isDirectory() ||
      linked.isSymbolicLink() ||
      opened.uid !== runtimeUserId ||
      (opened.mode & 0o077) !== 0 ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new OfflineRuntimeIdentityError("Sompi runtime ownership or identity is unsafe for owner execution");
    }
    const primaryGroupId = numericId(opened.gid, "API primary group ID");
    operations.setgroups([...new Set([primaryGroupId, runtimeGroupId, authorityGroupId])]);
    operations.setgid(primaryGroupId);
    operations.setuid(runtimeUserId);
    if (operations.getuid() !== runtimeUserId || operations.getgid() !== primaryGroupId) {
      throw new OfflineRuntimeIdentityError("offline owner execution could not enter the API runtime identity");
    }
  } catch (cause) {
    if (cause instanceof OfflineRuntimeIdentityError) throw cause;
    throw new OfflineRuntimeIdentityError("offline owner runtime identity could not be established", { cause });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function processIdentityOperations(): IdentityOperations {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    typeof process.setgroups !== "function" ||
    typeof process.setgid !== "function" ||
    typeof process.setuid !== "function"
  ) {
    throw new OfflineRuntimeIdentityError("offline owner execution requires POSIX identity controls");
  }
  return {
    getuid: () => process.getuid!(),
    getgid: () => process.getgid!(),
    setgroups: (groups) => process.setgroups!(groups),
    setgid: (gid) => process.setgid!(gid),
    setuid: (uid) => process.setuid!(uid),
  };
}

function numericEnvironment(value: string | undefined, label: string): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new OfflineRuntimeIdentityError(`${label} is unavailable`);
  }
  return numericId(Number(value), label);
}

function numericId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_ID) {
    throw new OfflineRuntimeIdentityError(`${label} is invalid`);
  }
  return value as number;
}

function absolutePath(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new OfflineRuntimeIdentityError(`${label} is invalid`);
  }
  return value;
}

function directoryFlag(): number {
  return typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}
