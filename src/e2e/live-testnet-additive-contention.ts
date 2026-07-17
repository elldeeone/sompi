import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  DirectModeClient,
  MemoryChannelStore,
  type CreatePaymentResult,
} from "@kaspa-x402/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  sha256Hex,
  stableStringify,
  type Hash32Hex,
  type PaymentRequired,
  type SignatureHex,
} from "@kaspa-x402/core";
import {
  DirectModeServer,
  type ExactHeadRecord,
  type ServerResponse,
} from "@kaspa-x402/server";

import {
  ExactTransactionBuilder,
  KaspaTestnet10AddressCodec,
  SOMPI_EXACT_FEE_POLICY,
  StagingKeyStore,
  VaultTreasuryFundingProvider,
} from "../adapters/kaspa-x402/index.js";
import { HttpsAcceptedChainWitness, WrpcOperatorChainObserver } from "../chain-evidence/sources.js";
import type { ChainEvidenceRequest, ChainSourceEvidence } from "../chain-evidence/types.js";
import { JournalChainEvidenceStore } from "../chain-evidence/journal-store.js";
import { ChainEvidenceModule } from "../chain-evidence/module.js";
import { SqliteMerchantServerStateStore } from "../demo/merchant-server-store.js";
import { Transaction, calculateTransactionFee, calculateTransactionMass } from "../kaspa-wasm.js";
import { PolicyEngine } from "../policy.js";
import { createPaymentIdentifier, createPurchaseId } from "../purchase/identity.js";
import type { PurchaseId } from "../purchase/types.js";
import { TreasuryOperationModule } from "../treasury/operations.js";
import { WalletTreasuryOperationAdapter } from "../treasury/operation-adapters.js";
import {
  LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
  LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
  LIVE_ADDITIVE_THRESHOLD_ATOMIC,
  LIVE_NETWORK,
  LIVE_PRICE_ATOMIC,
  LIVE_SDK_NETWORK,
  LIVE_TREASURY_FEE_CEILING_ATOMIC,
  LiveMerchantExactVerifier,
  additiveHeadId,
  assertPublicReportExcludesPrivateState,
  bootstrapLiveProof,
  driveLiveTreasuryOperation,
  initializeLiveProof,
  observeCurrentAddressOutpoint,
  secureDirectory,
  verifyLiveChainMilestoneInclusion,
  writeAtomicJson,
  type InitializedLiveProof,
  type LiveChainMilestone,
  type LiveObservedOutpoint,
} from "./live-testnet-support.js";

const RESOURCE_URL = "https://merchant.example/additive-contention";
const MERCHANT_ORIGIN = new URL(RESOURCE_URL).origin;
const REPORT_PROFILE = "urn:sompi:e2e:live-testnet10-additive-contention:1" as const;
const STAGING_AMOUNT_ATOMIC = (
  BigInt(LIVE_PRICE_ATOMIC) + BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi)
).toString();
const SERVER_PUBLIC_KEY = "11".repeat(32);
const REPORT_MODE = 0o600;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;

type CandidateLabel = "first" | "second" | "retry";

export interface RunLiveAdditiveContentionOptions {
  readonly directory: string;
  readonly sourceWalletDirectory: string;
  readonly reportFilename: string;
  readonly onProgress?: (message: string) => void;
}

interface StagedCandidate {
  readonly label: CandidateLabel;
  readonly purchaseId: PurchaseId;
  readonly paymentIdentifier: string;
  readonly requestHash: Hash32Hex;
  readonly operationKey: string;
  readonly keyReference: string;
  readonly address: string;
  readonly publicKey: string;
  readonly scriptPublicKey: string;
  readonly outpoint: { readonly txid: string; readonly index: number };
  readonly observed: LiveObservedOutpoint;
  readonly stagingFeeAtomic: string;
}

interface PreparedCandidate extends StagedCandidate {
  readonly payment: CreatePaymentResult;
  readonly transactionId: Hash32Hex;
  readonly transactionFeeAtomic: string;
  readonly transactionMass: string;
  readonly headOutpoint: { readonly txid: string; readonly index: number };
  readonly headVersion: string;
  readonly headAmountAtomic: string;
}

interface ContentionProofState {
  readonly version: 1;
  readonly runId: string;
  readonly initialHeadOutpoint: string;
  readonly phase:
    | "prepared"
    | "winner_accepted"
    | "loser_reconciled"
    | "retry_prepared"
    | "complete";
  readonly first: PreparedCandidate;
  readonly second: PreparedCandidate;
  readonly advancedHead?: ExactHeadRecord;
  readonly advancedObservation?: LiveObservedOutpoint;
  readonly correctiveHeader?: string;
  readonly loserWitnessEvidenceDigest?: string;
  readonly loserOperatorEvidenceDigest?: string;
  readonly retry?: PreparedCandidate;
  readonly finalHead?: ExactHeadRecord;
  readonly finalObservation?: LiveObservedOutpoint;
}

export interface LiveAdditiveContentionReport {
  readonly profile: typeof REPORT_PROFILE;
  readonly generatedAt: string;
  readonly network: typeof LIVE_NETWORK;
  readonly chainProvenance: {
    readonly nodeVersion: string;
    readonly nodeNetwork: "testnet-10";
    readonly nodeVirtualDaaScore: string;
    readonly nodeSynced: true;
    readonly nodeUtxoIndex: true;
  };
  readonly protocol: {
    readonly binding: "kaspa-exact-v2";
    readonly exactProfile: "additive";
    readonly packageVersion: "0.1.0-alpha.8";
    readonly transactionEncoding: "kaspa-sdk-safe-json-v2.0.0";
  };
  readonly initialHead: LiveChainMilestone & {
    readonly headId: string;
    readonly version: "0";
    readonly amountAtomic: typeof LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC;
  };
  readonly candidates: readonly [ContentionCandidateReport, ContentionCandidateReport];
  readonly winner: {
    readonly label: "first";
    readonly transactionId: string;
    readonly status: 200;
    readonly successorOutpoint: string;
    readonly successorAmountAtomic: string;
    readonly merchantGainAtomic: typeof LIVE_PRICE_ATOMIC;
    readonly successorBlockDaaScore: string;
    readonly successorVirtualDaaScore: string;
    readonly successorFinality: "accepted" | "confirmed";
  };
  readonly loser: {
    readonly label: "second";
    readonly transactionId: string;
    readonly status: 402;
    readonly correctiveHeadOutpoint: string;
    readonly correctiveHeadVersion: string;
    readonly operatorObservation: "absent";
    readonly witnessObservation: "absent";
    readonly operatorEvidenceDigest: string;
    readonly witnessEvidenceDigest: string;
    readonly stagingOutpointStillUnspent: true;
  };
  readonly explicitRetry: ContentionCandidateReport & {
    readonly status: 200;
    readonly priorHeadOutpoint: string;
    readonly successorOutpoint: string;
    readonly successorAmountAtomic: string;
    readonly successorBlockDaaScore: string;
    readonly successorVirtualDaaScore: string;
    readonly successorFinality: "accepted" | "confirmed";
    readonly separatelyAuthorized: true;
  };
  readonly assertions: {
    readonly bothCandidatesSignedBeforeFirstSubmission: true;
    readonly oneWinner: true;
    readonly loserPaidNothing: true;
    readonly unansweredOffersConsumedNoHead: true;
    readonly correctiveOfferAdvancedHead: true;
    readonly trustedAbsenceBeforeRetry: true;
    readonly retryUsedFreshStagingAndAuthorization: true;
    readonly noAutomaticCorrectiveResigning: true;
  };
}

