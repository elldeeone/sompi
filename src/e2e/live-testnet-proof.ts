import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  decodePaymentSignatureHeader,
  type PaymentPayload,
} from "@kaspa-x402/core";
import type {
  ExactBorrowReservationProvider,
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
  ExactOnlyChannelSigner,
  ExactOnlyChannelStore,
  KaspaExactChainVerifier,
  KaspaStagingRecoveryModule,
  KaspaTestnet10AddressCodec,
  KaspaX402ExactPaymentModule,
  KaspaX402PaymentRequirementsVerifier,
  KaspaX402ServerStorePaymentResponseLookup,
  Kip10ExactTransactionBuilder,
  RpcChainObservationSource,
  RpcStagingRecoveryRaceSource,
  RpcStagingRecoveryTransactionSubmitter,
  StagingKeyStore,
  VaultExactAttemptFundingBridge,
  VaultTreasuryStaging,
} from "../adapters/kaspa-x402/index.js";
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
import { SqliteExactServerStateStore } from "../demo/exact-server-store.js";
import {
  DemoMerchantFixture,
  type DemoMerchantOffer,
} from "../demo/merchant-fixture.js";
import { SompiCheckoutTermsModule } from "../purchase/checkout-terms-module.js";
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
import {
  LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
  LIVE_ADDITIVE_THRESHOLD_ATOMIC,
  LIVE_BORROW_AMOUNT_ATOMIC,
  LIVE_NETWORK,
  LIVE_PRICE_ATOMIC,
  LIVE_SDK_NETWORK,
  LIVE_VAULT_DEPOSIT_AMOUNT_ATOMIC,
  LiveMerchantExactVerifier,
  assertPrivateFile,
  bootstrapLiveProof,
  initializeLiveProof,
  installAuthorityMacKeyPair,
  observeAddressOutpoint,
  reservationId,
  secureDirectory,
  sha256Hex,
  writeAtomicJson,
  type InitializedLiveProof,
  type LiveChainMilestone,
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
  "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:1" as const;

export interface LiveTestnetProofReport {
  readonly profile: typeof LIVE_TESTNET_PROOF_PROFILE;
  readonly generatedAt: string;
  readonly network: typeof LIVE_NETWORK;
  readonly chainMode: "live-public-testnet-10-wrpc";
  readonly liveNetworkConformanceClaimed: true;
  readonly authorityMode: "in-process-local-human-present-unix-fixture";
  readonly authorityIsolationEvidence: "proved-by-separate-os-isolation-proof";
  readonly merchantMode: "in-process-local-merchant-independent-wrpc-verifier";
  readonly protocolPins: typeof SUPPORTED_PROTOCOL_PROFILES;
  readonly bootstrapFunding: LiveChainMilestone;
  readonly borrowInventory: {
    readonly created: LiveChainMilestone;
    readonly additiveContinuation: LiveChainMilestone;
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
  };
}

export interface RunLiveTestnetProofOptions {
  readonly directory: string;
  readonly sourceWalletDirectory: string;
  readonly reportFilename: string;
  readonly onProgress?: (message: string) => void;
}

export async function runLiveTestnetProof(
  options: RunLiveTestnetProofOptions
): Promise<LiveTestnetProofReport> {
  const initialized = initializeLiveProof(options.directory, options.sourceWalletDirectory);
  const resources: Array<() => void | Promise<void>> = [];
  let purchaseJournal: PurchaseJournal | undefined;
  try {
    resources.push(() => initialized.observerWallet.disconnect());
    resources.push(() => initialized.merchantWallet.disconnect());
    resources.push(() => initialized.treasuryWallet.disconnect());

    const bootstrap = await bootstrapLiveProof({
      initialized,
      onProgress: options.onProgress,
    });
    purchaseJournal = bootstrap.journal;
    resources.push(() => purchaseJournal?.close());
    options.onProgress?.("durable funding, borrow inventory, and vault deposit are live");

    const merchantStore = new SqliteExactServerStateStore(
      path.join(initialized.layout.root, "merchant", "exact.sqlite")
    );
    resources.push(() => merchantStore.close());
    const authorizationStore = new SqliteDemoCommerceAuthorizationStore(
      path.join(initialized.layout.root, "merchant", "authorization.sqlite")
    );
    resources.push(() => authorizationStore.close());

    const authority = await createLiveAuthority(initialized);
    resources.push(() => authority.close());
    const verifier = new LiveMerchantExactVerifier(
      initialized.merchantWallet,
      initialized.layout.merchantVerifierStatePath
    );
    const merchant = await createLiveMerchant(
      initialized,
      bootstrap.progress,
      merchantStore,
      authorizationStore,
      verifier
    );
    const expectedPurchaseId = createPurchaseId(
      Buffer.from(initialized.config.purchaseEntropyHex, "hex")
    );
    const transport = new LiveDemoPinnedTransport(
      merchant,
      expectedPurchaseId,
      initialized.layout.paidReplayCapsulePath
    );
    const composition = composeLiveCoordinator({
      initialized,
      journal: purchaseJournal,
      merchantStore,
      transport,
      authorityModule: authority.module,
    });
    const intent = purchaseIntent(initialized.config);
    options.onProgress?.("running resumable AP2 authorization and Kaspa-x402 exact Purchase");
    const first = await drivePurchase(
      composition.coordinator,
      purchaseJournal,
      intent,
      expectedPurchaseId,
      options.onProgress
    );
    const duplicate = await composition.coordinator.purchase(intent);
    if (duplicate.id !== first.id || duplicate.state !== "receipted") {
      throw new Error("duplicate live Purchase did not return the same receipted identity");
    }
    const replay = await transport.replayPaidRequest();
    const attempt = purchaseJournal.requirePaymentAttempt(first.id, 1);
    const spend = purchaseJournal.findSpendForPurchase(first.id);
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
    });
    writeLiveTestnetProofReport(options.reportFilename, report);
    purchaseJournal.integrityCheck();
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
  report: LiveTestnetProofReport
): void {
  assertSecretFreeReport(report);
  writeAtomicJson(filename, report);
  assertPrivateFile(filename);
}

