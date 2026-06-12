import * as fs from "node:fs";
import * as path from "node:path";
import { PolicyEngine } from "../policy";
import { KaspaWallet } from "../wallet";
import {
  PaymentRequired,
  X_PAYMENT_HEADER,
  encodePaymentHeader,
} from "./types";
import { deriveEscrowAddress, generateChannelKey, makeVoucher } from "./escrow";

interface TabState {
  tabId: string;
  payTo: string;
  network: string;
  depositedSompi: string;
}

interface EscrowState {
  clientPrivate: string;
  clientPublic: string;
  serverPublic: string;
  refundTimeout: string;
  escrowAddress: string;
  network: string;
  depositedSompi: string;
  pricePerRequestSompi: string;
  /** Cumulative amount authorized to the server so far, sompi. */
  authorizedSompi: string;
}

export interface PaidFetchResult {
  status: number;
  body: string;
  /** Set when this call made an on-chain deposit. */
  deposit?: { txid: string; amountSompi: string; payTo: string };
  tabId?: string;
  remainingSompi?: string;
  /** Set for escrow payments. */
  scheme?: "kaspa-tab" | "kaspa-escrow";
  authorizedSompi?: string;
}

/**
 * HTTP client that resolves kaspa-tab 402 responses automatically,
 * within the local spending policy.
 *
 * Tabs are persisted per origin so credit survives restarts and is reused
 * across requests — the deposit is on-chain once, then requests are free.
 */
export class X402Client {
  private readonly wallet: KaspaWallet;
  private readonly policy: PolicyEngine;
  private readonly tabsPath: string;
  private readonly escrowsPath: string;
  private tabs: Record<string, TabState>;
  private escrows: Record<string, EscrowState>;

  constructor(wallet: KaspaWallet, policy: PolicyEngine, dataDir: string) {
    this.wallet = wallet;
    this.policy = policy;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.tabsPath = path.join(dataDir, "client-tabs.json");
    this.escrowsPath = path.join(dataDir, "client-escrows.json");
    this.tabs = fs.existsSync(this.tabsPath) ? JSON.parse(fs.readFileSync(this.tabsPath, "utf8")) : {};
    this.escrows = fs.existsSync(this.escrowsPath) ? JSON.parse(fs.readFileSync(this.escrowsPath, "utf8")) : {};
  }

