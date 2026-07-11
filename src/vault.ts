import { createHash } from "node:crypto";
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
} from "./kaspa-wasm.js";
import { SecureLocalStateDirectory } from "./secure-local-state.js";
import { VAULT_TEMPLATE_VERSION, VaultState, buildRedeemScript, buildSigArgs, bytesToHex, hexToBytes } from "./vault/template.js";
import type { KaspaWallet } from "./wallet.js";

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

export interface PreparedVaultSpend {
  transaction: string;
  transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
  transactionId: string;
  destination: string;
  destinationOutpoint: { txid: string; index: 0 };
  amountSompi: bigint;
  feeSompi: bigint;
  continuationOutpoint: { txid: string; index: 1 };
  continuationAddress: string;
  continuationAmountSompi: bigint;
  covenantId: string;
  baseConfigDigest: string;
  configUpdate: {
    windowStartDaa: string;
    spentInWindowSompi: string;
    address: string;
    currentOutpoint: { txid: string; index: 1 };
  };
}

export interface ObservedVaultSpend {
  transactionId: string;
  destinationOutpoint: { txid: string; index: 0 };
  continuationOutpoint: { txid: string; index: 1 };
  amountSompi: bigint;
  continuationAmountSompi: bigint;
  observedAtDaa?: bigint;
}

export type VaultSendReconciliation =
  | { readonly status: "observed"; readonly observation: ObservedVaultSpend }
  | { readonly status: "not_submitted" }
  | { readonly status: "pending" };

export interface PreparedVaultDeposit {
  readonly transaction: string;
  readonly transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
  readonly transactionId: string;
  readonly depositKind: "initial" | "topup";
  readonly depositedSompi: bigint;
  readonly feeSompi: bigint;
  readonly vaultAddress: string;
  readonly vaultOutpoint: { readonly txid: string; readonly index: 0 };
  readonly vaultAmountSompi: bigint;
  readonly covenantId: string;
  readonly baseConfigDigest: string;
  readonly sourceInputs: readonly {
    readonly address: string;
    readonly txid: string;
    readonly index: number;
    readonly amountSompi: bigint;
  }[];
  readonly configUpdate: Partial<VaultConfig> & {
    readonly currentOutpoint: { readonly txid: string; readonly index: 0 };
  };
}

export interface ObservedVaultDeposit {
  readonly transactionId: string;
  readonly vaultOutpoint: { readonly txid: string; readonly index: 0 };
  readonly vaultAmountSompi: bigint;
  readonly covenantId: string;
  readonly observedAtDaa?: bigint;
}

export type VaultDepositReconciliation =
  | { readonly status: "observed"; readonly observation: ObservedVaultDeposit }
  | { readonly status: "not_submitted" }
  | { readonly status: "pending" };

export interface VaultSpendResult {
  txid: string;
  amountSompi: bigint;
  feeSompi: bigint;
  configUpdate?: Partial<VaultConfig>;
  preparedTransaction?: string;
}

