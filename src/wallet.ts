import * as fs from "node:fs";
import * as path from "node:path";
import websocket from "websocket";

// The kaspa-wasm wRPC client requires a browser-style WebSocket global.
// Node's built-in WebSocket (21+) is untested with wRPC borsh framing,
// so we follow the official SDK examples and use the `websocket` package.
(globalThis as any).WebSocket = websocket.w3cwebsocket;

import {
  Address,
  Keypair,
  PrivateKey,
  Resolver,
  RpcClient,
  SighashType,
  Transaction,
  addressFromScriptPublicKey,
  createInputSignature,
  createTransactions,
  initConsolePanicHook,
  kaspaToSompi,
  sompiToKaspaString,
} from "./kaspa-wasm.js";

initConsolePanicHook();

export interface WalletConfig {
  networkId: string;
  dataDir: string;
  /** Optional explicit node URL; otherwise the public resolver network is used. */
  nodeUrl?: string;
}

export interface PreparedWalletSend {
  readonly transaction: string;
  readonly transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
  readonly transactionId: string;
  readonly sourceAddress: string;
  readonly destination: string;
  readonly destinationOutpoint: { readonly txid: string; readonly index: number };
  readonly amountSompi: bigint;
  readonly feeSompi: bigint;
  readonly sourceInputs: readonly {
    readonly txid: string;
    readonly index: number;
    readonly amountSompi: bigint;
  }[];
}

export type WalletSendObservation =
  | {
      readonly status: "observed";
      readonly transactionId: string;
      readonly destinationOutpoint: { readonly txid: string; readonly index: number };
      readonly amountSompi: bigint;
    }
  | { readonly status: "not_submitted" }
  | { readonly status: "pending" };

export class KaspaWallet {
  readonly networkId: string;
  readonly address: string;
  private readonly privateKey: PrivateKey;
  private readonly config: WalletConfig;
  private rpc?: RpcClient;

