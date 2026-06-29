import * as fs from "node:fs";
import * as path from "node:path";
import { PolicyEngine } from "../policy";
import { KaspaWallet } from "../wallet";
import {
  PaymentRequired,
  X_PAYMENT_HEADER,
  encodePaymentHeader,
} from "./types";
import { EscrowParams, EscrowUtxoNotFoundError, deriveEscrowAddress, escrowFunding, generateChannelKey, makeVoucher } from "./escrow";

interface EscrowState {
  clientPrivate: string;
  clientPublic: string;
  serverPublic: string;
  refundTimeout: string;
  escrowAddress: string;
  network: string;
  depositedSompi: string;
  pricePerRequestSompi: string;
  /** Source that funded the escrow deposit. MCP mode requires vault-funded channels. */
  fundingSource: EscrowDepositFundingSource;
  /** Funding transaction id of the escrow UTXO. */
  fundingTxid: string;
  /** Funding output index of the escrow UTXO. Full outpoint binding requires this. */
  fundingIndex?: number;
  /** Cumulative amount authorized to the server so far, sompi. */
  authorizedSompi: string;
}

export type EscrowDepositFundingSource = "wallet" | "vault";

export interface EscrowDepositFundingRequest {
  origin: string;
  escrowAddress: string;
  amountSompi: bigint;
  network: string;
  clientPublic: string;
  serverPublic: string;
  refundTimeout: bigint;
  pricePerRequestSompi: bigint;
}

export interface EscrowDepositFundingResult {
  txid: string;
  feeSompi?: bigint;
  source: EscrowDepositFundingSource;
}

export interface X402ClientOptions {
  fundEscrowDeposit?: (request: EscrowDepositFundingRequest) => Promise<EscrowDepositFundingResult>;
  requiredEscrowFundingSource?: EscrowDepositFundingSource;
}

export interface PaidFetchDeposit {
  txid: string;
  amountSompi: string;
  payTo: string;
  source: EscrowDepositFundingSource;
  feeSompi?: string;
}

export interface PaidFetchResult {
  status: number;
  body: string;
  /** Set when this call made an on-chain deposit. */
  deposit?: PaidFetchDeposit;
  /** Set for escrow payments. */
  scheme?: "kaspa-escrow";
  fundingSource?: EscrowDepositFundingSource;
  authorizedSompi?: string;
}

/**
 * HTTP client that resolves x402 HTTP 402 responses automatically,
 * within the local spending policy.
 *
 * Escrow channels are persisted per origin so credit survives restarts and
 * signed vouchers can be reused across requests. MCP mode can require
 * vault-funded channels so the hot wallet is only setup/working float.
 */
export class X402Client {
  private readonly wallet: KaspaWallet;
  private readonly policy: PolicyEngine;
  private readonly options: X402ClientOptions;
  private readonly escrowsPath: string;
  private escrows: Record<string, EscrowState>;
  /** Exhausted escrows kept for later refund of their unspent balance. */
  private retired: EscrowState[];

  constructor(wallet: KaspaWallet, policy: PolicyEngine, dataDir: string, options: X402ClientOptions = {}) {
    this.wallet = wallet;
    this.policy = policy;
    this.options = options;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.escrowsPath = path.join(dataDir, "client-escrows.json");
    const escrowData = fs.existsSync(this.escrowsPath) ? JSON.parse(fs.readFileSync(this.escrowsPath, "utf8")) : undefined;
    const escrowStore = requireEscrowFundingSource(normalizeEscrowStore(escrowData), options.requiredEscrowFundingSource);
    this.escrows = escrowStore.active;
    this.retired = escrowStore.retired;
    if (escrowStore.changed) this.persistEscrows();
  }

  /** Active and retired escrow channels, for refund tooling. */
  escrowChannels(): { active: EscrowState[]; retired: EscrowState[] } {
    return { active: Object.values(this.escrows), retired: [...this.retired] };
  }

  async paidFetch(url: string, init?: RequestInit): Promise<PaidFetchResult> {
    const origin = new URL(url).origin;

    // If we already have an escrow channel for this origin, pay from it directly.
    if (this.escrows[origin]) {
      return this.escrowRequest(origin, url, init);
    }

    let response = await fetch(url, init);
    if (response.status !== 402) {
      return await this.toResult(response);
    }

    // 402: require the trust-minimized kaspa-escrow scheme.
    const body = (await response.json()) as PaymentRequired;
    const escrowOffer = body.accepts?.find((o: any) => o.scheme === "kaspa-escrow") as any;
    if (escrowOffer) {
      const deposit = await this.openEscrow(origin, escrowOffer);
      const result = await this.escrowRequest(origin, url, init);
      result.deposit = deposit;
      return result;
    }
    throw new Error("402 response carries no kaspa-escrow payment offer");
  }

