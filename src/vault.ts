import * as fs from "node:fs";
import * as path from "node:path";
import {
  CovenantBinding,
  Hash,
  Keypair,
  PrivateKey,
  SighashType,
  Transaction,
  addressFromScriptPublicKey,
  calculateTransactionMass,
  createInputSignature,
  payToAddressScript,
  payToScriptHashScript,
  payToScriptHashSignatureScript,
} from "../vendor/kaspa-wasm/kaspa";
import { VAULT_TEMPLATE_VERSION, VaultState, buildRedeemScript, buildSigArgs, bytesToHex, hexToBytes } from "./vault/template";
import type { KaspaWallet } from "./wallet";

/**
 * Covenant vault, pure JS.
 *
 * The current vault is a covenant-bound singleton with rolling-window state.
 * The agent path can spend at most maxOutflowSompi per windowSizeDaa DAA
 * window. The owner path remains an unrestricted recovery path.
 */

export interface VaultConfig {
  template: string;
  agentPublic: string;
  ownerPublic: string;
  maxOutflowSompi: string;
  windowSizeDaa: string;
  windowStartDaa: string;
  spentInWindowSompi: string;
  address: string;
  covenantId?: string;
  currentOutpoint?: { txid: string; index: number };
}

type VaultSpendConfig = Pick<
  VaultConfig,
  | "agentPublic"
  | "ownerPublic"
  | "maxOutflowSompi"
  | "windowSizeDaa"
  | "windowStartDaa"
  | "spentInWindowSompi"
  | "address"
  | "covenantId"
  | "currentOutpoint"
>;

interface NormalizedUtxo {
  txid: string;
  index: number;
  amount: bigint;
  scriptPublicKey: unknown;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  covenantId?: string;
}

const SUBNETWORK_NATIVE = "00".repeat(20);
const STORAGE_MASS_PARAMETER = 10n ** 12n; // KIP-9 C
const MASS_PER_SPK_BYTE = 10n;
const GRAMS_PER_SIGOP = 1_000n;
const GRAMS_PER_COMPUTE_BUDGET_UNIT = 100n;
const DEFAULT_WINDOW_SIZE_DAA = 36_000n; // ~1 hour on testnet-10/mainnet at 10 BPS
const VAULT_INPUT_COMPUTE_BUDGET = 50;
const NON_FINAL_SEQUENCE = 0n;

/**
 * Deterministic fallback fee estimate for a 1-input vault spend.
 *
 * Compute mass: serialized size + scriptPubKey bytes x10 + one sigop;
 * storage mass (KIP-9): C*(sum 1/out - 1/in). Priced at the node's normal
 * feerate with a small margin so cap-max sends do not bounce on rounding.
 */
