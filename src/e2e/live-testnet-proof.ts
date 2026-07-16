import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  stableStringify,
  type ExactPaymentRequirements,
  type PaymentPayload,
} from "@kaspa-x402/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  ExactHeadRecord,
  ServerChainProvider,
  VoucherVerifier,
} from "@kaspa-x402/server";

import {
  AP2_AUTHORIZATION_STATUS_PATH,
  AP2_CHECKOUT_AUTHORIZATION_PATH,
  AP2_PAYMENT_AUTHORIZATION_PATH,
  Ap2AuthorityDecisionEvidenceVerifier,
  Ap2AuthorityModule,
  Ap2HttpCommerceAuthorizationModule,
  Ap2MerchantCheckoutVerifier,
  Ap2PaidResponseVerifier,
  SOMPI_CHECKOUT_HEADER,
  decodeAp2CommerceAuthorizationPresentation,
  encodeAp2CommerceAuthorizationAcceptance,
  encodeStageAcceptance,
} from "../adapters/ap2/index.js";
import {
  AUTHORITY_SIGNER,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  MERCHANT_RECEIPT_SIGNER,
  MERCHANT_SIGNER,
  PAYMENT_RECEIPT_SIGNER,
  fixedTrustStore,
} from "../adapters/ap2/test-fixtures.js";
import { Ap2HumanAuthorityDecisionProvider } from "../adapters/ap2/human-authority.js";
import {
  AbandonedStagingRecovery,
  JournalBatchChannelStore,
  SecureBatchChannelSigner,
  KaspaExactChainVerifier,
  KaspaStagingRecoveryModule,
  KaspaTestnet10AddressCodec,
  KaspaX402ExactPaymentModule,
  KaspaX402TreasuryStagingAdapter,
  KaspaX402PaymentRequirementsVerifier,
  KaspaX402ServerStorePaymentResponseLookup,
  ExactTransactionBuilder,
  RpcStagingRecoveryTransactionSubmitter,
  StagingKeyStore,
  VaultExactAttemptFundingBridge,
  VaultTreasuryStaging,
} from "../adapters/kaspa-x402/index.js";
import { ChainEvidenceModule } from "../chain-evidence/module.js";
import { ChainEvidenceExactOutputSource } from "../chain-evidence/exact-output-source.js";
import type { ChainObservationSource } from "../adapters/kaspa-x402/chain-verifier.js";
import { JournalChainEvidenceStore } from "../chain-evidence/journal-store.js";
import { HttpsAcceptedChainWitness, WrpcOperatorChainObserver } from "../chain-evidence/sources.js";
import { ChainEvidenceStagingRecoveryRaceSource } from "../chain-evidence/staging-recovery-source.js";
import {
  AuthorityDecisionEndpoint,
  AuthorityUnixDecisionClient,
  AuthorityUnixDecisionServer,
} from "../authority/endpoint.js";
import { AuthorityMacKeyFile } from "../authority/key-provider.js";
import { AUTHORITY_MAC_KEY_BYTES } from "../authority/protocol.js";
import { SqliteAuthorityDecisionStore } from "../authority/decision-store.js";
import { SqliteAuthorityReplayStore } from "../authority/replay-store.js";
import { AuthorityService } from "../authority/service.js";
import { SqliteDemoCommerceAuthorizationStore } from "../demo/commerce-authorization-store.js";
import { SqliteMerchantServerStateStore } from "../demo/merchant-server-store.js";
import {
  DemoMerchantFixture,
  type DemoMerchantOffer,
  type DemoMerchantPaidRequest,
  type DemoMerchantPaidResult,
} from "../demo/merchant-fixture.js";
import { SompiCheckoutTermsModule } from "../purchase/checkout-terms-module.js";
import { PurchaseApiClient } from "../api/client.js";
import {
  createPurchaseApplication,
  type PurchaseApplication,
  type PurchaseCreateRequest,
} from "../api/contracts.js";
import { generateAgentApiCredential } from "../api/credential.js";
import { startPurchaseApiServer } from "../api/server.js";
import type {
  PinnedHttpTransport,
  PinnedHttpTransportRequest,
  PinnedHttpTransportResponse,
} from "../http/pinned-transport.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";
import { EgressPolicy } from "../purchase/egress-policy.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
} from "../purchase/identity.js";
import {
  PurchaseCoordinator,
  type FulfilmentModule,
} from "../purchase/coordinator.js";
import { PurchaseJournal } from "../purchase/journal.js";
import type {
  PurchaseId,
  PurchaseIntent,
  PurchaseView,
  Sha256Digest,
} from "../purchase/types.js";
import {
  JournalAp2CommerceEvidenceSource,
  JournalChainTreasuryMetadataSource,
  JournalTreasuryStagingObservationSource,
  createJournalTreasuryStagingMetadataSource,
} from "../runtime/journal-sources.js";
import { VaultTreasuryModule } from "../treasury/vault-treasury.js";
import { createSompiMcpServer } from "../mcp/server.js";
import {
  Transaction,
  calculateTransactionFee,
  calculateTransactionMass,
} from "../kaspa-wasm.js";
import {
  LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
  LIVE_ADDITIVE_THRESHOLD_ATOMIC,
  LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
  LIVE_NETWORK,
  LIVE_PRICE_ATOMIC,
  LIVE_SDK_NETWORK,
  LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC,
  LiveMerchantExactVerifier,
  assertPublicReportExcludesPrivateState,
  assertPrivateFile,
  bootstrapLiveProof,
  initializeLiveProof,
  installAuthorityMacKeyPair,
  observeCurrentAddressOutpoint,
  privateStateFileExists,
  readPrivateJsonState,
  additiveHeadId,
  secureDirectory,
  sha256Hex,
  verifyLiveChainMilestoneInclusion,
  writeAtomicJson,
  type InitializedLiveProof,
  type LiveChainMilestone,
  type LiveObservedOutpoint,
  type LiveProofConfig,
  type LiveProofProgress,
  type MerchantVerifierState,
} from "./live-testnet-support.js";

const MERCHANT_ORIGIN = "https://merchant.example";
const RESOURCE_URL = `${MERCHANT_ORIGIN}/paid-resource`;
const RESOURCE_BODY = Buffer.from("Sompi live Testnet-10 AP2 + Kaspa-x402 resource\n", "utf8");
const AUTHORITY_TIMEOUT_MS = 5_000;
const PROOF_TIMEOUT_MS = 12 * 60_000;

export const LIVE_TESTNET_PROOF_PROFILE =
  "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2" as const;

export type LiveExactProfile = "standard-native" | "additive";
export type LivePurchaseIngress = "http-api" | "mcp-api-compatibility";

export interface LiveTestnetProofReport {
  readonly profile: typeof LIVE_TESTNET_PROOF_PROFILE;
  readonly generatedAt: string;
  readonly network: typeof LIVE_NETWORK;
  readonly chainMode: "operator-pinned-live-testnet-10-wrpc";
  readonly chainProvenance: {
    readonly nodeVersion: string;
    readonly nodeNetwork: "testnet-10";
    readonly nodeVirtualDaaScore: string;
    readonly nodeSynced: true;
    readonly nodeUtxoIndex: true;
    readonly kaspaWasmSourceCommit: "78257f273a26c4be085bab0f79437dee99ca8835";
    readonly kaspaWasmVersion: "2.0.1";
  };
  readonly liveKaspaTestnet10ExecutionProved: true;
  readonly exactProfile: LiveExactProfile;
  readonly purchaseIngress: LivePurchaseIngress;
  readonly ap2HumanPresentConformanceClaimed: false;
  readonly authorityMode: "in-process-local-auto-approved-test-fixture";
  readonly authorityIsolationAppliedToThisRun: false;
  readonly separateAuthorityIsolationProofAvailable: false;
  readonly merchantMode: "in-process-local-merchant-independent-wrpc-verifier";
  readonly protocolPins: typeof SUPPORTED_PROTOCOL_PROFILES;
  readonly bootstrapFunding: LiveChainMilestone;
  readonly additiveHead: {
    readonly created: LiveChainMilestone;
    readonly additiveContinuation?: LiveObservedOutpoint;
  };
  readonly vaultDeposit: LiveChainMilestone & {
    readonly covenantId: string;
    readonly requestedDepositAtomic: typeof LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC;
  };
  readonly purchase: {
    readonly id: PurchaseId;
    readonly state: "receipted";
    readonly paymentIdentifier: string;
    readonly checkoutDigest: Sha256Digest;
    readonly authorizationEvidenceDigest: Sha256Digest;
    readonly settlementEvidenceDigest: Sha256Digest;
    readonly fulfilmentDigest: Sha256Digest;
    readonly receiptEvidenceDigests: readonly Sha256Digest[];
  };
  readonly transactions: {
    readonly stagingTransactionId: string;
    readonly stagingOutpoint: string;
    readonly stagingObservedAtDaa: string;
    readonly stagingFinality: "accepted" | "confirmed";
    readonly exactTransactionId: string;
    readonly merchantOutpoint: string;
  };
  readonly exactFinality: {
    readonly merchantVerifier: "accepted";
    readonly merchantObservedAtDaa: string;
    readonly clientObserver: "accepted" | "confirmed";
    readonly clientObservedAtMs: number;
  };
  readonly economics: {
    readonly advertisedAmountAtomic: typeof LIVE_PRICE_ATOMIC;
    readonly merchantGainAtomic: typeof LIVE_PRICE_ATOMIC;
    readonly payerTransactionCostAtomic: string;
    readonly exactFeeAtomic: string;
    readonly minimumSdkFeeAtomic: string;
    readonly transactionMass: string;
    readonly transactionVersion: 0 | 1;
    readonly inputCount: 1 | 2;
    readonly outputCount: 1;
  };
  readonly idempotency: {
    readonly duplicatePurchaseReturnedSameId: true;
    readonly duplicateMerchantPaidRequestReturnedSameTransaction: true;
    readonly uniqueMerchantExactTransactions: 1;
  };
  readonly protocolSeparation: {
    readonly paidRequestExtensionKeys: readonly ["payment-identifier"];
    readonly ap2DataInX402Request: false;
  };
  readonly evidenceHandling: {
    readonly reportMode: "0600";
    readonly publicFactsOnly: true;
    readonly recoveryRecordStoredSeparately: true;
    readonly outputBlockDaaScoreMeaning: "utxo-creation-daa-observed-while-output-was-live";
    readonly acceptingBlockDaaScoreMeaning: "current-virtual-chain-accepting-block-header-daa";
  };
  readonly lifecycleLimitations: {
    readonly additiveChallenges: "offer-scoped-read-only-until-paid";
    readonly expiredRunAction: "fail-closed-recover-staging-and-require-new-explicit-run";
    readonly missingStateAction: "fail-closed-while-run-identity-survives-total-state-loss-requires-operator-accounting";
  };
}

