import * as path from "node:path";
import { createHash } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  stableStringify,
  type Hash32Hex,
} from "@kaspa-x402/core";
import type {
  ServerChainProvider,
  ServerChannelRecord,
  VoucherVerifier,
} from "@kaspa-x402/server";

import {
  AUTHORITY_SIGNER,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_MERCHANT_ORIGIN,
  fixedTrustStore,
} from "../adapters/ap2/authority-test-fixtures.js";
import {
  BatchRefundTreasuryOperationAdapter,
  JournalBatchChannelStore,
  JournalBatchVoucherAuthorizer,
  KaspaTestnet10AddressCodec,
  KaspaX402BatchCapitalModule,
  KaspaX402BatchClaimBuilder,
  KaspaX402BatchPaymentModule,
  KaspaX402BatchRefundModule,
  KaspaX402PaymentRequirementsVerifier,
  SecureBatchChannelSigner,
  WalletBatchChainSource,
  type BatchClaimRaceSource,
} from "../adapters/kaspa-x402/index.js";
import { ChainEvidenceModule } from "../chain-evidence/module.js";
import { JournalChainEvidenceStore } from "../chain-evidence/journal-store.js";
import {
  HttpsAcceptedChainWitness,
  WrpcOperatorChainObserver,
} from "../chain-evidence/sources.js";
import { DemoMerchantFixture } from "../demo/merchant-fixture.js";
import { SqliteMerchantServerStateStore } from "../demo/merchant-server-store.js";
import { EgressPolicy } from "../purchase/egress-policy.js";
import {
  assertPurchaseRequestKey,
  createPurchaseId,
  evidenceDigest,
} from "../purchase/identity.js";
import { PurchaseCoordinator } from "../purchase/coordinator.js";
import type { PurchaseJournal } from "../purchase/journal.js";
import { SompiPaidResponseVerifier } from "../purchase/paid-response-verifier.js";
import type { PurchaseIntent, PurchaseView } from "../purchase/types.js";
import { SompiCheckoutTermsModule } from "../purchase/checkout-terms-module.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";
import { PolicyEngine } from "../policy.js";
import {
  VaultDepositTreasuryOperationAdapter,
  VaultSendTreasuryOperationAdapter,
  WalletTreasuryOperationAdapter,
} from "../treasury/operation-adapters.js";
import {
  TreasuryOperationModule,
  type TreasuryOperationView,
} from "../treasury/operations.js";
import { VaultTreasuryModule } from "../treasury/vault-treasury.js";
import { Transaction } from "../kaspa-wasm.js";
import {
  LIVE_NETWORK,
  LIVE_SDK_NETWORK,
  assertPrivateFile,
  bootstrapLiveProof,
  initializeLiveProof,
  observeCurrentAddressOutpoint,
  privateStateFileExists,
  readPrivateJsonState,
  writeAtomicJson,
  type InitializedLiveProof,
  type LiveObservedOutpoint,
} from "./live-testnet-support.js";
import {
  LiveDemoPinnedTransport,
  LiveMerchantPaidEndpoint,
  createLiveAuthority,
  createLivePurchaseIngress,
  drivePurchase,
} from "./live-testnet-proof.js";

const MERCHANT_ORIGIN = "https://merchant.example";
const RESOURCE_URL = `${MERCHANT_ORIGIN}/paid-resource`;
const REFUND_ONLY_RESOURCE_URL = `${MERCHANT_ORIGIN}/refund-only`;
const RESOURCE_BODY = Buffer.from("Sompi live Testnet-10 batch resource\n", "utf8");
const BATCH_DEPOSIT_ATOMIC = "40000000";
const BATCH_MAXIMUM_ATOMIC = "10000000";
const BATCH_CHARGE_ATOMIC = "6000000";
const BATCH_CLAIM_FEE_ATOMIC = "2000000";
const CLAIM_DAA_LEAD = 6_000n;
const REFUND_PROOF_DAA_LEAD = 1_800n;
const PROOF_TIMEOUT_MS = 15 * 60_000;
const LIVE_CHAIN_EVIDENCE_FINALITY_POLICY = Object.freeze({
  settlement: "accepted",
  "direct-treasury": "accepted",
  vault: "accepted",
  staging: "accepted",
  "recovery-release": "accepted",
} as const);

export const LIVE_BATCH_PROOF_PROFILE =
  "urn:sompi:e2e:live-testnet10-generic-x402-batch:2" as const;

export async function resumeOrStartLiveBatchRefund(input: Readonly<{
  channelId: string;
  channelStatus: "active" | "retired" | "refundable" | "refunded" | "suspicious";
  treasury: Pick<TreasuryOperationModule, "status">;
  refund: Pick<KaspaX402BatchRefundModule, "refund">;
}>): Promise<TreasuryOperationView> {
  return input.channelStatus === "refunded"
    ? input.treasury.status(`batch.refund.${input.channelId}`)
    : input.refund.refund(input.channelId);
}