export function estimateVaultSpendFeeSompi(
  inputAmount: bigint,
  outputs: { value: bigint; spkScriptLen: number }[],
  redeemScriptLen: number,
  feerate: number,
  inputComputeMassGrams: bigint = GRAMS_PER_SIGOP
): bigint {
  const sigScriptLen = BigInt(pushDataLength(65) + 1 + pushDataLength(redeemScriptLen)); // sig + selector + redeem
  const inputSize = 32n + 4n + 8n + sigScriptLen + 8n;
  const outputsSize = outputs.reduce((acc, o) => acc + 8n + 2n + 8n + BigInt(o.spkScriptLen), 0n);
  const size = 2n + 8n + inputSize + 8n + outputsSize + 8n + 20n + 8n + 32n + 8n;

  const spkMass = outputs.reduce((acc, o) => acc + (2n + BigInt(o.spkScriptLen)) * MASS_PER_SPK_BYTE, 0n);
  const computeGrams = size + spkMass + inputComputeMassGrams;

  const harmonicOuts = outputs.reduce((acc, o) => acc + (o.value > 0n ? STORAGE_MASS_PARAMETER / o.value : 0n), 0n);
  const harmonicIn = STORAGE_MASS_PARAMETER / inputAmount;
  const storageGrams = harmonicOuts > harmonicIn ? harmonicOuts - harmonicIn : 0n;

  const transientGrams = size * 2n;
  const grams = (computeGrams > transientGrams ? computeGrams : transientGrams) + storageGrams;
  const rate = BigInt(Math.max(Math.ceil(feerate), 100));
  return (grams * rate * 110n) / 100n;
}

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
    const config = JSON.parse(fs.readFileSync(path.join(this.vaultDir, "config.json"), "utf8")) as VaultConfig;
    assertCurrentConfig(config);
    return config;
  }

  create(maxOutflowSompi: bigint, ownerPublicKey: string, windowSizeDaa: bigint = DEFAULT_WINDOW_SIZE_DAA): VaultConfig {
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
    if (maxOutflowSompi <= 0n) throw new Error("Vault spending cap must be positive.");
    if (windowSizeDaa <= 0n) throw new Error("windowSizeDaa must be positive");

    const agent = Keypair.random();
    const agentPublic = String(agent.xOnlyPublicKey);
    const state = { windowStartDaa: 0n, spentInWindowSompi: 0n };
    const address = this.deriveAddress(agentPublic, ownerPublic, maxOutflowSompi, windowSizeDaa, state);

    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.vaultDir, "agent-key"), agent.privateKey, { mode: 0o600 });

    const config: VaultConfig = {
      template: VAULT_TEMPLATE_VERSION,
      agentPublic,
      ownerPublic,
      maxOutflowSompi: maxOutflowSompi.toString(),
      windowSizeDaa: windowSizeDaa.toString(),
      windowStartDaa: "0",
      spentInWindowSompi: "0",
      address,
    };
    this.saveConfig(config);
    return config;
  }

  private saveConfig(config: VaultConfig): void {
    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.vaultDir, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  private deriveAddress(
    agentPublic: string,
    ownerPublic: string,
    maxOutflowSompi: bigint,
    windowSizeDaa: bigint,
    state: VaultState
  ): string {
    const redeem = buildRedeemScript(agentPublic, ownerPublic, maxOutflowSompi, windowSizeDaa, state);
    const spk = payToScriptHashScript(redeem);
    const address = addressFromScriptPublicKey(spk, this.networkId);
    if (!address) throw new Error("could not derive vault address");
    return address.toString();
  }

  async balanceSompi(wallet: KaspaWallet): Promise<bigint> {
    const { spendableSompi } = await this.balanceBreakdown(wallet);
    return spendableSompi;
  }

  async balanceBreakdown(wallet: KaspaWallet): Promise<{ spendableSompi: bigint; unboundSompi: bigint }> {
    const config = this.config();
    const rpc = await wallet.client();
    const { entries } = await rpc.getUtxosByAddresses([config.address]);
    const normalized = normalizeEntries(entries);
    const spendableSompi = config.covenantId
      ? normalized
          .filter((entry) => entry.covenantId === config.covenantId)
          .reduce((acc, entry) => acc + entry.amount, 0n)
      : 0n;
    const unboundSompi = normalized
      .filter((entry) => !config.covenantId || entry.covenantId !== config.covenantId)
      .reduce((acc, entry) => acc + entry.amount, 0n);
    return { spendableSompi, unboundSompi };
  }

  async deposit(
    wallet: KaspaWallet,
    amountSompi: bigint | "max",
    keepFloatSompi: bigint = 0n
  ): Promise<{ txid: string; depositedSompi: bigint; feeSompi: bigint; vaultAddress: string; covenantId?: string }> {
    if (amountSompi !== "max" && amountSompi <= 0n) throw new Error("Vault deposit amount must be positive.");
    if (keepFloatSompi < 0n) throw new Error("keepFloatSompi must be non-negative");
    const config = this.config();
    const agentKey = fs.readFileSync(path.join(this.vaultDir, "agent-key"), "utf8").trim();
    const result = config.covenantId
      ? await topUpVault({ wallet, config, privateKey: agentKey, amountSompi, keepFloatSompi })
      : await fundInitialVault({ wallet, config, amountSompi, keepFloatSompi });

    this.saveConfig({ ...config, ...result.configUpdate });
    return {
      txid: result.txid,
      depositedSompi: result.depositedSompi,
      feeSompi: result.feeSompi,
      vaultAddress: result.configUpdate.address ?? config.address,
      covenantId: result.configUpdate.covenantId ?? config.covenantId,
    };
  }

  async send(
    wallet: KaspaWallet,
    destination: string,
    amount: bigint | "max",
    authorize?: (amountSompi: bigint) => void
  ): Promise<{ txid: string; amountSompi: bigint; feeSompi: bigint }> {
    const config = this.config();
    const agentKey = fs.readFileSync(path.join(this.vaultDir, "agent-key"), "utf8").trim();
    const result = await spendVault({
      wallet,
      config,
      fn: "withdraw",
      privateKey: agentKey,
      destination,
      amount,
      authorize,
    });
    if (result.configUpdate) this.saveConfig({ ...config, ...result.configUpdate });
    return { txid: result.txid, amountSompi: result.amountSompi, feeSompi: result.feeSompi };
  }

  async recover(): Promise<never> {
    throw new Error(
      "the owner key is not stored on this host (by design). Recover from the operator's machine: " +
        "node scripts/vault-recover.js <ownerPrivateKey> <agentPublic> <maxOutflowSompi> " +
        "<windowSizeDaa> <windowStartDaa> <spentInWindowSompi> <destination>"
    );
  }
}