export interface RunLiveTestnetProofOptions {
  readonly directory: string;
  readonly sourceWalletDirectory: string;
  readonly reportFilename: string;
  readonly exactProfile: LiveExactProfile;
  readonly purchaseIngress: LivePurchaseIngress;
  readonly onProgress?: (message: string) => void;
}

export async function runLiveTestnetProof(
  options: RunLiveTestnetProofOptions
): Promise<LiveTestnetProofReport> {
  if (options.exactProfile !== "standard-native" && options.exactProfile !== "additive") {
    throw new Error("live exact profile is unsupported");
  }
  if (options.purchaseIngress !== "http-api" && options.purchaseIngress !== "mcp-api-compatibility") {
    throw new Error("live Purchase ingress is unsupported");
  }
  assertLiveTestnetProofPaths(options);
  const initialized = initializeLiveProof(options.directory, options.sourceWalletDirectory);
  const resources: Array<() => void | Promise<void>> = [];
  let purchaseJournal: PurchaseJournal | undefined;
  try {
    resources.push(() => initialized.observerWallet.disconnect());
    resources.push(() => initialized.merchantWallet.disconnect());
    resources.push(() => initialized.treasuryWallet.disconnect());
    preflightLiveTestnetProofReportTarget(
      options.reportFilename,
      createPurchaseId(Buffer.from(initialized.config.purchaseEntropyHex, "hex"))
    );

    const bootstrap = await bootstrapLiveProof({
      initialized,
      onProgress: options.onProgress,
    });
    purchaseJournal = bootstrap.journal;
    resources.push(() => purchaseJournal?.close());
    options.onProgress?.("durable funding, additive head, and vault deposit are live");

    const exactStorePath = path.join(initialized.layout.root, "merchant", "exact.sqlite");
    const authorizationStorePath = path.join(
      initialized.layout.root,
      "merchant",
      "authorization.sqlite"
    );
    const existingPurchase = purchaseJournal.findPurchaseByRequestKey(
      liveRequestKey(initialized.config, options.exactProfile)
    );
    if (existingPurchase) {
      if (
        !privateStateFileExists(exactStorePath) ||
        !privateStateFileExists(authorizationStorePath) ||
        (existingPurchase.state !== "created" &&
          !privateStateFileExists(initialized.layout.merchantOfferPath)) ||
        (privateStateFileExists(initialized.layout.merchantVerifierStatePath) &&
          (!privateStateFileExists(initialized.layout.paidReplayCapsulePath) ||
            !privateStateFileExists(initialized.layout.merchantPaidIngressPath)))
      ) {
        throw new Error(
          "live Merchant continuity is missing; refusing to create replacement authorization or payment state"
        );
      }
    }

    const merchantStore = new SqliteMerchantServerStateStore(exactStorePath);
    resources.push(() => merchantStore.close());
    const authorizationStore = new SqliteDemoCommerceAuthorizationStore(authorizationStorePath);
    resources.push(() => authorizationStore.close());

    const authority = await createLiveAuthority(initialized);
    resources.push(() => authority.close());
    const additiveHeadMilestone = bootstrap.progress.additiveHead;
    if (!additiveHeadMilestone) throw new Error("live additive head milestone is unavailable");
    const additiveHeadOutpoint = parseOutpoint(additiveHeadMilestone.outpoint);
    const payTo = options.exactProfile === "additive"
      ? initialized.config.additiveHead.address
      : initialized.config.wallets.merchantAddress;
    const payToScriptPublicKey = new KaspaTestnet10AddressCodec().scriptPublicKeyForAddress(
      payTo,
      LIVE_NETWORK
    ).toLowerCase();
    const verifier = new LiveMerchantExactVerifier({
      wallet: initialized.merchantWallet,
      statePath: initialized.layout.merchantVerifierStatePath,
      expected: {
        profile: options.exactProfile,
        payTo,
        payToScriptPublicKey,
        ...(options.exactProfile === "additive"
          ? {
              head: {
                headId: additiveHeadId(initialized.config, additiveHeadMilestone.outpoint),
                headVersion: "0",
                transactionId: additiveHeadOutpoint.transactionId,
                index: additiveHeadOutpoint.index,
                amountAtomic: initialized.config.additiveHead.amountAtomic,
                scriptPublicKey: initialized.config.additiveHead.scriptPublicKey,
                redeemScript: initialized.config.additiveHead.redeemScript,
                additiveThresholdAtomic: initialized.config.additiveHead.additiveThresholdAtomic,
              },
            }
          : {}),
      },
    });
    const merchant = await createLiveMerchant(
      initialized,
      bootstrap.progress,
      merchantStore,
      authorizationStore,
      verifier,
      options.exactProfile
    );
    const merchantPaidEndpoint = new LiveMerchantPaidEndpoint({
      merchant,
      ingressPath: initialized.layout.merchantPaidIngressPath,
    });
    const expectedPurchaseId = createPurchaseId(
      Buffer.from(initialized.config.purchaseEntropyHex, "hex")
    );
    if (
      existingPurchase &&
      !["receipted", "denied", "cancelled", "expired", "failed_terminal"].includes(
        existingPurchase.state
      )
    ) {
      const resumed = await merchantPaidEndpoint.resumeDurableIngress(expectedPurchaseId);
      if (resumed) {
        options.onProgress?.("resumed the Merchant's durable paid ingress before client reconciliation");
      }
    }
    const transport = new LiveDemoPinnedTransport(
      merchant,
      merchantPaidEndpoint,
      expectedPurchaseId,
      initialized.layout.merchantOfferPath,
      initialized.layout.paidReplayCapsulePath
    );
    const composition = composeLiveCoordinator({
      initialized,
      journal: purchaseJournal,
      merchantStore,
      transport,
      authorityModule: authority.module,
      payTo,
    });
    const intent = purchaseIntent(initialized.config, options.exactProfile);
    const ingress = await createLivePurchaseIngress(
      composition.coordinator,
      options.purchaseIngress
    );
    resources.push(() => ingress.close());
    options.onProgress?.("running resumable AP2 authorization and Kaspa-x402 exact Purchase");
    const first = await drivePurchase(
      ingress.application,
      purchaseJournal,
      intent,
      expectedPurchaseId,
      options.onProgress
    );
    const duplicate = await ingress.application.purchase(purchaseCreateRequest(intent));
    if (duplicate.id !== first.id || duplicate.state !== "receipted") {
      throw new Error("duplicate live Purchase did not return the same receipted identity");
    }
    const replay = await transport.replayPaidRequest();
    const attempt = purchaseJournal.requirePaymentAttempt(first.id, 1);
    const spend = purchaseJournal.findSettlementForPurchase(first.id);
    if (!spend?.transactionId || replay.transactionId !== spend.transactionId) {
      throw new Error("duplicate Merchant paid request returned a different exact transaction");
    }
    const report = await createReport({
      initialized,
      progress: bootstrap.progress,
      journal: purchaseJournal,
      first,
      duplicate,
      transport,
      verifierState: verifier.state(),
      observedStaging: composition.observedStaging,
      clientChain: composition.clientChain,
      merchantStore,
      paymentIdentifier: attempt.identifier,
      exactProfile: options.exactProfile,
      purchaseIngress: options.purchaseIngress,
    });
    purchaseJournal.integrityCheck();
    writeLiveTestnetProofReport(options.reportFilename, report, initialized);
    options.onProgress?.("live Purchase reached receipted and the 0600 public-facts report is durable");
    return report;
  } finally {
    const errors: unknown[] = [];
    for (const close of resources.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "live proof cleanup failed");
    }
  }
}

