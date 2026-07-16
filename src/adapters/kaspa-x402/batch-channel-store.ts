import type {
  ChannelLookupScope,
  ChannelStore,
  DirectModeChannel,
} from "@kaspa-x402/client";
import type { Hash32Hex, SompiString } from "@kaspa-x402/core";

import {
  PurchaseJournal,
  type BatchChannelJournalRecord,
  type BatchChannelLookup,
} from "../../purchase/journal.js";

/**
 * Alpha.8 client ChannelStore backed by the Purchase Journal's SQLite
 * transaction boundary. It never persists `clientPrivateKey`.
 */
export class JournalBatchChannelStore implements ChannelStore {
  constructor(
    private readonly journal: PurchaseJournal,
    private readonly now: () => number = Date.now
  ) {
    if (!journal) throw new Error("batch ChannelStore requires the Purchase Journal");
    readClock(this.now);
  }

  async loadChannels(scope: ChannelLookupScope): Promise<DirectModeChannel[]> {
    return this.journal.loadBatchChannels(normalizeScope(scope)).map(fromJournalRecord);
  }

  async saveChannel(channel: DirectModeChannel): Promise<void> {
    const existing = this.journal.loadBatchChannels({}).find((entry) => entry.channelId === channel.id);
    const candidate = toJournalRecord(channel, existing, readClock(this.now));
    if (existing && channelStateEquals(existing, candidate)) return;
    this.journal.saveBatchChannelWithLifecycleMovement(candidate);
  }

  activateChannelFromDeposit(
    channel: DirectModeChannel,
    movementId: string,
  ): BatchChannelJournalRecord {
    const existing = this.journal.loadBatchChannels({}).find((entry) => entry.channelId === channel.id);
    const candidate = toJournalRecord(channel, existing, readClock(this.now));
    if (existing && !channelStateEquals(existing, candidate)) {
      throw new Error("accepted batch deposit conflicts with the active channel");
    }
    return this.journal.activateBatchChannelFromDeposit(existing ?? candidate, movementId).channel;
  }

  async retireChannel(channelId: Hash32Hex, reason?: string): Promise<void> {
    // Kaspa-x402 calls this after its current-UTXO lookup cannot find the
    // active outpoint. That lookup is only a provisional observation. It is
    // deliberately not allowed to terminalize Sompi's durable channel state.
    this.journal.requireBatchChannel(channelId);
    void reason;
    throw new Error("batch channel retirement requires corroborated Chain Evidence");
  }

  async deleteChannel(channelId: Hash32Hex): Promise<void> {
    // Clean cutover keeps immutable channel history. The protocol store seam
    // cannot delete or retire it without a Sompi-owned verified transition.
    this.journal.requireBatchChannel(channelId);
    throw new Error("batch channel deletion requires corroborated Chain Evidence");
  }

  async listRefundableChannels(nowDaa?: SompiString): Promise<DirectModeChannel[]> {
    if (nowDaa === undefined) throw new Error("durable batch refund lookup requires an explicit DAA score");
    return this.journal.listRefundableBatchChannels(nowDaa).map(fromJournalRecord);
  }
}

function normalizeScope(scope: ChannelLookupScope): BatchChannelLookup {
  if (!scope || typeof scope !== "object") throw new Error("batch channel lookup is invalid");
  if (scope.network !== undefined && scope.network !== "kaspa:testnet-10") {
    return Object.freeze({ network: "kaspa:testnet-10", status: "retired" });
  }
  return Object.freeze({
    ...(scope.origin === undefined ? {} : { origin: scope.origin }),
    ...(scope.resourceUrl === undefined ? {} : { resourceUrl: scope.resourceUrl }),
    ...(scope.network === undefined ? {} : { network: scope.network }),
    ...(scope.status === undefined ? {} : { status: scope.status }),
  });
}