  async paidFetch(url: string, init?: RequestInit): Promise<PaidFetchResult> {
    const origin = new URL(url).origin;

    // If we already have an escrow channel for this origin, pay from it directly.
    if (this.escrows[origin]) {
      return this.escrowRequest(origin, url, init);
    }

    const known = this.tabs[origin];
    let response = await this.fetchWithTab(url, init, known?.tabId);
    if (response.status !== 402) {
      return await this.toResult(response, known?.tabId);
    }

    // 402: choose the scheme. Prefer escrow (trust-minimized) when offered.
    const body = (await response.json()) as PaymentRequired;
    const escrowOffer = body.accepts?.find((o: any) => o.scheme === "kaspa-escrow") as any;
    if (escrowOffer) {
      await this.openEscrow(origin, escrowOffer);
      return this.escrowRequest(origin, url, init);
    }

    const offer = body.accepts?.find((o) => o.scheme === "kaspa-tab");
    if (!offer) throw new Error("402 response carries no supported payment offer");
    if (offer.network !== this.wallet.networkId) {
      throw new Error(`server wants payment on ${offer.network} but wallet is on ${this.wallet.networkId}`);
    }

    const amount = BigInt(offer.minDepositSompi);
    this.policy.authorize(offer.payTo, amount);
    const { txid } = await this.wallet.send(offer.payTo, amount);
    this.policy.record(amount);

    this.tabs[origin] = { tabId: offer.tabId, payTo: offer.payTo, network: offer.network, depositedSompi: amount.toString() };
    this.persist();

    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1_000);
      response = await this.fetchWithTab(url, init, offer.tabId, txid);
      if (response.status !== 402) {
        const result = await this.toResult(response, offer.tabId);
        result.deposit = { txid, amountSompi: amount.toString(), payTo: offer.payTo };
        return result;
      }
    }
    throw new Error(`deposit ${txid} sent but server still returns 402 after retries; tab ${offer.tabId}, address ${offer.payTo}`);
  }

  /** Fund a new escrow channel for an origin from a kaspa-escrow offer. */
  private async openEscrow(origin: string, offer: any): Promise<void> {
    if (offer.network !== this.wallet.networkId) {
      throw new Error(`server wants payment on ${offer.network} but wallet is on ${this.wallet.networkId}`);
    }
    const client = generateChannelKey();
    const refundTimeout = BigInt(offer.refundTimeout);
    const escrowAddress = deriveEscrowAddress(
      { clientPublic: client.publicKey, serverPublic: offer.serverPublic, timeout: refundTimeout },
      this.wallet.networkId
    );
    const deposit = BigInt(offer.minDepositSompi);
    this.policy.authorize(escrowAddress, deposit);
    await this.wallet.send(escrowAddress, deposit);
    this.policy.record(deposit);

    this.escrows[origin] = {
      clientPrivate: client.privateKey,
      clientPublic: client.publicKey,
      serverPublic: offer.serverPublic,
      refundTimeout: refundTimeout.toString(),
      escrowAddress,
      network: offer.network,
      depositedSompi: deposit.toString(),
      pricePerRequestSompi: String(offer.pricePerRequestSompi),
      authorizedSompi: "0",
    };
    this.persist();
    await sleep(1_500); // let the deposit confirm before the first voucher
  }

  /** Issue a cumulative voucher and make one escrow-paid request. */
  private async escrowRequest(origin: string, url: string, init?: RequestInit): Promise<PaidFetchResult> {
    const state = this.escrows[origin];
    const price = BigInt(state.pricePerRequestSompi);
    const nextAuthorized = BigInt(state.authorizedSompi) + price;
    if (nextAuthorized > BigInt(state.depositedSompi)) {
      throw new Error(
        `escrow for ${origin} exhausted: authorized ${nextAuthorized} would exceed deposit ${state.depositedSompi}; top up needed`
      );
    }
    const voucher = makeVoucher(state.clientPrivate, nextAuthorized);
    const header = encodePaymentHeader({
      scheme: "kaspa-escrow",
      clientPublic: state.clientPublic,
      voucherAmountSompi: nextAuthorized.toString(),
      voucherHex: voucher.voucherHex,
    } as any);

    let response: Response | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const headers = new Headers(init?.headers);
      headers.set(X_PAYMENT_HEADER, header);
      response = await fetch(url, { ...init, headers });
      if (response.status !== 402) break;
      await sleep(1_000); // deposit may still be confirming
    }
    if (!response) throw new Error("no response");
    if (response.status !== 402) {
      state.authorizedSompi = nextAuthorized.toString();
      this.persist();
    }
    const result = await this.toResult(response);
    result.scheme = "kaspa-escrow";
    result.authorizedSompi = state.authorizedSompi;
    return result;
  }

  private async fetchWithTab(
    url: string,
    init: RequestInit | undefined,
    tabId?: string,
    depositTxid?: string
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (tabId) {
      headers.set(
        X_PAYMENT_HEADER,
        encodePaymentHeader({ scheme: "kaspa-tab", tabId, depositTxid })
      );
    }
    return fetch(url, { ...init, headers });
  }

  private async toResult(response: Response, tabId?: string): Promise<PaidFetchResult> {
    return {
      status: response.status,
      body: await response.text(),
      tabId,
      remainingSompi: response.headers.get("x-payment-remaining-sompi") ?? undefined,
    };
  }

  private persist(): void {
    fs.writeFileSync(this.tabsPath, JSON.stringify(this.tabs), { mode: 0o600 });
    fs.writeFileSync(this.escrowsPath, JSON.stringify(this.escrows), { mode: 0o600 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
