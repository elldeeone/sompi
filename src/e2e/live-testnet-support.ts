import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import type {
  ExactTransactionVerification,
  ExactTransactionVerificationRequest,
  ExactTransactionVerifier,
} from "@kaspa-x402/server";

import {
  KaspaTestnet10AddressCodec,
  SOMPI_EXACT_FEE_POLICY,
} from "../adapters/kaspa-x402/index.js";
import {
  Keypair,
  PrivateKey,
  ScriptPublicKey,
  Transaction,
  addressFromScriptPublicKey,
} from "../kaspa-wasm.js";
import { PolicyEngine } from "../policy.js";
import { PurchaseJournal } from "../purchase/journal.js";
import {
  TreasuryOperationModule,
  type TreasuryOperationRequest,
  type TreasuryOperationView,
} from "../treasury/operations.js";
import {
  VaultDepositTreasuryOperationAdapter,
  VaultSendTreasuryOperationAdapter,
  WalletTreasuryOperationAdapter,
} from "../treasury/operation-adapters.js";
import { VaultManager, generateOwnerKey } from "../vault.js";
import { KaspaWallet } from "../wallet.js";

export const LIVE_NETWORK = "kaspa:testnet-10" as const;
export const LIVE_SDK_NETWORK = "testnet-10" as const;
export const LIVE_BOOTSTRAP_AMOUNT_ATOMIC = "500000000" as const;
export const LIVE_BORROW_AMOUNT_ATOMIC = "100000000" as const;
export const LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC = "300000000" as const;
export const LIVE_PRICE_ATOMIC = "20000000" as const;
export const LIVE_ADDITIVE_THRESHOLD_ATOMIC = "10000000" as const;
export const LIVE_ADDITIONAL_COST_CEILING_ATOMIC = "30000000" as const;
export const LIVE_TREASURY_FEE_CEILING_ATOMIC = "10000000" as const;

const HASH32 = /^[a-f0-9]{64}$/;
const HEX = /^(?:[a-f0-9]{2})+$/;
const ADDRESS = /^kaspatest:[a-z0-9]+$/;
const RUN_ID = /^[a-f0-9]{24}$/;
const OPERATION_TIMEOUT_MS = 8 * 60_000;
const OBSERVATION_TIMEOUT_MS = 6 * 60_000;

export interface LiveProofConfig {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly sourceWalletDirectory: string;
  readonly purchaseEntropyHex: string;
  readonly reservationExpiresAt: string;
  readonly authorityMacKeyId: string;
  readonly wallets: {
    readonly treasuryDirectory: string;
    readonly treasuryAddress: string;
    readonly merchantDirectory: string;
    readonly merchantAddress: string;
    readonly observerDirectory: string;
    readonly observerAddress: string;
  };
  readonly vault: {
    readonly dataDirectory: string;
    readonly address: string;
    readonly ownerPublicKey: string;
    readonly ownerKeyPath: string;
  };
  readonly borrow: {
    readonly address: string;
    readonly ownerPublicKey: string;
    readonly ownerKeyPath: string;
    readonly redeemScript: string;
    readonly scriptPublicKey: string;
    readonly amountAtomic: typeof LIVE_BORROW_AMOUNT_ATOMIC;
    readonly additiveThresholdAtomic: typeof LIVE_ADDITIVE_THRESHOLD_ATOMIC;
  };
  readonly operationKeys: {
    readonly bootstrap: string;
    readonly borrowInventory: string;
    readonly vaultDeposit: string;
  };
}

export interface LiveChainMilestone {
  readonly transactionId: string;
  readonly outpoint: string;
  readonly address: string;
  readonly amountAtomic: string;
  readonly blockDaaScore: string;
  readonly virtualDaaScore: string;
  readonly finality: "accepted" | "confirmed";
}

export interface LiveProofProgress {
  readonly version: 1;
  readonly runId: string;
  readonly updatedAt: string;
  readonly bootstrap?: LiveChainMilestone;
  readonly borrowInventory?: LiveChainMilestone;
  readonly vaultDeposit?: LiveChainMilestone & {
    readonly covenantId: string;
  };
}

export interface LiveRecoveryRecord {
  readonly version: 1;
  readonly runId: string;
  readonly preparedBeforeFirstSpendAt: string;
  readonly updatedAt: string;
  readonly network: typeof LIVE_NETWORK;
  readonly sourceWalletDirectory: string;
  readonly proofRoot: string;
  readonly sensitivePaths: readonly string[];
  readonly journalPaths: readonly string[];
  readonly operationKeys: LiveProofConfig["operationKeys"];
  readonly intendedAmountsAtomic: {
    readonly bootstrap: typeof LIVE_BOOTSTRAP_AMOUNT_ATOMIC;
    readonly borrowInventory: typeof LIVE_BORROW_AMOUNT_ATOMIC;
    readonly vaultDeposit: typeof LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC;
    readonly purchasePrice: typeof LIVE_PRICE_ATOMIC;
    readonly additiveThreshold: typeof LIVE_ADDITIVE_THRESHOLD_ATOMIC;
  };
  readonly milestones: Readonly<Partial<{
    bootstrap: LiveChainMilestone;
    borrowInventory: LiveChainMilestone;
    vaultDeposit: LiveChainMilestone & { readonly covenantId: string };
  }>>;
}

export interface LiveProofLayout {
  readonly root: string;
  readonly configPath: string;
  readonly progressPath: string;
  readonly recoveryPath: string;
  readonly bootstrapPolicyPath: string;
  readonly bootstrapJournalPath: string;
  readonly purchasePolicyPath: string;
  readonly purchaseJournalPath: string;
  readonly merchantVerifierStatePath: string;
  readonly paidReplayCapsulePath: string;
  readonly authorityRoot: string;
  readonly stagingKeyDirectory: string;
}

export interface InitializedLiveProof {
  readonly layout: LiveProofLayout;
  readonly config: LiveProofConfig;
  readonly treasuryWallet: KaspaWallet;
  readonly merchantWallet: KaspaWallet;
  readonly observerWallet: KaspaWallet;
  readonly vault: VaultManager;
}

