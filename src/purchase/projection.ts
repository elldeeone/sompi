import { kasAmountView } from "../amount-display.js";
import type {
  CheckoutTerms,
  PaymentAttemptView,
  PurchaseAuthorizationView,
  PurchaseId,
  PurchaseRequestKey,
  PurchaseState,
  PurchaseView,
  Sha256Digest,
  TreasuryView,
} from "./types.js";

export const MAX_INLINE_FULFILMENT_BYTES = 8 * 1024;
const MAX_SUMMARY_CHARACTERS = 240;
const MAX_DISPLAY_LABEL_CHARACTERS = 80;
const MAX_FULFILMENT_HANDLE_CHARACTERS = 240;
const SAFE_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export interface PurchaseProjectionSnapshot {
  id: PurchaseId;
  requestKey: PurchaseRequestKey;
  state: PurchaseState;
  resourceFingerprint: Sha256Digest;
  terms?: CheckoutTerms;
  authorization: PurchaseAuthorizationView;
  treasury: TreasuryView;
  paymentAttempts: readonly PaymentAttemptView[];
  settlementEvidence?: Sha256Digest;
  fulfilment?: {
    digest?: Sha256Digest;
    /** Raw response bytes are required before content may be projected inline. */
    bodyBytes?: Uint8Array;
    mediaType?: string;
    /** Opaque, implementation-owned reference. It is never resolved here. */
    handle?: string;
    byteLength?: number;
  };
  receiptEvidence: readonly Sha256Digest[];
  /** A durable external effect exists that must be reconciled before progress. */
  recoveryRequired?: boolean;
}

export type ProjectedPurchaseView = PurchaseView;

export class PurchaseProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseProjectionError";
  }
}

interface StateProjection {
  summary: (snapshot: PurchaseProjectionSnapshot) => string;
  userAction: string;
}

const STATE_PROJECTIONS = {
  created: {
    summary: () => "Starting purchase.",
    userAction: "none",
  },
  terms_bound: {
    summary: (snapshot) => `Purchase ready${termsSubject(snapshot)}.`,
    userAction: "none",
  },
  awaiting_authority: {
    summary: (snapshot) => `Waiting for user approval${termsSubject(snapshot)}.`,
    userAction: "Approve or deny the exact purchase in the trusted authority.",
  },
  authorised: {
    summary: (snapshot) => `Purchase approved${termsSubject(snapshot)}. Preparing payment.`,
    userAction: "none",
  },
  execution_prepared: {
    summary: (snapshot) => `Payment prepared${termsSubject(snapshot)}. Sending now.`,
    userAction: "none",
  },
  submitted: {
    summary: () => "Payment sent. Waiting for confirmation.",
    userAction: "none",
  },
  settled: {
    summary: () => "Payment confirmed. Waiting for the merchant response.",
    userAction: "none",
  },
  fulfilled: {
    summary: () => "Purchase completed. Finishing the receipt.",
    userAction: "none",
  },
  receipted: {
    summary: () => "Purchase completed successfully.",
    userAction: "none",
  },
  denied: {
    summary: () => "Purchase denied. No payment was made.",
    userAction: "Start a new purchase only if the terms or operator decision change.",
  },
  cancelled: {
    summary: () => "Purchase cancelled. No further action will be taken.",
    userAction: "none",
  },
  expired: {
    summary: () => "Purchase offer expired. No payment was made.",
    userAction: "Start a new purchase to obtain fresh merchant terms and authorization.",
  },
  failed_recoverable: {
    summary: () => "Sompi is checking the original payment. Do not pay again.",
    userAction: "Run purchase_recover for this Purchase; do not submit another payment.",
  },
  failed_terminal: {
    summary: () => "Purchase stopped safely. Operator review is required.",
    userAction: "Ask the operator to review the Purchase record; do not retry or pay again.",
  },
} satisfies Readonly<Record<PurchaseState, StateProjection>>;

/**
 * Projects protocol-neutral internal state into the stable, secret-free view.
 * Unknown properties on a runtime snapshot are deliberately not copied.
 */
