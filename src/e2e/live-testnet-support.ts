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
  minimumRequiredExactFeeSompi,
} from "../adapters/kaspa-x402/index.js";
import {
  Keypair,
  PrivateKey,
  ScriptPublicKey,
  Transaction,
  addressFromScriptPublicKey,
} from "../kaspa-wasm.js";
import { PolicyEngine } from "../policy.js";
import { assertPurchaseRequestKey } from "../purchase/identity.js";
import { PurchaseJournal } from "../purchase/journal.js";
import { SecureLocalStateDirectory } from "../secure-local-state.js";
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
import { ChainEvidenceModule } from "../chain-evidence/module.js";
import { JournalChainEvidenceStore } from "../chain-evidence/journal-store.js";
import { HttpsAcceptedChainWitness, WrpcOperatorChainObserver } from "../chain-evidence/sources.js";
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
const LIVE_OPERATOR_MANIFEST_IDENTITY = Object.freeze({
  revision: 1,
  digest: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
});

const HASH32 = /^[a-f0-9]{64}$/;
const HEX = /^(?:[a-f0-9]{2})+$/;
const ADDRESS = /^kaspatest:[a-z0-9]+$/;
const RUN_ID = /^[a-f0-9]{24}$/;
const OPERATION_TIMEOUT_MS = 8 * 60_000;
const OBSERVATION_TIMEOUT_MS = 6 * 60_000;
const MAX_JSON_STATE_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_FILE_BYTES = 4096;
const MAX_DURABLE_FILE_BYTES = 16 * 1024 * 1024;

export interface LiveProofConfig {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly nodeUrl: string;
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

export interface LiveObservedOutpoint {
  readonly transactionId: string;
  readonly outpoint: string;
  readonly address: string;
  readonly amountAtomic: string;
  readonly blockDaaScore: string;
  readonly virtualDaaScore: string;
  readonly finality: "accepted" | "confirmed";
}

export interface LiveChainMilestone extends LiveObservedOutpoint {
  readonly observationStartHash: string;
  readonly acceptingBlockHash: string;
  /** DAA of the virtual-chain block that accepted the transaction; distinct from UTXO creation DAA. */
  readonly acceptingBlockDaaScore: string;
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
  readonly nodeUrl: string;
  readonly sourceWalletDirectory: string;
  readonly proofRoot: string;
  readonly sensitivePaths: readonly string[];
  readonly journalPaths: readonly string[];
  readonly operationKeys: LiveProofConfig["operationKeys"];
  readonly startedOperations: readonly LiveFundingOperation[];
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

export type LiveFundingOperation = "bootstrap" | "borrowInventory" | "vaultDeposit";

const LIVE_FUNDING_OPERATION_ORDER = Object.freeze([
  "bootstrap",
  "borrowInventory",
  "vaultDeposit",
] as const satisfies readonly LiveFundingOperation[]);

const LIVE_ADMISSION = Object.freeze({
  authorityPreauthSockets: 32,
  authorityPrompts: 4,
  prevalidationPurchases: 128,
  evidenceBytes: 67_108_864,
  directTreasuryRetries: 3,
});

export interface LiveProofLayout {
  readonly root: string;
  readonly configPath: string;
  readonly progressPath: string;
  readonly recoveryPath: string;
  readonly bootstrapPolicyPath: string;
  readonly bootstrapJournalPath: string;
  readonly purchasePolicyPath: string;
  readonly purchaseJournalPath: string;
  readonly merchantOfferPath: string;
  readonly merchantPaidIngressPath: string;
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
    merchantOfferPath: path.join(resolved, "merchant", "offer.json"),
    merchantPaidIngressPath: path.join(resolved, "merchant", "paid-ingress.json"),
    merchantVerifierStatePath: path.join(resolved, "merchant", "exact-verifier-state.json"),
    paidReplayCapsulePath: path.join(resolved, "merchant", "paid-replay-capsule.json"),
    authorityRoot: path.join(resolved, "authority"),
    stagingKeyDirectory: path.join(resolved, "staging-keys"),
  });
}

