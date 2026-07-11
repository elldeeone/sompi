import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

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
import {
  ExactOnlyChannelSigner,
  ExactOnlyChannelStore,
  KaspaExactChainVerifier,
  KaspaTestnet10AddressCodec,
  KaspaX402ExactPaymentModule,
  KaspaX402PaymentRequirementsVerifier,
  KaspaX402ServerStorePaymentResponseLookup,
  Kip10ExactTransactionBuilder,
  StagingKeyStore,
  VaultExactAttemptFundingBridge,
  VaultTreasuryStaging,
} from "../adapters/kaspa-x402/index.js";
import { Ap2HumanAuthorityDecisionProvider } from "../adapters/ap2/human-authority.js";
import { AuthorityDecisionEndpoint, AuthorityUnixDecisionClient, AuthorityUnixDecisionServer } from "../authority/endpoint.js";
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
import type {
  PinnedHttpTransport,
  PinnedHttpTransportRequest,
  PinnedHttpTransportResponse,
} from "../http/pinned-transport.js";
import {
  Keypair,
  PrivateKey,
  addressFromScriptPublicKey,
  payToScriptHashScript,
  type ScriptPublicKey,
} from "../kaspa-wasm.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";
import { SompiCheckoutTermsModule } from "../purchase/checkout-terms-module.js";
import { EgressPolicy } from "../purchase/egress-policy.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
} from "../purchase/identity.js";
import {
  PurchaseCoordinator,
  type CommerceAuthorizationModule,
} from "../purchase/coordinator.js";
import {
  PurchaseJournal,
  type JournalFaultPoint,
} from "../purchase/journal.js";
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
import { VAULT_TEMPLATE_VERSION, buildRedeemScript } from "../vault/template.js";
import { VaultManager, type VaultConfig } from "../vault.js";
import { KaspaWallet } from "../wallet.js";
import { InMemoryKaspaTestnet10 } from "./in-memory-testnet.js";

const NOW_MS = 2_000_000_000_000;
const MERCHANT_ORIGIN = "https://merchant.example";
const RESOURCE_URL = `${MERCHANT_ORIGIN}/paid-resource`;
const RESOURCE_BODY = Buffer.from("Sompi deterministic AP2 + x402 resource\n", "utf8");
const PAY_TO = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
const PRICE_ATOMIC = "20000000";
const ADDITIONAL_COST_CEILING_ATOMIC = "30000000";
const ADDITIVE_THRESHOLD_ATOMIC = "10000000";
const BORROW_AMOUNT_ATOMIC = "100000000";
const BORROW_TRANSACTION_ID = "62".repeat(32);
const BORROW_RESERVATION_ID = "63".repeat(32);
const INITIAL_VAULT_TRANSACTION_ID = "64".repeat(32);
const COVENANT_ID = "65".repeat(32);
const OWNER_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AGENT_PRIVATE_KEY = "01".padStart(64, "0");
const STAGING_PRIVATE_KEY = "02".padStart(64, "0");
const AUTHORITY_MAC_KEY_ID = "authority-e2e-ipc-key-1";
const EXPECTED_PURCHASE_ID = createPurchaseId(new Uint8Array(16).fill(0x41));

export const LOCAL_TESTNET_PROOF_PROFILE =
  "urn:sompi:e2e:deterministic-in-memory-testnet10:1" as const;

export interface LocalTestnetProofReport {
  readonly profile: typeof LOCAL_TESTNET_PROOF_PROFILE;
  readonly generatedAt: string;
  readonly chainMode: "deterministic-in-memory-testnet10";
  readonly liveNetworkConformanceClaimed: false;
  readonly authorityMode: "real-unix-framed-service-in-process-fixture";
  readonly adapterTransport: "sompi-demo-local-ap2-presentation-endpoints";
  readonly protocolPins: typeof SUPPORTED_PROTOCOL_PROFILES;
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
    readonly exactTransactionId: string;
    readonly merchantOutpoint: string;
  };
  readonly idempotency: {
    readonly duplicatePurchaseReturnedSameId: true;
    readonly stagingSubmissions: 1;
    readonly exactMerchantAcceptances: 1;
  };
  readonly recovery: {
    readonly restartCount: number;
    readonly injectedFaultPoint?: JournalFaultPoint;
    readonly finalState: "receipted";
  };
  readonly protocolSeparation: {
    readonly paidRequestExtensionKeys: readonly ["payment-identifier"];
    readonly ap2DataInX402Request: false;
  };
}