export interface VaultSpendParams {
  wallet: KaspaWallet;
  config: VaultSpendConfig;
  fn: "withdraw" | "recover";
  privateKey: string;
  destination: string;
  amount?: bigint | "max";
  feeSompi?: bigint;
  authorize?: (amountSompi: bigint) => void;
}

const MIN_VAULT_CHANGE_SOMPI = 100_000_000n;
const DUMMY_SIGNATURE = new Uint8Array(65).fill(0xab);
const DUMMY_WALLET_SIGNATURE_SCRIPT = `41${"ab".repeat(65)}`;
const MAX_FEE_CONVERGENCE_PASSES = 12;

export async function spendVault(
  params: VaultSpendParams
): Promise<{ txid: string; amountSompi: bigint; feeSompi: bigint; configUpdate?: Partial<VaultConfig> }> {
  const { wallet, config, fn, destination } = params;
  assertCurrentConfig(config);
  const max = BigInt(config.maxOutflowSompi);
  const windowSize = BigInt(config.windowSizeDaa);
  const currentState = stateFromConfig(config);
  const redeem = buildRedeemScript(config.agentPublic, config.ownerPublic, max, windowSize, currentState);
  const vaultSpk = payToScriptHashScript(redeem);

  const rpc = await wallet.client();
  const utxo = await selectCurrentVaultUtxo(wallet, config, fn === "withdraw");
  const destSpk = payToAddressScript(destination);
  const estimate = await rpc.getFeeEstimate();
  const feerate = estimate.estimate?.normalBuckets?.[0]?.feerate ?? 100;

  if (fn === "recover") {
    let feeSompi = params.feeSompi ?? 0n;
    let converged = params.feeSompi !== undefined;
    for (let i = 0; i < MAX_FEE_CONVERGENCE_PASSES; i++) {
      const candidateAmount = utxo.amount - feeSompi;
      if (candidateAmount <= 0n) {
        throw new Error(`Vault balance ${displayAmount(utxo.amount)} is too small for recovery fee ${displayAmount(feeSompi)}.`);
      }
      const candidateTx = buildTransaction({
        inputs: [txInput(utxo, "")],
        outputs: [{ value: candidateAmount, scriptPublicKey: destSpk }],
        lockTime: 0n,
      });
      const nextFee = estimateTxFeeSompi(wallet.networkId, candidateTx, feerate, [dummyVaultSignatureScript(redeem, "recover")]);
      if (params.feeSompi !== undefined || nextFee <= feeSompi) {
        converged = true;
        break;
      }
      feeSompi = nextFee;
    }
    if (!converged) throw new Error(`vault recovery fee estimate did not converge after ${MAX_FEE_CONVERGENCE_PASSES} passes`);
    const amountSompi = utxo.amount - feeSompi;
    if (amountSompi <= 0n) {
      throw new Error(`Vault balance ${displayAmount(utxo.amount)} is too small for recovery fee ${displayAmount(feeSompi)}.`);
    }
    const tx = buildTransaction({
      inputs: [txInput(utxo, "")],
      outputs: [{ value: amountSompi, scriptPublicKey: destSpk }],
      lockTime: 0n,
    });
    const pushedSig = createInputSignature(tx, 0, new PrivateKey(params.privateKey), SighashType.All);
    setInputScripts(tx, [payToScriptHashSignatureScript(redeem, buildSigArgs(hexToBytes(pushedSig).slice(1), "recover"))]);
    assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault recovery");
    const { transactionId } = await (rpc as any).submitTransaction({ transaction: tx, allowOrphan: false });
    return { txid: String(transactionId), amountSompi, feeSompi };
  }

  if (!config.covenantId) throw new Error("vault has not been covenant-funded yet; call vault_deposit first");

  const info = await rpc.getServerInfo();
  const virtualDaa = BigInt(info.virtualDaaScore);
  // Keep the input non-final so header context enforces this DAA locktime.
  // The contract also requires the active vault UTXO itself to have aged a
  // full window, so stale-but-final historical locktimes cannot reset windows.
  const lockDaa = virtualDaa > 0n ? virtualDaa - 1n : 0n;
  const resetTargetDaa = maxBigInt(currentState.windowStartDaa, utxo.blockDaaScore) + windowSize;
  const reset = lockDaa >= resetTargetDaa;
  const spentAtWindowStart = reset ? 0n : currentState.spentInWindowSompi;
  const remainingWindow = max - spentAtWindowStart;
  if (remainingWindow <= 0n) {
    throw new Error(
      `Vault window exhausted: spent ${displayAmount(spentAtWindowStart)} of ${displayAmount(max)}; ` +
        `next reset at DAA ${resetTargetDaa}`
    );
  }

  const continuationFor = (outflow: bigint) => {
    const nextState = {
      windowStartDaa: reset ? lockDaa : currentState.windowStartDaa,
      spentInWindowSompi: spentAtWindowStart + outflow,
    };
    const nextRedeem = buildRedeemScript(config.agentPublic, config.ownerPublic, max, windowSize, nextState);
    const nextSpk = payToScriptHashScript(nextRedeem);
    const nextAddress = addressFromScriptPublicKey(nextSpk, wallet.networkId)?.toString();
    if (!nextAddress) throw new Error("could not derive next vault address");
    return { nextState, nextRedeem, nextSpk, nextAddress };
  };

  let amountSompi: bigint;
  let feeSompi = params.feeSompi ?? 0n;
  let converged = params.feeSompi !== undefined;
  for (let i = 0; i < MAX_FEE_CONVERGENCE_PASSES; i++) {
    amountSompi = withdrawAmount(params.amount, remainingWindow, utxo.amount, feeSompi);
    const outflow = amountSompi + feeSompi;
    if (outflow > remainingWindow) {
      throw new Error(
        `Outflow ${displayAmount(outflow)} (amount + estimated fee ${displayAmount(feeSompi)}) exceeds remaining vault window ` +
          `${displayAmount(remainingWindow)}.`
      );
    }
    const next = continuationFor(outflow);
    const changeSompi = utxo.amount - outflow;
    if (changeSompi <= 0n) throw new Error(`Vault balance ${displayAmount(utxo.amount)} is too small for this spend.`);
    const tx = buildTransaction({
      inputs: [txInput(utxo, "")],
      outputs: [
        { value: amountSompi, scriptPublicKey: destSpk },
        { value: changeSompi, scriptPublicKey: next.nextSpk, covenant: covenantBinding(config.covenantId, 0) },
      ],
      lockTime: lockDaa,
    });
    const nextFee = estimateTxFeeSompi(wallet.networkId, tx, feerate, [dummyVaultSignatureScript(redeem, "withdraw")]);
    if (params.feeSompi !== undefined || nextFee <= feeSompi) {
      converged = true;
      break;
    }
    feeSompi = nextFee;
  }
  if (!converged) throw new Error(`vault withdrawal fee estimate did not converge after ${MAX_FEE_CONVERGENCE_PASSES} passes`);

  amountSompi = withdrawAmount(params.amount, remainingWindow, utxo.amount, feeSompi);
  const outflow = amountSompi + feeSompi;
  if (outflow > remainingWindow) {
    throw new Error(
      `Outflow ${displayAmount(outflow)} (amount + estimated fee ${displayAmount(feeSompi)}) exceeds remaining vault window ` +
        `${displayAmount(remainingWindow)}.`
    );
  }
  if (amountSompi <= 0n) throw new Error(`Vault balance ${displayAmount(utxo.amount)} is too small for this spend.`);
  params.authorize?.(amountSompi);

  const next = continuationFor(outflow);
  const changeSompi = utxo.amount - outflow;
  if (changeSompi <= 0n) throw new Error(`Vault balance ${displayAmount(utxo.amount)} is too small for this spend.`);

  const tx = buildTransaction({
    inputs: [txInput({ ...utxo, scriptPublicKey: vaultSpk }, "")],
    outputs: [
      { value: amountSompi, scriptPublicKey: destSpk },
      { value: changeSompi, scriptPublicKey: next.nextSpk, covenant: covenantBinding(config.covenantId, 0) },
    ],
    lockTime: lockDaa,
  });
  const pushedSig = createInputSignature(tx, 0, new PrivateKey(params.privateKey), SighashType.All);
  setInputScripts(tx, [payToScriptHashSignatureScript(redeem, buildSigArgs(hexToBytes(pushedSig).slice(1), "withdraw"))]);
  assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault withdrawal");
  const { transactionId } = await (rpc as any).submitTransaction({ transaction: tx, allowOrphan: false });
  const txid = String(transactionId);

  return {
    txid,
    amountSompi,
    feeSompi,
    configUpdate: {
      windowStartDaa: next.nextState.windowStartDaa.toString(),
      spentInWindowSompi: next.nextState.spentInWindowSompi.toString(),
      address: next.nextAddress,
      currentOutpoint: { txid, index: 1 },
    },
  };
}

