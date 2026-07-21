import * as fs from "node:fs";
import * as http from "node:http";

import {
  EvidenceAdmissionError,
  JournalNotFoundError,
  PurchaseAdmissionError,
} from "../purchase/journal.js";
import {
  MAX_SOMPI_API_BODY_BYTES,
  SompiApiContractError,
  type SompiApiErrorBody,
  type SompiApplication,
  assertTransferView,
  assertWalletActivity,
  assertWalletView,
  assertPurchaseView,
  assertPolicyChangeView,
  assertVaultMigrationView,
  assertWalletTechnicalView,
  parsePolicyChangeCreateRequest,
  parseVaultMigrationCreateRequest,
  parsePurchaseCreateRequest,
  parseTransferCreateRequest,
} from "./contracts.js";
import { TransferModuleError } from "../transfer/module.js";
import {
  agentApiCredentialMatches,
  recoveryApiCredentialMatches,
  type AgentApiCredential,
  type RecoveryApiCredential,
} from "./credential.js";
import {
  installAndVerifySompiApiSocket,
  prepareSompiApiSocketDirectory,
  removeOwnedSompiApiSocket,
  type SompiApiSocketAccess,
} from "./socket.js";

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_MAX_PURCHASE_CONCURRENCY = 8;
const DEFAULT_MAX_CONTROL_CONCURRENCY = 2;
const DEFAULT_MAX_CONNECTIONS = 32;
const PURCHASE_PATH = /^\/purchases\/(pur_[A-Za-z0-9_-]{22})(\/recover)?$/;
const TRANSFER_PATH = /^\/transfers\/(trf_[A-Za-z0-9_-]{22})(\/recover)?$/;
const POLICY_CHANGE_PATH = /^\/policy-changes\/(pcg_[A-Za-z0-9_-]{22})(\/recover)?$/;
const VAULT_MIGRATION_PATH = /^\/vault-migrations\/(vmg_[A-Za-z0-9_-]{22})$/;
const WALLET_ACTIVITY_PATH = /^\/wallet\/activity(?:\?limit=([1-9][0-9]{0,2}))?$/;

export interface SompiApiServerOptions extends SompiApiSocketAccess {
  readonly application: SompiApplication;
  readonly credential: AgentApiCredential;
  readonly socketPath: string;
  readonly deadlineMs?: number;
  /** Concurrent mutating Purchase or Transfer requests. */
  readonly maxMutationConcurrency?: number;
  /** Reserved status/recovery requests, independent of create-Purchase work. */
  readonly maxControlConcurrency?: number;
  /** Hard bound on retained pre-authentication local sockets. */
  readonly maxConnections?: number;
  /** Operator-only diagnostic sink. Error details are never returned to the caller. */
  readonly onRequestError?: (error: unknown) => void;
}

export interface SompiRecoveryApiServerOptions extends SompiApiSocketAccess {
  readonly application: SompiApplication;
  readonly credential: RecoveryApiCredential;
  readonly socketPath: string;
  readonly deadlineMs?: number;
  readonly maxControlConcurrency?: number;
  readonly maxConnections?: number;
  readonly onRequestError?: (error: unknown) => void;
}

export interface RunningSompiApiServer {
  readonly server: http.Server;
  readonly socketPath: string;
  close(): Promise<void>;
}

export class SompiApiServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SompiApiServerError";
  }
}

export async function startSompiApiServer(options: SompiApiServerOptions): Promise<RunningSompiApiServer> {
  return startSompiApiListener(options, "agent");
}

export async function startSompiRecoveryApiServer(
  options: SompiRecoveryApiServerOptions
): Promise<RunningSompiApiServer> {
  return startSompiApiListener(options, "operator-recovery");
}

