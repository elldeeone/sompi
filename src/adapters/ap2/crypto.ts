import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import { decodeProtectedHeader, importJWK, type KeyLike } from "jose";
import { Ap2AdapterError } from "./errors.js";
import type {
  Ap2PublicKeyResolver,
  Ap2PublicTrustEntry,
  Ap2SigningIdentity,
  Ap2SigningRole,
  Ap2VerificationClock,
  P256PrivateJwk,
  P256PublicJwk,
} from "./types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const MAX_ARTIFACT_BYTES = 64 * 1024;

export class LocalAp2TrustStore implements Ap2PublicKeyResolver {
  private readonly entries = new Map<string, P256PublicJwk>();

  constructor(entries: readonly Ap2PublicTrustEntry[]) {
    for (const entry of entries) {
      const issuer = requireBoundedText(entry.issuer, "trust issuer", 256);
      const kid = requireKid(entry.kid);
      assertPublicJwk(entry.publicJwk, kid);
      const key = trustKey(entry.role, issuer, kid);
      if (this.entries.has(key)) {
        throw new Ap2AdapterError("duplicate AP2 trust entry", "untrusted_key");
      }
      this.entries.set(key, Object.freeze({ ...entry.publicJwk }));
    }
  }

  resolve(role: Ap2SigningRole, issuer: string, kid: string): P256PublicJwk | undefined {
    return this.entries.get(trustKey(role, issuer, kid));
  }
}

export function assertSigningIdentity(
  identity: Ap2SigningIdentity,
  expectedRole: Ap2SigningRole
): void {
  if (identity.role !== expectedRole) {
    throw new Ap2AdapterError(`signing identity is not a ${expectedRole} key`, "untrusted_key");
  }
  requireBoundedText(identity.issuer, "signing issuer", 256);
  requireKid(identity.kid);
  assertPrivateJwk(identity.privateJwk, identity.kid);
}

export async function resolveTrustedPublicKey(input: {
  resolver: Ap2PublicKeyResolver;
  role: Ap2SigningRole;
  issuer: string;
  kid: string;
}): Promise<{ jwk: P256PublicJwk; key: KeyLike }> {
  requireBoundedText(input.issuer, "expected issuer", 256);
  requireKid(input.kid);
  const jwk = await input.resolver.resolve(input.role, input.issuer, input.kid);
  if (!jwk) throw new Ap2AdapterError("AP2 issuer or key is not trusted", "untrusted_key");
  assertPublicJwk(jwk, input.kid);
  try {
    return { jwk, key: await importJWK(mutableJwk(jwk), "ES256") as KeyLike };
  } catch {
    throw new Ap2AdapterError("trusted AP2 public key is invalid", "untrusted_key");
  }
}

export async function importSigningKey(identity: Ap2SigningIdentity): Promise<KeyLike> {
  try {
    return await importJWK(mutableJwk(identity.privateJwk), "ES256") as KeyLike;
  } catch {
    throw new Ap2AdapterError("AP2 signing key is invalid", "untrusted_key");
  }
}

export function sdJwtSigner(identity: Ap2SigningIdentity): (data: string) => Promise<string> {
  assertSigningIdentity(identity, "authority");
  const key = privateKeyObject(identity.privateJwk);
  return async (data: string): Promise<string> => {
    assertAscii(data, "SD-JWT signing input");
    const signature = signBytes("sha256", Buffer.from(data, "ascii"), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    if (signature.byteLength !== 64) {
      throw new Ap2AdapterError("ES256 signer returned an invalid signature", "signature_invalid");
    }
    return signature.toString("base64url");
  };
}

export function sdJwtVerifier(jwk: P256PublicJwk): (data: string, signature: string) => Promise<boolean> {
  const key = publicKeyObject(jwk);
  return async (data: string, signature: string): Promise<boolean> => {
    try {
      assertAscii(data, "SD-JWT signing input");
      const decoded = decodeBase64url(signature, "SD-JWT signature");
      if (decoded.byteLength !== 64) return false;
      return verifyBytes("sha256", Buffer.from(data, "ascii"), {
        key,
        dsaEncoding: "ieee-p1363",
      }, decoded);
    } catch {
      return false;
    }
  };
}

export async function strictProtectedHeader(
  compactJwt: string,
  allowedKeys: readonly string[],
  requiredTyp: string | undefined
): Promise<{ alg: "ES256"; kid: string; typ?: string }> {
  assertCompactJwt(compactJwt);
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(compactJwt);
  } catch {
    throw new Ap2AdapterError("compact JWS protected header is malformed", "artifact_malformed");
  }
  assertExactKeys(header, ["alg", "kid", ...(requiredTyp === undefined ? [] : ["typ"])], allowedKeys,
    "compact JWS protected header");
  if (header.alg !== "ES256") {
    throw new Ap2AdapterError("only protected ES256 artifacts are supported", "profile_mismatch");
  }
  const kid = requireKid(header.kid);
  if (requiredTyp !== undefined && header.typ !== requiredTyp) {
    throw new Ap2AdapterError("compact JWS typ does not match the pinned profile", "profile_mismatch");
  }
  return { alg: "ES256", kid, ...(typeof header.typ === "string" ? { typ: header.typ } : {}) };
}

