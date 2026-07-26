import { createHash } from "node:crypto";

import type {
  BatchChannelJournalRecord,
  PurchaseJournal,
} from "../../purchase/journal.js";
import type { Sha256Digest } from "../../purchase/types.js";
import { ChainEvidenceModule } from "../../chain-evidence/module.js";
import type { BatchActiveUtxoSource } from "./batch-payment-module.js";

const HASH32 = /^[a-f0-9]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;
const MAX_HISTORY_TRANSACTIONS = 500;
const MAX_HISTORY_ROWS_PER_PAGE = 5_000;
const MAX_HISTORY_PAGES_PER_ATTEMPT = 4;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const HISTORY_TIMEOUT_MS = 15_000;

export type BatchClaimRaceObservation =
  | Readonly<{ status: "unspent"; detailDigest: Sha256Digest }>
  | Readonly<{ status: "unknown"; detailDigest: Sha256Digest }>
  | Readonly<{
      status: "claim";
      transactionId: string;
      finality: "accepted" | "depth-confirmed";
      continuationOutpoint: Readonly<{ txid: string; index: 1 }>;
      continuationScriptPublicKey: string;
      continuationFundingAmountAtomic: string;
      detailDigest: Sha256Digest;
    }>;

export interface BatchClaimRaceSource {
  getVirtualDaaScore(signal: AbortSignal): Promise<string>;
  observeClaimWinner(input: Readonly<{
    channel: BatchChannelJournalRecord;
    refundTransactionId: string;
    signal: AbortSignal;
  }>): Promise<BatchClaimRaceObservation>;
}

export type BatchRaceRecoveryStore = Pick<
  PurchaseJournal,
  "loadBatchRaceRecovery" | "advanceBatchRaceRecovery"
>;

/**
 * Identifies an accepted merchant claim which won the claim/refund race.
 *
 * The address index is used only to discover the candidate transaction. The
 * candidate is then constrained to the alpha.9 claim shape and independently
 * corroborated through Sompi's central Chain Evidence module before it can
 * advance local channel state.
 */