async function startSompiApiListener(
  options: SompiApiServerOptions | SompiRecoveryApiServerOptions,
  audience: "agent" | "operator-recovery"
): Promise<RunningSompiApiServer> {
  const deadlineMs = positiveInteger(options.deadlineMs ?? DEFAULT_DEADLINE_MS, "API deadline");
  const maxMutationConcurrency = audience === "agent"
    ? positiveInteger(
        (options as SompiApiServerOptions).maxMutationConcurrency ?? DEFAULT_MAX_PURCHASE_CONCURRENCY,
        "API mutation concurrency"
      )
    : 0;
  const maxControlConcurrency = positiveInteger(
    options.maxControlConcurrency ?? DEFAULT_MAX_CONTROL_CONCURRENCY,
    "API control concurrency"
  );
  const totalConcurrency = maxMutationConcurrency + maxControlConcurrency;
  const maxConnections = positiveInteger(
    options.maxConnections ?? Math.max(DEFAULT_MAX_CONNECTIONS, totalConcurrency * 4),
    "API connection limit"
  );
  if (maxConnections < totalConcurrency) {
    throw new SompiApiServerError("Sompi API connection limit cannot be below total request concurrency");
  }
  if (!options.application || !options.credential) throw new SompiApiServerError("Sompi API dependencies are unavailable");

  const purchaseLane = apiLane(maxMutationConcurrency);
  const controlLane = apiLane(maxControlConcurrency);
  const requestTimeout = deadlineMs + 5_000;
  const server = http.createServer({ requestTimeout, headersTimeout: Math.min(10_000, requestTimeout) }, (request, response) => {
    void (async () => {
      setSecurityHeaders(response);
      const authorized = audience === "agent"
        ? agentApiCredentialMatches(options.credential as AgentApiCredential, header(request, "authorization"))
        : recoveryApiCredentialMatches(options.credential as RecoveryApiCredential, header(request, "authorization"));
      if (!authorized) {
        response.setHeader("www-authenticate", "Bearer");
        writeError(
          response,
          401,
          "UNAUTHENTICATED",
          `A valid ${audience === "agent" ? "agent" : "recovery"} API credential is required.`,
          false
        );
        return;
      }
      const lane = audience === "agent" && isMutation(request) ? purchaseLane : controlLane;
      if (lane.active >= lane.maximum) {
        writeError(response, 429, "API_BUSY", "The Sompi API is at its concurrency limit.", true);
        return;
      }
      if (lane.overdue.size >= lane.maximum) {
        writeError(response, 503, "API_RECOVERY_SATURATED", "Prior timed-out work is still reconciling.", true);
        return;
      }
      lane.active += 1;
      const timeout = AbortSignal.timeout(deadlineMs);
      const disconnected = new AbortController();
      const abort = () => disconnected.abort(new Error("Sompi API client disconnected"));
      request.once("aborted", abort);
      const responseClosed = () => { if (!response.writableEnded) abort(); };
      response.once("close", responseClosed);
      const signal = AbortSignal.any([timeout, disconnected.signal]);
      let settled = false;
      let detached = false;
      const operation = routeRequest(options.application, request, signal, audience);
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
  let socketIdentity: { dev: bigint; ino: bigint } | undefined;
  try {
    prepareSompiApiSocketDirectory(options.socketPath, options);
    if (fs.existsSync(options.socketPath)) {
      throw new SompiApiServerError("Sompi API socket path already exists");
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const created = fs.lstatSync(options.socketPath, { bigint: true });
    socketIdentity = { dev: created.dev, ino: created.ino };
    installAndVerifySompiApiSocket(options.socketPath, options, socketIdentity);
  } catch (cause) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    removeOwnedSompiApiSocket(options.socketPath, socketIdentity);
    if (cause instanceof SompiApiServerError) throw cause;
    throw new SompiApiServerError("Sompi API could not establish its secure local socket");
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    server,
    socketPath: options.socketPath,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          removeOwnedSompiApiSocket(options.socketPath, socketIdentity);
          error ? reject(error) : resolve();
        });
        server.closeIdleConnections();
      });
      return closePromise;
    },
  });
}