type VaultSpendConfig = Pick<
  VaultConfig,
  | "template"
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
const MAX_VAULT_AGENT_KEY_BYTES = 256;
const MAX_VAULT_CONFIG_BYTES = 64 * 1024;
const UINT64_MAX = (1n << 64n) - 1n;

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
  private readonly state: SecureLocalStateDirectory;
  private readonly networkId: string;

  constructor(dataDir: string, networkId: string) {
    const root = new SecureLocalStateDirectory(dataDir, "Sompi data");
    this.state = root.child("vault", "vault state");
    this.networkId = networkId;
  }

  get configured(): boolean {
    const hasConfig = this.state.fileExists("config.json");
    const hasAgentKey = this.state.fileExists("agent-key");
    if (hasConfig !== hasAgentKey) {
      throw new Error(
        "vault state is incomplete after an interrupted creation; do not recreate or overwrite its secret"
      );
    }
    return hasConfig;
  }

  config(): VaultConfig {
    if (!this.configured) throw new Error("vault is not configured");
    const bytes = this.state.readFile("config.json", MAX_VAULT_CONFIG_BYTES);
    try {
      let config: unknown;
      try {
        config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        throw new Error("vault config is malformed", { cause: error });
      }
      assertCurrentConfig(config, this.networkId);
      return config as VaultConfig;
    } finally {
      bytes.fill(0);
    }
  }

  create(maxOutflowSompi: bigint, ownerPublicKey: string, windowSizeDaa: bigint = DEFAULT_WINDOW_SIZE_DAA): VaultConfig {
    if (this.configured) {
      throw new Error(`vault already exists at ${this.state.directory}; use it or move it aside first`);
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

    let agent: Keypair | undefined;
    let agentBytes: Buffer | undefined;
    let configBytes: Buffer | undefined;
    try {
      agent = Keypair.random();
      const agentPublic = String(agent.xOnlyPublicKey);
      const state = { windowStartDaa: 0n, spentInWindowSompi: 0n };
      const address = this.deriveAddress(agentPublic, ownerPublic, maxOutflowSompi, windowSizeDaa, state);
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
      assertCurrentConfig(config, this.networkId);

      agentBytes = Buffer.from(agent.privateKey, "utf8");
      this.state.createFileExclusive("agent-key", agentBytes, MAX_VAULT_AGENT_KEY_BYTES);
      configBytes = encodeVaultConfig(config);
      this.state.createFileExclusive("config.json", configBytes, MAX_VAULT_CONFIG_BYTES);
      return config;
    } finally {
      configBytes?.fill(0);
      agentBytes?.fill(0);
      agent?.free();
    }
  }

  private saveConfig(config: VaultConfig): void {
    assertCurrentConfig(config, this.networkId);
    const bytes = encodeVaultConfig(config);
    try {
      this.state.replaceFileAtomic("config.json", bytes, MAX_VAULT_CONFIG_BYTES);
    } finally {
      bytes.fill(0);
    }
  }

  private deriveAddress(
    agentPublic: string,
    ownerPublic: string,
    maxOutflowSompi: bigint,
    windowSizeDaa: bigint,
    state: VaultState
  ): string {
    return deriveVaultAddress(
      agentPublic,
      ownerPublic,
      maxOutflowSompi,
      windowSizeDaa,
      state,
      this.networkId
    );
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

  /** Builds and signs a covenant deposit without broadcasting or changing config. */
  async prepareDeposit(
    wallet: KaspaWallet,
    amountSompi: bigint | "max",
    keepFloatSompi: bigint = 0n,
    feeCeilingSompi?: bigint
  ): Promise<PreparedVaultDeposit> {
    if (amountSompi !== "max" && amountSompi <= 0n) throw new Error("Vault deposit amount must be positive.");
    if (keepFloatSompi < 0n) throw new Error("keepFloatSompi must be non-negative");
    if (feeCeilingSompi !== undefined && feeCeilingSompi < 0n) {
      throw new Error("Vault deposit fee ceiling must be non-negative.");
    }
    const config = this.config();
    const result = config.covenantId
      ? await this.withAgentPrivateKey(config, (signingKey) =>
          topUpVault({
            wallet,
            config,
            signingKey,
            amountSompi,
            keepFloatSompi,
            feeCeilingSompi,
            broadcast: false,
          })
        )
      : await fundInitialVault({
          wallet,
          config,
          amountSompi,
          keepFloatSompi,
          feeCeilingSompi,
          broadcast: false,
        });
    if (!result.preparedTransaction) {
      throw new Error("vault deposit preparation did not return signed transaction material");
    }
    const transaction = requirePreparedTransaction(result.preparedTransaction, result.txid);
    try {
      const output = transaction.outputs[0];
      if (!output) throw new Error("prepared vault deposit has no covenant output");
      const address = addressFromScriptPublicKey(output.scriptPublicKey, this.networkId);
      const vaultAddress = address?.toString();
      address?.free();
      if (!vaultAddress) throw new Error("prepared vault deposit address cannot be derived");
      const covenantId = result.configUpdate.covenantId ?? config.covenantId;
      if (!covenantId || !/^[a-f0-9]{64}$/.test(covenantId)) {
        throw new Error("prepared vault deposit covenant identity is invalid");
      }
      const binding = output.covenant;
      if (!binding || String(binding.covenantId) !== covenantId || binding.authorizingInput !== 0) {
        throw new Error("prepared vault deposit covenant binding changed");
      }
      const currentOutpoint = result.configUpdate.currentOutpoint;
      if (currentOutpoint?.txid !== result.txid || currentOutpoint.index !== 0) {
        throw new Error("prepared vault deposit continuation outpoint is invalid");
      }
      const sourceInputs = transaction.inputs.map((input) => {
        const utxo = input.utxo;
        if (!utxo) throw new Error("prepared vault deposit input lacks recovery UTXO data");
        const source = addressFromScriptPublicKey(utxo.scriptPublicKey, this.networkId);
        try {
          const sourceAddress = source?.toString();
          if (!sourceAddress) throw new Error("prepared vault deposit input address cannot be derived");
          return Object.freeze({
            address: sourceAddress,
            txid: String(input.previousOutpoint.transactionId),
            index: input.previousOutpoint.index,
            amountSompi: BigInt(utxo.amount),
          });
        } finally {
          source?.free();
        }
      });
      const prepared: PreparedVaultDeposit = Object.freeze({
        transaction: result.preparedTransaction,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
        transactionId: result.txid,
        depositKind: config.covenantId ? "topup" as const : "initial" as const,
        depositedSompi: result.depositedSompi,
        feeSompi: result.feeSompi,
        vaultAddress,
        vaultOutpoint: Object.freeze({ txid: result.txid, index: 0 as const }),
        vaultAmountSompi: BigInt(output.value),
        covenantId,
        baseConfigDigest: vaultConfigDigest(config),
        sourceInputs: Object.freeze(sourceInputs),
        configUpdate: Object.freeze({
          ...result.configUpdate,
          currentOutpoint: Object.freeze({ txid: result.txid, index: 0 as const }),
        }),
      });
      const verified = requireBoundPreparedDeposit(prepared, this.networkId);
      verified.free();
      return prepared;
    } finally {
      transaction.free();
    }
  }

  async submitPreparedDeposit(
    wallet: KaspaWallet,
    prepared: PreparedVaultDeposit
  ): Promise<{ transactionId: string }> {
    const transaction = requireBoundPreparedDeposit(prepared, this.networkId);
    try {
      const rpc = await wallet.client();
      const submitted = await (rpc as any).submitTransaction({ transaction, allowOrphan: false });
      const transactionId = String(submitted?.transactionId ?? "");
      if (transactionId !== prepared.transactionId) {
        throw new Error("Kaspa node returned a different transaction identity for the prepared vault deposit");
      }
      return { transactionId };
    } finally {
      transaction.free();
    }
  }

  async observePreparedDeposit(
    wallet: KaspaWallet,
    prepared: PreparedVaultDeposit
  ): Promise<ObservedVaultDeposit | undefined> {
    const transaction = requireBoundPreparedDeposit(prepared, this.networkId);
    transaction.free();
    const rpc = await wallet.client();
    const { entries } = await rpc.getUtxosByAddresses([prepared.vaultAddress]);
    const matches = normalizeEntries(entries).filter((entry) =>
      entry.txid === prepared.transactionId &&
      entry.index === 0 &&
      entry.amount === prepared.vaultAmountSompi &&
      entry.covenantId === prepared.covenantId &&
      scriptPublicKeyMatchesAddress(entry.scriptPublicKey, prepared.vaultAddress, this.networkId)
    );
    if (matches.length > 1) throw new Error("prepared vault deposit has duplicate on-chain output");
    if (matches.length === 0) return undefined;
    return Object.freeze({
      transactionId: prepared.transactionId,
      vaultOutpoint: prepared.vaultOutpoint,
      vaultAmountSompi: prepared.vaultAmountSompi,
      covenantId: prepared.covenantId,
      observedAtDaa: matches[0].blockDaaScore,
    });
  }

  async reconcilePreparedDeposit(
    wallet: KaspaWallet,
    prepared: PreparedVaultDeposit,
    observationStartHash?: string
  ): Promise<VaultDepositReconciliation> {
    const observed = await this.observePreparedDeposit(wallet, prepared);
    if (observed) return Object.freeze({ status: "observed" as const, observation: observed });
    const rpc = await wallet.client();
    try {
      const mempool = await rpc.getMempoolEntry({
        transactionId: prepared.transactionId,
        includeOrphanPool: false,
        filterTransactionPool: false,
      });
      if (mempool.mempoolEntry) return Object.freeze({ status: "pending" as const });
    } catch (error) {
      if (!isMempoolNotFound(error)) throw error;
    }
    if (observationStartHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(observationStartHash)) {
        throw new Error("vault deposit observation start hash is invalid");
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
            observation: Object.freeze({
              transactionId: prepared.transactionId,
              vaultOutpoint: prepared.vaultOutpoint,
              vaultAmountSompi: prepared.vaultAmountSompi,
              covenantId: prepared.covenantId,
            }),
          });
        }
      } catch {
        // Historical proof may be pruned. Exact intact inputs can still prove
        // non-submission; otherwise ambiguity remains locked.
      }
    }
    const addresses = [...new Set(prepared.sourceInputs.map((input) => input.address))];
    const { entries } = await rpc.getUtxosByAddresses(addresses);
    const live = new Map(
      normalizeEntries(entries).map((entry) => [`${entry.txid}:${entry.index}`, entry.amount] as const)
    );
    const intact = prepared.sourceInputs.every(
      (input) => live.get(`${input.txid}:${input.index}`) === input.amountSompi
    );
    return Object.freeze({ status: intact ? "not_submitted" as const : "pending" as const });
  }

  commitObservedDeposit(
    prepared: PreparedVaultDeposit,
    observed: ObservedVaultDeposit
  ): VaultConfig {
    const transaction = requireBoundPreparedDeposit(prepared, this.networkId);
    transaction.free();
    if (
      observed.transactionId !== prepared.transactionId ||
      observed.vaultOutpoint.txid !== prepared.transactionId ||
      observed.vaultOutpoint.index !== 0 ||
      observed.vaultAmountSompi !== prepared.vaultAmountSompi ||
      observed.covenantId !== prepared.covenantId
    ) {
      throw new Error("vault deposit observation does not match exact prepared transaction");
    }
    const current = this.config();
    const updated: VaultConfig = { ...current, ...prepared.configUpdate };
    if (vaultConfigMatchesDepositUpdate(current, prepared.configUpdate)) return current;
    if (vaultConfigDigest(current) !== prepared.baseConfigDigest) {
      throw new Error("vault state advanced after this deposit was prepared");
    }
    this.saveConfig(updated);
    return updated;
  }

  /**
   * Signs an immutable vault withdrawal without broadcasting it or advancing
   * local vault state. The caller must durably journal this result before
   * `submitPreparedSend` and must not call `commitObservedSend` until both
   * outputs have been independently observed.
   */
  async prepareSend(
    wallet: KaspaWallet,
    destination: string,
    amount: bigint | "max",
    authorize?: (amountSompi: bigint) => void,
    feeCeilingSompi?: bigint
  ): Promise<PreparedVaultSpend> {
    if (amount !== "max" && amount <= 0n) throw new Error("Prepared vault send amount must be positive.");
    if (feeCeilingSompi !== undefined && feeCeilingSompi < 0n) {
      throw new Error("Prepared vault send fee ceiling must be non-negative.");
    }
    const config = this.config();
    if (!config.covenantId) throw new Error("vault has not been covenant-funded yet");
    const result = await this.withAgentPrivateKey(config, (signingKey) =>
      spendVault({
        wallet,
        config,
        fn: "withdraw",
        signingKey,
        destination,
        amount,
        authorize,
        feeCeilingSompi,
        broadcast: false,
      })
    );
    if (!result.preparedTransaction || !result.configUpdate) {
      throw new Error("vault preparation did not return an immutable transaction and state update");
    }
    const transaction = requirePreparedTransaction(
      result.preparedTransaction,
      result.txid
    );
    const outputs = transaction.outputs;
    if (outputs.length !== 2) {
      transaction.free();
      throw new Error("prepared vault staging transaction must have exactly two outputs");
    }
    const destinationAmount = BigInt((outputs[0] as any).value);
    const continuationAmount = BigInt((outputs[1] as any).value);
    transaction.free();
    if (destinationAmount !== result.amountSompi) {
      throw new Error("prepared vault staging output does not match the requested amount");
    }
    const update = requirePreparedConfigUpdate(result.configUpdate, result.txid);
    const prepared: PreparedVaultSpend = {
      transaction: result.preparedTransaction,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
      transactionId: result.txid,
      destination,
      destinationOutpoint: Object.freeze({ txid: result.txid, index: 0 as const }),
      amountSompi: result.amountSompi,
      feeSompi: result.feeSompi,
      continuationOutpoint: Object.freeze({ txid: result.txid, index: 1 as const }),
      continuationAddress: update.address,
      continuationAmountSompi: continuationAmount,
      covenantId: config.covenantId,
      baseConfigDigest: vaultConfigDigest(config),
      configUpdate: Object.freeze(update),
    };
    const validated = requireBoundPreparedTransaction(prepared, this.networkId);
    validated.free();
    return Object.freeze(prepared);
  }

  async submitPreparedSend(
    wallet: KaspaWallet,
    prepared: PreparedVaultSpend
  ): Promise<{ transactionId: string }> {
    assertPreparedVaultSpend(prepared);
    const transaction = requireBoundPreparedTransaction(prepared, this.networkId);
    try {
      const rpc = await wallet.client();
      const submitted = await (rpc as any).submitTransaction({
        transaction,
        allowOrphan: false,
      });
      const transactionId = String(submitted?.transactionId ?? "");
      if (transactionId !== prepared.transactionId) {
        throw new Error("Kaspa node returned a different transaction identity for the prepared vault send");
      }
      return { transactionId };
    } finally {
      transaction.free();
    }
  }

  async observePreparedSend(
    wallet: KaspaWallet,
    prepared: PreparedVaultSpend
  ): Promise<ObservedVaultSpend | undefined> {
    assertPreparedVaultSpend(prepared);
    const transaction = requireBoundPreparedTransaction(prepared, this.networkId);
    transaction.free();
    const rpc = await wallet.client();
    const { entries } = await rpc.getUtxosByAddresses([
      prepared.destination,
      prepared.continuationAddress,
    ]);
    const normalized = normalizeEntries(entries);
    const destination = normalized.filter(
      (entry) =>
        entry.txid === prepared.destinationOutpoint.txid &&
        entry.index === prepared.destinationOutpoint.index &&
        entry.amount === prepared.amountSompi &&
        !entry.covenantId &&
        scriptPublicKeyMatchesAddress(entry.scriptPublicKey, prepared.destination, this.networkId)
    );
    const continuation = normalized.filter(
      (entry) =>
        entry.txid === prepared.continuationOutpoint.txid &&
        entry.index === prepared.continuationOutpoint.index &&
        entry.amount === prepared.continuationAmountSompi &&
        entry.covenantId === prepared.covenantId &&
        scriptPublicKeyMatchesAddress(
          entry.scriptPublicKey,
          prepared.continuationAddress,
          this.networkId
        )
    );
    if (destination.length === 0 && continuation.length === 0) return undefined;
    if (destination.length !== 1 || continuation.length !== 1) {
      throw new Error("prepared vault send has a partial, duplicate, or conflicting on-chain observation");
    }
    const observedAtDaa = maxBigInt(
      destination[0].blockDaaScore,
      continuation[0].blockDaaScore
    );
    return Object.freeze({
      transactionId: prepared.transactionId,
      destinationOutpoint: prepared.destinationOutpoint,
      continuationOutpoint: prepared.continuationOutpoint,
      amountSompi: prepared.amountSompi,
      continuationAmountSompi: prepared.continuationAmountSompi,
      observedAtDaa,
    });
  }

  /**
   * Read-only reconciliation for an interrupted prepared send. A retry is
   * allowed only when the transaction is absent from the pool and every exact
   * source outpoint in the signed artifact remains unspent.
   */
  async reconcilePreparedSend(
    wallet: KaspaWallet,
    prepared: PreparedVaultSpend,
    observationStartHash?: string
  ): Promise<VaultSendReconciliation> {
    const observed = await this.observePreparedSend(wallet, prepared);
    if (observed) {
      return Object.freeze({ status: "observed" as const, observation: observed });
    }
    const rpc = await wallet.client();
    try {
      const mempool = await rpc.getMempoolEntry({
        transactionId: prepared.transactionId,
        includeOrphanPool: false,
        filterTransactionPool: false,
      });
      // Presence proves a submission may have happened, but local vault state
      // advances only after both exact outputs reach the UTXO index.
      if (mempool.mempoolEntry) return Object.freeze({ status: "pending" as const });
    } catch (error) {
      if (!isMempoolNotFound(error)) throw error;
    }

    if (observationStartHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(observationStartHash)) {
        throw new Error("vault observation start hash is invalid");
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
            observation: Object.freeze({
              transactionId: prepared.transactionId,
              destinationOutpoint: prepared.destinationOutpoint,
              continuationOutpoint: prepared.continuationOutpoint,
              amountSompi: prepared.amountSompi,
              continuationAmountSompi: prepared.continuationAmountSompi,
            }),
          });
        }
      } catch {
        // Historical observation may be pruned. Intact exact inputs can still
        // prove non-submission; otherwise recovery stays pending.
      }
    }

    const transaction = requireBoundPreparedTransaction(prepared, this.networkId);
    try {
      const inputs = transaction.inputs.map((input) => {
        const utxo = input.utxo;
        if (!utxo) throw new Error("prepared vault input is missing recovery UTXO data");
        const address = addressFromScriptPublicKey(utxo.scriptPublicKey, this.networkId);
        try {
          const sourceAddress = address?.toString();
          if (!sourceAddress) throw new Error("prepared vault input address cannot be derived");
          return Object.freeze({
            sourceAddress,
            txid: String(input.previousOutpoint.transactionId),
            index: input.previousOutpoint.index,
            amount: BigInt(utxo.amount),
          });
        } finally {
          address?.free();
        }
      });
      const addresses = [...new Set(inputs.map((input) => input.sourceAddress))];
      const { entries } = await rpc.getUtxosByAddresses(addresses);
      const live = new Map(
        normalizeEntries(entries).map((entry) => [
          `${entry.txid}:${entry.index}`,
          entry.amount,
        ] as const)
      );
      const allInputsUnspent = inputs.every(
        (input) => live.get(`${input.txid}:${input.index}`) === input.amount
      );
      return Object.freeze({
        status: allInputsUnspent ? "not_submitted" as const : "pending" as const,
      });
    } finally {
      transaction.free();
    }
  }

  commitObservedSend(
    prepared: PreparedVaultSpend,
    observed: ObservedVaultSpend
  ): VaultConfig {
    assertPreparedVaultSpend(prepared);
    if (
      observed.transactionId !== prepared.transactionId ||
      observed.destinationOutpoint.txid !== prepared.destinationOutpoint.txid ||
      observed.destinationOutpoint.index !== 0 ||
      observed.continuationOutpoint.txid !== prepared.continuationOutpoint.txid ||
      observed.continuationOutpoint.index !== 1 ||
      observed.amountSompi !== prepared.amountSompi ||
      observed.continuationAmountSompi !== prepared.continuationAmountSompi
    ) {
      throw new Error("vault observation does not match the exact prepared staging transaction");
    }
    const current = this.config();
    const updated: VaultConfig = { ...current, ...prepared.configUpdate };
    if (vaultConfigMatchesUpdate(current, prepared.configUpdate)) return current;
    if (vaultConfigDigest(current) !== prepared.baseConfigDigest) {
      throw new Error("vault state advanced after this staging transaction was prepared");
    }
    this.saveConfig(updated);
    return updated;
  }

  async recover(): Promise<never> {
    throw new Error(
      "the owner key is not stored on this host (by design). Recover from the operator's machine: " +
        "node scripts/vault-recover.js <ownerPrivateKey> <agentPublic> <maxOutflowSompi> " +
        "<windowSizeDaa> <windowStartDaa> <spentInWindowSompi> <destination>"
    );
  }

  private async withAgentPrivateKey<T>(
    config: VaultConfig,
    operation: (privateKey: PrivateKey) => T | Promise<T>
  ): Promise<T> {
    const bytes = this.state.readFile("agent-key", MAX_VAULT_AGENT_KEY_BYTES);
    let privateKey: PrivateKey | undefined;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (!/^[a-fA-F0-9]{64}$/.test(text)) throw new Error("vault Agent key material is invalid");
      try {
        privateKey = new PrivateKey(text);
      } catch (error) {
        throw new Error("vault Agent key material is invalid", { cause: error });
      }
      if (!privateKeyMatchesXOnly(privateKey, config.agentPublic)) {
        throw new Error("vault Agent key does not match the configured public key");
      }
      return await operation(privateKey);
    } finally {
      privateKey?.free();
      bytes.fill(0);
    }
  }
}

