import * as fs from "node:fs";
import * as path from "node:path";

import {
  canonicalAgentApiCredentialBytes,
  canonicalRecoveryApiCredentialBytes,
  generateAgentApiCredential,
  generateRecoveryApiCredential,
} from "../api/credential.js";

export interface InstallApiCredentialOptions {
  readonly operatorUserId: number;
  readonly runtimeGroupId: number;
  /** Hermetic test capability; never accepted by the production CLI. */
  readonly allowSameUserForTests?: boolean;
}

export class ApiCredentialInstallError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiCredentialInstallError";
  }
}

/** Create the MCP/API bearer capability without printing or returning its token. */
export function installAgentApiCredential(
  filename: string,
  options: InstallApiCredentialOptions
): Readonly<{ filename: string; credentialId: string }> {
  return installApiCredential(filename, options, "agent");
}

/** Create the operator-only recovery bearer without printing or returning its token. */
export function installRecoveryApiCredential(
  filename: string,
  options: InstallApiCredentialOptions
): Readonly<{ filename: string; credentialId: string }> {
  return installApiCredential(filename, options, "recovery");
}

function installApiCredential(
  filename: string,
  options: InstallApiCredentialOptions,
  role: "agent" | "recovery"
): Readonly<{ filename: string; credentialId: string }> {
  const resolved = path.resolve(filename);
  const directory = path.dirname(resolved);
  const mode = options.allowSameUserForTests ? 0o600 : 0o640;
  validateId(options.operatorUserId, "operator user ID");
  validateId(options.runtimeGroupId, "runtime group ID");
  if (fs.existsSync(resolved)) throw new ApiCredentialInstallError(`${role} API credential already exists`);
  try {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true, mode: options.allowSameUserForTests ? 0o700 : 0o750 });
    }
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ApiCredentialInstallError(`${role} API credential directory is invalid`);
    const generated = role === "agent"
      ? (() => {
          const credential = generateAgentApiCredential();
          return { credential, bytes: canonicalAgentApiCredentialBytes(credential) };
        })()
      : (() => {
          const credential = generateRecoveryApiCredential();
          return { credential, bytes: canonicalRecoveryApiCredentialBytes(credential) };
        })();
    const { credential, bytes } = generated;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(), mode);
      fs.fchmodSync(descriptor, mode);
      if (!options.allowSameUserForTests) fs.fchownSync(descriptor, options.operatorUserId, options.runtimeGroupId);
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.byteLength || (stat.mode & 0o777) !== mode) {
        throw new ApiCredentialInstallError(`${role} API credential publication is invalid`);
      }
      fs.closeSync(descriptor);
      descriptor = undefined;
      const parentDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
      return Object.freeze({ filename: resolved, credentialId: credential.id });
    } finally {
      bytes.fill(0);
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  } catch (cause) {
    if (cause instanceof ApiCredentialInstallError) throw cause;
    throw new ApiCredentialInstallError(`${role} API credential could not be installed`, { cause });
  }
}

function validateId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new ApiCredentialInstallError(`${label} is invalid`);
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}