  constructor(config: WalletConfig) {
    assertNetworkAllowed(config.networkId);
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
    if (this.config.nodeUrl) {
      this.rpc = new RpcClient({ url: this.config.nodeUrl, networkId: this.networkId });
      await this.rpc.connect({ timeoutDuration: 15_000, retries: 2 } as any);
      // Explicitly configured node: trust it, but warn if it looks off-chain.
      const verdict = await this.chainGuardVerdict(this.rpc);
      if (verdict) console.error(`sompi warning: configured node ${this.config.nodeUrl} ${verdict}`);
      return this.rpc;
    }
    // Public resolver: nodes may be unsynced or on a stale fork (observed in
    // the wild on testnet-10). Verify against the explorer and rotate.
    let lastVerdict = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const rpc = new RpcClient({ resolver: new Resolver(), networkId: this.networkId });
      await rpc.connect({ timeoutDuration: 15_000, retries: 1 } as any);
      const verdict = await this.chainGuardVerdict(rpc);
      if (!verdict) {
        this.rpc = rpc;
        return rpc;
      }
      lastVerdict = `${rpc.url}: ${verdict}`;
      console.error(`sompi: rejecting public node (${lastVerdict}); trying another`);
      try {
        await rpc.disconnect();
      } catch {
        /* discard */
      }
    }
    throw new Error(
      `no healthy public node found for ${this.networkId} (last: ${lastVerdict}); ` +
        `set SOMPI_NODE_URL to a trusted synced node`
    );
  }

  /**
   * Returns a problem description if the node looks unsynced or off the
   * canonical chain, or null when healthy. The canonical reference is the
   * public explorer's DAA score (best-effort: network failures skip the
   * fork check rather than blocking).
   */
  private async chainGuardVerdict(rpc: RpcClient): Promise<string | null> {
    const info = await rpc.getServerInfo();
    if (!info.isSynced) return "reports unsynced";
    if (!info.hasUtxoIndex) return "runs without utxoindex";
    const reference = await this.referenceDaaScore();
    if (reference === null) return null; // explorer unreachable: skip fork check
    const nodeDaa = BigInt(info.virtualDaaScore);
    const drift = nodeDaa > reference ? nodeDaa - reference : reference - nodeDaa;
    // 10 bps => 6000 DAA per 10 minutes. Anything beyond that is a stale fork,
    // not propagation lag.
    if (drift > 6_000n) {
      return `is ${drift} DAA off the canonical chain (node ${nodeDaa}, explorer ${reference})`;
    }
    return null;
  }

  private async referenceDaaScore(): Promise<bigint | null> {
    const apis: Record<string, string> = {
      "testnet-10": "https://api-tn10.kaspa.org",
    };
    const base = apis[this.networkId];
    if (!base) return null;
    try {
      const response = await fetch(`${base}/info/blockdag`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      const body = (await response.json()) as { virtualDaaScore?: string | number };
      return body.virtualDaaScore !== undefined ? BigInt(body.virtualDaaScore) : null;
    } catch {
      return null;
    }
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

  signInput(transaction: Transaction, inputIndex: number): string {
    return createInputSignature(transaction, inputIndex, this.privateKey, SighashType.All);
  }

  /**
   * Signs one immutable wallet payment without broadcasting it. Callers must
   * durably persist the returned artifact before `submitPreparedSend`.
   *
   * Multi-transaction generators are rejected for this direct-operation seam:
   * their chained recovery contract needs a separate design and must not be
   * approximated by partially journalling a batch.
   */
  async prepareSend(
    destination: string,
    amountSompi: bigint,
    feeCeilingSompi?: bigint
  ): Promise<PreparedWalletSend> {
    if (amountSompi <= 0n) throw new Error("Prepared wallet send amount must be positive.");
    if (feeCeilingSompi !== undefined && feeCeilingSompi < 0n) {
      throw new Error("Prepared wallet send fee ceiling must be non-negative.");
    }
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

    if (transactions.length !== 1) {
      for (const pending of transactions) pending.free();
      throw new Error(
        "direct wallet operation requires exactly one prepared transaction; consolidate wallet UTXOs first"
      );
    }
    const estimatedFee = BigInt(summary.fees ?? 0);
    if (feeCeilingSompi !== undefined && estimatedFee > feeCeilingSompi) {
      for (const pending of transactions) pending.free();
      throw new Error("wallet fee estimate exceeds the capacity reserved before signing");
    }
    const pending = transactions[0];
    let transaction: Transaction | undefined;
    try {
      pending.sign([this.privateKey]);
      transaction = pending.transaction;
      const transactionId = String(transaction.finalize());
      if (!/^[a-f0-9]{64}$/.test(transactionId)) {
        throw new Error("prepared wallet transaction identity is invalid");
      }
      const outputs = transaction.outputs;
      const destinationIndexes: number[] = [];
      for (let index = 0; index < outputs.length; index++) {
        const address = addressFromScriptPublicKey(outputs[index].scriptPublicKey, this.networkId);
        try {
          if (address?.toString() === destination) destinationIndexes.push(index);
        } finally {
          address?.free();
        }
      }
      if (destinationIndexes.length !== 1) {
        throw new Error("prepared wallet transaction must contain exactly one destination output");
      }
      const destinationIndex = destinationIndexes[0];
      if (BigInt(outputs[destinationIndex].value) !== amountSompi) {
        throw new Error("prepared wallet destination output changed the requested amount");
      }
      const sourceInputs = transaction.inputs.map((input) => {
        const utxo = input.utxo;
        if (!utxo) throw new Error("prepared wallet transaction input is missing recovery UTXO data");
        return Object.freeze({
          txid: String(input.previousOutpoint.transactionId),
          index: input.previousOutpoint.index,
          amountSompi: BigInt(utxo.amount),
        });
      });
      const prepared: PreparedWalletSend = Object.freeze({
        transaction: transaction.serializeToSafeJSON(),
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
        transactionId,
        sourceAddress: this.address,
        destination,
        destinationOutpoint: Object.freeze({ txid: transactionId, index: destinationIndex }),
        amountSompi,
        feeSompi: estimatedFee,
        sourceInputs: Object.freeze(sourceInputs),
      });
      const verified = requirePreparedWalletTransaction(prepared, this.networkId);
      verified.free();
      return prepared;
    } finally {
      transaction?.free();
      pending.free();
    }
  }

  async submitPreparedSend(prepared: PreparedWalletSend): Promise<{ transactionId: string }> {
    const transaction = requirePreparedWalletTransaction(prepared, this.networkId);
    try {
      const rpc = await this.client();
      const submitted = await rpc.submitTransaction({ transaction, allowOrphan: false });
      const transactionId = String(submitted.transactionId);
      if (transactionId !== prepared.transactionId) {
        throw new Error("Kaspa node returned a different transaction identity for the prepared wallet send");
      }
      return { transactionId };
    } finally {
      transaction.free();
    }
  }

  /**
   * Reconciles a prepared send without broadcasting. `not_submitted` is
   * returned only when the transaction is absent from the pool and every
   * exact source outpoint remains unspent; only that proof permits retry.
   */
  async observePreparedSend(
    prepared: PreparedWalletSend,
    observationStartHash?: string
  ): Promise<WalletSendObservation> {
    const transaction = requirePreparedWalletTransaction(prepared, this.networkId);
    transaction.free();
    const rpc = await this.client();
    const destination = await rpc.getUtxosByAddresses([prepared.destination]);
    const destinationMatches = (destination.entries as any[]).filter((entry) => {
      const outpoint = entry?.outpoint ?? entry?.entry?.outpoint;
      return (
        String(outpoint?.transactionId ?? "") === prepared.transactionId &&
        Number(outpoint?.index) === prepared.destinationOutpoint.index &&
        BigInt(entry?.amount ?? entry?.entry?.amount ?? -1) === prepared.amountSompi
      );
    });
    if (destinationMatches.length > 1) {
      throw new Error("Kaspa UTXO index returned duplicate prepared wallet outputs");
    }
    if (destinationMatches.length === 1) {
      return Object.freeze({
        status: "observed" as const,
        transactionId: prepared.transactionId,
        destinationOutpoint: prepared.destinationOutpoint,
        amountSompi: prepared.amountSompi,
      });
    }

    try {
      const mempool = await rpc.getMempoolEntry({
        transactionId: prepared.transactionId,
        includeOrphanPool: false,
        filterTransactionPool: false,
      });
      if (mempool.mempoolEntry.isOrphan) return Object.freeze({ status: "pending" as const });
      return Object.freeze({
        status: "observed" as const,
        transactionId: prepared.transactionId,
        destinationOutpoint: prepared.destinationOutpoint,
        amountSompi: prepared.amountSompi,
      });
    } catch (error) {
      if (!isMempoolNotFound(error)) throw error;
    }

    if (observationStartHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(observationStartHash)) {
        throw new Error("wallet observation start hash is invalid");
      }
      try {
        const chain = await rpc.getVirtualChainFromBlock({
          startHash: observationStartHash,
          includeAcceptedTransactionIds: true,
        });
        if (
          chain.acceptedTransactionIds.some((accepted) =>
            accepted.acceptedTransactionIds.some((id) => String(id) === prepared.transactionId)
          )
        ) {
          return Object.freeze({
            status: "observed" as const,
            transactionId: prepared.transactionId,
            destinationOutpoint: prepared.destinationOutpoint,
            amountSompi: prepared.amountSompi,
          });
        }
      } catch {
        // A pruned/unknown start hash removes our historical proof source. We
        // may still prove non-submission from intact source outpoints below,
        // but missing inputs remain ambiguous rather than being retried.
      }
    }

    const source = await rpc.getUtxosByAddresses([prepared.sourceAddress]);
    const live = new Map(
      (source.entries as any[]).map((entry) => {
        const outpoint = entry?.outpoint ?? entry?.entry?.outpoint;
        return [
          `${String(outpoint?.transactionId ?? "")}:${Number(outpoint?.index)}`,
          BigInt(entry?.amount ?? entry?.entry?.amount ?? -1),
        ] as const;
      })
    );
    const allInputsUnspent = prepared.sourceInputs.every(
      (input) => live.get(`${input.txid}:${input.index}`) === input.amountSompi
    );
    return Object.freeze({ status: allInputsUnspent ? "not_submitted" as const : "pending" as const });
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
        () =>
          finish(
            new Error(
              `timed out after ${timeoutMs}ms; received ${formatKas(received)} KAS (${received} sompi) ` +
                `of ${formatKas(minAmountSompi)} KAS (${minAmountSompi} sompi)`
            )
          ),
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

function assertNetworkAllowed(network: string): void {
  if (network !== "testnet-10") {
    throw new Error("The initial Sompi wallet profile supports only testnet-10.");
  }
}

function requirePreparedWalletTransaction(
  prepared: PreparedWalletSend,
  networkId: string
): Transaction {
  if (
    !prepared ||
    prepared.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    typeof prepared.transaction !== "string" ||
    prepared.transaction.length === 0 ||
    prepared.transaction.length > 2_000_000 ||
    !/^[a-f0-9]{64}$/.test(prepared.transactionId) ||
    prepared.destinationOutpoint.txid !== prepared.transactionId ||
    !Number.isSafeInteger(prepared.destinationOutpoint.index) ||
    prepared.destinationOutpoint.index < 0 ||
    prepared.amountSompi <= 0n ||
    prepared.feeSompi < 0n ||
    prepared.sourceInputs.length === 0
  ) {
    throw new Error("prepared wallet send metadata is invalid");
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.deserializeFromSafeJSON(prepared.transaction);
  } catch {
    throw new Error("prepared wallet transaction artifact is not valid Kaspa safe JSON");
  }
  try {
    if (
      String(transaction.finalize()) !== prepared.transactionId ||
      transaction.serializeToSafeJSON() !== prepared.transaction
    ) {
      throw new Error("prepared wallet transaction identity or encoding changed");
    }
    const outputs = transaction.outputs;
    const output = outputs[prepared.destinationOutpoint.index];
    if (!output || BigInt(output.value) !== prepared.amountSompi) {
      throw new Error("prepared wallet destination output changed");
    }
    const address = addressFromScriptPublicKey(output.scriptPublicKey, networkId);
    try {
      if (address?.toString() !== prepared.destination) {
        throw new Error("prepared wallet destination address changed");
      }
    } finally {
      address?.free();
    }
    const inputs = transaction.inputs;
    if (inputs.length !== prepared.sourceInputs.length) {
      throw new Error("prepared wallet source inputs changed");
    }
    for (let index = 0; index < inputs.length; index++) {
      const actual = inputs[index];
      const wanted = prepared.sourceInputs[index];
      if (
        String(actual.previousOutpoint.transactionId) !== wanted.txid ||
        actual.previousOutpoint.index !== wanted.index ||
        BigInt(actual.utxo?.amount ?? -1) !== wanted.amountSompi ||
        !/^[a-f0-9]{64}$/.test(wanted.txid) ||
        !Number.isSafeInteger(wanted.index) ||
        wanted.index < 0 ||
        wanted.amountSompi <= 0n
      ) {
        throw new Error("prepared wallet source input binding changed");
      }
    }
    return transaction;
  } catch (error) {
    transaction.free();
    throw error;
  }
}

function isMempoolNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|missing|unknown transaction|mempool.*exist/i.test(message);
}

/** Generate a wallet keypair locally (operator-controlled). Returns the private
 *  key hex and the receive address for the given network. */
export function generateWalletKey(networkId: string): { privateKey: string; address: string } {
  assertNetworkAllowed(networkId);
  const keypair = Keypair.random();
  return { privateKey: keypair.privateKey, address: keypair.toAddress(networkId).toString() };
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