interface ContentionCandidateReport {
  readonly label: CandidateLabel;
  readonly purchaseId: string;
  readonly paymentIdentifier: string;
  readonly requestHash: string;
  readonly stagingOutpoint: string;
  readonly transactionId: string;
  readonly transactionFeeAtomic: string;
  readonly transactionMass: string;
  readonly headOutpoint: string;
  readonly headVersion: string;
  readonly headAmountAtomic: string;
}

export async function runLiveAdditiveContentionProof(
  options: RunLiveAdditiveContentionOptions
): Promise<LiveAdditiveContentionReport> {
  assertProofPaths(options);
  const initialized = initializeLiveProof(options.directory, options.sourceWalletDirectory);
  const close: Array<() => void | Promise<void>> = [
    () => initialized.observerWallet.disconnect(),
    () => initialized.merchantWallet.disconnect(),
    () => initialized.treasuryWallet.disconnect(),
  ];
  try {
    const bootstrap = await bootstrapLiveProof({ initialized, onProgress: options.onProgress });
    close.push(() => bootstrap.journal.close());
    const initialHead = bootstrap.progress.additiveHead;
    if (!initialHead) throw new Error("funded additive contention proof has no initial head");
    await verifyLiveChainMilestoneInclusion(initialHead, initialized.observerWallet);

    const keyStore = new StagingKeyStore({
      directory: path.join(initialized.layout.root, "contention", "staging-keys"),
    });
    const bindings = (["first", "second", "retry"] as const).map((label) => {
      const purchaseId = contentionPurchaseId(initialized, label);
      const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
      return Object.freeze({
        label,
        purchaseId,
        paymentIdentifier,
        key: keyStore.create({ purchaseId, paymentIdentifier }),
      });
    });
    const stagingModule = contentionStagingModule(
      initialized,
      bootstrap.journal,
      bindings.map((binding) => binding.key.address)
    );
    const staged: StagedCandidate[] = [];
    for (const binding of bindings) {
      staged.push(await stageCandidate({
        initialized,
        journal: bootstrap.journal,
        module: stagingModule,
        binding,
        onProgress: options.onProgress,
      }));
    }

    const merchantStorePath = path.join(initialized.layout.root, "contention", "merchant.sqlite");
    secureDirectory(path.dirname(merchantStorePath));
    const merchantStore = new SqliteMerchantServerStateStore(merchantStorePath);
    close.push(() => merchantStore.close());
    const originalHead = await registerInitialHead(initialized, initialHead, merchantStore);
    const statePath = path.join(initialized.layout.root, "contention", "state.json");
    let state = readContentionState(
      statePath,
      initialized.config.runId,
      originalHead,
      staged
    );
    if (!state) {
      const firstServer = await contentionServer(
        initialized,
        merchantStore,
        originalHead,
        path.join(initialized.layout.root, "contention", "first-verifier.json")
      );
      const secondServer = await contentionServer(
        initialized,
        merchantStore,
        originalHead,
        path.join(initialized.layout.root, "contention", "second-verifier.json")
      );
      const [firstOffer, secondOffer] = await Promise.all([
        offer(firstServer),
        offer(secondServer),
      ]);
      assertSameAdvertisedHead(firstOffer, secondOffer, originalHead);
      await assertHeadUnchangedAfterOffers(merchantStore, originalHead);
      const first = await prepareCandidate(firstOffer, staged[0]!, keyStore, initialized);
      const second = await prepareCandidate(secondOffer, staged[1]!, keyStore, initialized);
      if (first.transactionId === second.transactionId) {
        throw new Error("contention candidates unexpectedly share one transaction identity");
      }
      state = Object.freeze({
        version: 1 as const,
        runId: initialized.config.runId,
        initialHeadOutpoint: `${originalHead.currentOutpoint.txid}:${originalHead.currentOutpoint.index}`,
        phase: "prepared" as const,
        first,
        second,
      });
      writeContentionState(statePath, state);
      options.onProgress?.("two independently authorized candidates are durable before first submission");
    }

    const first = state.first;
    const second = state.second;
    if (state.phase === "prepared") {
      const firstServer = await contentionServer(
        initialized,
        merchantStore,
        originalHead,
        path.join(initialized.layout.root, "contention", "first-verifier.json")
      );
      const firstResponse = await submitCandidate(firstServer, first);
      if (firstResponse.status !== 200) {
        throw new Error(`first additive contention candidate returned ${firstResponse.status}`);
      }
      applySettlementResponse(first, firstResponse);
      const advancedHead = await requireAdvancedHead(merchantStore, originalHead, first.transactionId);
      const advancedObservation = await observeCurrentAddressOutpoint({
        wallet: initialized.observerWallet,
        address: initialized.config.additiveHead.address,
        outpoint: `${advancedHead.currentOutpoint.txid}:${advancedHead.currentOutpoint.index}`,
        amountAtomic: advancedHead.currentAmount,
      });
      state = Object.freeze({
        ...state,
        phase: "winner_accepted" as const,
        advancedHead,
        advancedObservation,
      });
      writeContentionState(statePath, state);
    }
    const advanced = requireStateAdvancedHead(state, originalHead, first);
    const advancedObservation = requireStateObservation(
      state.advancedObservation,
      advanced,
      "winner"
    );

    if (state.phase === "winner_accepted") {
      const secondServer = await contentionServer(
        initialized,
        merchantStore,
        originalHead,
        path.join(initialized.layout.root, "contention", "second-verifier.json")
      );
      const secondResponse = await submitCandidate(secondServer, second);
      if (secondResponse.status !== 402) {
        throw new Error(`stale additive contention candidate returned ${secondResponse.status}`);
      }
      const correctiveHeader = requiredHeader(secondResponse, "PAYMENT-REQUIRED");
      assertCorrectiveHead(decodePaymentRequiredHeader(correctiveHeader), advanced);
      const absence = await proveLosingCandidateAbsent(initialized, second);
      state = Object.freeze({
        ...state,
        phase: "loser_reconciled" as const,
        correctiveHeader,
        loserWitnessEvidenceDigest: absence.witness.detailDigest,
        loserOperatorEvidenceDigest: absence.operator.detailDigest,
      });
      writeContentionState(statePath, state);
    }
    const correctiveHeader = requiredStateString(state.correctiveHeader, "corrective header");
    assertCorrectiveHead(decodePaymentRequiredHeader(correctiveHeader), advanced);
    const loserWitnessEvidenceDigest = requiredDigest(
      state.loserWitnessEvidenceDigest,
      "loser witness evidence"
    );
    const loserOperatorEvidenceDigest = requiredDigest(
      state.loserOperatorEvidenceDigest,
      "loser operator evidence"
    );

    if (state.phase === "loser_reconciled") {
      const retry = await prepareCandidate(correctiveHeader, staged[2]!, keyStore, initialized);
      if (
        retry.paymentIdentifier === second.paymentIdentifier ||
        retry.purchaseId === second.purchaseId ||
        retry.outpoint.txid === second.outpoint.txid
      ) throw new Error("explicit retry reused the losing authorization or staging capability");
      state = Object.freeze({ ...state, phase: "retry_prepared" as const, retry });
      writeContentionState(statePath, state);
    }
    const retry = requirePreparedStateCandidate(state.retry, staged[2]!, advanced, "retry");
    if (state.phase === "retry_prepared") {
      const retryServer = await contentionServer(
        initialized,
        merchantStore,
        advanced,
        path.join(initialized.layout.root, "contention", "retry-verifier.json")
      );
      const retryResponse = await submitCandidate(retryServer, retry);
      if (retryResponse.status !== 200) {
        throw new Error(`explicit additive retry returned ${retryResponse.status}`);
      }
      applySettlementResponse(retry, retryResponse);
      const finalHead = await requireAdvancedHead(merchantStore, advanced, retry.transactionId);
      const finalObservation = await observeCurrentAddressOutpoint({
        wallet: initialized.observerWallet,
        address: initialized.config.additiveHead.address,
        outpoint: `${finalHead.currentOutpoint.txid}:${finalHead.currentOutpoint.index}`,
        amountAtomic: finalHead.currentAmount,
      });
      state = Object.freeze({
        ...state,
        phase: "complete" as const,
        finalHead,
        finalObservation,
      });
      writeContentionState(statePath, state);
    }
    if (state.phase !== "complete") {
      throw new Error(`contention proof stopped in unexpected phase ${state.phase}`);
    }
    const finalHead = requireStateAdvancedHead(state, advanced, retry);
    const finalObservation = requireStateObservation(state.finalObservation, finalHead, "retry");
    const node = await initialized.merchantWallet.serverInfo();

    const report: LiveAdditiveContentionReport = Object.freeze({
      profile: REPORT_PROFILE,
      generatedAt: new Date().toISOString(),
      network: LIVE_NETWORK,
      chainProvenance: Object.freeze({
        nodeVersion: String(node.serverVersion),
        nodeNetwork: "testnet-10" as const,
        nodeVirtualDaaScore: String(node.virtualDaaScore),
        nodeSynced: true as const,
        nodeUtxoIndex: true as const,
      }),
      protocol: Object.freeze({
        binding: "kaspa-exact-v2" as const,
        exactProfile: "additive" as const,
        packageVersion: "0.1.0-alpha.8" as const,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
      }),
      initialHead: Object.freeze({
        ...initialHead,
        headId: originalHead.headId,
        version: "0" as const,
        amountAtomic: LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
      }),
      candidates: Object.freeze([candidateReport(first), candidateReport(second)] as const),
      winner: Object.freeze({
        label: "first" as const,
        transactionId: first.transactionId,
        status: 200 as const,
        successorOutpoint: `${advanced.currentOutpoint.txid}:${advanced.currentOutpoint.index}`,
        successorAmountAtomic: advanced.currentAmount,
        merchantGainAtomic: LIVE_PRICE_ATOMIC,
        successorBlockDaaScore: advancedObservation.blockDaaScore,
        successorVirtualDaaScore: advancedObservation.virtualDaaScore,
        successorFinality: advancedObservation.finality,
      }),
      loser: Object.freeze({
        label: "second" as const,
        transactionId: second.transactionId,
        status: 402 as const,
        correctiveHeadOutpoint: `${advanced.currentOutpoint.txid}:${advanced.currentOutpoint.index}`,
        correctiveHeadVersion: advanced.version,
        operatorObservation: "absent" as const,
        witnessObservation: "absent" as const,
        operatorEvidenceDigest: loserOperatorEvidenceDigest,
        witnessEvidenceDigest: loserWitnessEvidenceDigest,
        stagingOutpointStillUnspent: true as const,
      }),
      explicitRetry: Object.freeze({
        ...candidateReport(retry),
        status: 200 as const,
        priorHeadOutpoint: `${advanced.currentOutpoint.txid}:${advanced.currentOutpoint.index}`,
        successorOutpoint: `${finalHead.currentOutpoint.txid}:${finalHead.currentOutpoint.index}`,
        successorAmountAtomic: finalHead.currentAmount,
        successorBlockDaaScore: finalObservation.blockDaaScore,
        successorVirtualDaaScore: finalObservation.virtualDaaScore,
        successorFinality: finalObservation.finality,
        separatelyAuthorized: true as const,
      }),
      assertions: Object.freeze({
        bothCandidatesSignedBeforeFirstSubmission: true as const,
        oneWinner: true as const,
        loserPaidNothing: true as const,
        unansweredOffersConsumedNoHead: true as const,
        correctiveOfferAdvancedHead: true as const,
        trustedAbsenceBeforeRetry: true as const,
        retryUsedFreshStagingAndAuthorization: true as const,
        noAutomaticCorrectiveResigning: true as const,
      }),
    });
    assertLiveAdditiveContentionReport(report);
    assertPublicReportExcludesPrivateState(report, initialized);
    assertContentionKeyMaterialExcluded(
      report,
      path.join(initialized.layout.root, "contention", "staging-keys")
    );
    writeReport(options.reportFilename, report);
    options.onProgress?.("additive contention, trusted absence, and explicit retry are proven");
    return report;
  } finally {
    const errors: unknown[] = [];
    for (const release of close.reverse()) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "contention proof cleanup failed");
  }
}

