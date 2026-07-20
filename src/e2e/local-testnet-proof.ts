import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  decodePaymentSignatureHeader,
  type PaymentPayload,
} from "@kaspa-x402/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  ServerChainProvider,
  VoucherVerifier,
} from "@kaspa-x402/server";

import {
  Ap2AuthorityDecisionEvidenceVerifier,
  Ap2AuthorityModule,
  type Ap2PublicKeyResolver,
} from "../adapters/ap2/index.js";
import {
  AUTHORITY_SIGNER,
  FIXED_AUTHORITY_ISSUER,
  FIXED_INSTRUMENT_ID,
  FIXED_MERCHANT_ORIGIN,
  fixedTrustStore,
} from "../adapters/ap2/authority-test-fixtures.js";
import {
  JournalBatchChannelStore,
  SecureBatchChannelSigner,
  KaspaExactChainVerifier,
  KaspaTestnet10AddressCodec,
  KaspaX402ExactPaymentModule,
  KaspaX402AuthorityEvidenceVerifier,
  KaspaX402TreasuryStagingAdapter,
  KaspaX402PaymentRequirementsVerifier,
  KaspaX402ServerStorePaymentResponseLookup,
  ExactTransactionBuilder,
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
import { SqliteMerchantServerStateStore } from "../demo/merchant-server-store.js";
import {
  DemoMerchantFixture,
  type DemoMerchantOffer,
} from "../demo/merchant-fixture.js";
import type {
  PinnedHttpTransport,
  PinnedHttpTransportRequest,
  PinnedHttpTransportResponse,
} from "../http/pinned-transport.js";
import { createPurchaseApplication, type PurchaseApplication, type SompiApplication } from "../api/contracts.js";
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
} from "../purchase/coordinator.js";
import {
  PurchaseJournal,
  type JournalFaultPoint,
} from "../purchase/journal.js";
import { SompiPaidResponseVerifier } from "../purchase/paid-response-verifier.js";
import type {
  PurchaseId,
  PurchaseIntent,
  PurchaseView,
  Sha256Digest,
} from "../purchase/types.js";
import {
  JournalChainTreasuryMetadataSource,
  JournalTreasuryStagingObservationSource,
  createJournalTreasuryStagingMetadataSource,
} from "../runtime/journal-sources.js";
import { VaultTreasuryModule } from "../treasury/vault-treasury.js";
import { VAULT_TEMPLATE_VERSION, buildRedeemScript } from "../vault/template.js";
import { VaultManager, type VaultConfig } from "../vault.js";
import { KaspaWallet } from "../wallet.js";
import { InMemoryKaspaTestnet10 } from "./in-memory-testnet.js";
import { createSompiMcpServer } from "../mcp/server.js";
import { PolicyEngine } from "../policy.js";

const NOW_MS = 2_000_000_000_000;
const MERCHANT_ORIGIN = "https://merchant.example";
const RESOURCE_URL = `${MERCHANT_ORIGIN}/paid-resource`;
const RESOURCE_BODY = Buffer.from("Sompi deterministic generic x402 resource\n", "utf8");
const PAY_TO = "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd";
const PRICE_ATOMIC = "20000000";
const ADDITIONAL_COST_CEILING_ATOMIC = "30000000";
const INITIAL_VAULT_TRANSACTION_ID = "64".repeat(32);
const COVENANT_ID = "65".repeat(32);
const OWNER_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AGENT_PRIVATE_KEY = "01".padStart(64, "0");
const STAGING_PRIVATE_KEY = "02".padStart(64, "0");
const AUTHORITY_MAC_KEY_ID = "authority-e2e-ipc-key-1";
const EXPECTED_PURCHASE_ID = createPurchaseId(new Uint8Array(16).fill(0x41));

export const LOCAL_TESTNET_PROOF_PURCHASE_ID = EXPECTED_PURCHASE_ID;

export const LOCAL_TESTNET_PROOF_PROFILE =
  "urn:sompi:e2e:deterministic-in-memory-testnet10:1" as const;