async function routeRequest(
  application: SompiApplication,
  request: http.IncomingMessage,
  signal: AbortSignal,
  audience: "agent" | "operator-recovery"
): Promise<unknown> {
  const method = request.method ?? "";
  const target = request.url ?? "";
  if (target.includes("#") || target.includes("%") || (target.includes("?") && !WALLET_ACTIVITY_PATH.test(target))) {
    throw new HttpBoundaryError(400, "INVALID_TARGET", "The request target is invalid.", false);
  }
  if (audience === "agent" && method === "POST" && target === "/purchases") {
    if (header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new HttpBoundaryError(400, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.", false);
    }
    const input = parsePurchaseCreateRequest(await readJsonBody(request, signal));
    return application.purchase(input, signal);
  }
  if (audience === "agent" && method === "POST" && target === "/transfers") {
    requireJson(request);
    const input = parseTransferCreateRequest(await readJsonBody(request, signal));
    return application.transfer(input, signal);
  }
  if (audience === "agent" && method === "POST" && target === "/policy-changes") {
    requireJson(request);
    return application.changePolicy(
      parsePolicyChangeCreateRequest(await readJsonBody(request, signal)),
      signal,
    );
  }
  if (audience === "agent" && method === "POST" && target === "/vault-migrations") {
    requireJson(request);
    return assertVaultMigrationView(await application.vaultMigration(
      parseVaultMigrationCreateRequest(await readJsonBody(request, signal)), signal,
    ));
  }
  if (audience === "agent" && method === "GET" && target === "/wallet") {
    rejectBody(request);
    return application.wallet(signal);
  }
  if (audience === "agent" && method === "GET" && target === "/wallet/technical") {
    rejectBody(request);
    return assertWalletTechnicalView(await application.walletTechnical(signal));
  }
  const activity = WALLET_ACTIVITY_PATH.exec(target);
  if (audience === "agent" && method === "GET" && activity) {
    rejectBody(request);
    const limit = activity[1] === undefined ? 20 : Number(activity[1]);
    if (limit < 1 || limit > 100) throw new HttpBoundaryError(400, "INVALID_LIMIT", "Wallet activity limit must be between 1 and 100.", false);
    return application.activity(limit, signal);
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
  const transferMatch = TRANSFER_PATH.exec(target);
  if (transferMatch && method === "GET" && transferMatch[2] === undefined) {
    rejectBody(request);
    return application.transferStatus(transferMatch[1], signal);
  }
  const policyChangeMatch = POLICY_CHANGE_PATH.exec(target);
  if (audience === "agent" && policyChangeMatch && method === "GET" && policyChangeMatch[2] === undefined) {
    rejectBody(request);
    return application.policyChangeStatus(policyChangeMatch[1], signal);
  }
  if (policyChangeMatch && method === "POST" && policyChangeMatch[2] === "/recover") {
    rejectBody(request);
    return application.policyChangeRecover(policyChangeMatch[1], signal);
  }
  const vaultMigrationMatch = VAULT_MIGRATION_PATH.exec(target);
  if (audience === "agent" && vaultMigrationMatch && method === "GET") {
    rejectBody(request);
    return application.vaultMigrationStatus(vaultMigrationMatch[1], signal);
  }
  if (transferMatch && method === "POST" && transferMatch[2] === "/recover") {
    rejectBody(request);
    return application.transferRecover(transferMatch[1], signal);
  }
  if (audience === "operator-recovery" && (
    target === "/purchases" || target === "/transfers" || target === "/policy-changes" || target === "/vault-migrations" ||
    target === "/wallet" || target.startsWith("/wallet/activity")
  )) {
    throw new HttpBoundaryError(404, "NOT_FOUND", "The resource does not exist.", false);
  }
  if (["/purchases", "/transfers", "/policy-changes", "/vault-migrations", "/wallet", "/wallet/technical", "/wallet/activity"].includes(target) || match || transferMatch || policyChangeMatch || vaultMigrationMatch || activity) {
    throw new HttpBoundaryError(405, "METHOD_NOT_ALLOWED", "The method is not supported for this resource.", false);
  }
  throw new HttpBoundaryError(404, "NOT_FOUND", "The resource does not exist.", false);
}

async function readJsonBody(request: http.IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const declared = header(request, "content-length");
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_SOMPI_API_BODY_BYTES)) {
    throw new HttpBoundaryError(413, "REQUEST_TOO_LARGE", "The request body exceeds the limit.", false);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  let bytes = Buffer.alloc(0);
  const abortRead = () => request.destroy(
    signal.reason instanceof Error ? signal.reason : new Error("Sompi API request aborted")
  );
  signal.addEventListener("abort", abortRead, { once: true });
  try {
    for await (const value of request) {
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += chunk.byteLength;
      if (length > MAX_SOMPI_API_BODY_BYTES) {
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
  const abort = () => rejectAbort(signal.reason ?? new Error("Sompi API request aborted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function isMutation(request: http.IncomingMessage): boolean {
  return request.method === "POST" && (
    request.url === "/purchases" || request.url === "/transfers" || request.url === "/policy-changes" || request.url === "/vault-migrations"
  );
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
  const view = Array.isArray(value)
    ? assertWalletActivity(value)
    : isRecord(value) && value.id?.toString().startsWith("trf_")
      ? assertTransferView(value)
      : isRecord(value) && value.id?.toString().startsWith("pcg_")
        ? assertPolicyChangeView(value)
      : isRecord(value) && value.id?.toString().startsWith("vmg_")
        ? assertVaultMigrationView(value)
      : isRecord(value) && value.receiveAddress !== undefined && value.activeVault !== undefined
        ? assertWalletTechnicalView(value)
      : isRecord(value) && value.network === "kaspa:testnet-10" && value.balance !== undefined
        ? assertWalletView(value)
        : assertPurchaseView(value);
  writeJson(response, 200, view);
}

function writeMappedError(response: http.ServerResponse, error: unknown, timedOut: boolean): void {
  if (timedOut || (error instanceof DOMException && error.name === "TimeoutError")) {
    writeError(response, 504, "DEADLINE_EXCEEDED", "Sompi is still checking the original operation. Retry only with the same request key or operation ID.", true);
  } else if (error instanceof HttpBoundaryError) {
    writeError(response, error.status, error.code, error.message, error.retryable);
  } else if (error instanceof SompiApiContractError) {
    writeError(response, 400, "INVALID_REQUEST", "The request does not match the Sompi API contract.", false);
  } else if (error instanceof TransferModuleError) {
    const status = error.code === "TRANSFER_NOT_FOUND" ? 404 : error.code === "TRANSFER_CONFLICT" ? 409 : error.code === "TRANSFER_DENIED" ? 403 : error.code === "TRANSFER_EXPIRED" ? 410 : error.code === "INVALID_TRANSFER" ? 400 : 500;
    writeError(response, status, error.code, error.message, error.code === "TRANSFER_FAILED");
  } else if (error instanceof JournalNotFoundError) {
    writeError(response, 404, "PURCHASE_NOT_FOUND", "The Purchase does not exist.", false);
  } else if (error instanceof PurchaseAdmissionError || error instanceof EvidenceAdmissionError) {
    writeError(response, 429, "PURCHASE_ADMISSION_SATURATED", "Purchase admission is saturated.", true);
  } else if (error instanceof Error && error.name === "AbortError") {
    writeError(response, 504, "REQUEST_CANCELLED", "The request stopped, but the original operation remains safe. Retry only with the same request key or operation ID.", true);
  } else {
    writeError(response, 500, "INTERNAL_ERROR", "Sompi stopped safely. Ask the operator to check the local service.", false);
  }
}

function requireJson(request: http.IncomingMessage): void {
  if (header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpBoundaryError(400, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.", false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeError(response: http.ServerResponse, status: number, code: string, message: string, retryable: boolean): void {
  const body: SompiApiErrorBody = { error: { code, message, retryable } };
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
  if (!Number.isSafeInteger(value) || value <= 0) throw new SompiApiServerError(`${label} is invalid`);
  return value;
}

class HttpBoundaryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "HttpBoundaryError";
  }
}