export interface LiveBatchProofReport {
  readonly profile: typeof LIVE_BATCH_PROOF_PROFILE;
  readonly generatedAt: string;
  readonly network: typeof LIVE_NETWORK;
  readonly protocolPins: typeof SUPPORTED_PROTOCOL_PROFILES;
  readonly node: {
    readonly version: string;
    readonly network: "testnet-10";
    readonly virtualDaaScore: string;
    readonly synced: true;
    readonly utxoIndex: true;
    readonly kaspaWasmSourceCommit: "78257f273a26c4be085bab0f79437dee99ca8835";
    readonly kaspaWasmVersion: "2.0.1";
  };
  readonly authority: {
    readonly mode: "in-process-local-auto-approved-test-fixture";
    readonly humanPresentConformanceClaimed: false;
  };
  readonly claimChannel: {
    readonly channelId: string;
    readonly deposit: LiveObservedOutpoint;
    readonly refundTimeoutDaa: string;
    readonly purchases: readonly [BatchPurchaseEvidence, BatchPurchaseEvidence];
    readonly authorizedCumulativeAtomic: "16000000";
    readonly chargedCumulativeAtomic: "12000000";
    readonly claimTransactionId: string;
    readonly claimAmountAtomic: "12000000";
    readonly claimFeeAtomic: typeof BATCH_CLAIM_FEE_ATOMIC;
    readonly payoutAmountAtomic: "10000000";
    readonly continuation: LiveObservedOutpoint;
    readonly chainEvidenceDigest: string;
    readonly chainEvidenceLevel: "accepted" | "depth-confirmed" | "consensus-final";
  };
  readonly refundChannel: {
    readonly channelId: string;
    readonly deposit: LiveObservedOutpoint;
    readonly refundTimeoutDaa: string;
    readonly observedBeforeBoundaryDaa: string;
    readonly observedAfterBoundaryDaa: string;
    readonly strictBoundarySatisfied: true;
    readonly refundTransactionId: string;
    readonly refundFeeAtomic: typeof BATCH_CLAIM_FEE_ATOMIC;
    readonly refundOutput: LiveObservedOutpoint;
  };
  readonly invariants: {
    readonly depositAuthorizedNoPurchase: true;
    readonly eachVoucherSeparatelyAuthorized: true;
    readonly voucherAmountsMonotonic: true;
    readonly claimContinuationEqualsFundingMinusActualCharge: true;
    readonly refundSubmittedOnlyAfterDaaGreaterThanTimeout: true;
    readonly privateStateExcluded: true;
  };
}

interface BatchPurchaseEvidence {
  readonly purchaseId: string;
  readonly requestKey: string;
  readonly state: "receipted";
  readonly paymentIdentifier: string;
  readonly maximumAuthorizedAtomic: typeof BATCH_MAXIMUM_ATOMIC;
  readonly actualChargeAtomic: typeof BATCH_CHARGE_ATOMIC;
  readonly signedCumulativeAtomic: string;
  readonly chargedCumulativeAtomic: string;
  readonly commitmentId: string;
}

export interface RunLiveBatchProofOptions {
  readonly directory: string;
  readonly sourceWalletDirectory: string;
  readonly reportFilename: string;
  readonly onProgress?: (message: string) => void;
}

