import * as fs from "node:fs";
import * as path from "node:path";
import {
  Keypair,
  PrivateKey,
  SighashType,
  Transaction,
  addressFromScriptPublicKey,
  createInputSignature,
  payToAddressScript,
  payToScriptHashScript,
  payToScriptHashSignatureScript,
} from "../vendor/kaspa-wasm/kaspa";
import { VAULT_TEMPLATE_VERSION, buildRedeemScript, buildSigArgs, bytesToHex, hexToBytes } from "./vault/template";
import type { KaspaWallet } from "./wallet";

/**
 * Covenant vault (testnet proof-of-concept), pure JS.
 *
 * The vault is the byte-pinned SompiVault covenant (see vault/template.ts):
 * the agent path is capped at maxOutflow sompi per transaction by Kaspa
 * consensus. No external tooling is required — the template ships with this
 * package and is verified byte-for-byte against the SilverScript compiler
 * in CI.
 *
 * The owner (recovery) key belongs to the human operator and never exists
 * on the agent's host: the operator generates it on their own machine
 * (`sompi-mcp gen-owner-key`) and supplies only the public half.
 */

interface VaultConfig {
  template: string;
  agentPublic: string;
  ownerPublic: string;
  maxOutflowSompi: string;
  address: string;
}

const DEFAULT_FEE_SOMPI = 2_000_000n;
const SUBNETWORK_NATIVE = "00".repeat(20);

export class VaultManager {
  private readonly vaultDir: string;
  private readonly networkId: string;

  constructor(dataDir: string, networkId: string) {
    this.vaultDir = path.join(dataDir, "vault");
    this.networkId = networkId;
  }

  get configured(): boolean {
    return fs.existsSync(path.join(this.vaultDir, "config.json"));
  }

  config(): VaultConfig {
    return JSON.parse(fs.readFileSync(path.join(this.vaultDir, "config.json"), "utf8"));
  }

  /** Derive the vault address from the template and persist config. One vault per data dir. */
  create(maxOutflowSompi: bigint, ownerPublicKey: string): VaultConfig {
    if (this.configured) {
      throw new Error(`vault already exists at ${this.vaultDir}; use it or move it aside first`);
    }
    const ownerPublic = ownerPublicKey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(ownerPublic)) {
      throw new Error(
        "ownerPublicKey must be a 32-byte x-only public key in hex (64 hex chars). " +
          "Ask your human operator to run `npx @elldeeone/sompi gen-owner-key` on THEIR machine and " +
          "give you the `public:` line; the private half must stay with them."
      );
    }
    const agent = Keypair.random();
    const agentPublic = String(agent.xOnlyPublicKey);
    const address = this.deriveAddress(agentPublic, ownerPublic, maxOutflowSompi);

    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.vaultDir, "agent-key"), agent.privateKey, { mode: 0o600 });

    const config: VaultConfig = {
      template: VAULT_TEMPLATE_VERSION,
      agentPublic,
      ownerPublic,
      maxOutflowSompi: maxOutflowSompi.toString(),
      address,
    };
    fs.writeFileSync(path.join(this.vaultDir, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
    return config;
  }

  private deriveAddress(agentPublic: string, ownerPublic: string, maxOutflowSompi: bigint): string {
    const redeem = buildRedeemScript(agentPublic, ownerPublic, maxOutflowSompi);
    const spk = payToScriptHashScript(redeem);
    const address = addressFromScriptPublicKey(spk, this.networkId);
    if (!address) throw new Error("could not derive vault address");
    return address.toString();
  }

  async balanceSompi(wallet: KaspaWallet): Promise<bigint> {
    return wallet.balanceSompi(this.config().address);
  }

  /** Withdraw via the consensus-capped agent path. */
  async send(wallet: KaspaWallet, destination: string, amountSompi: bigint, feeSompi = DEFAULT_FEE_SOMPI): Promise<string> {
    const config = this.config();
    const max = BigInt(config.maxOutflowSompi);
    if (amountSompi + feeSompi > max) {
      throw new Error(
        `outflow ${amountSompi + feeSompi} sompi (amount + fee) exceeds the vault's consensus cap of ${max} sompi; ` +
          `the network would reject this transaction`
      );
    }
    const agentKey = fs.readFileSync(path.join(this.vaultDir, "agent-key"), "utf8").trim();
    return spendVault({
      wallet,
      config,
      fn: "withdraw",
      privateKey: agentKey,
      destination,
      amountSompi,
      feeSompi,
    });
  }

  /** The owner key is not stored here by design; recovery runs on the operator's machine. */
  async recover(): Promise<never> {
    throw new Error(
      "the owner key is not stored on this host (by design). Recover from the operator's machine: " +
        "node scripts/vault-recover.js <ownerPrivateKey> <agentPublic> <maxOutflowSompi> <destination>"
    );
  }
}