function toJournalRecord(
  channel: DirectModeChannel,
  existing: BatchChannelJournalRecord | undefined,
  now: number
): BatchChannelJournalRecord {
  const activeChanged = existing !== undefined && (
    existing.activeOutpoint.txid !== channel.activeOutpoint.txid ||
    existing.activeOutpoint.index !== channel.activeOutpoint.index
  );
  return Object.freeze({
    channelId: channel.id,
    origin: channel.origin,
    ...(channel.resourceUrl === undefined ? {} : { resourceUrl: channel.resourceUrl }),
    network: channel.config.network as "kaspa:testnet-10",
    asset: channel.config.asset as "KAS",
    templateId: channel.config.templateId,
    clientPublicKey: channel.clientPublicKey,
    serverPublicKey: channel.serverPublicKey,
    payTo: channel.config.payTo,
    refundAddress: channel.config.refundAddress,
    refundTimeoutDaa: channel.refundTimeoutDaa,
    salt: channel.config.salt,
    activeOutpoint: Object.freeze({ ...channel.activeOutpoint }),
    activeScriptPublicKey: channel.activeScriptPublicKey,
    escrowAddress: channel.escrowAddress,
    fundingSource: channel.fundingSource as "vault-treasury",
    fundingAmountAtomic: channel.fundingAmount,
    chargedCumulativeAtomic: channel.chargedCumulativeAmount,
    claimedCumulativeAtomic: channel.claimedCumulativeAmount,
    signedCumulativeAtomic: channel.signedCumulativeAmount,
    ...(channel.latestVoucher === undefined ? {} : {
      latestVoucher: Object.freeze({
        amountAtomic: channel.latestVoucher.amount,
        signature: channel.latestVoucher.signature,
      }),
    }),
    status: channel.status,
    epoch: existing === undefined ? 0 : existing.epoch + (activeChanged ? 1 : 0),
    version: existing === undefined ? 1 : existing.version + 1,
    ...(existing?.retiredReason === undefined ? {} : { retiredReason: existing.retiredReason }),
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  });
}

function fromJournalRecord(record: BatchChannelJournalRecord): DirectModeChannel {
  return Object.freeze({
    id: record.channelId as Hash32Hex,
    origin: record.origin,
    ...(record.resourceUrl === undefined ? {} : { resourceUrl: record.resourceUrl }),
    config: Object.freeze({
      network: record.network,
      asset: record.asset,
      templateId: record.templateId,
      clientPublicKey: record.clientPublicKey as Hash32Hex,
      serverPublicKey: record.serverPublicKey as Hash32Hex,
      payTo: record.payTo,
      refundAddress: record.refundAddress,
      refundTimeoutDaa: record.refundTimeoutDaa,
      salt: record.salt as Hash32Hex,
    }),
    clientPublicKey: record.clientPublicKey as Hash32Hex,
    serverPublicKey: record.serverPublicKey as Hash32Hex,
    activeOutpoint: Object.freeze({ ...record.activeOutpoint }) as DirectModeChannel["activeOutpoint"],
    activeScriptPublicKey: record.activeScriptPublicKey as DirectModeChannel["activeScriptPublicKey"],
    escrowAddress: record.escrowAddress,
    fundingSource: record.fundingSource,
    fundingAmount: record.fundingAmountAtomic,
    chargedCumulativeAmount: record.chargedCumulativeAtomic,
    claimedCumulativeAmount: record.claimedCumulativeAtomic,
    signedCumulativeAmount: record.signedCumulativeAtomic,
    ...(record.latestVoucher === undefined ? {} : {
      latestVoucher: Object.freeze({
        amount: record.latestVoucher.amountAtomic,
        signature: record.latestVoucher.signature as DirectModeChannel["latestVoucher"] extends infer V
          ? V extends { signature: infer S } ? S : never
          : never,
      }),
    }),
    refundTimeoutDaa: record.refundTimeoutDaa,
    templateId: record.templateId,
    status: record.status,
  });
}

function channelStateEquals(left: BatchChannelJournalRecord, right: BatchChannelJournalRecord): boolean {
  return JSON.stringify({ ...left, version: 0, updatedAtMs: 0 }) ===
    JSON.stringify({ ...right, version: 0, updatedAtMs: 0 });
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("batch ChannelStore clock is invalid");
  return value;
}