export function writeLiveTestnetProofReport(
  filename: string,
  report: LiveTestnetProofReport,
  initialized: InitializedLiveProof
): void {
  assertExactReportSchema(report);
  assertSecretFreeReport(report);
  assertPublicReportExcludesPrivateState(report, initialized);
  if (privateStateFileExists(filename)) {
    const existing = readPrivateJsonState<LiveTestnetProofReport>(filename);
    assertExactReportSchema(existing);
    if (
      existing.profile !== report.profile ||
      existing.network !== report.network ||
      existing.purchase.id !== report.purchase.id ||
      existing.transactions.exactTransactionId !== report.transactions.exactTransactionId ||
      existing.bootstrapFunding.transactionId !== report.bootstrapFunding.transactionId ||
      existing.additiveHead.created.transactionId !==
        report.additiveHead.created.transactionId ||
      existing.vaultDeposit.transactionId !== report.vaultDeposit.transactionId
    ) {
      throw new Error("live proof report path belongs to a different immutable proof run");
    }
  }
  writeAtomicJson(filename, report);
  assertPrivateFile(filename);
}

export function preflightLiveTestnetProofReportTarget(
  filename: string,
  expectedPurchaseId: PurchaseId
): void {
  if (!privateStateFileExists(filename)) return;
  const existing = readPrivateJsonState<LiveTestnetProofReport>(filename);
  assertExactReportSchema(existing);
  if (existing.purchase.id !== expectedPurchaseId) {
    throw new Error("live proof report path belongs to a different proof identity");
  }
}

export function assertLiveTestnetProofPaths(
  options: Pick<RunLiveTestnetProofOptions, "directory" | "sourceWalletDirectory" | "reportFilename">
): void {
  const proofRoot = path.resolve(options.directory);
  const sourceRoot = path.resolve(options.sourceWalletDirectory);
  const report = path.resolve(options.reportFilename);
  if (pathsOverlap(proofRoot, sourceRoot)) {
    throw new Error("live proof and bootstrap source directories must be disjoint");
  }
  if (isSameOrDescendant(report, proofRoot) || isSameOrDescendant(report, sourceRoot)) {
    throw new Error("live proof report must be outside both private state directories");
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

interface LiveComposition {
  readonly coordinator: PurchaseCoordinator;
  readonly observedStaging: JournalTreasuryStagingObservationSource;
  readonly clientChain: ChainObservationSource;
}

function composeLiveCoordinator(input: {
  readonly initialized: InitializedLiveProof;
  readonly journal: PurchaseJournal;
  readonly merchantStore: SqliteMerchantServerStateStore;
  readonly transport: PinnedHttpTransport;
  readonly authorityModule: Ap2AuthorityModule;
  readonly payTo: string;
}): LiveComposition {
  const now = Date.now;
  const trust = fixedTrustStore();
  const config = input.initialized.config;
  const egress = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    limits: { requestTimeoutMs: 20_000 },
    now,
  });
  const checkout = new SompiCheckoutTermsModule({
    transport: input.transport,
    merchantCheckout: new Ap2MerchantCheckoutVerifier({
      trust,
      authorityAudience: AUTHORITY_SIGNER.issuer,
    }),
    paymentRequirements: new KaspaX402PaymentRequirementsVerifier(),
    now,
  });
  const commerceEvidence = new JournalAp2CommerceEvidenceSource({
    journal: input.journal,
    trust,
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    now,
  });
  const commerceAuthorization = new Ap2HttpCommerceAuthorizationModule({
    evidenceSource: commerceEvidence,
    transport: input.transport,
    now,
  });
  const keyStore = new StagingKeyStore({
    directory: input.initialized.layout.stagingKeyDirectory,
    now,
  });
  const chainEvidence = new ChainEvidenceModule(
    new WrpcOperatorChainObserver({ rpc: input.initialized.treasuryWallet, depthConfirmationDaa: 10, now }),
    new HttpsAcceptedChainWitness({
      baseUrl: "https://api-tn10.kaspa.org/",
      depthConfirmationDaa: 10,
      fetch: globalThis.fetch,
      now,
    }),
    new JournalChainEvidenceStore(input.journal),
    now
  );
  const staging = new VaultTreasuryStaging({
    vault: input.initialized.vault,
    wallet: input.initialized.treasuryWallet,
    keyStore,
    chainEvidence,
    finalityFloor: "accepted",
  });
  const canonicalStaging = createJournalTreasuryStagingMetadataSource(input.journal);
  const observedStaging = new JournalTreasuryStagingObservationSource(
    input.journal,
    canonicalStaging
  );
  const funding = new VaultExactAttemptFundingBridge({
    metadataSource: canonicalStaging,
    observedStagingSource: observedStaging,
    builder: new ExactTransactionBuilder({ keyStore, now }),
  });
  const clientChain = new ChainEvidenceExactOutputSource(chainEvidence, "accepted");
  const chainVerifier = new KaspaExactChainVerifier({
    stagingMetadata: new JournalChainTreasuryMetadataSource(
      canonicalStaging,
      observedStaging,
      now
    ),
    chain: clientChain,
    merchantResponses: new KaspaX402ServerStorePaymentResponseLookup({
      store: input.merchantStore,
      now,
    }),
    addressCodec: new KaspaTestnet10AddressCodec(),
    observationTimeoutMs: 5 * 60_000,
    now,
  });
  const paidResponseVerifier = new Ap2PaidResponseVerifier({
    evidenceSource: commerceEvidence,
    trust,
    expectedMerchantReceiptIssuer: MERCHANT_RECEIPT_SIGNER.issuer,
    expectedPaymentReceiptIssuer: PAYMENT_RECEIPT_SIGNER.issuer,
    now,
  });
  const treasuryStaging = new KaspaX402TreasuryStagingAdapter({
    driver: staging,
    now,
  });
  const payment = new KaspaX402ExactPaymentModule({
    funding,
    channelSigner: new SecureBatchChannelSigner(
      path.join(input.initialized.layout.root, "batch-channel-keys"),
      now
    ),
    channelStore: new JournalBatchChannelStore(input.journal, now),
    addressCodec: new KaspaTestnet10AddressCodec(),
    transport: input.transport,
    settlementVerifier: chainVerifier,
    recoveryObserver: chainVerifier,
    paidResponseVerifier,
    now,
  });
  const stagingRecovery = new KaspaStagingRecoveryModule({
    recovery: new AbandonedStagingRecovery({
      keyStore,
      recoveryAddress: input.initialized.treasuryWallet.address,
      observer: new ChainEvidenceStagingRecoveryRaceSource(chainEvidence, input.initialized.observerWallet, "accepted"),
      submitter: new RpcStagingRecoveryTransactionSubmitter({
        rpc: input.initialized.treasuryWallet,
        now,
      }),
      now,
    }),
    metadata: canonicalStaging,
    observedStaging,
    finalityFloor: "accepted",
  });
  const treasury = new VaultTreasuryModule({
    vault: input.initialized.vault,
    policy: {
      maxPerPaymentAtomic: "100000000",
      maxPerHourAtomic: "1000000000",
      approvalAboveAtomic: "0",
      allowlist: [input.payTo],
    },
    additionalCostCeilingAtomic: LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
    reservationTtlMs: 30 * 60_000,
    staging: treasuryStaging,
    stagingRecovery,
  });
  const coordinator = new PurchaseCoordinator(
    input.journal,
    egress,
    checkout,
    input.authorityModule,
    commerceAuthorization,
    treasury,
    payment,
    new PendingFulfilmentModule(),
    {
      now,
      entropy: (length: number) => {
        if (length === 16) return Buffer.from(config.purchaseEntropyHex, "hex");
        return Buffer.alloc(length, 0x4c);
      },
      workerId: `sompi-live-e2e-${config.runId}`,
      effectLeaseTtlMs: 20_000,
    }
  );
  return Object.freeze({ coordinator, observedStaging, clientChain });
}

class PendingFulfilmentModule implements FulfilmentModule {
  async obtain(): Promise<{ status: "pending" }> {
    return Object.freeze({ status: "pending" as const });
  }
}

export class LiveMerchantPaidEndpoint {
  constructor(private readonly options: Readonly<{
    merchant: Pick<DemoMerchantFixture, "handlePaid">;
    ingressPath: string;
  }>) {}

  async handlePaid(request: DemoMerchantPaidRequest): Promise<DemoMerchantPaidResult> {
    this.persistIngress(request);
    return this.options.merchant.handlePaid(request);
  }

  async resumeDurableIngress(
    expectedPurchaseId: PurchaseId
  ): Promise<DemoMerchantPaidResult | undefined> {
    if (!privateStateFileExists(this.options.ingressPath)) return undefined;
    const ingress = readMerchantPaidIngress(this.options.ingressPath, expectedPurchaseId);
    return this.handlePaid({
      purchaseId: ingress.purchaseId,
      merchantCheckout: ingress.merchantCheckout,
      paymentRequiredHeader: ingress.paymentRequiredHeader,
      paymentIdentifier: ingress.paymentIdentifier,
      headers: { "PAYMENT-SIGNATURE": ingress.paymentSignature },
    });
  }