export function liveProofLayout(root: string): LiveProofLayout {
  const resolved = path.resolve(root);
  return Object.freeze({
    root: resolved,
    configPath: path.join(resolved, "run-config.json"),
    progressPath: path.join(resolved, "progress.json"),
    recoveryPath: path.join(resolved, "recovery.json"),
    bootstrapPolicyPath: path.join(resolved, "bootstrap", "policy.json"),
    bootstrapJournalPath: path.join(resolved, "bootstrap", "journal.sqlite"),
    purchasePolicyPath: path.join(resolved, "purchase", "policy.json"),
    purchaseJournalPath: path.join(resolved, "purchase", "journal.sqlite"),
    merchantVerifierStatePath: path.join(resolved, "merchant", "exact-verifier-state.json"),
    paidReplayCapsulePath: path.join(resolved, "merchant", "paid-replay-capsule.json"),
    authorityRoot: path.join(resolved, "authority"),
    stagingKeyDirectory: path.join(resolved, "staging-keys"),
  });
}

export function initializeLiveProof(
  root: string,
  sourceWalletDirectory: string
): InitializedLiveProof {
  if (process.env.SOMPI_PRIVATE_KEY) {
    throw new Error(
      "SOMPI_PRIVATE_KEY must be unset for the live proof so every disposable wallet is file-bound and distinct"
    );
  }
  const layout = liveProofLayout(root);
  secureDirectory(layout.root);
  for (const directory of [
    path.dirname(layout.bootstrapJournalPath),
    path.dirname(layout.purchaseJournalPath),
    path.dirname(layout.merchantVerifierStatePath),
    layout.authorityRoot,
    layout.stagingKeyDirectory,
    path.join(layout.root, "secrets"),
    path.join(layout.root, "wallets"),
    path.join(layout.root, "vault-state"),
  ]) {
    secureDirectory(directory);
  }

  const treasuryDirectory = path.join(layout.root, "wallets", "treasury");
  const merchantDirectory = path.join(layout.root, "wallets", "merchant");
  const observerDirectory = path.join(layout.root, "wallets", "observer");
  const vaultDataDirectory = path.join(layout.root, "vault-state");
  const treasuryWallet = new KaspaWallet({
    networkId: LIVE_SDK_NETWORK,
    dataDir: treasuryDirectory,
    ...(process.env.SOMPI_NODE_URL ? { nodeUrl: process.env.SOMPI_NODE_URL } : {}),
  });
  const merchantWallet = new KaspaWallet({
    networkId: LIVE_SDK_NETWORK,
    dataDir: merchantDirectory,
    ...(process.env.SOMPI_NODE_URL ? { nodeUrl: process.env.SOMPI_NODE_URL } : {}),
  });
  const observerWallet = new KaspaWallet({
    networkId: LIVE_SDK_NETWORK,
    dataDir: observerDirectory,
    ...(process.env.SOMPI_NODE_URL ? { nodeUrl: process.env.SOMPI_NODE_URL } : {}),
  });

  const vaultOwnerKeyPath = path.join(layout.root, "secrets", "vault-owner.key");
  const borrowOwnerKeyPath = path.join(layout.root, "secrets", "borrow-owner.key");
  const runIdPath = path.join(layout.root, "secrets", "run-id");
  const entropyPath = path.join(layout.root, "secrets", "purchase-entropy");
  const runId = loadOrCreateHex(runIdPath, 12);
  const purchaseEntropyHex = loadOrCreateHex(entropyPath, 16);
  const vaultOwner = loadOrCreateOwnerKey(vaultOwnerKeyPath);
  const borrowOwner = loadOrCreateOwnerKey(borrowOwnerKeyPath);

  const vault = new VaultManager(vaultDataDirectory, LIVE_SDK_NETWORK);
  if (!vault.configured) {
    vault.create(100_000_000n, vaultOwner.publicKey, 36_000n);
  }
  const vaultConfig = vault.config();
  if (vaultConfig.ownerPublic !== vaultOwner.publicKey) {
    throw new Error("live proof vault owner key does not match its durable vault configuration");
  }

  const borrowTemplate = {
    ownerPublicKey: borrowOwner.publicKey,
    amount: LIVE_BORROW_AMOUNT_ATOMIC,
  } as const;
  const borrowRedeemScript = buildKip10AdditiveRedeemScript(borrowTemplate).toLowerCase();
  const borrowSpk = kip10AdditiveScriptPublicKey(borrowTemplate);
  const borrowScriptPublicKey = serializedScriptPublicKey(borrowSpk).toLowerCase();
  const addressCodec = new KaspaTestnet10AddressCodec();
  const borrowAddress = addressCodec.encodeScriptAddress({
    network: LIVE_NETWORK,
    scriptPublicKey: borrowSpk,
    serializedScriptPublicKey: borrowScriptPublicKey,
  });

  const created = Object.freeze({
    version: 1 as const,
    runId,
    createdAt: new Date().toISOString(),
    sourceWalletDirectory: path.resolve(sourceWalletDirectory),
    purchaseEntropyHex,
    reservationExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    authorityMacKeyId: `live-proof-${runId}`,
    wallets: Object.freeze({
      treasuryDirectory,
      treasuryAddress: treasuryWallet.address,
      merchantDirectory,
      merchantAddress: merchantWallet.address,
      observerDirectory,
      observerAddress: observerWallet.address,
    }),
    vault: Object.freeze({
      dataDirectory: vaultDataDirectory,
      address: vaultConfig.address,
      ownerPublicKey: vaultOwner.publicKey,
      ownerKeyPath: vaultOwnerKeyPath,
    }),
    borrow: Object.freeze({
      address: borrowAddress,
      ownerPublicKey: borrowOwner.publicKey,
      ownerKeyPath: borrowOwnerKeyPath,
      redeemScript: borrowRedeemScript,
      scriptPublicKey: borrowScriptPublicKey,
      amountAtomic: LIVE_BORROW_AMOUNT_ATOMIC,
      additiveThresholdAtomic: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
    }),
    operationKeys: Object.freeze({
      bootstrap: `live:${runId}:bootstrap`,
      borrowInventory: `live:${runId}:borrow-inventory`,
      vaultDeposit: `live:${runId}:vault-deposit`,
    }),
  }) satisfies LiveProofConfig;

  const config = fs.existsSync(layout.configPath)
    ? readLiveProofConfig(layout.configPath)
    : created;
  assertSameConfig(config, created);
  if (!fs.existsSync(layout.configPath)) writeAtomicJson(layout.configPath, config);

  const progress = readProgress(layout.progressPath, runId);
  writeRecoveryRecord(layout, config, progress);
  assertPrivateFile(layout.recoveryPath);
  return Object.freeze({ layout, config, treasuryWallet, merchantWallet, observerWallet, vault });
}

