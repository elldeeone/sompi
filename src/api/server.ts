import * as http from "node:http";

import {
  EvidenceAdmissionError,
  JournalNotFoundError,
  PurchaseAdmissionError,
} from "../purchase/journal.js";
import {
  MAX_PURCHASE_API_BODY_BYTES,
  PurchaseApiContractError,
  type PurchaseApiErrorBody,
  type PurchaseApplication,
  assertPurchaseView,
  parsePurchaseCreateRequest,
} from "./contracts.js";
import { agentApiCredentialMatches, type AgentApiCredential } from "./credential.js";

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_MAX_PURCHASE_CONCURRENCY = 8;
const DEFAULT_MAX_CONTROL_CONCURRENCY = 2;
const DEFAULT_MAX_CONNECTIONS = 32;
const PURCHASE_PATH = /^\/purchases\/(pur_[A-Za-z0-9_-]{22})(\/recover)?$/;

export interface PurchaseApiServerOptions {
  readonly application: PurchaseApplication;
  readonly credential: AgentApiCredential;
  readonly host?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly deadlineMs?: number;
  /** Concurrent create-Purchase requests. */
  readonly maxPurchaseConcurrency?: number;
  /** Reserved status/recovery requests, independent of create-Purchase work. */
  readonly maxControlConcurrency?: number;
  /** Hard bound on retained pre-authentication TCP sockets. */
  readonly maxConnections?: number;
  /** Operator-only diagnostic sink. Error details are never returned to the caller. */
  readonly onRequestError?: (error: unknown) => void;
}

export interface RunningPurchaseApiServer {
  readonly server: http.Server;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export class PurchaseApiServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseApiServerError";
  }
}

export async function startPurchaseApiServer(options: PurchaseApiServerOptions): Promise<RunningPurchaseApiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7442;
  const deadlineMs = positiveInteger(options.deadlineMs ?? DEFAULT_DEADLINE_MS, "API deadline");
  const maxPurchaseConcurrency = positiveInteger(
    options.maxPurchaseConcurrency ?? DEFAULT_MAX_PURCHASE_CONCURRENCY,
    "API Purchase concurrency"
  );
  const maxControlConcurrency = positiveInteger(
    options.maxControlConcurrency ?? DEFAULT_MAX_CONTROL_CONCURRENCY,
    "API control concurrency"
  );
  const totalConcurrency = maxPurchaseConcurrency + maxControlConcurrency;
  const maxConnections = positiveInteger(
    options.maxConnections ?? Math.max(DEFAULT_MAX_CONNECTIONS, totalConcurrency * 4),
    "API connection limit"
  );
  if (maxConnections < totalConcurrency) {
    throw new PurchaseApiServerError("Purchase API connection limit cannot be below total request concurrency");
  }
  if (host !== "127.0.0.1" && host !== "::1") throw new PurchaseApiServerError("Purchase API must bind to loopback");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new PurchaseApiServerError("Purchase API port is invalid");
  if (!options.application || !options.credential) throw new PurchaseApiServerError("Purchase API dependencies are unavailable");

  const purchaseLane = apiLane(maxPurchaseConcurrency);
  const controlLane = apiLane(maxControlConcurrency);
  const requestTimeout = deadlineMs + 5_000;
  const server = http.createServer({ requestTimeout, headersTimeout: Math.min(10_000, requestTimeout) }, (request, response) => {
    void (async () => {
      setSecurityHeaders(response);
      if (!agentApiCredentialMatches(options.credential, header(request, "authorization"))) {
        response.setHeader("www-authenticate", "Bearer");
        writeError(response, 401, "UNAUTHENTICATED", "A valid agent API credential is required.", false);
        return;
      }
      const lane = isPurchaseCreation(request) ? purchaseLane : controlLane;
      if (lane.active >= lane.maximum) {
        writeError(response, 429, "API_BUSY", "The Purchase API is at its concurrency limit.", true);
        return;
      }
      if (lane.overdue.size >= lane.maximum) {
        writeError(response, 503, "API_RECOVERY_SATURATED", "Prior timed-out work is still reconciling.", true);
        return;
      }
      lane.active += 1;
      const timeout = AbortSignal.timeout(deadlineMs);
      const disconnected = new AbortController();
      const abort = () => disconnected.abort(new Error("Purchase API client disconnected"));
      request.once("aborted", abort);
      const responseClosed = () => { if (!response.writableEnded) abort(); };
      response.once("close", responseClosed);
      const signal = AbortSignal.any([timeout, disconnected.signal]);
      let settled = false;
      let detached = false;
      const operation = routeRequest(options.application, request, signal);
      void operation.then(
        () => {
          settled = true;
          lane.overdue.delete(operation);
        },
        (error: unknown) => {
          settled = true;
          lane.overdue.delete(operation);
          if (detached) {
            try { options.onRequestError?.(error); } catch { /* diagnostics cannot alter recovery */ }
          }
        }
      );
      try {
        const view = await raceWithSignal(operation, signal);
        signal.throwIfAborted();
        writeView(response, view);
      } catch (error) {
        try { options.onRequestError?.(error); } catch { /* diagnostics cannot alter the API result */ }
        if (!response.destroyed && !response.headersSent) writeMappedError(response, error, timeout.aborted);
        else if (!response.destroyed) response.destroy();
      } finally {
        request.off("aborted", abort);
        response.off("close", responseClosed);
        if (!settled) {
          detached = true;
          lane.overdue.add(operation);
        }
        lane.active -= 1;
      }
    })().catch(() => {
      if (!response.headersSent) writeError(response, 500, "INTERNAL_ERROR", "Sompi failed safely.", false);
      else response.destroy();
    });
  });
  server.maxConnections = maxConnections;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new PurchaseApiServerError("Purchase API did not bind to TCP loopback");
  }
  const effectiveHost = host === "::1" ? "[::1]" : host;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    server,
    host,
    port: address.port,
    baseUrl: `http://${effectiveHost}:${address.port}`,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      return closePromise;
    },
  });
}

