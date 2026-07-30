import {
  channelId,
  hexToBytes,
  sha256Hex,
  stableStringify,
  type ChannelConfig,
  type Hash32Hex,
} from "@kaspa-x402/core";
import {
  deriveEscrowAddress,
  escrowScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import type { DirectModeChannel } from "@kaspa-x402/client";

import { evidenceDigest } from "../../purchase/identity.js";
import type {
  BatchTreasuryMovementRecord,
  PurchaseJournal,
} from "../../purchase/journal.js";
import type {
  TreasuryOperationView,
} from "../../treasury/operation-journal.js";
import type { TreasuryOperationModule } from "../../treasury/operations.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import { SecureBatchChannelSigner } from "./batch-channel-signer.js";
import { JournalBatchChannelStore } from "./batch-channel-store.js";

const NETWORK = "kaspa:testnet-10" as const;
const ASSET = "KAS" as const;
const TEMPLATE = "kaspa-x402-escrow-v1" as const;
const SOURCE = "vault-treasury" as const;
const UINT64_MAX = (1n << 64n) - 1n;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,160}$/;
const HASH32 = /^[a-f0-9]{64}$/;

export interface OpenBatchChannelRequest {
  readonly operationKey: string;
  readonly origin: string;
  readonly resourceUrl?: string;
  readonly serverPublicKey: string;
  readonly payTo: string;
  readonly refundAddress: string;
  readonly refundTimeoutDaa: string;
  readonly amountAtomic: string;
}

export interface BatchChannelCapitalResult {
  readonly channelId: string;
  readonly state: "pending" | "active" | "failed_terminal";
  readonly movement: BatchTreasuryMovementRecord;
  readonly treasury: TreasuryOperationView;
  readonly channel?: DirectModeChannel;
}

/**
 * Capitalizes alpha.9 batch channels without authorizing a Purchase.
 *
 * The immutable channel identity and deposit Movement are durable before the
 * vault send can become live. Retrying the operation reconstructs the same
 * channel and the Treasury module reuses the same signed transaction.
 */
export class KaspaX402BatchCapitalModule {
  private readonly codec = new KaspaTestnet10AddressCodec();
  private readonly store: JournalBatchChannelStore;

  constructor(
    private readonly journal: PurchaseJournal,
    private readonly treasury: Pick<TreasuryOperationModule, "execute">,
    private readonly signer: SecureBatchChannelSigner,
    store?: JournalBatchChannelStore,
    private readonly now: () => number = Date.now,
  ) {
    if (!journal || !treasury || !signer) throw new Error("batch capital dependencies are incomplete");
    this.store = store ?? new JournalBatchChannelStore(journal, now);
    timestamp(now());
  }

  async openChannel(request: Readonly<OpenBatchChannelRequest>): Promise<BatchChannelCapitalResult> {
    const input = normalizeOpenRequest(request, this.codec);
    if (BigInt(input.refundTimeoutDaa) >= 500000000000n) {
      throw new Error("batch refund timeout must remain below the consensus timestamp boundary");
    }
    const operationDigest = evidenceDigest(stableStringify({
      profile: "urn:sompi:batch-channel-capital-operation:2",
      operationKey: input.operationKey,
      origin: input.origin,
      resourceUrl: input.resourceUrl ?? null,
      serverPublicKey: input.serverPublicKey,
      payTo: input.payTo,
      refundAddress: input.refundAddress,
      refundTimeoutDaa: input.refundTimeoutDaa,
      amountAtomic: input.amountAtomic,
    }));
    const key = await this.signer.ensureChannelKey(input.operationKey, operationDigest);
    const salt = sha256Hex(`sompi:batch-channel-salt:v1\0${input.operationKey}\0${key.publicKey}`) as Hash32Hex;
    const config: ChannelConfig = Object.freeze({
      network: NETWORK,
      asset: ASSET,
      templateId: TEMPLATE,
      clientPublicKey: key.publicKey,
      serverPublicKey: input.serverPublicKey as Hash32Hex,
      payTo: input.payTo,
      refundAddress: input.refundAddress,
      refundTimeoutDaa: input.refundTimeoutDaa,
      salt,
    });
    const identity = channelId(config);
    const template = escrowTemplate(config, this.codec);
    const script = escrowScriptPublicKey(template);
    const activeScriptPublicKey = serializedScriptPublicKey(script);
    const escrowAddress = deriveEscrowAddress(template, (value) => this.codec.encodeScriptAddress(value));
    const requestDigest = evidenceDigest(stableStringify({
      profile: "urn:sompi:batch-channel-capital:v1",
      operationKey: input.operationKey,
      origin: input.origin,
      resourceUrl: input.resourceUrl ?? null,
      channelConfig: config,
      escrowAddress,
      activeScriptPublicKey,
      amountAtomic: input.amountAtomic,
    }));
    const movementId = `batch-deposit:${identity}`;
    let movement = this.journal.planBatchTreasuryMovement({
      movementId,
      channelId: identity,
      kind: "deposit",
      requestDigest,
    });

    const treasury = await this.treasury.execute({
      operationKey: `batch.deposit.${identity}`,
      kind: "vault_send",
      destination: escrowAddress,
      amountAtomic: input.amountAtomic,
    });

    movement = this.advanceMovement(movement, treasury);
    if (treasury.state !== "completed") {
      return Object.freeze({
        channelId: identity,
        state: treasury.state === "failed_terminal" ? "failed_terminal" : "pending",
        movement,
        treasury,
      });
    }
    if (!treasury.transactionId || treasury.amountAtomic !== input.amountAtomic) {
      throw new Error("accepted batch deposit Treasury evidence is incomplete");
    }

    const existing = this.journal.loadBatchChannels({}).find((value) => value.channelId === identity);
    const channel: DirectModeChannel = existing
      ? (await this.store.loadChannels({})).find((value) => value.id === identity)!
      : Object.freeze({
          id: identity,
          origin: input.origin,
          ...(input.resourceUrl === undefined ? {} : { resourceUrl: input.resourceUrl }),
          config,
          clientPublicKey: key.publicKey,
          serverPublicKey: config.serverPublicKey,
          activeOutpoint: Object.freeze({ txid: treasury.transactionId, index: 0 }),
          activeScriptPublicKey,
          escrowAddress,
          fundingSource: SOURCE,
          fundingAmount: input.amountAtomic,
          chargedCumulativeAmount: "0",
          claimedCumulativeAmount: "0",
          signedCumulativeAmount: "0",
          refundTimeoutDaa: config.refundTimeoutDaa,
          templateId: TEMPLATE,
          status: "active",
        });
    this.store.activateChannelFromDeposit(channel, movementId);
    movement = this.journal.requireBatchTreasuryMovement(movementId);
    return Object.freeze({ channelId: identity, state: "active", movement, treasury, channel });
  }

