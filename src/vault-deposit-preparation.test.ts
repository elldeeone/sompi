import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  Transaction,
  addressFromScriptPublicKey,
  payToAddressScript,
  payToScriptHashScript,
} from "./kaspa-wasm.js";
import { VaultManager, VaultPreparationError, generateOwnerKey } from "./vault.js";
import { buildRedeemScript } from "./vault/template.js";
import { KaspaWallet } from "./wallet.js";

test("initial fragmented deposit and singleton top-up use prepare/submit/observe/commit edges", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-deposit-prepared-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: path.join(directory, "wallet") });
  const vault = new VaultManager(directory, "testnet-10");
  vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
  const walletScript = payToAddressScript(wallet.address);
  let exhaustedVaultScript: ReturnType<typeof payToScriptHashScript> | undefined;
  const simulator = new UtxoSimulator(wallet.networkId);
  simulator.add(wallet.address, {
    outpoint: { transactionId: "11".repeat(32), index: 0 },
    amount: 100_000_000n,
    scriptPublicKey: walletScript,
    blockDaaScore: 1n,
    isCoinbase: false,
  });
  simulator.add(wallet.address, {
    outpoint: { transactionId: "22".repeat(32), index: 0 },
    amount: 80_000_000n,
    scriptPublicKey: walletScript,
    blockDaaScore: 2n,
    isCoinbase: false,
  });
  simulator.add(wallet.address, {
    outpoint: { transactionId: "33".repeat(32), index: 0 },
    amount: 60_000_000n,
    scriptPublicKey: walletScript,
    blockDaaScore: 3n,
    isCoinbase: false,
  });
  (wallet as any).client = async () => simulator.rpc();

  try {
    const original = vault.config();
    const prepared = await vault.prepareDeposit(
      wallet,
      "max",
      80_000_000n,
      20_000_000n
    );
    assert.equal(prepared.depositKind, "initial");
    assert.equal(prepared.sourceInputs.length, 3, "maximum deposit must bind every fragmented wallet input");
    assert.equal(
      prepared.depositedSompi,
      240_000_000n - 80_000_000n - prepared.feeSompi
    );
    assert.equal(vault.config().covenantId, undefined);
    await vault.submitPreparedDeposit(wallet, prepared);
    assert.equal(vault.config().covenantId, undefined, "RPC acceptance must not advance config");
    const observed = {
      transactionId: prepared.transactionId,
      vaultOutpoint: prepared.vaultOutpoint,
      vaultAmountSompi: prepared.vaultAmountSompi,
      covenantId: prepared.covenantId,
      observedAtDaa: 9n,
      chainEvidenceDigest: `sha256:${"B".repeat(43)}`,
      chainEvidenceLevel: "accepted" as const,
    };
    assert.throws(
      () => vault.commitObservedDeposit(prepared, { ...observed, chainEvidenceLevel: "provisional" as never }),
      /observation does not match/
    );
    const funded = vault.commitObservedDeposit(prepared, observed);
    assert.equal(funded.covenantId, prepared.covenantId);
    assert.deepEqual(funded.currentOutpoint, { txid: prepared.transactionId, index: 0 });
    assert.deepEqual(
      vault.commitObservedDeposit(prepared, observed).currentOutpoint,
      funded.currentOutpoint,
      "config commit must be idempotent"
    );

    // Simulate an exhausted window which ages through a reset while topping up.
    const configPath = path.join(directory, "vault", "config.json");
    const current = vault.config();
    const exhausted = {
      ...current,
      windowStartDaa: "0",
      spentInWindowSompi: current.maxOutflowSompi,
    };
    exhausted.address = vaultAddressFor(exhausted, wallet.networkId);
    exhaustedVaultScript = payToScriptHashScript(
      buildRedeemScript(
        exhausted.agentPublic,
        exhausted.ownerPublic,
        BigInt(exhausted.maxOutflowSompi),
        BigInt(exhausted.windowSizeDaa),
        {
          windowStartDaa: BigInt(exhausted.windowStartDaa),
          spentInWindowSompi: BigInt(exhausted.spentInWindowSompi),
        }
      )
    );
    simulator.rebind(funded.address, exhausted.address, exhaustedVaultScript);
    fs.writeFileSync(
      configPath,
      JSON.stringify(exhausted, null, 2),
      { mode: 0o600 }
    );
    simulator.virtualDaaScore = 1_000n;
    const topup = await vault.prepareDeposit(wallet, 20_000_000n, 0n, 20_000_000n);
    assert.equal(topup.depositKind, "topup");
    assert.equal(topup.configUpdate.spentInWindowSompi, "0");
    assert.ok(topup.vaultAmountSompi > topup.depositedSompi);
    await vault.submitPreparedDeposit(wallet, topup);
    const topupObserved = {
      transactionId: topup.transactionId,
      vaultOutpoint: topup.vaultOutpoint,
      vaultAmountSompi: topup.vaultAmountSompi,
      covenantId: topup.covenantId,
      observedAtDaa: 1_000n,
      chainEvidenceDigest: `sha256:${"C".repeat(43)}`,
      chainEvidenceLevel: "depth-confirmed" as const,
    };
    const topped = vault.commitObservedDeposit(topup, topupObserved);
    assert.deepEqual(topped.currentOutpoint, { txid: topup.transactionId, index: 0 });
    assert.equal(topped.spentInWindowSompi, "0");
    assert.equal(topped.covenantId, funded.covenantId);

    const restarted = new VaultManager(directory, "testnet-10");
    assert.deepEqual(restarted.config().currentOutpoint, topped.currentOutpoint);

    fs.writeFileSync(configPath, JSON.stringify(original, null, 2), { mode: 0o600 });
    assert.throws(
      () => vault.commitObservedDeposit(topup, topupObserved),
      /state advanced/
    );
  } finally {
    simulator.close();
    exhaustedVaultScript?.free();
    walletScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deposit fee ceiling fails before any wallet signature", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-deposit-fee-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: path.join(directory, "wallet") });
  const vault = new VaultManager(directory, "testnet-10");
  vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
  const walletScript = payToAddressScript(wallet.address);
  const simulator = new UtxoSimulator(wallet.networkId);
  simulator.add(wallet.address, {
    outpoint: { transactionId: "44".repeat(32), index: 0 },
    amount: 300_000_000n,
    scriptPublicKey: walletScript,
    blockDaaScore: 1n,
    isCoinbase: false,
  });
  (wallet as any).client = async () => simulator.rpc();
  const originalSign = wallet.signInput.bind(wallet);
  let signatures = 0;
  (wallet as any).signInput = (...args: Parameters<KaspaWallet["signInput"]>) => {
    signatures += 1;
    return originalSign(...args);
  };
  try {
    await assert.rejects(
      vault.prepareDeposit(wallet, 100_000_000n, 0n, 1n),
      /fee exceeds the capacity reserved before signing/
    );
    assert.equal(signatures, 0);
  } finally {
    simulator.close();
    walletScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("maximum deposit that cannot preserve keep-float is a typed no-effect terminal failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-deposit-insufficient-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: path.join(directory, "wallet") });
  const vault = new VaultManager(directory, "testnet-10");
  vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
  const walletScript = payToAddressScript(wallet.address);
  const simulator = new UtxoSimulator(wallet.networkId);
  simulator.add(wallet.address, {
    outpoint: { transactionId: "55".repeat(32), index: 0 },
    amount: 100_000n,
    scriptPublicKey: walletScript,
    blockDaaScore: 1n,
    isCoinbase: false,
  });
  (wallet as any).client = async () => simulator.rpc();
  let signatures = 0;
  const originalSign = wallet.signInput.bind(wallet);
  (wallet as any).signInput = (...args: Parameters<KaspaWallet["signInput"]>) => {
    signatures += 1;
    return originalSign(...args);
  };
  try {
    await assert.rejects(
      vault.prepareDeposit(wallet, "max", 100_000n, 100_000n),
      (error: unknown) => error instanceof VaultPreparationError && error.code === "insufficient_funds",
    );
    assert.equal(signatures, 0);
  } finally {
    simulator.close();
    walletScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

interface SimulatedEntry {
  outpoint: { transactionId: string; index: number };
  amount: bigint;
  scriptPublicKey: any;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  covenantId?: string;
}

function vaultAddressFor(
  config: ReturnType<VaultManager["config"]>,
  networkId: string
): string {
  const redeem = buildRedeemScript(
    config.agentPublic,
    config.ownerPublic,
    BigInt(config.maxOutflowSompi),
    BigInt(config.windowSizeDaa),
    {
      windowStartDaa: BigInt(config.windowStartDaa),
      spentInWindowSompi: BigInt(config.spentInWindowSompi),
    }
  );
  const script = payToScriptHashScript(redeem);
  const address = addressFromScriptPublicKey(script, networkId);
  try {
    if (!address) throw new Error("test vault address cannot be derived");
    return address.toString();
  } finally {
    address?.free();
    script.free();
  }
}

class UtxoSimulator {
  virtualDaaScore = 100n;
  private readonly entries = new Map<string, SimulatedEntry[]>();
  private readonly transactions: Transaction[] = [];

  constructor(private readonly networkId: string) {}

  add(address: string, entry: SimulatedEntry): void {
    this.entries.set(address, [...(this.entries.get(address) ?? []), entry]);
  }

  rebind(from: string, to: string, scriptPublicKey: unknown): void {
    const current = this.entries.get(from) ?? [];
    if (current.length !== 1) throw new Error("test vault UTXO is unavailable for state rebinding");
    this.entries.set(from, []);
    this.entries.set(to, [{ ...current[0], scriptPublicKey }]);
  }

  rpc() {
    return {
      getUtxosByAddresses: async (addresses: string[]) => ({
        entries: addresses.flatMap((address) => this.entries.get(address) ?? []),
      }),
      getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
      getServerInfo: async () => ({ virtualDaaScore: this.virtualDaaScore.toString() }),
      getBlockDagInfo: async () => ({ sink: "aa".repeat(32) }),
      getMempoolEntry: async () => {
        throw new Error("transaction not found");
      },
      getVirtualChainFromBlock: async () => ({ acceptedTransactionIds: [] }),
      submitTransaction: async ({ transaction }: { transaction: Transaction }) => {
        const submitted = new Transaction(transaction);
        this.transactions.push(submitted);
        const transactionId = String(submitted.finalize());
        const spent = new Set(
          submitted.inputs.map((input) =>
            `${String(input.previousOutpoint.transactionId)}:${input.previousOutpoint.index}`
          )
        );
        for (const [address, current] of this.entries) {
          this.entries.set(
            address,
            current.filter((entry) => !spent.has(`${entry.outpoint.transactionId}:${entry.outpoint.index}`))
          );
        }
        for (let index = 0; index < submitted.outputs.length; index++) {
          const output = submitted.outputs[index];
          const address = addressFromScriptPublicKey(output.scriptPublicKey, this.networkId);
          try {
            const value = address?.toString();
            if (!value) throw new Error("simulated output address unavailable");
            this.add(value, {
              outpoint: { transactionId, index },
              amount: BigInt(output.value),
              scriptPublicKey: output.scriptPublicKey,
              blockDaaScore: this.virtualDaaScore,
              isCoinbase: false,
              ...(output.covenant
                ? { covenantId: String(output.covenant.covenantId) }
                : {}),
            });
          } finally {
            address?.free();
          }
        }
        return { transactionId };
      },
    };
  }

  close(): void {
    for (const transaction of this.transactions) transaction.free();
  }
}