export class HttpsBatchClaimRaceSource implements BatchClaimRaceSource {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    private readonly chain: BatchActiveUtxoSource,
    private readonly evidence: ChainEvidenceModule,
    private readonly journal: BatchRaceRecoveryStore,
    fetcher: typeof globalThis.fetch,
  ) {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || !journal || typeof fetcher !== "function"
    ) {
      throw new Error("batch claim-race history requires an uncredentialed HTTPS base URL");
    }
    this.baseUrl = parsed;
    this.fetcher = fetcher;
  }

  async getVirtualDaaScore(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const response = await this.fetcher(new URL("info/blockdag", this.baseUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(HISTORY_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error(`batch DAA witness returned HTTP ${response.status}`);
    }
    const value = await boundedJson(response);
    return atomic(value.virtualDaaScore, "batch witness virtual DAA").toString();
  }

  async observeClaimWinner(input: Readonly<{
    channel: BatchChannelJournalRecord;
    refundTransactionId: string;
    signal: AbortSignal;
  }>): Promise<BatchClaimRaceObservation> {
    input.signal.throwIfAborted();
    const channel = input.channel;
    hash(input.refundTransactionId, "refund transaction ID");

    const current = await this.chain.getUtxos([channel.escrowAddress]);
    input.signal.throwIfAborted();
    const active = current.filter((entry) =>
      entry.outpoint.txid === channel.activeOutpoint.txid &&
      entry.outpoint.index === channel.activeOutpoint.index
    );
    if (active.length > 1) return unknown("duplicate-active-channel-utxo");
    let activeObserved = false;
    if (active.length === 1) {
      if (
        active[0]!.amount !== channel.fundingAmountAtomic ||
        active[0]!.scriptPublicKey !== channel.activeScriptPublicKey
      ) return unknown("active-channel-utxo-mismatch");
      // Current UTXO presence is provisional. A stale or malicious index can
      // still report the already-spent source, so retained accepted history
      // must get a chance to prove a winning claim before this observation is
      // treated as unspent.
      activeObserved = true;
    }

    const recoveryKey = Object.freeze({
      channelId: channel.channelId,
      sourceOutpoint: channel.activeOutpoint,
      refundTransactionId: input.refundTransactionId,
    });
    const checkpoint = this.journal.loadBatchRaceRecovery(recoveryKey);
    if (checkpoint?.state === "accepted") return unknown("accepted-race-already-applied");

    // Exhaustion completes one bounded index scan, not chain truth. The
    // address index may lag an already accepted spender, so a later recovery
    // call starts a fresh cycle at the newest page. Accepted lineage is the
    // only terminal discovery state.
    let before = checkpoint?.state === "active"
      ? checkpoint.nextBeforeCursor
      : undefined;
    let pagesScanned = checkpoint?.pagesScanned ?? 0;
    const deadline = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    ]);
    for (let page = 0; page < MAX_HISTORY_PAGES_PER_ATTEMPT; page += 1) {
      const url = new URL(
        `addresses/${encodeURIComponent(channel.escrowAddress)}/full-transactions-page`,
        this.baseUrl,
      );
      url.searchParams.set("limit", String(MAX_HISTORY_TRANSACTIONS));
      url.searchParams.set("resolve_previous_outpoints", "light");
      url.searchParams.set("acceptance", "accepted");
      if (before !== undefined) url.searchParams.set("before", before);
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: deadline,
      });
      if (!response.ok) {
        void response.body?.cancel();
        return unknown(`history-http-${response.status}`);
      }
      const history = await boundedJsonArray(response);
      const spenders = history.filter((transaction) =>
        transaction.is_accepted === true &&
        Array.isArray(transaction.inputs) &&
        transaction.inputs.some((candidate: unknown) => {
          const value = record(candidate);
          return (
            String(value?.previous_outpoint_hash ?? "").toLowerCase() === channel.activeOutpoint.txid &&
            Number(value?.previous_outpoint_index) === channel.activeOutpoint.index
          );
        })
      );
      if (spenders.length > 1) return unknown("multiple-accepted-spenders");
      if (spenders.length === 1) {
        const candidate = validateClaimCandidate(spenders[0]!, channel);
        if (!candidate || candidate.transactionId === input.refundTransactionId) {
          return unknown("accepted-spender-is-not-alpha9-claim");
        }
        return this.verifyCandidate(input, channel, candidate);
      }

      const next = historyCursor(response.headers.get("x-next-page-before"), before);
      const progress = this.journal.advanceBatchRaceRecovery({
        ...recoveryKey,
        ...(before === undefined ? {} : { expectedBeforeCursor: before }),
        expectedPagesScanned: pagesScanned,
        ...(next === undefined ? {} : { nextBeforeCursor: next }),
        rowsScanned: history.length,
      });
      if (progress.state === "exhausted") {
        return activeObserved
          ? Object.freeze({ status: "unspent", detailDigest: digest("active-channel-unspent") })
          : unknown("accepted-history-exhausted");
      }
      before = progress.nextBeforeCursor;
      pagesScanned = progress.pagesScanned;
    }
    return unknown("accepted-history-search-incomplete");
  }

  private async verifyCandidate(
    input: Readonly<{
      channel: BatchChannelJournalRecord;
      refundTransactionId: string;
      signal: AbortSignal;
    }>,
    channel: BatchChannelJournalRecord,
    candidate: Readonly<{
      transactionId: string;
      payoutAmountAtomic: string;
      payoutScriptPublicKey: string;
      continuationFundingAmountAtomic: string;
    }>,
  ): Promise<BatchClaimRaceObservation> {
    const observed = await this.evidence.observe({
      operationId: `batch-claim-race:${channel.channelId}`,
      operation: "recovery-release",
      network: "kaspa:testnet-10",
      transactionId: candidate.transactionId,
      expectedInputs: [Object.freeze({
        transactionId: channel.activeOutpoint.txid,
        index: channel.activeOutpoint.index,
      })],
      expectedOutputs: [
        Object.freeze({
          index: 0,
          amountAtomic: candidate.payoutAmountAtomic,
          scriptPublicKey: candidate.payoutScriptPublicKey,
          address: channel.payTo,
        }),
        Object.freeze({
          index: 1,
          amountAtomic: candidate.continuationFundingAmountAtomic,
          scriptPublicKey: channel.activeScriptPublicKey,
          address: channel.escrowAddress,
        }),
      ],
      watchedAddresses: [channel.escrowAddress, channel.payTo],
      mechanism: "native-covenant",
      protocolFinality: "accepted",
      signal: input.signal,
    });
    if (observed.interpretation !== "accepted") {
      return unknown("claim-chain-evidence-not-final");
    }
    const evidence = observed.evidence;
    return Object.freeze({
      status: "claim",
      transactionId: candidate.transactionId,
      finality:
        evidence.level === "accepted"
          ? "accepted" as const
          : "depth-confirmed" as const,
      continuationOutpoint: Object.freeze({ txid: candidate.transactionId, index: 1 as const }),
      continuationScriptPublicKey: channel.activeScriptPublicKey,
      continuationFundingAmountAtomic: candidate.continuationFundingAmountAtomic,
      detailDigest: evidence.detailDigest as Sha256Digest,
    });
  }
}