export function liveAdditiveContentionReportDigest(report: LiveAdditiveContentionReport): string {
  assertLiveAdditiveContentionReport(report);
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

export function assertLiveAdditiveContentionReport(
  report: LiveAdditiveContentionReport
): void {
  if (
    report.profile !== REPORT_PROFILE ||
    report.network !== LIVE_NETWORK ||
    report.protocol.binding !== "kaspa-exact-v2" ||
    report.protocol.exactProfile !== "additive" ||
    report.protocol.packageVersion !== "0.1.0-alpha.8" ||
    report.chainProvenance.nodeNetwork !== "testnet-10" ||
    report.chainProvenance.nodeSynced !== true ||
    report.chainProvenance.nodeUtxoIndex !== true ||
    report.initialHead.amountAtomic !== LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC ||
    report.candidates.length !== 2 ||
    report.candidates[0].label !== "first" ||
    report.candidates[1].label !== "second" ||
    report.candidates[0].headOutpoint !== report.candidates[1].headOutpoint ||
    report.candidates[0].headVersion !== report.candidates[1].headVersion ||
    report.initialHead.outpoint.split(":")[0] !== report.initialHead.transactionId ||
    report.candidates.some((candidate) =>
      candidate.headOutpoint !== report.initialHead.outpoint ||
      candidate.headVersion !== report.initialHead.version ||
      candidate.headAmountAtomic !== report.initialHead.amountAtomic
    ) ||
    report.candidates[0].transactionId === report.candidates[1].transactionId ||
    report.winner.transactionId !== report.candidates[0].transactionId ||
    report.loser.transactionId !== report.candidates[1].transactionId ||
    report.winner.status !== 200 ||
    report.winner.successorOutpoint !== `${report.winner.transactionId}:0` ||
    report.loser.status !== 402 ||
    report.winner.merchantGainAtomic !== LIVE_PRICE_ATOMIC ||
    BigInt(report.winner.successorAmountAtomic) - BigInt(report.initialHead.amountAtomic) !==
      BigInt(LIVE_PRICE_ATOMIC) ||
    (report.winner.successorFinality !== "accepted" && report.winner.successorFinality !== "confirmed") ||
    report.loser.operatorObservation !== "absent" ||
    report.loser.witnessObservation !== "absent" ||
    report.loser.stagingOutpointStillUnspent !== true ||
    report.loser.correctiveHeadOutpoint !== report.winner.successorOutpoint ||
    report.explicitRetry.status !== 200 ||
    report.explicitRetry.transactionId === report.winner.transactionId ||
    report.explicitRetry.priorHeadOutpoint !== report.winner.successorOutpoint ||
    report.explicitRetry.headOutpoint !== report.winner.successorOutpoint ||
    report.explicitRetry.headVersion !== report.loser.correctiveHeadVersion ||
    report.explicitRetry.headAmountAtomic !== report.winner.successorAmountAtomic ||
    report.explicitRetry.successorOutpoint !== `${report.explicitRetry.transactionId}:0` ||
    BigInt(report.explicitRetry.successorAmountAtomic) - BigInt(report.winner.successorAmountAtomic) !==
      BigInt(LIVE_PRICE_ATOMIC) ||
    (report.explicitRetry.successorFinality !== "accepted" &&
      report.explicitRetry.successorFinality !== "confirmed") ||
    report.explicitRetry.transactionId === report.loser.transactionId ||
    report.explicitRetry.stagingOutpoint === report.candidates[1].stagingOutpoint ||
    report.explicitRetry.separatelyAuthorized !== true ||
    Object.values(report.assertions).some((value) => value !== true)
  ) {
    throw new Error("live additive contention report invariants changed");
  }
  for (const candidate of [...report.candidates, report.explicitRetry]) {
    if (
      !HASH32.test(candidate.transactionId) ||
      !HASH32.test(candidate.requestHash) ||
      !/^[a-f0-9]{64}:[0-9]+$/.test(candidate.stagingOutpoint) ||
      BigInt(candidate.transactionFeeAtomic) <= 0n ||
      BigInt(candidate.transactionMass) <= 0n
    ) throw new Error("live additive contention candidate evidence is invalid");
  }
  if (!DIGEST.test(report.loser.operatorEvidenceDigest) || !DIGEST.test(report.loser.witnessEvidenceDigest)) {
    throw new Error("live additive contention absence evidence is invalid");
  }
  const encoded = JSON.stringify(report);
  if (
    Buffer.byteLength(encoded) > MAX_REPORT_BYTES ||
    /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) throw new Error("live additive contention report contains private state");
}

async function stageCandidate(input: {
  readonly initialized: InitializedLiveProof;
  readonly journal: ReturnType<typeof bootstrapLiveProof> extends Promise<infer T>
    ? T extends { journal: infer J } ? J : never
    : never;
  readonly module: TreasuryOperationModule;
  readonly binding: {
    readonly label: CandidateLabel;
    readonly purchaseId: PurchaseId;
    readonly paymentIdentifier: string;
    readonly key: ReturnType<StagingKeyStore["create"]>;
  };
  readonly onProgress?: (message: string) => void;
}): Promise<StagedCandidate> {
  const operationKey = `live:${input.initialized.config.runId}:contention:${input.binding.label}:staging`;
  const request = Object.freeze({
    operationKey,
    kind: "wallet_send" as const,
    destination: input.binding.key.address,
    amountAtomic: STAGING_AMOUNT_ATOMIC,
  });
  const existing = Boolean(input.journal.findTreasuryOperation(operationKey));
  await driveLiveTreasuryOperation(input.module, request, input.onProgress, existing);
  const detail = input.journal.readObservedTreasuryOperationDetail(operationKey);
  const outpoint = parseOutpoint(requiredString(detail.destinationOutpoint, "contention staging outpoint"));
  const observed = await observeCurrentAddressOutpoint({
    wallet: input.initialized.observerWallet,
    address: input.binding.key.address,
    outpoint: `${outpoint.txid}:${outpoint.index}`,
    amountAtomic: STAGING_AMOUNT_ATOMIC,
  });
  const prepared = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    input.journal.readPreparedTreasuryOperation(operationKey)
  )) as Record<string, any>;
  const stagingFeeAtomic = requiredAtomic(prepared?.prepared?.feeAtomic, "contention staging fee");
  const requestHash = sha256Hex(stableStringify({
    scope: "sompi:live-additive-contention-request:v1",
    purchaseId: input.binding.purchaseId,
    paymentIdentifier: input.binding.paymentIdentifier,
    url: RESOURCE_URL,
    method: "GET",
  })) as Hash32Hex;
  return Object.freeze({
    label: input.binding.label,
    purchaseId: input.binding.purchaseId,
    paymentIdentifier: input.binding.paymentIdentifier,
    requestHash,
    operationKey,
    keyReference: input.binding.key.keyReference,
    address: input.binding.key.address,
    publicKey: input.binding.key.publicKey,
    scriptPublicKey: input.binding.key.scriptPublicKey,
    outpoint,
    observed,
    stagingFeeAtomic,
  });
}