export function projectPurchaseView(snapshot: PurchaseProjectionSnapshot): ProjectedPurchaseView {
  const stateProjection = STATE_PROJECTIONS[snapshot.state];
  if (!stateProjection) throw new PurchaseProjectionError("unsupported Purchase state");

  const recoveryPending = snapshot.recoveryRequired === true;

  const fulfilment = projectFulfilment(snapshot.fulfilment);
  const view: ProjectedPurchaseView = {
    id: snapshot.id,
    requestKey: snapshot.requestKey,
    state: snapshot.state,
    summary: boundSummary(
      recoveryPending
        ? "Sompi is checking the original payment. Do not pay again."
        : stateProjection.summary(snapshot)
    ),
    userAction: recoveryPending
      ? "Run purchase_recover for this Purchase; do not submit another payment."
      : stateProjection.userAction,
    resourceFingerprint: snapshot.resourceFingerprint,
    ...(snapshot.terms ? { terms: copyTerms(snapshot.terms) } : {}),
    ...(snapshot.terms ? {
      display: Object.freeze({
        price: kasAmountView(snapshot.terms.amountAtomic),
        additionalCostCeiling: kasAmountView(snapshot.treasury.additionalCostCeilingAtomic ?? "0"),
        maximumCharge: kasAmountView(
          BigInt(snapshot.terms.amountAtomic) + BigInt(snapshot.treasury.additionalCostCeilingAtomic ?? "0"),
        ),
      }),
    } : {}),
    authorization: copyAuthorization(snapshot.authorization),
    treasury: copyTreasury(snapshot.treasury),
    paymentAttempts: copyPaymentAttempts(snapshot.paymentAttempts),
    ...(snapshot.settlementEvidence ? { settlementEvidence: snapshot.settlementEvidence } : {}),
    ...(fulfilment.digest ? { fulfilmentDigest: fulfilment.digest } : {}),
    receiptEvidence: sortedDigests(snapshot.receiptEvidence),
    ...(fulfilment.body !== undefined ? { fulfilmentBody: fulfilment.body } : {}),
    ...(fulfilment.handle !== undefined ? { fulfilmentHandle: fulfilment.handle } : {}),
  };
  return view;
}

/** Returns the same bounded human summary used by projectPurchaseView. */
export function projectPurchaseSummary(snapshot: PurchaseProjectionSnapshot): string {
  const stateProjection = STATE_PROJECTIONS[snapshot.state];
  if (!stateProjection) throw new PurchaseProjectionError("unsupported Purchase state");
  if (snapshot.recoveryRequired === true) {
    return boundSummary(
      "Sompi is checking the original payment. Do not pay again."
    );
  }
  return boundSummary(stateProjection.summary(snapshot));
}

function projectFulfilment(fulfilment: PurchaseProjectionSnapshot["fulfilment"]): {
  digest?: Sha256Digest;
  body?: string;
  handle?: string;
} {
  if (!fulfilment) return {};
  const bytes = fulfilment.bodyBytes instanceof Uint8Array
    ? Buffer.from(
      fulfilment.bodyBytes.buffer,
      fulfilment.bodyBytes.byteOffset,
      fulfilment.bodyBytes.byteLength
    )
    : undefined;
  const byteLength = bytes?.byteLength;
  if (fulfilment.byteLength !== undefined) {
    requireByteLength(fulfilment.byteLength);
    if (byteLength !== undefined && fulfilment.byteLength !== byteLength) {
      throw new PurchaseProjectionError("fulfilment body length does not match its recorded length");
    }
  }

  const handle = fulfilment.handle === undefined ? undefined : requireSafeHandle(fulfilment.handle);
  if (
    bytes !== undefined &&
    bytes.byteLength <= MAX_INLINE_FULFILMENT_BYTES &&
    explicitlyUtf8TextMediaType(fulfilment.mediaType)
  ) {
    const body = strictUtf8Text(bytes);
    if (body !== undefined) return { digest: fulfilment.digest, body };
  }
  if (byteLength !== undefined && !handle) {
    throw new PurchaseProjectionError("non-inline fulfilment requires an implementation-owned handle");
  }
  return {
    ...(fulfilment.digest ? { digest: fulfilment.digest } : {}),
    ...(handle ? { handle } : {}),
  };
}

function copyTerms(terms: CheckoutTerms): CheckoutTerms {
  return {
    merchant: {
      id: terms.merchant.id,
      name: terms.merchant.name,
      origin: terms.merchant.origin,
    },
    resourceFingerprint: terms.resourceFingerprint,
    amountAtomic: terms.amountAtomic,
    asset: terms.asset,
    network: terms.network,
    payTo: terms.payTo,
    expiresAt: terms.expiresAt,
    checkoutDigest: terms.checkoutDigest,
  };
}

function copyAuthorization(authorization: PurchaseAuthorizationView): PurchaseAuthorizationView {
  return {
    status: authorization.status,
    ...(authorization.authorityId ? { authorityId: authorization.authorityId } : {}),
    ...(authorization.evidenceDigest ? { evidenceDigest: authorization.evidenceDigest } : {}),
  };
}

