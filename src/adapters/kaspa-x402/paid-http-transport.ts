import type { PinnedHttpTransport } from "../../http/pinned-transport.js";
import type {
  KaspaRequestContext,
  PurchaseEgressSession,
} from "../../purchase/coordinator.js";

const MAX_PAYMENT_HEADER_BYTES = 32 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface BoundedPaidHttpResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

export interface SendBoundedPaidRequestInput {
  readonly request: Readonly<KaspaRequestContext>;
  readonly egress: PurchaseEgressSession;
  readonly transport: PinnedHttpTransport;
  readonly paymentHeaderName: string;
  readonly paymentHeaderValue: string;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly error: (message: string, cause?: unknown) => Error;
}

/**
 * One reusable paid-HTTP transport boundary for exact and batch execution.
 * Signed payment artifacts are never forwarded across a redirect.
 */
export async function sendBoundedPaidRequest(
  input: Readonly<SendBoundedPaidRequestInput>
): Promise<BoundedPaidHttpResponse> {
  strictPaymentHeader(input.paymentHeaderValue, input.paymentHeaderName, input.error);
  assertEgressBinding(input.request, input.egress.request, input.error);
  const hop = input.egress.request;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) abortFromCaller();
  else input.signal.addEventListener("abort", abortFromCaller, { once: true });
  const remaining = hop.deadlineAtMs - readClock(input.now, input.error);
  if (remaining <= 0) controller.abort(new Error("egress deadline exceeded"));
  const timeout = setTimeout(
    () => controller.abort(new Error("egress deadline exceeded")),
    Math.max(1, remaining)
  );
  const guard = input.egress.responseGuard(hop, (reason) => controller.abort(reason));
  try {
    controller.signal.throwIfAborted();
    const headers: Array<readonly [string, string]> = [
      [input.paymentHeaderName, input.paymentHeaderValue],
    ];
    if (input.request.mediaType) headers.push(["content-type", input.request.mediaType]);
    const response = await input.transport.send({
      hop,
      headers: Object.freeze(headers),
      body: Uint8Array.from(input.request.body),
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
      throw input.error("paid request returned an invalid HTTP status");
    }
    const responseHeaders = normalizeHeaders(response.headers, input.error);
    guard.acceptHeaders(responseHeaders);
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      controller.signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) {
        throw input.error("paid request body yielded a non-byte chunk");
      }
      guard.acceptBodyChunk(chunk);
      chunks.push(Buffer.from(chunk));
    }
    guard.checkTime();
    if (REDIRECT_STATUS.has(response.status)) {
      throw input.error("paid request redirects are forbidden after payment authorization");
    }
    return Object.freeze({
      status: response.status,
      headers: responseHeaders,
      body: Uint8Array.from(Buffer.concat(chunks)),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "egress deadline exceeded") throw error;
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", abortFromCaller);
  }
}

export function requireSingleHttpHeader(
  headers: readonly (readonly [string, string])[],
  name: string,
  error: (message: string, cause?: unknown) => Error
): string | undefined {
  const values = headers
    .filter(([candidate]) => candidate.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);
  if (values.length > 1) throw error(`HTTP response repeated ${name}`);
  return values[0];
}

function strictPaymentHeader(
  value: string,
  name: string,
  error: (message: string, cause?: unknown) => Error
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PAYMENT_HEADER_BYTES ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw error(`${name} must be one canonical ASCII base64 value`);
  }
}

function normalizeHeaders(
  headers: readonly (readonly [string, string])[],
  error: (message: string, cause?: unknown) => Error
): readonly (readonly [string, string])[] {
  if (!Array.isArray(headers)) throw error("HTTP transport returned no header collection");
  return Object.freeze(headers.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw error("HTTP transport returned an invalid header");
    }
    return Object.freeze([entry[0], entry[1]] as const);
  }));
}

function assertEgressBinding(
  request: Readonly<KaspaRequestContext>,
  hop: PurchaseEgressSession["request"],
  error: (message: string, cause?: unknown) => Error
): void {
  if (
    hop.url !== request.url ||
    hop.method !== request.method ||
    hop.requestFingerprint !== request.requestFingerprint ||
    !bytesEqual(hop.body ?? new Uint8Array(), request.body)
  ) {
    throw error("address-pinned egress hop changed the authorized request");
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function readClock(now: () => number, error: (message: string, cause?: unknown) => Error): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw error("paid request clock is invalid");
  return value;
}
