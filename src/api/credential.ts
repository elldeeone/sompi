import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const AGENT_API_CREDENTIAL_SCHEMA = "sompi-agent-api-credential-v1" as const;
export const RECOVERY_API_CREDENTIAL_SCHEMA = "sompi-recovery-api-credential-v1" as const;
const MAX_CREDENTIAL_BYTES = 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AgentApiCredential {
  readonly schema: typeof AGENT_API_CREDENTIAL_SCHEMA;
  readonly id: string;
  readonly token: string;
}

export interface RecoveryApiCredential {
  readonly schema: typeof RECOVERY_API_CREDENTIAL_SCHEMA;
  readonly id: string;
  readonly token: string;
}

export class SompiApiCredentialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SompiApiCredentialError";
  }
}

export function generateAgentApiCredential(): AgentApiCredential {
  return Object.freeze({
    schema: AGENT_API_CREDENTIAL_SCHEMA,
    id: `agent-${randomBytes(12).toString("base64url")}`,
    token: randomBytes(32).toString("base64url"),
  });
}

export function generateRecoveryApiCredential(): RecoveryApiCredential {
  return Object.freeze({
    schema: RECOVERY_API_CREDENTIAL_SCHEMA,
    id: `recovery-${randomBytes(12).toString("base64url")}`,
    token: randomBytes(32).toString("base64url"),
  });
}

export function canonicalAgentApiCredentialBytes(credential: AgentApiCredential): Buffer {
  const parsed = parseAgentApiCredential(credential);
  return Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
}

export function canonicalRecoveryApiCredentialBytes(credential: RecoveryApiCredential): Buffer {
  const parsed = parseRecoveryApiCredential(credential);
  return Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
}

export function parseAgentApiCredential(value: unknown): AgentApiCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SompiApiCredentialError("agent API credential is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "id,schema,token" ||
    record.schema !== AGENT_API_CREDENTIAL_SCHEMA ||
    typeof record.id !== "string" || !/^agent-[A-Za-z0-9_-]{16}$/.test(record.id) ||
    typeof record.token !== "string" || !TOKEN_PATTERN.test(record.token)
  ) {
    throw new SompiApiCredentialError("agent API credential is invalid");
  }
  return Object.freeze({ schema: AGENT_API_CREDENTIAL_SCHEMA, id: record.id, token: record.token });
}

export function parseRecoveryApiCredential(value: unknown): RecoveryApiCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SompiApiCredentialError("recovery API credential is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "id,schema,token" ||
    record.schema !== RECOVERY_API_CREDENTIAL_SCHEMA ||
    typeof record.id !== "string" || !/^recovery-[A-Za-z0-9_-]{16}$/.test(record.id) ||
    typeof record.token !== "string" || !TOKEN_PATTERN.test(record.token)
  ) {
    throw new SompiApiCredentialError("recovery API credential is invalid");
  }
  return Object.freeze({ schema: RECOVERY_API_CREDENTIAL_SCHEMA, id: record.id, token: record.token });
}

/** Stable, no-follow read of an operator-installed least-authority credential. */
export function loadAgentApiCredential(
  filename: string,
  options: Readonly<{ expectedOwnerUserId: number; runtimeGroupId: number; allowSameUserForTests?: boolean }>
): AgentApiCredential {
  return loadCredential(filename, options, parseAgentApiCredential, canonicalAgentApiCredentialBytes, "agent");
}

export function loadRecoveryApiCredential(
  filename: string,
  options: Readonly<{ expectedOwnerUserId: number; runtimeGroupId: number; allowSameUserForTests?: boolean }>
): RecoveryApiCredential {
  return loadCredential(filename, options, parseRecoveryApiCredential, canonicalRecoveryApiCredentialBytes, "recovery");
}

export function agentApiCredentialMatches(credential: AgentApiCredential, authorization: string | undefined): boolean {
  return apiCredentialMatches(credential, authorization);
}

export function recoveryApiCredentialMatches(credential: RecoveryApiCredential, authorization: string | undefined): boolean {
  return apiCredentialMatches(credential, authorization);
}

function apiCredentialMatches(
  credential: Pick<AgentApiCredential | RecoveryApiCredential, "token">,
  authorization: string | undefined
): boolean {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(credential.token, "utf8");
  try {
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  } finally {
    supplied.fill(0);
    expected.fill(0);
  }
}

function loadCredential<T extends AgentApiCredential | RecoveryApiCredential>(
  filename: string,
  options: Readonly<{ expectedOwnerUserId: number; runtimeGroupId: number; allowSameUserForTests?: boolean }>,
  parse: (value: unknown) => T,
  canonicalBytes: (credential: T) => Buffer,
  label: "agent" | "recovery"
): T {
  const resolved = path.resolve(filename);
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollowFlag());
    const before = fs.fstatSync(descriptor);
    const expectedMode = options.allowSameUserForTests ? 0o600 : 0o640;
    if (
      !before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_CREDENTIAL_BYTES ||
      before.uid !== options.expectedOwnerUserId || before.gid !== options.runtimeGroupId ||
      (before.mode & 0o777) !== expectedMode
    ) {
      throw new SompiApiCredentialError(`${label} API credential file permissions or identity are invalid`);
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new SompiApiCredentialError(`${label} API credential file was truncated`);
      offset += read;
    }
    const after = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(resolved);
    if (
      pathname.isSymbolicLink() || !pathname.isFile() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      after.dev !== pathname.dev || after.ino !== pathname.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      throw new SompiApiCredentialError(`${label} API credential changed during stable read`);
    }
    const parsed = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const canonical = canonicalBytes(parsed);
    try {
      if (!canonical.equals(bytes)) throw new SompiApiCredentialError(`${label} API credential is not canonical`);
    } finally {
      canonical.fill(0);
    }
    return parsed;
  } catch (cause) {
    if (cause instanceof SompiApiCredentialError) throw cause;
    throw new SompiApiCredentialError(`${label} API credential could not be loaded`, { cause });
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}