function copyTreasury(treasury: TreasuryView): TreasuryView {
  return {
    status: treasury.status,
    ...(treasury.amountAtomic !== undefined ? { amountAtomic: treasury.amountAtomic } : {}),
    ...(treasury.additionalCostCeilingAtomic !== undefined ? { additionalCostCeilingAtomic: treasury.additionalCostCeilingAtomic } : {}),
    ...(treasury.reservationId ? { reservationId: treasury.reservationId } : {}),
    ...(treasury.fundingSource ? { fundingSource: treasury.fundingSource } : {}),
  };
}

function copyPaymentAttempts(attempts: readonly PaymentAttemptView[]): PaymentAttemptView[] {
  const copied = attempts.map((attempt) => ({
    attempt: attempt.attempt,
    identifier: attempt.identifier,
    status: attempt.status,
    ...(attempt.transactionId ? { transactionId: attempt.transactionId } : {}),
    ...(attempt.finality ? { finality: attempt.finality } : {}),
    evidenceDigests: sortedDigests(attempt.evidenceDigests),
  }));
  copied.sort((left, right) => left.attempt - right.attempt || compareStrings(left.identifier, right.identifier));
  for (let index = 1; index < copied.length; index++) {
    if (copied[index - 1].attempt === copied[index].attempt) {
      throw new PurchaseProjectionError("duplicate payment attempt in projection snapshot");
    }
  }
  return copied;
}

function sortedDigests(digests: readonly Sha256Digest[]): Sha256Digest[] {
  return [...digests].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function termsSubject(snapshot: PurchaseProjectionSnapshot): string {
  if (!snapshot.terms) return "";
  const merchant = boundedLabel(snapshot.terms.merchant.name || snapshot.terms.merchant.id, "merchant");
  const amount = atomicAmountDisplay(
    snapshot.terms.amountAtomic,
    snapshot.terms.asset,
    snapshot.terms.network
  );
  const additionalCostCeiling = snapshot.treasury.additionalCostCeilingAtomic === undefined
    ? ""
    : `, with additional costs capped at ${atomicAmountDisplay(
      snapshot.treasury.additionalCostCeilingAtomic,
      snapshot.terms.asset,
      snapshot.terms.network
    )}`;
  return ` for ${amount}${additionalCostCeiling}, from ${merchant}`;
}

function atomicAmountDisplay(amountAtomic: string, asset: string, network: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(amountAtomic)) {
    throw new PurchaseProjectionError("Purchase amount must be a canonical atomic-unit integer");
  }
  const safeAsset = boundedLabel(asset, "asset");
  if (asset !== "KAS") return `${amountAtomic} atomic units of ${safeAsset}`;

  if (network === "kaspa:testnet-10" || network === "kaspa:mainnet") {
    return kasAmountView(amountAtomic, network).display;
  }
  return `${amountAtomic} atomic units of ${safeAsset}`;
}

function explicitlyUtf8TextMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const segments = mediaType.split(";");
  const essence = segments.shift()?.trim().toLowerCase() ?? "";
  if (!isTextualMediaType(essence)) return false;

  const charsets: string[] = [];
  for (const segment of segments) {
    const match = /^\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]+))\s*$/i.exec(segment);
    if (match) charsets.push((match[1] ?? match[2]).toLowerCase());
  }
  return charsets.length === 1 && (charsets[0] === "utf-8" || charsets[0] === "utf8");
}

function isTextualMediaType(essence: string): boolean {
  return essence.startsWith("text/") ||
    essence === "application/json" ||
    essence.endsWith("+json") ||
    essence === "application/xml" ||
    essence.endsWith("+xml") ||
    essence === "application/javascript";
}

function strictUtf8Text(bytes: Buffer): string | undefined {
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return Buffer.from(body, "utf8").equals(bytes) ? body : undefined;
}

function boundedLabel(value: string, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length <= MAX_DISPLAY_LABEL_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_DISPLAY_LABEL_CHARACTERS - 1)}…`;
}

function boundSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) throw new PurchaseProjectionError("Purchase summary must not be empty");
  return normalized.length <= MAX_SUMMARY_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_SUMMARY_CHARACTERS - 1)}…`;
}

function requireSafeHandle(handle: string): string {
  if (
    handle.length === 0 ||
    handle.length > MAX_FULFILMENT_HANDLE_CHARACTERS ||
    !SAFE_HANDLE_PATTERN.test(handle) ||
    handle.startsWith("/") ||
    handle.split("/").includes("..")
  ) {
    throw new PurchaseProjectionError("invalid fulfilment handle");
  }
  return handle;
}

function requireByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new PurchaseProjectionError("fulfilment byte length must be a non-negative safe integer");
  }
}
