#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalEvidence = path.join(root, "evidence", "live-testnet10");
const currentEvidence = path.join(root, "evidence", "generic-x402-cutover");
const walletTransferEvidence = path.join(root, "evidence", "wallet-transfer");
const phase4Evidence = path.join(root, "evidence", "phase4-c7");
const phase5Evidence = path.join(root, "evidence", "phase5-c5");
const phase4Expected = Object.freeze({
  "standard-native.json": "1bcce8f51cca40e52afb335fe3679b0fe2e0254ad83a29c9c5adb981c23ce4fb",
  "restart-proof.json": "554c52aca3400355e8d4b3604e9dcb54845ef5e74e9777b0fc044cab0cfba3d2",
  "verification.json": "168093a9edaf25d94ad57c1fb15d005f87f01893ed2c0b59d07d118c363881ba",
});
const phase5Expected = Object.freeze({
  "standard-native.json": "f9ac0bc9413ed94b09c29c23de724378e19df5a81181859693154544261a40b0",
  "restart-proof.json": "8ac215de641aa69085765a3588f48fc69e65121069e41d335d1d55bab45611d6",
  "verification.json": "89018859b541887d0644e07c64927b7bbafcdb07b6ae0724439fc50e9a46c6cf",
});
const historicalExpected = Object.freeze({
  "standard-native.json": Object.freeze({
    digest: "b17898cc726f46e8ee35bbad07c800e19117536350996f7600b0006bb688e1a8",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2",
  }),
  "additive.json": Object.freeze({
    digest: "4dd59afa4b64c62d52bf6674783ccd6f2ba9e5a5e521fc78357f1a2efd2202f2",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2",
  }),
  "batch.json": Object.freeze({
    digest: "8736ece032a8c2e517169319edf91c30a50f87de97f89ce47b22868be0fbb7f1",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-batch:1",
  }),
  "additive-contention.json": Object.freeze({
    digest: "5198dadb90fde6249831418d6ac475ce36cb959c0d468f289415f9d8a3a8e42e",
    profile: "urn:sompi:e2e:live-testnet10-additive-contention:1",
  }),
  "human-present-standard-native.json": Object.freeze({
    digest: "d550766dbe1a161566b310500192a81adfe0213bc3e6f561c652600fcf3558bd",
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2",
  }),
});

