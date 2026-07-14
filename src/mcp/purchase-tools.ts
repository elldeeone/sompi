import { assertPurchaseId, assertPurchaseRequestKey } from "../purchase/identity.js";
import type { PurchaseIntent, PurchaseModule, PurchaseView } from "../purchase/types.js";

export interface PurchaseToolInput {
  requestKey: string;
  url: string;
  method?: string;
  bodyBase64?: string;
  mediaType?: string;
  expectedMerchantId?: string;
  expectedMerchantOrigin?: string;
}

export interface PurchaseIdentityInput {
  purchaseId: string;
}

export interface PurchaseToolHandlers {
  purchase(input: PurchaseToolInput): Promise<PurchaseView>;
  purchaseStatus(input: PurchaseIdentityInput): Promise<PurchaseView>;
  purchaseRecover(input: PurchaseIdentityInput): Promise<PurchaseView>;
}

/** Thin, deterministic MCP input adapters around the stable PurchaseModule. */
export function createPurchaseToolHandlers(module: PurchaseModule): PurchaseToolHandlers {
  const purchase = async (input: PurchaseToolInput): Promise<PurchaseView> => module.purchase(toolIntent(input));
  return {
    purchase,
    purchaseStatus: async ({ purchaseId }) => module.status(assertPurchaseId(purchaseId)),
    purchaseRecover: async ({ purchaseId }) => module.recover(assertPurchaseId(purchaseId)),
  };
}

export function toolIntent(input: PurchaseToolInput): PurchaseIntent {
  if (!input || typeof input !== "object") throw new Error("Purchase input is required");
  if (typeof input.url !== "string" || input.url.length === 0) throw new Error("Purchase URL is required");
  const body = input.bodyBase64 === undefined ? undefined : strictBase64(input.bodyBase64);
  const expectedMerchant =
    input.expectedMerchantId !== undefined || input.expectedMerchantOrigin !== undefined
      ? {
          id: optionalBounded(input.expectedMerchantId, "expected Merchant id"),
          origin: optionalBounded(input.expectedMerchantOrigin, "expected Merchant origin"),
        }
      : undefined;
  return {
    requestKey: assertPurchaseRequestKey(input.requestKey),
    resource: {
      url: input.url,
      method: input.method ?? "GET",
      body,
      mediaType: optionalBounded(input.mediaType, "media type"),
    },
    expectedMerchant,
  };
}

function strictBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length > 1_398_104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Purchase body must be canonical padded base64 and at most 1 MiB");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength > 1024 * 1024) {
    throw new Error("Purchase body must be canonical padded base64 and at most 1 MiB");
  }
  return Uint8Array.from(decoded);
}

function optionalBounded(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