export async function runLiveBatchProof(
  options: RunLiveBatchProofOptions
): Promise<LiveBatchProofReport> {
  const initialized = initializeLiveProof(options.directory, options.sourceWalletDirectory);
  const resources: Array<() => void | Promise<void>> = [];
  try {
    resources.push(() => initialized.observerWallet.disconnect());
    resources.push(() => initialized.merchantWallet.disconnect());
    resources.push(() => initialized.treasuryWallet.disconnect());
    const bootstrapped = await bootstrapLiveProof({ initialized, onProgress: options.onProgress });
    const journal = bootstrapped.journal;
    resources.push(() => journal.close());

    const chainEvidence = new ChainEvidenceModule(
      new WrpcOperatorChainObserver({
        rpc: initialized.treasuryWallet,
        depthConfirmationDaa: 10,
        now: Date.now,
      }),
      new HttpsAcceptedChainWitness({
        baseUrl: "https://api-tn10.kaspa.org/",
        depthConfirmationDaa: 10,
        fetch: globalThis.fetch,
        now: Date.now,
      }),
      new JournalChainEvidenceStore(journal),
      LIVE_CHAIN_EVIDENCE_FINALITY_POLICY,
      Date.now
    );
    const channelStore = new JournalBatchChannelStore(journal, Date.now);
    const clientSigner = new SecureBatchChannelSigner(
      path.join(initialized.layout.root, "batch-client-keys"),
      Date.now
    );
    const merchantSigner = new SecureBatchChannelSigner(
      path.join(initialized.layout.root, "batch-merchant-keys"),
      Date.now
    );
    const merchantKey = await merchantSigner.ensureChannelKey(
      `batch-merchant:${initialized.config.runId}`,
      evidenceDigest(`batch-merchant-key:${initialized.config.runId}`),
    );
    const batchChain = new WalletBatchChainSource(initialized.observerWallet);
    const claimRace: BatchClaimRaceSource = {
      async getVirtualDaaScore() {
        return batchChain.getVirtualDaaScore();
      },
      async observeClaimWinner() {
        return Object.freeze({
          status: "unknown" as const,
          detailDigest: evidenceDigest("live-refund-claim-race-not-observed"),
        });
      },
    };
    const policy = new PolicyEngine({
      maxSompiPerTx: 200_000_000n,
      maxSompiPerHour: 500_000_000n,
      allowlist: [],
    });
    const treasury = new TreasuryOperationModule({
      journal,
      policy,
      adapters: [
        new WalletTreasuryOperationAdapter(
          initialized.treasuryWallet,
          chainEvidence
        ),
        new VaultSendTreasuryOperationAdapter(
          initialized.vault,
          initialized.treasuryWallet,
          chainEvidence
        ),
        new VaultDepositTreasuryOperationAdapter(
          initialized.vault,
          initialized.treasuryWallet,
          chainEvidence
        ),
        new BatchRefundTreasuryOperationAdapter(
          journal,
          initialized.treasuryWallet,
          batchChain,
          clientSigner,
          chainEvidence,
          BATCH_CLAIM_FEE_ATOMIC,
          claimRace
        ),
      ],
      feeCeilingAtomic: "10000000",
    });
    const capital = new KaspaX402BatchCapitalModule(
      journal,
      treasury,
      clientSigner,
      channelStore,
      Date.now
    );
    const refund = new KaspaX402BatchRefundModule(journal, treasury);
    const currentDaa = BigInt(await batchChain.getVirtualDaaScore());
    const terms = loadOrCreateBatchTerms(
      path.join(initialized.layout.root, "batch-terms.json"),
      initialized.config.runId,
      currentDaa
    );

    const claimChannel = await openChannel({
      capital,
      initialized,
      merchantPublicKey: merchantKey.publicKey,
      operationKey: `alpha9.batch.claim.${initialized.config.runId}`,
      refundTimeoutDaa: terms.claimRefundTimeoutDaa,
      resourceUrl: RESOURCE_URL,
      onProgress: options.onProgress,
    });
    const refundChannel = await openChannel({
      capital,
      initialized,
      merchantPublicKey: merchantKey.publicKey,
      operationKey: `alpha9.batch.refund.${initialized.config.runId}`,
      refundTimeoutDaa: terms.refundProofTimeoutDaa,
      resourceUrl: REFUND_ONLY_RESOURCE_URL,
      onProgress: options.onProgress,
    });
    if (!claimChannel.channel || !refundChannel.channel) {
      throw new Error("live batch channels did not become active");
    }
    const claimDeposit = acceptedOperationOutpoint({
      journal,
      operationKey: claimChannel.treasury.operationKey,
      address: claimChannel.channel.escrowAddress,
      outpoint: `${claimChannel.treasury.transactionId}:0`,
      amountAtomic: BATCH_DEPOSIT_ATOMIC,
    });
    const refundDeposit = acceptedOperationOutpoint({
      journal,
      operationKey: refundChannel.treasury.operationKey,
      address: refundChannel.channel.escrowAddress,
      outpoint: `${refundChannel.treasury.transactionId}:0`,
      amountAtomic: BATCH_DEPOSIT_ATOMIC,
    });
    const observedBeforeBoundaryDaa = refundDeposit.virtualDaaScore;
    if (BigInt(observedBeforeBoundaryDaa) > BigInt(terms.refundProofTimeoutDaa)) {
      throw new Error("live refund proof reached its boundary before recording the locked state");
    }

    const merchantStore = new SqliteMerchantServerStateStore(
      path.join(initialized.layout.root, "batch-merchant", "state.sqlite")
    );
    resources.push(() => merchantStore.close());
    const existingMerchantChannel = await merchantStore.loadChannel(claimChannel.channel.id as Hash32Hex);
    if (!existingMerchantChannel) {
      await merchantStore.saveChannel(serverChannel(claimChannel.channel));
    } else if (
      existingMerchantChannel.channelId !== claimChannel.channel.id ||
      stableStringify(existingMerchantChannel.channelConfig) !== stableStringify(claimChannel.channel.config)
    ) {
      throw new Error("live Merchant channel state belongs to a different channel epoch");
    }
    const trackedEscrows = new Set<string>([claimChannel.channel.escrowAddress]);
    const chainProvider = liveBatchServerChainProvider(
      initialized,
      batchChain,
      trackedEscrows,
      chainEvidence,
      claimChannel.channel,
    );
    const claimBuilder = new KaspaX402BatchClaimBuilder(
      merchantSigner,
      { estimateClaimFee: async () => BATCH_CLAIM_FEE_ATOMIC }
    );
    const voucherVerifier: VoucherVerifier = {
      verifyVoucher(request) {
        return schnorr.verify(
          Buffer.from(request.voucher.signature, "hex"),
          Buffer.from(request.digest, "hex"),
          Buffer.from(request.clientPublicKey, "hex")
        );
      },
    };
    const merchant = await DemoMerchantFixture.create({
      merchantId: FIXED_MERCHANT_ORIGIN,
      merchantName: "Sompi Live Batch Merchant",
      merchantOrigin: MERCHANT_ORIGIN,
      payTo: initialized.config.wallets.merchantAddress,
      paymentScheme: "batch-settlement",
      amountAtomic: BATCH_MAXIMUM_ATOMIC,
      batchMinDepositSompi: BATCH_DEPOSIT_ATOMIC,
      batchRefundTimeoutDaa: terms.claimRefundTimeoutDaa,
      batchChargeAtomic: BATCH_CHARGE_ATOMIC,
      resource: {
        identity: `resource:sompi:live-batch:${initialized.config.runId}`,
        url: RESOURCE_URL,
        method: "GET",
        mediaType: "text/plain; charset=utf-8",
        body: RESOURCE_BODY,
      },
      store: merchantStore,
      addressCodec: new KaspaTestnet10AddressCodec(),
      chainProvider,
      voucherVerifier,
      claimBuilder,
      serverPublicKey: merchantKey.publicKey,
    });

    const authority = await createLiveAuthority(initialized);
    resources.push(() => authority.close());
    const purchaseEvidence: BatchPurchaseEvidence[] = [];
    for (let index = 1; index <= 2; index += 1) {
      const entropy = Buffer.alloc(16, 0x60 + index);
      const purchaseId = createPurchaseId(entropy);
      const stateRoot = path.join(initialized.layout.root, "batch-purchases", String(index));
      const paidEndpoint = new LiveMerchantPaidEndpoint({
        merchant,
        ingressPath: path.join(stateRoot, "paid-ingress.json"),
      });
      const transport = new LiveDemoPinnedTransport(
        merchant,
        paidEndpoint,
        purchaseId,
        path.join(stateRoot, "offer.json"),
        path.join(stateRoot, "replay.json")
      );
      const coordinator = composeBatchCoordinator({
        initialized,
        journal,
        merchantStore,
        transport,
        authorityModule: authority.module,
        channelStore,
        channelSigner: clientSigner,
        batchChain,
        chainEvidence,
        entropy,
        workerId: `sompi-live-batch-${index}`,
      });
      const ingress = await createLivePurchaseIngress(
        coordinator,
        index === 1 ? "http-api" : "mcp-api-compatibility",
        (error) => options.onProgress?.(
          `Sompi API internal diagnostic: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`
        )
      );
      resources.push(() => ingress.close());
      const intent = batchIntent(initialized.config.runId, index);
      const result = await drivePurchase(
        ingress.application,
        journal,
        intent,
        purchaseId,
        options.onProgress
      );
      const duplicate = await ingress.application.purchase({
        requestKey: intent.requestKey,
        url: intent.resource.url,
        method: intent.resource.method,
        expectedMerchant: intent.expectedMerchant,
      });
      if (duplicate.id !== result.id || duplicate.state !== "receipted") {
        throw new Error("live batch Purchase was not idempotent");
      }
      const channel = journal.requireBatchChannel(claimChannel.channel.id);
      const attempt = journal.requirePaymentAttempt(result.id, 1);
      const settlement = journal.findSettlementForPurchase(result.id);
      if (!settlement?.commitmentId) {
        throw new Error("live batch Purchase has no commitment settlement");
      }
      purchaseEvidence.push(Object.freeze({
        purchaseId: result.id,
        requestKey: intent.requestKey,
        state: "receipted" as const,
        paymentIdentifier: attempt.identifier,
        maximumAuthorizedAtomic: BATCH_MAXIMUM_ATOMIC,
        actualChargeAtomic: BATCH_CHARGE_ATOMIC,
        signedCumulativeAtomic: channel.signedCumulativeAtomic,
        chargedCumulativeAtomic: channel.chargedCumulativeAtomic,
        commitmentId: settlement.commitmentId,
      }));
    }

    const beforeClaim = journal.requireBatchChannel(claimChannel.channel.id);
    if (
      beforeClaim.signedCumulativeAtomic !== "16000000" ||
      beforeClaim.chargedCumulativeAtomic !== "12000000"
    ) {
      throw new Error("live batch voucher progression is not monotonic and exact");
    }
    const merchantChannelBeforeClaim = await merchantStore.loadChannel(
      claimChannel.channel.id as Hash32Hex
    );
    const openClaimAttempt = await merchantStore.loadOpenClaimAttempt(
      claimChannel.channel.id as Hash32Hex,
    );
    const claim =
      merchantChannelBeforeClaim &&
      merchantChannelBeforeClaim.claimedCumulativeAmount === "12000000" &&
      merchantChannelBeforeClaim.fundingAmount === "28000000" &&
      merchantChannelBeforeClaim.activeOutpoint.txid !== claimChannel.channel.activeOutpoint.txid
        ? Object.freeze({
            channel: merchantChannelBeforeClaim,
            transactionId: merchantChannelBeforeClaim.activeOutpoint.txid,
            finality: "accepted" as const,
            accepted: true as const,
          })
        : openClaimAttempt
          ? await recoverLiveBatchClaim({
              merchant,
              chainEvidence,
              channel: claimChannel.channel,
              transaction: openClaimAttempt.transaction,
              transactionId: openClaimAttempt.transactionId,
              merchantAddress: initialized.config.wallets.merchantAddress,
              chainProvider,
            })
        : await merchant.executeBatchClaim(claimChannel.channel.id as Hash32Hex);
    if (!claim.accepted || !claim.transactionId) {
      throw new Error("live batch claim was not accepted");
    }
    const claimChainEvidence = await observeAcceptedBatchClaim({
      chainEvidence,
      channel: claimChannel.channel,
      transactionId: claim.transactionId,
      merchantAddress: initialized.config.wallets.merchantAddress,
    });
    const continuation = await observeCurrentAddressOutpoint({
      wallet: initialized.observerWallet,
      address: claimChannel.channel.escrowAddress,
      outpoint: `${claim.transactionId}:1`,
      amountAtomic: "28000000",
    });

    options.onProgress?.(`waiting for strict batch refund boundary ${terms.refundProofTimeoutDaa}`);
    let observedAfterBoundaryDaa = observedBeforeBoundaryDaa;
    while (BigInt(observedAfterBoundaryDaa) <= BigInt(terms.refundProofTimeoutDaa)) {
      await delay(2_000);
      observedAfterBoundaryDaa = await batchChain.getVirtualDaaScore();
    }
    // A prior run can commit the refund and then stop before publishing the
    // public report (for example, because the report directory is unsafe).
    // Resume from the durable Treasury operation instead of trying to plan a
    // second refund against an already-refunded channel.
    const latestRefundChannel = journal.requireBatchChannel(refundChannel.channel.id);
    const refunded = await resumeOrStartLiveBatchRefund({
      channelId: refundChannel.channel.id,
      channelStatus: latestRefundChannel.status,
      treasury,
      refund,
    });
    if (refunded.state !== "completed" || !refunded.transactionId) {
      throw new Error("live batch refund did not complete");
    }
    const refundOutput = await observeCurrentAddressOutpoint({
      wallet: initialized.observerWallet,
      address: initialized.config.wallets.treasuryAddress,
      outpoint: `${refunded.transactionId}:0`,
      amountAtomic: "38000000",
    });
    const info = await initialized.observerWallet.serverInfo();
    assertReadyNode(info);
    const report: LiveBatchProofReport = Object.freeze({
      profile: LIVE_BATCH_PROOF_PROFILE,
      generatedAt: new Date().toISOString(),
      network: LIVE_NETWORK,
      protocolPins: SUPPORTED_PROTOCOL_PROFILES,
      node: Object.freeze({
        version: String(info.serverVersion),
        network: "testnet-10" as const,
        virtualDaaScore: String(info.virtualDaaScore),
        synced: true as const,
        utxoIndex: true as const,
        kaspaWasmSourceCommit: "78257f273a26c4be085bab0f79437dee99ca8835" as const,
        kaspaWasmVersion: "2.0.1" as const,
      }),
      authority: Object.freeze({
        mode: "in-process-local-auto-approved-test-fixture" as const,
        humanPresentConformanceClaimed: false as const,
      }),
      claimChannel: Object.freeze({
        channelId: claimChannel.channel.id,
        deposit: claimDeposit,
        refundTimeoutDaa: terms.claimRefundTimeoutDaa,
        purchases: Object.freeze(purchaseEvidence) as unknown as readonly [BatchPurchaseEvidence, BatchPurchaseEvidence],
        authorizedCumulativeAtomic: "16000000" as const,
        chargedCumulativeAtomic: "12000000" as const,
        claimTransactionId: claim.transactionId,
        claimAmountAtomic: "12000000" as const,
        claimFeeAtomic: BATCH_CLAIM_FEE_ATOMIC,
        payoutAmountAtomic: "10000000" as const,
        continuation,
        chainEvidenceDigest: claimChainEvidence.detailDigest,
        chainEvidenceLevel: claimChainEvidence.level,
      }),
      refundChannel: Object.freeze({
        channelId: refundChannel.channel.id,
        deposit: refundDeposit,
        refundTimeoutDaa: terms.refundProofTimeoutDaa,
        observedBeforeBoundaryDaa,
        observedAfterBoundaryDaa,
        strictBoundarySatisfied: true as const,
        refundTransactionId: refunded.transactionId,
        refundFeeAtomic: BATCH_CLAIM_FEE_ATOMIC,
        refundOutput,
      }),
      invariants: Object.freeze({
        depositAuthorizedNoPurchase: true as const,
        eachVoucherSeparatelyAuthorized: true as const,
        voucherAmountsMonotonic: true as const,
        claimContinuationEqualsFundingMinusActualCharge: true as const,
        refundSubmittedOnlyAfterDaaGreaterThanTimeout: true as const,
        privateStateExcluded: true as const,
      }),
    });
    journal.integrityCheck();
    writeLiveBatchReport(options.reportFilename, report);
    options.onProgress?.("live batch vouchers, claim, and strict-boundary refund are durable");
    return report;
  } finally {
    const errors: unknown[] = [];
    for (const close of resources.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "live batch proof cleanup failed");
  }
}