for (const [filename, contract] of Object.entries(historicalExpected)) {
  const bytes = fs.readFileSync(path.join(historicalEvidence, filename));
  const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const encoded = JSON.stringify(report);
  const digest = createHash("sha256").update(encoded).digest("hex");
  if (
    digest !== contract.digest ||
    report.profile !== contract.profile ||
    report.network !== "kaspa:testnet-10" ||
    /(?:0\.1\.0-alpha\.6|kaspa-exact-v1|borrowInventory|privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) {
    throw new Error(`historical live Testnet-10 evidence ${filename} is invalid`);
  }
}

const historicalStandard = readHistorical("standard-native.json");
if (
  historicalStandard.exactProfile !== "standard-native" ||
  historicalStandard.purchaseIngress !== "http-api" ||
  historicalStandard.economics?.merchantGainAtomic !== historicalStandard.economics?.advertisedAmountAtomic ||
  historicalStandard.economics?.transactionVersion !== 0
) throw new Error("standard-native live evidence invariants changed");

const historicalAdditive = readHistorical("additive.json");
if (
  historicalAdditive.exactProfile !== "additive" ||
  historicalAdditive.purchaseIngress !== "mcp-api-compatibility" ||
  historicalAdditive.economics?.merchantGainAtomic !== historicalAdditive.economics?.advertisedAmountAtomic ||
  historicalAdditive.economics?.transactionVersion !== 1 ||
  historicalAdditive.economics?.outputCount !== 1
) throw new Error("additive live evidence invariants changed");

const historicalBatch = readHistorical("batch.json");
if (
  historicalBatch.claimChannel?.purchases?.length !== 2 ||
  historicalBatch.claimChannel?.chargedCumulativeAtomic !== "12000000" ||
  historicalBatch.claimChannel?.continuation?.amountAtomic !== "28000000" ||
  historicalBatch.refundChannel?.refundOutput?.amountAtomic !== "38000000" ||
  BigInt(historicalBatch.refundChannel?.observedAfterBoundaryDaa ?? 0) <=
    BigInt(historicalBatch.refundChannel?.refundTimeoutDaa ?? 0)
) throw new Error("batch live evidence invariants changed");

const contention = readHistorical("additive-contention.json");
if (
  contention.assertions?.oneWinner !== true ||
  contention.assertions?.loserPaidNothing !== true ||
  contention.assertions?.trustedAbsenceBeforeRetry !== true ||
  contention.assertions?.noAutomaticCorrectiveResigning !== true ||
  contention.explicitRetry?.separatelyAuthorized !== true ||
  contention.winner?.transactionId === contention.explicitRetry?.transactionId
) throw new Error("additive contention live evidence invariants changed");

const humanPresent = readHistorical("human-present-standard-native.json");
if (
  humanPresent.exactProfile !== "standard-native" ||
  humanPresent.purchaseIngress !== "http-api" ||
  humanPresent.purchase?.state !== "receipted" ||
  humanPresent.ap2HumanPresentConformanceClaimed !== true ||
  humanPresent.authorityMode !== "separate-process-human-present" ||
  humanPresent.authorityIsolationAppliedToThisRun !== true ||
  humanPresent.separateAuthorityIsolationProofAvailable !== true ||
  humanPresent.economics?.merchantGainAtomic !== humanPresent.economics?.advertisedAmountAtomic ||
  humanPresent.economics?.transactionVersion !== 0
) throw new Error("human-present standard-native live evidence invariants changed");

const currentExpected = Object.freeze({
  "standard-native.json": Object.freeze({
    digest: "219511a816da502555b52d02189c243ef48329637ac29178a308a364a0afa377",
    profile: "urn:sompi:evidence:generic-x402-cutover:1",
  }),
  "additive.json": Object.freeze({
    digest: "54409a9bb062ddbc234bf6efe38a3afbbb883f47c8c88bb97a070f4c9f33b3e3",
    profile: "urn:sompi:evidence:generic-x402-cutover:1",
  }),
  "batch.json": Object.freeze({
    digest: "238a21c0543278835145a782637a56834d4b1d82ff6097d4da2703244943ad68",
    profile: "urn:sompi:evidence:generic-x402-cutover:1",
  }),
  "terah-standard-native-recovery.json": Object.freeze({
    digest: "fdecaed6effa12495f2e8ec5efba1ae7423b959a56b7d4cac70b294e7991ec5b",
    profile: "urn:sompi:evidence:terah-alpha8-canary:1",
  }),
});
for (const [filename, contract] of Object.entries(currentExpected)) {
  const report = readCurrent(filename);
  const encoded = JSON.stringify(report);
  if (
    createHash("sha256").update(encoded).digest("hex") !== contract.digest ||
    report.profile !== contract.profile ||
    report.network !== "kaspa:testnet-10" ||
    report.merchantProfile !== "generic-x402" ||
    report.privateMaterialIncluded !== false ||
    /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl)/i.test(encoded)
  ) throw new Error(`generic x402 cutover evidence ${filename} is invalid`);
}
const currentStandard = readCurrent("standard-native.json");
const currentAdditive = readCurrent("additive.json");
const currentBatch = readCurrent("batch.json");
const terahRecovery = readCurrent("terah-standard-native-recovery.json");
if (
  currentStandard.exactProfile !== "standard-native" ||
  currentStandard.purchaseIngress !== "http-api" ||
  currentStandard.purchaseState !== "receipted" ||
  currentStandard.merchantGainAtomic !== currentStandard.advertisedAmountAtomic ||
  currentStandard.transactionVersion !== 0 ||
  currentAdditive.exactProfile !== "additive" ||
  currentAdditive.purchaseIngress !== "mcp-api-compatibility" ||
  currentAdditive.purchaseState !== "receipted" ||
  currentAdditive.merchantGainAtomic !== currentAdditive.advertisedAmountAtomic ||
  currentAdditive.transactionVersion !== 1 ||
  currentBatch.paymentScheme !== "batch-settlement" ||
  currentBatch.authorizedCharges !== 2 ||
  currentBatch.strictBoundarySatisfied !== true ||
  BigInt(currentBatch.observedAfterBoundaryDaa ?? 0) <= BigInt(currentBatch.refundTimeoutDaa ?? 0) ||
  terahRecovery.profile !== "urn:sompi:evidence:terah-alpha8-canary:1" ||
  terahRecovery.exactProfile !== "standard-native" ||
  terahRecovery.purchaseIngress !== "hermes-telegram-skill" ||
  terahRecovery.authorityMode !== "separate-process-human-present-telegram" ||
  terahRecovery.purchaseState !== "receipted" ||
  terahRecovery.initialSubmissionOutcome !== "ambiguous" ||
  terahRecovery.recoveryOutcome !== "exact-payment-won" ||
  terahRecovery.checkoutExpiredBeforeRecovery !== true ||
  terahRecovery.sameSignedPaymentReplayed !== true ||
  terahRecovery.paymentTransactionCount !== 1 ||
  terahRecovery.stagingRecoveryBroadcast !== false ||
  terahRecovery.fulfilmentRecovered !== true ||
  terahRecovery.receiptRecorded !== true
) throw new Error("generic x402 cutover evidence invariants changed");

