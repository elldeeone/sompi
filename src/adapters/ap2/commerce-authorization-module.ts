import type { PinnedHttpTransport } from "../../http/pinned-transport.js";
import type {
  CommerceAuthorizationContext,
  CommerceAuthorizationModule,
  CommerceAuthorizationRecoveryObservation,
  CommerceAuthorizationSubmissionResult,
  PurchaseEgressSession,
  VerifiedArtifact,
} from "../../purchase/coordinator.js";
import type { SafeTransportHop } from "../../purchase/egress-policy.js";
import { evidenceDigest } from "../../purchase/identity.js";
import type { Sha256Digest } from "../../purchase/types.js";
import type {
  Ap2CommerceEvidenceSource,
  VerifiedAp2CommerceEvidence,
} from "./paid-response-verifier.js";

export const AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE =
  "urn:sompi:ap2:commerce-authorization-http:1" as const;
export const AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE =
  "urn:sompi:ap2:commerce-authorization-acceptance:1" as const;
export const AP2_CHECKOUT_AUTHORIZATION_PATH =
  "/.well-known/sompi/ap2/checkout-authorization" as const;
export const AP2_PAYMENT_AUTHORIZATION_PATH =
  "/.well-known/sompi/ap2/payment-authorization" as const;
export const AP2_AUTHORIZATION_STATUS_PATH =
  "/.well-known/sompi/ap2/authorization-status" as const;

const MEDIA_TYPE = "application/vnd.sompi.ap2-commerce-authorization+json";
const VERIFIER_ID = "sompi:ap2-commerce-http:v1";
const MAX_BODY_BYTES = 256 * 1024;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;

export interface Ap2CommerceAuthorizationPresentation {
  readonly profile: typeof AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE;
  readonly version: 1;
  readonly stage: "checkout" | "payment";
  readonly purchaseId: string;
  readonly paymentIdentifier: string;
  readonly checkoutDigest: Sha256Digest;
  readonly authorizationEvidenceDigest: Sha256Digest;
  readonly mandate: string;
  readonly mandateDigest: Sha256Digest;
}

export interface Ap2CommerceAuthorizationStageAcceptance {
  readonly profile: typeof AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE;
  readonly version: 1;
  readonly status: "accepted";
  readonly stage: "checkout" | "payment";
  readonly purchaseId: string;
  readonly paymentIdentifier: string;
  readonly checkoutDigest: Sha256Digest;
  readonly mandateDigest: Sha256Digest;
  readonly acceptedAtMs: number;
}

export interface Ap2CommerceAuthorizationAcceptance {
  readonly profile: typeof AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE;
  readonly version: 1;
  readonly status: "accepted";
  readonly purchaseId: string;
  readonly paymentIdentifier: string;
  readonly checkoutDigest: Sha256Digest;
  readonly authorizationEvidenceDigest: Sha256Digest;
  readonly checkoutMandateDigest: Sha256Digest;
  readonly paymentMandateDigest: Sha256Digest;
  readonly checkoutAcceptanceDigest: Sha256Digest;
  readonly paymentAcceptanceDigest: Sha256Digest;
}

export interface Ap2HttpCommerceAuthorizationModuleOptions {
  readonly evidenceSource: Ap2CommerceEvidenceSource;
  readonly transport: PinnedHttpTransport;
  readonly checkoutPath?: string;
  readonly paymentPath?: string;
  readonly statusPath?: string;
  readonly now?: () => number;
}

/**
 * Presents AP2 mandates over a separate Merchant HTTP stage. The small Sompi
 * envelope is adapter-local correlation, not an AP2-in-x402 extension.
 */
