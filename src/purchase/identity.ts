import { createHash, randomBytes } from "node:crypto";
import type {
  PaymentIdentifier,
  PurchaseId,
  PurchaseRequestKey,
  PurchaseResource,
  Sha256Digest,
} from "./types";

const PURCHASE_ID_BYTES = 16;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const PURCHASE_ID_PATTERN = /^pur_[A-Za-z0-9_-]{22}$/;

export function createPurchaseId(entropy: Uint8Array = randomBytes(PURCHASE_ID_BYTES)): PurchaseId {
  if (entropy.byteLength !== PURCHASE_ID_BYTES) {
    throw new Error(`purchase id entropy must be exactly ${PURCHASE_ID_BYTES} bytes`);
  }
  return assertPurchaseId(`pur_${Buffer.from(entropy).toString("base64url")}`);
}

export function assertPurchaseId(value: string): PurchaseId {
  if (!PURCHASE_ID_PATTERN.test(value)) throw new Error("invalid PurchaseId");
  return value as PurchaseId;
}

export function assertPurchaseRequestKey(value: string): PurchaseRequestKey {
  if (!REQUEST_KEY_PATTERN.test(value)) {
    throw new Error("purchase request key must be 1-160 characters using letters, digits, '.', '_', ':', or '-'");
  }
  return value as PurchaseRequestKey;
}

export function requestFingerprint(resource: PurchaseResource): Sha256Digest {
  const url = canonicalRequestUrl(resource.url);
  const method = resource.method.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(method)) {
    throw new Error("invalid HTTP method for Purchase resource");
  }
  const body = resource.body ?? new Uint8Array();
  const bodyDigest = sha256(body);
  return domainDigest("sompi:purchase-request:v1", [method, url, bodyDigest]);
}

export function createPaymentIdentifier(purchaseId: PurchaseId, attempt: number): PaymentIdentifier {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("payment attempt must be a positive safe integer");
  const digest = domainDigest("sompi:payment-identifier:v1", [purchaseId, String(attempt)]);
  return `pay_${digest.slice("sha256:".length)}` as PaymentIdentifier;
}

export function evidenceDigest(value: string | Uint8Array): Sha256Digest {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return `sha256:${sha256(bytes)}` as Sha256Digest;
}

export function canonicalRequestUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Purchase resource URL must use http or https");
  }
  if (url.username || url.password) throw new Error("Purchase resource URL must not contain credentials");
  url.hash = "";
  return url.href;
}

function domainDigest(domain: string, fields: readonly string[]): Sha256Digest {
  const hash = createHash("sha256");
  appendLengthPrefixed(hash, Buffer.from(domain, "utf8"));
  for (const field of fields) appendLengthPrefixed(hash, Buffer.from(field, "utf8"));
  return `sha256:${hash.digest("base64url")}` as Sha256Digest;
}

function appendLengthPrefixed(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  if (bytes.byteLength > 0xffffffff) throw new Error("canonical fingerprint field is too large");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}