export async function bootstrapLiveProof(input: {
  readonly initialized: InitializedLiveProof;
  readonly onProgress?: (message: string) => void;
}): Promise<{
  readonly journal: PurchaseJournal;
  readonly progress: LiveProofProgress;
}> {
  const { initialized } = input;
  const { layout, config, treasuryWallet, vault } = initialized;
  writePolicyOnce(layout.bootstrapPolicyPath, {
    maxSompiPerTx: "600000000",
    maxSompiPerHour: "700000000",
    allowlist: [config.wallets.treasuryAddress],
    requireApprovalAboveSompi: "0",
  });
  writePolicyOnce(layout.purchasePolicyPath, {
    maxSompiPerTx: "500000000",
    maxSompiPerHour: "1000000000",
    allowlist: [config.borrow.address, config.vault.address],
    requireApprovalAboveSompi: "0",
  });

  const bootstrapJournal = new PurchaseJournal(layout.bootstrapJournalPath);
  let purchaseJournal: PurchaseJournal | undefined;
  const sourceWallet = new KaspaWallet({
    networkId: LIVE_SDK_NETWORK,
    dataDir: config.sourceWalletDirectory,
    ...(process.env.SOMPI_NODE_URL ? { nodeUrl: process.env.SOMPI_NODE_URL } : {}),
  });
  try {
    if (sourceWallet.address === treasuryWallet.address) {
      throw new Error("bootstrap source and disposable Treasury wallet unexpectedly share an address");
    }
    const sourceInfo = await sourceWallet.serverInfo();
    if (!sourceInfo.isSynced || !sourceInfo.hasUtxoIndex) {
      throw new Error("bootstrap source RPC is unsynced or lacks the UTXO index");
    }
    const sourceBalance = await sourceWallet.balanceSompi();
    if (sourceBalance < BigInt(LIVE_BOOTSTRAP_AMOUNT_ATOMIC) + BigInt(LIVE_TREASURY_FEE_CEILING_ATOMIC)) {
      throw new Error("bootstrap source does not hold enough Testnet-10 funds");
    }

    const sourceAdapterVault = new VaultManager(
      path.join(layout.root, "bootstrap", "unused-vault-adapter"),
      LIVE_SDK_NETWORK
    );
    const bootstrapModule = treasuryModule({
      journal: bootstrapJournal,
      policyPath: layout.bootstrapPolicyPath,
      wallet: sourceWallet,
      vault: sourceAdapterVault,
    });
    input.onProgress?.("recovering durable bootstrap operation");
    const bootstrapView = await driveTreasuryOperation(
      bootstrapModule,
      {
        operationKey: config.operationKeys.bootstrap,
        kind: "wallet_send",
        destination: config.wallets.treasuryAddress,
        amountAtomic: LIVE_BOOTSTRAP_AMOUNT_ATOMIC,
      },
      input.onProgress
    );
    let progress = readProgress(layout.progressPath, config.runId);
    if (!progress.bootstrap) {
      const detail = bootstrapJournal.readObservedTreasuryOperationDetail(
        config.operationKeys.bootstrap
      );
      const outpoint = requireOutpoint(detail.destinationOutpoint, "bootstrap destination outpoint");
      const milestone = await observeAddressOutpoint({
        wallet: treasuryWallet,
        address: config.wallets.treasuryAddress,
        outpoint,
        amountAtomic: LIVE_BOOTSTRAP_AMOUNT_ATOMIC,
      });
      if (bootstrapView.transactionId !== milestone.transactionId) {
        throw new Error("bootstrap operation and observed funding transaction differ");
      }
      progress = updateProgress(layout, progress, { bootstrap: milestone });
      writeRecoveryRecord(layout, config, progress);
    }

    purchaseJournal = new PurchaseJournal(layout.purchaseJournalPath);
    const mainModule = treasuryModule({
      journal: purchaseJournal,
      policyPath: layout.purchasePolicyPath,
      wallet: treasuryWallet,
      vault,
    });
    input.onProgress?.("recovering durable KIP-10 inventory operation");
    const borrowView = await driveTreasuryOperation(
      mainModule,
      {
        operationKey: config.operationKeys.borrowInventory,
        kind: "wallet_send",
        destination: config.borrow.address,
        amountAtomic: LIVE_BORROW_AMOUNT_ATOMIC,
      },
      input.onProgress
    );
    progress = readProgress(layout.progressPath, config.runId);
    if (!progress.borrowInventory) {
      const detail = purchaseJournal.readObservedTreasuryOperationDetail(
        config.operationKeys.borrowInventory
      );
      const outpoint = requireOutpoint(detail.destinationOutpoint, "borrow inventory outpoint");
      const milestone = await observeAddressOutpoint({
        wallet: treasuryWallet,
        address: config.borrow.address,
        outpoint,
        amountAtomic: LIVE_BORROW_AMOUNT_ATOMIC,
      });
      if (borrowView.transactionId !== milestone.transactionId) {
        throw new Error("borrow inventory operation and observed transaction differ");
      }
      progress = updateProgress(layout, progress, { borrowInventory: milestone });
      writeRecoveryRecord(layout, config, progress);
    }

    input.onProgress?.("recovering durable fresh-vault deposit operation");
    const depositView = await driveTreasuryOperation(
      mainModule,
      {
        operationKey: config.operationKeys.vaultDeposit,
        kind: "vault_deposit",
        destination: config.vault.address,
        amountAtomic: LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC,
      },
      input.onProgress
    );
    progress = readProgress(layout.progressPath, config.runId);
    if (!progress.vaultDeposit) {
      const detail = purchaseJournal.readObservedTreasuryOperationDetail(
        config.operationKeys.vaultDeposit
      );
      const outpoint = requireOutpoint(detail.vaultOutpoint, "vault deposit outpoint");
      const milestone = await observeAddressOutpoint({
        wallet: treasuryWallet,
        address: config.vault.address,
        outpoint,
        amountAtomic: requireAtomic(detail.vaultAmountAtomic, "vault amount"),
      });
      if (depositView.transactionId !== milestone.transactionId) {
        throw new Error("vault deposit operation and observed transaction differ");
      }
      progress = updateProgress(layout, progress, {
        vaultDeposit: Object.freeze({
          ...milestone,
          covenantId: requireHash(detail.covenantId, "vault covenant ID"),
        }),
      });
      writeRecoveryRecord(layout, config, progress);
    }
    purchaseJournal.integrityCheck();
    bootstrapJournal.integrityCheck();
    return Object.freeze({ journal: purchaseJournal, progress });
  } catch (error) {
    purchaseJournal?.close();
    throw error;
  } finally {
    bootstrapJournal.close();
    await sourceWallet.disconnect();
  }
}