function contentionStagingModule(
  initialized: InitializedLiveProof,
  journal: Parameters<typeof stageCandidate>[0]["journal"],
  allowlist: readonly string[]
): TreasuryOperationModule {
  const chainEvidence = new ChainEvidenceModule(
    new WrpcOperatorChainObserver({ rpc: initialized.treasuryWallet, depthConfirmationDaa: 10 }),
    new HttpsAcceptedChainWitness({
      baseUrl: "https://api-tn10.kaspa.org/",
      depthConfirmationDaa: 10,
      fetch: globalThis.fetch,
    }),
    new JournalChainEvidenceStore(journal)
  );
  return new TreasuryOperationModule({
    journal,
    policy: new PolicyEngine({
      maxSompiPerTx: BigInt(STAGING_AMOUNT_ATOMIC),
      maxSompiPerHour: BigInt(STAGING_AMOUNT_ATOMIC) * 3n,
      allowlist: [...allowlist],
      requireApprovalAboveSompi: 0n,
    }),
    adapters: [new WalletTreasuryOperationAdapter(initialized.treasuryWallet, chainEvidence, "accepted")],
    feeCeilingAtomic: LIVE_TREASURY_FEE_CEILING_ATOMIC,
  });
}

async function registerInitialHead(
  initialized: InitializedLiveProof,
  milestone: LiveChainMilestone,
  store: SqliteMerchantServerStateStore
): Promise<ExactHeadRecord> {
  const outpoint = parseOutpoint(milestone.outpoint);
  const original = Object.freeze({
    headId: additiveHeadId(initialized.config, milestone.outpoint),
    network: LIVE_NETWORK,
    payTo: initialized.config.additiveHead.address,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: outpoint.txid, index: outpoint.index },
    currentAmount: LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
    scriptPublicKey: initialized.config.additiveHead.scriptPublicKey,
    redeemScript: initialized.config.additiveHead.redeemScript,
    additiveThresholdSompi: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
    version: "0",
    status: "available",
    createdAt: initialized.config.createdAt,
    updatedAt: initialized.config.createdAt,
  });
  const existing = await store.loadExactHead(original.headId);
  if (!existing) return store.registerExactHead(original);
  if (
    existing.network !== original.network ||
    existing.payTo !== original.payTo ||
    existing.templateId !== original.templateId ||
    existing.transactionEncoding !== original.transactionEncoding ||
    existing.scriptPublicKey !== original.scriptPublicKey ||
    existing.redeemScript !== original.redeemScript ||
    existing.additiveThresholdSompi !== original.additiveThresholdSompi ||
    BigInt(existing.version) < 0n ||
    BigInt(existing.version) > 2n
  ) throw new Error("persisted contention head is not a successor of the configured launch head");
  return original;
}