  /** Fund a new escrow channel for an origin from a kaspa-escrow offer. */
  private async openEscrow(origin: string, offer: any): Promise<PaidFetchDeposit> {
    if (offer.network !== this.wallet.networkId) {
      throw new Error(`server wants payment on ${offer.network} but wallet is on ${this.wallet.networkId}`);
    }
    const client = generateChannelKey();
    const refundTimeout = BigInt(offer.refundTimeout);
    const params = { clientPublic: client.publicKey, serverPublic: offer.serverPublic, timeout: refundTimeout };
    const escrowAddress = deriveEscrowAddress(params, this.wallet.networkId);
    const deposit = BigInt(offer.minDepositSompi);
    const funding = await this.fundEscrowDeposit({
      origin,
      escrowAddress,
      amountSompi: deposit,
      network: offer.network,
      clientPublic: client.publicKey,
      serverPublic: offer.serverPublic,
      refundTimeout,
      pricePerRequestSompi: BigInt(offer.pricePerRequestSompi),
    });

    this.escrows[origin] = {
      clientPrivate: client.privateKey,
      clientPublic: client.publicKey,
      serverPublic: offer.serverPublic,
      refundTimeout: refundTimeout.toString(),
      escrowAddress,
      network: offer.network,
      depositedSompi: deposit.toString(),
      pricePerRequestSompi: String(offer.pricePerRequestSompi),
      fundingSource: funding.source,
      fundingTxid: funding.txid,
      authorizedSompi: "0",
    };
    this.persist();

    const indexed = await this.waitForEscrowFunding(params, funding.txid);
    this.escrows[origin].fundingTxid = indexed.txid;
    this.escrows[origin].fundingIndex = indexed.index;
    this.persist();
    return {
      txid: funding.txid,
      amountSompi: deposit.toString(),
      payTo: escrowAddress,
      source: funding.source,
      feeSompi: funding.feeSompi?.toString(),
    };
  }

  private async fundEscrowDeposit(request: EscrowDepositFundingRequest): Promise<EscrowDepositFundingResult> {
    this.policy.authorize(request.escrowAddress, request.amountSompi);
    const funding = this.options.fundEscrowDeposit
      ? await this.options.fundEscrowDeposit(request)
      : { ...(await this.wallet.send(request.escrowAddress, request.amountSompi)), source: "wallet" as const };
    if (this.options.requiredEscrowFundingSource && funding.source !== this.options.requiredEscrowFundingSource) {
      throw new Error(
        `escrow deposit funding source ${funding.source} does not satisfy required source ` +
          this.options.requiredEscrowFundingSource
      );
    }
    this.policy.record(request.amountSompi);
    return funding;
  }