export interface LocalTestnetProofReport {
  readonly profile: typeof LOCAL_TESTNET_PROOF_PROFILE;
  readonly generatedAt: string;
  readonly chainMode: "deterministic-in-memory-testnet10";
  readonly liveNetworkConformanceClaimed: false;
  readonly authorityMode:
    | "real-unix-framed-service-in-process-fixture"
    | "separate-process-human-present";
  readonly initiationMode:
    | "direct-purchase-module"
    | "mcp-sdk-in-memory-transport";
  readonly merchantProfile: "generic-x402";
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
    readonly authorityDataInX402Request: false;
  };
}

export interface RunLocalTestnetProofOptions {
  readonly directory?: string;
  readonly keepDirectory?: boolean;
  readonly approve?: boolean;
  readonly now?: () => number;
  readonly externalAuthority?: Readonly<{
    readonly module: Ap2AuthorityModule;
    readonly trust: Ap2PublicKeyResolver;
    readonly issuer: string;
    readonly instrumentId: string;
    readonly mode: "separate-process-human-present";
  }>;
  readonly initiationMode?: LocalTestnetProofReport["initiationMode"];
  readonly stagingVisibleOnSubmit?: boolean;
  readonly faultPoint?: JournalFaultPoint;
}

/**
 * Runs one fully local vertical proof. The external Kaspa/RPC boundary alone
 * is deterministic in-memory Testnet-10, so this never claims live network
 * conformance. Every Sompi module, authority signature, Unix authority frame,
 * Kaspa-x402 alpha.8 transaction, Merchant acceptance, and journal write is
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
    const clock = options.now ?? (() => NOW_MS);
    const startedAtMs = readProofClock(clock);
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
      now: clock,
    });
    // The fixture owns the one ScriptPublicKey passed to the chain from here.
    resources.pop();
    resources.push(() => chain.close());
    (wallet as unknown as { client(): Promise<object> }).client = async () =>
      chain.walletClient();

    const initiationMode = options.initiationMode ?? "direct-purchase-module";
    if (options.externalAuthority && options.approve !== undefined) {
      throw new Error("external authority proof cannot configure fixture approval");
    }
    if (
      initiationMode === "mcp-sdk-in-memory-transport" &&
      (options.faultPoint !== undefined ||
        options.stagingVisibleOnSubmit === false)
    ) {
      throw new Error("MCP-ingress proof does not combine with deterministic restart injection");
    }
    const ownedAuthority = options.externalAuthority
      ? undefined
      : await createAuthorityFixture(
          path.join(directory, "authority"),
          clock,
          options.approve ?? true
        );
    if (ownedAuthority) resources.push(() => ownedAuthority.close());
    const authority = externalAuthorityContext(
      options.externalAuthority,
      ownedAuthority?.module
    );

    const merchantStore = new SqliteMerchantServerStateStore(
      path.join(directory, "merchant", "exact.sqlite")
    );
    resources.push(() => merchantStore.close());
    const addressCodec = new KaspaTestnet10AddressCodec();
    const merchant = await DemoMerchantFixture.create({
      merchantId: FIXED_MERCHANT_ORIGIN,
      merchantName: "Sompi E2E Merchant",
      merchantOrigin: MERCHANT_ORIGIN,
      payTo: PAY_TO,
      paymentScheme: "exact",
      exactProfile: "standard-native",
      amountAtomic: PRICE_ATOMIC,
      resource: {
        identity: "resource:sompi:e2e:1",
        url: RESOURCE_URL,
        method: "GET",
        mediaType: "text/plain; charset=utf-8",
        body: RESOURCE_BODY,
      },
      store: merchantStore,
      addressCodec,
      chainProvider: inertServerChainProvider(),
      voucherVerifier: { verifyVoucher: () => false } satisfies VoucherVerifier,
      exactTransactionVerifier: chain,
      serverPublicKey: `02${"11".repeat(32)}`,
    });
    const transport = new DemoPinnedTransport(merchant, EXPECTED_PURCHASE_ID);

    const journalFilename = path.join(directory, "purchase", "journal.sqlite");
    const policy = new PolicyEngine({
      maxSompiPerTx: 100_000_000n,
      maxSompiPerHour: 500_000_000n,
      allowlist: [],
    });
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
      trust: authority.trust,
      authorityIssuer: authority.issuer,
      instrumentId: authority.instrumentId,
      clock,
    });
    const intent = purchaseIntent("e2e:success");
    let first: PurchaseView | undefined;
    let thrown: unknown;
    try {
      first = await invokePurchase({
        mode: initiationMode,
        coordinator,
        intent,
        journal,
        wallet,
        vault: vaultFixture.vault,
        policy,
      });
    } catch (error) {
      thrown = error;
    }
    let restartCount = 0;
    const restartRequired = options.faultPoint !== undefined ||
      (options.stagingVisibleOnSubmit === false && first?.state !== "receipted");
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
        trust: authority.trust,
        authorityIssuer: authority.issuer,
        instrumentId: authority.instrumentId,
        clock,
      });
      first = await invokePurchase({
        mode: initiationMode,
        coordinator,
        intent,
        journal,
        wallet,
        vault: vaultFixture.vault,
        policy,
      });
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
    const duplicate = await invokePurchase({
      mode: initiationMode,
      coordinator,
      intent,
      journal,
      wallet,
      vault: vaultFixture.vault,
      policy,
    });
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
      authority.mode,
      initiationMode,
      startedAtMs,
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

    if (target.href !== RESOURCE_URL) throw new Error("demo transport path is unsupported");
    const offer = await this.offer();
    if (!signature) {
      return response(
        offer.paymentRequired.status,
        Object.entries(offer.paymentRequired.headers),
        new Uint8Array()
      );
    }

    const decoded = decodePaymentSignatureHeader(signature);
    const keys = Object.keys(decoded.extensions ?? {}).sort();
    this.paidRequestExtensionKeys.push(keys);
    if (keys.length !== 1 || keys[0] !== "payment-identifier") {
      throw new Error("x402 paid request contained Sompi authority data");
    }
    const paymentIdentifier = paymentIdentifierFromPayload(decoded);
    const paid = await this.merchant.handlePaid({
      purchaseId: this.purchaseId,
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
  merchantStore: SqliteMerchantServerStateStore;
  transport: PinnedHttpTransport;
  authorityModule: Ap2AuthorityModule;
  trust: Ap2PublicKeyResolver;
  authorityIssuer: string;
  instrumentId: string;
  clock: () => number;
}): PurchaseCoordinator {
  const trust = input.trust;
  const egress = new EgressPolicy({
    allowRules: [{ hostname: "merchant.example", ports: [443] }],
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    limits: { requestTimeoutMs: 5_000 },
    now: input.clock,
  });
  const checkout = new SompiCheckoutTermsModule({
    transport: input.transport,
    paymentRequirements: new KaspaX402PaymentRequirementsVerifier(),
    now: input.clock,
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
    chainEvidence: localWalletChainEvidence(input.wallet, input.clock),
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
    // @kaspa-x402/client derives the short-lived request authorization from
    // wall-clock time. Keep the signing adapter on that same clock even though
    // the surrounding deterministic proof uses a fixed business clock.
    builder: new ExactTransactionBuilder({ keyStore }),
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
  const paidResponseVerifier = new SompiPaidResponseVerifier();
  const treasuryStaging = new KaspaX402TreasuryStagingAdapter({
    driver: staging,
    now: input.clock,
  });
  const payment = new KaspaX402ExactPaymentModule({
    funding,
    channelSigner: new SecureBatchChannelSigner(
      path.join(input.directory, "batch-channel-keys"),
      input.clock
    ),
    channelStore: new JournalBatchChannelStore(input.journal, input.clock),
    addressCodec: new KaspaTestnet10AddressCodec(),
    transport: input.transport,
    settlementVerifier: chainVerifier,
    recoveryObserver: chainVerifier,
    paidResponseVerifier,
    now: input.clock,
  });
  const stagingRecovery = {
    async prepare() {
      throw new Error("local proof did not expect abandoned staging recovery");
    },
    async observe() {
      throw new Error("local proof did not expect abandoned staging recovery");
    },
    async submit() {
      throw new Error("local proof did not expect abandoned staging recovery");
    },
  };
  const treasury = new VaultTreasuryModule({
    vault: input.vault,
    policy: {
      maxPerPaymentAtomic: "100000000",
      maxPerHourAtomic: "500000000",
      allowlist: [PAY_TO],
    },
    additionalCostCeilingAtomic: ADDITIONAL_COST_CEILING_ATOMIC,
    reservationTtlMs: 120_000,
    staging: treasuryStaging,
    stagingRecovery,
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
      now: input.clock,
      entropy: (length) => new Uint8Array(length).fill(length === 16 ? 0x41 : 0x42),
      workerId: "sompi-e2e-coordinator",
      effectLeaseTtlMs: 5_000,
    }
  );
}

async function invokePurchase(input: {
  mode: LocalTestnetProofReport["initiationMode"];
  coordinator: PurchaseCoordinator;
  intent: PurchaseIntent;
  journal: PurchaseJournal;
  wallet: KaspaWallet;
  vault: VaultManager;
  policy: PolicyEngine;
}): Promise<PurchaseView> {
  if (input.mode === "direct-purchase-module") {
    return input.coordinator.purchase(input.intent);
  }
  if (input.mode !== "mcp-sdk-in-memory-transport") {
    throw new Error("local proof initiation mode is unsupported");
  }
  const server = createSompiMcpServer(
    purchaseProofApplication(createPurchaseApplication(input.coordinator)),
    "e2e-human-present-proof"
  );
  const client = new Client({ name: "sompi-e2e-agent", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "purchase",
      arguments: {
        requestKey: input.intent.requestKey,
        url: input.intent.resource.url,
        method: input.intent.resource.method,
        ...(input.intent.resource.body
          ? { bodyBase64: Buffer.from(input.intent.resource.body).toString("base64") }
          : {}),
        ...(input.intent.resource.mediaType
          ? { mediaType: input.intent.resource.mediaType }
          : {}),
        ...(input.intent.expectedMerchant?.id
          ? { expectedMerchantId: input.intent.expectedMerchant.id }
          : {}),
        ...(input.intent.expectedMerchant?.origin
          ? { expectedMerchantOrigin: input.intent.expectedMerchant.origin }
          : {}),
      },
    });
    const publicView = parseMcpPurchaseResult(result);
    const authoritative = await input.coordinator.status(publicView.id as PurchaseId);
    if (
      authoritative.id !== publicView.id ||
      authoritative.state !== publicView.state ||
      authoritative.requestKey !== publicView.requestKey
    ) {
      throw new Error("MCP Purchase result does not match canonical Purchase state");
    }
    return authoritative;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function purchaseProofApplication(application: PurchaseApplication): SompiApplication {
  const unavailable = async (): Promise<never> => { throw new Error("wallet and Transfer surfaces are outside this Purchase proof"); };
  return Object.freeze({
    ...application,
    wallet: unavailable,
    walletTechnical: unavailable,
    activity: async () => [],
    transfer: unavailable,
    transferStatus: unavailable,
    transferRecover: unavailable,
    changePolicy: unavailable,
    policyChangeStatus: unavailable,
    policyChangeRecover: unavailable,
    vaultMigration: unavailable,
    vaultMigrationStatus: unavailable,
  });
}

function localWalletChainEvidence(wallet: KaspaWallet, now: () => number) {
  return {
    async observe(request: any) {
      const rpc = await wallet.client();
      const response = await rpc.getUtxosByAddresses([...request.watchedAddresses]);
      const entries = response.entries as any[];
      const scores: bigint[] = [];
      const present = request.expectedOutputs.every((expected: any) => {
        const match = entries.find((entry) => {
          const outpoint = entry?.outpoint ?? entry?.entry?.outpoint;
          return String(outpoint?.transactionId) === request.transactionId &&
            Number(outpoint?.index) === expected.index &&
            BigInt(entry?.amount ?? entry?.entry?.amount ?? -1) === BigInt(expected.amountAtomic);
        });
        if (match) scores.push(BigInt(match?.blockDaaScore ?? match?.entry?.blockDaaScore ?? 0));
        return Boolean(match);
      });
      if (!present) return { status: "absent" as const, detailDigest: evidenceDigest(`local-absent:${request.transactionId}`), observedAtMs: now() };
      const score = scores.reduce((max, value) => value > max ? value : max, 0n);
      if (score <= 0n) return { status: "present" as const, level: "provisional" as const, view: "current" as const, detailDigest: evidenceDigest(`local-provisional:${request.transactionId}`), observedAtMs: now() };
      return { status: "present" as const, level: "accepted" as const, view: "current" as const, detailDigest: evidenceDigest(`local-accepted:${request.transactionId}`), acceptingBlockDaaScore: score.toString(), observedAtMs: now() };
    },
  };
}

function parseMcpPurchaseResult(result: unknown): {
  id: string;
  requestKey: string;
  state: string;
} {
  const candidate = result as {
    isError?: unknown;
    content?: readonly { type?: unknown; text?: unknown }[];
  };
  const first = candidate.content?.[0];
  if (
    candidate.isError === true ||
    first?.type !== "text" ||
    typeof first.text !== "string"
  ) {
    throw new Error("MCP Purchase invocation failed safely");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(first.text);
  } catch {
    throw new Error("MCP Purchase result is malformed");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("MCP Purchase result is malformed");
  }
  const view = decoded as Record<string, unknown>;
  if (
    typeof view.id !== "string" ||
    !/^pur_[A-Za-z0-9_-]{22}$/.test(view.id) ||
    typeof view.requestKey !== "string" ||
    typeof view.state !== "string"
  ) {
    throw new Error("MCP Purchase result is malformed");
  }
  return { id: view.id, requestKey: view.requestKey, state: view.state };
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
    checkoutEvidenceVerifier: new KaspaX402AuthorityEvidenceVerifier(),
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

function externalAuthorityContext(
  external: RunLocalTestnetProofOptions["externalAuthority"],
  fixtureModule: Ap2AuthorityModule | undefined
): Readonly<{
  module: Ap2AuthorityModule;
  trust: Ap2PublicKeyResolver;
  issuer: string;
  instrumentId: string;
  mode: LocalTestnetProofReport["authorityMode"];
}> {
  if (!external) {
    if (!fixtureModule) throw new Error("local authority fixture is unavailable");
    return Object.freeze({
      module: fixtureModule,
      trust: fixedTrustStore(),
      issuer: AUTHORITY_SIGNER.issuer,
      instrumentId: FIXED_INSTRUMENT_ID,
      mode: "real-unix-framed-service-in-process-fixture" as const,
    });
  }
  if (
    !(external.module instanceof Ap2AuthorityModule) ||
    !external.trust ||
    typeof external.trust.resolve !== "function" ||
    external.mode !== "separate-process-human-present" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(external.issuer) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(external.instrumentId)
  ) {
    throw new Error("external authority proof configuration is invalid");
  }
  return external;
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
      id: FIXED_MERCHANT_ORIGIN,
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
  authorityMode: LocalTestnetProofReport["authorityMode"],
  initiationMode: LocalTestnetProofReport["initiationMode"],
  generatedAtMs: number,
  injectedFaultPoint?: JournalFaultPoint
): LocalTestnetProofReport {
  if (first.state !== "receipted") {
    throw new Error("proof report requires a receipted Purchase");
  }
  const terms = journal.requireCheckoutTerms(first.id);
  const authorization = journal.requireAuthorization(first.id);
  const attempt = journal.requirePaymentAttempt(first.id, 1);
  const staging = journal.findTreasuryStagingObservation(first.id, 1);
  const spend = journal.findSettlementForPurchase(first.id);
  const fulfilment = journal.findFulfilment(first.id);
  const receipts = journal.receipts(first.id);
  if (!staging || !spend || !fulfilment || receipts.length !== 1) {
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
    throw new Error("local proof did not preserve authority/x402 wire separation");
  }
  const report: LocalTestnetProofReport = Object.freeze({
    profile: LOCAL_TESTNET_PROOF_PROFILE,
    generatedAt: new Date(generatedAtMs).toISOString(),
    chainMode: "deterministic-in-memory-testnet10",
    liveNetworkConformanceClaimed: false,
    authorityMode,
    initiationMode,
    merchantProfile: "generic-x402",
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
      authorityDataInX402Request: false,
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

function readProofClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("local proof clock is unavailable");
  }
  return value;
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