export interface RunLocalTestnetProofOptions {
  readonly directory?: string;
  readonly keepDirectory?: boolean;
  readonly approve?: boolean;
  readonly stagingVisibleOnSubmit?: boolean;
  readonly faultPoint?: JournalFaultPoint;
  readonly commerceAuthorizationDecorator?: (
    module: CommerceAuthorizationModule
  ) => CommerceAuthorizationModule;
}

/**
 * Runs one fully local vertical proof. The external Kaspa/RPC boundary alone
 * is deterministic in-memory Testnet-10, so this never claims live network
 * conformance. Every Sompi module, AP2 signature, Unix authority frame,
 * Kaspa-x402 alpha.6 transaction, Merchant acceptance, and journal write is
 * the production implementation.
 */
export async function runLocalTestnetProof(
  options: RunLocalTestnetProofOptions = {}
): Promise<LocalTestnetProofReport> {
  const ownedDirectory = options.directory === undefined;
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "sompi-e2e-"));
  secureDirectory(directory);
  const resources: Array<() => void | Promise<void>> = [];
  try {
    const clock = () => NOW_MS;
    const vaultFixture = createDeterministicVault(directory);
    resources.push(() => vaultFixture.script.free());
    const wallet = new KaspaWallet({
      networkId: "testnet-10",
      dataDir: path.join(directory, "wallet"),
    });
    const chain = new InMemoryKaspaTestnet10({
      initialVaultAddress: vaultFixture.config.address,
      initialVaultScript: vaultFixture.script,
      initialVaultAmount: 600_000_000n,
      initialVaultTransactionId: INITIAL_VAULT_TRANSACTION_ID,
      covenantId: COVENANT_ID,
      stagingVisibleOnSubmit: options.stagingVisibleOnSubmit,
    });
    // The fixture owns the one ScriptPublicKey passed to the chain from here.
    resources.pop();
    resources.push(() => chain.close());
    (wallet as unknown as { client(): Promise<object> }).client = async () =>
      chain.walletClient();

    const authority = await createAuthorityFixture(
      path.join(directory, "authority"),
      clock,
      options.approve ?? true
    );
    resources.push(() => authority.close());

    const merchantStore = new SqliteExactServerStateStore(
      path.join(directory, "merchant", "exact.sqlite")
    );
    resources.push(() => merchantStore.close());
    const merchantAuthorizationStore = new SqliteDemoCommerceAuthorizationStore(
      path.join(directory, "merchant", "authorization.sqlite"),
      { now: clock }
    );
    resources.push(() => merchantAuthorizationStore.close());
    const addressCodec = new KaspaTestnet10AddressCodec();
    const merchant = await DemoMerchantFixture.create({
      merchantId: MERCHANT_SIGNER.issuer,
      merchantName: "Sompi E2E Merchant",
      merchantOrigin: MERCHANT_ORIGIN,
      merchantWebsite: `${MERCHANT_ORIGIN}/store`,
      payTo: PAY_TO,
      amountAtomic: PRICE_ATOMIC,
      additionalCostCeilingAtomic: ADDITIONAL_COST_CEILING_ATOMIC,
      checkoutTtlMs: 120_000,
      authorityAudience: AUTHORITY_SIGNER.issuer,
      expectedAuthorityIssuer: AUTHORITY_SIGNER.issuer,
      expectedInstrumentId: FIXED_INSTRUMENT_ID,
      resource: {
        identity: "resource:sompi:e2e:1",
        url: RESOURCE_URL,
        method: "GET",
        mediaType: "text/plain; charset=utf-8",
        body: RESOURCE_BODY,
      },
      store: merchantStore,
      authorizationStore: merchantAuthorizationStore,
      addressCodec,
      chainProvider: inertServerChainProvider(),
      voucherVerifier: { verifyVoucher: () => false } satisfies VoucherVerifier,
      exactTransactionVerifier: chain,
      exactReservationProvider: exactReservationProvider(),
      serverPublicKey: `02${"11".repeat(32)}`,
      merchantCheckoutSigner: MERCHANT_SIGNER,
      merchantReceiptSigner: MERCHANT_RECEIPT_SIGNER,
      paymentReceiptSigner: PAYMENT_RECEIPT_SIGNER,
      ap2Trust: fixedTrustStore(),
      now: clock,
    });
    const transport = new DemoPinnedTransport(merchant, EXPECTED_PURCHASE_ID);

    const journalFilename = path.join(directory, "purchase", "journal.sqlite");
    let faultInjected = false;
    let journal = new PurchaseJournal(journalFilename, {
      now: clock,
      ...(options.faultPoint
        ? {
            faultInjector(point) {
              if (point === options.faultPoint) {
                faultInjected = true;
                throw new InjectedE2eFault(point);
              }
            },
          }
        : {}),
    });
    resources.push(() => journal.close());
    let coordinator = composeCoordinator({
      directory,
      journal,
      wallet,
      vault: vaultFixture.vault,
      chain,
      merchantStore,
      transport,
      authorityModule: authority.module,
      clock,
      commerceAuthorizationDecorator: options.commerceAuthorizationDecorator,
    });
    const intent = purchaseIntent("e2e:success");
    let first: PurchaseView | undefined;
    let thrown: unknown;
    try {
      first = await coordinator.purchase(intent);
    } catch (error) {
      thrown = error;
    }
    let restartCount = 0;
    const restartRequired = options.faultPoint !== undefined ||
      (options.stagingVisibleOnSubmit === false && first?.state !== "receipted") ||
      (options.commerceAuthorizationDecorator !== undefined && first?.state !== "receipted");
    if (restartRequired) {
      if (options.faultPoint && !faultInjected) {
        throw thrown ?? new Error(`configured E2E fault ${options.faultPoint} was not exercised`);
      }
      if (thrown && !(thrown instanceof InjectedE2eFault)) throw thrown;
      if (options.stagingVisibleOnSubmit === false) chain.makeStagingVisible();
      journal.close();
      journal = new PurchaseJournal(journalFilename, { now: clock });
      restartCount += 1;
      coordinator = composeCoordinator({
        directory,
        journal,
        wallet,
        vault: vaultFixture.vault,
        chain,
        merchantStore,
        transport,
        authorityModule: authority.module,
        clock,
        commerceAuthorizationDecorator: options.commerceAuthorizationDecorator,
      });
      first = await coordinator.purchase(intent);
      for (let pass = 0; first.state !== "receipted" && pass < 4; pass++) {
        first = await coordinator.recover(first.id);
      }
    } else if (thrown) {
      throw thrown;
    }
    if (!first) throw new Error("local proof produced no Purchase view");
    if (first.state !== "receipted") {
      throw new Error(`local proof did not reach receipted state (found ${first.state})`);
    }
    const duplicate = await coordinator.purchase(intent);
    if (duplicate.id !== first.id || duplicate.state !== "receipted") {
      throw new Error("duplicate Purchase call did not return the completed idempotent Purchase");
    }
    return proofReport(
      first,
      duplicate,
      journal,
      chain,
      transport,
      restartCount,
      options.faultPoint
    );
  } finally {
    const errors: unknown[] = [];
    for (const close of resources.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (ownedDirectory && !options.keepDirectory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "local proof cleanup failed");
    }
  }
}