  private persistIngress(request: DemoMerchantPaidRequest): void {
    const paymentSignature = request.headers["PAYMENT-SIGNATURE"];
    if (typeof paymentSignature !== "string" || paymentSignature.length === 0) {
      throw new Error("live Merchant ingress requires one PAYMENT-SIGNATURE");
    }
    const candidate = Object.freeze({
      version: 1 as const,
      purchaseId: request.purchaseId,
      merchantCheckout: request.merchantCheckout,
      paymentRequiredHeader: request.paymentRequiredHeader,
      paymentIdentifier: request.paymentIdentifier,
      paymentSignature,
    });
    if (privateStateFileExists(this.options.ingressPath)) {
      const current = readMerchantPaidIngress(this.options.ingressPath, request.purchaseId);
      const { firstReceivedAtMs: _ignored, ...currentRequest } = current;
      if (JSON.stringify(currentRequest) !== JSON.stringify(candidate)) {
        throw new Error("live Merchant ingress differs from its first durable paid request");
      }
      return;
    }
    writeAtomicJson(this.options.ingressPath, {
      ...candidate,
      firstReceivedAtMs: Date.now(),
    } satisfies MerchantPaidIngressRecord);
  }

}

export class LiveDemoPinnedTransport implements PinnedHttpTransport {
  private offerValue?: DemoMerchantOffer;
  private replayConfirmed = false;

  constructor(
    private readonly merchant: DemoMerchantFixture,
    private readonly merchantPaidEndpoint: LiveMerchantPaidEndpoint,
    private readonly purchaseId: PurchaseId,
    private readonly offerPath: string,
    private readonly replayCapsulePath: string
  ) {}

  async send(
    request: Readonly<PinnedHttpTransportRequest>
  ): Promise<PinnedHttpTransportResponse> {
    request.signal.throwIfAborted();
    const target = new URL(request.hop.url);
    if (target.origin !== MERCHANT_ORIGIN) throw new Error("live demo transport origin changed");
    const signature = oneRequestHeader(request.headers, "payment-signature");

    if (target.pathname === AP2_CHECKOUT_AUTHORIZATION_PATH) {
      return response(
        200,
        [],
        encodeStageAcceptance(
          await this.merchant.presentCheckoutMandate(
            decodeAp2CommerceAuthorizationPresentation(request.body)
          )
        )
      );
    }
    if (target.pathname === AP2_PAYMENT_AUTHORIZATION_PATH) {
      return response(
        200,
        [],
        encodeStageAcceptance(
          await this.merchant.presentPaymentMandate(
            decodeAp2CommerceAuthorizationPresentation(request.body)
          )
        )
      );
    }
    if (target.pathname === AP2_AUTHORIZATION_STATUS_PATH) {
      const status = await this.merchant.commerceAuthorizationStatus({
        purchaseId: this.purchaseId,
        paymentIdentifier: requiredQuery(target, "paymentIdentifier"),
        checkoutDigest: requiredQuery(target, "checkoutDigest") as Sha256Digest,
      });
      return status
        ? response(200, [], encodeAp2CommerceAuthorizationAcceptance(status))
        : response(404, [], new Uint8Array());
    }
    if (target.href !== RESOURCE_URL) throw new Error("live demo transport path is unsupported");
    const offer = await this.offer();
    if (!signature) {
      return response(
        offer.paymentRequired.status,
        [
          ...Object.entries(offer.paymentRequired.headers),
          [SOMPI_CHECKOUT_HEADER, offer.checkout.artifact],
        ],
        new Uint8Array()
      );
    }
    const decoded = decodePaymentSignatureHeader(signature);
    assertOnlyPaymentIdentifier(decoded);
    const paymentIdentifier = paymentIdentifierFromPayload(decoded, this.purchaseId);
    this.persistReplayCapsule(offer, {
      version: 1,
      purchaseId: this.purchaseId,
      merchantCheckout: offer.checkout.artifact,
      paymentRequiredHeader: offer.paymentRequired.headers["PAYMENT-REQUIRED"],
      paymentIdentifier,
      paymentSignature: signature,
    });
    const paid = await this.merchantPaidEndpoint.handlePaid({
      purchaseId: this.purchaseId,
      merchantCheckout: offer.checkout.artifact,
      paymentRequiredHeader: offer.paymentRequired.headers["PAYMENT-REQUIRED"],
      paymentIdentifier,
      headers: { "PAYMENT-SIGNATURE": signature },
    });
    return response(
      paid.response.status,
      Object.entries(paid.response.headers),
      paid.resource?.body ?? new Uint8Array()
    );
  }

  async replayPaidRequest(): Promise<{ readonly transactionId: string }> {
    const capsule = this.readReplayCapsule();
    const decoded = decodePaymentSignatureHeader(capsule.paymentSignature);
    assertOnlyPaymentIdentifier(decoded);
    if (paymentIdentifierFromPayload(decoded, this.purchaseId) !== capsule.paymentIdentifier) {
      throw new Error("live Merchant replay capsule payment identifier changed");
    }
    const paid = await this.merchantPaidEndpoint.handlePaid({
      purchaseId: capsule.purchaseId,
      merchantCheckout: capsule.merchantCheckout,
      paymentRequiredHeader: capsule.paymentRequiredHeader,
      paymentIdentifier: capsule.paymentIdentifier,
      headers: { "PAYMENT-SIGNATURE": capsule.paymentSignature },
    });
    if (!paid.evidence?.transactionId) {
      throw new Error("duplicate Merchant paid request produced no exact evidence");
    }
    this.replayConfirmed = true;
    return Object.freeze({ transactionId: paid.evidence.transactionId });
  }

  extensionKeys(): readonly ["payment-identifier"] {
    const decoded = decodePaymentSignatureHeader(this.readReplayCapsule().paymentSignature);
    assertOnlyPaymentIdentifier(decoded);
    return Object.freeze(["payment-identifier"] as const);
  }

  duplicateConfirmed(): true {
    if (!this.replayConfirmed) throw new Error("Merchant duplicate paid request was not exercised");
    return true;
  }

  private async offer(): Promise<DemoMerchantOffer> {
    if (this.offerValue) return this.offerValue;
    if (privateStateFileExists(this.offerPath)) {
      this.offerValue = await this.merchant.restoreOffer(
        readPersistedOffer(this.offerPath, this.purchaseId)
      );
      return this.offerValue;
    }
    const created = await this.merchant.offer(this.purchaseId);
    const paymentRequiredHeader = created.paymentRequired.headers["PAYMENT-REQUIRED"];
    if (typeof paymentRequiredHeader !== "string" || paymentRequiredHeader.length === 0) {
      throw new Error("live Merchant offer omitted PAYMENT-REQUIRED");
    }
    const record: PersistedLiveMerchantOffer = Object.freeze({
      version: 1,
      purchaseId: this.purchaseId,
      merchantCheckout: created.checkout.artifact,
      paymentRequiredHeader,
      issuedAtSec: created.checkout.issuedAtSec,
    });
    writeAtomicJson(this.offerPath, record);
    this.offerValue = await this.merchant.restoreOffer(record);
    return this.offerValue;
  }

  private persistReplayCapsule(
    offer: DemoMerchantOffer,
    capsule: Omit<PaidReplayCapsule, "firstPresentedAtMs">
  ): void {
    if (privateStateFileExists(this.replayCapsulePath)) {
      const current = this.readReplayCapsule();
      const { firstPresentedAtMs: _ignored, ...currentRequest } = current;
      if (JSON.stringify(currentRequest) !== JSON.stringify(capsule)) {
        throw new Error("live paid-request replay capsule changed");
      }
      return;
    }
    const firstPresentedAtMs = Date.now();
    if (firstPresentedAtMs >= offer.checkout.expiresAtSec * 1000) {
      throw new Error("live paid request cannot begin after Checkout expiry");
    }
    writeAtomicJson(this.replayCapsulePath, {
      ...capsule,
      firstPresentedAtMs,
    } satisfies PaidReplayCapsule);
  }

  private readReplayCapsule(): PaidReplayCapsule {
    return readPaidReplayCapsule(this.replayCapsulePath, this.purchaseId);
  }
}

interface PersistedLiveMerchantOffer {
  readonly version: 1;
  readonly purchaseId: PurchaseId;
  readonly merchantCheckout: string;
  readonly paymentRequiredHeader: string;
  readonly issuedAtSec: number;
}

interface PaidReplayCapsule {
  readonly version: 1;
  readonly purchaseId: PurchaseId;
  readonly merchantCheckout: string;
  readonly paymentRequiredHeader: string;
  readonly paymentIdentifier: string;
  readonly paymentSignature: string;
  readonly firstPresentedAtMs: number;
}

interface MerchantPaidIngressRecord {
  readonly version: 1;
  readonly purchaseId: PurchaseId;
  readonly merchantCheckout: string;
  readonly paymentRequiredHeader: string;
  readonly paymentIdentifier: string;
  readonly paymentSignature: string;
  readonly firstReceivedAtMs: number;
}

