import * as Ajv2020Module from "ajv/dist/2020.js";
import type {
  Ajv2020 as Ajv2020Instance,
  JSONSchemaType,
  Options as AjvOptions,
} from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { assertPurchaseId, assertPurchaseRequestKey } from "../purchase/identity.js";
import type { PurchaseIntent, PurchaseModule, PurchaseView } from "../purchase/types.js";

export const PURCHASE_API_VERSION = "sompi-purchase-api-v1" as const;
export const MAX_PURCHASE_API_BODY_BYTES = 1_500_000;
export const MAX_PURCHASE_BODY_BYTES = 1024 * 1024;
export const MAX_PURCHASE_API_RESPONSE_BYTES = 64 * 1024;

const PURCHASE_ID_PATTERN = "^pur_[A-Za-z0-9_-]{22}$";
const REQUEST_KEY_PATTERN = "^[A-Za-z0-9._:-]{1,160}$";
const DIGEST_PATTERN = "^sha256:[A-Za-z0-9_-]{43}$";
const POSITIVE_ATOMIC_PATTERN = "^[1-9][0-9]*$";
const NONNEGATIVE_ATOMIC_PATTERN = "^(?:0|[1-9][0-9]*)$";
const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

export interface PurchaseCreateRequest {
  readonly requestKey: string;
  readonly url: string;
  readonly method?: string;
  readonly bodyBase64?: string;
  readonly mediaType?: string;
  readonly expectedMerchant?: Readonly<{
    id?: string;
    origin?: string;
  }>;
}

export interface PurchaseApiErrorBody {
  readonly error: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
}

export interface PurchaseApplication {
  purchase(input: PurchaseCreateRequest, signal?: AbortSignal): Promise<PurchaseView>;
  status(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView>;
  recover(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView>;
}

export const PURCHASE_CREATE_REQUEST_SCHEMA: JSONSchemaType<PurchaseCreateRequest> = {
  $id: "https://sompi.local/schemas/purchase-create-request.json",
  type: "object",
  additionalProperties: false,
  required: ["requestKey", "url"],
  properties: {
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    url: { type: "string", minLength: 1, maxLength: 2048, format: "uri" },
    method: {
      type: "string",
      pattern: "^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$",
      nullable: true,
    },
    bodyBase64: {
      type: "string",
      minLength: 4,
      maxLength: 1_398_104,
      pattern: BASE64_PATTERN,
      nullable: true,
    },
    mediaType: { type: "string", minLength: 1, maxLength: 200, nullable: true },
    expectedMerchant: {
      type: "object",
      additionalProperties: false,
      required: [],
      nullable: true,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 256, nullable: true },
        origin: { type: "string", minLength: 1, maxLength: 2048, format: "uri", nullable: true },
      },
    },
  },
};

export const PURCHASE_VIEW_SCHEMA = {
  $id: "https://sompi.local/schemas/purchase-view.json",
  type: "object",
  additionalProperties: false,
  required: [
    "id", "requestKey", "state", "summary", "resourceFingerprint",
    "authorization", "treasury", "paymentAttempts", "receiptEvidence",
  ],
  properties: {
    id: { type: "string", pattern: PURCHASE_ID_PATTERN },
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN },
    state: {
      enum: [
        "created", "terms_bound", "awaiting_authority", "authorised",
        "execution_prepared", "submitted", "settled", "fulfilled", "receipted",
        "denied", "cancelled", "expired", "failed_recoverable", "failed_terminal",
      ],
    },
    summary: { type: "string", minLength: 1, maxLength: 512 },
    userAction: { type: "string", minLength: 1, maxLength: 512 },
    resourceFingerprint: { type: "string", pattern: DIGEST_PATTERN },
    terms: {
      type: "object",
      additionalProperties: false,
      required: [
        "merchant", "resourceFingerprint", "amountAtomic", "asset", "network",
        "payTo", "expiresAt", "checkoutDigest",
      ],
      properties: {
        merchant: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "origin"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            name: { type: "string", minLength: 1, maxLength: 256 },
            origin: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
        resourceFingerprint: { type: "string", pattern: DIGEST_PATTERN },
        amountAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 78 },
        asset: { type: "string", minLength: 1, maxLength: 64 },
        network: { type: "string", minLength: 1, maxLength: 128 },
        payTo: { type: "string", minLength: 1, maxLength: 256 },
        expiresAt: { type: "string", minLength: 1, maxLength: 100 },
        checkoutDigest: { type: "string", pattern: DIGEST_PATTERN },
      },
    },
    authorization: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { enum: ["not_requested", "pending", "approved", "denied", "expired"] },
        authorityId: { type: "string", minLength: 1, maxLength: 256 },
        evidenceDigest: { type: "string", pattern: DIGEST_PATTERN },
      },
    },
    treasury: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { enum: ["unreserved", "reserved", "committed", "released", "expired"] },
        amountAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 78 },
        additionalCostCeilingAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 78 },
        reservationId: { type: "string", minLength: 1, maxLength: 256 },
        fundingSource: { const: "vault-treasury" },
      },
    },
    paymentAttempts: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attempt", "identifier", "status", "evidenceDigests"],
        properties: {
          attempt: { type: "integer", minimum: 1, maximum: 0x7fffffff },
          identifier: { type: "string", minLength: 1, maxLength: 160 },
          status: { enum: ["planned", "prepared", "submitted", "observed", "failed"] },
          transactionId: { type: "string", minLength: 1, maxLength: 128 },
          finality: { type: "string", minLength: 1, maxLength: 100 },
          evidenceDigests: {
            type: "array",
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", pattern: DIGEST_PATTERN },
          },
        },
      },
    },
    settlementEvidence: { type: "string", pattern: DIGEST_PATTERN },
    fulfilmentDigest: { type: "string", pattern: DIGEST_PATTERN },
    receiptEvidence: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", pattern: DIGEST_PATTERN },
    },
    fulfilmentBody: { type: "string", maxLength: 8192 },
    fulfilmentHandle: { type: "string", minLength: 1, maxLength: 240 },
  },
} as const;