export function writeLocalTestnetProofReport(
  filename: string,
  report: LocalTestnetProofReport
): void {
  assertSecretFreeReport(report);
  const target = path.resolve(filename);
  secureDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
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
}

class DemoPinnedTransport implements PinnedHttpTransport {
  private offerValue?: DemoMerchantOffer;
  readonly paidRequestExtensionKeys: string[][] = [];

  constructor(
    private readonly merchant: DemoMerchantFixture,
    private readonly purchaseId: PurchaseId
  ) {}

  async send(
    request: Readonly<PinnedHttpTransportRequest>
  ): Promise<PinnedHttpTransportResponse> {
    request.signal.throwIfAborted();
    const target = new URL(request.hop.url);
    if (target.origin !== MERCHANT_ORIGIN) throw new Error("demo transport origin changed");
    const signature = oneRequestHeader(request.headers, "payment-signature");

    if (target.pathname === AP2_CHECKOUT_AUTHORIZATION_PATH) {
      return response(200, [], encodeStageAcceptance(
        await this.merchant.presentCheckoutMandate(
          decodeAp2CommerceAuthorizationPresentation(request.body)
        )
      ));
    }
    if (target.pathname === AP2_PAYMENT_AUTHORIZATION_PATH) {
      return response(200, [], encodeStageAcceptance(
        await this.merchant.presentPaymentMandate(
          decodeAp2CommerceAuthorizationPresentation(request.body)
        )
      ));
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
    if (target.href !== RESOURCE_URL) throw new Error("demo transport path is unsupported");
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
    const keys = Object.keys(decoded.extensions ?? {}).sort();
    this.paidRequestExtensionKeys.push(keys);
    if (keys.length !== 1 || keys[0] !== "payment-identifier") {
      throw new Error("x402 paid request contained non-standard AP2 correlation data");
    }
    const paymentIdentifier = paymentIdentifierFromPayload(decoded);
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

  private async offer(): Promise<DemoMerchantOffer> {
    this.offerValue ??= await this.merchant.offer(this.purchaseId);
    return this.offerValue;
  }
}

function composeCoordinator(input: {
  directory: string;
  journal: PurchaseJournal;
  wallet: KaspaWallet;
  vault: VaultManager;
  chain: InMemoryKaspaTestnet10;
  merchantStore: SqliteExactServerStateStore;
  transport: PinnedHttpTransport;
  authorityModule: Ap2AuthorityModule;
  clock: () => number;
  commerceAuthorizationDecorator?: (
    module: CommerceAuthorizationModule
  ) => CommerceAuthorizationModule;
}): PurchaseCoordinator {
  const trust = fixedTrustStore();
  const egress = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    limits: { requestTimeoutMs: 5_000 },
    now: input.clock,
  });
  const checkout = new SompiCheckoutTermsModule({
    transport: input.transport,
    merchantCheckout: new Ap2MerchantCheckoutVerifier({
      trust,
      authorityAudience: AUTHORITY_SIGNER.issuer,
    }),
    paymentRequirements: new KaspaX402PaymentRequirementsVerifier(),
    now: input.clock,
  });
  const commerceEvidence = new JournalAp2CommerceEvidenceSource({
    journal: input.journal,
    trust,
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    now: input.clock,
  });
  const commerceBase = new Ap2HttpCommerceAuthorizationModule({
    evidenceSource: commerceEvidence,
    transport: input.transport,
    now: input.clock,
  });
  const commerceAuthorization = input.commerceAuthorizationDecorator
    ? input.commerceAuthorizationDecorator(commerceBase)
    : commerceBase;
  const treasury = new VaultTreasuryModule({
    vault: input.vault,
    policy: {
      maxPerPaymentAtomic: "100000000",
      maxPerHourAtomic: "500000000",
      approvalAboveAtomic: "0",
      allowlist: [PAY_TO],
    },
    additionalCostCeilingAtomic: ADDITIONAL_COST_CEILING_ATOMIC,
    reservationTtlMs: 120_000,
  });
  const keyStore = new StagingKeyStore({
    directory: path.join(input.directory, "staging-keys"),
    now: input.clock,
    generatePrivateKey: () => STAGING_PRIVATE_KEY,
  });
  const staging = new VaultTreasuryStaging({
    vault: input.vault,
    wallet: input.wallet,
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
    builder: new Kip10ExactTransactionBuilder({ keyStore, now: input.clock }),
  });
  const chainVerifier = new KaspaExactChainVerifier({
    stagingMetadata: new JournalChainTreasuryMetadataSource(
      canonicalStaging,
      observedStaging,
      input.clock
    ),
    chain: input.chain,
    merchantResponses: new KaspaX402ServerStorePaymentResponseLookup({
      store: input.merchantStore,
      now: input.clock,
    }),
    addressCodec: new KaspaTestnet10AddressCodec(),
    now: input.clock,
  });
  const paidResponseVerifier = new Ap2PaidResponseVerifier({
    evidenceSource: commerceEvidence,
    trust,
    expectedMerchantReceiptIssuer: MERCHANT_RECEIPT_SIGNER.issuer,
    expectedPaymentReceiptIssuer: PAYMENT_RECEIPT_SIGNER.issuer,
    now: input.clock,
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
    now: input.clock,
  });
  return new PurchaseCoordinator(
    input.journal,
    egress,
    checkout,
    input.authorityModule,
    commerceAuthorization,
    treasury,
    payment,
    {
      async prepare() {
        throw new Error("local proof did not expect abandoned staging recovery");
      },
      async observe() {
        throw new Error("local proof did not expect abandoned staging recovery");
      },
      async submit() {
        throw new Error("local proof did not expect abandoned staging recovery");
      },
    },
    { async obtain() { return { status: "pending" as const }; } },
    {
      now: input.clock,
      entropy: (length) => new Uint8Array(length).fill(length === 16 ? 0x41 : 0x42),
      workerId: "sompi-e2e-coordinator",
      effectLeaseTtlMs: 5_000,
    }
  );
}