interface VaultSpendParams {
  wallet: KaspaWallet;
  config: VaultSpendConfig;
  fn: "withdraw" | "recover";
  signingKey: PrivateKey;
  destination: string;
  amount?: bigint | "max";
  feeSompi?: bigint;
  feeCeilingSompi?: bigint;
  authorize?: (amountSompi: bigint) => void;
  /** Defaults to true. False returns signed safe JSON without an RPC effect. */
  broadcast?: boolean;
}

const MIN_VAULT_CHANGE_SOMPI = 100_000_000n;
const DUMMY_SIGNATURE = new Uint8Array(65).fill(0xab);
const DUMMY_WALLET_SIGNATURE_SCRIPT = `41${"ab".repeat(65)}`;
const MAX_FEE_CONVERGENCE_PASSES = 12;

async function spendVault(
  params: VaultSpendParams
): Promise<VaultSpendResult> {
  const { wallet, config, fn, destination } = params;
  assertCurrentConfig(config, wallet.networkId);
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
    const pushedSig = createInputSignature(tx, 0, params.signingKey, SighashType.All);
    setInputScripts(tx, [payToScriptHashSignatureScript(redeem, buildSigArgs(hexToBytes(pushedSig).slice(1), "recover"))]);
    assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault recovery");
    if (params.broadcast === false) {
      const txid = String(tx.finalize());
      return {
        txid,
        amountSompi,
        feeSompi,
        preparedTransaction: tx.serializeToSafeJSON(),
      };
    }
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
    const derivedAddress = addressFromScriptPublicKey(nextSpk, wallet.networkId);
    let nextAddress: string;
    try {
      if (!derivedAddress) throw new Error("could not derive next vault address");
      nextAddress = derivedAddress.toString();
    } finally {
      derivedAddress?.free();
    }
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

  if (params.feeCeilingSompi !== undefined && feeSompi > params.feeCeilingSompi) {
    throw new Error("vault withdrawal fee exceeds the capacity reserved before signing");
  }

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
  const pushedSig = createInputSignature(tx, 0, params.signingKey, SighashType.All);
  setInputScripts(tx, [payToScriptHashSignatureScript(redeem, buildSigArgs(hexToBytes(pushedSig).slice(1), "withdraw"))]);
  assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault withdrawal");
  if (params.broadcast === false) {
    const txid = String(tx.finalize());
    return {
      txid,
      amountSompi,
      feeSompi,
      preparedTransaction: tx.serializeToSafeJSON(),
      configUpdate: {
        windowStartDaa: next.nextState.windowStartDaa.toString(),
        spentInWindowSompi: next.nextState.spentInWindowSompi.toString(),
        address: next.nextAddress,
        currentOutpoint: { txid, index: 1 },
      },
    };
  }
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

export interface VaultOwnerRecoveryParams {
  readonly wallet: KaspaWallet;
  readonly config: VaultConfig;
  readonly privateKey: string;
  readonly destination: string;
  readonly feeSompi?: bigint;
}

/**
 * Explicit operator-only escape path for the unrestricted covenant owner.
 * Agent and MCP execution use prepare/submit/observe through the journal; this
 * export cannot invoke the capped Agent withdrawal branch.
 */
export async function recoverVaultWithOwner(
  params: VaultOwnerRecoveryParams
): Promise<VaultSpendResult> {
  let privateKey: PrivateKey | undefined;
  try {
    try {
      privateKey = new PrivateKey(params.privateKey.trim());
    } catch (error) {
      throw new Error("vault owner key material is invalid", { cause: error });
    }
    if (!privateKeyMatchesXOnly(privateKey, params.config.ownerPublic)) {
      throw new Error("vault owner key does not match the configured public key");
    }
    return await spendVault({
      wallet: params.wallet,
      config: params.config,
      fn: "recover",
      signingKey: privateKey,
      destination: params.destination,
      ...(params.feeSompi === undefined ? {} : { feeSompi: params.feeSompi }),
    });
  } finally {
    privateKey?.free();
  }
}

async function fundInitialVault(params: {
  wallet: KaspaWallet;
  config: VaultConfig;
  amountSompi: bigint | "max";
  keepFloatSompi: bigint;
  feeCeilingSompi?: bigint;
  broadcast?: boolean;
}): Promise<{
  txid: string;
  depositedSompi: bigint;
  feeSompi: bigint;
  configUpdate: Partial<VaultConfig>;
  preparedTransaction?: string;
}> {
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
  if (params.feeCeilingSompi !== undefined && feeSompi > params.feeCeilingSompi) {
    throw new Error("vault deposit fee exceeds the capacity reserved before signing");
  }

  tx = buildGenesisDepositTx(walletUtxos, vaultSpk, changeSpk, amountSompi, feeSompi);
  setInputScripts(
    tx,
    walletUtxos.map((_, index) => wallet.signInput(tx, index))
  );
  assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault deposit");
  const covenantId = tx.outputs[0].covenant?.covenantId?.toString();
  if (!covenantId) throw new Error("failed to populate genesis covenant id");
  const preparedTxid = String(tx.finalize());
  if (params.broadcast === false) {
    return {
      txid: preparedTxid,
      depositedSompi: amountSompi,
      feeSompi,
      preparedTransaction: tx.serializeToSafeJSON(),
      configUpdate: {
        covenantId,
        currentOutpoint: { txid: preparedTxid, index: 0 },
      },
    };
  }
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
  signingKey: PrivateKey;
  amountSompi: bigint | "max";
  keepFloatSompi: bigint;
  feeCeilingSompi?: bigint;
  broadcast?: boolean;
}): Promise<{
  txid: string;
  depositedSompi: bigint;
  feeSompi: bigint;
  configUpdate: Partial<VaultConfig>;
  preparedTransaction?: string;
}> {
  const { wallet, config, signingKey, keepFloatSompi } = params;
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
  const derivedAddress = addressFromScriptPublicKey(nextSpk, wallet.networkId);
  let nextAddress: string;
  try {
    if (!derivedAddress) throw new Error("could not derive next vault address");
    nextAddress = derivedAddress.toString();
  } finally {
    derivedAddress?.free();
  }
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
  if (params.feeCeilingSompi !== undefined && feeSompi > params.feeCeilingSompi) {
    throw new Error("vault top-up fee exceeds the capacity reserved before signing");
  }

  tx = buildTopupTx(config, vaultUtxo, walletUtxos, nextSpk, changeSpk, amountSompi, feeSompi, lockDaa);
  const pushedVaultSig = createInputSignature(tx, 0, signingKey, SighashType.All);
  setInputScripts(tx, [
    payToScriptHashSignatureScript(redeem, buildSigArgs(hexToBytes(pushedVaultSig).slice(1), "topup")),
    ...walletUtxos.map((_, index) => wallet.signInput(tx, index + 1)),
  ]);
  assertFeeCoversSignedTx(wallet.networkId, tx, feerate, feeSompi, "vault top-up");
  const preparedTxid = String(tx.finalize());
  if (params.broadcast === false) {
    return {
      txid: preparedTxid,
      depositedSompi: amountSompi,
      feeSompi,
      preparedTransaction: tx.serializeToSafeJSON(),
      configUpdate: {
        windowStartDaa: nextState.windowStartDaa.toString(),
        spentInWindowSompi: nextState.spentInWindowSompi.toString(),
        address: nextAddress,
        currentOutpoint: { txid: preparedTxid, index: 0 },
      },
    };
  }
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

function assertCurrentConfig(config: unknown, networkId: string): asserts config is VaultConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("vault config is not the current stateful format; recreate the vault");
  }
  if (networkId !== "testnet-10") {
    throw new Error("the initial Sompi vault profile supports only testnet-10");
  }
  const record = config as Record<string, unknown>;
  const required = [
    "address",
    "agentPublic",
    "maxOutflowSompi",
    "ownerPublic",
    "spentInWindowSompi",
    "template",
    "windowSizeDaa",
    "windowStartDaa",
  ];
  const optional = ["covenantId", "currentOutpoint"];
  const keys = Object.keys(record).sort();
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error("vault config contains missing or unsupported fields");
  }
  if (record.template !== VAULT_TEMPLATE_VERSION) {
    throw new Error(`unsupported vault template; expected ${VAULT_TEMPLATE_VERSION}`);
  }
  if (
    typeof record.agentPublic !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.agentPublic) ||
    typeof record.ownerPublic !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.ownerPublic)
  ) {
    throw new Error("vault config public keys are invalid or noncanonical");
  }
  const maxOutflowSompi = canonicalUint64(record.maxOutflowSompi, "maximum outflow");
  const windowSizeDaa = canonicalUint64(record.windowSizeDaa, "window size");
  const windowStartDaa = canonicalUint64(record.windowStartDaa, "window start");
  const spentInWindowSompi = canonicalUint64(record.spentInWindowSompi, "window spend");
  if (maxOutflowSompi === 0n || windowSizeDaa === 0n) {
    throw new Error("vault config maximum outflow and window size must be positive");
  }
  if (spentInWindowSompi > maxOutflowSompi) {
    throw new Error("vault config window spend exceeds its maximum outflow");
  }
  if (typeof record.address !== "string" || record.address.length === 0 || record.address.length > 256) {
    throw new Error("vault config address is invalid");
  }

  const hasCovenantId = Object.prototype.hasOwnProperty.call(record, "covenantId");
  const hasCurrentOutpoint = Object.prototype.hasOwnProperty.call(record, "currentOutpoint");
  if (hasCovenantId !== hasCurrentOutpoint) {
    throw new Error("vault config covenant identity and current outpoint must appear together");
  }
  if (hasCovenantId) {
    if (typeof record.covenantId !== "string" || !/^[a-f0-9]{64}$/.test(record.covenantId)) {
      throw new Error("vault config covenant identity is invalid or noncanonical");
    }
    if (!record.currentOutpoint || typeof record.currentOutpoint !== "object" || Array.isArray(record.currentOutpoint)) {
      throw new Error("vault config current outpoint is invalid");
    }
    const outpoint = record.currentOutpoint as Record<string, unknown>;
    const outpointKeys = Object.keys(outpoint).sort();
    if (
      outpointKeys.length !== 2 ||
      outpointKeys[0] !== "index" ||
      outpointKeys[1] !== "txid" ||
      typeof outpoint.txid !== "string" ||
      !/^[a-f0-9]{64}$/.test(outpoint.txid) ||
      (outpoint.index !== 0 && outpoint.index !== 1)
    ) {
      throw new Error("vault config current outpoint is invalid or noncanonical");
    }
  }

  const derivedAddress = deriveVaultAddress(
    record.agentPublic,
    record.ownerPublic,
    maxOutflowSompi,
    windowSizeDaa,
    { windowStartDaa, spentInWindowSompi },
    networkId
  );
  if (record.address !== derivedAddress) {
    throw new Error("vault config address does not match its covenant state");
  }
}