export function assertCompactJwt(compactJwt: string): void {
  if (
    typeof compactJwt !== "string" ||
    compactJwt.length === 0 ||
    Buffer.byteLength(compactJwt, "utf8") > MAX_ARTIFACT_BYTES ||
    /[^\x21-\x7e]/.test(compactJwt)
  ) {
    throw new Ap2AdapterError("compact JWS is not bounded ASCII", "artifact_malformed");
  }
  const parts = compactJwt.split(".");
  if (parts.length !== 3 || parts.some((part) => !BASE64URL_PATTERN.test(part))) {
    throw new Ap2AdapterError("compact JWS must contain three base64url segments", "artifact_malformed");
  }
}

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Ap2AdapterError(`${label} contains unsupported field ${key}`, "profile_mismatch");
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Ap2AdapterError(`${label} is missing required field ${key}`, "profile_mismatch");
    }
  }
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Ap2AdapterError(`${label} must be an object`, "profile_mismatch");
  }
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Ap2AdapterError(`${label} must be an array`, "profile_mismatch");
  }
  return value;
}

export function requireBoundedText(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Ap2AdapterError(`${label} must be bounded canonical text`, "profile_mismatch");
  }
  return value;
}

export function requireKid(value: unknown): string {
  if (typeof value !== "string" || !KID_PATTERN.test(value)) {
    throw new Ap2AdapterError("AP2 kid is not a bounded local key identity", "untrusted_key");
  }
  return value;
}

export function requireSafeEpoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Ap2AdapterError(`${label} must be a non-negative safe epoch second`, "time_invalid");
  }
  return value as number;
}

export function verificationClock(clock: Ap2VerificationClock): { nowSec: number; clockSkewSec: number } {
  const nowSec = clock.nowSec ?? Math.floor(Date.now() / 1000);
  const clockSkewSec = clock.clockSkewSec ?? 30;
  if (!Number.isSafeInteger(nowSec) || nowSec < 0 || !Number.isSafeInteger(clockSkewSec) || clockSkewSec < 0 || clockSkewSec > 300) {
    throw new Ap2AdapterError("AP2 verification clock is invalid", "time_invalid");
  }
  return { nowSec, clockSkewSec };
}

export function assertShortLivedWindow(
  iatValue: unknown,
  expValue: unknown,
  clock: Ap2VerificationClock,
  maxTtlSec = 300
): { iat: number; exp: number } {
  const iat = requireSafeEpoch(iatValue, "iat");
  const exp = requireSafeEpoch(expValue, "exp");
  const { nowSec, clockSkewSec } = verificationClock(clock);
  if (exp <= iat || exp - iat > maxTtlSec) {
    throw new Ap2AdapterError("artifact lifetime exceeds the pinned five-minute profile", "time_invalid");
  }
  if (iat > nowSec + clockSkewSec) {
    throw new Ap2AdapterError("artifact was issued in the future", "time_invalid");
  }
  if (exp < nowSec - clockSkewSec) {
    throw new Ap2AdapterError("artifact is expired", "time_invalid");
  }
  return { iat, exp };
}

export function sha256Base64url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return createHash("sha256").update(bytes).digest("base64url");
}