export interface VaultSpendParams {
  wallet: KaspaWallet;
  config: { agentPublic: string; ownerPublic: string; maxOutflowSompi: string; address: string };
  fn: "withdraw" | "recover";
  privateKey: string;
  destination: string;
  /** Withdrawal amount; ignored for recover (full drain). */
  amountSompi?: bigint;
  feeSompi: bigint;
}

/** Build, sign, and broadcast a vault spend. Shared by agent send and operator recovery. */
export async function spendVault(params: VaultSpendParams): Promise<string> {
  const { wallet, config, fn, destination, feeSompi } = params;
  const max = BigInt(config.maxOutflowSompi);
  const redeem = buildRedeemScript(config.agentPublic, config.ownerPublic, max);
  const vaultSpk = payToScriptHashScript(redeem);

  const rpc = await wallet.client();
  const { entries } = await rpc.getUtxosByAddresses([config.address]);
  if (!entries.length) throw new Error(`vault ${config.address} has no UTXOs; fund it first`);

  const utxo = (entries as any[])
    .map((e) => ({
      txid: String(e?.outpoint?.transactionId ?? e?.entry?.outpoint?.transactionId),
      index: Number(e?.outpoint?.index ?? e?.entry?.outpoint?.index),
      amount: BigInt(e?.amount ?? e?.entry?.amount ?? 0),
    }))
    .sort((a, b) => (a.amount > b.amount ? -1 : 1))[0];

  const outputs =
    fn === "withdraw"
      ? [
          { value: params.amountSompi!, scriptPublicKey: payToAddressScript(destination) },
          { value: utxo.amount - params.amountSompi! - feeSompi, scriptPublicKey: vaultSpk },
        ]
      : [{ value: utxo.amount - feeSompi, scriptPublicKey: payToAddressScript(destination) }];
  if (outputs.some((o) => o.value <= 0n)) {
    throw new Error(`vault UTXO of ${utxo.amount} sompi is too small for this spend`);
  }

  const inputBase = {
    previousOutpoint: { transactionId: utxo.txid, index: utxo.index },
    sequence: 0n,
    sigOpCount: 1, // each vault path executes exactly one OpCheckSig (runtime-counted post-Toccata)
    utxo: {
      outpoint: { transactionId: utxo.txid, index: utxo.index },
      amount: utxo.amount,
      scriptPublicKey: vaultSpk,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
  const txShape = {
    version: 0,
    outputs,
    lockTime: 0n,
    subnetworkId: SUBNETWORK_NATIVE,
    gas: 0n,
    payload: "",
  };

  // Pass 1: signature over the populated transaction (sighash excludes signature scripts).
  const unsigned = new Transaction({ ...txShape, inputs: [{ ...inputBase, signatureScript: "" }] } as any);
  const pushedSig = createInputSignature(unsigned, 0, new PrivateKey(params.privateKey), SighashType.All);
  const rawSig = hexToBytes(pushedSig).slice(1); // strip the push-65 opcode prefix

  // Pass 2: assemble the signature script and broadcast.
  const signatureScript = payToScriptHashSignatureScript(redeem, buildSigArgs(rawSig, fn));
  const transaction = { ...txShape, inputs: [{ ...inputBase, signatureScript }] };
  const { transactionId } = await (rpc as any).submitTransaction({ transaction, allowOrphan: false });
  return String(transactionId);
}

export function generateOwnerKey(): { privateKey: string; publicKey: string } {
  const kp = Keypair.random();
  return { privateKey: kp.privateKey, publicKey: String(kp.xOnlyPublicKey) };
}

export { bytesToHex };
