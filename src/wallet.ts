import * as fs from "node:fs";
import * as path from "node:path";

// The kaspa-wasm wRPC client requires a browser-style WebSocket global.
// Node's built-in WebSocket (21+) is untested with wRPC borsh framing,
// so we follow the official SDK examples and use the `websocket` package.
// eslint-disable-next-line @typescript-eslint/no-var-requires
(globalThis as any).WebSocket = require("websocket").w3cwebsocket;

import {
  Address,
  Keypair,
  PrivateKey,
  Resolver,
  RpcClient,
  createTransactions,
  initConsolePanicHook,
  kaspaToSompi,
  sompiToKaspaString,
} from "../vendor/kaspa-wasm/kaspa";

initConsolePanicHook();

export interface WalletConfig {
  networkId: string;
  dataDir: string;
  /** Optional explicit node URL; otherwise the public resolver network is used. */
  nodeUrl?: string;
}

export class KaspaWallet {
  readonly networkId: string;
  readonly address: string;
  private readonly privateKey: PrivateKey;
  private readonly config: WalletConfig;
  private rpc?: RpcClient;

  constructor(config: WalletConfig) {
    this.config = config;
    this.networkId = config.networkId;
    this.privateKey = loadOrCreateKey(config.dataDir);
    this.address = this.privateKey.toAddress(this.networkId).toString();
  }

  /** Lazily connect (and reconnect if the socket dropped). */
  async client(): Promise<RpcClient> {
    if (this.rpc && this.rpc.isConnected) return this.rpc;
    if (this.rpc) {
      try {
        await this.rpc.disconnect();
      } catch {
        /* stale socket; replaced below */
      }
    }
    this.rpc = this.config.nodeUrl
      ? new RpcClient({ url: this.config.nodeUrl, networkId: this.networkId })
      : new RpcClient({ resolver: new Resolver(), networkId: this.networkId });
    await this.rpc.connect({ timeoutDuration: 15_000, retries: 2 } as any);
    return this.rpc;
  }

  async serverInfo() {
    const rpc = await this.client();
    return rpc.getServerInfo();
  }

  async balanceSompi(address?: string): Promise<bigint> {
    const rpc = await this.client();
    const target = address ?? this.address;
    const { entries } = await rpc.getBalancesByAddresses([target]);
    return entries.reduce((acc: bigint, e: any) => acc + BigInt(e.balance ?? 0), 0n);
  }

  async feeEstimate() {
    const rpc = await this.client();
    return rpc.getFeeEstimate();
  }

  /**
   * Send `amountSompi` to `destination`. Fee rate is always taken from the
   * node's estimator (post-Toccata the minimum standard feerate is enforced
   * by the mempool, so hardcoded fees would be rejected).
   */
  async send(destination: string, amountSompi: bigint): Promise<{ txid: string; feeSompi: bigint }> {
    const rpc = await this.client();
    const { entries } = await rpc.getUtxosByAddresses([this.address]);
    if (!entries.length) {
      throw new Error(`no spendable UTXOs for ${this.address}; fund the wallet first`);
    }

    const estimate = await rpc.getFeeEstimate();
    const feerate = estimate.estimate?.normalBuckets?.[0]?.feerate ?? estimate.estimate?.priorityBucket?.feerate ?? 1;

    const { transactions, summary } = await createTransactions({
      entries,
      outputs: [{ address: destination, amount: amountSompi }],
      changeAddress: this.address,
      feeRate: feerate,
      priorityFee: 0n,
      networkId: this.networkId,
    } as any);

    let lastTxid = "";
    for (const pending of transactions) {
      await pending.sign([this.privateKey]);
      lastTxid = await pending.submit(rpc);
    }
    return { txid: lastTxid, feeSompi: BigInt(summary.fees ?? 0) };
  }

  /**
   * Wait until `address` receives at least `minAmountSompi` in new UTXOs,
   * or `timeoutMs` elapses. Resolves with the matched amount.
   */
  async awaitPayment(address: string, minAmountSompi: bigint, timeoutMs: number): Promise<{ receivedSompi: bigint; txids: string[] }> {
    const rpc = await this.client();
    const target = new Address(address);

    return await new Promise(async (resolve, reject) => {
      let settled = false;
      let received = 0n;
      const txids = new Set<string>();

      const finish = async (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          await rpc.unsubscribeUtxosChanged([target]);
        } catch {
          /* subscription may already be gone */
        }
        rpc.removeEventListener("utxos-changed", listener as any);
        if (err) reject(err);
        else resolve({ receivedSompi: received, txids: [...txids] });
      };

      const timer = setTimeout(
        () => finish(new Error(`timed out after ${timeoutMs}ms; received ${received} of ${minAmountSompi} sompi`)),
        timeoutMs
      );

      const listener = (event: any) => {
        const added = event?.data?.added ?? [];
        for (const utxo of added) {
          const utxoAddr = utxo?.address?.toString?.() ?? String(utxo?.address ?? "");
          if (utxoAddr !== address) continue;
          received += BigInt(utxo?.entry?.amount ?? utxo?.amount ?? 0);
          const txid = utxo?.outpoint?.transactionId ?? utxo?.entry?.outpoint?.transactionId;
          if (txid) txids.add(String(txid));
        }
        if (received >= minAmountSompi) void finish();
      };

      rpc.addEventListener("utxos-changed", listener as any);
      try {
        await rpc.subscribeUtxosChanged([target]);
      } catch (e) {
        await finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Check whether `address` currently holds a UTXO created by `txid`
   * (i.e. the payment landed and is still unspent).
   */
  async verifyPayment(txid: string, address: string): Promise<{ found: boolean; amountSompi: bigint }> {
    const rpc = await this.client();
    const { entries } = await rpc.getUtxosByAddresses([address]);
    let amount = 0n;
    let found = false;
    for (const entry of entries as any[]) {
      const entryTxid = entry?.outpoint?.transactionId ?? entry?.entry?.outpoint?.transactionId;
      if (String(entryTxid) === txid) {
        found = true;
        amount += BigInt(entry?.amount ?? entry?.entry?.amount ?? 0);
      }
    }
    return { found, amountSompi: amount };
  }

  async disconnect(): Promise<void> {
    if (this.rpc?.isConnected) await this.rpc.disconnect();
  }
}

export function formatKas(sompi: bigint): string {
  return sompiToKaspaString(sompi);
}

export function parseKasToSompi(kas: string): bigint {
  const sompi = kaspaToSompi(kas);
  if (sompi === undefined) throw new Error(`invalid KAS amount: ${kas}`);
  return sompi;
}

function loadOrCreateKey(dataDir: string): PrivateKey {
  const envKey = process.env.SOMPI_PRIVATE_KEY;
  if (envKey) return new PrivateKey(envKey.trim());

  const keyPath = path.join(dataDir, "wallet-key");
  if (fs.existsSync(keyPath)) {
    return new PrivateKey(fs.readFileSync(keyPath, "utf8").trim());
  }
  const keypair = Keypair.random();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, keypair.privateKey, { mode: 0o600 });
  return new PrivateKey(keypair.privateKey);
}