export async function recoverLiveBatchClaim(input: Readonly<{
  merchant: DemoMerchantFixture;
  chainEvidence: ChainEvidenceModule;
  channel: LiveBatchClaimEvidenceChannel;
  transaction: string;
  transactionId?: string;
  merchantAddress: string;
  chainProvider: LiveBatchServerChainProvider;
}>) {
  const transactionId = input.transactionId ?? exactTransactionId(input.transaction);
  const evidence = await observeAcceptedBatchClaim({
    chainEvidence: input.chainEvidence,
    channel: input.channel,
    transactionId,
    merchantAddress: input.merchantAddress,
  });
  input.chainProvider.acceptIndependentEvidence(transactionId);
  return input.merchant.recoverBatchClaim(input.channel.id as Hash32Hex, {
    transactionId: transactionId as Hash32Hex,
    finality: evidence.level === "accepted" ? "accepted" : "confirmed",
  });
}

function exactTransactionId(safeJson: string): string {
  const transaction = Transaction.deserializeFromSafeJSON(safeJson);
  try {
    return String(transaction.finalize()).toLowerCase();
  } finally {
    transaction.free();
  }
}

function composeBatchCoordinator(input: {
  readonly initialized: InitializedLiveProof;
  readonly journal: PurchaseJournal;
  readonly merchantStore: SqliteMerchantServerStateStore;
  readonly transport: LiveDemoPinnedTransport;
  readonly authorityModule: Awaited<ReturnType<typeof createLiveAuthority>>["module"];
  readonly channelStore: JournalBatchChannelStore;
  readonly channelSigner: SecureBatchChannelSigner;
  readonly batchChain: WalletBatchChainSource;
  readonly chainEvidence: ChainEvidenceModule;
  readonly entropy: Buffer;
  readonly workerId: string;
}): PurchaseCoordinator {
  const trust = fixedTrustStore();
  const egress = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    limits: { requestTimeoutMs: 20_000 },
    now: Date.now,
  });
  const checkout = new SompiCheckoutTermsModule({
    transport: input.transport,
    paymentRequirements: new KaspaX402PaymentRequirementsVerifier({
      channelStore: input.channelStore,
      claimFeeReserveAtomic: BATCH_CLAIM_FEE_ATOMIC,
    }),
    now: Date.now,
  });
  const paid = new SompiPaidResponseVerifier();
  const payment = new KaspaX402BatchPaymentModule({
    store: input.channelStore,
    signer: input.channelSigner,
    addressCodec: new KaspaTestnet10AddressCodec(),
    chain: input.batchChain,
    authorizer: new JournalBatchVoucherAuthorizer(input.journal, BATCH_CLAIM_FEE_ATOMIC),
    claimFeeReserveAtomic: BATCH_CLAIM_FEE_ATOMIC,
    transport: input.transport,
    paidResponseVerifier: paid,
    now: Date.now,
  });
  const unavailableStaging = {
    async prepareStaging() { throw new Error("batch execution must not stage exact funding"); },
    async submitStaging() { throw new Error("batch execution must not submit exact staging"); },
    async observeStaging() { throw new Error("batch execution must not observe exact staging"); },
  };
  const unavailableRecovery = {
    async prepare() { throw new Error("batch execution has no exact staging recovery"); },
    async observe() { throw new Error("batch execution has no exact staging recovery"); },
    async submit() { throw new Error("batch execution has no exact staging recovery"); },
  };
  const treasury = new VaultTreasuryModule({
    vault: input.initialized.vault,
    policy: {
      maxPerPaymentAtomic: "100000000",
      maxPerHourAtomic: "500000000",
      allowlist: [input.initialized.config.wallets.merchantAddress],
    },
    additionalCostCeilingAtomic: "0",
    reservationTtlMs: 30 * 60_000,
    staging: unavailableStaging,
    stagingRecovery: unavailableRecovery,
  });
  return new PurchaseCoordinator(
    input.journal,
    egress,
    checkout,
    input.authorityModule,
    treasury,
    payment,
    { async obtain() { return { status: "pending" as const }; } },
    {
      now: Date.now,
      entropy: (length) => {
        if (length === 16) return Buffer.from(input.entropy);
        return createHash("sha256")
          .update("sompi:live-batch-entropy:v1\0", "utf8")
          .update(input.entropy)
          .digest()
          .subarray(0, length);
      },
      workerId: input.workerId,
      effectLeaseTtlMs: 20_000,
      finality: input.chainEvidence,
    }
  );
}