export class LiveMerchantExactVerifier implements ExactTransactionVerifier {
  private readonly codec = new KaspaTestnet10AddressCodec();

  constructor(
    private readonly wallet: KaspaWallet,
    private readonly statePath: string,
    private readonly now: () => number = Date.now
  ) {
    if (wallet.networkId !== LIVE_SDK_NETWORK) {
      throw new Error("live Merchant verifier requires Testnet-10");
    }
  }

  async verifyExactPayment(
    request: ExactTransactionVerificationRequest
  ): Promise<ExactTransactionVerification> {
    const parsed = this.validate(request);
    try {
      const existing = readMerchantVerifierState(this.statePath);
      const transactionDigest = sha256Hex(request.transaction);
      if (
        existing &&
        (existing.transactionId !== parsed.transactionId ||
          existing.transactionDigest !== transactionDigest)
      ) {
        throw new Error("Merchant verifier state is bound to a different exact transaction");
      }
      let observation = await findRpcOutpoint(
        this.wallet,
        request.payTo,
        parsed.transactionId,
        request.paymentOutputIndex
      );
      if (!observation) {
        await this.assertInputExists(
          request.reservation!.borrowOutpoint.txid,
          request.reservation!.borrowOutpoint.index,
          request.reservation!.borrowAmount,
          request.reservation!.borrowScriptPublicKey,
          parsed.borrowAddress
        );
        await this.assertInputExists(
          parsed.stagingOutpoint.transactionId,
          parsed.stagingOutpoint.index,
          parsed.stagingAmountAtomic,
          parsed.stagingScriptPublicKey,
          parsed.payerAddress
        );
      }
      if (!existing) {
        writeAtomicJson(this.statePath, {
          version: 1,
          transactionId: parsed.transactionId,
          transactionDigest,
          paymentOutpoint: `${parsed.transactionId}:${request.paymentOutputIndex}`,
          continuationOutpoint: `${parsed.transactionId}:0`,
          state: "planned",
          plannedAt: new Date(this.now()).toISOString(),
        } satisfies MerchantVerifierState);
      }

      if (!observation) {
        const rpc = await this.wallet.client();
        try {
          const submitted = await rpc.submitTransaction({
            transaction: parsed.transaction,
            allowOrphan: false,
          });
          if (String(submitted.transactionId).toLowerCase() !== parsed.transactionId) {
            throw new Error("Merchant RPC returned a different exact transaction identity");
          }
        } catch (error) {
          if (!isAlreadySubmitted(error)) throw error;
        }
        observation = await waitForRpcOutpoint(
          this.wallet,
          request.payTo,
          parsed.transactionId,
          request.paymentOutputIndex,
          OBSERVATION_TIMEOUT_MS
        );
      }
      if (
        observation.amountAtomic !== request.amount ||
        observation.scriptPublicKey !== request.payToScriptPublicKey.toLowerCase()
      ) {
        throw new Error("Merchant live RPC observation changed the exact payment output");
      }
      const info = await this.wallet.serverInfo();
      const state = Object.freeze({
        version: 1 as const,
        transactionId: parsed.transactionId,
        transactionDigest,
        paymentOutpoint: `${parsed.transactionId}:${request.paymentOutputIndex}`,
        continuationOutpoint: `${parsed.transactionId}:0`,
        state: "observed" as const,
        plannedAt:
          existing?.plannedAt ??
          readMerchantVerifierState(this.statePath)?.plannedAt ??
          new Date(this.now()).toISOString(),
        observedAt: new Date(this.now()).toISOString(),
        blockDaaScore: observation.blockDaaScore,
        virtualDaaScore: String(info.virtualDaaScore),
        finality: "accepted" as const,
      }) satisfies MerchantVerifierState;
      writeAtomicJson(this.statePath, state);
      return Object.freeze({
        transactionId: parsed.transactionId,
        paymentOutput: Object.freeze({
          amount: request.amount,
          scriptPublicKey: request.payToScriptPublicKey.toLowerCase(),
          address: request.payTo,
        }),
        finality: "accepted" as const,
        payerAddress: parsed.payerAddress,
      });
    } finally {
      parsed.transaction.free();
    }
  }

  state(): MerchantVerifierState {
    const state = readMerchantVerifierState(this.statePath);
    if (!state || state.state !== "observed") {
      throw new Error("Merchant exact verifier has no durable observed transaction");
    }
    return state;
  }

