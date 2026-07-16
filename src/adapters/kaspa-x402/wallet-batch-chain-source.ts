import type { FundingProviderUtxo } from "@kaspa-x402/client";
import type { SompiString } from "@kaspa-x402/core";

import type { KaspaWallet } from "../../wallet.js";
import { KaspaTestnet10AddressCodec, serializeScriptPublicKey } from "./address-codec.js";
import type { BatchActiveUtxoSource } from "./batch-payment-module.js";

const X402_NETWORK = "kaspa:testnet-10" as const;
const SDK_NETWORK = "testnet-10" as const;
const MAX_ADDRESSES = 16;
const MAX_UTXOS = 256;
const HASH32 = /^[a-f0-9]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;

interface BatchWalletRpc {
  getBlockDagInfo(): Promise<unknown>;
  getUtxosByAddresses(addresses: readonly string[]): Promise<unknown>;
}

export interface WalletBatchChainRpcProvider {
  readonly networkId: string;
  client(): Promise<BatchWalletRpc>;
  serverInfo(): Promise<unknown>;
}

/**
 * Read-only alpha.8 batch chain source. It deliberately exposes none of the
 * wallet's signing or submission capability to the Kaspa-x402 client.
 */
export class WalletBatchChainSource implements BatchActiveUtxoSource {
  private readonly codec = new KaspaTestnet10AddressCodec();

  constructor(private readonly wallet: WalletBatchChainRpcProvider | KaspaWallet) {
    if (!wallet || wallet.networkId !== SDK_NETWORK) {
      throw new Error("batch chain source supports only Testnet-10");
    }
  }

  async getVirtualDaaScore(): Promise<SompiString> {
    const rpc = await this.wallet.client();
    const [serverValue, dagValue] = await Promise.all([
      this.wallet.serverInfo(),
      rpc.getBlockDagInfo(),
    ]);
    const server = record(serverValue, "Kaspa server info");
    const dag = record(dagValue, "Kaspa DAG info");
    if (
      server.isSynced !== true ||
      server.hasUtxoIndex !== true ||
      dag.network !== SDK_NETWORK
    ) {
      throw new Error("batch chain source requires a synced UTXO-indexed Testnet-10 node");
    }
    return atomic(server.virtualDaaScore, "virtual DAA score") as SompiString;
  }

  async getUtxos(addresses: readonly string[]): Promise<FundingProviderUtxo[]> {
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
      throw new Error("batch UTXO address count is invalid");
    }
    const unique = [...new Set(addresses)];
    if (unique.length !== addresses.length) {
      throw new Error("batch UTXO addresses must be unique");
    }
    const expected = new Map<string, string>();
    for (const address of unique) {
      const script = this.codec.scriptPublicKeyForAddress(address, X402_NETWORK);
      if (expected.has(script)) throw new Error("batch UTXO addresses resolve to duplicate scripts");
      expected.set(script, address);
    }

    const rpc = await this.wallet.client();
    const dag = record(await rpc.getBlockDagInfo(), "Kaspa DAG info");
    if (dag.network !== SDK_NETWORK) {
      throw new Error("batch UTXO source is not Testnet-10");
    }
    const response = record(
      await rpc.getUtxosByAddresses(unique),
      "Kaspa UTXO response"
    );
    if (!Array.isArray(response.entries) || response.entries.length > MAX_UTXOS) {
      throw new Error("batch UTXO response count is invalid");
    }

    const seen = new Set<string>();
    return response.entries.map((value, index) => {
      const outer = record(value, `Kaspa UTXO entry ${index}`);
      const entry = isRecord(outer.entry) ? outer.entry : outer;
      const outpoint = record(outer.outpoint ?? entry.outpoint, `Kaspa UTXO outpoint ${index}`);
      const txid = String(outpoint.transactionId ?? "").toLowerCase();
      const outputIndex = Number(outpoint.index);
      if (!HASH32.test(txid) || !Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffff_ffff) {
        throw new Error("batch UTXO outpoint is invalid");
      }
      const outpointKey = `${txid}:${outputIndex}`;
      if (seen.has(outpointKey)) throw new Error("batch UTXO response contains a duplicate outpoint");
      seen.add(outpointKey);

      const blockDaaScore = BigInt(atomic(outer.blockDaaScore ?? entry.blockDaaScore, "batch UTXO block DAA"));
      if (blockDaaScore === 0n) throw new Error("batch UTXO is not accepted in a block");
      const script = record(outer.scriptPublicKey ?? entry.scriptPublicKey, "batch UTXO script");
      const serialized = serializeScriptPublicKey(Number(script.version), String(script.script));
      const address = expected.get(serialized);
      if (!address) throw new Error("batch UTXO does not belong to a requested address");
      return Object.freeze({
        outpoint: Object.freeze({ txid, index: outputIndex }),
        amount: atomic(outer.amount ?? entry.amount, "batch UTXO amount", true) as SompiString,
        scriptPublicKey: serialized,
        address,
      });
    });
  }
}

function atomic(value: unknown, label: string, positive = false): string {
  if (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
    !/^(?:0|[1-9][0-9]*)$/.test(String(value))
  ) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new Error(`${label} is outside uint64 bounds`);
  }
  return parsed.toString();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