async function fundInitialVault(params: {
  wallet: KaspaWallet;
  config: VaultConfig;
  amountSompi: bigint | "max";
  keepFloatSompi: bigint;
}): Promise<{ txid: string; depositedSompi: bigint; feeSompi: bigint; configUpdate: Partial<VaultConfig> }> {
  const { wallet, config, keepFloatSompi } = params;
  const rpc = await wallet.client();
  let walletUtxos = params.amountSompi === "max" ? await listWalletUtxos(wallet) : await selectWalletUtxos(wallet, params.amountSompi);
  const vaultSpk = payToScriptHashScript(
    buildRedeemScript(config.agentPublic, config.ownerPublic, BigInt(config.maxOutflowSompi), BigInt(config.windowSizeDaa), stateFromConfig(config))
  );
  const changeSpk = payToAddressScript(wallet.address);
  const estimate = await rpc.getFeeEstimate();
  const feerate = estimate.estimate?.normalBuckets?.[0]?.feerate ?? 100;

  let feeSompi = 0n;
  let amountSompi = 0n;
  let tx: Transaction | undefined;
  let converged = false;
  for (let i = 0; i < MAX_FEE_CONVERGENCE_PASSES; i++) {
    let walletTotal = sumUtxoAmounts(walletUtxos);
    amountSompi = depositAmountFor(params.amountSompi, walletTotal, feeSompi, keepFloatSompi);
    if (params.amountSompi !== "max" && walletTotal < amountSompi + feeSompi) {
      walletUtxos = await selectWalletUtxos(wallet, amountSompi + feeSompi);
      walletTotal = sumUtxoAmounts(walletUtxos);
      amountSompi = depositAmountFor(params.amountSompi, walletTotal, feeSompi, keepFloatSompi);
    }
    tx = buildGenesisDepositTx(walletUtxos, vaultSpk, changeSpk, amountSompi, feeSompi);
    const nextFee = estimateTxFeeSompi(wallet.networkId, tx, feerate, walletUtxos.map(() => DUMMY_WALLET_SIGNATURE_SCRIPT));
    if (nextFee <= feeSompi) {
      converged = true;
      break;
    }
    feeSompi = nextFee;
  }
  if (!converged || !tx) throw new Error(`vault deposit fee estimate did not converge after ${MAX_FEE_CONVERGENCE_PASSES} passes`);
  const walletTotal = sumUtxoAmounts(walletUtxos);
  if (walletTotal < amountSompi + feeSompi) {
    throw new Error(
      `Regular wallet balance ${displayAmount(walletTotal)} cannot cover vault deposit ${displayAmount(amountSompi)} plus fee ${displayAmount(feeSompi)}.`
    );
  }

  tx = buildGenesisDepositTx(walletUtxos, vaultSpk, changeSpk, amountSompi, feeSompi);
  setInputScripts(
    tx,
    walletUtxos.map((_, index) => wallet.signInput(tx, index))
  );
  assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault deposit");
  const covenantId = tx.outputs[0].covenant?.covenantId?.toString();
  if (!covenantId) throw new Error("failed to populate genesis covenant id");
  const { transactionId } = await (rpc as any).submitTransaction({ transaction: tx, allowOrphan: false });
  const txid = String(transactionId);
  return {
    txid,
    depositedSompi: amountSompi,
    feeSompi,
    configUpdate: {
      covenantId,
      currentOutpoint: { txid, index: 0 },
    },
  };
}