  /** Alpha.8 exposes verification but no general client top-up builder. */
  topUpChannel(): never {
    throw new Error("in-place batch top-up is unavailable; rotate to a separately funded channel");
  }

  private advanceMovement(
    movement: BatchTreasuryMovementRecord,
    treasury: TreasuryOperationView,
  ): BatchTreasuryMovementRecord {
    if (movement.state === "accepted" || movement.state === "failed_terminal") return movement;
    if (treasury.state === "failed_terminal") {
      return this.journal.advanceBatchTreasuryMovement({
        movementId: movement.movementId,
        expectedState: movement.state,
        state: "failed_terminal",
      });
    }
    if ((treasury.state === "submitted" || treasury.state === "observed") && movement.state === "planned") {
      return this.journal.advanceBatchTreasuryMovement({
        movementId: movement.movementId,
        expectedState: "planned",
        state: "submitted",
        ...(treasury.transactionId === undefined ? {} : { transactionId: treasury.transactionId }),
      });
    }
    return movement;
  }
}

function escrowTemplate(config: ChannelConfig, codec: KaspaTestnet10AddressCodec) {
  return Object.freeze({
    clientPublicKey: config.clientPublicKey,
    serverPublicKey: config.serverPublicKey,
    network: config.network,
    payoutScriptPublicKeyHash: sha256Hex(hexToBytes(codec.scriptPublicKeyForAddress(config.payTo, NETWORK))),
    refundScriptPublicKeyHash: sha256Hex(hexToBytes(codec.scriptPublicKeyForAddress(config.refundAddress, NETWORK))),
    timeoutDaa: config.refundTimeoutDaa,
  });
}

function normalizeOpenRequest(
  request: Readonly<OpenBatchChannelRequest>,
  codec: KaspaTestnet10AddressCodec,
): OpenBatchChannelRequest {
  if (!request || !OPERATION_KEY.test(request.operationKey)) throw new Error("batch channel operation key is invalid");
  const origin = new URL(request.origin);
  if (origin.protocol !== "https:" || origin.origin !== request.origin) throw new Error("batch channel origin is invalid");
  if (request.resourceUrl !== undefined) {
    const resource = new URL(request.resourceUrl);
    if (resource.protocol !== "https:" || resource.origin !== origin.origin) throw new Error("batch channel resource is invalid");
  }
  if (!HASH32.test(request.serverPublicKey)) throw new Error("batch server public key is invalid");
  codec.scriptPublicKeyForAddress(request.payTo, NETWORK);
  codec.scriptPublicKeyForAddress(request.refundAddress, NETWORK);
  atomic(request.refundTimeoutDaa, "batch refund timeout", true);
  atomic(request.amountAtomic, "batch deposit amount", true);
  return Object.freeze({ ...request, origin: origin.origin });
}

function atomic(value: string, label: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) throw new Error(`${label} is outside uint64 bounds`);
  return parsed;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("batch capital clock is invalid");
  return value;
}
