import {
  MAX_PURCHASE_API_RESPONSE_BYTES,
  PurchaseApiContractError,
  assertPurchaseApiError,
  assertPurchaseView,
  parsePurchaseCreateRequest,
  type PurchaseApplication,
  type PurchaseCreateRequest,
} from "./contracts.js";
import type { AgentApiCredential } from "./credential.js";
import type { PurchaseView } from "../purchase/types.js";
import { assertPurchaseId } from "../purchase/identity.js";

export interface PurchaseApiClientOptions {
  readonly baseUrl: string;
  readonly credential: AgentApiCredential;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class PurchaseApiClientError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PurchaseApiClientError";
  }
}

/** Thin client used by MCP; it has no wallet, Journal, Authority, or protocol capability. */
export class PurchaseApiClient implements PurchaseApplication {
  private readonly baseUrl: string;
  private readonly credential: AgentApiCredential;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: PurchaseApiClientOptions) {
    this.baseUrl = canonicalLoopbackBaseUrl(options.baseUrl);
    this.credential = options.credential;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 125_000);
    this.fetcher = options.fetch ?? fetch;
  }

  purchase(input: PurchaseCreateRequest, signal?: AbortSignal): Promise<PurchaseView> {
    return this.request("POST", "/purchases", parsePurchaseCreateRequest(input), signal);
  }

  status(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView> {
    return this.request("GET", `/purchases/${assertPurchaseId(purchaseId)}`, undefined, signal);
  }

  recover(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView> {
    return this.request("POST", `/purchases/${assertPurchaseId(purchaseId)}/recover`, undefined, signal);
  }

  private async request(method: string, pathname: string, body: unknown, signal?: AbortSignal): Promise<PurchaseView> {
    const target = `${this.baseUrl}${pathname}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(target, {
        method,
        redirect: "error",
        signal: combined,
        headers: {
          authorization: `Bearer ${this.credential.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new PurchaseApiClientError(
        timeout.aborted ? "DEADLINE_EXCEEDED" : "API_UNAVAILABLE",
        timeout.aborted ? "The local Purchase API deadline elapsed." : "The local Purchase API is unavailable.",
        true,
        { cause }
      );
    }
    if (response.url !== target || response.redirected) {
      throw new PurchaseApiClientError("UNEXPECTED_RESPONSE_TARGET", "The local Purchase API response target changed.", false);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new PurchaseApiClientError("INVALID_API_RESPONSE", "The local Purchase API returned an invalid content type.", false);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_PURCHASE_API_RESPONSE_BYTES)) {
      throw new PurchaseApiClientError("INVALID_API_RESPONSE", "The local Purchase API response exceeds the size limit.", false);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PURCHASE_API_RESPONSE_BYTES) {
      throw new PurchaseApiClientError("INVALID_API_RESPONSE", "The local Purchase API response size is invalid.", false);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (cause) {
      throw new PurchaseApiClientError("INVALID_API_RESPONSE", "The local Purchase API returned invalid JSON.", false, { cause });
    } finally {
      bytes.fill(0);
    }
    try {
      if (response.ok) return assertPurchaseView(value);
      const error = assertPurchaseApiError(value).error;
      throw new PurchaseApiClientError(error.code, error.message, error.retryable);
    } catch (cause) {
      if (cause instanceof PurchaseApiClientError) throw cause;
      if (cause instanceof PurchaseApiContractError) {
        throw new PurchaseApiClientError("INVALID_API_RESPONSE", "The local Purchase API response violates its contract.", false, { cause });
      }
      throw cause;
    }
  }
}

function canonicalLoopbackBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PurchaseApiClientError("INVALID_CONFIGURATION", "Purchase API URL is invalid.", false); }
  if (
    url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new PurchaseApiClientError("INVALID_CONFIGURATION", "Purchase API URL must be a canonical loopback HTTP origin.", false);
  }
  return url.origin;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PurchaseApiClientError("INVALID_CONFIGURATION", "Purchase API timeout is invalid.", false);
  return value;
}