export function initializeLiveProof(
  root: string,
  sourceWalletDirectory: string,
  nodeUrlInput: string | undefined = process.env.SOMPI_NODE_URL
): InitializedLiveProof {
  if (process.env.SOMPI_PRIVATE_KEY) {
    throw new Error(
      "SOMPI_PRIVATE_KEY must be unset for the live proof so every disposable wallet is file-bound and distinct"
    );
  }
  const layout = liveProofLayout(root);
  const nodeUrl = requireLiveNodeUrl(nodeUrlInput);
  secureDirectory(layout.root);
  const initialRootEntries = fs.readdirSync(layout.root);
  const hasConfig = secureFileExists(layout.configPath);
  const hasRecovery = secureFileExists(layout.recoveryPath);
  if (!hasConfig && initialRootEntries.length > 0) {
    throw new Error(
      "live proof run identity is missing from a non-empty proof root; use a fresh root after manual reconciliation"
    );
  }
  if (hasConfig && !hasRecovery) {
    throw new Error(
      "live proof recovery continuity is missing; refusing to reconstruct a surviving run identity"
    );
  }
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
    nodeUrl,
  });
  const merchantWallet = new KaspaWallet({
    networkId: LIVE_SDK_NETWORK,
    dataDir: merchantDirectory,
    nodeUrl,
  });
  const observerWallet = new KaspaWallet({
    networkId: LIVE_SDK_NETWORK,
    dataDir: observerDirectory,
    nodeUrl,
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
    amount: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
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
    nodeUrl,
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
      address: vault.initialAddress(),
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

  const config = hasConfig
    ? readLiveProofConfig(layout.configPath)
    : created;
  assertSameConfig(config, created);
  if (!hasConfig) writeAtomicJson(layout.configPath, config);

  const progress = readProgress(layout.progressPath, runId);
  writeRecoveryRecord(layout, config, progress);
  assertPrivateFile(layout.recoveryPath);
  if (hasConfig) {
    if (
      !secureFileExists(layout.bootstrapJournalPath) ||
      !secureFileExists(layout.purchaseJournalPath)
    ) {
      throw new Error(
        "live proof journal continuity is missing from a surviving run identity"
      );
    }
  } else {
    for (const filename of [layout.bootstrapJournalPath, layout.purchaseJournalPath]) {
      const journal = new PurchaseJournal(filename, {
        operatorManifestIdentity: LIVE_OPERATOR_MANIFEST_IDENTITY,
        admission: LIVE_ADMISSION,
      });
      journal.close();
    }
  }
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

  let progress = readProgress(layout.progressPath, config.runId);
  if (
    (progress.vaultDeposit && !progress.borrowInventory) ||
    (progress.borrowInventory && !progress.bootstrap)
  ) {
    throw new Error("live proof milestones are not a complete ordered prefix");
  }
  const bootstrapJournalExists = secureFileExists(layout.bootstrapJournalPath);
  const purchaseJournalExists = secureFileExists(layout.purchaseJournalPath);
  const recovery = readRecoveryRecord(layout.recoveryPath, config.runId);
  if (
    recovery.nodeUrl !== config.nodeUrl ||
    recovery.sourceWalletDirectory !== config.sourceWalletDirectory ||
    recovery.proofRoot !== layout.root ||
    JSON.stringify(recovery.operationKeys) !== JSON.stringify(config.operationKeys) ||
    JSON.stringify(recovery.intendedAmountsAtomic) !== JSON.stringify({
      bootstrap: LIVE_BOOTSTRAP_AMOUNT_ATOMIC,
      borrowInventory: LIVE_BORROW_AMOUNT_ATOMIC,
      vaultDeposit: LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC,
      purchasePrice: LIVE_PRICE_ATOMIC,
      additiveThreshold: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
    })
  ) {
    throw new Error("live proof recovery record differs from its immutable run configuration");
  }
  const startedOperations = new Set(recovery.startedOperations);
  const merchantDownstreamExists = [
    layout.merchantOfferPath,
    layout.merchantPaidIngressPath,
    layout.merchantVerifierStatePath,
    layout.paidReplayCapsulePath,
    path.join(layout.root, "merchant", "exact.sqlite"),
    path.join(layout.root, "merchant", "authorization.sqlite"),
  ].some(secureFileExists);
  if (
    !bootstrapJournalExists ||
    !purchaseJournalExists ||
    (progress.bootstrap && !bootstrapJournalExists) ||
    (startedOperations.has("bootstrap") && !bootstrapJournalExists) ||
    ((startedOperations.has("borrowInventory") || startedOperations.has("vaultDeposit")) &&
      !purchaseJournalExists) ||
    (startedOperations.has("borrowInventory") && !progress.bootstrap) ||
    (startedOperations.has("vaultDeposit") && !progress.borrowInventory) ||
    ((progress.borrowInventory || progress.vaultDeposit || purchaseJournalExists || merchantDownstreamExists) &&
      !bootstrapJournalExists) ||
    ((progress.borrowInventory || progress.vaultDeposit || merchantDownstreamExists) &&
      !purchaseJournalExists)
  ) {
    throw new Error("live proof journal continuity is missing; refusing to create a replacement operation");
  }

  const bootstrapJournal = new PurchaseJournal(layout.bootstrapJournalPath, {
    operatorManifestIdentity: LIVE_OPERATOR_MANIFEST_IDENTITY,
    admission: LIVE_ADMISSION,
  });
  const purchaseJournal = new PurchaseJournal(layout.purchaseJournalPath, {
    operatorManifestIdentity: LIVE_OPERATOR_MANIFEST_IDENTITY,
    admission: LIVE_ADMISSION,
  });
  const purchaseHasDownstreamState = Boolean(
    purchaseJournal.findTreasuryOperation(config.operationKeys.borrowInventory) ||
    purchaseJournal.findTreasuryOperation(config.operationKeys.vaultDeposit) ||
    purchaseJournal.findPurchaseByRequestKey(assertLivePurchaseRequestKey(config.runId))
  );
  const sourceWallet = new KaspaWallet({
    networkId: LIVE_SDK_NETWORK,
    dataDir: config.sourceWalletDirectory,
    nodeUrl: config.nodeUrl,
  });
  try {
    await assertLiveNodeReady(sourceWallet);
    if (sourceWallet.address === treasuryWallet.address) {
      throw new Error("bootstrap source and disposable Treasury wallet unexpectedly share an address");
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
    writeRecoveryRecord(layout, config, progress);
    assertPreSpendDurability(initialized, config.sourceWalletDirectory);
    const bootstrapRequest = {
      operationKey: config.operationKeys.bootstrap,
      kind: "wallet_send" as const,
      destination: config.wallets.treasuryAddress,
      amountAtomic: LIVE_BOOTSTRAP_AMOUNT_ATOMIC,
    };
    input.onProgress?.("recovering durable bootstrap operation");
    if (progress.bootstrap) {
      const milestone = await revalidateOperationMilestone({
        journal: bootstrapJournal,
        request: bootstrapRequest,
        milestone: progress.bootstrap,
        wallet: treasuryWallet,
      });
      if (milestone !== progress.bootstrap) {
        progress = updateProgress(layout, progress, { bootstrap: milestone });
        writeRecoveryRecord(layout, config, progress);
      }
    } else {
      const existing = assertOperationRequestMatches(bootstrapJournal, bootstrapRequest);
      if (purchaseHasDownstreamState) {
        throw new Error("bootstrap milestone is missing after downstream state; manual reconciliation is required");
      }
      if (liveBootstrapNeedsCapacity(progress.bootstrap, existing)) {
        const sourceBalance = await sourceWallet.balanceSompi();
        if (
          sourceBalance <
          BigInt(LIVE_BOOTSTRAP_AMOUNT_ATOMIC) +
            BigInt(LIVE_TREASURY_FEE_CEILING_ATOMIC)
        ) {
          throw new Error("bootstrap source does not hold enough Testnet-10 funds");
        }
      }
      writeRecoveryRecord(layout, config, progress, "bootstrap");
      assertPreSpendDurability(initialized, config.sourceWalletDirectory);
      const bootstrapView = await driveLiveTreasuryOperation(
        bootstrapModule,
        bootstrapRequest,
        input.onProgress,
        existing
      );
      const detail = bootstrapJournal.readObservedTreasuryOperationDetail(
        config.operationKeys.bootstrap
      );
      const outpoint = requireOutpoint(detail.destinationOutpoint, "bootstrap destination outpoint");
      const milestone = await observeAddressOutpoint({
        wallet: treasuryWallet,
        address: config.wallets.treasuryAddress,
        outpoint,
        amountAtomic: LIVE_BOOTSTRAP_AMOUNT_ATOMIC,
        observationStartHash: preparedObservationStartHash(
          bootstrapJournal,
          config.operationKeys.bootstrap
        ),
      });
      if (bootstrapView.transactionId !== milestone.transactionId) {
        throw new Error("bootstrap operation and observed funding transaction differ");
      }
      progress = updateProgress(layout, progress, { bootstrap: milestone });
      writeRecoveryRecord(layout, config, progress);
    }

    const mainModule = treasuryModule({
      journal: purchaseJournal,
      policyPath: layout.purchasePolicyPath,
      wallet: treasuryWallet,
      vault,
    });
    const borrowRequest = {
      operationKey: config.operationKeys.borrowInventory,
      kind: "wallet_send" as const,
      destination: config.borrow.address,
      amountAtomic: LIVE_BORROW_AMOUNT_ATOMIC,
    };
    writeRecoveryRecord(layout, config, progress);
    assertPreSpendDurability(initialized, config.sourceWalletDirectory);
    input.onProgress?.("recovering durable KIP-10 inventory operation");
    if (progress.borrowInventory) {
      const milestone = await revalidateOperationMilestone({
        journal: purchaseJournal,
        request: borrowRequest,
        milestone: progress.borrowInventory,
        wallet: treasuryWallet,
      });
      if (milestone !== progress.borrowInventory) {
        progress = updateProgress(layout, progress, { borrowInventory: milestone });
        writeRecoveryRecord(layout, config, progress);
      }
    } else {
      const existing = assertOperationRequestMatches(purchaseJournal, borrowRequest);
      const depositExists = Boolean(
        purchaseJournal.findTreasuryOperation(config.operationKeys.vaultDeposit)
      );
      const purchaseExists = Boolean(
        purchaseJournal.findPurchaseByRequestKey(
          assertLivePurchaseRequestKey(config.runId)
        )
      );
      if (depositExists || purchaseExists || merchantDownstreamExists) {
        throw new Error("borrow milestone is missing after downstream state; manual reconciliation is required");
      }
      writeRecoveryRecord(layout, config, progress, "borrowInventory");
      assertPreSpendDurability(initialized, config.sourceWalletDirectory);
      const borrowView = await driveLiveTreasuryOperation(
        mainModule,
        borrowRequest,
        input.onProgress,
        existing
      );
      const detail = purchaseJournal.readObservedTreasuryOperationDetail(
        config.operationKeys.borrowInventory
      );
      const outpoint = requireOutpoint(detail.destinationOutpoint, "borrow inventory outpoint");
      const milestone = await observeAddressOutpoint({
        wallet: treasuryWallet,
        address: config.borrow.address,
        outpoint,
        amountAtomic: LIVE_BORROW_AMOUNT_ATOMIC,
        observationStartHash: preparedObservationStartHash(
          purchaseJournal,
          config.operationKeys.borrowInventory
        ),
      });
      if (borrowView.transactionId !== milestone.transactionId) {
        throw new Error("borrow inventory operation and observed transaction differ");
      }
      progress = updateProgress(layout, progress, { borrowInventory: milestone });
      writeRecoveryRecord(layout, config, progress);
    }

    const depositRequest = {
      operationKey: config.operationKeys.vaultDeposit,
      kind: "vault_deposit" as const,
      destination: config.vault.address,
      amountAtomic: LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC,
    };
    writeRecoveryRecord(layout, config, progress);
    assertPreSpendDurability(initialized, config.sourceWalletDirectory);
    input.onProgress?.("recovering durable fresh-vault deposit operation");
    if (progress.vaultDeposit) {
      const milestone = await revalidateOperationMilestone({
        journal: purchaseJournal,
        request: depositRequest,
        milestone: progress.vaultDeposit,
        wallet: treasuryWallet,
        deposit: true,
      });
      if (milestone !== progress.vaultDeposit) {
        progress = updateProgress(layout, progress, { vaultDeposit: milestone });
        writeRecoveryRecord(layout, config, progress);
      }
    } else {
      const existing = assertOperationRequestMatches(purchaseJournal, depositRequest);
      const purchaseExists = Boolean(
        purchaseJournal.findPurchaseByRequestKey(assertLivePurchaseRequestKey(config.runId))
      );
      if (purchaseExists || merchantDownstreamExists) {
        throw new Error("vault milestone is missing after Purchase state; manual reconciliation is required");
      }
      writeRecoveryRecord(layout, config, progress, "vaultDeposit");
      assertPreSpendDurability(initialized, config.sourceWalletDirectory);
      const depositView = await driveLiveTreasuryOperation(
        mainModule,
        depositRequest,
        input.onProgress,
        existing
      );
      const detail = purchaseJournal.readObservedTreasuryOperationDetail(
        config.operationKeys.vaultDeposit
      );
      const outpoint = requireOutpoint(detail.vaultOutpoint, "vault deposit outpoint");
      const milestone = await observeAddressOutpoint({
        wallet: treasuryWallet,
        address: config.vault.address,
        outpoint,
        amountAtomic: requireAtomic(detail.vaultAmountAtomic, "vault amount"),
        observationStartHash: preparedObservationStartHash(
          purchaseJournal,
          config.operationKeys.vaultDeposit
        ),
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
    purchaseJournal.close();
    throw error;
  } finally {
    bootstrapJournal.close();
    await sourceWallet.disconnect();
  }
}

export class LiveMerchantExactVerifier implements ExactTransactionVerifier {
  private readonly codec = new KaspaTestnet10AddressCodec();
  private readonly wallet: KaspaWallet;
  private readonly statePath: string;
  private readonly expected: LiveMerchantExactExpectation;
  private readonly now: () => number;

  constructor(options: {
    readonly wallet: KaspaWallet;
    readonly statePath: string;
    readonly expected: LiveMerchantExactExpectation;
    readonly now?: () => number;
  }) {
    if (options.wallet.networkId !== LIVE_SDK_NETWORK) {
      throw new Error("live Merchant verifier requires Testnet-10");
    }
    this.wallet = options.wallet;
    this.statePath = options.statePath;
    this.expected = Object.freeze({ ...options.expected });
    this.now = options.now ?? Date.now;
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
      const continuation = await waitForRpcOutpoint(
        this.wallet,
        parsed.borrowAddress,
        parsed.transactionId,
        0,
        OBSERVATION_TIMEOUT_MS
      );
      if (
        continuation.amountAtomic !==
          (BigInt(request.reservation!.borrowAmount) +
            BigInt(request.reservation!.additiveThresholdSompi)).toString() ||
        continuation.scriptPublicKey !== request.reservation!.borrowScriptPublicKey.toLowerCase()
      ) {
        throw new Error("Merchant live RPC observation changed the additive continuation output");
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

  hasDurablePaymentPlan(): boolean {
    return readMerchantVerifierState(this.statePath) !== undefined;
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
    if (
      request.payTo !== this.expected.payTo ||
      request.payToScriptPublicKey.toLowerCase() !== this.expected.payToScriptPublicKey ||
      reservation.reservationId.toLowerCase() !== this.expected.reservationId ||
      reservation.borrowOutpoint.txid.toLowerCase() !== this.expected.borrowTransactionId ||
      reservation.borrowOutpoint.index !== this.expected.borrowIndex ||
      reservation.borrowAmount !== this.expected.borrowAmountAtomic ||
      reservation.borrowScriptPublicKey.toLowerCase() !== this.expected.borrowScriptPublicKey ||
      reservation.borrowRedeemScript.toLowerCase() !== this.expected.borrowRedeemScript ||
      reservation.additiveThresholdSompi !== this.expected.additiveThresholdAtomic
    ) {
      throw new Error("Merchant exact verifier request differs from configured live inventory");
    }
    const recomputedRedeem = buildKip10AdditiveRedeemScript({
      ownerPublicKey: ownerPublicKeyFromRedeemScript(reservation.borrowRedeemScript),
      amount: reservation.additiveThresholdSompi,
    }).toLowerCase();
    const recomputedSpk = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({
        ownerPublicKey: ownerPublicKeyFromRedeemScript(reservation.borrowRedeemScript),
        amount: reservation.additiveThresholdSompi,
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
      if (inputs.length !== 2 || outputs.length !== 2) {
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
      const outputTotal = BigInt(outputs[0].value) + BigInt(outputs[1].value);
      const inputTotal = BigInt(reservation.borrowAmount) + stagingAmount;
      const exactFee = inputTotal - outputTotal;
      if (
        exactFee !== BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi) ||
        exactFee < minimumRequiredExactFeeSompi(transaction)
      ) {
        throw new Error("Merchant exact transaction changed the pinned exact fee");
      }
      const expectedChange =
        stagingAmount -
        BigInt(request.amount) -
        BigInt(reservation.additiveThresholdSompi) -
        BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi);
      if (
        expectedChange < 0n ||
        expectedChange !== 0n
      ) {
        throw new Error("Merchant fixed-v2 transaction requires exact staging without change");
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

export interface LiveMerchantExactExpectation {
  readonly payTo: string;
  readonly payToScriptPublicKey: string;
  readonly reservationId: string;
  readonly borrowTransactionId: string;
  readonly borrowIndex: number;
  readonly borrowAmountAtomic: string;
  readonly borrowScriptPublicKey: string;
  readonly borrowRedeemScript: string;
  readonly additiveThresholdAtomic: string;
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
  const recoveryPath = path.join(path.dirname(filename), "recovery.json");
  if (secureFileExists(recoveryPath)) {
    const recovery = readRecoveryRecord(recoveryPath, runId);
    // recovery.json is the safety source of truth. progress.json is a
    // replaceable operator convenience cache; a crash between their atomic
    // replacements may leave either generation there without authorizing a
    // replacement transaction.
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
  if (!secureFileExists(filename)) {
    return Object.freeze({
      version: 1,
      runId,
      updatedAt: new Date(0).toISOString(),
    });
  }
  const value = readPrivateJson<LiveProofProgress>(filename);
  if (value.version !== 1 || value.runId !== runId) {
    throw new Error("live proof progress belongs to a different run");
  }
  return value;
}

export function writeAtomicJson(filename: string, value: unknown): void {
  const target = path.resolve(filename);
  const state = new SecureLocalStateDirectory(path.dirname(target), "live proof state");
  const leaf = path.basename(target);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    if (state.fileExists(leaf)) {
      state.replaceFileAtomic(leaf, bytes, MAX_JSON_STATE_BYTES);
    } else {
      state.createFileExclusive(leaf, bytes, MAX_JSON_STATE_BYTES);
    }
  } finally {
    bytes.fill(0);
  }
}

export function secureDirectory(directory: string): void {
  void new SecureLocalStateDirectory(directory, "live proof state");
}

export function assertPrivateFile(filename: string): void {
  const target = path.resolve(filename);
  const state = new SecureLocalStateDirectory(path.dirname(target), "live proof state");
  if (!state.fileExists(path.basename(target))) throw new Error("live proof state file is missing");
}

export function privateStateFileExists(filename: string): boolean {
  return secureFileExists(filename);
}

export function readPrivateJsonState<T>(filename: string): T {
  return readPrivateJson<T>(filename);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function reservationId(config: LiveProofConfig, borrowOutpoint: string): string {
  return sha256Hex(`sompi-live-borrow-reservation:${config.runId}:${borrowOutpoint}`);
}

export function assertPublicReportExcludesPrivateState(
  report: unknown,
  initialized: InitializedLiveProof
): void {
  const encoded = JSON.stringify(report);
  const files = [
    path.join(initialized.config.wallets.treasuryDirectory, "wallet-key"),
    path.join(initialized.config.wallets.merchantDirectory, "wallet-key"),
    path.join(initialized.config.wallets.observerDirectory, "wallet-key"),
    initialized.config.vault.ownerKeyPath,
    initialized.config.borrow.ownerKeyPath,
    path.join(initialized.config.vault.dataDirectory, "vault", "agent-key"),
    path.join(initialized.layout.authorityRoot, "server-private", "ipc-mac.key"),
    path.join(initialized.layout.authorityRoot, "client-runtime", "ipc-mac.key"),
    initialized.layout.paidReplayCapsulePath,
    initialized.layout.merchantOfferPath,
    initialized.layout.merchantPaidIngressPath,
  ];
  const stagingState = new SecureLocalStateDirectory(
    initialized.layout.stagingKeyDirectory,
    "live staging keys"
  );
  for (const entry of fs.readdirSync(stagingState.directory)) {
    if (/^[A-Za-z0-9._-]{1,128}$/.test(entry) && stagingState.fileExists(entry)) {
      files.push(path.join(stagingState.directory, entry));
    }
  }
  for (const filename of files) {
    if (!secureFileExists(filename)) continue;
    const bytes = readPrivateBytes(filename, MAX_JSON_STATE_BYTES);
    try {
      const candidates = [
        bytes.toString("utf8").trim(),
        bytes.toString("hex"),
        bytes.toString("base64"),
        bytes.toString("base64url"),
      ];
      for (const candidate of candidates) {
        if (candidate.length >= 16 && encoded.includes(candidate)) {
          throw new Error("live proof report contains private state or a signed protocol artifact");
        }
      }
      if (
        filename === initialized.layout.paidReplayCapsulePath ||
        filename === initialized.layout.merchantOfferPath ||
        filename === initialized.layout.merchantPaidIngressPath
      ) {
        const capsule = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        for (const key of ["merchantCheckout", "paymentRequiredHeader", "paymentSignature"]) {
          const value = capsule[key];
          if (typeof value === "string" && value.length >= 16 && encoded.includes(value)) {
            throw new Error("live proof report contains a paid-request artifact");
          }
        }
      }
    } finally {
      bytes.fill(0);
    }
  }
}

export async function observeAddressOutpoint(input: {
  readonly wallet: KaspaWallet;
  readonly address: string;
  readonly outpoint: string;
  readonly amountAtomic: string;
  readonly observationStartHash: string;
}): Promise<LiveChainMilestone> {
  const current = await observeCurrentAddressOutpoint(input);
  const acceptance = await acceptingBlockForTransaction(
    input.wallet,
    requireHash(input.observationStartHash, "operation observation start hash"),
    current.transactionId
  );
  return Object.freeze({
    ...current,
    observationStartHash: input.observationStartHash,
    acceptingBlockHash: acceptance.hash,
    acceptingBlockDaaScore: acceptance.daaScore,
  });
}

export async function observeCurrentAddressOutpoint(input: {
  readonly wallet: KaspaWallet;
  readonly address: string;
  readonly outpoint: string;
  readonly amountAtomic: string;
}): Promise<LiveObservedOutpoint> {
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
  const raw = JSON.parse(fs.readFileSync(input.policyPath, "utf8")) as Record<string, unknown>;
  const chainEvidence = new ChainEvidenceModule(
    new WrpcOperatorChainObserver({ rpc: input.wallet, depthConfirmationDaa: 10 }),
    new HttpsAcceptedChainWitness({ baseUrl: "https://api-tn10.kaspa.org/", depthConfirmationDaa: 10 }),
    new JournalChainEvidenceStore(input.journal)
  );
  return new TreasuryOperationModule({
    journal: input.journal,
    policy: new PolicyEngine({
      maxSompiPerTx: BigInt(String(raw.maxSompiPerTx)),
      maxSompiPerHour: BigInt(String(raw.maxSompiPerHour)),
      allowlist: Array.isArray(raw.allowlist) ? raw.allowlist.map(String) : [],
      requireApprovalAboveSompi: BigInt(String(raw.requireApprovalAboveSompi ?? "0")),
    }),
    adapters: [
      new WalletTreasuryOperationAdapter(input.wallet, chainEvidence, "accepted"),
      new VaultSendTreasuryOperationAdapter(input.vault, input.wallet, chainEvidence, "accepted"),
      new VaultDepositTreasuryOperationAdapter(input.vault, input.wallet, chainEvidence, "accepted"),
    ],
    feeCeilingAtomic: LIVE_TREASURY_FEE_CEILING_ATOMIC,
  });
}

function assertLivePurchaseRequestKey(runId: string) {
  return assertPurchaseRequestKey(`e2e:live-testnet10:${runId}`);
}

function preparedObservationStartHash(
  journal: PurchaseJournal,
  operationKey: string
): string {
  const bytes = journal.readPreparedTreasuryOperation(operationKey);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("durable Treasury operation envelope is malformed", { cause: error });
  }
  const record = value as Record<string, unknown>;
  return requireHash(record.observationStartHash, "Treasury observation start hash");
}

async function acceptingBlockForTransaction(
  wallet: KaspaWallet,
  startHash: string,
  transactionId: string
): Promise<{ readonly hash: string; readonly daaScore: string }> {
  const rpc = await wallet.client();
  const chain = await rpc.getVirtualChainFromBlock({
    startHash,
    includeAcceptedTransactionIds: true,
    minConfirmationCount: 0,
  });
  const matches = chain.acceptedTransactionIds.filter((entry) =>
    entry.acceptedTransactionIds.some(
      (candidate) => String(candidate).toLowerCase() === transactionId
    )
  );
  if (matches.length !== 1) {
    throw new Error("Treasury transaction lacks one current virtual-chain inclusion proof");
  }
  const hash = requireHash(matches[0].acceptingBlockHash, "Treasury accepting block hash");
  const block = await rpc.getBlock({ hash, includeTransactions: true });
  const headerHash = requireHash(block.block.header.hash, "Treasury accepting block header hash");
  const verboseHash = block.block.verboseData?.hash === undefined
    ? headerHash
    : requireHash(block.block.verboseData.hash, "Treasury accepting block verbose hash");
  const daaScore = BigInt(block.block.header.daaScore);
  if (headerHash !== hash || verboseHash !== hash || daaScore <= 0n) {
    throw new Error("Treasury accepting block cannot be independently bound to its header");
  }
  // The accepting block can accept a merge-set transaction that is not one of
  // its own transactionIds. The virtual-chain accepted-ID relation proves
  // acceptance; getBlock separately binds that accepting block's hash and DAA.
  return Object.freeze({ hash, daaScore: daaScore.toString() });
}

export function liveBootstrapNeedsCapacity(
  milestone: LiveChainMilestone | undefined,
  operationExists: boolean
): boolean {
  return milestone === undefined && !operationExists;
}

export async function driveLiveTreasuryOperation(
  module: TreasuryOperationModule,
  request: TreasuryOperationRequest,
  onProgress?: (message: string) => void,
  existing = false
): Promise<TreasuryOperationView> {
  const started = Date.now();
  let view = existing
    ? await module.recover(request.operationKey)
    : await module.execute(request);
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

function assertOperationRequestMatches(
  journal: PurchaseJournal,
  request: TreasuryOperationRequest
): boolean {
  const record = journal.findTreasuryOperation(request.operationKey);
  if (!record) return false;
  if (
    record.kind !== request.kind ||
    record.destination !== request.destination ||
    record.requestedAmountAtomic !== request.amountAtomic ||
    record.keepFloatAtomic !== request.keepFloatAtomic
  ) {
    throw new Error("durable Treasury operation differs from the live proof request");
  }
  return true;
}

async function revalidateOperationMilestone<T extends LiveChainMilestone>(input: {
  readonly journal: PurchaseJournal;
  readonly request: TreasuryOperationRequest;
  readonly milestone: T;
  readonly wallet: KaspaWallet;
  readonly deposit?: boolean;
}): Promise<T> {
  const record = input.journal.findTreasuryOperation(input.request.operationKey);
  if (!record || record.state !== "completed" || !record.transactionId) {
    throw new Error("live milestone has no exact completed Treasury operation");
  }
  assertOperationRequestMatches(input.journal, input.request);
  const bytes = input.journal.readPreparedTreasuryOperation(input.request.operationKey);
  let envelope: Record<string, any>;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("durable Treasury operation envelope is malformed", { cause: error });
  }
  const prepared = envelope.prepared as Record<string, unknown> | undefined;
  const binding = envelope.binding as Record<string, unknown> | undefined;
  const detail = input.journal.readObservedTreasuryOperationDetail(input.request.operationKey);
  const expectedOutpoint = requireOutpoint(
    input.deposit ? detail.vaultOutpoint : detail.destinationOutpoint,
    "Treasury milestone outpoint"
  );
  const expectedAmount = input.deposit
    ? requireAtomic(detail.vaultAmountAtomic, "Treasury vault amount")
    : requireAtomic(detail.amountAtomic, "Treasury destination amount");
  const preparedOutpoint = input.deposit
    ? (prepared?.vaultOutpoint as Record<string, unknown> | undefined)
    : (prepared?.destinationOutpoint as Record<string, unknown> | undefined);
  if (
    envelope.kind !== input.request.kind ||
    binding?.operationKey !== input.request.operationKey ||
    binding?.destination !== input.request.destination ||
    binding?.requestedAmountAtomic !== input.request.amountAtomic ||
    binding?.network !== LIVE_NETWORK ||
    prepared?.transactionId !== record.transactionId ||
    record.resolvedAmountAtomic !== input.request.amountAtomic ||
    detail.transactionId !== record.transactionId ||
    preparedOutpoint?.txid !== record.transactionId ||
    `${record.transactionId}:${preparedOutpoint?.index}` !== expectedOutpoint ||
    String(input.deposit ? prepared?.vaultAmountAtomic : prepared?.amountAtomic) !== expectedAmount ||
    input.milestone.transactionId !== record.transactionId ||
    input.milestone.outpoint !== expectedOutpoint ||
    input.milestone.address !== input.request.destination ||
    input.milestone.amountAtomic !== expectedAmount
  ) {
    throw new Error("live milestone differs from its exact prepared and observed Treasury facts");
  }
  const observationStartHash = requireHash(
    envelope.observationStartHash,
    "Treasury observation start hash"
  );
  if (input.milestone.observationStartHash !== observationStartHash) {
    throw new Error("live milestone changed its durable pre-broadcast chain anchor");
  }
  return reconcileLiveChainMilestoneInclusion(input.milestone, input.wallet);
}

export async function reconcileLiveChainMilestoneInclusion<T extends LiveChainMilestone>(
  milestone: T,
  wallet: KaspaWallet
): Promise<T> {
  const acceptance = await acceptingBlockForTransaction(
    wallet,
    requireHash(milestone.observationStartHash, "Treasury observation start hash"),
    requireHash(milestone.transactionId, "Treasury transaction ID")
  );
  if (
    milestone.acceptingBlockHash === acceptance.hash &&
    milestone.acceptingBlockDaaScore === acceptance.daaScore
  ) {
    return milestone;
  }
  return Object.freeze({
    ...milestone,
    acceptingBlockHash: acceptance.hash,
    acceptingBlockDaaScore: acceptance.daaScore,
  }) as T;
}

export async function verifyLiveChainMilestoneInclusion(
  milestone: LiveChainMilestone,
  wallet: KaspaWallet
): Promise<void> {
  const reconciled = await reconcileLiveChainMilestoneInclusion(milestone, wallet);
  if (
    milestone.acceptingBlockHash !== reconciled.acceptingBlockHash ||
    milestone.acceptingBlockDaaScore !== reconciled.acceptingBlockDaaScore
  ) {
    throw new Error("live milestone accepting-block proof changed");
  }
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
  progress: LiveProofProgress,
  operationStarted?: LiveFundingOperation
): void {
  const existing = secureFileExists(layout.recoveryPath)
    ? readRecoveryRecord(layout.recoveryPath, config.runId)
    : undefined;
  const startedOperations = [...(existing?.startedOperations ?? [])];
  if (operationStarted && !startedOperations.includes(operationStarted)) {
    const expected = LIVE_FUNDING_OPERATION_ORDER[startedOperations.length];
    if (operationStarted !== expected) {
      throw new Error("live proof funding operation fences are not an ordered prefix");
    }
    startedOperations.push(operationStarted);
  }
  const record = Object.freeze({
    version: 1 as const,
    runId: config.runId,
    preparedBeforeFirstSpendAt: existing?.preparedBeforeFirstSpendAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    network: LIVE_NETWORK,
    nodeUrl: config.nodeUrl,
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
      layout.merchantOfferPath,
      layout.merchantPaidIngressPath,
      layout.paidReplayCapsulePath,
    ]),
    journalPaths: Object.freeze([
      layout.bootstrapJournalPath,
      layout.purchaseJournalPath,
      path.join(layout.root, "merchant", "exact.sqlite"),
      path.join(layout.root, "merchant", "authorization.sqlite"),
    ]),
    operationKeys: config.operationKeys,
    startedOperations: Object.freeze(startedOperations),
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

function readRecoveryRecord(filename: string, runId: string): LiveRecoveryRecord {
  const value = readPrivateJson<LiveRecoveryRecord>(filename);
  const hasStartedOperations = Array.isArray(value.startedOperations);
  const started = hasStartedOperations ? value.startedOperations : [];
  const expectedPrefix = LIVE_FUNDING_OPERATION_ORDER.slice(0, started.length);
  if (
    value.version !== 1 ||
    value.runId !== runId ||
    value.network !== LIVE_NETWORK ||
    !hasStartedOperations ||
    requireLiveNodeUrl(value.nodeUrl) !== value.nodeUrl ||
    started.length > LIVE_FUNDING_OPERATION_ORDER.length ||
    JSON.stringify(started) !== JSON.stringify(expectedPrefix)
  ) {
    throw new Error("live proof recovery record is invalid or belongs to a different run");
  }
  return value;
}

function assertPreSpendDurability(
  initialized: InitializedLiveProof,
  sourceWalletDirectory: string
): void {
  const source = new SecureLocalStateDirectory(sourceWalletDirectory, "bootstrap source wallet");
  const sourceKey = source.readFile("wallet-key", MAX_SECRET_FILE_BYTES);
  sourceKey.fill(0);
  const files = [
    initialized.layout.configPath,
    initialized.layout.recoveryPath,
    path.join(initialized.config.wallets.treasuryDirectory, "wallet-key"),
    path.join(initialized.config.wallets.merchantDirectory, "wallet-key"),
    path.join(initialized.config.wallets.observerDirectory, "wallet-key"),
    initialized.config.vault.ownerKeyPath,
    initialized.config.borrow.ownerKeyPath,
    path.join(initialized.config.vault.dataDirectory, "vault", "agent-key"),
    path.join(initialized.config.vault.dataDirectory, "vault", "config.json"),
    initialized.layout.bootstrapPolicyPath,
    initialized.layout.bootstrapJournalPath,
    initialized.layout.purchasePolicyPath,
    ...(secureFileExists(initialized.layout.purchaseJournalPath)
      ? [initialized.layout.purchaseJournalPath]
      : []),
  ];
  for (const filename of files) {
    const bytes = readPrivateBytes(filename, MAX_DURABLE_FILE_BYTES);
    bytes.fill(0);
  }
}

async function assertLiveNodeReady(wallet: KaspaWallet): Promise<void> {
  const info = await wallet.serverInfo();
  const rpc = await wallet.client();
  const dag = await rpc.getBlockDagInfo();
  if (
    !info.isSynced ||
    !info.hasUtxoIndex ||
    String(dag.network) !== LIVE_SDK_NETWORK ||
    !HASH32.test(String(dag.sink).toLowerCase())
  ) {
    throw new Error("live proof RPC is not a synced UTXO-indexed Testnet-10 node");
  }
}

function writePolicyOnce(filename: string, policy: Record<string, unknown>): void {
  if (secureFileExists(filename)) {
    const current = readPrivateJson<unknown>(filename);
    if (JSON.stringify(current) !== JSON.stringify(policy)) {
      throw new Error(`live proof policy ${filename} changed; refusing to widen it`);
    }
    return;
  }
  writeAtomicJson(filename, policy);
}

function readLiveProofConfig(filename: string): LiveProofConfig {
  const value = readPrivateJson<LiveProofConfig>(filename);
  const createdAtMs = canonicalIsoMilliseconds(value.createdAt);
  const reservationExpiresAtMs = canonicalIsoMilliseconds(value.reservationExpiresAt);
  if (
    value.version !== 1 ||
    !RUN_ID.test(value.runId) ||
    requireLiveNodeUrl(value.nodeUrl) !== value.nodeUrl ||
    path.resolve(value.sourceWalletDirectory) !== value.sourceWalletDirectory ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(reservationExpiresAtMs) ||
    createdAtMs > Date.now() + 5 * 60_000 ||
    reservationExpiresAtMs - createdAtMs < 2 * 60 * 60_000 ||
    reservationExpiresAtMs - createdAtMs > 2 * 60 * 60_000 + 60_000 ||
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

function canonicalIsoMilliseconds(value: unknown): number {
  if (typeof value !== "string" || value.length > 64) return Number.NaN;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return Number.NaN;
  }
  return milliseconds;
}

function requireLiveNodeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("SOMPI_NODE_URL is required for the live proof");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("SOMPI_NODE_URL is invalid", { cause: error });
  }
  if (
    !["ws:", "wss:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("SOMPI_NODE_URL must be an uncredentialed ws/wss endpoint");
  }
  return parsed.toString();
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
  if (!secureFileExists(filename)) {
    writePrivateText(filename, randomBytes(byteLength).toString("hex"));
  }
  const value = readPrivateText(filename, MAX_SECRET_FILE_BYTES).trim().toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${byteLength * 2}}$`).test(value)) {
    throw new Error(`${filename} contains invalid proof identity material`);
  }
  return value;
}

function loadOrCreateOwnerKey(filename: string): { readonly publicKey: string } {
  if (!secureFileExists(filename)) {
    const generated = generateOwnerKey();
    writePrivateText(filename, generated.privateKey);
  }
  const privateKeyHex = readPrivateText(filename, MAX_SECRET_FILE_BYTES).trim().toLowerCase();
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
  const bytes = Buffer.from(`${value}\n`, "utf8");
  try {
    writePrivateBytes(filename, bytes);
  } finally {
    bytes.fill(0);
  }
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
  if (!secureFileExists(filename)) return undefined;
  const value = readPrivateJson<MerchantVerifierState>(filename);
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
  const server = secureFileExists(serverFilename)
    ? readPrivateBytes(serverFilename, byteLength)
    : undefined;
  const client = secureFileExists(clientFilename)
    ? readPrivateBytes(clientFilename, byteLength)
    : undefined;
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
  const target = path.resolve(filename);
  const state = new SecureLocalStateDirectory(path.dirname(target), "live proof secret");
  state.createFileExclusive(path.basename(target), bytes, MAX_SECRET_FILE_BYTES);
}

function secureFileExists(filename: string): boolean {
  const target = path.resolve(filename);
  const state = new SecureLocalStateDirectory(path.dirname(target), "live proof state");
  return state.fileExists(path.basename(target));
}

function readPrivateBytes(filename: string, maxBytes: number): Buffer {
  const target = path.resolve(filename);
  const state = new SecureLocalStateDirectory(path.dirname(target), "live proof state");
  return state.readFile(path.basename(target), maxBytes);
}

function readPrivateText(filename: string, maxBytes: number): string {
  const bytes = readPrivateBytes(filename, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function readPrivateJson<T>(filename: string): T {
  const text = readPrivateText(filename, MAX_JSON_STATE_BYTES);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error("live proof JSON state is malformed", { cause: error });
  }
}
