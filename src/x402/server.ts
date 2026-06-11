import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Keypair, RpcClient } from "kaspa-wasm";
import {
  PaymentOffer,
  PaymentRequired,
  X_PAYMENT_HEADER,
  decodePaymentHeader,
} from "./types";

export interface TabServerConfig {
  networkId: string;
  /** Connected RpcClient used to verify deposits on-chain. */
  rpc: () => Promise<RpcClient>;
  /** Minimum first deposit per tab, in sompi. */
  minDepositSompi: bigint;
  /** Price per request, in sompi. */
  pricePerRequestSompi: bigint;
  /** Directory for tab persistence (deposit keys + charge ledger). */
  dataDir: string;
  description?: string;
}

interface TabRecord {
  tabId: string;
  /** Private key for the tab's deposit address — kept so funds can be swept later. */
  depositPrivateKey: string;
  depositAddress: string;
  /** Sompi charged against this tab so far. */
  chargedSompi: string;
  createdMs: number;
}

export interface ChargeResult {
  ok: boolean;
  /** Set when ok=false: the 402 body to return. */
  paymentRequired?: PaymentRequired;
  /** Remaining credit after the charge, when ok=true. */
  remainingSompi?: bigint;
  tabId?: string;
}

/**
 * Framework-agnostic payment-tab engine.
 *
 * Deposits are verified by querying the tab address's UTXOs at request time
 * (a deposit confirms in ~1 second on Kaspa, so the client's first retry
 * normally succeeds). Charges are an in-process ledger persisted to disk.
 */
export class TabServer {
  private readonly config: TabServerConfig;
  private readonly tabsPath: string;
  private tabs = new Map<string, TabRecord>();
  /** Cache of confirmed deposits to limit RPC chatter (tabId -> [sompi, fetchedMs]). */
  private depositCache = new Map<string, [bigint, number]>();
  private static readonly DEPOSIT_CACHE_MS = 2_000;

  constructor(config: TabServerConfig) {
    this.config = config;
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.tabsPath = path.join(config.dataDir, "tabs.json");
    if (fs.existsSync(this.tabsPath)) {
      for (const t of JSON.parse(fs.readFileSync(this.tabsPath, "utf8")) as TabRecord[]) {
        this.tabs.set(t.tabId, t);
      }
    }
  }

  /** Total confirmed sompi deposited to the tab's address. */
  private async depositedSompi(tab: TabRecord): Promise<bigint> {
    const cached = this.depositCache.get(tab.tabId);
    if (cached && Date.now() - cached[1] < TabServer.DEPOSIT_CACHE_MS) return cached[0];
    const rpc = await this.config.rpc();
    const { entries } = await rpc.getUtxosByAddresses([tab.depositAddress]);
    const total = (entries as any[]).reduce(
      (acc, e) => acc + BigInt(e?.amount ?? e?.entry?.amount ?? 0),
      0n
    );
    this.depositCache.set(tab.tabId, [total, Date.now()]);
    return total;
  }

  private newTab(): TabRecord {
    const keypair = Keypair.random();
    const tab: TabRecord = {
      tabId: crypto.randomUUID(),
      depositPrivateKey: keypair.privateKey,
      depositAddress: keypair.toAddress(this.config.networkId).toString(),
      chargedSompi: "0",
      createdMs: Date.now(),
    };
    this.tabs.set(tab.tabId, tab);
    this.persist();
    return tab;
  }

  private offer(tab: TabRecord): PaymentRequired {
    const offer: PaymentOffer = {
      scheme: "kaspa-tab",
      network: this.config.networkId,
      payTo: tab.depositAddress,
      minDepositSompi: this.config.minDepositSompi.toString(),
      pricePerRequestSompi: this.config.pricePerRequestSompi.toString(),
      tabId: tab.tabId,
      description: this.config.description,
    };
    return { x402Version: 1, accepts: [offer] };
  }

  /**
   * Charge one request against the tab identified by the X-Payment header.
   * Returns a 402 offer when there is no header, an unknown tab, or
   * insufficient credit.
   */
  async charge(xPaymentHeader: string | undefined): Promise<ChargeResult> {
    let tab: TabRecord | undefined;
    if (xPaymentHeader) {
      try {
        tab = this.tabs.get(decodePaymentHeader(xPaymentHeader).tabId);
      } catch {
        tab = undefined;
      }
    }
    if (!tab) {
      return { ok: false, paymentRequired: this.offer(this.newTab()) };
    }

    const deposited = await this.depositedSompi(tab);
    const charged = BigInt(tab.chargedSompi);
    const price = this.config.pricePerRequestSompi;

    if (deposited === 0n || deposited - charged < price) {
      // Tab exists but has no usable credit: re-offer the same deposit address.
      return { ok: false, paymentRequired: this.offer(tab), tabId: tab.tabId };
    }

    tab.chargedSompi = (charged + price).toString();
    this.persist();
    return { ok: true, remainingSompi: deposited - charged - price, tabId: tab.tabId };
  }

  /** Node `http` adapter: returns true when the request was already answered with a 402. */
  async gate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const header = req.headers[X_PAYMENT_HEADER];
    const result = await this.charge(typeof header === "string" ? header : undefined);
    if (result.ok) {
      res.setHeader("x-payment-remaining-sompi", result.remainingSompi!.toString());
      return false;
    }
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.paymentRequired));
    return true;
  }

  private persist(): void {
    fs.writeFileSync(this.tabsPath, JSON.stringify([...this.tabs.values()]), { mode: 0o600 });
  }
}
