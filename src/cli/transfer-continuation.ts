import { SompiApiClientError } from "../api/client.js";
import type { TransferCreateRequest } from "../api/contracts.js";
import type { TransferView } from "../transfer/types.js";

export const AGENT_TRANSFER_CONTINUATION_DEADLINE_MS = 75_000;
export const AGENT_TRANSFER_MAX_RECOVERY_CALLS = 64;
export const AGENT_TRANSFER_INITIAL_BACKOFF_MS = 250;
export const AGENT_TRANSFER_MAX_BACKOFF_MS = 1_000;

export interface TransferContinuationClient {
  transfer(input: TransferCreateRequest, signal?: AbortSignal): Promise<TransferView>;
  transferRecover(transferId: string, signal?: AbortSignal): Promise<TransferView>;
}

export interface TransferContinuationOptions {
  readonly deadlineMs?: number;
  readonly maxRecoveryCalls?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/**
 * Agent-facing convenience only. The API remains authoritative for every
 * transition. This helper observes and recovers one durable Transfer; it never
 * creates replacement authority or another blockchain transaction.
 */
export async function runTransferCommand(
  client: TransferContinuationClient,
  input: TransferCreateRequest,
  options: TransferContinuationOptions = {},
): Promise<TransferView> {
  const initial = await client.transfer(input);
  assertTransferIdentity(initial, undefined, input.requestKey);
  return continueTransfer(client, initial, initial.id, options);
}

export async function runTransferRecoveryCommand(
  client: TransferContinuationClient,
  transferId: string,
  options: TransferContinuationOptions = {},
): Promise<TransferView> {
  return continueTransfer(client, undefined, transferId, options);
}

async function continueTransfer(
  client: TransferContinuationClient,
  initial: TransferView | undefined,
  transferId: string,
  options: TransferContinuationOptions,
): Promise<TransferView> {
  const deadlineMs = boundedInteger(
    options.deadlineMs ?? AGENT_TRANSFER_CONTINUATION_DEADLINE_MS,
    "Transfer continuation deadline",
    1,
    300_000,
  );
  const maxRecoveryCalls = boundedInteger(
    options.maxRecoveryCalls ?? AGENT_TRANSFER_MAX_RECOVERY_CALLS,
    "Transfer continuation recovery limit",
    1,
    100,
  );
  const initialBackoffMs = boundedInteger(
    options.initialBackoffMs ?? AGENT_TRANSFER_INITIAL_BACKOFF_MS,
    "Transfer continuation initial backoff",
    1,
    10_000,
  );
  const maxBackoffMs = boundedInteger(
    options.maxBackoffMs ?? AGENT_TRANSFER_MAX_BACKOFF_MS,
    "Transfer continuation maximum backoff",
    initialBackoffMs,
    30_000,
  );
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const startedAt = now();
  let view = initial;
  let expectedRequestKey = initial?.requestKey;
  let backoffMs = 0;

  for (
    let recoveryCalls = 0;
    (view === undefined || needsContinuation(view)) && recoveryCalls < maxRecoveryCalls;
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
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)));
    let recovered: TransferView;
    try {
      recovered = await client.transferRecover(transferId, signal);
    } catch (cause) {
      if (signal.aborted) return viewBeforeDeadlineOrThrow(view, cause);
      throw cause;
    }
    assertTransferIdentity(recovered, transferId, expectedRequestKey);
    expectedRequestKey ??= recovered.requestKey;
    view = recovered;
    backoffMs = previousProgress !== undefined && progressFingerprint(view) === previousProgress
      ? Math.min(backoffMs === 0 ? initialBackoffMs : backoffMs * 2, maxBackoffMs)
      : 0;
  }
  return viewBeforeDeadlineOrThrow(view);
}

function needsContinuation(view: TransferView): boolean {
  return view.userAction === "wait" || view.userAction === "recover" || [
    "funds_reserved",
    "prepared",
    "submitted",
    "settled",
    "failed_recoverable",
  ].includes(view.state);
}

function viewBeforeDeadlineOrThrow(view: TransferView | undefined, cause?: unknown): TransferView {
  if (view !== undefined) return view;
  throw new SompiApiClientError(
    "DEADLINE_EXCEEDED",
    "The bounded Transfer recovery deadline elapsed before Sompi returned a durable view.",
    true,
    { cause },
  );
}

function assertTransferIdentity(
  view: TransferView,
  expectedId?: string,
  expectedRequestKey?: string,
): void {
  if (
    (expectedId !== undefined && view.id !== expectedId) ||
    (expectedRequestKey !== undefined && view.requestKey !== expectedRequestKey)
  ) {
    throw new SompiApiClientError(
      "INVALID_API_RESPONSE",
      "The local Sompi API returned an unexpected Transfer identity.",
      false,
    );
  }
}

function progressFingerprint(view: TransferView): string {
  return JSON.stringify({
    state: view.state,
    version: view.version,
    transactionId: view.transactionId,
    actualFeeAtomic: view.actualFeeAtomic,
    receipt: view.receipt,
    recoveryRequired: view.recoveryRequired,
    userAction: view.userAction,
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