  private validate(request: ExactTransactionVerificationRequest): ParsedExactTransaction {
    if (
      request.network !== LIVE_NETWORK ||
      request.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
      request.paymentOutputIndex !== 1 ||
      request.requiredFinality !== "accepted" ||
      !ADDRESS.test(request.payTo) ||
      !HASH32.test(String(request.requestHash ?? "").toLowerCase())
    ) {
      throw new Error("Merchant exact verifier received an unsupported or unbound profile");
    }
    const reservation = request.reservation;
    if (
      !reservation ||
      reservation.templateId !== "kaspa-x402-kip10-additive-v1" ||
      reservation.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
      reservation.paymentOutputIndex !== 1 ||
      !HASH32.test(reservation.reservationId.toLowerCase()) ||
      !HASH32.test(reservation.borrowOutpoint.txid.toLowerCase()) ||
      !Number.isSafeInteger(reservation.borrowOutpoint.index) ||
      reservation.borrowOutpoint.index < 0 ||
      reservation.borrowOutpoint.index > 0xffff_ffff ||
      reservation.borrowAmount !== LIVE_BORROW_AMOUNT_ATOMIC ||
      reservation.additiveThresholdSompi !== LIVE_ADDITIVE_THRESHOLD_ATOMIC
    ) {
      throw new Error("Merchant exact verifier received an invalid KIP-10 reservation");
    }
    const recomputedRedeem = buildKip10AdditiveRedeemScript({
      ownerPublicKey: ownerPublicKeyFromRedeemScript(reservation.borrowRedeemScript),
      amount: reservation.borrowAmount,
    }).toLowerCase();
    const recomputedSpk = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({
        ownerPublicKey: ownerPublicKeyFromRedeemScript(reservation.borrowRedeemScript),
        amount: reservation.borrowAmount,
      })
    ).toLowerCase();
    if (
      recomputedRedeem !== reservation.borrowRedeemScript.toLowerCase() ||
      recomputedSpk !== reservation.borrowScriptPublicKey.toLowerCase()
    ) {
      throw new Error("Merchant exact verifier rejected a changed KIP-10 covenant");
    }

    let transaction: Transaction;
    try {
      transaction = Transaction.deserializeFromSafeJSON(request.transaction);
    } catch {
      throw new Error("Merchant exact verifier could not decode Kaspa safe JSON");
    }
    try {
      const transactionId = String(transaction.finalize()).toLowerCase();
      const document = JSON.parse(request.transaction) as Record<string, unknown>;
      if (
        !HASH32.test(transactionId) ||
        transaction.serializeToSafeJSON() !== request.transaction ||
        document.id !== transactionId ||
        document.version !== 1 ||
        document.lockTime !== "0" ||
        document.subnetworkId !== "00".repeat(20) ||
        document.gas !== "0" ||
        document.payload !== ""
      ) {
        throw new Error("Merchant exact verifier rejected non-canonical transaction JSON");
      }
      const inputs = transaction.inputs;
      const outputs = transaction.outputs;
      if (inputs.length !== 2 || (outputs.length !== 2 && outputs.length !== 3)) {
        throw new Error("Merchant exact transaction input/output shape changed");
      }
      const borrowInput = inputs[0];
      const stagingInput = inputs[1];
      if (
        String(borrowInput.previousOutpoint.transactionId).toLowerCase() !==
          reservation.borrowOutpoint.txid.toLowerCase() ||
        borrowInput.previousOutpoint.index !== reservation.borrowOutpoint.index ||
        BigInt(borrowInput.utxo?.amount ?? -1n).toString() !== reservation.borrowAmount ||
        sdkSerializedScript(borrowInput.utxo?.scriptPublicKey) !==
          reservation.borrowScriptPublicKey.toLowerCase() ||
        (String(stagingInput.previousOutpoint.transactionId).toLowerCase() ===
          reservation.borrowOutpoint.txid.toLowerCase() &&
          stagingInput.previousOutpoint.index === reservation.borrowOutpoint.index)
      ) {
        throw new Error("Merchant exact transaction changed its borrow input");
      }
      const stagingUtxo = stagingInput.utxo;
      if (!stagingUtxo) throw new Error("Merchant exact transaction omitted staging UTXO facts");
      const stagingScriptPublicKey = sdkSerializedScript(stagingUtxo.scriptPublicKey);
      const payerAddress = addressForSerializedScript(stagingScriptPublicKey);
      const stagingAmount = BigInt(stagingUtxo.amount);
      const merchantScript = this.codec.scriptPublicKeyForAddress(request.payTo, LIVE_NETWORK).toLowerCase();
      if (
        BigInt(outputs[0].value) !==
          BigInt(reservation.borrowAmount) + BigInt(reservation.additiveThresholdSompi) ||
        sdkSerializedScript(outputs[0].scriptPublicKey) !== reservation.borrowScriptPublicKey.toLowerCase() ||
        BigInt(outputs[1].value).toString() !== request.amount ||
        sdkSerializedScript(outputs[1].scriptPublicKey) !== merchantScript ||
        request.payToScriptPublicKey.toLowerCase() !== merchantScript
      ) {
        throw new Error("Merchant exact transaction changed its continuation or payment output");
      }
      let outputTotal = BigInt(outputs[0].value) + BigInt(outputs[1].value);
      if (outputs.length === 3) {
        if (sdkSerializedScript(outputs[2].scriptPublicKey) !== stagingScriptPublicKey) {
          throw new Error("Merchant exact transaction changed its staging change script");
        }
        outputTotal += BigInt(outputs[2].value);
      }
      const inputTotal = BigInt(reservation.borrowAmount) + stagingAmount;
      if (inputTotal - outputTotal !== BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi)) {
        throw new Error("Merchant exact transaction changed the pinned exact fee");
      }
      const expectedChange =
        stagingAmount -
        BigInt(request.amount) -
        BigInt(reservation.additiveThresholdSompi) -
        BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi);
      if (
        expectedChange < 0n ||
        (expectedChange === 0n) !== (outputs.length === 2) ||
        (expectedChange > 0n && BigInt(outputs[2].value) !== expectedChange)
      ) {
        throw new Error("Merchant exact transaction does not conserve staging value");
      }
      return Object.freeze({
        transaction,
        transactionId,
        payerAddress,
        stagingAmountAtomic: stagingAmount.toString(),
        stagingScriptPublicKey,
        stagingOutpoint: Object.freeze({
          transactionId: String(stagingInput.previousOutpoint.transactionId).toLowerCase(),
          index: stagingInput.previousOutpoint.index,
        }),
        borrowAddress: addressForSerializedScript(reservation.borrowScriptPublicKey),
      });
    } catch (error) {
      transaction.free();
      throw error;
    }
  }

  private async assertInputExists(
    transactionId: string,
    index: number,
    amountAtomic: string,
    scriptPublicKey: string,
    address: string
  ): Promise<void> {
    const observed = await findRpcOutpoint(this.wallet, address, transactionId, index);
    if (
      !observed ||
      observed.amountAtomic !== amountAtomic ||
      observed.scriptPublicKey !== scriptPublicKey.toLowerCase()
    ) {
      throw new Error("Merchant verifier could not independently bind a live exact input");
    }
  }
}

