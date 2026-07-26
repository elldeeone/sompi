import { lookup } from "node:dns/promises";

import {
  Ap2AuthorityDecisionEvidenceVerifier,
  Ap2AuthorityModule,
  loadAp2TrustStore,
} from "../adapters/ap2/index.js";
import {
  AuthorityUnixDecisionClient,
} from "../authority/endpoint.js";
import { AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS } from "../authority/transport.js";
import { AuthorityMacKeyFile } from "../authority/key-provider.js";
import { SqliteAuthorityReplayStore } from "../authority/replay-store.js";
import {
  JournalBatchChannelStore,
  JournalBatchVoucherAuthorizer,
  KaspaX402BatchCapitalModule,
  BatchRefundTreasuryOperationAdapter,
  HttpsBatchClaimRaceSource,
  KaspaX402BatchRefundModule,
  SecureBatchChannelSigner,
  KaspaTestnet10AddressCodec,
  KaspaX402BatchPaymentModule,
  KaspaX402ExactPaymentModule,
  KaspaX402PaymentModule,
  KaspaX402TreasuryStagingAdapter,
  KaspaX402PaymentRequirementsVerifier,
  AbandonedStagingRecovery,
  ExactTransactionBuilder,
  KaspaStagingRecoveryModule,
  RpcStagingRecoveryTransactionSubmitter,
  StagingKeyStore,
  WalletBatchChainSource,
} from "../adapters/kaspa-x402/index.js";
import {
  KaspaExactChainVerifier,
  type MerchantPaymentResponseLookup,
} from "../adapters/kaspa-x402/chain-verifier.js";
import { ChainEvidenceModule } from "../chain-evidence/module.js";
import { ChainEvidenceExactOutputSource } from "../chain-evidence/exact-output-source.js";
import { JournalChainEvidenceStore } from "../chain-evidence/journal-store.js";
import { HttpsAcceptedChainWitness, WrpcOperatorChainObserver } from "../chain-evidence/sources.js";
import { ChainEvidenceStagingRecoveryRaceSource } from "../chain-evidence/staging-recovery-source.js";
import { VaultExactAttemptFundingBridge } from "../adapters/kaspa-x402/exact-attempt-funding-bridge.js";
import { VaultTreasuryStaging } from "../adapters/kaspa-x402/vault-treasury-staging.js";
import { NodePinnedHttpTransport } from "../http/node-pinned-transport.js";
import type { PinnedHttpTransport } from "../http/pinned-transport.js";
import { createPinnedGetFetch } from "../http/pinned-fetch.js";
import { PolicyEngine } from "../policy.js";
import {
  PurchaseCoordinator,
  type FulfilmentModule,
} from "../purchase/coordinator.js";
import { SompiCheckoutTermsModule } from "../purchase/checkout-terms-module.js";
import {
  EgressPolicy,
  type EgressResolver,
} from "../purchase/egress-policy.js";
import { PurchaseJournal } from "../purchase/journal.js";
import { SompiPaidResponseVerifier } from "../purchase/paid-response-verifier.js";
import type { PurchaseModule, Sha256Digest } from "../purchase/types.js";
import { VaultTreasuryModule } from "../treasury/vault-treasury.js";
import { TreasuryOperationModule } from "../treasury/operations.js";
import {
  VaultDepositTreasuryOperationAdapter,
  VaultSendTreasuryOperationAdapter,
  WalletTreasuryOperationAdapter,
} from "../treasury/operation-adapters.js";
import { VaultManager, vaultStaticConfigurationDigest } from "../vault.js";
import { assertVaultConfigurationLineage, reconcileAppliedVaultMigrationFence } from "../vault-migration/lineage.js";
import { KaspaWallet } from "../wallet.js";
import {
  assertSompiPurchaseRuntimeConfig,
  secureRuntimeDirectory,
  type SompiPurchaseRuntimeConfig,
} from "./config.js";
import {
  JournalChainTreasuryMetadataSource,
  JournalTreasuryStagingObservationSource,
  createJournalTreasuryStagingMetadataSource,
} from "./journal-sources.js";
import { OwnerAuthorityClient } from "../authority/owner-authority.js";
import { TransferModule } from "../transfer/module.js";
import { WalletViewModule } from "../wallet-view/module.js";
import { FundingIntakeModule } from "../funding-intake/module.js";
import { PolicyChangeModule } from "../policy-change/module.js";
import { VaultMigrationModule } from "../vault-migration/module.js";