function readContentionState(
  filename: string,
  runId: string,
  originalHead: ExactHeadRecord,
  staged: readonly StagedCandidate[]
): ContentionProofState | undefined {
  if (!fs.existsSync(filename)) return undefined;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_REPORT_BYTES) {
    throw new Error("contention proof state file is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error("contention proof state is malformed", { cause: error });
  }
  const state = value as ContentionProofState;
  if (
    state.version !== 1 ||
    state.runId !== runId ||
    state.initialHeadOutpoint !== `${originalHead.currentOutpoint.txid}:${originalHead.currentOutpoint.index}` ||
    !["prepared", "winner_accepted", "loser_reconciled", "retry_prepared", "complete"].includes(state.phase)
  ) throw new Error("contention proof state belongs to a different run");
  requirePreparedStateCandidate(state.first, staged[0]!, originalHead, "first");
  requirePreparedStateCandidate(state.second, staged[1]!, originalHead, "second");
  if (state.first.transactionId === state.second.transactionId) {
    throw new Error("persisted contention candidates share one transaction identity");
  }
  if (state.phase !== "prepared") {
    const advanced = requireStateAdvancedHead(state, originalHead, state.first);
    requireStateObservation(state.advancedObservation, advanced, "winner");
  }
  if (["loser_reconciled", "retry_prepared", "complete"].includes(state.phase)) {
    const advanced = requireStateAdvancedHead(state, originalHead, state.first);
    assertCorrectiveHead(
      decodePaymentRequiredHeader(requiredStateString(state.correctiveHeader, "corrective header")),
      advanced
    );
    requiredDigest(state.loserWitnessEvidenceDigest, "loser witness evidence");
    requiredDigest(state.loserOperatorEvidenceDigest, "loser operator evidence");
  }
  if (state.phase === "retry_prepared" || state.phase === "complete") {
    const advanced = requireStateAdvancedHead(state, originalHead, state.first);
    requirePreparedStateCandidate(state.retry, staged[2]!, advanced, "retry");
  }
  if (state.phase === "complete") {
    const advanced = requireStateAdvancedHead(state, originalHead, state.first);
    const retry = requirePreparedStateCandidate(state.retry, staged[2]!, advanced, "retry");
    const finalHead = requireStateAdvancedHead(state, advanced, retry);
    requireStateObservation(state.finalObservation, finalHead, "retry");
  }
  return Object.freeze(state);
}

function writeContentionState(filename: string, state: ContentionProofState): void {
  const encoded = JSON.stringify(state);
  if (
    Buffer.byteLength(encoded) <= 0 ||
    Buffer.byteLength(encoded) > MAX_REPORT_BYTES ||
    /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) throw new Error("contention proof state contains invalid or private material");
  writeAtomicJson(filename, state);
  fs.chmodSync(filename, REPORT_MODE);
}

