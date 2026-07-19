import { sha256Hex, stableStringify, type Hash32Hex, type PaymentRequirements } from "@kaspa-x402/core";

export interface X402HttpRequestHashInput {
  readonly url: string;
  readonly method: string;
  readonly body: Uint8Array;
  readonly mediaType?: string;
}

/**
 * Reproduce the pinned alpha.8 HTTP fingerprint used by DirectModeClient and
 * DirectModeServer. Sompi's protocol-neutral resource fingerprint is not an
 * x402 requestHash: the latter also binds the selected payment requirements.
 */
export function x402HttpRequestHash(
  request: Readonly<X402HttpRequestHashInput>,
  accepted: Readonly<PaymentRequirements>,
): Hash32Hex {
  const body = x402CanonicalHttpBody(request.body, request.mediaType);
  return sha256Hex(
    stableStringify({
      method: request.method,
      url: request.url,
      body,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    }),
  );
}

function x402CanonicalHttpBody(bytes: Uint8Array, mediaType: string | undefined): unknown {
  if (bytes.byteLength === 0) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Kaspa-x402 HTTP requestHash requires an empty, JSON, or UTF-8 text body", {
      cause: error,
    });
  }
  const essence = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  if (essence === "application/json" || essence?.endsWith("+json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error("Kaspa-x402 JSON request body is not valid JSON", {
        cause: error,
      });
    }
  }
  if (essence?.startsWith("text/")) return text;
  throw new Error("Kaspa-x402 HTTP requestHash requires an explicit interoperable body profile");
}