export interface SompiPurchaseRuntime {
  readonly purchase: PurchaseModule;
  readonly transfer: TransferModule;
  readonly walletView: WalletViewModule;
  readonly fundingIntake: FundingIntakeModule;
  readonly policyChange: PolicyChangeModule;
  readonly vaultMigration: VaultMigrationModule;
  readonly journal: PurchaseJournal;
  readonly wallet: KaspaWallet;
  readonly vault: VaultManager;
  readonly policy: PolicyEngine;
  readonly chainEvidence: ChainEvidenceModule;
  readonly treasuryOperations: TreasuryOperationModule;
  readonly batchCapital: KaspaX402BatchCapitalModule;
  readonly batchRefund: KaspaX402BatchRefundModule;
  close(): Promise<void>;
}

export interface SompiPurchaseRuntimeDependencies {
  readonly now?: () => number;
  readonly resolver?: EgressResolver;
  readonly transport?: PinnedHttpTransport;
  readonly merchantResponses?: MerchantPaymentResponseLookup;
  /** Explicitly scoped to hermetic tests; the production entrypoint never sets it. */
  readonly allowSameUserAuthorityForTests?: boolean;
}

/**
 * Production composition root. Every volatile protocol dependency terminates
 * here; the Purchase coordinator receives only its narrow Sompi-owned seams.
 */