async function topUpVault(params: {
  wallet: KaspaWallet;
  config: VaultConfig;
  privateKey: string;
  amountSompi: bigint | "max";
  keepFloatSompi: bigint;
}): Promise<{ txid: string; depositedSompi: bigint; feeSompi: bigint; configUpdate: Partial<VaultConfig> }> {
  const { wallet, config, privateKey, keepFloatSompi } = params;
  if (!config.covenantId) throw new Error("vault has no covenant id; cannot top up");
  const rpc = await wallet.client();
  const vaultUtxo = await selectCurrentVaultUtxo(wallet, config, true);
  let walletUtxos = params.amountSompi === "max" ? await listWalletUtxos(wallet) : await selectWalletUtxos(wallet, params.amountSompi);
  const state = stateFromConfig(config);
  const windowSize = BigInt(config.windowSizeDaa);
  const redeem = buildRedeemScript(config.agentPublic, config.ownerPublic, BigInt(config.maxOutflowSompi), windowSize, state);
  const info = await rpc.getServerInfo();
  const virtualDaa = BigInt(info.virtualDaaScore);
  const lockDaa = virtualDaa > 0n ? virtualDaa - 1n : 0n;
  const resetTargetDaa = maxBigInt(state.windowStartDaa, vaultUtxo.blockDaaScore) + windowSize;
  const nextState = lockDaa >= resetTargetDaa ? { windowStartDaa: lockDaa, spentInWindowSompi: 0n } : state;
  const nextRedeem = buildRedeemScript(config.agentPublic, config.ownerPublic, BigInt(config.maxOutflowSompi), windowSize, nextState);
  const nextSpk = payToScriptHashScript(nextRedeem);
  const nextAddress = addressFromScriptPublicKey(nextSpk, wallet.networkId)?.toString();
  if (!nextAddress) throw new Error("could not derive next vault address");
  const changeSpk = payToAddressScript(wallet.address);
  const estimate = await rpc.getFeeEstimate();
  const feerate = estimate.estimate?.normalBuckets?.[0]?.feerate ?? 100;

  let feeSompi = 0n;
  let amountSompi = 0n;
  let tx: Transaction | undefined;
  let converged = false;
  for (let i = 0; i < MAX_FEE_CONVERGENCE_PASSES; i++) {
    let walletTotal = sumUtxoAmounts(walletUtxos);
    amountSompi = depositAmountFor(params.amountSompi, walletTotal, feeSompi, keepFloatSompi);
    if (params.amountSompi !== "max" && walletTotal < amountSompi + feeSompi) {
      walletUtxos = await selectWalletUtxos(wallet, amountSompi + feeSompi);
      walletTotal = sumUtxoAmounts(walletUtxos);
      amountSompi = depositAmountFor(params.amountSompi, walletTotal, feeSompi, keepFloatSompi);
    }
    tx = buildTopupTx(config, vaultUtxo, walletUtxos, nextSpk, changeSpk, amountSompi, feeSompi, lockDaa);
    const nextFee = estimateTxFeeSompi(wallet.networkId, tx, feerate, [
      dummyVaultSignatureScript(redeem, "topup"),
      ...walletUtxos.map(() => DUMMY_WALLET_SIGNATURE_SCRIPT),
    ]);
    if (nextFee <= feeSompi) {
      converged = true;
      break;
    }
    feeSompi = nextFee;
  }
  if (!converged || !tx) throw new Error(`vault top-up fee estimate did not converge after ${MAX_FEE_CONVERGENCE_PASSES} passes`);
  const walletTotal = sumUtxoAmounts(walletUtxos);
  if (walletTotal < amountSompi + feeSompi) {
    throw new Error(
      `Regular wallet balance ${displayAmount(walletTotal)} cannot cover vault top-up ${displayAmount(amountSompi)} plus fee ${displayAmount(feeSompi)}.`
    );
  }

  tx = buildTopupTx(config, vaultUtxo, walletUtxos, nextSpk, changeSpk, amountSompi, feeSompi, lockDaa);
  const pushedVaultSig = createInputSignature(tx, 0, new PrivateKey(privateKey), SighashType.All);
  setInputScripts(tx, [
    payToScriptHashSignatureScript(redeem, buildSigArgs(hexToBytes(pushedVaultSig).slice(1), "topup")),
    ...walletUtxos.map((_, index) => wallet.signInput(tx, index + 1)),
  ]);
  assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault top-up");
  const { transactionId } = await (rpc as any).submitTransaction({ transaction: tx, allowOrphan: false });
  const txid = String(transactionId);
  return {
    txid,
    depositedSompi: amountSompi,
    feeSompi,
    configUpdate: {
      windowStartDaa: nextState.windowStartDaa.toString(),
      spentInWindowSompi: nextState.spentInWindowSompi.toString(),
      address: nextAddress,
      currentOutpoint: { txid, index: 0 },
    },
  };
}