export interface MerchantVerifierState {
  readonly version: 1;
  readonly transactionId: string;
  readonly transactionDigest: string;
  readonly paymentOutpoint: string;
  readonly continuationOutpoint: string;
  readonly state: "planned" | "observed";
  readonly plannedAt: string;
  readonly observedAt?: string;
  readonly blockDaaScore?: string;
  readonly virtualDaaScore?: string;
  readonly finality?: "accepted";
}

interface ParsedExactTransaction {
  readonly transaction: Transaction;
  readonly transactionId: string;
  readonly payerAddress: string;
  readonly stagingAmountAtomic: string;
  readonly stagingScriptPublicKey: string;
  readonly stagingOutpoint: { readonly transactionId: string; readonly index: number };
  readonly borrowAddress: string;
}

export function readProgress(filename: string, runId: string): LiveProofProgress {
  if (!fs.existsSync(filename)) {
    const recoveryPath = path.join(path.dirname(filename), "recovery.json");
    if (fs.existsSync(recoveryPath)) {
      assertPrivateFile(recoveryPath);
      const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8")) as LiveRecoveryRecord;
      if (recovery.version !== 1 || recovery.runId !== runId) {
        throw new Error("live proof recovery record belongs to a different run");
      }
      return Object.freeze({
        version: 1,
        runId,
        updatedAt: recovery.updatedAt,
        ...(recovery.milestones.bootstrap
          ? { bootstrap: recovery.milestones.bootstrap }
          : {}),
        ...(recovery.milestones.borrowInventory
          ? { borrowInventory: recovery.milestones.borrowInventory }
          : {}),
        ...(recovery.milestones.vaultDeposit
          ? { vaultDeposit: recovery.milestones.vaultDeposit }
          : {}),
      });
    }
    return Object.freeze({
      version: 1,
      runId,
      updatedAt: new Date(0).toISOString(),
    });
  }
  assertPrivateFile(filename);
  const value = JSON.parse(fs.readFileSync(filename, "utf8")) as LiveProofProgress;
  if (value.version !== 1 || value.runId !== runId) {
    throw new Error("live proof progress belongs to a different run");
  }
  return value;
}

export function writeAtomicJson(filename: string, value: unknown): void {
  secureDirectory(path.dirname(path.resolve(filename)));
  const target = path.resolve(filename);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
  fs.chmodSync(target, 0o600);
}