const walletTransfer = JSON.parse(
  fs.readFileSync(path.join(walletTransferEvidence, "terah-wallet-transfer.json"), "utf8")
);
const walletTransferEncoded = JSON.stringify(walletTransfer);
if (
  createHash("sha256").update(walletTransferEncoded).digest("hex") !==
    "61a11260e4bfc6177f85af7665e7ffbade1d68ad5f8f22dd3abf272c2d49bc54" ||
  walletTransfer.profile !== "urn:sompi:evidence:terah-wallet-transfer:1" ||
  walletTransfer.network !== "kaspa:testnet-10" ||
  walletTransfer.packageVersion !== "0.9.0" ||
  walletTransfer.journalEpoch !== 16 ||
  walletTransfer.cleanCutover?.oldRuntimeReused !== false ||
  walletTransfer.runtime?.authorityMode !== "separate-process-human-present-telegram" ||
  walletTransfer.runtime?.privateMaterialIncluded !== false ||
  walletTransfer.wallet?.chainStatus !== "observed" ||
  walletTransfer.wallet?.unboundAtomic !== "0" ||
  walletTransfer.wallet?.reservedAtomic !== "0" ||
  walletTransfer.wallet?.availableAtomic !== walletTransfer.wallet?.observedAtomic ||
  walletTransfer.directTransfer?.state !== "receipted" ||
  walletTransfer.directTransfer?.amountAtomic !== walletTransfer.directTransfer?.destinationOutputAtomic ||
  walletTransfer.directTransfer?.paymentTransactionCount !== 1 ||
  walletTransfer.directTransfer?.receiptRecorded !== true ||
  walletTransfer.agentTransfer?.ingress !== "hermes-skill-natural-language" ||
  walletTransfer.agentTransfer?.state !== "receipted" ||
  walletTransfer.agentTransfer?.amountAtomic !== walletTransfer.agentTransfer?.destinationOutputAtomic ||
  walletTransfer.agentTransfer?.paymentTransactionCount !== 1 ||
  walletTransfer.agentTransfer?.receiptRecorded !== true ||
  walletTransfer.x402Regression?.binding !== "kaspa-exact-v2" ||
  walletTransfer.x402Regression?.exactProfile !== "standard-native" ||
  walletTransfer.x402Regression?.state !== "receipted" ||
  walletTransfer.x402Regression?.amountAtomic !== walletTransfer.x402Regression?.merchantOutputAtomic ||
  walletTransfer.x402Regression?.paymentTransactionCount !== 1 ||
  walletTransfer.x402Regression?.receiptRecorded !== true ||
  walletTransfer.failClosedProbe?.state !== "failed_terminal" ||
  walletTransfer.failClosedProbe?.transactionBroadcast !== false ||
  walletTransfer.node?.networkId !== "testnet-10" ||
  walletTransfer.node?.isSynced !== true ||
  walletTransfer.node?.hasUtxoIndex !== true ||
  /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl|telegramBotToken|apiCredential)/i.test(
    walletTransferEncoded
  )
) throw new Error("wallet and Transfer live evidence invariants changed");