export class Ap2HttpCommerceAuthorizationModule
implements CommerceAuthorizationModule {
  private readonly checkoutPath: string;
  private readonly paymentPath: string;
  private readonly statusPath: string;
  private readonly now: () => number;

  constructor(private readonly options: Ap2HttpCommerceAuthorizationModuleOptions) {
    if (
      typeof options?.evidenceSource?.load !== "function" ||
      typeof options?.transport?.send !== "function"
    ) {
      throw new Error("AP2 Merchant authorization configuration is incomplete");
    }
    this.checkoutPath = canonicalAbsolutePath(
      options.checkoutPath ?? AP2_CHECKOUT_AUTHORIZATION_PATH
    );
    this.paymentPath = canonicalAbsolutePath(
      options.paymentPath ?? AP2_PAYMENT_AUTHORIZATION_PATH
    );
    this.statusPath = canonicalAbsolutePath(
      options.statusPath ?? AP2_AUTHORIZATION_STATUS_PATH
    );
    this.now = options.now ?? Date.now;
    readClock(this.now);
  }

  async present(
    input: Parameters<CommerceAuthorizationModule["present"]>[0]
  ): Promise<CommerceAuthorizationSubmissionResult> {
    input.signal.throwIfAborted();
    const evidence = await this.requireEvidence(input.context);
    const checkout = presentation(
      "checkout",
      input.context,
      evidence.mandates.checkout.artifact
    );
    const checkoutAcceptance = await this.sendPresentation(
      input.context,
      input.egress,
      this.checkoutPath,
      checkout,
      input.signal
    );
    input.signal.throwIfAborted();
    const payment = presentation(
      "payment",
      input.context,
      evidence.mandates.payment.artifact
    );
    const paymentAcceptance = await this.sendPresentation(
      input.context,
      input.egress,
      this.paymentPath,
      payment,
      input.signal
    );
    const acceptance = acceptanceDocument(
      input.context,
      evidence,
      checkoutAcceptance,
      paymentAcceptance
    );
    const artifact = verifiedAcceptanceArtifact(acceptance, input.context.merchantId);
    return Object.freeze({
      status: "accepted" as const,
      submissionDigest: artifact.declaredDigest!,
      acceptance: artifact,
    });
  }

  async observe(
    input: Parameters<CommerceAuthorizationModule["observe"]>[0]
  ): Promise<CommerceAuthorizationRecoveryObservation> {
    const evidence = await this.requireEvidence(input.context);
    const target = endpointUrl(input.context.merchantOrigin, this.statusPath);
    target.searchParams.set("purchaseId", input.context.purchaseId);
    target.searchParams.set("paymentIdentifier", input.context.paymentIdentifier);
    target.searchParams.set("checkoutDigest", input.context.checkoutDigest);
    const response = await this.send(
      input.context,
      input.egress,
      target.href,
      "GET",
      new Uint8Array(),
      new AbortController().signal
    );
    if (response.status === 404) {
      return Object.freeze({
        status: "not_found" as const,
        safeToRetry: true,
        detailDigest: evidenceDigest("ap2-commerce-authorization:not-found"),
      });
    }
    if (response.status === 409) {
      return Object.freeze({
        status: "conflict" as const,
        detailDigest: evidenceDigest(response.body),
      });
    }
    if (response.status !== 200) {
      return Object.freeze({
        status: "pending" as const,
        detailDigest: evidenceDigest(response.body),
      });
    }
    const acceptance = decodeAp2CommerceAuthorizationAcceptance(response.body);
    assertAcceptance(acceptance, input.context, evidence);
    return Object.freeze({
      status: "accepted" as const,
      acceptance: verifiedAcceptanceArtifact(
        acceptance,
        input.context.merchantId
      ),
    });
  }

  private async requireEvidence(
    context: Readonly<CommerceAuthorizationContext>
  ): Promise<VerifiedAp2CommerceEvidence> {
    const evidence = await this.options.evidenceSource.load(context.purchaseId);
    if (!evidence) throw new Error("verified AP2 Merchant authorization evidence is unavailable");
    if (
      evidence.checkout.purchaseId !== context.purchaseId ||
      evidence.checkout.checkoutDigest !== context.checkoutDigest ||
      evidence.checkout.terms.resourceFingerprint !== context.resourceFingerprint ||
      evidence.checkout.resourceUrl !== context.resourceUrl ||
      evidence.checkout.method !== context.method ||
      evidence.checkout.terms.merchant.id !== context.merchantId ||
      evidence.checkout.terms.merchant.origin !== context.merchantOrigin ||
      evidence.checkout.terms.amountAtomic !== context.amountAtomic ||
      evidence.checkout.terms.asset !== context.asset ||
      evidence.checkout.terms.network !== context.network ||
      evidence.checkout.terms.payTo !== context.payTo ||
      evidence.authorizationEvidenceDigest !== context.authorizationEvidenceDigest ||
      evidence.mandates.checkout.content.checkout_jwt !== evidence.checkout.artifact ||
      evidence.mandates.payment.content.transaction_id !== evidence.checkout.checkoutHash
    ) {
      throw new Error("verified AP2 evidence does not match the exact Merchant authorization context");
    }
    return evidence;
  }

  private async sendPresentation(
    context: Readonly<CommerceAuthorizationContext>,
    egress: PurchaseEgressSession,
    path: string,
    value: Ap2CommerceAuthorizationPresentation,
    signal: AbortSignal
  ): Promise<Ap2CommerceAuthorizationStageAcceptance> {
    const body = encodeCanonicalJson(value);
    const response = await this.send(
      context,
      egress,
      endpointUrl(context.merchantOrigin, path).href,
      "POST",
      body,
      signal
    );
    if (response.status !== 200) {
      throw new Error(`Merchant rejected AP2 ${value.stage} authorization presentation`);
    }
    const acceptance = decodeStageAcceptance(response.body);
    assertStageAcceptance(acceptance, value, this.now);
    return acceptance;
  }

  private async send(
    context: Readonly<CommerceAuthorizationContext>,
    egress: PurchaseEgressSession,
    url: string,
    method: "GET" | "POST",
    body: Uint8Array,
    signal: AbortSignal
  ): Promise<{ status: number; body: Uint8Array }> {
    const hop = await egress.requestFor({
      url,
      method,
      ...(method === "POST" ? { body, mediaType: MEDIA_TYPE } : {}),
    });
    if (new URL(hop.url).origin !== context.merchantOrigin) {
      throw new Error("AP2 Merchant authorization endpoint changed Merchant origin");
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
    const remaining = hop.deadlineAtMs - readClock(this.now);
    const timeout = setTimeout(
      () => controller.abort(new Error("AP2 Merchant authorization deadline exceeded")),
      Math.max(1, remaining)
    );
    timeout.unref();
    const guard = egress.responseGuard(hop, (reason) => controller.abort(reason));
    try {
      controller.signal.throwIfAborted();
      const response = await this.options.transport.send({
        hop,
        headers: Object.freeze([
          ["accept", MEDIA_TYPE] as const,
          ...(method === "POST" ? [["content-type", MEDIA_TYPE] as const] : []),
        ]),
        body: Uint8Array.from(body),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        throw new Error("AP2 Merchant authorization endpoints must not redirect");
      }
      guard.acceptHeaders(response.headers);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        controller.signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) throw new Error("Merchant authorization body is invalid");
        guard.acceptBodyChunk(chunk);
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) {
          controller.abort(new Error("Merchant authorization body is oversized"));
          controller.signal.throwIfAborted();
        }
        chunks.push(Buffer.from(chunk));
      }
      guard.checkTime();
      return { status: response.status, body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortFromCaller);
    }
  }
}

