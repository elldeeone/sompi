import * as fs from "node:fs";

import { LocalAp2TrustStore, assertSigningIdentity } from "./crypto.js";
import type {
  Ap2PublicTrustEntry,
  Ap2SigningIdentity,
  Ap2SigningRole,
  P256PrivateJwk,
  P256PublicJwk,
} from "./types.js";

const MAX_FILE_BYTES = 256 * 1024;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export function loadAuthoritySigningIdentity(
  filename: string,
  issuer: string,
  kid: string,
): Ap2SigningIdentity {
  const value = secureJson(filename);
  const jwk = privateJwk(value);
  const identity = Object.freeze({
    role: "authority" as const,
    issuer,
    kid,
    privateJwk: jwk,
  });
  assertSigningIdentity(identity, "authority");
  return identity;
}

export function loadAp2TrustStore(filename: string): LocalAp2TrustStore {
  const value = secureJson(filename);
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("AP2 trust file must contain a bounded non-empty array");
  }
  const entries = value.map((candidate, index) => trustEntry(candidate, index));
  return new LocalAp2TrustStore(entries);
}

function secureJson(filename: string): unknown {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
    const before = fs.fstatSync(descriptor);
    assertSecureFile(before);
    if (before.size <= 0 || before.size > MAX_FILE_BYTES) throw new Error("secure AP2 file size is invalid");
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    assertSecureFile(after);
    if (before.dev !== after.dev || before.ino !== after.ino || after.size !== bytes.byteLength) {
      throw new Error("secure AP2 file changed while reading");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    if (`${JSON.stringify(parsed, null, 2)}\n` !== text) {
      throw new Error("secure AP2 JSON must use canonical two-space formatting");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("secure AP2")) throw error;
    if (error instanceof Error && error.message.startsWith("AP2")) throw error;
    throw new Error("secure AP2 configuration is unavailable");
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function privateJwk(value: unknown): P256PrivateJwk {
  const record = exactRecord(value, ["kty", "crv", "x", "y", "d"], "authority private JWK");
  if (
    record.kty !== "EC" ||
    record.crv !== "P-256" ||
    !BASE64URL_32.test(String(record.x)) ||
    !BASE64URL_32.test(String(record.y)) ||
    !BASE64URL_32.test(String(record.d))
  ) {
    throw new Error("AP2 authority private JWK is invalid");
  }
  return Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: String(record.x),
    y: String(record.y),
    d: String(record.d),
  });
}

function trustEntry(value: unknown, index: number): Ap2PublicTrustEntry {
  const record = exactRecord(value, ["role", "issuer", "kid", "publicJwk"], `trust entry ${index}`);
  const roles: readonly Ap2SigningRole[] = [
    "merchant-checkout", "authority", "merchant-receipt", "payment-receipt",
  ];
  if (!roles.includes(record.role as Ap2SigningRole) || !ID.test(String(record.issuer)) || !ID.test(String(record.kid))) {
    throw new Error(`AP2 trust entry ${index} identity is invalid`);
  }
  const jwkRecord = exactRecord(record.publicJwk, ["kty", "crv", "x", "y"], `trust entry ${index} JWK`);
  if (
    jwkRecord.kty !== "EC" ||
    jwkRecord.crv !== "P-256" ||
    !BASE64URL_32.test(String(jwkRecord.x)) ||
    !BASE64URL_32.test(String(jwkRecord.y))
  ) {
    throw new Error(`AP2 trust entry ${index} JWK is invalid`);
  }
  const publicJwk: P256PublicJwk = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: String(jwkRecord.x),
    y: String(jwkRecord.y),
  });
  return Object.freeze({
    role: record.role as Ap2SigningRole,
    issuer: String(record.issuer),
    kid: String(record.kid),
    publicJwk,
  });
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`AP2 ${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`AP2 ${label} has unknown or missing fields`);
  }
  return record;
}

function assertSecureFile(stat: fs.Stats): void {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (
    !stat.isFile() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o077) !== 0 ||
    stat.nlink !== 1
  ) {
    throw new Error("secure AP2 file ownership or mode is invalid");
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}