function requirePreparedStateCandidate(
  candidate: PreparedCandidate | undefined,
  staged: StagedCandidate,
  expectedHead: ExactHeadRecord,
  expectedLabel: CandidateLabel
): PreparedCandidate {
  if (
    !candidate ||
    candidate.label !== expectedLabel ||
    candidate.purchaseId !== staged.purchaseId ||
    candidate.paymentIdentifier !== staged.paymentIdentifier ||
    candidate.requestHash !== staged.requestHash ||
    candidate.keyReference !== staged.keyReference ||
    candidate.address !== staged.address ||
    candidate.scriptPublicKey !== staged.scriptPublicKey ||
    candidate.outpoint.txid !== staged.outpoint.txid ||
    candidate.outpoint.index !== staged.outpoint.index ||
    candidate.headOutpoint.txid !== expectedHead.currentOutpoint.txid ||
    candidate.headOutpoint.index !== expectedHead.currentOutpoint.index ||
    candidate.headVersion !== expectedHead.version ||
    candidate.headAmountAtomic !== expectedHead.currentAmount ||
    !HASH32.test(candidate.transactionId) ||
    candidate.payment.transactionId !== candidate.transactionId
  ) throw new Error(`persisted ${expectedLabel} contention candidate is invalid`);
  const transaction = parseExactTransaction(candidate.payment);
  try {
    const transactionId = String(transaction.finalize()).toLowerCase();
    const fee = calculateTransactionFee(LIVE_SDK_NETWORK, transaction);
    const mass = calculateTransactionMass(LIVE_SDK_NETWORK, transaction);
    if (
      transactionId !== candidate.transactionId ||
      fee?.toString() !== candidate.transactionFeeAtomic ||
      mass?.toString() !== candidate.transactionMass
    ) throw new Error(`persisted ${expectedLabel} contention transaction changed`);
  } finally {
    transaction.free();
  }
  return Object.freeze(candidate);
}

function requireStateAdvancedHead(
  state: ContentionProofState,
  prior: ExactHeadRecord,
  candidate: PreparedCandidate
): ExactHeadRecord {
  const head = prior.version === "0" ? state.advancedHead : state.finalHead;
  if (
    !head ||
    head.headId !== prior.headId ||
    head.network !== prior.network ||
    head.payTo !== prior.payTo ||
    head.status !== "available" ||
    head.currentOutpoint.txid !== candidate.transactionId ||
    head.currentOutpoint.index !== 0 ||
    BigInt(head.currentAmount) - BigInt(prior.currentAmount) !== BigInt(LIVE_PRICE_ATOMIC) ||
    BigInt(head.version) !== BigInt(prior.version) + 1n ||
    head.scriptPublicKey !== prior.scriptPublicKey ||
    head.redeemScript !== prior.redeemScript
  ) throw new Error("persisted contention successor head is invalid");
  return Object.freeze(head);
}

function requireStateObservation(
  observation: LiveObservedOutpoint | undefined,
  head: ExactHeadRecord,
  label: string
): LiveObservedOutpoint {
  if (
    !observation ||
    observation.transactionId !== head.currentOutpoint.txid ||
    observation.outpoint !== `${head.currentOutpoint.txid}:${head.currentOutpoint.index}` ||
    observation.amountAtomic !== head.currentAmount ||
    (observation.finality !== "accepted" && observation.finality !== "confirmed") ||
    BigInt(observation.blockDaaScore) <= 0n ||
    BigInt(observation.virtualDaaScore) < BigInt(observation.blockDaaScore)
  ) throw new Error(`persisted ${label} contention observation is invalid`);
  return Object.freeze(observation);
}

function requiredStateString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4 * 1024 * 1024) {
    throw new Error(`persisted ${label} is invalid`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`persisted ${label} is invalid`);
  }
  return value;
}

async function contentionServer(
  initialized: InitializedLiveProof,
  store: SqliteMerchantServerStateStore,
  head: ExactHeadRecord,
  verifierStatePath: string
): Promise<DirectModeServer> {
  const info = await initialized.merchantWallet.serverInfo();
  const verifier = new LiveMerchantExactVerifier({
    wallet: initialized.merchantWallet,
    statePath: verifierStatePath,
    expected: {
      profile: "additive",
      payTo: initialized.config.additiveHead.address,
      payToScriptPublicKey: initialized.config.additiveHead.scriptPublicKey,
      head: {
        headId: head.headId,
        headVersion: head.version,
        transactionId: head.currentOutpoint.txid,
        index: head.currentOutpoint.index,
        amountAtomic: head.currentAmount,
        scriptPublicKey: head.scriptPublicKey,
        redeemScript: head.redeemScript,
        additiveThresholdAtomic: head.additiveThresholdSompi,
      },
    },
  });
  return new DirectModeServer({
    network: LIVE_NETWORK,
    payTo: initialized.config.additiveHead.address,
    serverPublicKey: SERVER_PUBLIC_KEY,
    minDepositSompi: "1",
    amount: LIVE_PRICE_ATOMIC,
    refundTimeoutDaa: (BigInt(info.virtualDaaScore) + 10_000n).toString(),
    store,
    chainProvider: {
      getUtxo: async () => null,
      getVirtualDaaScore: async () => String((await initialized.merchantWallet.serverInfo()).virtualDaaScore),
      estimateClaimFee: async () => "1",
      sendTransaction: async () => { throw new Error("contention exact broadcast belongs to the verifier"); },
    },
    addressCodec: new KaspaTestnet10AddressCodec(),
    voucherVerifier: { verifyVoucher: () => false },
    exactTransactionVerifier: verifier,
    exactProfile: "additive",
    minimumExactAdditiveThresholdSompi: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
    requirePaymentIdentifier: true,
    acceptedFinality: "accepted",
    allowMainnet: false,
  });
}

async function offer(server: DirectModeServer): Promise<string> {
  const response = await server.paymentRequiredResponseAsync({
    resource: { url: RESOURCE_URL },
    amount: LIVE_PRICE_ATOMIC,
    scheme: "exact",
  });
  if (response.status !== 402) throw new Error(`contention offer returned ${response.status}`);
  return requiredHeader(response, "PAYMENT-REQUIRED");
}