function presentation(
  stage: "checkout" | "payment",
  context: Readonly<CommerceAuthorizationContext>,
  mandate: string
): Ap2CommerceAuthorizationPresentation {
  return Object.freeze({
    profile: AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE,
    version: 1 as const,
    stage,
    purchaseId: context.purchaseId,
    paymentIdentifier: context.paymentIdentifier,
    checkoutDigest: context.checkoutDigest,
    authorizationEvidenceDigest: context.authorizationEvidenceDigest,
    mandate,
    mandateDigest: evidenceDigest(mandate),
  });
}

function acceptanceDocument(
  context: Readonly<CommerceAuthorizationContext>,
  evidence: VerifiedAp2CommerceEvidence,
  checkout: Ap2CommerceAuthorizationStageAcceptance,
  payment: Ap2CommerceAuthorizationStageAcceptance
): Ap2CommerceAuthorizationAcceptance {
  const result = Object.freeze({
    profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
    version: 1 as const,
    status: "accepted" as const,
    purchaseId: context.purchaseId,
    paymentIdentifier: context.paymentIdentifier,
    checkoutDigest: context.checkoutDigest,
    authorizationEvidenceDigest: context.authorizationEvidenceDigest,
    checkoutMandateDigest: evidenceDigest(evidence.mandates.checkout.artifact),
    paymentMandateDigest: evidenceDigest(evidence.mandates.payment.artifact),
    checkoutAcceptanceDigest: evidenceDigest(encodeCanonicalJson(checkout)),
    paymentAcceptanceDigest: evidenceDigest(encodeCanonicalJson(payment)),
  });
  assertAcceptance(result, context, evidence);
  return result;
}

function assertAcceptance(
  value: Ap2CommerceAuthorizationAcceptance,
  context: Readonly<CommerceAuthorizationContext>,
  evidence: VerifiedAp2CommerceEvidence
): void {
  if (
    value.profile !== AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE ||
    value.version !== 1 ||
    value.status !== "accepted" ||
    value.purchaseId !== context.purchaseId ||
    value.paymentIdentifier !== context.paymentIdentifier ||
    value.checkoutDigest !== context.checkoutDigest ||
    value.authorizationEvidenceDigest !== context.authorizationEvidenceDigest ||
    value.checkoutMandateDigest !== evidenceDigest(evidence.mandates.checkout.artifact) ||
    value.paymentMandateDigest !== evidenceDigest(evidence.mandates.payment.artifact) ||
    !DIGEST.test(value.checkoutAcceptanceDigest) ||
    !DIGEST.test(value.paymentAcceptanceDigest)
  ) {
    throw new Error("Merchant AP2 authorization acceptance is differently bound");
  }
}