async function createAuthorityFixture(
  directory: string,
  now: () => number,
  approve: boolean
): Promise<{ module: Ap2AuthorityModule; close(): Promise<void> }> {
  const serverPrivate = path.join(directory, "server-private");
  const clientRuntime = path.join(directory, "client-runtime");
  const socketDirectory = path.join(directory, "run");
  for (const value of [serverPrivate, clientRuntime, socketDirectory]) secureDirectory(value);
  const serverMac = path.join(serverPrivate, "ipc-mac.key");
  const clientMac = path.join(clientRuntime, "ipc-mac.key");
  const mac = Buffer.alloc(AUTHORITY_MAC_KEY_BYTES, 0xa7);
  fs.writeFileSync(serverMac, mac, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(clientMac, mac, { mode: 0o600, flag: "wx" });
  mac.fill(0);
  const serverAuthentication = new AuthorityMacKeyFile(serverMac, AUTHORITY_MAC_KEY_ID);
  const clientAuthentication = new AuthorityMacKeyFile(clientMac, AUTHORITY_MAC_KEY_ID);
  const serverReplay = new SqliteAuthorityReplayStore(
    path.join(serverPrivate, "replay.sqlite"),
    { now }
  );
  const decisionStore = new SqliteAuthorityDecisionStore(
    path.join(serverPrivate, "decisions.sqlite")
  );
  const clientReplay = new SqliteAuthorityReplayStore(
    path.join(clientRuntime, "replay.sqlite"),
    { now }
  );
  const trust = fixedTrustStore();
  const humanDecision = new Ap2HumanAuthorityDecisionProvider({
    signer: AUTHORITY_SIGNER,
    trust,
    instrumentId: FIXED_INSTRUMENT_ID,
    prompt: { approve: async () => approve },
    now,
  });
  const service = new AuthorityService({
    replayStore: serverReplay,
    decisionStore,
    authenticationProvider: serverAuthentication,
    humanDecision,
    now,
  });
  const socketPath = path.join(socketDirectory, "authority.sock");
  const server = new AuthorityUnixDecisionServer({
    socketPath,
    timeoutMs: 5_000,
    endpoint: new AuthorityDecisionEndpoint(service),
  });
  await server.start();
  const verifier = new Ap2AuthorityDecisionEvidenceVerifier({
    trust,
    expectedAuthorityIssuer: FIXED_AUTHORITY_ISSUER,
    expectedInstrumentId: FIXED_INSTRUMENT_ID,
    now,
    clockSkewSec: 0,
  });
  const module = new Ap2AuthorityModule({
    authenticationProvider: clientAuthentication,
    replayStore: clientReplay,
    transport: new AuthorityUnixDecisionClient({ socketPath, timeoutMs: 5_000 }),
    verifier,
    now,
  });
  return {
    module,
    async close() {
      await server.close();
      clientReplay.close();
      serverReplay.close();
      decisionStore.close();
    },
  };
}

function createDeterministicVault(directory: string): {
  vault: VaultManager;
  config: VaultConfig;
  script: ScriptPublicKey;
} {
  const vault = new VaultManager(directory, "testnet-10");
  const privateKey = new PrivateKey(AGENT_PRIVATE_KEY);
  const keypair = Keypair.fromPrivateKey(privateKey);
  let address;
  try {
    const agentPublic = String(keypair.xOnlyPublicKey).toLowerCase();
    const redeemScript = buildRedeemScript(
      agentPublic,
      OWNER_PUBLIC_KEY,
      500_000_000n,
      36_000n,
      { windowStartDaa: 0n, spentInWindowSompi: 0n }
    );
    const script = payToScriptHashScript(redeemScript);
    address = addressFromScriptPublicKey(script, "testnet-10");
    const value = address?.toString();
    if (!value) {
      script.free();
      throw new Error("deterministic vault address could not be derived");
    }
    const config: VaultConfig = {
      template: VAULT_TEMPLATE_VERSION,
      agentPublic,
      ownerPublic: OWNER_PUBLIC_KEY,
      maxOutflowSompi: "500000000",
      windowSizeDaa: "36000",
      windowStartDaa: "0",
      spentInWindowSompi: "0",
      address: value,
      covenantId: COVENANT_ID,
      currentOutpoint: { txid: INITIAL_VAULT_TRANSACTION_ID, index: 0 },
    };
    const vaultDirectory = path.join(directory, "vault");
    secureDirectory(vaultDirectory);
    fs.writeFileSync(path.join(vaultDirectory, "agent-key"), AGENT_PRIVATE_KEY, {
      mode: 0o600,
      flag: "wx",
    });
    fs.writeFileSync(
      path.join(vaultDirectory, "config.json"),
      JSON.stringify(config, null, 2),
      { mode: 0o600, flag: "wx" }
    );
    return { vault, config, script };
  } finally {
    address?.free();
    keypair.free();
    privateKey.free();
  }
}

function exactReservationProvider(): ExactBorrowReservationProvider {
  const borrowRedeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey: OWNER_PUBLIC_KEY,
    amount: ADDITIVE_THRESHOLD_ATOMIC,
  }).toLowerCase();
  const borrowScriptPublicKey = serializedScriptPublicKey(
    kip10AdditiveScriptPublicKey({
      ownerPublicKey: OWNER_PUBLIC_KEY,
      amount: ADDITIVE_THRESHOLD_ATOMIC,
    })
  ).toLowerCase();
  return {
    reserveExactPayment: () => ({
      reservationId: BORROW_RESERVATION_ID,
      templateId: "kaspa-x402-kip10-additive-v1",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      borrowOutpoint: { txid: BORROW_TRANSACTION_ID, index: 0 },
      borrowAmount: BORROW_AMOUNT_ATOMIC,
      borrowScriptPublicKey,
      borrowRedeemScript,
      additiveThresholdSompi: ADDITIVE_THRESHOLD_ATOMIC,
      paymentOutputIndex: 1,
      expiresAt: new Date(NOW_MS + 300_000).toISOString(),
    }),
  };
}