async function prepareCandidate(
  paymentRequiredHeader: string,
  staged: StagedCandidate,
  keyStore: StagingKeyStore,
  initialized: InitializedLiveProof
): Promise<PreparedCandidate> {
  const builder = new ExactTransactionBuilder({ keyStore });
  const provider = new VaultTreasuryFundingProvider({
    getPublicIdentity: async () => ({ address: staged.address, publicKey: staged.publicKey }),
    getVirtualDaaScore: async () => String((await initialized.treasuryWallet.serverInfo()).virtualDaaScore),
    getUtxos: async (addresses) => addresses.includes(staged.address) ? [{
      outpoint: staged.outpoint,
      amount: STAGING_AMOUNT_ATOMIC,
      scriptPublicKey: staged.scriptPublicKey,
      address: staged.address,
    }] : [],
    estimateFees: async () => ({ feeSompi: SOMPI_EXACT_FEE_POLICY.feeSompi }),
    authorizeExactPayment: async (request) => {
      if (
        request.profile !== "additive" ||
        request.amount !== LIVE_PRICE_ATOMIC ||
        request.payTo !== initialized.config.additiveHead.address ||
        request.requestHash !== staged.requestHash ||
        request.fundingSource !== "vault-treasury"
      ) throw new Error("contention signer request differs from its explicit authorization");
    },
    buildExactTransactionDurably: async (request) => builder.build({
      purchaseId: staged.purchaseId,
      paymentIdentifier: staged.paymentIdentifier,
      request,
      staging: {
        outpoint: staged.outpoint,
        amountAtomic: STAGING_AMOUNT_ATOMIC,
        scriptPublicKey: staged.scriptPublicKey,
        address: staged.address,
        blockDaaScore: staged.observed.blockDaaScore,
        keyReference: staged.keyReference,
      },
      additionalCostCeilingAtomic: LIVE_ADDITIONAL_COST_CEILING_ATOMIC,
      stagingTransactionFeeAtomic: staged.stagingFeeAtomic,
    }),
  });
  const client = new DirectModeClient({
    fundingProvider: provider,
    signer: {
      generateChannelKey: async () => ({ publicKey: SERVER_PUBLIC_KEY }),
      randomSalt: async () => "22".repeat(32) as Hash32Hex,
      signVoucher: async () => { throw new Error("batch voucher signing is disabled"); },
    },
    store: new MemoryChannelStore(),
    addressCodec: new KaspaTestnet10AddressCodec(),
    supportedNetworks: [LIVE_NETWORK],
    supportedSchemes: ["exact"],
    fundingPolicy: {
      requiredSource: "vault-treasury",
      allowedOrigins: [MERCHANT_ORIGIN],
      allowedExactProfiles: ["additive"],
      allowedPayTo: [initialized.config.additiveHead.address],
      maximumExactAmountSompi: LIVE_PRICE_ATOMIC,
    },
    maxPaymentRetries: 0,
  });
  const payment = await client.createPayment(paymentRequiredHeader, {
    url: RESOURCE_URL,
    method: "GET",
    origin: MERCHANT_ORIGIN,
    paymentIdentifier: staged.paymentIdentifier,
    requestHash: staged.requestHash,
  });
  if (payment.scheme !== "exact" || !payment.transactionId) {
    throw new Error("contention client did not create one exact transaction");
  }
  const accepted = payment.accepted;
  const extra = accepted.extra as Record<string, any>;
  const transaction = parseExactTransaction(payment);
  try {
    const fee = calculateTransactionFee(LIVE_SDK_NETWORK, transaction);
    const mass = calculateTransactionMass(LIVE_SDK_NETWORK, transaction);
    if (fee === undefined || mass === undefined || fee <= 0n || mass <= 0n) {
      throw new Error("contention transaction fee or mass is invalid");
    }
    return Object.freeze({
      ...staged,
      payment,
      transactionId: payment.transactionId,
      transactionFeeAtomic: fee.toString(),
      transactionMass: mass.toString(),
      headOutpoint: {
        txid: requiredHash(extra.expectedHeadOutpoint?.txid, "contention head transaction ID"),
        index: requiredIndex(extra.expectedHeadOutpoint?.index, "contention head output index"),
      },
      headVersion: requiredAtomic(extra.headVersion, "contention head version"),
      headAmountAtomic: requiredAtomic(extra.headAmount, "contention head amount"),
    });
  } finally {
    transaction.free();
  }
}

async function submitCandidate(
  server: DirectModeServer,
  candidate: PreparedCandidate
): Promise<ServerResponse> {
  return server.handlePaidRequest({
    method: "GET",
    url: RESOURCE_URL,
    resource: { url: RESOURCE_URL },
    paymentAmount: LIVE_PRICE_ATOMIC,
    paymentScheme: "exact",
    requestHash: candidate.requestHash,
    headers: {
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(candidate.payment.paymentPayload),
    },
  }, async () => ({
    status: 200,
    chargedAmount: LIVE_PRICE_ATOMIC,
    body: `${candidate.label}-contention-resource`,
  }));
}

function applySettlementResponse(candidate: PreparedCandidate, response: ServerResponse): void {
  const header = requiredHeader(response, "PAYMENT-RESPONSE");
  const settlement = decodePaymentResponseHeader(header);
  if (!settlement.success || settlement.transaction !== candidate.transactionId) {
    throw new Error("contention settlement response differs from its candidate");
  }
}

async function requireAdvancedHead(
  store: SqliteMerchantServerStateStore,
  prior: ExactHeadRecord,
  transactionId: string
): Promise<ExactHeadRecord> {
  const head = await store.loadExactHead(prior.headId);
  if (
    !head ||
    head.status !== "available" ||
    head.currentOutpoint.txid !== transactionId ||
    head.currentOutpoint.index !== 0 ||
    BigInt(head.currentAmount) - BigInt(prior.currentAmount) !== BigInt(LIVE_PRICE_ATOMIC) ||
    BigInt(head.version) !== BigInt(prior.version) + 1n
  ) throw new Error("accepted contention transaction did not atomically advance the head");
  return head;
}

async function assertHeadUnchangedAfterOffers(
  store: SqliteMerchantServerStateStore,
  expected: ExactHeadRecord
): Promise<void> {
  const current = await store.loadExactHead(expected.headId);
  if (
    !current ||
    current.status !== "available" ||
    current.version !== expected.version ||
    current.currentOutpoint.txid !== expected.currentOutpoint.txid ||
    current.currentOutpoint.index !== expected.currentOutpoint.index ||
    current.currentAmount !== expected.currentAmount ||
    current.lastTransactionId !== expected.lastTransactionId
  ) throw new Error("unpaid additive offers mutated the reusable head");
}