function assertStageAcceptance(
  value: Ap2CommerceAuthorizationStageAcceptance,
  request: Ap2CommerceAuthorizationPresentation,
  now: () => number
): void {
  const current = readClock(now);
  if (
    value.profile !== AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE ||
    value.version !== 1 ||
    value.status !== "accepted" ||
    value.stage !== request.stage ||
    value.purchaseId !== request.purchaseId ||
    value.paymentIdentifier !== request.paymentIdentifier ||
    value.checkoutDigest !== request.checkoutDigest ||
    value.mandateDigest !== request.mandateDigest ||
    !Number.isSafeInteger(value.acceptedAtMs) ||
    value.acceptedAtMs <= 0 ||
    value.acceptedAtMs > current + 300_000
  ) {
    throw new Error("Merchant AP2 stage acceptance is differently bound");
  }
}

function verifiedAcceptanceArtifact(
  value: Ap2CommerceAuthorizationAcceptance,
  issuer: string
): VerifiedArtifact {
  const bytes = encodeCanonicalJson(value);
  const digest = evidenceDigest(bytes);
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    mediaType: MEDIA_TYPE,
    profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
    issuer,
    declaredDigest: digest,
    verification: Object.freeze({
      verifierId: VERIFIER_ID,
      profile: AP2_COMMERCE_AUTHORIZATION_ACCEPTANCE_PROFILE,
      detailDigest: digest,
    }),
  });
}

export function decodeAp2CommerceAuthorizationPresentation(
  bytes: Uint8Array
): Ap2CommerceAuthorizationPresentation {
  const value = decodeCanonicalJson(bytes);
  exactKeys(value, [
    "authorizationEvidenceDigest", "checkoutDigest", "mandate", "mandateDigest",
    "paymentIdentifier", "profile", "purchaseId", "stage", "version",
  ]);
  if (
    value.profile !== AP2_COMMERCE_AUTHORIZATION_HTTP_PROFILE ||
    value.version !== 1 ||
    (value.stage !== "checkout" && value.stage !== "payment") ||
    typeof value.purchaseId !== "string" ||
    typeof value.paymentIdentifier !== "string" ||
    typeof value.checkoutDigest !== "string" ||
    typeof value.authorizationEvidenceDigest !== "string" ||
    typeof value.mandate !== "string" ||
    typeof value.mandateDigest !== "string" ||
    evidenceDigest(value.mandate) !== value.mandateDigest
  ) {
    throw new Error("AP2 Merchant authorization presentation is malformed");
  }
  return value as unknown as Ap2CommerceAuthorizationPresentation;
}

export function encodeStageAcceptance(
  value: Ap2CommerceAuthorizationStageAcceptance
): Uint8Array {
  return encodeCanonicalJson(value);
}

export function encodeAp2CommerceAuthorizationAcceptance(
  value: Ap2CommerceAuthorizationAcceptance
): Uint8Array {
  return encodeCanonicalJson(value);
}

export function decodeAp2CommerceAuthorizationAcceptance(
  bytes: Uint8Array
): Ap2CommerceAuthorizationAcceptance {
  const value = decodeCanonicalJson(bytes);
  exactKeys(value, [
    "authorizationEvidenceDigest", "checkoutAcceptanceDigest", "checkoutDigest",
    "checkoutMandateDigest", "paymentAcceptanceDigest", "paymentIdentifier",
    "paymentMandateDigest", "profile", "purchaseId", "status", "version",
  ]);
  return value as unknown as Ap2CommerceAuthorizationAcceptance;
}

function decodeStageAcceptance(
  bytes: Uint8Array
): Ap2CommerceAuthorizationStageAcceptance {
  const value = decodeCanonicalJson(bytes);
  exactKeys(value, [
    "acceptedAtMs", "checkoutDigest", "mandateDigest", "paymentIdentifier",
    "profile", "purchaseId", "stage", "status", "version",
  ]);
  return value as unknown as Ap2CommerceAuthorizationStageAcceptance;
}

function endpointUrl(origin: string, path: string): URL {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new Error("AP2 Merchant authorization endpoint is not same-origin");
  }
  return url;
}

function canonicalAbsolutePath(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    new URL(value, "https://merchant.invalid").pathname !== value
  ) {
    throw new Error("AP2 Merchant authorization path is invalid");
  }
  return value;
}

function encodeCanonicalJson(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(sortJson(value)), "utf8");
}

function decodeCanonicalJson(bytes: Uint8Array): Record<string, unknown> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) {
    throw new Error("AP2 Merchant authorization JSON is empty or oversized");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("AP2 Merchant authorization JSON is malformed");
  }
  if (!isRecord(value) || !Buffer.from(encodeCanonicalJson(value)).equals(Buffer.from(bytes))) {
    throw new Error("AP2 Merchant authorization JSON is not canonical");
  }
  return value;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])])
  );
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error("AP2 Merchant authorization JSON has unsupported fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("AP2 Merchant authorization clock is unavailable");
  }
  return value;
}
