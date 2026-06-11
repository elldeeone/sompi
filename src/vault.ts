import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { KaspaWallet } from "./wallet";

/**
 * Covenant vault integration (testnet proof-of-concept).
 *
 * The vault is a SilverScript covenant (SompiVault) whose agent path is
 * capped at maxOutflow sompi per transaction by consensus. Compilation and
 * transaction signing are delegated to the `vault-driver` binary from the
 * silverscript workspace (SOMPI_VAULT_DRIVER); this module manages keys,
 * UTXO selection, and broadcast.
 */

interface VaultConfig {
  agentPublic: string;
  ownerPublic: string;
  maxOutflowSompi: string;
  address: string;
}

const DEFAULT_FEE_SOMPI = 2_000_000n;

export class VaultManager {
  private readonly vaultDir: string;
  private readonly driverPath?: string;

  constructor(dataDir: string, driverPath?: string) {
    this.vaultDir = path.join(dataDir, "vault");
    this.driverPath = driverPath;
  }

  get configured(): boolean {
    return fs.existsSync(path.join(this.vaultDir, "config.json"));
  }

  config(): VaultConfig {
    return JSON.parse(fs.readFileSync(path.join(this.vaultDir, "config.json"), "utf8"));
  }

  private driver(args: string[]): string {
    if (!this.driverPath) {
      throw new Error(
        "vault support requires the vault-driver binary; build it from the silverscript " +
          "workspace (cargo build -p vault-driver) and set SOMPI_VAULT_DRIVER to its path"
      );
    }
    return execFileSync(this.driverPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  /** Generate keys, derive the vault address, persist config. One vault per data dir. */
  create(maxOutflowSompi: bigint): VaultConfig & { ownerKeyPath: string } {
    if (this.configured) {
      throw new Error(`vault already exists at ${this.vaultDir}; use it or move it aside first`);
    }
    const agent = this.parseKeyPair(this.driver(["gen-key"]));
    const owner = this.parseKeyPair(this.driver(["gen-key"]));
    const info = this.driver(["info", agent.public, owner.public, maxOutflowSompi.toString()]);
    const address = /vault address: (\S+)/.exec(info)?.[1];
    if (!address) throw new Error(`could not parse vault address from driver output: ${info}`);

    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.vaultDir, "agent-key"), agent.private, { mode: 0o600 });
    // The owner key is the recovery/admin key. Keeping it on the same host as
    // the agent key defeats the purpose outside of testing — move it offline.
    const ownerKeyPath = path.join(this.vaultDir, "owner-key");
    fs.writeFileSync(ownerKeyPath, owner.private, { mode: 0o600 });

    const config: VaultConfig = {
      agentPublic: agent.public,
      ownerPublic: owner.public,
      maxOutflowSompi: maxOutflowSompi.toString(),
      address,
    };
    fs.writeFileSync(path.join(this.vaultDir, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
    return { ...config, ownerKeyPath };
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
    const key = fs.readFileSync(path.join(this.vaultDir, "agent-key"), "utf8").trim();
    return this.spend(wallet, "sign-withdraw", key, destination, amountSompi, feeSompi);
  }

  /** Drain the vault via the unrestricted owner path. */
  async recover(wallet: KaspaWallet, destination: string, feeSompi = DEFAULT_FEE_SOMPI): Promise<string> {
    const key = fs.readFileSync(path.join(this.vaultDir, "owner-key"), "utf8").trim();
    return this.spend(wallet, "sign-recover", key, destination, null, feeSompi);
  }

  private async spend(
    wallet: KaspaWallet,
    command: "sign-withdraw" | "sign-recover",
    privateKey: string,
    destination: string,
    amountSompi: bigint | null,
    feeSompi: bigint
  ): Promise<string> {
    const config = this.config();
    const rpc = await wallet.client();
    const { entries } = await rpc.getUtxosByAddresses([config.address]);
    if (!entries.length) throw new Error(`vault ${config.address} has no UTXOs; fund it first`);

    const needed = (amountSompi ?? 0n) + feeSompi;
    const utxo = (entries as any[])
      .map((e) => ({
        txid: String(e?.outpoint?.transactionId ?? e?.entry?.outpoint?.transactionId),
        index: Number(e?.outpoint?.index ?? e?.entry?.outpoint?.index),
        amount: BigInt(e?.amount ?? e?.entry?.amount ?? 0),
      }))
      .sort((a, b) => (a.amount > b.amount ? -1 : 1))[0];
    if (utxo.amount < needed) {
      throw new Error(`largest vault UTXO holds ${utxo.amount} sompi but ${needed} is needed`);
    }

    const args = [
      command,
      privateKey,
      config.agentPublic,
      config.ownerPublic,
      config.maxOutflowSompi,
      utxo.txid,
      utxo.index.toString(),
      utxo.amount.toString(),
      destination,
      ...(command === "sign-withdraw" ? [amountSompi!.toString(), feeSompi.toString()] : [feeSompi.toString()]),
    ];
    const raw = JSON.parse(this.driver(args));

    const transaction = {
      version: raw.version,
      inputs: raw.inputs.map((i: any) => ({
        previousOutpoint: i.previousOutpoint,
        signatureScript: i.signatureScript,
        sequence: BigInt(i.sequence),
        sigOpCount: i.sigOpCount,
      })),
      outputs: raw.outputs.map((o: any) => ({ value: BigInt(o.value), scriptPublicKey: o.scriptPublicKey })),
      lockTime: BigInt(raw.lockTime),
      subnetworkId: raw.subnetworkId,
      gas: BigInt(raw.gas),
      payload: raw.payload,
    };
    const { transactionId } = await rpc.submitTransaction({ transaction, allowOrphan: false } as any);
    return String(transactionId);
  }

  private parseKeyPair(output: string): { private: string; public: string } {
    const priv = /private: ([0-9a-f]+)/.exec(output)?.[1];
    const pub = /public: {2}([0-9a-f]+)/.exec(output)?.[1];
    if (!priv || !pub) throw new Error(`could not parse gen-key output: ${output}`);
    return { private: priv, public: pub };
  }
}
