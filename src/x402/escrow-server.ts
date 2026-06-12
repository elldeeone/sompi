import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KaspaWallet } from "../wallet";
import { X_PAYMENT_HEADER, decodePaymentHeader } from "./types";
import { EscrowParams, claimEscrow, deriveEscrowAddress, verifyVoucher } from "./escrow";

/**
 * Trust-minimized x402 server middleware (kaspa-escrow scheme).
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
}

interface EscrowPaymentHeader {
  scheme: "kaspa-escrow";
  clientPublic: string;
  voucherAmountSompi: string;
  voucherHex: string;
}

export class EscrowTabServer {
  private readonly config: EscrowServerConfig;
  private readonly channelsPath: string;
  private channels = new Map<string, ClientChannel>();
  private fundingCache = new Map<string, [bigint, number]>();
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

  private async fundedSompi(address: string): Promise<bigint> {
    const cached = this.fundingCache.get(address);
    if (cached && Date.now() - cached[1] < EscrowTabServer.FUNDING_CACHE_MS) return cached[0];
    const rpc = await this.config.rpc();
    const { entries } = await rpc.getUtxosByAddresses([address]);
    const total = (entries as any[]).reduce((acc, e) => acc + BigInt(e?.amount ?? e?.entry?.amount ?? 0), 0n);
    this.fundingCache.set(address, [total, Date.now()]);
    return total;
  }

  /** Returns true when the request was answered with a 402 (no payment / insufficient). */
  async gate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const raw = req.headers[X_PAYMENT_HEADER];
    let header: EscrowPaymentHeader | undefined;
    if (typeof raw === "string") {
      try {
        header = decodePaymentHeader(raw) as unknown as EscrowPaymentHeader;
      } catch {
        header = undefined;
      }
    }
    if (!header || header.scheme !== "kaspa-escrow" || !header.clientPublic) {
      return this.reply402(res);
    }

    const price = this.config.pricePerRequestSompi;
    const channel = this.channels.get(header.clientPublic) ?? {
      clientPublic: header.clientPublic,
      servedCount: 0,
      authorizedSompi: "0",
      voucherHex: "",
    };
    const required = BigInt(channel.servedCount + 1) * price;
    const voucherAmount = BigInt(header.voucherAmountSompi);

    // 1. voucher must cryptographically authorize at least the running total.
    if (voucherAmount < required || !verifyVoucher(header.clientPublic, voucherAmount, header.voucherHex)) {
      return this.reply402(res);
    }
    // 2. the escrow must actually hold at least the authorized amount, so the
    //    server's claim will succeed.
    const escrowAddr = deriveEscrowAddress(this.params(header.clientPublic), this.config.networkId);
    if ((await this.fundedSompi(escrowAddr)) < voucherAmount) {
      return this.reply402(res);
    }

    channel.servedCount += 1;
    channel.authorizedSompi = voucherAmount.toString();
    channel.voucherHex = header.voucherHex;
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

  /** Claim earned funds from one client's escrow using its latest voucher. */
  async claim(clientPublic: string, destination: string, feeSompi = 2_000_000n): Promise<string> {
    const channel = this.channels.get(clientPublic);
    if (!channel || channel.authorizedSompi === "0") throw new Error(`no vouchers from client ${clientPublic}`);
    const authorized = BigInt(channel.authorizedSompi);
    return claimEscrow(
      this.config.wallet(),
      this.params(clientPublic),
      this.config.serverPrivateHex,
      { amountSompi: authorized, voucherHex: channel.voucherHex },
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