const transferLimitFix = JSON.parse(
  fs.readFileSync(path.join(walletTransferEvidence, "terah-transfer-limit-0.9.1.json"), "utf8")
);
const transferLimitFixEncoded = JSON.stringify(transferLimitFix);
if (
  createHash("sha256").update(transferLimitFixEncoded).digest("hex") !==
    "fce30b67d8539d9f628f4f1761c63a4b93c74b6bc79905deadbbc9f4d58eaff4" ||
  transferLimitFix.profile !== "urn:sompi:evidence:terah-transfer-limit-fix:1" ||
  transferLimitFix.network !== "kaspa:testnet-10" ||
  transferLimitFix.packageVersion !== "0.9.1" ||
  transferLimitFix.journalEpoch !== 16 ||
  transferLimitFix.deployment?.stateReinitialized !== false ||
  transferLimitFix.deployment?.walletIdentityPreserved !== true ||
  transferLimitFix.deployment?.journalPreserved !== true ||
  transferLimitFix.deployment?.privateMaterialIncluded !== false ||
  transferLimitFix.regression?.maxPerTransferAtomic !== transferLimitFix.transfer?.amountAtomic ||
  transferLimitFix.regression?.oldTransferState !== "failed_terminal" ||
  transferLimitFix.regression?.oldTransferTransactionBroadcast !== false ||
  transferLimitFix.regression?.oldTransferRetried !== false ||
  transferLimitFix.transfer?.state !== "receipted" ||
  transferLimitFix.transfer?.authorizationDecision !== "approved" ||
  transferLimitFix.transfer?.amountAtomic !== transferLimitFix.transfer?.destinationOutputAtomic ||
  BigInt(transferLimitFix.transfer?.feeAtomic ?? -1) >
    BigInt(transferLimitFix.regression?.feeCeilingAtomic ?? -1) ||
  transferLimitFix.transfer?.paymentTransactionCount !== 1 ||
  transferLimitFix.transfer?.receiptRecorded !== true ||
  transferLimitFix.transfer?.recoveryRequired !== false ||
  transferLimitFix.acceptedChainEvidence?.recipientOutputAddress !== transferLimitFix.transfer?.destination ||
  transferLimitFix.acceptedChainEvidence?.recipientOutputAtomic !== transferLimitFix.transfer?.amountAtomic ||
  transferLimitFix.acceptedChainEvidence?.continuationOutputAtomic !==
    transferLimitFix.walletAfter?.observedAtomic ||
  transferLimitFix.walletAfter?.vaultOutpoint?.transactionId !== transferLimitFix.transfer?.transactionId ||
  transferLimitFix.walletAfter?.vaultOutpoint?.index !== transferLimitFix.transfer?.continuationOutputIndex ||
  transferLimitFix.walletAfter?.unboundAtomic !== "0" ||
  transferLimitFix.walletAfter?.reservedAtomic !== "0" ||
  transferLimitFix.walletAfter?.availableAtomic !== transferLimitFix.walletAfter?.observedAtomic ||
  /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl|telegramBotToken|apiCredential)/i.test(
    transferLimitFixEncoded
  )
) throw new Error("0.9.1 transfer-limit evidence invariants changed");

