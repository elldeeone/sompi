import { createHash, randomBytes } from "node:crypto";
import type {
  PaymentIdentifier,
  PurchaseId,
  PurchaseRequestKey,
  PurchaseResource,
  Sha256Digest,
} from "./types.js";

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
  const bodyDigest = evidenceDigest(resource.body ?? new Uint8Array());
  return requestFingerprintFromBodyDigest({
    url: resource.url,
    method: resource.method,
    mediaType: resource.mediaType,
    bodyDigest,
  });
}

/** Reconstructs the request identity from a durably stored body digest. */
export function requestFingerprintFromBodyDigest(input: {
  url: string;
  method: string;
  mediaType?: string;
  bodyDigest: Sha256Digest;
}): Sha256Digest {
  const url = canonicalRequestUrl(input.url);
  const method = input.method.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(method)) {
    throw new Error("invalid HTTP method for Purchase resource");
  }
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(input.bodyDigest)) {
    throw new Error("invalid Purchase request body digest");
  }
  const mediaType = canonicalMediaType(input.mediaType) ?? "";
  return domainDigest("sompi:purchase-request:v2", [
    method,
    url,
    mediaType,
    input.bodyDigest.slice("sha256:".length),
  ]);
}

/** Canonicalizes the exact Content-Type semantics bound into a Purchase. */
export function canonicalMediaType(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw || raw.length > 200 || raw.trim() !== raw || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("invalid Purchase resource media type");
  }
  const [essenceRaw, ...parameterParts] = raw.split(";");
  const essence = essenceRaw.toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(essence)) {
    throw new Error("invalid Purchase resource media type");
  }
  const parameters = parameterParts.map((part) => {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals <= 0 || equals === trimmed.length - 1) throw new Error("invalid Purchase resource media type");
    const name = trimmed.slice(0, equals).trim().toLowerCase();
    const value = trimmed.slice(equals + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[;\r\n]/.test(value)) {
      throw new Error("invalid Purchase resource media type");
    }
    return `${name}=${value}`;
  });
  return parameters.length === 0 ? essence : `${essence}; ${parameters.join("; ")}`;
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