export function createSompiPurchaseRuntime(
  config: SompiPurchaseRuntimeConfig,
  dependencies: SompiPurchaseRuntimeDependencies = {}
): SompiPurchaseRuntime {
  assertSompiPurchaseRuntimeConfig(config);
  const sameUserAuthorityTest =
    dependencies.allowSameUserAuthorityForTests === true;
  assertAuthorityProcessIsolation(
    config,
    sameUserAuthorityTest
  );
  const now = dependencies.now ?? Date.now;
  readClock(now);
  secureRuntimeDirectory(config.dataDirectory);

  // Validate read-only configuration before creating the wallet or opening
  // either durable store. A bad trust/policy/egress configuration must not
  // create signing material as a side effect of a failed start.
  const trust = loadAp2TrustStore(config.authority.paths.trust);
  const transport = dependencies.transport ?? new NodePinnedHttpTransport();
  const egress = new EgressPolicy({
    allowRules: config.egressAllowRules,
    resolver: dependencies.resolver ?? systemResolver,
    now,
  });
  const witnessUrl = new URL(config.witnessBaseUrl);
  const witnessEgress = new EgressPolicy({
    allowRules: [{
      hostname: witnessUrl.hostname,
      ports: [witnessUrl.port ? Number(witnessUrl.port) : 443],
    }],
    resolver: dependencies.resolver ?? systemResolver,
    limits: { maxRedirects: 0, maxResponseBodyBytes: 4 * 1024 * 1024 },
    now,
  });
  const witnessFetch = createPinnedGetFetch(witnessEgress, transport, now);
  const policy = new PolicyEngine(config.policy);
  const vault = new VaultManager(config.dataDirectory, config.networkId);
  let journal: PurchaseJournal | undefined;
  let authorityReplay: SqliteAuthorityReplayStore | undefined;
  try {
    journal = new PurchaseJournal(config.journalDatabase, {
      now,
      operatorManifestIdentity: config.operatorManifest.identity,
      admission: config.admission,
    });
    assertManifestVault(vault, journal, config);
    reconcileAppliedVaultMigrationFence({ vault, journal });
    const wallet = new KaspaWallet({
      networkId: config.networkId,
      dataDir: config.dataDirectory,
      nodeUrl: config.nodeUrl,
    });
    activateJournalPolicy(journal, policy);
    authorityReplay = new SqliteAuthorityReplayStore(
      config.authority.clientReplayDatabase,
      { now }
    );
    const runtimeJournal = journal;
    const runtimeAuthorityReplay = authorityReplay;
    const chainEvidence = new ChainEvidenceModule(
      new WrpcOperatorChainObserver({ rpc: wallet, depthConfirmationDaa: config.depthConfirmationDaa, now }),
      new HttpsAcceptedChainWitness({ baseUrl: config.witnessBaseUrl, depthConfirmationDaa: config.depthConfirmationDaa, fetch: witnessFetch, now }),
      new JournalChainEvidenceStore(journal),
      Object.freeze({
        settlement: config.finalityFloors.settlement,
        "direct-treasury": config.finalityFloors.directTreasury,
        vault: config.finalityFloors.vault,
        staging: config.finalityFloors.staging,
        "recovery-release": config.finalityFloors.recoveryRelease,
      }),
      now
    );
    const channelStore = new JournalBatchChannelStore(journal, now);
    const channelSigner = new SecureBatchChannelSigner(
      `${config.dataDirectory}/batch-channel-keys`,
      now
    );
    const addressCodec = new KaspaTestnet10AddressCodec();
    const batchChain = new WalletBatchChainSource(wallet);
    const treasuryOperations = new TreasuryOperationModule({
      journal,
      policy,
      adapters: [
        new WalletTreasuryOperationAdapter(
          wallet,
          chainEvidence,
        ),
        new VaultSendTreasuryOperationAdapter(
          vault,
          wallet,
          chainEvidence,
        ),
        new VaultDepositTreasuryOperationAdapter(
          vault,
          wallet,
          chainEvidence,
        ),
        new BatchRefundTreasuryOperationAdapter(
          journal,
          wallet,
          batchChain,
          channelSigner,
          chainEvidence,
          config.batchClaimFeeReserveAtomic,
          new HttpsBatchClaimRaceSource(
            config.witnessBaseUrl,
            batchChain,
            chainEvidence,
            journal,
            witnessFetch,
          ),
        ),
      ],
      feeCeilingAtomic: config.treasuryOperationFeeCeilingAtomic,
      directTreasuryRetries: config.admission.directTreasuryRetries,
    });
    const batchCapital = new KaspaX402BatchCapitalModule(
      journal,
      treasuryOperations,
      channelSigner,
      channelStore,
      now,
    );
    const batchRefund = new KaspaX402BatchRefundModule(journal, treasuryOperations);
    const checkout = new SompiCheckoutTermsModule({
      transport,
      paymentRequirements: new KaspaX402PaymentRequirementsVerifier({
        channelStore,
        claimFeeReserveAtomic: config.batchClaimFeeReserveAtomic,
      }),
      now,
    });
    const authorityVerifier = new Ap2AuthorityDecisionEvidenceVerifier({
      trust,
      expectedAuthorityIssuer: config.authority.issuer,
      expectedInstrumentId: config.authority.instrumentId,
      now,
      clockSkewSec: 0,
    });
    const authorityTransport = new AuthorityUnixDecisionClient({
      socketPath: config.authority.paths.socket,
      timeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
      ...(!sameUserAuthorityTest && config.authority.socketAccess
        ? {
            expectedSocketOwnerUserId:
              config.authority.socketAccess.expectedOwnerUserId,
            socketGroupId: config.authority.socketAccess.groupId,
          }
        : {}),
    });
    const authorityAuthentication = new AuthorityMacKeyFile(
      config.authority.paths.macKey,
      config.authority.keyId,
    );
    const authority = new Ap2AuthorityModule({
      authenticationProvider: authorityAuthentication,
      replayStore: authorityReplay,
      transport: authorityTransport,
      verifier: authorityVerifier,
      now,
    });
    const keyStore = new StagingKeyStore({
      directory: config.stagingKeyDirectory,
      now,
    });
    const staging = new VaultTreasuryStaging({
      vault, wallet, keyStore, chainEvidence,
    });
    const canonicalStaging = createJournalTreasuryStagingMetadataSource(journal);
    const observedStaging = new JournalTreasuryStagingObservationSource(
      journal,
      canonicalStaging
    );
    const funding = new VaultExactAttemptFundingBridge({
      metadataSource: canonicalStaging,
      observedStagingSource: observedStaging,
      builder: new ExactTransactionBuilder({ keyStore, now }),
    });
    const chainVerifier = new KaspaExactChainVerifier({
      stagingMetadata: new JournalChainTreasuryMetadataSource(
        canonicalStaging,
        observedStaging,
        now
      ),
      chain: new ChainEvidenceExactOutputSource(chainEvidence),
      merchantResponses:
        dependencies.merchantResponses ?? new AbsentMerchantPaymentResponseLookup(),
      addressCodec: new KaspaTestnet10AddressCodec(),
      now,
    });
    const paidResponseVerifier = new SompiPaidResponseVerifier();
    const treasuryStaging = new KaspaX402TreasuryStagingAdapter({
      driver: staging,
      now,
    });
    const exactPayment = new KaspaX402ExactPaymentModule({
      funding,
      channelSigner,
      channelStore,
      addressCodec,
      transport,
      settlementVerifier: chainVerifier,
      recoveryObserver: chainVerifier,
      paidResponseVerifier,
      now,
    });
    const batchPayment = new KaspaX402BatchPaymentModule({
      store: channelStore,
      signer: channelSigner,
      addressCodec,
      chain: batchChain,
      authorizer: new JournalBatchVoucherAuthorizer(
        journal,
        config.batchClaimFeeReserveAtomic
      ),
      claimFeeReserveAtomic: config.batchClaimFeeReserveAtomic,
      transport,
      paidResponseVerifier,
      now,
    });
    const payment = new KaspaX402PaymentModule(exactPayment, batchPayment);
    const ownerAuthority = new OwnerAuthorityClient({
      authenticationProvider: authorityAuthentication,
      transport: authorityTransport,
      trust,
      expectedAuthorityIssuer: config.authority.issuer,
      now,
    });
    const transfer = new TransferModule({
      journal,
      authority: ownerAuthority,
      treasury: treasuryOperations,
      source: () => {
        const current = vault.config();
        return Object.freeze({
          vaultAddress: current.address,
          vaultDigest: vaultStaticConfigurationDigest(current),
        });
      },
      manifest: () => config.operatorManifest.identity,
      finality: chainEvidence,
      now,
    });
    const fundingIntake = new FundingIntakeModule({
      wallet,
      vault,
      treasury: treasuryOperations,
    });
    const policyChange = new PolicyChangeModule({
      journal,
      policy,
      authority: ownerAuthority,
      manifest: () => config.operatorManifest.identity,
      vaultProtection: () => {
        const current = vault.config();
        return Object.freeze({
          digest: vaultStaticConfigurationDigest(current) as Sha256Digest,
          maximumOutflowAtomic: current.maxOutflowSompi,
        });
      },
      now,
    });
    const vaultMigration = new VaultMigrationModule({
      journal,
      vault,
      wallet,
      authority: ownerAuthority,
      everydayMaximumAtomic: () => policy.policy.maxSompiPerHour.toString(),
      manifest: () => config.operatorManifest.identity,
      now,
    });
    const walletView = new WalletViewModule({
      wallet,
      vault,
      journal,
      treasury: treasuryOperations,
      fundingIntake,
      policy,
      now,
    });
    const stagingRecovery = new KaspaStagingRecoveryModule({
      recovery: new AbandonedStagingRecovery({
        keyStore,
        recoveryAddress: wallet.address,
        observer: new ChainEvidenceStagingRecoveryRaceSource(
          chainEvidence,
          wallet
        ),
        submitter: new RpcStagingRecoveryTransactionSubmitter({ rpc: wallet, now }),
        now,
      }),
      metadata: canonicalStaging,
      observedStaging,
      finality: chainEvidence,
    });
    const treasury = new VaultTreasuryModule({
      vault,
      policy: () => purchasePolicy(policy),
      additionalCostCeilingAtomic: config.additionalCostCeilingAtomic,
      staging: treasuryStaging,
      stagingRecovery,
    });
    const purchase = new PurchaseCoordinator(
      journal,
      egress,
      checkout,
      authority,
      treasury,
      payment,
      new PendingFulfilmentModule(),
      {
        now,
        finality: chainEvidence,
      }
    );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      purchase,
      transfer,
      walletView,
      fundingIntake,
      policyChange,
      vaultMigration,
      journal,
      wallet,
      vault,
      policy,
      chainEvidence,
      treasuryOperations,
      batchCapital,
      batchRefund,
      close() {
        closePromise ??= closeRuntimeResources(
          wallet,
          runtimeAuthorityReplay,
          runtimeJournal
        );
        return closePromise;
      },
    });
  } catch (error) {
    const cleanupErrors = closeDurableStores(authorityReplay, journal);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Sompi Purchase runtime construction and cleanup failed"
      );
    }
    throw error;
  }
}