async function routeRequest(
  application: PurchaseApplication,
  request: http.IncomingMessage,
  signal: AbortSignal
): Promise<unknown> {
  const method = request.method ?? "";
  const target = request.url ?? "";
  if (target.includes("?") || target.includes("#") || target.includes("%")) {
    throw new HttpBoundaryError(400, "INVALID_TARGET", "The request target is invalid.", false);
  }
  if (method === "POST" && target === "/purchases") {
    if (header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new HttpBoundaryError(400, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.", false);
    }
    const input = parsePurchaseCreateRequest(await readJsonBody(request, signal));
    return application.purchase(input, signal);
  }
  const match = PURCHASE_PATH.exec(target);
  if (match && method === "GET" && match[2] === undefined) {
    rejectBody(request);
    return application.status(match[1], signal);
  }
  if (match && method === "POST" && match[2] === "/recover") {
    rejectBody(request);
    return application.recover(match[1], signal);
  }
  if (target === "/purchases" || match) {
    throw new HttpBoundaryError(405, "METHOD_NOT_ALLOWED", "The method is not supported for this resource.", false);
  }
  throw new HttpBoundaryError(404, "NOT_FOUND", "The resource does not exist.", false);
}

async function readJsonBody(request: http.IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const declared = header(request, "content-length");
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_PURCHASE_API_BODY_BYTES)) {
    throw new HttpBoundaryError(413, "REQUEST_TOO_LARGE", "The request body exceeds the limit.", false);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  let bytes = Buffer.alloc(0);
  const abortRead = () => request.destroy(
    signal.reason instanceof Error ? signal.reason : new Error("Purchase API request aborted")
  );
  signal.addEventListener("abort", abortRead, { once: true });
  try {
    for await (const value of request) {
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += chunk.byteLength;
      if (length > MAX_PURCHASE_API_BODY_BYTES) {
        throw new HttpBoundaryError(413, "REQUEST_TOO_LARGE", "The request body exceeds the limit.", false);
      }
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    bytes = Buffer.concat(chunks, length);
    try {
      if (bytes.byteLength === 0) throw new HttpBoundaryError(400, "INVALID_JSON", "A JSON request body is required.", false);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      if (error instanceof HttpBoundaryError) throw error;
      throw new HttpBoundaryError(400, "INVALID_JSON", "The request body is not valid UTF-8 JSON.", false);
    }
  } finally {
    signal.removeEventListener("abort", abortRead);
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason ?? new Error("Purchase API request aborted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function isPurchaseCreation(request: http.IncomingMessage): boolean {
  return request.method === "POST" && request.url === "/purchases";
}

function apiLane(maximum: number): {
  active: number;
  readonly maximum: number;
  readonly overdue: Set<Promise<unknown>>;
} {
  return { active: 0, maximum, overdue: new Set() };
}

function rejectBody(request: http.IncomingMessage): void {
  const length = header(request, "content-length");
  if ((length !== undefined && length !== "0") || header(request, "transfer-encoding") !== undefined) {
    throw new HttpBoundaryError(400, "UNEXPECTED_BODY", "This operation does not accept a request body.", false);
  }
}

function writeView(response: http.ServerResponse, value: unknown): void {
  const view = assertPurchaseView(value);
  writeJson(response, 200, view);
}

function writeMappedError(response: http.ServerResponse, error: unknown, timedOut: boolean): void {
  if (timedOut || (error instanceof DOMException && error.name === "TimeoutError")) {
    writeError(response, 504, "DEADLINE_EXCEEDED", "The request deadline elapsed; inspect the durable Purchase before retrying.", true);
  } else if (error instanceof HttpBoundaryError) {
    writeError(response, error.status, error.code, error.message, error.retryable);
  } else if (error instanceof PurchaseApiContractError) {
    writeError(response, 400, "INVALID_REQUEST", "The request does not match the Purchase contract.", false);
  } else if (error instanceof JournalNotFoundError) {
    writeError(response, 404, "PURCHASE_NOT_FOUND", "The Purchase does not exist.", false);
  } else if (error instanceof PurchaseAdmissionError || error instanceof EvidenceAdmissionError) {
    writeError(response, 429, "PURCHASE_ADMISSION_SATURATED", "Purchase admission is saturated.", true);
  } else if (error instanceof Error && error.name === "AbortError") {
    writeError(response, 504, "REQUEST_CANCELLED", "The request was cancelled; inspect the durable Purchase before retrying.", true);
  } else {
    writeError(response, 500, "INTERNAL_ERROR", "Sompi failed safely; ask the operator to inspect the local service.", false);
  }
}

function writeError(response: http.ServerResponse, status: number, code: string, message: string, retryable: boolean): void {
  const body: PurchaseApiErrorBody = { error: { code, message, retryable } };
  writeJson(response, status, body);
}

function writeJson(response: http.ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", bytes.byteLength);
  response.end(bytes);
}

function setSecurityHeaders(response: http.ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function header(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PurchaseApiServerError(`${label} is invalid`);
  return value;
}

class HttpBoundaryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "HttpBoundaryError";
  }
}
