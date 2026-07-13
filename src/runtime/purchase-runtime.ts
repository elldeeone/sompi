import { lookup } from "node:dns/promises";

import {
  Ap2AuthorityDecisionEvidenceVerifier,
  Ap2AuthorityModule,
  Ap2HttpCommerceAuthorizationModule,
  Ap2MerchantCheckoutVerifier,
  loadAp2TrustStore,
} from "../adapters/ap2/index.js";
import { Ap2PaidResponseVerifier } from "../adapters/ap2/paid-response-verifier.js";
import {
  AuthorityUnixDecisionClient,
} from "../authority/endpoint.js";
import { AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS } from "../authority/transport.js";
import { AuthorityMacKeyFile } from "../authority/key-provider.js";
import { SqliteAuthorityReplayStore } from "../authority/replay-store.js";
import {
  ExactOnlyChannelSigner,
  ExactOnlyChannelStore,
  KaspaTestnet10AddressCodec,
  KaspaX402ExactPaymentModule,
  KaspaX402PaymentRequirementsVerifier,
  AbandonedStagingRecovery,
  Kip10ExactTransactionBuilder,
  KaspaStagingRecoveryModule,
  RpcStagingRecoveryTransactionSubmitter,
  StagingKeyStore,
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
import type { PurchaseModule } from "../purchase/types.js";
import { VaultTreasuryModule } from "../treasury/vault-treasury.js";
import { VaultManager, vaultStaticConfigurationDigest } from "../vault.js";
import { KaspaWallet } from "../wallet.js";
import {
  assertSompiPurchaseRuntimeConfig,
  secureRuntimeDirectory,
  type SompiPurchaseRuntimeConfig,
} from "./config.js";
import {
  JournalAp2CommerceEvidenceSource,
  JournalChainTreasuryMetadataSource,
  JournalTreasuryStagingObservationSource,
  createJournalTreasuryStagingMetadataSource,
} from "./journal-sources.js";

export interface SompiPurchaseRuntime {
  readonly purchase: PurchaseModule;
  readonly journal: PurchaseJournal;
  readonly wallet: KaspaWallet;
  readonly vault: VaultManager;
  readonly policy: PolicyEngine;
  readonly chainEvidence: ChainEvidenceModule;
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
  const policy = new PolicyEngine(config.policy);
  const vault = new VaultManager(config.dataDirectory, config.networkId);
  assertManifestVault(vault, config);
  const wallet = new KaspaWallet({
    networkId: config.networkId,
    dataDir: config.dataDirectory,
    nodeUrl: config.nodeUrl,
  });
  let journal: PurchaseJournal | undefined;
  let authorityReplay: SqliteAuthorityReplayStore | undefined;
  try {
    journal = new PurchaseJournal(config.journalDatabase, {
      now,
      operatorManifestIdentity: config.operatorManifest.identity,
      admission: config.admission,
    });
    authorityReplay = new SqliteAuthorityReplayStore(
      config.authority.clientReplayDatabase,
      { now }
    );
    const runtimeJournal = journal;
    const runtimeAuthorityReplay = authorityReplay;
    const chainEvidence = new ChainEvidenceModule(
      new WrpcOperatorChainObserver({ rpc: wallet, depthConfirmationDaa: config.depthConfirmationDaa, now }),
      new HttpsAcceptedChainWitness({ baseUrl: config.witnessBaseUrl, depthConfirmationDaa: config.depthConfirmationDaa, now }),
      new JournalChainEvidenceStore(journal),
      now
    );
    const checkout = new SompiCheckoutTermsModule({
      transport,
      merchantCheckout: new Ap2MerchantCheckoutVerifier({
        trust,
        authorityAudience: config.authority.issuer,
      }),
      paymentRequirements: new KaspaX402PaymentRequirementsVerifier(),
      now,
    });
    const authorityVerifier = new Ap2AuthorityDecisionEvidenceVerifier({
      trust,
      expectedAuthorityIssuer: config.authority.issuer,
      expectedInstrumentId: config.authority.instrumentId,
      now,
      clockSkewSec: 0,
    });
    const authority = new Ap2AuthorityModule({
      authenticationProvider: new AuthorityMacKeyFile(
        config.authority.paths.macKey,
        config.authority.keyId
      ),
      replayStore: authorityReplay,
      transport: new AuthorityUnixDecisionClient({
        socketPath: config.authority.paths.socket,
        timeoutMs: AUTHORITY_DECISION_TRANSPORT_TIMEOUT_MS,
        ...(!sameUserAuthorityTest && config.authority.socketAccess
          ? {
              expectedSocketOwnerUserId:
                config.authority.socketAccess.expectedOwnerUserId,
              socketGroupId: config.authority.socketAccess.groupId,
            }
          : {}),
      }),
      verifier: authorityVerifier,
      now,
    });
    const treasury = new VaultTreasuryModule({
      vault,
      policy: () => purchasePolicy(policy),
      additionalCostCeilingAtomic: config.additionalCostCeilingAtomic,
    });

    const keyStore = new StagingKeyStore({
      directory: config.stagingKeyDirectory,
      now,
    });
    const staging = new VaultTreasuryStaging({
      vault, wallet, keyStore, chainEvidence,
      finalityFloor: config.finalityFloors.staging,
    });
    const canonicalStaging = createJournalTreasuryStagingMetadataSource(journal);
    const observedStaging = new JournalTreasuryStagingObservationSource(
      journal,
      canonicalStaging
    );
    const funding = new VaultExactAttemptFundingBridge({
      metadataSource: canonicalStaging,
      observedStagingSource: observedStaging,
      builder: new Kip10ExactTransactionBuilder({ keyStore, now }),
    });
    const chainVerifier = new KaspaExactChainVerifier({
      stagingMetadata: new JournalChainTreasuryMetadataSource(
        canonicalStaging,
        observedStaging,
        now
      ),
      chain: new ChainEvidenceExactOutputSource(chainEvidence, config.finalityFloors.settlement),
      merchantResponses:
        dependencies.merchantResponses ?? new AbsentMerchantPaymentResponseLookup(),
      addressCodec: new KaspaTestnet10AddressCodec(),
      now,
    });
    const commerceEvidence = new JournalAp2CommerceEvidenceSource({
      journal,
      trust,
      expectedAuthorityIssuer: config.authority.issuer,
      expectedInstrumentId: config.authority.instrumentId,
      now,
    });
    const commerceAuthorization = new Ap2HttpCommerceAuthorizationModule({
      evidenceSource: commerceEvidence,
      transport,
      now,
    });
    const paidResponseVerifier = new Ap2PaidResponseVerifier({
      evidenceSource: commerceEvidence,
      trust,
      expectedMerchantReceiptIssuer: config.merchantReceiptIssuer,
      expectedPaymentReceiptIssuer: config.paymentReceiptIssuer,
      now,
    });
    const payment = new KaspaX402ExactPaymentModule({
      staging,
      funding,
      channelSigner: new ExactOnlyChannelSigner(),
      channelStore: new ExactOnlyChannelStore(),
      addressCodec: new KaspaTestnet10AddressCodec(),
      transport,
      settlementVerifier: chainVerifier,
      recoveryObserver: chainVerifier,
      paidResponseVerifier,
      now,
    });
    const stagingRecovery = new KaspaStagingRecoveryModule({
      recovery: new AbandonedStagingRecovery({
        keyStore,
        recoveryAddress: wallet.address,
        observer: new ChainEvidenceStagingRecoveryRaceSource(
          chainEvidence,
          wallet,
          config.finalityFloors.recoveryRelease
        ),
        submitter: new RpcStagingRecoveryTransactionSubmitter({ rpc: wallet, now }),
        now,
      }),
      metadata: canonicalStaging,
      observedStaging,
      finalityFloor: config.finalityFloors.recoveryRelease,
    });
    const purchase = new PurchaseCoordinator(
      journal,
      egress,
      checkout,
      authority,
      commerceAuthorization,
      treasury,
      payment,
      stagingRecovery,
      new PendingFulfilmentModule(),
      { now, effectiveFinalityFloor: config.finalityFloors.settlement }
    );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      purchase,
      journal,
      wallet,
      vault,
      policy,
      chainEvidence,
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
  config: SompiPurchaseRuntimeConfig
): void {
  if (!vault.configured) {
    throw new Error("Operator Manifest vault has not been provisioned");
  }
  const actual = vault.config();
  const expected = config.operatorManifest.manifest.vault;
  if (
    actual.template !== expected.template ||
    actual.ownerPublic !== expected.ownerPublic ||
    actual.agentPublic !== expected.agentPublic ||
    actual.maxOutflowSompi !== expected.maxOutflowSompi ||
    actual.windowSizeDaa !== expected.windowSizeDaa ||
    vault.initialAddress() !== expected.address ||
    vaultStaticConfigurationDigest(actual) !== expected.configDigest
  ) {
    throw new Error("provisioned vault does not match the Operator Manifest");
  }
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
    approvalAboveAtomic: current.requireApprovalAboveSompi.toString(),
    allowlist: Object.freeze([...current.allowlist]),
  });
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
