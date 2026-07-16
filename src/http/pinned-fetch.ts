import type { PinnedHttpTransport } from "./pinned-transport.js";
import { EgressPolicy } from "../purchase/egress-policy.js";

/** Minimal Fetch-compatible GET adapter over Sompi's address-pinned transport. */
export function createPinnedGetFetch(
  policy: EgressPolicy,
  transport: PinnedHttpTransport,
  now: () => number = Date.now,
): typeof globalThis.fetch {
  if (!policy || typeof transport?.send !== "function") {
    throw new Error("pinned fetch dependencies are incomplete");
  }
  return (async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" || init?.body !== undefined && init.body !== null) {
      throw new Error("pinned witness fetch supports bodyless GET only");
    }
    if (init?.redirect !== undefined && init.redirect !== "error") {
      throw new Error("pinned witness fetch forbids redirects");
    }
    const signal = init?.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const hop = await policy.validateRequest({ url, method: "GET" });
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const remaining = hop.deadlineAtMs - now();
    const timeout = setTimeout(
      () => controller.abort(new Error("pinned witness request deadline exceeded")),
      Math.max(1, remaining),
    );
    const guard = policy.createResponseGuard(hop, (reason) => controller.abort(reason));
    try {
      const headers = requestHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const response = await transport.send({
        hop,
        headers,
        body: new Uint8Array(),
        signal: controller.signal,
      });
      guard.acceptHeaders(response.headers);
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        controller.signal.throwIfAborted();
        guard.acceptBodyChunk(chunk);
        chunks.push(Buffer.from(chunk));
      }
      guard.checkTime();
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }) as typeof globalThis.fetch;
}

function requestHeaders(
  value: RequestInit["headers"] | undefined,
): readonly (readonly [string, string])[] {
  if (value === undefined) return Object.freeze([]);
  const headers = new Headers(value);
  return Object.freeze([...headers.entries()].map(([name, headerValue]) =>
    Object.freeze([name, headerValue] as const)
  ));
}