function readPersistedOffer(
  filename: string,
  expectedPurchaseId: PurchaseId
): PersistedLiveMerchantOffer {
  const value = readPrivateJsonState<PersistedLiveMerchantOffer>(filename);
  if (
    value.version !== 1 ||
    value.purchaseId !== expectedPurchaseId ||
    typeof value.merchantCheckout !== "string" ||
    value.merchantCheckout.length === 0 ||
    typeof value.paymentRequiredHeader !== "string" ||
    value.paymentRequiredHeader.length === 0 ||
    !Number.isSafeInteger(value.issuedAtSec) ||
    value.issuedAtSec <= 0
  ) {
    throw new Error("persisted live Merchant offer is invalid");
  }
  return value;
}

function readPaidReplayCapsule(
  filename: string,
  expectedPurchaseId: PurchaseId
): PaidReplayCapsule {
  const capsule = readPrivateJsonState<PaidReplayCapsule>(filename);
  if (
    capsule.version !== 1 ||
    capsule.purchaseId !== expectedPurchaseId ||
    typeof capsule.merchantCheckout !== "string" ||
    typeof capsule.paymentRequiredHeader !== "string" ||
    typeof capsule.paymentSignature !== "string" ||
    typeof capsule.paymentIdentifier !== "string" ||
    !Number.isSafeInteger(capsule.firstPresentedAtMs) ||
    capsule.firstPresentedAtMs <= 0 ||
    capsule.firstPresentedAtMs > Date.now()
  ) {
    throw new Error("live paid-request replay capsule is invalid");
  }
  return capsule;
}

function readMerchantPaidIngress(
  filename: string,
  expectedPurchaseId: PurchaseId
): MerchantPaidIngressRecord {
  const record = readPrivateJsonState<MerchantPaidIngressRecord>(filename);
  if (
    record.version !== 1 ||
    record.purchaseId !== expectedPurchaseId ||
    typeof record.merchantCheckout !== "string" ||
    typeof record.paymentRequiredHeader !== "string" ||
    typeof record.paymentSignature !== "string" ||
    typeof record.paymentIdentifier !== "string" ||
    !Number.isSafeInteger(record.firstReceivedAtMs) ||
    record.firstReceivedAtMs <= 0 ||
    record.firstReceivedAtMs > Date.now()
  ) {
    throw new Error("live Merchant paid ingress record is invalid");
  }
  return record;
}

export async function createLiveMerchant(
  initialized: InitializedLiveProof,
  progress: LiveProofProgress,
  store: SqliteMerchantServerStateStore,
  authorizationStore: SqliteDemoCommerceAuthorizationStore,
  verifier: LiveMerchantExactVerifier,
  exactProfile: LiveExactProfile
): Promise<DemoMerchantFixture> {
  const additiveHead = progress.additiveHead;
  if (!additiveHead) throw new Error("live KIP-10 additive head is not durably observed");
  const outpoint = parseOutpoint(additiveHead.outpoint);
  if (exactProfile === "additive") {
    await store.registerExactHead(Object.freeze({
      headId: additiveHeadId(initialized.config, additiveHead.outpoint),
      network: LIVE_NETWORK,
      payTo: initialized.config.additiveHead.address,
      templateId: "kaspa-x402-kip10-additive-v1",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      currentOutpoint: Object.freeze({ txid: outpoint.transactionId, index: outpoint.index }),
      currentAmount: LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
      scriptPublicKey: initialized.config.additiveHead.scriptPublicKey,
      redeemScript: initialized.config.additiveHead.redeemScript,
      additiveThresholdSompi: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
      version: "0",
      status: "available",
      createdAt: initialized.config.createdAt,
      updatedAt: initialized.config.createdAt,
    }) satisfies ExactHeadRecord);
  }
  const payTo = exactProfile === "additive"
    ? initialized.config.additiveHead.address
    : initialized.config.wallets.merchantAddress;
  return DemoMerchantFixture.create({
    merchantId: MERCHANT_SIGNER.issuer,
    merchantName: "Sompi Live Testnet-10 Merchant",
    merchantOrigin: MERCHANT_ORIGIN,
    merchantWebsite: `${MERCHANT_ORIGIN}/store`,
    payTo,
    paymentScheme: "exact",
    exactProfile,
    amountAtomic: LIVE_PRICE_ATOMIC,
    additionalCostCeilingAtomic: LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
    checkoutTtlMs: 5 * 60_000,
    authorityAudience: AUTHORITY_SIGNER.issuer,
    expectedAuthorityIssuer: AUTHORITY_SIGNER.issuer,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    resource: {
      identity: `resource:sompi:live-testnet10:${initialized.config.runId}`,
      url: RESOURCE_URL,
      method: "GET",
      mediaType: "text/plain; charset=utf-8",
      body: RESOURCE_BODY,
    },
    store,
    authorizationStore,
    addressCodec: new KaspaTestnet10AddressCodec(),
    chainProvider: merchantServerChainProvider(initialized),
    voucherVerifier: { verifyVoucher: () => false } satisfies VoucherVerifier,
    exactTransactionVerifier: verifier,
    serverPublicKey: `02${"11".repeat(32)}`,
    merchantCheckoutSigner: MERCHANT_SIGNER,
    merchantReceiptSigner: MERCHANT_RECEIPT_SIGNER,
    paymentReceiptSigner: PAYMENT_RECEIPT_SIGNER,
    ap2Trust: fixedTrustStore(),
    paidRequestContinuation: Object.freeze({
      authorizationPresentedAtSec(input) {
        if (!privateStateFileExists(initialized.layout.merchantPaidIngressPath)) {
          return undefined;
        }
        const expectedPurchaseId = createPurchaseId(
          Buffer.from(initialized.config.purchaseEntropyHex, "hex")
        );
        const ingress = readMerchantPaidIngress(
          initialized.layout.merchantPaidIngressPath,
          expectedPurchaseId
        );
        if (
          input.purchaseId !== ingress.purchaseId ||
          input.paymentIdentifier !== ingress.paymentIdentifier ||
          input.merchantCheckout !== ingress.merchantCheckout ||
          input.paymentRequiredHeader !== ingress.paymentRequiredHeader ||
          input.paymentSignature !== ingress.paymentSignature
        ) {
          throw new Error("live Merchant continuation differs from its durable paid request");
        }
        return Math.floor(ingress.firstReceivedAtMs / 1000);
      },
    }),
    now: Date.now,
  });
}

function merchantServerChainProvider(initialized: InitializedLiveProof): ServerChainProvider {
  return {
    getUtxo: async () => null,
    getVirtualDaaScore: async () =>
      String((await initialized.merchantWallet.serverInfo()).virtualDaaScore),
    estimateClaimFee: async () => "1",
    sendTransaction: async () => {
      throw new Error(
        "live exact broadcast must be performed and observed by the independent Merchant verifier"
      );
    },
  };
}

export async function createLiveAuthority(initialized: InitializedLiveProof): Promise<{
  readonly module: Ap2AuthorityModule;
  close(): Promise<void>;
}> {
  const root = initialized.layout.authorityRoot;
  const serverPrivate = path.join(root, "server-private");
  const clientRuntime = path.join(root, "client-runtime");
  const socketDirectory = path.join(root, "run");
  for (const directory of [serverPrivate, clientRuntime, socketDirectory]) {
    secureDirectory(directory);
  }
  const serverMac = path.join(serverPrivate, "ipc-mac.key");
  const clientMac = path.join(clientRuntime, "ipc-mac.key");
  installAuthorityMacKeyPair(serverMac, clientMac, AUTHORITY_MAC_KEY_BYTES);
  const serverReplay = new SqliteAuthorityReplayStore(
    path.join(serverPrivate, "replay.sqlite"),
    { now: Date.now }
  );
  const decisionStore = new SqliteAuthorityDecisionStore(
    path.join(serverPrivate, "decisions.sqlite")
  );
  const clientReplay = new SqliteAuthorityReplayStore(
    path.join(clientRuntime, "replay.sqlite"),
    { now: Date.now }
  );
  const humanDecision = new Ap2HumanAuthorityDecisionProvider({
    signer: AUTHORITY_SIGNER,
    trust: fixedTrustStore(),
    instrumentId: FIXED_INSTRUMENT_ID,
    prompt: { approve: async () => true },
    now: Date.now,
  });
  const service = new AuthorityService({
    replayStore: serverReplay,
    decisionStore,
    authenticationProvider: new AuthorityMacKeyFile(
      serverMac,
      initialized.config.authorityMacKeyId
    ),
    humanDecision,
    now: Date.now,
  });
  const socketPath = path.join(socketDirectory, "authority.sock");
  await removeStaleSocket(socketPath);
  const server = new AuthorityUnixDecisionServer({
    socketPath,
    timeoutMs: AUTHORITY_TIMEOUT_MS,
    endpoint: new AuthorityDecisionEndpoint(service),
  });
  try {
    await server.start();
  } catch (error) {
    clientReplay.close();
    serverReplay.close();
    decisionStore.close();
    throw error;
  }
  const module = new Ap2AuthorityModule({
    authenticationProvider: new AuthorityMacKeyFile(
      clientMac,
      initialized.config.authorityMacKeyId
    ),
    replayStore: clientReplay,
    transport: new AuthorityUnixDecisionClient({
      socketPath,
      timeoutMs: AUTHORITY_TIMEOUT_MS,
    }),
    verifier: new Ap2AuthorityDecisionEvidenceVerifier({
      trust: fixedTrustStore(),
      expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
      expectedInstrumentId: FIXED_INSTRUMENT_ID,
      now: Date.now,
      clockSkewSec: 0,
    }),
    now: Date.now,
  });
  return Object.freeze({
    module,
    async close() {
      await server.close();
      clientReplay.close();
      serverReplay.close();
      decisionStore.close();
    },
  });
}