interface LiveComposition {
  readonly coordinator: PurchaseCoordinator;
  readonly observedStaging: JournalTreasuryStagingObservationSource;
  readonly clientChain: RpcChainObservationSource;
}

function composeLiveCoordinator(input: {
  readonly initialized: InitializedLiveProof;
  readonly journal: PurchaseJournal;
  readonly merchantStore: SqliteExactServerStateStore;
  readonly transport: PinnedHttpTransport;
  readonly authorityModule: Ap2AuthorityModule;
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
  const treasury = new VaultTreasuryModule({
    vault: input.initialized.vault,
    policy: {
      maxPerPaymentAtomic: "100000000",
      maxPerHourAtomic: "1000000000",
      approvalAboveAtomic: "0",
      allowlist: [config.wallets.merchantAddress],
    },
    additionalCostCeilingAtomic: LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
    reservationTtlMs: 30 * 60_000,
  });
  const keyStore = new StagingKeyStore({
    directory: input.initialized.layout.stagingKeyDirectory,
    now,
  });
  const staging = new VaultTreasuryStaging({
    vault: input.initialized.vault,
    wallet: input.initialized.treasuryWallet,
    keyStore,
  });
  const canonicalStaging = createJournalTreasuryStagingMetadataSource(input.journal);
  const observedStaging = new JournalTreasuryStagingObservationSource(
    input.journal,
    canonicalStaging
  );
  const funding = new VaultExactAttemptFundingBridge({
    metadataSource: canonicalStaging,
    observedStagingSource: observedStaging,
    builder: new Kip10ExactTransactionBuilder({ keyStore, now }),
  });
  const clientChain = new RpcChainObservationSource({
    rpc: input.initialized.observerWallet,
    confirmedDaaDepth: 10,
    now,
  });
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
  const payment = new KaspaX402ExactPaymentModule({
    staging,
    funding,
    channelSigner: new ExactOnlyChannelSigner(),
    channelStore: new ExactOnlyChannelStore(),
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
      observer: new RpcStagingRecoveryRaceSource({
        rpc: input.initialized.observerWallet,
        now,
      }),
      submitter: new RpcStagingRecoveryTransactionSubmitter({
        rpc: input.initialized.treasuryWallet,
        now,
      }),
      now,
    }),
    metadata: canonicalStaging,
    observedStaging,
  });
  const coordinator = new PurchaseCoordinator(
    input.journal,
    egress,
    checkout,
    input.authorityModule,
    commerceAuthorization,
    treasury,
    payment,
    stagingRecovery,
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

class LiveDemoPinnedTransport implements PinnedHttpTransport {
  private offerValue?: DemoMerchantOffer;
  private replayConfirmed = false;

  constructor(
    private readonly merchant: DemoMerchantFixture,
    private readonly purchaseId: PurchaseId,
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
    this.persistReplayCapsule({
      version: 1,
      purchaseId: this.purchaseId,
      merchantCheckout: offer.checkout.artifact,
      paymentRequiredHeader: offer.paymentRequired.headers["PAYMENT-REQUIRED"],
      paymentIdentifier,
      paymentSignature: signature,
    });
    const paid = await this.merchant.handlePaid({
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
    const paid = await this.merchant.handlePaid({
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
    this.offerValue ??= await this.merchant.offer(this.purchaseId);
    return this.offerValue;
  }

  private persistReplayCapsule(capsule: PaidReplayCapsule): void {
    if (fs.existsSync(this.replayCapsulePath)) {
      const current = this.readReplayCapsule();
      if (JSON.stringify(current) !== JSON.stringify(capsule)) {
        throw new Error("live paid-request replay capsule changed");
      }
      return;
    }
    writeAtomicJson(this.replayCapsulePath, capsule);
  }

  private readReplayCapsule(): PaidReplayCapsule {
    assertPrivateFile(this.replayCapsulePath);
    const capsule = JSON.parse(fs.readFileSync(this.replayCapsulePath, "utf8")) as PaidReplayCapsule;
    if (
      capsule.version !== 1 ||
      capsule.purchaseId !== this.purchaseId ||
      typeof capsule.merchantCheckout !== "string" ||
      typeof capsule.paymentRequiredHeader !== "string" ||
      typeof capsule.paymentSignature !== "string" ||
      typeof capsule.paymentIdentifier !== "string"
    ) {
      throw new Error("live paid-request replay capsule is invalid");
    }
    return capsule;
  }
}

interface PaidReplayCapsule {
  readonly version: 1;
  readonly purchaseId: PurchaseId;
  readonly merchantCheckout: string;
  readonly paymentRequiredHeader: string;
  readonly paymentIdentifier: string;
  readonly paymentSignature: string;
}

async function createLiveMerchant(
  initialized: InitializedLiveProof,
  progress: LiveProofProgress,
  store: SqliteExactServerStateStore,
  authorizationStore: SqliteDemoCommerceAuthorizationStore,
  verifier: LiveMerchantExactVerifier
): Promise<DemoMerchantFixture> {
  const borrow = progress.borrowInventory;
  if (!borrow) throw new Error("live KIP-10 borrow inventory is not durably observed");
  const reservationProvider: ExactBorrowReservationProvider = {
    reserveExactPayment: (request) => {
      if (
        request.network !== LIVE_NETWORK ||
        request.amount !== LIVE_PRICE_ATOMIC ||
        request.payTo !== initialized.config.wallets.merchantAddress ||
        BigInt(request.minimumAdditiveThresholdSompi) >
          BigInt(LIVE_ADDITIVE_THRESHOLD_ATOMIC)
      ) {
        throw new Error("live Merchant exact reservation request changed");
      }
      const outpoint = parseOutpoint(borrow.outpoint);
      return Object.freeze({
        reservationId: reservationId(initialized.config, borrow.outpoint),
        templateId: "kaspa-x402-kip10-additive-v1" as const,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
        borrowOutpoint: Object.freeze({ txid: outpoint.transactionId, index: outpoint.index }),
        borrowAmount: LIVE_BORROW_AMOUNT_ATOMIC,
        borrowScriptPublicKey: initialized.config.borrow.scriptPublicKey,
        borrowRedeemScript: initialized.config.borrow.redeemScript,
        additiveThresholdSompi: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
        paymentOutputIndex: 1,
        expiresAt: initialized.config.reservationExpiresAt,
      });
    },
  };
  return DemoMerchantFixture.create({
    merchantId: MERCHANT_SIGNER.issuer,
    merchantName: "Sompi Live Testnet-10 Merchant",
    merchantOrigin: MERCHANT_ORIGIN,
    merchantWebsite: `${MERCHANT_ORIGIN}/store`,
    payTo: initialized.config.wallets.merchantAddress,
    amountAtomic: LIVE_PRICE_ATOMIC,
    additionalCostCeilingAtomic: LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
    checkoutTtlMs: 30 * 60_000,
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
    exactReservationProvider: reservationProvider,
    serverPublicKey: `02${"11".repeat(32)}`,
    merchantCheckoutSigner: MERCHANT_SIGNER,
    merchantReceiptSigner: MERCHANT_RECEIPT_SIGNER,
    paymentReceiptSigner: PAYMENT_RECEIPT_SIGNER,
    ap2Trust: fixedTrustStore(),
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

async function createLiveAuthority(initialized: InitializedLiveProof): Promise<{
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

async function drivePurchase(
  coordinator: PurchaseCoordinator,
  journal: PurchaseJournal,
  intent: PurchaseIntent,
  expectedPurchaseId: PurchaseId,
  onProgress?: (message: string) => void
): Promise<PurchaseView & { readonly state: "receipted" }> {
  const deadline = Date.now() + PROOF_TIMEOUT_MS;
  let current: PurchaseView;
  try {
    current = await coordinator.purchase(intent);
  } catch (error) {
    const existing = journal.findPurchaseByRequestKey(intent.requestKey);
    if (!existing || existing.id !== expectedPurchaseId) throw error;
    current = await coordinator.recover(existing.id);
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
      ? await coordinator.purchase(intent)
      : await coordinator.recover(current.id);
  }
  if (current.id !== expectedPurchaseId) {
    throw new Error("live Purchase identity differs from the durable proof run identity");
  }
  return current as PurchaseView & { readonly state: "receipted" };
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
  readonly clientChain: RpcChainObservationSource;
  readonly merchantStore: SqliteExactServerStateStore;
  readonly paymentIdentifier: string;
}): Promise<LiveTestnetProofReport> {
  const bootstrap = input.progress.bootstrap;
  const borrow = input.progress.borrowInventory;
  const deposit = input.progress.vaultDeposit;
  if (!bootstrap || !borrow || !deposit) {
    throw new Error("live proof report is missing a durable funding milestone");
  }
  const terms = input.journal.requireCheckoutTerms(input.first.id);
  const authorization = input.journal.requireAuthorization(input.first.id);
  const attempt = input.journal.requirePaymentAttempt(input.first.id, 1);
  const stagingRecord = input.journal.findTreasuryStagingObservation(input.first.id, 1);
  const spend = input.journal.findSpendForPurchase(input.first.id);
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
  const clientObservation = await input.clientChain.observeExactOutput({
    network: LIVE_NETWORK,
    transactionId: spend.transactionId,
    outpoint: spend.outpoint,
    outputIndex: merchantIndex,
    merchantAddress: terms.payTo,
    expectedAmountAtomic: terms.amountAtomic,
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
  const continuation = await observeAddressOutpoint({
    wallet: input.initialized.observerWallet,
    address: input.initialized.config.borrow.address,
    outpoint: `${spend.transactionId}:0`,
    amountAtomic: (
      BigInt(LIVE_BORROW_AMOUNT_ATOMIC) + BigInt(LIVE_ADDITIVE_THRESHOLD_ATOMIC)
    ).toString(),
  });
  const exactRecord = await input.merchantStore.loadExactPayment(spend.transactionId);
  const identifierRecord = await input.merchantStore.loadPaymentIdentifier(attempt.identifier);
  if (
    !exactRecord ||
    exactRecord.transactionId !== spend.transactionId ||
    exactRecord.finality !== "accepted" ||
    identifierRecord?.transactionId !== spend.transactionId ||
    input.verifierState.transactionId !== spend.transactionId ||
    input.verifierState.state !== "observed" ||
    input.verifierState.finality !== "accepted" ||
    !input.verifierState.blockDaaScore ||
    input.duplicate.id !== input.first.id ||
    input.duplicate.state !== "receipted" ||
    attempt.identifier !== input.paymentIdentifier
  ) {
    throw new Error("live Merchant, client, and Purchase exact facts are inconsistent");
  }
  const info = await input.initialized.observerWallet.serverInfo();
  const stagingDepth = BigInt(info.virtualDaaScore) - BigInt(staging.blockDaaScore);
  const report: LiveTestnetProofReport = Object.freeze({
    profile: LIVE_TESTNET_PROOF_PROFILE,
    generatedAt: new Date().toISOString(),
    network: LIVE_NETWORK,
    chainMode: "live-public-testnet-10-wrpc",
    liveNetworkConformanceClaimed: true,
    authorityMode: "in-process-local-human-present-unix-fixture",
    authorityIsolationEvidence: "proved-by-separate-os-isolation-proof",
    merchantMode: "in-process-local-merchant-independent-wrpc-verifier",
    protocolPins: SUPPORTED_PROTOCOL_PROFILES,
    bootstrapFunding: bootstrap,
    borrowInventory: Object.freeze({
      created: borrow,
      additiveContinuation: continuation,
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
    }),
  });
  assertSecretFreeReport(report);
  return report;
}

function purchaseIntent(config: LiveProofConfig): PurchaseIntent {
  return Object.freeze({
    requestKey: assertPurchaseRequestKey(`e2e:live-testnet10:${config.runId}`),
    resource: Object.freeze({ url: RESOURCE_URL, method: "GET" }),
    expectedMerchant: Object.freeze({
      id: MERCHANT_SIGNER.issuer,
      origin: MERCHANT_ORIGIN,
    }),
  });
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function liveReportDigest(report: LiveTestnetProofReport): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}
