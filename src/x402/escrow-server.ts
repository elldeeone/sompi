import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KaspaWallet } from "../wallet";
import { KaspaEscrowPaymentHeader, X_PAYMENT_HEADER, decodePaymentHeader } from "./types";
import { EscrowOutpoint, EscrowParams, claimEscrow, escrowFunding, verifyVoucher } from "./escrow";

/**
 * Trust-minimized server middleware for the kaspa-escrow x402-style scheme.
 *
 * Unpaid requests get a 402 offer carrying the server's channel public key and
 * a refund timeout. The client funds an escrow address (derived from both
 * parties' keys) and presents a cumulative voucher with each request. The
 * server serves while the voucher authorizes at least the running total it is
 * owed, and can `claim` the earned funds at any time with the latest voucher.
 * Unlike the custodial tab, the client can always refund the unspent balance
 * after the timeout, so the server is never trusted with idle funds.
 */

export interface EscrowServerConfig {
  networkId: string;
  rpc: () => Promise<KaspaWallet["client"] extends () => Promise<infer R> ? R : never>;
  /** Resolve the server wallet (for claims). */
  wallet: () => KaspaWallet;
  serverPrivateHex: string;
  serverPublicHex: string;
  /** DAA score after which clients may refund. Should be comfortably ahead of now. */
  refundTimeout: bigint;
  minDepositSompi: bigint;
  pricePerRequestSompi: bigint;
  dataDir: string;
  description?: string;
}

interface ClientChannel {
  clientPublic: string;
  servedCount: number;
  /** Highest voucher amount seen (cumulative authorization), sompi. */
  authorizedSompi: string;
  /** Latest voucher signature for the authorized amount. */
  voucherHex: string;
  /** Exact escrow UTXO authorized by the latest voucher. */
  outpointTxid?: string;
  outpointIndex?: number;
}

export class EscrowTabServer {
  private readonly config: EscrowServerConfig;
  private readonly channelsPath: string;
  private channels = new Map<string, ClientChannel>();
  private fundingCache = new Map<string, [{ txid: string; index: number; amountSompi: bigint }, number]>();
  private static readonly FUNDING_CACHE_MS = 3_000;

  constructor(config: EscrowServerConfig) {
    this.config = config;
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.channelsPath = path.join(config.dataDir, "escrow-channels.json");
    if (fs.existsSync(this.channelsPath)) {
      for (const c of JSON.parse(fs.readFileSync(this.channelsPath, "utf8")) as ClientChannel[]) {
        this.channels.set(c.clientPublic, c);
      }
    }
  }

  private params(clientPublic: string): EscrowParams {
    return { clientPublic, serverPublic: this.config.serverPublicHex, timeout: this.config.refundTimeout };
  }