function canonicalUint64(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`vault config ${label} is invalid or noncanonical`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error(`vault config ${label} exceeds uint64`);
  return parsed;
}

function deriveVaultAddress(
  agentPublic: string,
  ownerPublic: string,
  maxOutflowSompi: bigint,
  windowSizeDaa: bigint,
  state: VaultState,
  networkId: string
): string {
  const redeem = buildRedeemScript(
    agentPublic,
    ownerPublic,
    maxOutflowSompi,
    windowSizeDaa,
    state
  );
  const scriptPublicKey = payToScriptHashScript(redeem);
  const address = addressFromScriptPublicKey(scriptPublicKey, networkId);
  try {
    if (!address) throw new Error("could not derive vault address");
    return address.toString();
  } finally {
    address?.free();
    scriptPublicKey.free();
  }
}

function encodeVaultConfig(config: VaultConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function privateKeyMatchesXOnly(privateKey: PrivateKey, expectedPublicKey: string): boolean {
  let keypair: Keypair | undefined;
  try {
    keypair = privateKey.toKeypair();
    return String(keypair.xOnlyPublicKey).toLowerCase() === expectedPublicKey.toLowerCase();
  } finally {
    keypair?.free();
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

function isMempoolNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|missing|unknown transaction|mempool.*exist/i.test(message);
}

function requirePreparedTransaction(transactionJson: string, expectedTxid: string): Transaction {
  if (typeof transactionJson !== "string" || transactionJson.length === 0 || transactionJson.length > 2_000_000) {
    throw new Error("prepared vault transaction artifact is empty or oversized");
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.deserializeFromSafeJSON(transactionJson);
  } catch {
    throw new Error("prepared vault transaction artifact is not valid Kaspa safe JSON");
  }
  try {
    const transactionId = String(transaction.finalize());
    if (transactionId !== expectedTxid || !/^[a-f0-9]{64}$/.test(transactionId)) {
      throw new Error("prepared vault transaction identity does not match its signed artifact");
    }
    if (transaction.serializeToSafeJSON() !== transactionJson) {
      throw new Error("prepared vault transaction artifact is not canonical Kaspa safe JSON");
    }
    return transaction;
  } catch (error) {
    transaction.free();
    throw error;
  }
}

function requireBoundPreparedTransaction(
  prepared: PreparedVaultSpend,
  networkId: string
): Transaction {
  assertPreparedVaultSpend(prepared);
  const transaction = requirePreparedTransaction(prepared.transaction, prepared.transactionId);
  try {
    const outputs = transaction.outputs;
    if (outputs.length !== 2) {
      throw new Error("prepared vault staging transaction must have exactly two outputs");
    }
    if (
      BigInt(outputs[0].value) !== prepared.amountSompi ||
      BigInt(outputs[1].value) !== prepared.continuationAmountSompi
    ) {
      throw new Error("prepared vault staging transaction output amounts changed");
    }
    const destinationAddress = addressFromScriptPublicKey(outputs[0].scriptPublicKey, networkId);
    const continuationAddress = addressFromScriptPublicKey(outputs[1].scriptPublicKey, networkId);
    try {
      if (
        destinationAddress?.toString() !== prepared.destination ||
        continuationAddress?.toString() !== prepared.continuationAddress
      ) {
        throw new Error("prepared vault staging transaction output addresses changed");
      }
    } finally {
      destinationAddress?.free();
      continuationAddress?.free();
    }
    if (outputs[0].covenant !== undefined) {
      throw new Error("prepared vault staging destination output must not carry a covenant");
    }
    const binding = outputs[1].covenant;
    if (
      !binding ||
      String(binding.covenantId) !== prepared.covenantId ||
      binding.authorizingInput !== 0
    ) {
      throw new Error("prepared vault continuation covenant binding changed");
    }
    return transaction;
  } catch (error) {
    transaction.free();
    throw error;
  }
}

function requireBoundPreparedDeposit(
  prepared: PreparedVaultDeposit,
  networkId: string
): Transaction {
  if (
    !prepared ||
    prepared.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    !/^[a-f0-9]{64}$/.test(prepared.transactionId) ||
    (prepared.depositKind !== "initial" && prepared.depositKind !== "topup") ||
    prepared.depositedSompi <= 0n ||
    prepared.feeSompi < 0n ||
    prepared.vaultAmountSompi < prepared.depositedSompi ||
    prepared.vaultOutpoint.txid !== prepared.transactionId ||
    prepared.vaultOutpoint.index !== 0 ||
    !/^[a-f0-9]{64}$/.test(prepared.covenantId) ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(prepared.baseConfigDigest) ||
    prepared.sourceInputs.length === 0 ||
    prepared.configUpdate.currentOutpoint?.txid !== prepared.transactionId ||
    prepared.configUpdate.currentOutpoint.index !== 0
  ) {
    throw new Error("prepared vault deposit metadata is invalid");
  }
  const transaction = requirePreparedTransaction(prepared.transaction, prepared.transactionId);
  try {
    const output = transaction.outputs[0];
    if (!output || BigInt(output.value) !== prepared.vaultAmountSompi) {
      throw new Error("prepared vault deposit output amount changed");
    }
    const address = addressFromScriptPublicKey(output.scriptPublicKey, networkId);
    try {
      if (address?.toString() !== prepared.vaultAddress) {
        throw new Error("prepared vault deposit output address changed");
      }
    } finally {
      address?.free();
    }
    const binding = output.covenant;
    if (
      !binding ||
      String(binding.covenantId) !== prepared.covenantId ||
      binding.authorizingInput !== 0
    ) {
      throw new Error("prepared vault deposit covenant binding changed");
    }
    const inputs = transaction.inputs;
    if (inputs.length !== prepared.sourceInputs.length) {
      throw new Error("prepared vault deposit source inputs changed");
    }
    let inputTotal = 0n;
    for (let index = 0; index < inputs.length; index++) {
      const actual = inputs[index];
      const wanted = prepared.sourceInputs[index];
      const utxo = actual.utxo;
      if (
        !utxo ||
        String(actual.previousOutpoint.transactionId) !== wanted.txid ||
        actual.previousOutpoint.index !== wanted.index ||
        BigInt(utxo.amount) !== wanted.amountSompi
      ) {
        throw new Error("prepared vault deposit source input binding changed");
      }
      const source = addressFromScriptPublicKey(utxo.scriptPublicKey, networkId);
      try {
        if (source?.toString() !== wanted.address) {
          throw new Error("prepared vault deposit source address changed");
        }
      } finally {
        source?.free();
      }
      inputTotal += wanted.amountSompi;
    }
    const outputTotal = transaction.outputs.reduce(
      (sum, candidate) => sum + BigInt(candidate.value),
      0n
    );
    if (inputTotal - outputTotal !== prepared.feeSompi) {
      throw new Error("prepared vault deposit fee changed");
    }
    if (prepared.depositKind === "initial") {
      if (
        prepared.vaultAmountSompi !== prepared.depositedSompi ||
        prepared.configUpdate.covenantId !== prepared.covenantId
      ) {
        throw new Error("prepared initial vault deposit config changed");
      }
    } else if (
      prepared.configUpdate.address !== prepared.vaultAddress ||
      typeof prepared.configUpdate.windowStartDaa !== "string" ||
      typeof prepared.configUpdate.spentInWindowSompi !== "string"
    ) {
      throw new Error("prepared vault top-up continuation config changed");
    }
    return transaction;
  } catch (error) {
    transaction.free();
    throw error;
  }
}

function requirePreparedConfigUpdate(
  candidate: Partial<VaultConfig>,
  transactionId: string
): PreparedVaultSpend["configUpdate"] {
  if (
    typeof candidate.windowStartDaa !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(candidate.windowStartDaa) ||
    typeof candidate.spentInWindowSompi !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(candidate.spentInWindowSompi) ||
    typeof candidate.address !== "string" ||
    candidate.address.length === 0 ||
    candidate.currentOutpoint?.txid !== transactionId ||
    candidate.currentOutpoint.index !== 1
  ) {
    throw new Error("prepared vault send returned an invalid continuation state update");
  }
  return {
    windowStartDaa: candidate.windowStartDaa,
    spentInWindowSompi: candidate.spentInWindowSompi,
    address: candidate.address,
    currentOutpoint: { txid: transactionId, index: 1 },
  };
}

function assertPreparedVaultSpend(prepared: PreparedVaultSpend): void {
  if (
    !prepared ||
    prepared.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    !/^[a-f0-9]{64}$/.test(prepared.transactionId) ||
    prepared.destinationOutpoint.txid !== prepared.transactionId ||
    prepared.destinationOutpoint.index !== 0 ||
    prepared.continuationOutpoint.txid !== prepared.transactionId ||
    prepared.continuationOutpoint.index !== 1 ||
    prepared.amountSompi <= 0n ||
    prepared.feeSompi < 0n ||
    prepared.continuationAmountSompi <= 0n ||
    !/^[a-f0-9]{64}$/.test(prepared.covenantId) ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(prepared.baseConfigDigest)
  ) {
    throw new Error("prepared vault spend metadata is invalid");
  }
  requirePreparedConfigUpdate(prepared.configUpdate, prepared.transactionId);
}

function vaultConfigDigest(config: VaultConfig): string {
  const canonical = JSON.stringify({
    template: config.template,
    agentPublic: config.agentPublic,
    ownerPublic: config.ownerPublic,
    maxOutflowSompi: config.maxOutflowSompi,
    windowSizeDaa: config.windowSizeDaa,
    windowStartDaa: config.windowStartDaa,
    spentInWindowSompi: config.spentInWindowSompi,
    address: config.address,
    covenantId: config.covenantId ?? null,
    currentOutpoint: config.currentOutpoint
      ? { txid: config.currentOutpoint.txid, index: config.currentOutpoint.index }
      : null,
  });
  return `sha256:${createHash("sha256").update("sompi:vault-config:v1\0").update(canonical).digest("base64url")}`;
}

function vaultConfigMatchesUpdate(
  config: VaultConfig,
  update: PreparedVaultSpend["configUpdate"]
): boolean {
  return (
    config.windowStartDaa === update.windowStartDaa &&
    config.spentInWindowSompi === update.spentInWindowSompi &&
    config.address === update.address &&
    config.currentOutpoint?.txid === update.currentOutpoint.txid &&
    config.currentOutpoint.index === update.currentOutpoint.index
  );
}

function vaultConfigMatchesDepositUpdate(
  current: VaultConfig,
  update: PreparedVaultDeposit["configUpdate"]
): boolean {
  for (const [key, value] of Object.entries(update) as Array<
    [keyof VaultConfig, VaultConfig[keyof VaultConfig]]
  >) {
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

function scriptPublicKeyMatchesAddress(
  scriptPublicKey: unknown,
  expectedAddress: string,
  networkId: string
): boolean {
  try {
    const address = addressFromScriptPublicKey(scriptPublicKey as any, networkId);
    try {
      return address?.toString() === expectedAddress;
    } finally {
      address?.free();
    }
  } catch {
    return false;
  }
}

export function generateOwnerKey(): { privateKey: string; publicKey: string } {
  let keypair: Keypair | undefined;
  try {
    keypair = Keypair.random();
    return { privateKey: keypair.privateKey, publicKey: String(keypair.xOnlyPublicKey) };
  } finally {
    keypair?.free();
  }
}

export { bytesToHex };