  private async waitForEscrowFunding(
    params: EscrowParams,
    expectedTxid: string
  ): Promise<{ txid: string; index: number; amountSompi: bigint }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const funding = await escrowFunding(this.wallet, params);
        if (funding.txid === expectedTxid) return funding;
        lastError = new Error(`saw escrow UTXO ${funding.txid}:${funding.index}, waiting for ${expectedTxid}`);
      } catch (e) {
        lastError = e;
      }
      await sleep(1_000);
    }
    throw new Error(`escrow funding ${expectedTxid} was not indexed: ${String((lastError as any)?.message ?? lastError)}`);
  }

  /** Retire the exhausted escrow and open a fresh one for the same origin. */
  private async rotateEscrow(origin: string): Promise<void> {
    const old = this.escrows[origin];
    this.retired.push(old);
    delete this.escrows[origin];
    this.persist();
    await this.openEscrow(origin, {
      network: old.network,
      serverPublic: old.serverPublic,
      refundTimeout: old.refundTimeout,
      minDepositSompi: old.depositedSompi,
      pricePerRequestSompi: old.pricePerRequestSompi,
    });
  }

  private escrowParams(state: EscrowState): EscrowParams {
    return {
      clientPublic: state.clientPublic,
      serverPublic: state.serverPublic,
      timeout: BigInt(state.refundTimeout),
    };
  }

  private async resolveFundingIndex(state: EscrowState, params: EscrowParams): Promise<void> {
    if (state.fundingIndex !== undefined) return;
    const funding = await escrowFunding(this.wallet, params, { txid: state.fundingTxid, index: 0 }).catch(() =>
      escrowFunding(this.wallet, params)
    );
    state.fundingTxid = funding.txid;
    state.fundingIndex = funding.index;
    this.persist();
  }

  private async voucherOutpointExists(state: EscrowState, params: EscrowParams): Promise<boolean> {
    if (state.fundingIndex === undefined) return true;
    try {
      await escrowFunding(this.wallet, params, { txid: state.fundingTxid, index: state.fundingIndex });
      return true;
    } catch (e) {
      if (e instanceof EscrowUtxoNotFoundError) return false;
      throw e;
    }
  }

  /** Issue a cumulative voucher and make one escrow-paid request. */
  private async escrowRequest(origin: string, url: string, init?: RequestInit, allowRotate = true): Promise<PaidFetchResult> {
    let state = this.escrows[origin];
    const price = BigInt(state.pricePerRequestSompi);
    // Rotate before the escrow is fully consumed: the claim contract always
    // returns change to escrow, so authorized must stay strictly below the
    // deposit (>= leaves one price-unit of claimable headroom).
    if (BigInt(state.authorizedSompi) + price >= BigInt(state.depositedSompi)) {
      // Escrow exhausted: rotate to a fresh escrow for this origin. The old one
      // is retired (its remaining balance stays refundable after the timeout)
      // and a new deposit opens a clean channel — the agent sees no
      // interruption. A fresh channel avoids multi-UTXO claim ambiguity.
      await this.rotateEscrow(origin);
      await sleep(1_500); // let the new deposit confirm before the first voucher
      state = this.escrows[origin];
    }
    const nextAuthorized = BigInt(state.authorizedSompi) + price;
    const params = this.escrowParams(state);
    await this.resolveFundingIndex(state, params);
    const fundingIndex = state.fundingIndex;
    if (fundingIndex === undefined) throw new Error(`escrow funding ${state.fundingTxid} is not indexed yet`);
    const voucher = makeVoucher(
      state.clientPrivate,
      params,
      state.network,
      { txid: state.fundingTxid, index: fundingIndex },
      nextAuthorized
    );
    const header = encodePaymentHeader({
      scheme: "kaspa-escrow",
      clientPublic: state.clientPublic,
      voucherAmountSompi: nextAuthorized.toString(),
      voucherHex: voucher.voucherHex,
      outpointTxid: voucher.outpointTxid,
      outpointIndex: voucher.outpointIndex,
    });

    let response: Response | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const headers = new Headers(init?.headers);
      headers.set(X_PAYMENT_HEADER, header);
      response = await fetch(url, { ...init, headers });
      if (response.status !== 402) break;
      await sleep(1_000); // deposit may still be confirming
    }
    if (!response) throw new Error("no response");
    if (response.status === 402 && allowRotate && !(await this.voucherOutpointExists(state, params))) {
      await this.rotateEscrow(origin);
      await sleep(1_500);
      return this.escrowRequest(origin, url, init, false);
    }
    if (response.status !== 402) {
      state.authorizedSompi = nextAuthorized.toString();
      this.persist();
    }
    const result = await this.toResult(response);
    result.scheme = "kaspa-escrow";
    result.fundingSource = state.fundingSource;
    result.authorizedSompi = state.authorizedSompi;
    return result;
  }

  private async toResult(response: Response): Promise<PaidFetchResult> {
    return {
      status: response.status,
      body: await response.text(),
    };
  }

  private persist(): void {
    this.persistEscrows();
  }

  private persistEscrows(): void {
    fs.writeFileSync(this.escrowsPath, JSON.stringify({ active: this.escrows, retired: this.retired }), { mode: 0o600 });
  }
}

interface EscrowStore {
  active: Record<string, EscrowState>;
  retired: EscrowState[];
  changed: boolean;
}

function normalizeEscrowStore(raw: unknown): EscrowStore {
  if (raw === undefined) return { active: {}, retired: [], changed: false };
  if (!isRecord(raw) || !isRecord(raw.active)) return { active: {}, retired: [], changed: true };

  let changed = false;
  const active: Record<string, EscrowState> = {};
  for (const [origin, state] of Object.entries(raw.active)) {
    if (isCurrentEscrowState(state)) {
      active[origin] = state;
    } else {
      changed = true;
    }
  }

  const retired: EscrowState[] = [];
  if (Array.isArray(raw.retired)) {
    for (const state of raw.retired) {
      if (isCurrentEscrowState(state)) {
        retired.push(state);
      } else {
        changed = true;
      }
    }
  } else {
    changed = true;
  }

  return { active, retired, changed };
}

function requireEscrowFundingSource(store: EscrowStore, required?: EscrowDepositFundingSource): EscrowStore {
  if (!required) return store;
  let changed = store.changed;
  const active: Record<string, EscrowState> = {};
  const retired = [...store.retired];
  for (const [origin, state] of Object.entries(store.active)) {
    if (state.fundingSource === required) {
      active[origin] = state;
    } else {
      retired.push(state);
      changed = true;
    }
  }
  return { active, retired, changed };
}

function isCurrentEscrowState(value: unknown): value is EscrowState {
  if (!isRecord(value)) return false;
  return (
    isHexBytes(value.clientPrivate, 32) &&
    isHexBytes(value.clientPublic, 32) &&
    isHexBytes(value.serverPublic, 32) &&
    isNonEmptyString(value.escrowAddress) &&
    isNonEmptyString(value.network) &&
    isDecimalString(value.refundTimeout) &&
    isDecimalString(value.depositedSompi) &&
    isDecimalString(value.pricePerRequestSompi) &&
    isFundingSource(value.fundingSource) &&
    isDecimalString(value.authorizedSompi) &&
    isNonEmptyString(value.fundingTxid) &&
    (value.fundingIndex === undefined || isFundingIndex(value.fundingIndex))
  );
}

function isFundingSource(value: unknown): value is EscrowDepositFundingSource {
  return value === "wallet" || value === "vault";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHexBytes(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(value);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
}

function isFundingIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