export async function drivePurchase(
  application: PurchaseApplication,
  journal: PurchaseJournal,
  intent: PurchaseIntent,
  expectedPurchaseId: PurchaseId,
  onProgress?: (message: string) => void
): Promise<PurchaseView & { readonly state: "receipted" }> {
  const deadline = Date.now() + PROOF_TIMEOUT_MS;
  let current: PurchaseView;
  try {
    current = await application.purchase(purchaseCreateRequest(intent));
  } catch (error) {
    const existing = journal.findPurchaseByRequestKey(intent.requestKey);
    if (!existing || existing.id !== expectedPurchaseId) throw error;
    current = await application.recover(existing.id);
  }
  let priorState = "";
  while (current.state !== "receipted") {
    if (["denied", "failed_terminal"].includes(current.state)) {
      throw new Error(`live Purchase entered terminal state ${current.state}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `live Purchase remains ${current.state}; rerun the same command to resume purchase ${current.id}`
      );
    }
    if (current.state !== priorState) {
      onProgress?.(`live Purchase is ${current.state}`);
      priorState = current.state;
    }
    await delay(2_000);
    current = ["created", "terms_bound", "awaiting_authority", "authorised"].includes(
      current.state
    )
      ? await application.purchase(purchaseCreateRequest(intent))
      : await application.recover(current.id);
  }
  if (current.id !== expectedPurchaseId) {
    throw new Error("live Purchase identity differs from the durable proof run identity");
  }
  return current as PurchaseView & { readonly state: "receipted" };
}

export async function createLivePurchaseIngress(
  coordinator: PurchaseCoordinator,
  mode: LivePurchaseIngress,
  onRequestError?: (error: unknown) => void
): Promise<{ readonly application: PurchaseApplication; close(): Promise<void> }> {
  const credential = generateAgentApiCredential();
  const api = await startPurchaseApiServer({
    application: createPurchaseApplication(coordinator),
    credential,
    host: "127.0.0.1",
    port: 0,
    deadlineMs: PROOF_TIMEOUT_MS,
    maxPurchaseConcurrency: 4,
    onRequestError,
  });
  const apiClient = new PurchaseApiClient({
    baseUrl: api.baseUrl,
    credential,
    timeoutMs: PROOF_TIMEOUT_MS + 5_000,
  });
  if (mode === "http-api") {
    return Object.freeze({ application: apiClient, close: () => api.close() });
  }
  const server = createSompiMcpServer(apiClient, "alpha8-live-proof");
  const client = new Client({ name: "sompi-alpha8-live-proof", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const application: PurchaseApplication = Object.freeze({
    purchase: async (input: PurchaseCreateRequest, signal?: AbortSignal) =>
      mcpPurchaseView(client, "purchase", {
        requestKey: input.requestKey,
        url: input.url,
        method: input.method ?? "GET",
        ...(input.bodyBase64 === undefined ? {} : { bodyBase64: input.bodyBase64 }),
        ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
        ...(input.expectedMerchant === undefined
          ? {}
          : { expectedMerchant: input.expectedMerchant }),
      }, signal),
    status: async (purchaseId: string, signal?: AbortSignal) =>
      mcpPurchaseView(client, "purchase_status", { purchaseId }, signal),
    recover: async (purchaseId: string, signal?: AbortSignal) =>
      mcpPurchaseView(client, "purchase_recover", { purchaseId }, signal),
  });
  return Object.freeze({
    application,
    async close() {
      await client.close();
      await server.close();
      await api.close();
    },
  });
}

async function mcpPurchaseView(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<PurchaseView> {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    signal ? { signal } : undefined
  );
  if (result.isError || !Array.isArray(result.content) || result.content.length !== 1) {
    throw new Error(`live MCP ${name} failed safely`);
  }
  const item = result.content[0] as { type?: unknown; text?: unknown };
  if (item.type !== "text" || typeof item.text !== "string") {
    throw new Error(`live MCP ${name} returned malformed content`);
  }
  return JSON.parse(item.text) as PurchaseView;
}

function purchaseCreateRequest(intent: PurchaseIntent): PurchaseCreateRequest {
  return Object.freeze({
    requestKey: intent.requestKey,
    url: intent.resource.url,
    method: intent.resource.method,
    ...(intent.resource.body === undefined
      ? {}
      : { bodyBase64: Buffer.from(intent.resource.body).toString("base64") }),
    ...(intent.resource.mediaType === undefined
      ? {}
      : { mediaType: intent.resource.mediaType }),
    ...(intent.expectedMerchant === undefined
      ? {}
      : { expectedMerchant: Object.freeze({ ...intent.expectedMerchant }) }),
  });
}

async function createReport(input: {
  readonly initialized: InitializedLiveProof;
  readonly progress: LiveProofProgress;
  readonly journal: PurchaseJournal;
  readonly first: PurchaseView & { readonly state: "receipted" };
  readonly duplicate: PurchaseView;
  readonly transport: LiveDemoPinnedTransport;
  readonly verifierState: MerchantVerifierState;
  readonly observedStaging: JournalTreasuryStagingObservationSource;
  readonly clientChain: ChainObservationSource;
  readonly merchantStore: SqliteMerchantServerStateStore;
  readonly paymentIdentifier: string;
  readonly exactProfile: LiveExactProfile;
  readonly purchaseIngress: LivePurchaseIngress;
}): Promise<LiveTestnetProofReport> {
  const bootstrap = input.progress.bootstrap;
  const additiveHead = input.progress.additiveHead;
  const deposit = input.progress.vaultDeposit;
  if (!bootstrap || !additiveHead || !deposit) {
    throw new Error("live proof report is missing a durable funding milestone");
  }
  for (const milestone of [bootstrap, additiveHead, deposit]) {
    await verifyLiveChainMilestoneInclusion(
      milestone,
      input.initialized.observerWallet
    );
  }
  const terms = input.journal.requireCheckoutTerms(input.first.id);
  const authorization = input.journal.requireAuthorization(input.first.id);
  const attempt = input.journal.requirePaymentAttempt(input.first.id, 1);
  const economics = exactTransactionEconomics(
    input.journal.readPreparedPayment(input.first.id, 1),
    input.exactProfile
  );
  const stagingRecord = input.journal.findTreasuryStagingObservation(input.first.id, 1);
  const spend = input.journal.findSettlementForPurchase(input.first.id);
  const fulfilment = input.journal.findFulfilment(input.first.id);
  const receipts = input.journal.receipts(input.first.id);
  if (!stagingRecord || !spend?.transactionId || !spend.outpoint || !fulfilment || receipts.length !== 2) {
    throw new Error("receipted live Purchase is missing canonical evidence joins");
  }
  const staging = await input.observedStaging.read({
    purchaseId: input.first.id,
    paymentIdentifier: input.paymentIdentifier,
    evidenceDigest: stagingRecord.evidenceDigest,
  });
  const merchantIndex = parseOutpoint(spend.outpoint).index;
  const controller = new AbortController();
  const expectedMerchantOutputAmount = input.exactProfile === "additive"
    ? (BigInt(LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC) + BigInt(LIVE_PRICE_ATOMIC)).toString()
    : LIVE_PRICE_ATOMIC;
  const clientObservation = await input.clientChain.observeExactOutput({
    network: LIVE_NETWORK,
    transactionId: spend.transactionId,
    outpoint: spend.outpoint,
    outputIndex: merchantIndex,
    merchantAddress: terms.payTo,
    expectedAmountAtomic: expectedMerchantOutputAmount,
    expectedScriptPublicKey: new KaspaTestnet10AddressCodec().scriptPublicKeyForAddress(
      terms.payTo,
      LIVE_NETWORK
    ),
    minimumFinality: "accepted",
    deadlineAtMs: Date.now() + 5 * 60_000,
    signal: controller.signal,
  });
  if (clientObservation.status !== "observed") {
    throw new Error("independent client RPC did not observe the live exact payment output");
  }
  if (clientObservation.finality === "mempool") {
    throw new Error("independent client RPC observed only mempool finality for the live exact payment");
  }
  const continuation = input.exactProfile === "additive"
    ? await observeCurrentAddressOutpoint({
        wallet: input.initialized.observerWallet,
        address: input.initialized.config.additiveHead.address,
        outpoint: `${spend.transactionId}:0`,
        amountAtomic: expectedMerchantOutputAmount,
      })
    : undefined;
  const exactRecord = await input.merchantStore.loadExactPayment(spend.transactionId);
  const identifierRecord = await input.merchantStore.loadPaymentIdentifier(attempt.identifier);
  const exactPaymentCount = input.merchantStore.exactPaymentCount();
  if (
    !exactRecord ||
    exactRecord.transactionId !== spend.transactionId ||
    exactRecord.finality !== "accepted" ||
    identifierRecord?.transactionId !== spend.transactionId ||
    input.verifierState.transactionId !== spend.transactionId ||
    input.verifierState.state !== "observed" ||
    input.verifierState.finality !== "accepted" ||
    !input.verifierState.blockDaaScore ||
    exactPaymentCount !== 1 ||
    input.duplicate.id !== input.first.id ||
    input.duplicate.state !== "receipted" ||
    attempt.identifier !== input.paymentIdentifier
  ) {
    throw new Error("live Merchant, client, and Purchase exact facts are inconsistent");
  }
  const info = await input.initialized.observerWallet.serverInfo();
  if (
    info.isSynced !== true ||
    info.hasUtxoIndex !== true ||
    String(info.networkId) !== LIVE_SDK_NETWORK ||
    !/^[1-9][0-9]*$/.test(String(info.virtualDaaScore)) ||
    typeof info.serverVersion !== "string" ||
    info.serverVersion.length === 0
  ) {
    throw new Error("live report node provenance is invalid");
  }
  const stagingDepth = BigInt(info.virtualDaaScore) - BigInt(staging.blockDaaScore);
  const report: LiveTestnetProofReport = Object.freeze({
    profile: LIVE_TESTNET_PROOF_PROFILE,
    generatedAt: new Date().toISOString(),
    network: LIVE_NETWORK,
    chainMode: "operator-pinned-live-testnet-10-wrpc",
    chainProvenance: Object.freeze({
      nodeVersion: String(info.serverVersion),
      nodeNetwork: "testnet-10" as const,
      nodeVirtualDaaScore: String(info.virtualDaaScore),
      nodeSynced: true as const,
      nodeUtxoIndex: true as const,
      kaspaWasmSourceCommit: "78257f273a26c4be085bab0f79437dee99ca8835" as const,
      kaspaWasmVersion: "2.0.1" as const,
    }),
    liveKaspaTestnet10ExecutionProved: true,
    exactProfile: input.exactProfile,
    purchaseIngress: input.purchaseIngress,
    ap2HumanPresentConformanceClaimed: false,
    authorityMode: "in-process-local-auto-approved-test-fixture",
    authorityIsolationAppliedToThisRun: false,
    separateAuthorityIsolationProofAvailable: false,
    merchantMode: "in-process-local-merchant-independent-wrpc-verifier",
    protocolPins: SUPPORTED_PROTOCOL_PROFILES,
    bootstrapFunding: bootstrap,
    additiveHead: Object.freeze({
      created: additiveHead,
      ...(continuation === undefined ? {} : { additiveContinuation: continuation }),
    }),
    vaultDeposit: Object.freeze({
      ...deposit,
      requestedDepositAtomic: LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC,
    }),
    purchase: Object.freeze({
      id: input.first.id,
      state: "receipted" as const,
      paymentIdentifier: attempt.identifier,
      checkoutDigest: terms.checkoutDigest,
      authorizationEvidenceDigest: authorization.evidenceDigest,
      settlementEvidenceDigest: spend.evidenceDigest,
      fulfilmentDigest: fulfilment.bodyDigest,
      receiptEvidenceDigests: Object.freeze(
        receipts.map((receipt) => receipt.evidenceDigest).sort()
      ),
    }),
    transactions: Object.freeze({
      stagingTransactionId: staging.transactionId,
      stagingOutpoint: staging.outpoint,
      stagingObservedAtDaa: staging.blockDaaScore,
      stagingFinality: stagingDepth >= 10n ? "confirmed" as const : "accepted" as const,
      exactTransactionId: spend.transactionId,
      merchantOutpoint: spend.outpoint,
    }),
    exactFinality: Object.freeze({
      merchantVerifier: "accepted" as const,
      merchantObservedAtDaa: input.verifierState.blockDaaScore,
      clientObserver: clientObservation.finality,
      clientObservedAtMs: clientObservation.observedAtMs,
    }),
    economics,
    idempotency: Object.freeze({
      duplicatePurchaseReturnedSameId: true as const,
      duplicateMerchantPaidRequestReturnedSameTransaction: input.transport.duplicateConfirmed(),
      uniqueMerchantExactTransactions: 1 as const,
    }),
    protocolSeparation: Object.freeze({
      paidRequestExtensionKeys: input.transport.extensionKeys(),
      ap2DataInX402Request: false as const,
    }),
    evidenceHandling: Object.freeze({
      reportMode: "0600" as const,
      publicFactsOnly: true as const,
      recoveryRecordStoredSeparately: true as const,
      outputBlockDaaScoreMeaning:
        "utxo-creation-daa-observed-while-output-was-live" as const,
      acceptingBlockDaaScoreMeaning:
        "current-virtual-chain-accepting-block-header-daa" as const,
    }),
    lifecycleLimitations: Object.freeze({
      additiveChallenges: "offer-scoped-read-only-until-paid" as const,
      expiredRunAction: "fail-closed-recover-staging-and-require-new-explicit-run" as const,
      missingStateAction:
        "fail-closed-while-run-identity-survives-total-state-loss-requires-operator-accounting" as const,
    }),
  });
  assertSecretFreeReport(report);
  return report;
}

function exactTransactionEconomics(
  preparedBytes: Uint8Array,
  profile: LiveExactProfile
): LiveTestnetProofReport["economics"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(preparedBytes).toString("utf8"));
  } catch {
    throw new Error("live exact preparation is not JSON");
  }
  const record = parsed as {
    paymentPayload?: { payload?: { transaction?: unknown } };
    transactionId?: unknown;
  };
  const transactionJson = record.paymentPayload?.payload?.transaction;
  if (typeof transactionJson !== "string") {
    throw new Error("live exact preparation omitted its signed transaction");
  }
  const transaction = Transaction.deserializeFromSafeJSON(transactionJson);
  try {
    const transactionId = String(transaction.finalize()).toLowerCase();
    if (record.transactionId !== transactionId) {
      throw new Error("live exact preparation transaction identity changed");
    }
    const inputs = transaction.inputs;
    const outputs = transaction.outputs;
    if (
      inputs.length !== (profile === "additive" ? 2 : 1) ||
      outputs.length !== 1 ||
      transaction.version !== (profile === "additive" ? 1 : 0)
    ) {
      throw new Error("live exact transaction shape disagrees with its profile");
    }
    const inputTotal = inputs.reduce((sum, input) => {
      if (!input.utxo) throw new Error("live exact transaction omitted populated input facts");
      return sum + BigInt(input.utxo.amount);
    }, 0n);
    const outputTotal = outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
    const exactFee = inputTotal - outputTotal;
    const minimumFee = calculateTransactionFee(LIVE_SDK_NETWORK, transaction);
    const mass = calculateTransactionMass(LIVE_SDK_NETWORK, transaction);
    if (minimumFee === undefined || mass === undefined || exactFee < minimumFee) {
      throw new Error("live exact transaction fee or mass is invalid");
    }
    const merchantOutput = BigInt(outputs[0]!.value);
    const merchantGain = profile === "additive"
      ? merchantOutput - BigInt(LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC)
      : merchantOutput;
    const payerCost = BigInt(LIVE_PRICE_ATOMIC) + exactFee;
    if (merchantGain !== BigInt(LIVE_PRICE_ATOMIC)) {
      throw new Error("live exact merchant gain differs from the advertised price");
    }
    return Object.freeze({
      advertisedAmountAtomic: LIVE_PRICE_ATOMIC,
      merchantGainAtomic: LIVE_PRICE_ATOMIC,
      payerTransactionCostAtomic: payerCost.toString(),
      exactFeeAtomic: exactFee.toString(),
      minimumSdkFeeAtomic: minimumFee.toString(),
      transactionMass: mass.toString(),
      transactionVersion: transaction.version as 0 | 1,
      inputCount: inputs.length as 1 | 2,
      outputCount: 1 as const,
    });
  } finally {
    transaction.free();
  }
}

function purchaseIntent(config: LiveProofConfig, exactProfile: LiveExactProfile): PurchaseIntent {
  return Object.freeze({
    requestKey: liveRequestKey(config, exactProfile),
    resource: Object.freeze({ url: RESOURCE_URL, method: "GET" }),
    expectedMerchant: Object.freeze({
      id: MERCHANT_SIGNER.issuer,
      origin: MERCHANT_ORIGIN,
    }),
  });
}

function liveRequestKey(config: LiveProofConfig, exactProfile: LiveExactProfile) {
  return assertPurchaseRequestKey(`e2e:live-testnet10:${exactProfile}:${config.runId}`);
}

function response(
  status: number,
  headers: readonly (readonly [string, string])[],
  bytes: Uint8Array
): PinnedHttpTransportResponse {
  const body = Uint8Array.from(bytes);
  return {
    status,
    headers: Object.freeze(
      headers.map(([name, value]) => Object.freeze([name, value] as const))
    ),
    body: (async function* () {
      if (body.byteLength > 0) yield body;
    })(),
  };
}

function oneRequestHeader(
  headers: readonly (readonly [string, string])[],
  name: string
): string | undefined {
  const values = headers.filter(([candidate]) => candidate.toLowerCase() === name);
  if (values.length > 1) throw new Error(`duplicate ${name} request header`);
  return values[0]?.[1];
}

function paymentIdentifierFromPayload(payload: PaymentPayload, purchaseId: PurchaseId): string {
  const extension = payload.extensions?.["payment-identifier"] as
    | { info?: { id?: unknown } }
    | undefined;
  const value = extension?.info?.id;
  if (typeof value !== "string" || value !== createPaymentIdentifier(purchaseId, 1)) {
    throw new Error("live paid request payment identifier is invalid");
  }
  return value;
}

function assertOnlyPaymentIdentifier(payload: PaymentPayload): void {
  const keys = Object.keys(payload.extensions ?? {}).sort();
  if (keys.length !== 1 || keys[0] !== "payment-identifier") {
    throw new Error("live x402 paid request contained AP2 or non-standard correlation data");
  }
}

function requiredQuery(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error(`live demo authorization status requires ${name}`);
  }
  return values[0];
}

function parseOutpoint(value: string): { readonly transactionId: string; readonly index: number } {
  const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(value.toLowerCase());
  if (!match) throw new Error(`invalid live Testnet-10 outpoint ${value}`);
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`invalid live Testnet-10 outpoint index ${value}`);
  }
  return Object.freeze({ transactionId: match[1], index });
}

function requireHashValue(value: unknown, label: string): string {
  const canonical = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(canonical)) throw new Error(`${label} is invalid`);
  return canonical;
}

function requireHexValue(value: unknown, label: string): string {
  const canonical = String(value ?? "").toLowerCase();
  if (!/^(?:[a-f0-9]{2})+$/.test(canonical)) throw new Error(`${label} is invalid`);
  return canonical;
}

function requireAtomicValue(value: unknown, label: string): string {
  const canonical = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(canonical) || BigInt(canonical) > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${label} is invalid`);
  }
  return canonical;
}

function requireOutputIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 0xffff_ffff) {
    throw new Error("live exact output index is invalid");
  }
  return Number(value);
}

