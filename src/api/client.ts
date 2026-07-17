import * as http from "node:http";

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
import {
  verifyPurchaseApiSocketForClient,
  type PurchaseApiSocketAccess,
} from "./socket.js";
import type { PurchaseView } from "../purchase/types.js";
import { assertPurchaseId } from "../purchase/identity.js";

export interface PurchaseApiClientOptions extends PurchaseApiSocketAccess {
  readonly socketPath: string;
  readonly credential: AgentApiCredential;
  readonly timeoutMs?: number;
}

export class PurchaseApiClientError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PurchaseApiClientError";
  }
}

/** Thin client used by MCP; it has no wallet, Journal, Authority, or protocol capability. */
export class PurchaseApiClient implements PurchaseApplication {
  private readonly socketPath: string;
  private readonly socketAccess: PurchaseApiSocketAccess;
  private readonly credential: AgentApiCredential;
  private readonly timeoutMs: number;

  constructor(options: PurchaseApiClientOptions) {
    this.socketPath = options.socketPath;
    this.socketAccess = Object.freeze({
      expectedServerUserId: options.expectedServerUserId,
      runtimeGroupId: options.runtimeGroupId,
    });
    this.credential = options.credential;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 125_000);
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
    try {
      verifyPurchaseApiSocketForClient(this.socketPath, this.socketAccess);
    } catch (cause) {
      throw new PurchaseApiClientError(
        "API_UNAVAILABLE",
        "The local Purchase API socket is unavailable or has an invalid identity.",
        true,
        { cause }
      );
    }
    const bodyBytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: http.IncomingMessage;
    try {
      response = await sendRequest({
        socketPath: this.socketPath,
        method,
        pathname,
        credential: this.credential,
        body: bodyBytes,
        signal: combined,
      });
    } catch (cause) {
      throw new PurchaseApiClientError(
        timeout.aborted ? "DEADLINE_EXCEEDED" : "API_UNAVAILABLE",
        timeout.aborted ? "The local Purchase API deadline elapsed." : "The local Purchase API is unavailable.",
        true,
        { cause }
      );
    } finally {
      bodyBytes?.fill(0);
    }
    const contentType = firstHeader(response.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      response.destroy();
      throw new PurchaseApiClientError("INVALID_API_RESPONSE", "The local Purchase API returned an invalid content type.", false);
    }
    const declared = firstHeader(response.headers["content-length"]);
    if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_PURCHASE_API_RESPONSE_BYTES)) {
      response.destroy();
      throw new PurchaseApiClientError("INVALID_API_RESPONSE", "The local Purchase API response exceeds the size limit.", false);
    }
    const bytes = await readBoundedResponse(response, MAX_PURCHASE_API_RESPONSE_BYTES);
    if (bytes.byteLength === 0) {
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
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300) return assertPurchaseView(value);
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

function sendRequest(input: Readonly<{
  socketPath: string;
  method: string;
  pathname: string;
  credential: AgentApiCredential;
  body: Buffer | undefined;
  signal: AbortSignal;
}>): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: input.socketPath,
      path: input.pathname,
      method: input.method,
      signal: input.signal,
      headers: {
        host: "sompi.local",
        authorization: `Bearer ${input.credential.token}`,
        accept: "application/json",
        ...(input.body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(input.body.byteLength),
        }),
      },
    });
    request.once("error", reject);
    request.once("response", resolve);
    request.end(input.body);
  });
}

async function readBoundedResponse(response: http.IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > limit) {
        response.destroy();
        throw new PurchaseApiClientError(
          "INVALID_API_RESPONSE",
          "The local Purchase API response exceeds the size limit.",
          false
        );
      }
      chunks.push(Buffer.from(chunk));
    }
    return Uint8Array.from(Buffer.concat(chunks, total));
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PurchaseApiClientError("INVALID_CONFIGURATION", "Purchase API timeout is invalid.", false);
  return value;
}