  private offer(): unknown {
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: "kaspa-escrow",
          network: this.config.networkId,
          serverPublic: this.config.serverPublicHex,
          refundTimeout: this.config.refundTimeout.toString(),
          minDepositSompi: this.config.minDepositSompi.toString(),
          pricePerRequestSompi: this.config.pricePerRequestSompi.toString(),
          description: this.config.description,
        },
      ],
    };
  }

  /** The escrow's exact funding UTXO, or null if it isn't funded/indexed yet. */
  private async funding(clientPublic: string, outpoint: EscrowOutpoint): Promise<{ txid: string; index: number; amountSompi: bigint } | null> {
    const cacheKey = `${clientPublic}:${outpoint.txid}:${outpoint.index}`;
    const cached = this.fundingCache.get(cacheKey);
    if (cached && Date.now() - cached[1] < EscrowTabServer.FUNDING_CACHE_MS) return cached[0];
    try {
      const f = await escrowFunding(this.config.wallet(), this.params(clientPublic), outpoint);
      const value = { txid: f.txid, index: f.index, amountSompi: f.amountSompi };
      this.fundingCache.set(cacheKey, [value, Date.now()]);
      return value;
    } catch {
      return null; // not funded / not indexed yet
    }
  }

  /** Returns true when the request was answered with a 402 (no payment / insufficient). */
  async gate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const raw = req.headers[X_PAYMENT_HEADER];
    let header: KaspaEscrowPaymentHeader | undefined;
    if (typeof raw === "string") {
      try {
        header = decodePaymentHeader(raw) as KaspaEscrowPaymentHeader;
      } catch {
        header = undefined;
      }
    }
    if (
      !header ||
      header.scheme !== "kaspa-escrow" ||
      !header.clientPublic ||
      !header.outpointTxid ||
      !Number.isInteger(header.outpointIndex)
    ) {
      return this.reply402(res);
    }

    const price = this.config.pricePerRequestSompi;
    const channel = this.channels.get(header.clientPublic) ?? {
      clientPublic: header.clientPublic,
      servedCount: 0,
      authorizedSompi: "0",
      voucherHex: "",
      outpointTxid: header.outpointTxid,
      outpointIndex: header.outpointIndex,
    };
    const required = BigInt(channel.servedCount + 1) * price;
    const voucherAmount = BigInt(header.voucherAmountSompi);

    const outpoint = { txid: header.outpointTxid, index: header.outpointIndex };
    if (
      (channel.outpointTxid && channel.outpointTxid !== outpoint.txid) ||
      (channel.outpointIndex !== undefined && channel.outpointIndex !== outpoint.index)
    ) {
      return this.reply402(res);
    }

    // The escrow must be funded at exactly the outpoint signed by the voucher.
    const funding = await this.funding(header.clientPublic, outpoint);
    if (!funding) return this.reply402(res);

    // 1. voucher must cryptographically authorize at least the running total,
    //    bound to THIS escrow UTXO (the same check consensus enforces on claim).
    if (
      voucherAmount < required ||
      !verifyVoucher(this.params(header.clientPublic), this.config.networkId, outpoint, voucherAmount, header.voucherHex)
    ) {
      return this.reply402(res);
    }
    // 2. the escrow must actually hold at least the authorized amount, so the
    //    server's claim will succeed.
    if (funding.amountSompi < voucherAmount) {
      return this.reply402(res);
    }

    channel.servedCount += 1;
    channel.authorizedSompi = voucherAmount.toString();
    channel.voucherHex = header.voucherHex;
    channel.outpointTxid = funding.txid;
    channel.outpointIndex = funding.index;
    this.channels.set(header.clientPublic, channel);
    this.persist();
    res.setHeader("x-payment-authorized-sompi", channel.authorizedSompi);
    res.setHeader("x-payment-served", String(channel.servedCount));
    return false;
  }

  private reply402(res: ServerResponse): boolean {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(this.offer()));
    return true;
  }

  /** Claim earned funds from one client's escrow using its latest voucher.
   *  Fee is estimated from the node unless overridden. */
  async claim(clientPublic: string, destination: string, feeSompi?: bigint): Promise<string> {
    const channel = this.channels.get(clientPublic);
    if (!channel || channel.authorizedSompi === "0") throw new Error(`no vouchers from client ${clientPublic}`);
    if (!channel.outpointTxid || channel.outpointIndex === undefined) {
      throw new Error(`latest voucher from client ${clientPublic} does not record an outpoint`);
    }
    const authorized = BigInt(channel.authorizedSompi);
    return claimEscrow(
      this.config.wallet(),
      this.params(clientPublic),
      this.config.serverPrivateHex,
      {
        amountSompi: authorized,
        voucherHex: channel.voucherHex,
        outpointTxid: channel.outpointTxid,
        outpointIndex: channel.outpointIndex,
      },
      authorized,
      destination,
      feeSompi
    );
  }

  /** Claim from every client with outstanding vouchers. */
  async claimAll(destination: string): Promise<{ clientPublic: string; txid: string; amountSompi: string }[]> {
    const out: { clientPublic: string; txid: string; amountSompi: string }[] = [];
    for (const channel of this.channels.values()) {
      if (channel.authorizedSompi === "0") continue;
      const txid = await this.claim(channel.clientPublic, destination);
      out.push({ clientPublic: channel.clientPublic, txid, amountSompi: channel.authorizedSompi });
    }
    return out;
  }

  private persist(): void {
    fs.writeFileSync(this.channelsPath, JSON.stringify([...this.channels.values()]), { mode: 0o600 });
  }
}