function validateClaimCandidate(
  transaction: Record<string, unknown>,
  channel: BatchChannelJournalRecord,
): Readonly<{
  transactionId: string;
  payoutAmountAtomic: string;
  payoutScriptPublicKey: string;
  continuationFundingAmountAtomic: string;
}> | undefined {
  try {
    const transactionId = hash(transaction.transaction_id, "claim transaction ID");
    if (
      transaction.version !== 1 ||
      transaction.subnetwork_id !== "00".repeat(20) ||
      (transaction.payload !== null && transaction.payload !== "") ||
      !Array.isArray(transaction.inputs) || transaction.inputs.length !== 1 ||
      !Array.isArray(transaction.outputs) || transaction.outputs.length !== 2
    ) return undefined;
    const source = record(transaction.inputs[0]);
    if (
      String(source?.previous_outpoint_hash ?? "").toLowerCase() !== channel.activeOutpoint.txid ||
      Number(source?.previous_outpoint_index) !== channel.activeOutpoint.index
    ) return undefined;

    const payout = output(transaction.outputs[0], transactionId, 0);
    const continuation = output(transaction.outputs[1], transactionId, 1);
    const funding = atomic(channel.fundingAmountAtomic, "channel funding", true);
    const signed = atomic(channel.signedCumulativeAtomic, "channel signed voucher ceiling");
    const claimed = atomic(channel.claimedCumulativeAtomic, "channel claimed amount");
    const charged = atomic(channel.chargedCumulativeAtomic, "channel charged amount");
    if (claimed > charged || claimed >= signed) return undefined;
    const payoutAmount = atomic(payout.amountAtomic, "claim payout", true);
    const continuationAmount = atomic(continuation.amountAtomic, "claim continuation", true);
    if (continuationAmount >= funding) return undefined;
    const claim = funding - continuationAmount;
    const fee = funding - payoutAmount - continuationAmount;
    if (
      payout.address !== channel.payTo ||
      continuation.address !== channel.escrowAddress ||
      continuation.scriptPublicKey !== channel.activeScriptPublicKey ||
      claim > signed - claimed ||
      fee <= 0n || fee >= claim || payoutAmount + fee !== claim
    ) return undefined;
    return Object.freeze({
      transactionId,
      payoutAmountAtomic: payoutAmount.toString(),
      payoutScriptPublicKey: payout.scriptPublicKey,
      continuationFundingAmountAtomic: continuationAmount.toString(),
    });
  } catch {
    return undefined;
  }
}

function output(value: unknown, transactionId: string, index: number): Readonly<{
  amountAtomic: string;
  scriptPublicKey: string;
  address: string;
}> {
  const candidate = record(value);
  if (
    String(candidate?.transaction_id ?? "").toLowerCase() !== transactionId ||
    Number(candidate?.index) !== index
  ) throw new Error("claim output identity is invalid");
  const rawScript = String(candidate?.script_public_key ?? "").toLowerCase();
  if (!/^(?:[a-f0-9]{2})+$/.test(rawScript)) throw new Error("claim output script is invalid");
  const address = String(candidate?.script_public_key_address ?? "");
  if (address.length === 0 || address.length > 256) throw new Error("claim output address is invalid");
  return Object.freeze({
    amountAtomic: atomic(candidate?.amount, "claim output amount", true).toString(),
    scriptPublicKey: `0000${rawScript}`,
    address,
  });
}

async function boundedJsonArray(response: Response): Promise<Record<string, unknown>[]> {
  const value = await boundedJson(response);
  if (!Array.isArray(value) || value.length > MAX_HISTORY_ROWS_PER_PAGE) {
    throw new Error("batch claim history count is invalid");
  }
  return value.map((entry) => {
    const candidate = record(entry);
    if (!candidate) throw new Error("batch claim history entry is invalid");
    return candidate;
  });
}

function historyCursor(value: string | null, previous: string | undefined): string | undefined {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("batch claim history cursor is invalid");
  if (previous !== undefined && BigInt(value) >= BigInt(previous)) {
    throw new Error("batch claim history cursor did not move backward");
  }
  return value;
}

async function boundedJson(response: Response): Promise<any> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RESPONSE_BYTES) {
      void response.body?.cancel();
      throw new Error("batch claim history is oversized");
    }
  }
  if (!response.body) throw new Error("batch claim history has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel("batch claim history is oversized");
        throw new Error("batch claim history is oversized");
      }
      chunks.push(Uint8Array.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return JSON.parse(text) as unknown;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function hash(value: unknown, label: string): string {
  const parsed = String(value ?? "").toLowerCase();
  if (!HASH32.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function atomic(value: unknown, label: string, positive = false): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ""))) throw new Error(`${label} is invalid`);
  const parsed = BigInt(String(value));
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) throw new Error(`${label} is invalid`);
  return parsed;
}

function digest(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}` as Sha256Digest;
}

function unknown(reason: string): Readonly<{ status: "unknown"; detailDigest: Sha256Digest }> {
  return Object.freeze({ status: "unknown", detailDigest: digest(reason) });
}