export function secureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function assertPrivateFile(filename: string): void {
  const mode = fs.statSync(filename).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${filename} must be mode 0600, found ${mode.toString(8)}`);
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function reservationId(config: LiveProofConfig, borrowOutpoint: string): string {
  return sha256Hex(`sompi-live-borrow-reservation:${config.runId}:${borrowOutpoint}`);
}

export async function observeAddressOutpoint(input: {
  readonly wallet: KaspaWallet;
  readonly address: string;
  readonly outpoint: string;
  readonly amountAtomic: string;
}): Promise<LiveChainMilestone> {
  const parsed = parseOutpoint(input.outpoint);
  const observed = await waitForRpcOutpoint(
    input.wallet,
    input.address,
    parsed.transactionId,
    parsed.index,
    OBSERVATION_TIMEOUT_MS
  );
  if (observed.amountAtomic !== input.amountAtomic) {
    throw new Error("live outpoint amount differs from its durable operation");
  }
  const info = await input.wallet.serverInfo();
  const virtualDaa = BigInt(info.virtualDaaScore);
  const blockDaa = BigInt(observed.blockDaaScore);
  return Object.freeze({
    transactionId: parsed.transactionId,
    outpoint: `${parsed.transactionId}:${parsed.index}`,
    address: input.address,
    amountAtomic: input.amountAtomic,
    blockDaaScore: blockDaa.toString(),
    virtualDaaScore: virtualDaa.toString(),
    finality: virtualDaa - blockDaa >= 10n ? "confirmed" : "accepted",
  });
}

function treasuryModule(input: {
  readonly journal: PurchaseJournal;
  readonly policyPath: string;
  readonly wallet: KaspaWallet;
  readonly vault: VaultManager;
}): TreasuryOperationModule {
  return new TreasuryOperationModule({
    journal: input.journal,
    policy: new PolicyEngine(path.dirname(input.policyPath), input.policyPath),
    adapters: [
      new WalletTreasuryOperationAdapter(input.wallet),
      new VaultSendTreasuryOperationAdapter(input.vault, input.wallet),
      new VaultDepositTreasuryOperationAdapter(input.vault, input.wallet),
    ],
    feeCeilingAtomic: LIVE_TREASURY_FEE_CEILING_ATOMIC,
  });
}

async function driveTreasuryOperation(
  module: TreasuryOperationModule,
  request: TreasuryOperationRequest,
  onProgress?: (message: string) => void
): Promise<TreasuryOperationView> {
  const started = Date.now();
  let view = await module.execute(request);
  let lastState = "";
  while (view.state !== "completed") {
    if (view.state === "failed_terminal") {
      throw new Error(`Treasury operation ${request.operationKey} failed terminally`);
    }
    if (Date.now() - started >= OPERATION_TIMEOUT_MS) {
      throw new Error(
        `Treasury operation ${request.operationKey} remains ${view.state}; rerun the same command to resume it`
      );
    }
    if (view.state !== lastState) {
      onProgress?.(`${request.kind} is ${view.state}`);
      lastState = view.state;
    }
    await delay(2_000);
    view = await module.recover(request.operationKey);
  }
  return view;
}

function updateProgress(
  layout: LiveProofLayout,
  current: LiveProofProgress,
  patch: Partial<Pick<LiveProofProgress, "bootstrap" | "borrowInventory" | "vaultDeposit">>
): LiveProofProgress {
  const next = Object.freeze({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  writeAtomicJson(layout.progressPath, next);
  return next;
}

function writeRecoveryRecord(
  layout: LiveProofLayout,
  config: LiveProofConfig,
  progress: LiveProofProgress
): void {
  const existing = fs.existsSync(layout.recoveryPath)
    ? (JSON.parse(fs.readFileSync(layout.recoveryPath, "utf8")) as LiveRecoveryRecord)
    : undefined;
  const record = Object.freeze({
    version: 1 as const,
    runId: config.runId,
    preparedBeforeFirstSpendAt: existing?.preparedBeforeFirstSpendAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    network: LIVE_NETWORK,
    sourceWalletDirectory: config.sourceWalletDirectory,
    proofRoot: layout.root,
    sensitivePaths: Object.freeze([
      path.join(config.wallets.treasuryDirectory, "wallet-key"),
      path.join(config.wallets.merchantDirectory, "wallet-key"),
      path.join(config.wallets.observerDirectory, "wallet-key"),
      config.vault.ownerKeyPath,
      config.borrow.ownerKeyPath,
      path.join(config.vault.dataDirectory, "vault", "agent-key"),
      layout.authorityRoot,
      layout.stagingKeyDirectory,
      layout.paidReplayCapsulePath,
    ]),
    journalPaths: Object.freeze([
      layout.bootstrapJournalPath,
      layout.purchaseJournalPath,
      path.join(layout.root, "merchant", "exact.sqlite"),
      path.join(layout.root, "merchant", "authorization.sqlite"),
    ]),
    operationKeys: config.operationKeys,
    intendedAmountsAtomic: Object.freeze({
      bootstrap: LIVE_BOOTSTRAP_AMOUNT_ATOMIC,
      borrowInventory: LIVE_BORROW_AMOUNT_ATOMIC,
      vaultDeposit: LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC,
      purchasePrice: LIVE_PRICE_ATOMIC,
      additiveThreshold: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
    }),
    milestones: Object.freeze({
      ...(progress.bootstrap ? { bootstrap: progress.bootstrap } : {}),
      ...(progress.borrowInventory ? { borrowInventory: progress.borrowInventory } : {}),
      ...(progress.vaultDeposit ? { vaultDeposit: progress.vaultDeposit } : {}),
    }),
  }) satisfies LiveRecoveryRecord;
  writeAtomicJson(layout.recoveryPath, record);
}

function writePolicyOnce(filename: string, policy: Record<string, unknown>): void {
  if (fs.existsSync(filename)) {
    assertPrivateFile(filename);
    const current = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (JSON.stringify(current) !== JSON.stringify(policy)) {
      throw new Error(`live proof policy ${filename} changed; refusing to widen it`);
    }
    return;
  }
  writeAtomicJson(filename, policy);
}

function readLiveProofConfig(filename: string): LiveProofConfig {
  assertPrivateFile(filename);
  const value = JSON.parse(fs.readFileSync(filename, "utf8")) as LiveProofConfig;
  if (
    value.version !== 1 ||
    !RUN_ID.test(value.runId) ||
    !/^[a-f0-9]{32}$/.test(value.purchaseEntropyHex) ||
    !ADDRESS.test(value.wallets.treasuryAddress) ||
    !ADDRESS.test(value.wallets.merchantAddress) ||
    !ADDRESS.test(value.wallets.observerAddress) ||
    !ADDRESS.test(value.vault.address) ||
    !ADDRESS.test(value.borrow.address)
  ) {
    throw new Error("live proof configuration is invalid");
  }
  return value;
}

function assertSameConfig(actual: LiveProofConfig, expected: LiveProofConfig): void {
  const stableActual = {
    ...actual,
    createdAt: expected.createdAt,
    reservationExpiresAt: expected.reservationExpiresAt,
  };
  if (JSON.stringify(stableActual) !== JSON.stringify(expected)) {
    throw new Error("live proof configuration does not match its disposable keys and paths");
  }
}

function loadOrCreateHex(filename: string, byteLength: number): string {
  if (!fs.existsSync(filename)) {
    writePrivateText(filename, randomBytes(byteLength).toString("hex"));
  }
  assertPrivateFile(filename);
  const value = fs.readFileSync(filename, "utf8").trim().toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${byteLength * 2}}$`).test(value)) {
    throw new Error(`${filename} contains invalid proof identity material`);
  }
  return value;
}

function loadOrCreateOwnerKey(filename: string): { readonly publicKey: string } {
  if (!fs.existsSync(filename)) {
    const generated = generateOwnerKey();
    writePrivateText(filename, generated.privateKey);
  }
  assertPrivateFile(filename);
  const privateKeyHex = fs.readFileSync(filename, "utf8").trim().toLowerCase();
  const privateKey = new PrivateKey(privateKeyHex);
  const keypair = Keypair.fromPrivateKey(privateKey);
  try {
    return Object.freeze({
      publicKey: String(keypair.xOnlyPublicKey).toLowerCase(),
    });
  } finally {
    keypair.free();
    privateKey.free();
  }
}

function writePrivateText(filename: string, value: string): void {
  secureDirectory(path.dirname(filename));
  fs.writeFileSync(filename, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filename, 0o600);
}

interface RpcOutpointObservation {
  readonly amountAtomic: string;
  readonly scriptPublicKey: string;
  readonly blockDaaScore: string;
}

