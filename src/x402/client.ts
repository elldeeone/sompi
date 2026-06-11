import * as fs from "node:fs";
import * as path from "node:path";
import { PolicyEngine } from "../policy";
import { KaspaWallet } from "../wallet";
import {
  PaymentRequired,
  X_PAYMENT_HEADER,
  encodePaymentHeader,
} from "./types";

interface TabState {
  tabId: string;
  payTo: string;
  network: string;
  depositedSompi: string;
}

export interface PaidFetchResult {
  status: number;
  body: string;
  /** Set when this call made an on-chain deposit. */
  deposit?: { txid: string; amountSompi: string; payTo: string };
  tabId?: string;
  remainingSompi?: string;
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
  private tabs: Record<string, TabState>;

  constructor(wallet: KaspaWallet, policy: PolicyEngine, dataDir: string) {
    this.wallet = wallet;
    this.policy = policy;
    this.tabsPath = path.join(dataDir, "client-tabs.json");
    this.tabs = fs.existsSync(this.tabsPath)
      ? JSON.parse(fs.readFileSync(this.tabsPath, "utf8"))
      : {};
  }

  async paidFetch(url: string, init?: RequestInit): Promise<PaidFetchResult> {
    const origin = new URL(url).origin;
    const known = this.tabs[origin];

    // First attempt, with the existing tab when we have one.
    let response = await this.fetchWithTab(url, init, known?.tabId);
    if (response.status !== 402) {
      return await this.toResult(response, known?.tabId);
    }

    // 402: parse the offer, pay the deposit under policy, retry.
    const offer = await this.parseOffer(response);
    if (offer.network !== this.wallet.networkId) {
      throw new Error(
        `server wants payment on ${offer.network} but wallet is on ${this.wallet.networkId}`
      );
    }

    const amount = BigInt(offer.minDepositSompi);
    this.policy.authorize(offer.payTo, amount);
    const { txid } = await this.wallet.send(offer.payTo, amount);
    this.policy.record(amount);

    this.tabs[origin] = {
      tabId: offer.tabId,
      payTo: offer.payTo,
      network: offer.network,
      depositedSompi: amount.toString(),
    };
    this.persist();

    // The deposit confirms in ~1s; retry briefly until the server sees it.
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1_000);
      response = await this.fetchWithTab(url, init, offer.tabId, txid);
      if (response.status !== 402) {
        const result = await this.toResult(response, offer.tabId);
        result.deposit = { txid, amountSompi: amount.toString(), payTo: offer.payTo };
        return result;
      }
    }
    throw new Error(
      `deposit ${txid} sent but server still returns 402 after retries; ` +
        `tab ${offer.tabId}, address ${offer.payTo}`
    );
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

  private async parseOffer(response: Response) {
    const body = (await response.json()) as PaymentRequired;
    const offer = body.accepts?.find((o) => o.scheme === "kaspa-tab");
    if (!offer) throw new Error("402 response carries no kaspa-tab offer");
    return offer;
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
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