function inertServerChainProvider(): ServerChainProvider {
  return {
    getUtxo: async () => null,
    getVirtualDaaScore: async () => "100",
    estimateClaimFee: async () => "1",
    sendTransaction: async () => ({
      transactionId: "66".repeat(32),
      finality: "accepted",
    }),
  };
}

function purchaseIntent(key: string): PurchaseIntent {
  return {
    requestKey: assertPurchaseRequestKey(key),
    resource: { url: RESOURCE_URL, method: "GET" },
    expectedMerchant: {
      id: MERCHANT_SIGNER.issuer,
      origin: MERCHANT_ORIGIN,
    },
  };
}

function proofReport(
  first: PurchaseView,
  duplicate: PurchaseView,
  journal: PurchaseJournal,
  chain: InMemoryKaspaTestnet10,
  transport: DemoPinnedTransport,
  restartCount: number,
  injectedFaultPoint?: JournalFaultPoint
): LocalTestnetProofReport {
  if (first.state !== "receipted") {
    throw new Error("proof report requires a receipted Purchase");
  }
  const terms = journal.requireCheckoutTerms(first.id);
  const authorization = journal.requireAuthorization(first.id);
  const attempt = journal.requirePaymentAttempt(first.id, 1);
  const staging = journal.findTreasuryStagingObservation(first.id, 1);
  const spend = journal.findSpendForPurchase(first.id);
  const fulfilment = journal.findFulfilment(first.id);
  const receipts = journal.receipts(first.id);
  if (!staging || !spend || !fulfilment || receipts.length !== 2) {
    throw new Error("receipted local proof is missing its canonical evidence joins");
  }
  const stagingTransactionId = chain.stagingTransactionId();
  const exactTransactionId = chain.exactTransactionId();
  if (
    !stagingTransactionId ||
    !exactTransactionId ||
    staging.transactionId !== stagingTransactionId ||
    spend.transactionId !== exactTransactionId ||
    chain.stagingSubmissionCount !== 1 ||
    chain.exactAcceptanceCount !== 1 ||
    duplicate.id !== first.id
  ) {
    throw new Error("local proof transaction/idempotency facts are inconsistent");
  }
  if (
    transport.paidRequestExtensionKeys.length === 0 ||
    transport.paidRequestExtensionKeys.some(
      (keys) => keys.length !== 1 || keys[0] !== "payment-identifier"
    )
  ) {
    throw new Error("local proof did not preserve AP2/x402 wire separation");
  }
  const report: LocalTestnetProofReport = Object.freeze({
    profile: LOCAL_TESTNET_PROOF_PROFILE,
    generatedAt: new Date(NOW_MS).toISOString(),
    chainMode: "deterministic-in-memory-testnet10",
    liveNetworkConformanceClaimed: false,
    authorityMode: "real-unix-framed-service-in-process-fixture",
    adapterTransport: "sompi-demo-local-ap2-presentation-endpoints",
    protocolPins: SUPPORTED_PROTOCOL_PROFILES,
    purchase: Object.freeze({
      id: first.id,
      state: "receipted",
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
      stagingTransactionId,
      stagingOutpoint: staging.outpoint,
      exactTransactionId,
      merchantOutpoint: spend.outpoint!,
    }),
    idempotency: Object.freeze({
      duplicatePurchaseReturnedSameId: true,
      stagingSubmissions: 1,
      exactMerchantAcceptances: 1,
    }),
    recovery: Object.freeze({
      restartCount,
      ...(injectedFaultPoint ? { injectedFaultPoint } : {}),
      finalState: "receipted" as const,
    }),
    protocolSeparation: Object.freeze({
      paidRequestExtensionKeys: Object.freeze(["payment-identifier"] as const),
      ap2DataInX402Request: false,
    }),
  });
  assertSecretFreeReport(report);
  return report;
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

function paymentIdentifierFromPayload(payload: PaymentPayload): string {
  const extension = payload.extensions?.["payment-identifier"] as
    | { info?: { id?: unknown } }
    | undefined;
  const value = extension?.info?.id;
  if (typeof value !== "string" || value !== createPaymentIdentifier(EXPECTED_PURCHASE_ID, 1)) {
    throw new Error("paid request payment identifier is invalid");
  }
  return value;
}

function requiredQuery(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error(`demo authorization status requires ${name}`);
  }
  return values[0];
}

function secureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
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
      if (forbiddenKey.test(key)) throw new Error(`proof report contains forbidden field ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

export class InjectedE2eFault extends Error {
  constructor(readonly point: JournalFaultPoint) {
    super(`injected local E2E fault at ${point}`);
    this.name = "InjectedE2eFault";
  }
}