function assertManifestVault(
  vault: VaultManager,
  journal: PurchaseJournal,
  config: SompiPurchaseRuntimeConfig
): void {
  if (!vault.configured) {
    throw new Error("Operator Manifest vault has not been provisioned");
  }
  assertVaultConfigurationLineage({
    vault,
    journal,
    manifestVault: config.operatorManifest.manifest.vault,
    manifestIdentity: config.operatorManifest.identity,
  });
}

function assertAuthorityProcessIsolation(
  config: SompiPurchaseRuntimeConfig,
  allowSameUserForTests: boolean
): void {
  if (allowSameUserForTests) return;
  const currentUserId =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    currentUserId === undefined ||
    currentUserId === 0 ||
    !config.authority.socketAccess ||
    config.authority.socketAccess.expectedOwnerUserId === currentUserId
  ) {
    throw new Error(
      "sompi-mcp requires a non-root OS user distinct from sompi-authority"
    );
  }
}

class PendingFulfilmentModule implements FulfilmentModule {
  async obtain(): Promise<{ status: "pending" }> {
    return Object.freeze({ status: "pending" as const });
  }
}

/**
 * The public Merchant protocol has no generic status lookup in the pinned
 * profile. Returning absent causes recovery to observe Kaspa before replaying
 * the exact immutable paid request through the normal egress path.
 */