async function proveLosingCandidateAbsent(
  initialized: InitializedLiveProof,
  loser: PreparedCandidate
): Promise<{ readonly witness: ChainSourceEvidence & { status: "absent" }; readonly operator: ChainSourceEvidence & { status: "absent" } }> {
  const transaction = parseExactTransaction(loser.payment);
  let outputAmount: string;
  let outputScript: string;
  try {
    const output = transaction.outputs[0];
    if (!output) throw new Error("losing contention transaction has no successor");
    outputAmount = BigInt(output.value).toString();
    outputScript = initialized.config.additiveHead.scriptPublicKey;
  } finally {
    transaction.free();
  }
  const request: ChainEvidenceRequest = Object.freeze({
    operationId: `contention-loser:${loser.transactionId}`,
    operation: "settlement",
    network: LIVE_NETWORK,
    transactionId: loser.transactionId,
    expectedOutputs: Object.freeze([{
      index: 0,
      amountAtomic: outputAmount,
      scriptPublicKey: outputScript,
      address: initialized.config.additiveHead.address,
    }]),
    expectedInputs: Object.freeze([
      { transactionId: loser.headOutpoint.txid, index: loser.headOutpoint.index },
      { transactionId: loser.outpoint.txid, index: loser.outpoint.index },
    ]),
    watchedAddresses: Object.freeze([initialized.config.additiveHead.address, loser.address]),
    mechanism: "kip10-script-template",
    protocolFinality: "accepted",
    operatorFloor: "accepted",
    signal: AbortSignal.timeout(30_000),
  });
  const witness = await new HttpsAcceptedChainWitness({
    baseUrl: "https://api-tn10.kaspa.org/",
    depthConfirmationDaa: 10,
    fetch: globalThis.fetch,
  }).observe(request);
  const operator = await new WrpcOperatorChainObserver({
    rpc: initialized.observerWallet,
    depthConfirmationDaa: 10,
  }).observe(request, witness);
  if (witness.status !== "absent" || operator.status !== "absent") {
    throw new Error("losing contention candidate is not independently proven absent");
  }
  const unspent = await observeCurrentAddressOutpoint({
    wallet: initialized.observerWallet,
    address: loser.address,
    outpoint: `${loser.outpoint.txid}:${loser.outpoint.index}`,
    amountAtomic: STAGING_AMOUNT_ATOMIC,
  });
  if (unspent.outpoint !== `${loser.outpoint.txid}:${loser.outpoint.index}`) {
    throw new Error("losing contention staging output changed during reconciliation");
  }
  return Object.freeze({
    witness: witness as ChainSourceEvidence & { status: "absent" },
    operator: operator as ChainSourceEvidence & { status: "absent" },
  });
}

function assertSameAdvertisedHead(
  first: string,
  second: string,
  head: ExactHeadRecord
): void {
  for (const header of [first, second]) {
    const paymentRequired = decodePaymentRequiredHeader(header);
    const accepted = paymentRequired.accepts[0];
    const extra = accepted?.extra as Record<string, any> | undefined;
    if (
      accepted?.scheme !== "exact" ||
      extra?.profile !== "additive" ||
      extra?.headId !== head.headId ||
      extra?.headVersion !== head.version ||
      extra?.expectedHeadOutpoint?.txid !== head.currentOutpoint.txid ||
      extra?.expectedHeadOutpoint?.index !== head.currentOutpoint.index ||
      extra?.headAmount !== head.currentAmount
    ) throw new Error("contention offers did not advertise one identical head snapshot");
  }
}

function assertCorrectiveHead(paymentRequired: PaymentRequired, head: ExactHeadRecord): void {
  const accepted = paymentRequired.accepts[0];
  const extra = accepted?.extra as Record<string, any> | undefined;
  if (
    accepted?.scheme !== "exact" ||
    extra?.profile !== "additive" ||
    extra?.headId !== head.headId ||
    extra?.headVersion !== head.version ||
    extra?.expectedHeadOutpoint?.txid !== head.currentOutpoint.txid ||
    extra?.expectedHeadOutpoint?.index !== head.currentOutpoint.index ||
    extra?.headAmount !== head.currentAmount
  ) throw new Error("corrective offer did not advertise the accepted successor head");
}

function candidateReport(candidate: PreparedCandidate): ContentionCandidateReport {
  return Object.freeze({
    label: candidate.label,
    purchaseId: candidate.purchaseId,
    paymentIdentifier: candidate.paymentIdentifier,
    requestHash: candidate.requestHash,
    stagingOutpoint: `${candidate.outpoint.txid}:${candidate.outpoint.index}`,
    transactionId: candidate.transactionId,
    transactionFeeAtomic: candidate.transactionFeeAtomic,
    transactionMass: candidate.transactionMass,
    headOutpoint: `${candidate.headOutpoint.txid}:${candidate.headOutpoint.index}`,
    headVersion: candidate.headVersion,
    headAmountAtomic: candidate.headAmountAtomic,
  });
}

function contentionPurchaseId(initialized: InitializedLiveProof, label: CandidateLabel): PurchaseId {
  const entropy = createHash("sha256")
    .update(`sompi-live-additive-contention:${initialized.config.runId}:${label}`)
    .digest()
    .subarray(0, 16);
  return createPurchaseId(entropy);
}

function parseExactTransaction(payment: CreatePaymentResult): Transaction {
  const payload = payment.paymentPayload.payload as Record<string, unknown>;
  if (payload.type !== "exact-transaction" || typeof payload.transaction !== "string") {
    throw new Error("contention payment omitted its exact transaction");
  }
  return Transaction.deserializeFromSafeJSON(payload.transaction);
}

function requiredHeader(response: ServerResponse, name: string): string {
  const value = Object.entries(response.headers).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} header is missing`);
  return value;
}

function parseOutpoint(value: string): { readonly txid: string; readonly index: number } {
  const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(value);
  if (!match) throw new Error("contention outpoint is invalid");
  return Object.freeze({ txid: match[1]!, index: requiredIndex(match[2], "contention outpoint index") });
}

function requiredHash(value: unknown, label: string): string {
  const normalized = String(value ?? "").toLowerCase();
  if (!HASH32.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requiredIndex(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 0xffff_ffff) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requiredAtomic(value: unknown, label: string): string {
  const normalized = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function assertProofPaths(options: RunLiveAdditiveContentionOptions): void {
  const root = path.resolve(options.directory);
  const source = path.resolve(options.sourceWalletDirectory);
  const report = path.resolve(options.reportFilename);
  if (
    overlaps(root, source) ||
    overlaps(report, root) ||
    overlaps(report, source)
  ) throw new Error("contention proof state, source wallet, and report paths must be disjoint");
  secureDirectory(path.dirname(report));
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function writeReport(filename: string, report: LiveAdditiveContentionReport): void {
  const resolved = path.resolve(filename);
  if (fs.existsSync(resolved)) {
    const current = JSON.parse(fs.readFileSync(resolved, "utf8")) as LiveAdditiveContentionReport;
    assertLiveAdditiveContentionReport(current);
    if (liveAdditiveContentionReportDigest(current) !== liveAdditiveContentionReportDigest(report)) {
      throw new Error("contention report path belongs to another immutable run");
    }
    return;
  }
  writeAtomicJson(resolved, report);
  fs.chmodSync(resolved, REPORT_MODE);
}

function assertContentionKeyMaterialExcluded(
  report: LiveAdditiveContentionReport,
  directory: string
): void {
  const encoded = JSON.stringify(report);
  for (const entry of fs.readdirSync(directory)) {
    if (!/^stg_v1_[A-Za-z0-9_-]{43}$/.test(entry)) continue;
    const filename = path.join(directory, entry);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4096) {
      throw new Error("contention staging key file is invalid");
    }
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
    const secret = String(value.privateKey ?? "");
    if (!/^[a-f0-9]{64}$/.test(secret) || encoded.includes(secret)) {
      throw new Error("contention report includes or cannot validate staging key material");
    }
  }
}
