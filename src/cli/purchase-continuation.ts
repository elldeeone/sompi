import { SompiApiClientError } from "../api/client.js";
import type { PurchaseCreateRequest } from "../api/contracts.js";
import type { PurchaseView } from "../purchase/types.js";
import { referencedDeadline } from "./referenced-deadline.js";

export const AGENT_PURCHASE_CONTINUATION_DEADLINE_MS = 75_000;
export const AGENT_PURCHASE_MAX_RECOVERY_CALLS = 64;
export const AGENT_PURCHASE_INITIAL_BACKOFF_MS = 250;
export const AGENT_PURCHASE_MAX_BACKOFF_MS = 1_000;

export interface PurchaseContinuationClient {
  purchase(input: PurchaseCreateRequest, signal?: AbortSignal): Promise<PurchaseView>;
  recover(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView>;
}

export interface PurchaseContinuationOptions {
  readonly deadlineMs?: number;
  readonly maxRecoveryCalls?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/**
 * Agent-facing convenience only. The API remains the authority for every
 * transition; this helper repeatedly asks it to recover the same durable
 * Purchase and never creates another request or payment attempt.
 */
export async function runPurchaseCommand(
  client: PurchaseContinuationClient,
  input: PurchaseCreateRequest,
  options: PurchaseContinuationOptions = {},
): Promise<PurchaseView> {
  const initial = await client.purchase(input);
  assertPurchaseIdentity(initial, undefined, input.requestKey);
  return continueRecoverablePurchase(client, initial, initial.id, options);
}

export async function runPurchaseRecoveryCommand(
  client: PurchaseContinuationClient,
  purchaseId: string,
  options: PurchaseContinuationOptions = {},
): Promise<PurchaseView> {
  return continueRecoverablePurchase(client, undefined, purchaseId, options);
}

async function continueRecoverablePurchase(
  client: PurchaseContinuationClient,
  initial: PurchaseView | undefined,
  purchaseId: string,
  options: PurchaseContinuationOptions,
): Promise<PurchaseView> {
  const deadlineMs = boundedInteger(
    options.deadlineMs ?? AGENT_PURCHASE_CONTINUATION_DEADLINE_MS,
    "Purchase continuation deadline",
    1,
    300_000,
  );
  const maxRecoveryCalls = boundedInteger(
    options.maxRecoveryCalls ?? AGENT_PURCHASE_MAX_RECOVERY_CALLS,
    "Purchase continuation recovery limit",
    1,
    100,
  );
  const initialBackoffMs = boundedInteger(
    options.initialBackoffMs ?? AGENT_PURCHASE_INITIAL_BACKOFF_MS,
    "Purchase continuation initial backoff",
    1,
    10_000,
  );
  const maxBackoffMs = boundedInteger(
    options.maxBackoffMs ?? AGENT_PURCHASE_MAX_BACKOFF_MS,
    "Purchase continuation maximum backoff",
    initialBackoffMs,
    30_000,
  );
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const startedAt = now();
  let view = initial;
  let expectedRequestKey = initial?.requestKey;
  let backoffMs = 0;

  for (let recoveryCalls = 0;
    (view === undefined || view.state === "failed_recoverable") && recoveryCalls < maxRecoveryCalls;
    recoveryCalls += 1
  ) {
    let remainingMs = deadlineMs - (now() - startedAt);
    if (remainingMs <= 0) return viewBeforeDeadlineOrThrow(view);
    if (backoffMs > 0) {
      await wait(Math.min(backoffMs, remainingMs));
      remainingMs = deadlineMs - (now() - startedAt);
      if (remainingMs <= 0) return viewBeforeDeadlineOrThrow(view);
    }

    const previousProgress = view === undefined ? undefined : progressFingerprint(view);
    const deadline = referencedDeadline(Math.max(1, Math.floor(remainingMs)));
    let recovered: PurchaseView;
    try {
      recovered = await client.recover(purchaseId, deadline.signal);
    } catch (cause) {
      if (deadline.signal.aborted) return viewBeforeDeadlineOrThrow(view, cause);
      throw cause;
    } finally {
      deadline.dispose();
    }
    assertPurchaseIdentity(recovered, purchaseId, expectedRequestKey);
    expectedRequestKey ??= recovered.requestKey;
    view = recovered;
    backoffMs = previousProgress !== undefined && progressFingerprint(view) === previousProgress
      ? Math.min(backoffMs === 0 ? initialBackoffMs : backoffMs * 2, maxBackoffMs)
      : 0;
  }
  return viewBeforeDeadlineOrThrow(view);
}

function viewBeforeDeadlineOrThrow(view: PurchaseView | undefined, cause?: unknown): PurchaseView {
  if (view !== undefined) return view;
  throw new SompiApiClientError(
    "DEADLINE_EXCEEDED",
    "The bounded Purchase recovery deadline elapsed before Sompi returned a durable view.",
    true,
    { cause },
  );
}

function assertPurchaseIdentity(
  view: PurchaseView,
  expectedId?: string,
  expectedRequestKey?: string,
): void {
  if (
    (expectedId !== undefined && view.id !== expectedId) ||
    (expectedRequestKey !== undefined && view.requestKey !== expectedRequestKey)
  ) {
    throw new SompiApiClientError(
      "INVALID_API_RESPONSE",
      "The local Sompi API returned an unexpected Purchase identity.",
      false,
    );
  }
}

function progressFingerprint(view: PurchaseView): string {
  return JSON.stringify({
    state: view.state,
    authorization: view.authorization.status,
    treasury: view.treasury.status,
    attempts: view.paymentAttempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      transactionId: attempt.transactionId,
      finality: attempt.finality,
    })),
    settlementEvidence: view.settlementEvidence,
    fulfilmentDigest: view.fulfilmentDigest,
    receipts: view.receiptEvidence.length,
  });
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