async function waitForRpcOutpoint(
  wallet: KaspaWallet,
  address: string,
  transactionId: string,
  index: number,
  timeoutMs: number
): Promise<RpcOutpointObservation> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = await findRpcOutpoint(wallet, address, transactionId, index);
    if (observed) return observed;
    if (Date.now() >= deadline) {
      throw new Error(`live Testnet-10 outpoint ${transactionId}:${index} was not accepted before timeout`);
    }
    await delay(2_000);
  }
}

async function findRpcOutpoint(
  wallet: KaspaWallet,
  address: string,
  transactionId: string,
  index: number
): Promise<RpcOutpointObservation | undefined> {
  const rpc = await wallet.client();
  const result = await rpc.getUtxosByAddresses([address]);
  const matches = (result.entries as unknown[]).filter((candidate) => {
    const record = candidate as Record<string, any>;
    const outpoint = record.outpoint ?? record.entry?.outpoint;
    return (
      String(outpoint?.transactionId ?? "").toLowerCase() === transactionId.toLowerCase() &&
      Number(outpoint?.index) === index
    );
  });
  if (matches.length > 1) throw new Error("live RPC returned duplicate outpoint entries");
  if (matches.length === 0) return undefined;
  const record = matches[0] as Record<string, any>;
  const blockDaaScore = BigInt(
    record.blockDaaScore ?? record.entry?.blockDaaScore ?? 0n
  );
  // getUtxosByAddresses may expose an unaccepted/mempool output with DAA 0.
  // Every live-proof milestone requires a block-backed Testnet-10 fact.
  if (blockDaaScore <= 0n) return undefined;
  return Object.freeze({
    amountAtomic: BigInt(record.amount ?? record.entry?.amount).toString(),
    scriptPublicKey: sdkSerializedScript(record.scriptPublicKey ?? record.entry?.scriptPublicKey),
    blockDaaScore: blockDaaScore.toString(),
  });
}

function sdkSerializedScript(value: unknown): string {
  const candidate = value as { version?: unknown; script?: unknown } | undefined;
  if (!candidate || Number(candidate.version) !== 0 || typeof candidate.script !== "string") {
    throw new Error("Kaspa script public key is invalid");
  }
  const script = candidate.script.toLowerCase();
  if (!HEX.test(script)) throw new Error("Kaspa script public key contains invalid hex");
  return `0000${script}`;
}

function addressForSerializedScript(serialized: string): string {
  const canonical = serialized.toLowerCase();
  if (!canonical.startsWith("0000") || !HEX.test(canonical.slice(4))) {
    throw new Error("serialized script public key is invalid");
  }
  const script = new ScriptPublicKey(0, canonical.slice(4));
  try {
    const address = addressFromScriptPublicKey(script, LIVE_SDK_NETWORK);
    if (!address) throw new Error("Kaspa SDK could not derive a Testnet-10 script address");
    try {
      return address.toString();
    } finally {
      address.free();
    }
  } finally {
    script.free();
  }
}

function ownerPublicKeyFromRedeemScript(redeemScript: string): string {
  const canonical = redeemScript.toLowerCase();
  const match = /^6320([a-f0-9]{64})ac/.exec(canonical);
  if (!match) throw new Error("KIP-10 redeem script owner key is invalid");
  return match[1];
}

function readMerchantVerifierState(filename: string): MerchantVerifierState | undefined {
  if (!fs.existsSync(filename)) return undefined;
  assertPrivateFile(filename);
  const value = JSON.parse(fs.readFileSync(filename, "utf8")) as MerchantVerifierState;
  if (
    value.version !== 1 ||
    !HASH32.test(value.transactionId) ||
    !HASH32.test(value.transactionDigest) ||
    !["planned", "observed"].includes(value.state)
  ) {
    throw new Error("Merchant verifier state is invalid");
  }
  return value;
}

function requireOutpoint(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  parseOutpoint(value);
  return value.toLowerCase();
}

function parseOutpoint(value: string): { readonly transactionId: string; readonly index: number } {
  const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(value.toLowerCase());
  if (!match) throw new Error(`invalid Testnet-10 outpoint ${value}`);
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`invalid Testnet-10 outpoint index ${value}`);
  }
  return Object.freeze({ transactionId: match[1], index });
}

function requireHash(value: unknown, label: string): string {
  const canonical = String(value ?? "").toLowerCase();
  if (!HASH32.test(canonical)) throw new Error(`${label} is invalid`);
  return canonical;
}

function requireAtomic(value: unknown, label: string): string {
  const canonical = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(canonical)) throw new Error(`${label} is invalid`);
  return canonical;
}

function isAlreadySubmitted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already|duplicate|known transaction|accepted transaction|mempool/i.test(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function installAuthorityMacKeyPair(
  serverFilename: string,
  clientFilename: string,
  byteLength: number
): void {
  secureDirectory(path.dirname(serverFilename));
  secureDirectory(path.dirname(clientFilename));
  const server = fs.existsSync(serverFilename) ? fs.readFileSync(serverFilename) : undefined;
  const client = fs.existsSync(clientFilename) ? fs.readFileSync(clientFilename) : undefined;
  const key = server ?? client ?? randomBytes(byteLength);
  try {
    if (key.byteLength !== byteLength) throw new Error("authority MAC key has an invalid length");
    if (server && (server.byteLength !== key.byteLength || !timingSafeEqual(server, key))) {
      throw new Error("authority server MAC key changed");
    }
    if (client && (client.byteLength !== key.byteLength || !timingSafeEqual(client, key))) {
      throw new Error("authority client MAC key changed");
    }
    if (!server) writePrivateBytes(serverFilename, key);
    if (!client) writePrivateBytes(clientFilename, key);
    assertPrivateFile(serverFilename);
    assertPrivateFile(clientFilename);
  } finally {
    key.fill(0);
    if (server && server !== key) server.fill(0);
    if (client && client !== key) client.fill(0);
  }
}

function writePrivateBytes(filename: string, bytes: Uint8Array): void {
  secureDirectory(path.dirname(filename));
  fs.writeFileSync(filename, bytes, { mode: 0o600, flag: "wx" });
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filename, 0o600);
}