function acceptedOperationOutpoint(input: {
  readonly journal: PurchaseJournal;
  readonly operationKey: string;
  readonly address: string;
  readonly outpoint: string;
  readonly amountAtomic: string;
}): LiveObservedOutpoint {
  const separator = input.outpoint.lastIndexOf(":");
  const transactionId = input.outpoint.slice(0, separator);
  const index = Number(input.outpoint.slice(separator + 1));
  if (!/^[a-f0-9]{64}$/.test(transactionId) || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("live batch durable outpoint is invalid");
  }
  const evidence = input.journal.findCompletedTreasuryOperationChainEvidence(
    input.operationKey
  );
  if (
    !evidence ||
    evidence.transactionId !== transactionId ||
    !evidence.acceptingBlockDaaScore ||
    !evidence.virtualDaaScore ||
    (evidence.level !== "accepted" &&
      evidence.level !== "depth-confirmed" &&
      evidence.level !== "consensus-final")
  ) {
    throw new Error("live batch deposit lacks durable accepted Chain Evidence");
  }
  return Object.freeze({
    transactionId,
    outpoint: `${transactionId}:${index}`,
    address: input.address,
    amountAtomic: input.amountAtomic,
    blockDaaScore: evidence.acceptingBlockDaaScore,
    virtualDaaScore: evidence.virtualDaaScore,
    finality: evidence.level === "accepted" ? "accepted" as const : "confirmed" as const,
  });
}