function buildGenesisDepositTx(walletUtxos: NormalizedUtxo[], vaultSpk: unknown, changeSpk: unknown, amountSompi: bigint, feeSompi: bigint): Transaction {
  const change = sumUtxoAmounts(walletUtxos) - amountSompi - feeSompi;
  const outputs = [{ value: amountSompi, scriptPublicKey: vaultSpk }];
  if (change > 0n) outputs.push({ value: change, scriptPublicKey: changeSpk });
  const tx = buildTransaction({ inputs: walletUtxos.map((utxo) => txInput(utxo, "")), outputs, lockTime: 0n });
  tx.populateGenesisCovenants([{ authorizingInput: 0, outputs: [0] }]);
  return tx;
}

function buildTopupTx(
  config: VaultConfig,
  vaultUtxo: NormalizedUtxo,
  walletUtxos: NormalizedUtxo[],
  vaultSpk: unknown,
  changeSpk: unknown,
  amountSompi: bigint,
  feeSompi: bigint,
  lockTime: bigint
): Transaction {
  if (!config.covenantId) throw new Error("missing covenant id");
  const change = sumUtxoAmounts(walletUtxos) - amountSompi - feeSompi;
  const outputs: unknown[] = [
    {
      value: vaultUtxo.amount + amountSompi,
      scriptPublicKey: vaultSpk,
      covenant: covenantBinding(config.covenantId, 0),
    },
  ];
  if (change > 0n) outputs.push({ value: change, scriptPublicKey: changeSpk });
  return buildTransaction({
    inputs: [txInput(vaultUtxo, ""), ...walletUtxos.map((utxo) => txInput(utxo, ""))],
    outputs,
    lockTime,
  });
}