const automaticFunding = JSON.parse(
  fs.readFileSync(path.join(walletTransferEvidence, "terah-automatic-funding-0.10.0.json"), "utf8")
);
const automaticFundingEncoded = JSON.stringify(automaticFunding);
if (
  createHash("sha256").update(automaticFundingEncoded).digest("hex") !==
    "b7375d81bb7f97506b4a6fc7fdafe10b3e6e6edd6d6f711fec354d6dc65ef02e" ||
  automaticFunding.profile !== "urn:sompi:evidence:terah-automatic-funding:1" ||
  automaticFunding.network !== "kaspa:testnet-10" ||
  automaticFunding.packageVersion !== "0.10.0" ||
  automaticFunding.journalEpoch !== 16 ||
  automaticFunding.deployment?.registryArtifactByteIdentical !== true ||
  automaticFunding.deployment?.stateReinitialized !== false ||
  automaticFunding.deployment?.walletIdentityPreserved !== true ||
  automaticFunding.deployment?.journalPreserved !== true ||
  automaticFunding.deployment?.privateMaterialIncluded !== false ||
  automaticFunding.receive?.stableAcrossDeployment !== true ||
  automaticFunding.automaticSecuring?.automatic !== true ||
  automaticFunding.automaticSecuring?.authorityDecisionRequired !== false ||
  automaticFunding.automaticSecuring?.operationKind !== "vault_deposit" ||
  automaticFunding.automaticSecuring?.state !== "completed" ||
  automaticFunding.automaticSecuring?.paymentTransactionCount !== 1 ||
  automaticFunding.automaticSecuring?.finality !== "accepted" ||
  BigInt(automaticFunding.walletBefore?.incomingAtomic ?? -1) -
      BigInt(automaticFunding.automaticSecuring?.feeAtomic ?? -1) !==
    BigInt(automaticFunding.automaticSecuring?.amountAtomic ?? -1) ||
  BigInt(automaticFunding.walletBefore?.protectedAtomic ?? -1) +
      BigInt(automaticFunding.automaticSecuring?.amountAtomic ?? -1) !==
    BigInt(automaticFunding.walletAfter?.protectedAtomic ?? -1) ||
  automaticFunding.walletAfter?.availableAtomic !== automaticFunding.walletAfter?.protectedAtomic ||
  automaticFunding.walletAfter?.totalAtomic !== automaticFunding.walletAfter?.protectedAtomic ||
  automaticFunding.walletAfter?.incomingAtomic !== "0" ||
  automaticFunding.walletAfter?.pendingAtomic !== "0" ||
  automaticFunding.walletAfter?.securingState !== "idle" ||
  automaticFunding.walletAfter?.vaultOutpoint?.transactionId !==
    automaticFunding.automaticSecuring?.transactionId ||
  automaticFunding.walletAfter?.vaultOutpoint?.index !==
    automaticFunding.automaticSecuring?.continuationOutputIndex ||
  automaticFunding.assertions?.oneReceiveAddress !== true ||
  automaticFunding.assertions?.incomingPrincipalConserved !== true ||
  automaticFunding.assertions?.outwardApprovalBoundaryUnchanged !== true ||
  automaticFunding.assertions?.noAutomaticTransferOrPurchase !== true ||
  automaticFunding.assertions?.noDuplicateSubmission !== true ||
  /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl|telegramBotToken|apiCredential)/i.test(
    automaticFundingEncoded
  )
) throw new Error("0.10.0 automatic-funding evidence invariants changed");

verifyFundedRestartEvidence({
  label: "Phase 4 C7",
  directory: phase4Evidence,
  expected: phase4Expected,
  restartProfile: "urn:sompi:evidence:phase4-c7-restart-proof:1",
  verificationProfile: "urn:sompi:evidence:phase4-c7:2",
  stagingTransitions: [
    "planned",
    "executing",
    "submitted",
    "ambiguous",
    "ambiguous",
    "ambiguous",
    "observed",
  ],
  verificationAssertions: [],
});

verifyFundedRestartEvidence({
  label: "Phase 5 C5",
  directory: phase5Evidence,
  expected: phase5Expected,
  restartProfile: "urn:sompi:evidence:phase5-c5-restart-proof:1",
  verificationProfile: "urn:sompi:evidence:phase5-c5:1",
  phaseBase: "a258727aca0e735fe5ca97253c20abe9eb6a742f",
  stagingTransitions: [
    "planned",
    "executing",
    "submitted",
    "ambiguous",
    "ambiguous",
    "ambiguous",
    "ambiguous",
    "observed",
  ],
  verificationAssertions: [
    "samePurchaseAcrossRestart",
    "sameStagingEffectAcrossRestart",
    "sameStagingTransactionAcrossRestart",
    "onePaymentEffect",
    "oneMerchantExactTransaction",
  ],
});

process.stdout.write(
  "Generic x402, wallet/Transfer, historical TN10, Phase 4 C7, and Phase 5 C5 evidence passed.\n"
);