interface LiveBatchServerChainProvider extends ServerChainProvider {
  acceptIndependentEvidence(transactionId: string): void;
}

function liveBatchServerChainProvider(
  initialized: InitializedLiveProof,
  chain: WalletBatchChainSource,
  escrowAddresses: Set<string>,
  chainEvidence: ChainEvidenceModule,
  channel: NonNullable<Awaited<ReturnType<typeof openChannel>>["channel"]>,
): LiveBatchServerChainProvider {
  // Channel capitalization was already accepted through Treasury/Chain
  // Evidence before this provider is composed. Every successor claim must be
  // added only after the independent evidence check below.
  const independentlyAccepted = new Set<string>([channel.activeOutpoint.txid]);
  return {
    acceptIndependentEvidence(transactionId) {
      if (!/^[a-f0-9]{64}$/.test(transactionId)) {
        throw new Error("live batch accepted transaction ID is invalid");
      }
      independentlyAccepted.add(transactionId);
    },
    async getUtxo(outpoint) {
      const entries = await chain.getUtxos([...escrowAddresses]);
      const found = entries.find((entry) =>
        entry.outpoint.txid === outpoint.txid && entry.outpoint.index === outpoint.index
      );
      return found
        ? Object.freeze({
            outpoint: found.outpoint,
            amount: found.amount,
            scriptPublicKey: found.scriptPublicKey,
            finality: independentlyAccepted.has(outpoint.txid)
              ? "accepted" as const
              : "broadcast" as const,
          })
        : null;
    },
    getVirtualDaaScore: () => chain.getVirtualDaaScore(),
    estimateClaimFee: async () => BATCH_CLAIM_FEE_ATOMIC,
    async sendTransaction(safeJson) {
      const transaction = Transaction.deserializeFromSafeJSON(safeJson);
      try {
        const transactionId = String(transaction.finalize()).toLowerCase() as Hash32Hex;
        const rpc = await initialized.merchantWallet.client();
        try {
          const submitted = await rpc.submitTransaction({ transaction, allowOrphan: false });
          if (String(submitted.transactionId).toLowerCase() !== transactionId) {
            throw new Error("live batch RPC returned a different claim transaction ID");
          }
        } catch (error) {
          if (!/already|known|duplicate/i.test(String(error))) throw error;
        }
        const deadline = Date.now() + PROOF_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const entries = await chain.getUtxos([...escrowAddresses]);
          if (entries.some((entry) => entry.outpoint.txid === transactionId && entry.outpoint.index === 1)) {
            const accepted = await observeAcceptedBatchClaim({
              chainEvidence,
              channel,
              transactionId,
              merchantAddress: initialized.config.wallets.merchantAddress,
            });
            independentlyAccepted.add(transactionId);
            return Object.freeze({
              transactionId,
              finality: accepted.level === "accepted" ? "accepted" as const : "confirmed" as const,
            });
          }
          await delay(2_000);
        }
        throw new Error("live batch claim continuation was not accepted before the deadline");
      } finally {
        transaction.free();
      }
    },
  };
}