function buildTransaction(params: {
  inputs: unknown[];
  outputs: unknown[];
  lockTime: bigint;
}): Transaction {
  const tx = new Transaction({
    version: 1,
    inputs: params.inputs,
    outputs: params.outputs,
    lockTime: params.lockTime,
    subnetworkId: SUBNETWORK_NATIVE,
    gas: 0n,
    payload: "",
  } as any);
  const inputs = tx.inputs;
  for (const input of inputs) {
    input.sigOpCount = 0;
    input.computeBudget = VAULT_INPUT_COMPUTE_BUDGET;
  }
  tx.inputs = inputs;
  tx.finalize();
  return tx;
}

function txInput(utxo: NormalizedUtxo, signatureScript: string | Uint8Array): unknown {
  return {
    previousOutpoint: { transactionId: utxo.txid, index: utxo.index },
    signatureScript,
    sequence: NON_FINAL_SEQUENCE,
    sigOpCount: 0,
    computeBudget: VAULT_INPUT_COMPUTE_BUDGET,
    utxo: {
      outpoint: { transactionId: utxo.txid, index: utxo.index },
      amount: utxo.amount,
      scriptPublicKey: utxo.scriptPublicKey,
      blockDaaScore: utxo.blockDaaScore,
      isCoinbase: utxo.isCoinbase,
      covenantId: utxo.covenantId ? new Hash(utxo.covenantId) : undefined,
    },
  };
}

function setInputScripts(tx: Transaction, scripts: Array<string | Uint8Array>): void {
  const inputs = tx.inputs;
  for (let i = 0; i < scripts.length; i++) {
    inputs[i].signatureScript = scripts[i] as any;
    inputs[i].sigOpCount = 0;
    inputs[i].computeBudget = VAULT_INPUT_COMPUTE_BUDGET;
  }
  tx.inputs = inputs;
  tx.finalize();
}

async function selectCurrentVaultUtxo(wallet: KaspaWallet, config: VaultSpendConfig, requireCovenant: boolean): Promise<NormalizedUtxo> {
  const rpc = await wallet.client();
  const { entries } = await rpc.getUtxosByAddresses([config.address]);
  let matches = normalizeEntries(entries);
  if (requireCovenant) {
    if (!config.covenantId) throw new Error("vault has no covenant id; call vault_deposit first");
    matches = matches.filter((entry) => entry.covenantId === config.covenantId);
  }
  if (config.currentOutpoint) {
    matches = matches.filter((entry) => entry.txid === config.currentOutpoint?.txid && entry.index === config.currentOutpoint?.index);
  }
  if (!matches.length) throw new Error(`vault ${config.address} has no current spendable UTXO`);
  if (requireCovenant && matches.length !== 1) {
    throw new Error(`vault singleton invariant violated: found ${matches.length} current covenant UTXOs`);
  }
  return matches.sort((a, b) => (a.amount > b.amount ? -1 : 1))[0];
}

async function listWalletUtxos(wallet: KaspaWallet): Promise<NormalizedUtxo[]> {
  const rpc = await wallet.client();
  const { entries } = await rpc.getUtxosByAddresses([wallet.address]);
  const normalized = normalizeEntries(entries)
    .filter((entry) => !entry.covenantId)
    .sort((a, b) => (a.amount > b.amount ? -1 : 1));
  if (!normalized.length) throw new Error(`no spendable wallet UTXOs for ${wallet.address}; fund the wallet first`);
  return normalized;
}

async function selectWalletUtxos(wallet: KaspaWallet, amountHint: bigint): Promise<NormalizedUtxo[]> {
  const normalized = await listWalletUtxos(wallet);
  const selected: NormalizedUtxo[] = [];
  let total = 0n;
  for (const entry of normalized) {
    selected.push(entry);
    total += entry.amount;
    if (total >= amountHint) return selected;
  }
  throw new Error(`Regular wallet balance ${displayAmount(total)} cannot cover required amount ${displayAmount(amountHint)}.`);
}

function sumUtxoAmounts(utxos: NormalizedUtxo[]): bigint {
  return utxos.reduce((acc, utxo) => acc + utxo.amount, 0n);
}

function withdrawAmount(amount: bigint | "max" | undefined, remainingWindow: bigint, utxoAmount: bigint, feeSompi: bigint): bigint {
  if (amount !== "max") return amount!;
  const outflowCap = minBigInt(remainingWindow, utxoAmount - MIN_VAULT_CHANGE_SOMPI);
  if (outflowCap <= 0n) throw new Error(`Vault balance ${displayAmount(utxoAmount)} is too small to withdraw from.`);
  return outflowCap - feeSompi;
}

function depositAmountFor(requested: bigint | "max", walletTotal: bigint, feeSompi: bigint, keepFloatSompi: bigint): bigint {
  if (requested !== "max") return requested;
  const amount = walletTotal - keepFloatSompi - feeSompi;
  if (amount <= 0n) {
    throw new Error(
      `Nothing to deposit: regular wallet has ${displayAmount(walletTotal)}, requested float is ${displayAmount(keepFloatSompi)}, and estimated fee is ${displayAmount(feeSompi)}.`
    );
  }
  return amount;
}