class AbsentMerchantPaymentResponseLookup
implements MerchantPaymentResponseLookup {
  async findByPaymentIdentifier(): Promise<undefined> {
    return undefined;
  }
}

async function systemResolver(hostname: string) {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return Object.freeze(
    answers.map((answer) => {
      if (answer.family !== 4 && answer.family !== 6) {
        throw new Error("system resolver returned an unsupported address family");
      }
      return Object.freeze({ address: answer.address, family: answer.family });
    })
  );
}

function purchasePolicy(policy: PolicyEngine) {
  const current = policy.policy;
  return Object.freeze({
    maxPerPaymentAtomic: current.maxSompiPerTx.toString(),
    maxPerHourAtomic: current.maxSompiPerHour.toString(),
    allowlist: Object.freeze([...current.allowlist]),
  });
}

function activateJournalPolicy(journal: PurchaseJournal, policy: PolicyEngine): void {
  let active;
  try {
    active = journal.requireActivePolicy();
  } catch {
    active = journal.installPolicy(purchasePolicy(policy));
  }
  policy.activate(Object.freeze({
    maxSompiPerTx: BigInt(active.maxPerPaymentAtomic),
    maxSompiPerHour: BigInt(active.maxPerHourAtomic),
    allowlist: [...active.allowlist],
  }));
}

async function closeRuntimeResources(
  wallet: KaspaWallet,
  authorityReplay: SqliteAuthorityReplayStore,
  journal: PurchaseJournal
): Promise<void> {
  const errors = closeDurableStores(authorityReplay, journal);
  try {
    await wallet.disconnect();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Sompi Purchase runtime cleanup failed");
  }
}

function closeDurableStores(
  authorityReplay: SqliteAuthorityReplayStore | undefined,
  journal: PurchaseJournal | undefined
): unknown[] {
  const errors: unknown[] = [];
  for (const close of [
    authorityReplay ? () => authorityReplay.close() : undefined,
    journal ? () => journal.close() : undefined,
  ]) {
    if (!close) continue;
    try {
      close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function readClock(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch (cause) {
    throw new Error("Sompi Purchase runtime clock is unavailable", { cause });
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Sompi Purchase runtime clock is unavailable");
  }
  return value;
}