export function sha256Digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Base64url(value)}`;
}

export function requireSha256Digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Ap2AdapterError(`${label} must be a canonical SHA-256 digest`, "profile_mismatch");
  }
  return value as `sha256:${string}`;
}

export function requireBase64urlDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Ap2AdapterError(`${label} must be a base64url SHA-256 digest`, "profile_mismatch");
  }
  const decoded = decodeBase64url(value, label);
  if (decoded.byteLength !== 32) {
    throw new Ap2AdapterError(`${label} must contain 32 digest bytes`, "profile_mismatch");
  }
  return value;
}

export function requireCanonicalDecimal(
  value: unknown,
  label: string,
  options: { positive: boolean; safeInteger?: boolean }
): string {
  const pattern = options.positive ? /^[1-9][0-9]*$/ : /^(?:0|[1-9][0-9]*)$/;
  if (typeof value !== "string" || value.length > 78 || !pattern.test(value)) {
    throw new Ap2AdapterError(`${label} must be a canonical atomic decimal string`, "profile_mismatch");
  }
  if (options.safeInteger && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Ap2AdapterError(`${label} exceeds the native-KAS JSON safe-integer profile`, "profile_mismatch");
  }
  return value;
}

export function randomSalt(length: number): string {
  if (!Number.isSafeInteger(length) || length < 16) {
    throw new Ap2AdapterError("SD-JWT requested insufficient salt entropy", "artifact_malformed");
  }
  return randomBytes(length).toString("base64url");
}

export function sha256Hasher(data: string | ArrayBuffer, algorithm: string): Uint8Array {
  if (algorithm !== "sha-256") {
    throw new Ap2AdapterError("only SD-JWT sha-256 is supported", "profile_mismatch");
  }
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(bytes).digest();
}

export function decodeBase64urlJson(value: string, label: string): unknown {
  const bytes = decodeBase64url(value, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Ap2AdapterError(`${label} is not strict UTF-8 JSON`, "artifact_malformed");
  }
}

export function decodeBase64url(value: string, label: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Ap2AdapterError(`${label} is not canonical base64url`, "artifact_malformed");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new Ap2AdapterError(`${label} is not canonical base64url`, "artifact_malformed");
  }
  return bytes;
}

function assertPublicJwk(jwk: P256PublicJwk, kid: string): void {
  const value = requireRecord(jwk, "AP2 public JWK");
  assertExactKeys(value, ["kty", "crv", "x", "y"], ["kty", "crv", "x", "y", "alg", "kid", "use", "key_ops"], "AP2 public JWK");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || (jwk.alg !== undefined && jwk.alg !== "ES256") ||
      (jwk.kid !== undefined && jwk.kid !== kid) || (jwk.use !== undefined && jwk.use !== "sig")) {
    throw new Ap2AdapterError("AP2 public JWK is outside the pinned ES256 profile", "untrusted_key");
  }
  if (decodeBase64url(jwk.x, "AP2 JWK x").byteLength !== 32 || decodeBase64url(jwk.y, "AP2 JWK y").byteLength !== 32) {
    throw new Ap2AdapterError("AP2 public JWK coordinates must be 32 bytes", "untrusted_key");
  }
  if (jwk.key_ops && (!Array.isArray(jwk.key_ops) || jwk.key_ops.some((op) => op !== "verify"))) {
    throw new Ap2AdapterError("AP2 public JWK key_ops is invalid", "untrusted_key");
  }
}

function assertPrivateJwk(jwk: P256PrivateJwk, kid: string): void {
  assertPublicJwk({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    ...(jwk.alg === undefined ? {} : { alg: jwk.alg }),
    ...(jwk.kid === undefined ? {} : { kid: jwk.kid }),
    ...(jwk.use === undefined ? {} : { use: jwk.use }),
  }, kid);
  const value = requireRecord(jwk, "AP2 private JWK");
  assertExactKeys(value, ["kty", "crv", "x", "y", "d"], ["kty", "crv", "x", "y", "d", "alg", "kid", "use", "key_ops"], "AP2 private JWK");
  if (decodeBase64url(jwk.d, "AP2 JWK d").byteLength !== 32) {
    throw new Ap2AdapterError("AP2 private JWK scalar must be 32 bytes", "untrusted_key");
  }
  if (jwk.key_ops && (!Array.isArray(jwk.key_ops) || jwk.key_ops.some((op) => op !== "sign"))) {
    throw new Ap2AdapterError("AP2 private JWK key_ops is invalid", "untrusted_key");
  }
}

function privateKeyObject(jwk: P256PrivateJwk): KeyObject {
  try {
    return createPrivateKey({ key: { ...jwk }, format: "jwk" });
  } catch {
    throw new Ap2AdapterError("AP2 private JWK is invalid", "untrusted_key");
  }
}

function publicKeyObject(jwk: P256PublicJwk): KeyObject {
  try {
    return createPublicKey({ key: { ...jwk }, format: "jwk" });
  } catch {
    throw new Ap2AdapterError("AP2 public JWK is invalid", "untrusted_key");
  }
}

function mutableJwk(jwk: P256PublicJwk | P256PrivateJwk): {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
  alg?: string;
  kid?: string;
  use?: string;
  key_ops?: string[];
} {
  return {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    ...(Object.prototype.hasOwnProperty.call(jwk, "d")
      ? { d: (jwk as P256PrivateJwk).d }
      : {}),
    ...(jwk.alg === undefined ? {} : { alg: jwk.alg }),
    ...(jwk.kid === undefined ? {} : { kid: jwk.kid }),
    ...(jwk.use === undefined ? {} : { use: jwk.use }),
    ...(jwk.key_ops === undefined ? {} : { key_ops: [...jwk.key_ops] }),
  };
}

function trustKey(role: Ap2SigningRole, issuer: string, kid: string): string {
  return `${role}\u0000${issuer}\u0000${kid}`;
}

function assertAscii(value: string, label: string): void {
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Ap2AdapterError(`${label} is not ASCII`, "artifact_malformed");
  }
}