function normalizeEntries(entries: any[]): NormalizedUtxo[] {
  return (entries ?? []).map((raw) => {
    const entry = raw?.entry ?? raw;
    const outpoint = raw?.outpoint ?? entry?.outpoint;
    const covenant = raw?.covenantId ?? entry?.covenantId;
    return {
      txid: String(outpoint?.transactionId),
      index: Number(outpoint?.index),
      amount: BigInt(raw?.amount ?? entry?.amount ?? 0),
      scriptPublicKey: raw?.scriptPublicKey ?? entry?.scriptPublicKey,
      blockDaaScore: BigInt(raw?.blockDaaScore ?? entry?.blockDaaScore ?? 0),
      isCoinbase: Boolean(raw?.isCoinbase ?? entry?.isCoinbase ?? false),
      covenantId: covenant ? String(covenant) : undefined,
    };
  });
}

function stateFromConfig(config: Pick<VaultConfig, "windowStartDaa" | "spentInWindowSompi">): VaultState {
  return {
    windowStartDaa: BigInt(config.windowStartDaa),
    spentInWindowSompi: BigInt(config.spentInWindowSompi),
  };
}

function assertCurrentConfig(config: Partial<VaultConfig>): asserts config is VaultConfig {
  const missing = ["agentPublic", "ownerPublic", "maxOutflowSompi", "windowSizeDaa", "windowStartDaa", "spentInWindowSompi", "address"].filter(
    (key) => typeof (config as any)[key] !== "string"
  );
  if (missing.length) {
    throw new Error(`vault config is not the current stateful format; recreate the vault (${missing.join(", ")} missing)`);
  }
  if (config.template !== undefined && config.template !== VAULT_TEMPLATE_VERSION) {
    throw new Error(`unsupported vault template ${config.template}; expected ${VAULT_TEMPLATE_VERSION}`);
  }
}

function dummyVaultSignatureScript(redeem: Uint8Array, fn: "withdraw" | "topup" | "recover"): string | Uint8Array {
  return payToScriptHashSignatureScript(redeem, buildSigArgs(DUMMY_SIGNATURE, fn));
}

function estimateTxFeeSompi(networkId: string, tx: Transaction, feerate: number, inputScripts: Array<string | Uint8Array>): bigint {
  try {
    setInputScripts(tx, inputScripts);
    return withFeeMargin(minimumSignedTxFeeSompi(networkId, tx, feerate));
  } catch {
    return 100_000n * BigInt(inputScripts.length);
  }
}

function assertFeeCoversSignedTx(networkId: string, tx: Transaction, feerate: number, feeSompi: bigint, label: string): void {
  const requiredFee = minimumSignedTxFeeSompi(networkId, tx, feerate);
  if (feeSompi < requiredFee) {
    throw new Error(`${label} fee ${displayAmount(feeSompi)} is below final signed transaction minimum ${displayAmount(requiredFee)}.`);
  }
}

function minimumSignedTxFeeSompi(networkId: string, tx: Transaction, feerate: number): bigint {
  const computeBudgetMass = [...tx.inputs].reduce((acc, input: any) => acc + BigInt(input.computeBudget ?? 0) * GRAMS_PER_COMPUTE_BUDGET_UNIT, 0n);
  return (calculateTransactionMass(networkId, tx) + computeBudgetMass) * feeRateSompiPerGram(feerate);
}

function feeRateSompiPerGram(feerate: number): bigint {
  return BigInt(Math.max(Math.ceil(feerate), 100));
}

function withFeeMargin(feeSompi: bigint): bigint {
  return (feeSompi * 110n + 99n) / 100n;
}

function displayAmount(sompi: bigint): string {
  return `${formatKas(sompi)} KAS (${sompi} sompi)`;
}

function formatKas(sompi: bigint): string {
  const sign = sompi < 0n ? "-" : "";
  const absolute = sompi < 0n ? -sompi : sompi;
  const whole = absolute / 100_000_000n;
  const fraction = (absolute % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function covenantBinding(covenantId: string, authorizingInput: number): CovenantBinding {
  return new CovenantBinding(authorizingInput, new Hash(covenantId));
}

function pushDataLength(dataLength: number): number {
  if (dataLength <= 75) return 1 + dataLength;
  if (dataLength <= 0xff) return 2 + dataLength;
  if (dataLength <= 0xffff) return 3 + dataLength;
  throw new Error("pushdata too large");
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function generateOwnerKey(): { privateKey: string; publicKey: string } {
  const kp = Keypair.random();
  return { privateKey: kp.privateKey, publicKey: String(kp.xOnlyPublicKey) };
}

export { bytesToHex };