function requireExactTemplate(value: unknown): "kaspa-x402-kip10-additive-v1" {
  if (value !== "kaspa-x402-kip10-additive-v1") {
    throw new Error("live exact template is invalid");
  }
  return value;
}

function requireExactEncoding(value: unknown): "kaspa-sdk-safe-json-v2.0.0" {
  if (value !== "kaspa-sdk-safe-json-v2.0.0") {
    throw new Error("live exact transaction encoding is invalid");
  }
  return value;
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (["ECONNREFUSED", "ENOENT"].includes(error.code ?? "")) finish(false);
      else reject(error);
    });
  });
  if (active) throw new Error("live authority socket is already served by another process");
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("refusing to remove an unowned or non-socket authority path");
  }
  fs.unlinkSync(socketPath);
}

function assertSecretFreeReport(value: unknown): void {
  const forbiddenKey = /(private|secret|password|credential|mac.?key|signed.?evidence|artifact|raw)/i;
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (forbiddenKey.test(key)) throw new Error(`live proof report contains forbidden field ${key}`);
      visit(nested);
    }
  };
  visit(value);
  const encoded = JSON.stringify(value);
  if (/\b(?:wallet-key|agent-key|owner\.key|ipc-mac\.key)\b/i.test(encoded)) {
    throw new Error("live proof report contains a sensitive path");
  }
}