function verifyFundedRestartEvidence(configuration) {
  const artifacts = readDigestBoundArtifacts(
    configuration.label,
    configuration.directory,
    configuration.expected,
  );
  const report = artifacts["standard-native.json"];
  const restart = artifacts["restart-proof.json"];
  const verification = artifacts["verification.json"];
  const before = restart.beforeRestart;
  const after = restart.afterRestart;
  const directMovements = after?.directMovements;
  const beforeStaging = before?.effects?.[0];
  const afterStaging = after?.effects?.find(
    (effect) => effect.id === beforeStaging?.id,
  );
  const afterPayment = after?.effects?.find(
    (effect) => effect.kind === "kaspa-x402-payment",
  );
  const beforeAttempt = before?.paymentAttempts?.[0];
  const afterAttempt = after?.paymentAttempts?.[0];
  const firstStartedAt = Date.parse(
    restart.processBoundary?.firstInvocation?.durableActivityStartedAt ?? "",
  );
  const firstStoppedAt = Date.parse(
    restart.processBoundary?.firstInvocation?.durableStopRecordedAt ?? "",
  );
  const secondStartedAt = Date.parse(
    restart.processBoundary?.secondInvocation?.firstDurableRecoveryAt ?? "",
  );
  const secondCompletedAt = Date.parse(
    restart.processBoundary?.secondInvocation?.completedAt ?? "",
  );
  const assertionNames = Object.keys(verification.assertions ?? {}).sort();
  const expectedAssertionNames =
    [...configuration.verificationAssertions].sort();
  const encoded = JSON.stringify({ report, restart, verification });

  if (
    report.profile !== "urn:sompi:e2e:live-testnet10-generic-x402-exact:3" ||
    report.network !== "kaspa:testnet-10" ||
    report.exactProfile !== "standard-native" ||
    report.purchaseIngress !== "http-api" ||
    report.purchase?.state !== "receipted" ||
    report.liveKaspaTestnet10ExecutionProved !== true ||
    report.evidenceHandling?.publicFactsOnly !== true ||
    report.idempotency?.duplicatePurchaseReturnedSameId !== true ||
    report.idempotency?.duplicateMerchantPaidRequestReturnedSameTransaction !== true ||
    report.idempotency?.uniqueMerchantExactTransactions !== 1 ||
    restart.profile !== configuration.restartProfile ||
    restart.network !== report.network ||
    restart.exactProfile !== report.exactProfile ||
    verification.profile !== configuration.verificationProfile ||
    verification.network !== report.network ||
    verification.purchaseId !== report.purchase?.id ||
    verification.purchaseState !== report.purchase?.state ||
    (configuration.phaseBase === undefined
      ? Object.hasOwn(verification, "phaseBase")
      : verification.phaseBase !== configuration.phaseBase) ||
    verification.artifacts?.standardReport?.filename !==
      "standard-native.json" ||
    verification.artifacts?.standardReport?.sha256 !==
      configuration.expected["standard-native.json"] ||
    verification.artifacts?.restartProof?.filename !==
      "restart-proof.json" ||
    verification.artifacts?.restartProof?.sha256 !==
      configuration.expected["restart-proof.json"] ||
    JSON.stringify(assertionNames) !==
      JSON.stringify(expectedAssertionNames) ||
    assertionNames.some(
      (name) => verification.assertions[name] !== true,
    ) ||
    restart.processBoundary?.firstInvocation?.sequence !== 1 ||
    restart.processBoundary?.firstInvocation?.stopTrigger !==
      "purchase-failed-recoverable" ||
    restart.processBoundary?.firstInvocation?.exitSignal !== "SIGTERM" ||
    restart.processBoundary?.secondInvocation?.sequence !== 2 ||
    restart.processBoundary?.secondInvocation?.exitCode !== 0 ||
    restart.processBoundary?.reconstruction !==
      "durable-journal-transition-prefix" ||
    !Number.isFinite(firstStartedAt) ||
    !Number.isFinite(firstStoppedAt) ||
    !Number.isFinite(secondStartedAt) ||
    !Number.isFinite(secondCompletedAt) ||
    !(firstStartedAt <= firstStoppedAt &&
      firstStoppedAt < secondStartedAt &&
      secondStartedAt <= secondCompletedAt) ||
    before?.stage !== "before_restart" ||
    before?.captureMethod !== "durable-journal-transition-prefix" ||
    before?.purchase?.id !== report.purchase?.id ||
    before?.purchase?.state !== "failed_recoverable" ||
    after?.stage !== "after_restart" ||
    after?.purchase?.id !== before?.purchase?.id ||
    after?.purchase?.state !== report.purchase?.state ||
    !Array.isArray(directMovements) ||
    directMovements.length !== 3 ||
    JSON.stringify(directMovements.map((movement) => movement.kind)) !==
      JSON.stringify(["wallet_send", "wallet_send", "vault_deposit"]) ||
    directMovements.some(
      (movement) =>
        movement.state !== "completed" ||
        !/^[a-f0-9]{64}$/.test(movement.transactionId),
    ) ||
    JSON.stringify(before?.directMovements) !==
      JSON.stringify(directMovements) ||
    new Set(directMovements.map((movement) => movement.transactionId))
      .size !== 3 ||
    directMovements[0].transactionId !==
      report.bootstrapFunding?.transactionId ||
    directMovements[1].transactionId !==
      report.additiveHead?.created?.transactionId ||
    directMovements[2].transactionId !==
      report.vaultDeposit?.transactionId ||
    before?.effects?.length !== 1 ||
    beforeStaging?.kind !== "treasury-staging" ||
    beforeStaging?.state !== "submitted" ||
    beforeStaging?.transactionId !==
      report.transactions?.stagingTransactionId ||
    JSON.stringify(beforeStaging?.transitions) !==
      JSON.stringify(["planned", "executing", "submitted"]) ||
    restart.recoveredEffectIds?.length !== 1 ||
    restart.recoveredEffectIds[0] !== beforeStaging?.id ||
    after?.effects?.length !== 2 ||
    afterStaging?.state !== "observed" ||
    afterStaging?.transactionId !== beforeStaging?.transactionId ||
    JSON.stringify(afterStaging?.transitions) !==
      JSON.stringify(configuration.stagingTransitions) ||
    afterPayment?.state !== "observed" ||
    afterPayment?.transactionId !==
      report.transactions?.exactTransactionId ||
    JSON.stringify(afterPayment?.transitions) !==
      JSON.stringify(["planned", "executing", "ambiguous", "observed"]) ||
    before?.paymentAttempts?.length !== 1 ||
    beforeAttempt?.purchaseId !== report.purchase?.id ||
    beforeAttempt?.attempt !== 1 ||
    beforeAttempt?.state !== "planned" ||
    after?.paymentAttempts?.length !== 1 ||
    afterAttempt?.purchaseId !== beforeAttempt?.purchaseId ||
    afterAttempt?.attempt !== beforeAttempt?.attempt ||
    afterAttempt?.identifier !== beforeAttempt?.identifier ||
    afterAttempt?.state !== "observed" ||
    before?.settlements?.length !== 0 ||
    before?.merchantExactTransactionIds?.length !== 0 ||
    after?.settlements?.length !== 1 ||
    after.settlements[0]?.purchaseId !== report.purchase?.id ||
    after.settlements[0]?.attempt !== 1 ||
    after.settlements[0]?.transactionId !==
      report.transactions?.exactTransactionId ||
    after?.merchantExactTransactionIds?.length !== 1 ||
    after.merchantExactTransactionIds[0] !==
      report.transactions?.exactTransactionId ||
    verification.privateMaterialIncluded !== false ||
    /(?:privateKey|wallet-key|owner\.key|ipc-mac\.key|sourceWalletDirectory|nodeUrl|telegramBotToken|apiCredential)/i.test(
      encoded,
    )
  ) {
    throw new Error(
      `${configuration.label} funded evidence invariants changed`,
    );
  }
}

function readDigestBoundArtifacts(label, directory, expected) {
  return Object.fromEntries(
    Object.entries(expected).map(([filename, digest]) => {
      const bytes = fs.readFileSync(path.join(directory, filename));
      if (createHash("sha256").update(bytes).digest("hex") !== digest) {
        throw new Error(`${label} evidence ${filename} digest changed`);
      }
      return [
        filename,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ];
    }),
  );
}

function readHistorical(filename) {
  return JSON.parse(fs.readFileSync(path.join(historicalEvidence, filename), "utf8"));
}

function readCurrent(filename) {
  return JSON.parse(fs.readFileSync(path.join(currentEvidence, filename), "utf8"));
}