export interface LiveBatchClaimEvidenceChannel {
  readonly id: string;
  readonly activeOutpoint: Readonly<{ txid: string; index: number }>;
  readonly activeScriptPublicKey: string;
  readonly escrowAddress: string;
}

export async function observeAcceptedBatchClaim(input: Readonly<{
  chainEvidence: ChainEvidenceModule;
  channel: LiveBatchClaimEvidenceChannel;
  transactionId: string;
  merchantAddress: string;
}>): Promise<Readonly<{
  detailDigest: string;
  level: "accepted" | "depth-confirmed" | "consensus-final";
}>> {
  const codec = new KaspaTestnet10AddressCodec();
  const outcome = await input.chainEvidence.observe({
    operationId: `live-batch-claim:${input.channel.id}`,
    operation: "recovery-release",
    network: LIVE_NETWORK,
    transactionId: input.transactionId,
    expectedInputs: [Object.freeze({
      transactionId: input.channel.activeOutpoint.txid,
      index: input.channel.activeOutpoint.index,
    })],
    expectedOutputs: [
      Object.freeze({
        index: 0,
        amountAtomic: "10000000",
        scriptPublicKey: codec.scriptPublicKeyForAddress(input.merchantAddress, LIVE_NETWORK),
        address: input.merchantAddress,
      }),
      Object.freeze({
        index: 1,
        amountAtomic: "28000000",
        scriptPublicKey: input.channel.activeScriptPublicKey,
        address: input.channel.escrowAddress,
      }),
    ],
    watchedAddresses: [input.channel.escrowAddress, input.merchantAddress],
    mechanism: "native-covenant",
    protocolFinality: "accepted",
    signal: new AbortController().signal,
  });
  if (outcome.interpretation !== "accepted") {
    throw new Error("live batch claim lacks independent accepted Chain Evidence");
  }
  const observed = outcome.evidence;
  return Object.freeze({ detailDigest: observed.detailDigest, level: observed.level });
}

function serverChannel(channel: NonNullable<Awaited<ReturnType<typeof openChannel>>["channel"]>): ServerChannelRecord {
  return Object.freeze({
    channelId: channel.id,
    channelConfig: channel.config,
    escrowAddress: channel.escrowAddress,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    chargedCumulativeAmount: channel.chargedCumulativeAmount,
    claimedCumulativeAmount: channel.claimedCumulativeAmount,
    signedMaxClaimable: "0",
    status: "active" as const,
  });
}