export const PURCHASE_API_ERROR_SCHEMA: JSONSchemaType<PurchaseApiErrorBody> = {
  $id: "https://sompi.local/schemas/purchase-api-error.json",
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable"],
      properties: {
        code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,79}$", maxLength: 80 },
        message: { type: "string", minLength: 1, maxLength: 512 },
        retryable: { type: "boolean" },
      },
    },
  },
};

const Ajv2020 = (
  (Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module
) as new (options?: AjvOptions) => Ajv2020Instance;
const ajv = new Ajv2020({ allErrors: true, strict: true });
(addFormatsModule as unknown as (instance: Ajv2020Instance) => void)(ajv);
const validateCreate = ajv.compile(PURCHASE_CREATE_REQUEST_SCHEMA);
const validateView = ajv.compile<PurchaseView>(PURCHASE_VIEW_SCHEMA);
const validateError = ajv.compile(PURCHASE_API_ERROR_SCHEMA);

export class PurchaseApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseApiContractError";
  }
}

export function parsePurchaseCreateRequest(value: unknown): PurchaseCreateRequest {
  if (!validateCreate(value)) throw new PurchaseApiContractError("Purchase request does not match the canonical schema");
  const body = value.bodyBase64 === undefined ? undefined : strictBase64(value.bodyBase64);
  return Object.freeze({
    requestKey: assertPurchaseRequestKey(value.requestKey),
    url: canonicalUrl(value.url),
    method: value.method ?? "GET",
    ...(body === undefined ? {} : { bodyBase64: Buffer.from(body).toString("base64") }),
    ...(value.mediaType === undefined ? {} : { mediaType: boundedText(value.mediaType, "media type", 200) }),
    ...(value.expectedMerchant === undefined
      ? {}
      : {
          expectedMerchant: Object.freeze({
            ...(value.expectedMerchant.id === undefined
              ? {}
              : { id: boundedText(value.expectedMerchant.id, "expected Merchant id", 256) }),
            ...(value.expectedMerchant.origin === undefined
              ? {}
              : { origin: canonicalOrigin(value.expectedMerchant.origin) }),
          }),
        }),
  });
}

export function purchaseIntent(input: PurchaseCreateRequest): PurchaseIntent {
  const parsed = parsePurchaseCreateRequest(input);
  return Object.freeze({
    requestKey: assertPurchaseRequestKey(parsed.requestKey),
    resource: Object.freeze({
      url: parsed.url,
      method: parsed.method ?? "GET",
      ...(parsed.bodyBase64 === undefined
        ? {}
        : { body: Uint8Array.from(Buffer.from(parsed.bodyBase64, "base64")) }),
      ...(parsed.mediaType === undefined ? {} : { mediaType: parsed.mediaType }),
    }),
    ...(parsed.expectedMerchant === undefined
      ? {}
      : { expectedMerchant: Object.freeze({ ...parsed.expectedMerchant }) }),
  });
}

export function createPurchaseApplication(module: PurchaseModule): PurchaseApplication {
  return Object.freeze({
    purchase: async (input: PurchaseCreateRequest, signal?: AbortSignal) =>
      assertPurchaseView(await module.purchase(purchaseIntent(input), signal)),
    status: async (purchaseId: string, signal?: AbortSignal) =>
      assertPurchaseView(await module.status(assertPurchaseId(purchaseId), signal)),
    recover: async (purchaseId: string, signal?: AbortSignal) =>
      assertPurchaseView(await module.recover(assertPurchaseId(purchaseId), signal)),
  });
}

export function assertPurchaseView(value: unknown): PurchaseView {
  if (!validateView(value)) throw new PurchaseApiContractError("Purchase response does not match the canonical schema");
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > MAX_PURCHASE_API_RESPONSE_BYTES) {
    throw new PurchaseApiContractError("Purchase response exceeds the canonical size limit");
  }
  return value;
}

export function assertPurchaseApiError(value: unknown): PurchaseApiErrorBody {
  if (!validateError(value)) throw new PurchaseApiContractError("Purchase error does not match the canonical schema");
  return value;
}

function strictBase64(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_PURCHASE_BODY_BYTES || decoded.toString("base64") !== value) {
    throw new PurchaseApiContractError("Purchase body must be canonical padded base64 and at most 1 MiB");
  }
  return Uint8Array.from(decoded);
}

function canonicalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PurchaseApiContractError("Purchase URL is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.href !== value) {
    throw new PurchaseApiContractError("Purchase URL must be canonical HTTP without credentials");
  }
  return value;
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PurchaseApiContractError("expected Merchant origin is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.origin !== value) {
    throw new PurchaseApiContractError("expected Merchant origin must be canonical HTTP");
  }
  return value;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PurchaseApiContractError(`${label} is invalid`);
  }
  return value;
}