function assertExactReportSchema(report: LiveTestnetProofReport): void {
  exactKeys(report, [
    "ap2HumanPresentConformanceClaimed",
    "authorityIsolationAppliedToThisRun",
    "authorityMode",
    "bootstrapFunding",
    "additiveHead",
    "chainMode",
    "chainProvenance",
    "economics",
    "evidenceHandling",
    "exactProfile",
    "exactFinality",
    "generatedAt",
    "idempotency",
    "lifecycleLimitations",
    "liveKaspaTestnet10ExecutionProved",
    "merchantMode",
    "network",
    "profile",
    "protocolPins",
    "protocolSeparation",
    "purchaseIngress",
    "purchase",
    "separateAuthorityIsolationProofAvailable",
    "transactions",
    "vaultDeposit",
  ], "report");
  const milestoneKeys = [
    "acceptingBlockHash",
    "acceptingBlockDaaScore",
    "address",
    "amountAtomic",
    "blockDaaScore",
    "finality",
    "observationStartHash",
    "outpoint",
    "transactionId",
    "virtualDaaScore",
  ];
  exactKeys(report.bootstrapFunding, milestoneKeys, "bootstrap milestone");
  exactKeys(report.chainProvenance, [
    "kaspaWasmVersion", "nodeNetwork", "nodeSynced", "nodeUtxoIndex",
    "kaspaWasmSourceCommit", "nodeVersion", "nodeVirtualDaaScore",
  ], "chain provenance");
  exactKeys(
    report.additiveHead,
    report.exactProfile === "additive" ? ["additiveContinuation", "created"] : ["created"],
    "additive head"
  );
  exactKeys(report.additiveHead.created, milestoneKeys, "additive head milestone");
  if (report.exactProfile === "additive") {
    if (!report.additiveHead.additiveContinuation) {
      throw new Error("live additive report is missing its continuation");
    }
    exactKeys(report.additiveHead.additiveContinuation, [
      "address", "amountAtomic", "blockDaaScore", "finality", "outpoint",
      "transactionId", "virtualDaaScore",
    ], "additiveHead continuation");
  } else if (report.additiveHead.additiveContinuation !== undefined) {
    throw new Error("live standard-native report contains an additive continuation");
  }
  exactKeys(report.vaultDeposit, [
    ...milestoneKeys, "covenantId", "requestedDepositAtomic",
  ], "vault deposit");
  exactKeys(report.purchase, [
    "authorizationEvidenceDigest", "checkoutDigest", "fulfilmentDigest", "id",
    "paymentIdentifier", "receiptEvidenceDigests", "settlementEvidenceDigest", "state",
  ], "purchase");
  exactKeys(report.transactions, [
    "exactTransactionId", "merchantOutpoint", "stagingFinality", "stagingObservedAtDaa",
    "stagingOutpoint", "stagingTransactionId",
  ], "transactions");
  exactKeys(report.exactFinality, [
    "clientObservedAtMs", "clientObserver", "merchantObservedAtDaa", "merchantVerifier",
  ], "exact finality");
  exactKeys(report.economics, [
    "advertisedAmountAtomic", "exactFeeAtomic", "inputCount", "merchantGainAtomic",
    "minimumSdkFeeAtomic", "outputCount", "payerTransactionCostAtomic",
    "transactionMass", "transactionVersion",
  ], "exact economics");
  exactKeys(report.idempotency, [
    "duplicateMerchantPaidRequestReturnedSameTransaction",
    "duplicatePurchaseReturnedSameId",
    "uniqueMerchantExactTransactions",
  ], "idempotency");
  exactKeys(report.protocolSeparation, [
    "ap2DataInX402Request", "paidRequestExtensionKeys",
  ], "protocol separation");
  exactKeys(report.evidenceHandling, [
    "acceptingBlockDaaScoreMeaning", "outputBlockDaaScoreMeaning", "publicFactsOnly",
    "recoveryRecordStoredSeparately", "reportMode",
  ], "evidence handling");
  exactKeys(report.lifecycleLimitations, [
    "additiveChallenges", "expiredRunAction", "missingStateAction",
  ], "lifecycle limitations");
  if (
    JSON.stringify(report.protocolPins) !== JSON.stringify(SUPPORTED_PROTOCOL_PROFILES) ||
    report.ap2HumanPresentConformanceClaimed !== false ||
    report.authorityIsolationAppliedToThisRun !== false ||
    report.separateAuthorityIsolationProofAvailable !== false ||
    report.chainProvenance.nodeNetwork !== LIVE_SDK_NETWORK ||
    report.chainProvenance.nodeSynced !== true ||
    report.chainProvenance.nodeUtxoIndex !== true ||
    report.chainProvenance.kaspaWasmSourceCommit !==
      "78257f273a26c4be085bab0f79437dee99ca8835" ||
    report.chainProvenance.kaspaWasmVersion !== "2.0.1" ||
    report.economics.advertisedAmountAtomic !== LIVE_PRICE_ATOMIC ||
    report.economics.merchantGainAtomic !== LIVE_PRICE_ATOMIC ||
    (report.exactProfile !== "standard-native" && report.exactProfile !== "additive") ||
    (report.purchaseIngress !== "http-api" && report.purchaseIngress !== "mcp-api-compatibility") ||
    report.evidenceHandling.outputBlockDaaScoreMeaning !==
      "utxo-creation-daa-observed-while-output-was-live" ||
    report.evidenceHandling.acceptingBlockDaaScoreMeaning !==
      "current-virtual-chain-accepting-block-header-daa"
  ) {
    throw new Error("live proof report claims or protocol pins changed");
  }
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`live proof ${label} shape changed`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function liveReportDigest(report: LiveTestnetProofReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}