async function openChannel(input: {
  readonly capital: KaspaX402BatchCapitalModule;
  readonly initialized: InitializedLiveProof;
  readonly merchantPublicKey: string;
  readonly operationKey: string;
  readonly refundTimeoutDaa: string;
  readonly resourceUrl: string;
  readonly onProgress?: (message: string) => void;
}) {
  const deadline = Date.now() + PROOF_TIMEOUT_MS;
  while (true) {
    const result = await input.capital.openChannel({
      operationKey: input.operationKey,
      origin: MERCHANT_ORIGIN,
      resourceUrl: input.resourceUrl,
      serverPublicKey: input.merchantPublicKey,
      payTo: input.initialized.config.wallets.merchantAddress,
      refundAddress: input.initialized.config.wallets.treasuryAddress,
      refundTimeoutDaa: input.refundTimeoutDaa,
      amountAtomic: BATCH_DEPOSIT_ATOMIC,
    });
    if (result.state === "active") return result;
    if (result.state === "failed_terminal" || Date.now() >= deadline) {
      throw new Error(`live batch capitalization stopped in ${result.state}`);
    }
    input.onProgress?.(`live batch capitalization is ${result.treasury.state}`);
    await delay(2_000);
  }
}

function batchIntent(runId: string, index: number): PurchaseIntent {
  return Object.freeze({
    requestKey: assertPurchaseRequestKey(`e2e:live-batch:${runId}:${index}`),
    resource: Object.freeze({ url: RESOURCE_URL, method: "GET" }),
    expectedMerchant: Object.freeze({
      id: FIXED_MERCHANT_ORIGIN,
      origin: MERCHANT_ORIGIN,
    }),
  });
}

interface LiveBatchTerms {
  readonly version: 1;
  readonly runId: string;
  readonly claimRefundTimeoutDaa: string;
  readonly refundProofTimeoutDaa: string;
}

function loadOrCreateBatchTerms(
  filename: string,
  runId: string,
  currentDaa: bigint
): LiveBatchTerms {
  if (privateStateFileExists(filename)) {
    const existing = readPrivateJsonState<LiveBatchTerms>(filename);
    assertBatchTerms(existing, runId);
    return existing;
  }
  const terms = Object.freeze({
    version: 1 as const,
    runId,
    claimRefundTimeoutDaa: (currentDaa + CLAIM_DAA_LEAD).toString(),
    refundProofTimeoutDaa: (currentDaa + REFUND_PROOF_DAA_LEAD).toString(),
  });
  writeAtomicJson(filename, terms);
  assertPrivateFile(filename);
  return terms;
}

function assertBatchTerms(terms: LiveBatchTerms, runId: string): void {
  if (
    terms.version !== 1 ||
    terms.runId !== runId ||
    !/^[1-9][0-9]*$/.test(terms.claimRefundTimeoutDaa) ||
    !/^[1-9][0-9]*$/.test(terms.refundProofTimeoutDaa) ||
    BigInt(terms.claimRefundTimeoutDaa) >= 500_000_000_000n ||
    BigInt(terms.refundProofTimeoutDaa) >= 500_000_000_000n
  ) {
    throw new Error("live batch terms are invalid");
  }
}

function assertReadyNode(info: Awaited<ReturnType<InitializedLiveProof["observerWallet"]["serverInfo"]>>): void {
  if (
    info.isSynced !== true || info.hasUtxoIndex !== true ||
    String(info.networkId) !== LIVE_SDK_NETWORK ||
    !/^[1-9][0-9]*$/.test(String(info.virtualDaaScore)) ||
    typeof info.serverVersion !== "string" || info.serverVersion.length === 0
  ) throw new Error("live batch node provenance is invalid");
}

function writeLiveBatchReport(filename: string, report: LiveBatchProofReport): void {
  assertBatchReport(report);
  if (privateStateFileExists(filename)) {
    const existing = readPrivateJsonState<LiveBatchProofReport>(filename);
    assertBatchReport(existing);
    if (
      existing.claimChannel.claimTransactionId !== report.claimChannel.claimTransactionId ||
      existing.refundChannel.refundTransactionId !== report.refundChannel.refundTransactionId
    ) throw new Error("live batch report path belongs to another immutable proof");
  }
  writeAtomicJson(filename, report);
  assertPrivateFile(filename);
}

function assertBatchReport(report: LiveBatchProofReport): void {
  const encoded = stableStringify(report);
  if (
    report.profile !== LIVE_BATCH_PROOF_PROFILE ||
    report.network !== LIVE_NETWORK ||
    report.claimChannel.purchases.length !== 2 ||
    report.claimChannel.authorizedCumulativeAtomic !== "16000000" ||
    report.claimChannel.chargedCumulativeAtomic !== "12000000" ||
    report.claimChannel.continuation.amountAtomic !== "28000000" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(report.claimChannel.chainEvidenceDigest) ||
    !isAcceptedChainEvidenceLevel(report.claimChannel.chainEvidenceLevel) ||
    report.refundChannel.refundOutput.amountAtomic !== "38000000" ||
    BigInt(report.refundChannel.observedBeforeBoundaryDaa) > BigInt(report.refundChannel.refundTimeoutDaa) ||
    BigInt(report.refundChannel.observedAfterBoundaryDaa) <= BigInt(report.refundChannel.refundTimeoutDaa) ||
    /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) throw new Error("live batch report is invalid or contains private state");
}

function isAcceptedChainEvidenceLevel(
  level: string
): level is "accepted" | "depth-confirmed" | "consensus-final" {
  return level === "accepted" ||
    level === "depth-confirmed" ||
    level === "consensus-final";
}

export function liveBatchReportDigest(report: LiveBatchProofReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
