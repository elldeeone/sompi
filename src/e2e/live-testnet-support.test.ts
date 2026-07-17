import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExactTransactionVerificationRequest } from "@kaspa-x402/server";

import {
  LIVE_ADDITIVE_THRESHOLD_ATOMIC,
  LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
  LIVE_NETWORK,
  LiveMerchantExactVerifier,
  assertLiveNodeReady,
  assertPrivateFile,
  bootstrapLiveProof,
  driveLiveTreasuryOperation,
  initializeLiveProof,
  liveBootstrapNeedsCapacity,
  readProgress,
  readPrivateJsonState,
  reconcileLiveChainMilestoneInclusion,
  sha256Hex,
  verifyLiveChainMilestoneInclusion,
  writeAtomicJson,
  type LiveChainMilestone,
  type LiveRecoveryRecord,
} from "./live-testnet-support.js";
import {
  assertLiveTestnetProofPaths,
  createLiveMerchant,
  LiveMerchantPaidEndpoint,
  preflightLiveTestnetProofReportTarget,
  writeLiveTestnetProofReport,
  type LiveTestnetProofReport,
} from "./live-testnet-proof.js";
import {
  ExactTransactionBuilder,
  KaspaTestnet10AddressCodec,
  SOMPI_EXACT_FEE_POLICY,
  StagingKeyStore,
} from "../adapters/kaspa-x402/index.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "../protocols/profiles.js";
import { assertPurchaseId, createPaymentIdentifier } from "../purchase/identity.js";
import { SqliteMerchantServerStateStore } from "../demo/merchant-server-store.js";
import { SqliteDemoCommerceAuthorizationStore } from "../demo/commerce-authorization-store.js";
import type { KaspaWallet } from "../wallet.js";
import type {
  TreasuryOperationModule,
  TreasuryOperationRequest,
  TreasuryOperationView,
} from "../treasury/operations.js";

const TEST_NODE_URL = "ws://127.0.0.1:17210/";

test("live node readiness derives reportable health only from a fresh TN10 DAG check", async () => {
  const wallet = (network: string, synced = true, indexed = true) => ({
    serverInfo: async () => ({
      serverVersion: "rusty-kaspad test",
      virtualDaaScore: 123n,
      isSynced: synced,
      hasUtxoIndex: indexed,
    }),
    client: async () => ({
      getBlockDagInfo: async () => ({ network, sink: "11".repeat(32) }),
    }),
  }) as unknown as KaspaWallet;
  assert.deepEqual(await assertLiveNodeReady(wallet("testnet-10")), {
    serverVersion: "rusty-kaspad test",
    networkId: "testnet-10",
    virtualDaaScore: 123n,
    isSynced: true,
    hasUtxoIndex: true,
  });
  await assert.rejects(() => assertLiveNodeReady(wallet("mainnet")), /synced UTXO-indexed Testnet-10/);
  await assert.rejects(() => assertLiveNodeReady(wallet("testnet-10", false)), /synced UTXO-indexed Testnet-10/);
  await assert.rejects(() => assertLiveNodeReady(wallet("testnet-10", true, false)), /synced UTXO-indexed Testnet-10/);
});

test("live proof initialization is owner-only, fresh, and restart-stable before any spend", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-init-"));
  const source = path.join(root, "unopened-source-wallet");
  try {
    const first = initializeLiveProof(path.join(root, "proof"), source, TEST_NODE_URL);
    const firstConfig = JSON.stringify(first.config);
    assert.equal(first.vault.initialAddress(), first.config.vault.address);
    assert.equal(fs.statSync(first.layout.root).mode & 0o777, 0o700);
    for (const filename of [
      first.layout.configPath,
      first.layout.recoveryPath,
      path.join(first.config.wallets.treasuryDirectory, "wallet-key"),
      path.join(first.config.wallets.merchantDirectory, "wallet-key"),
      path.join(first.config.wallets.observerDirectory, "wallet-key"),
      first.config.vault.ownerKeyPath,
      first.config.additiveHead.ownerKeyPath,
    ]) {
      assertPrivateFile(filename);
    }
    assert.equal(
      new Set([
        first.config.wallets.treasuryAddress,
        first.config.wallets.merchantAddress,
        first.config.wallets.observerAddress,
      ]).size,
      3
    );
    const sensitiveBytes = [
      fs.readFileSync(path.join(first.config.wallets.treasuryDirectory, "wallet-key"), "utf8").trim(),
      fs.readFileSync(first.config.vault.ownerKeyPath, "utf8").trim(),
      fs.readFileSync(first.config.additiveHead.ownerKeyPath, "utf8").trim(),
    ];
    const recovery = fs.readFileSync(first.layout.recoveryPath, "utf8");
    for (const bytes of sensitiveBytes) assert.equal(recovery.includes(bytes), false);
    assert.equal(fs.existsSync(source), false, "initialization must not open the funding source");
    await Promise.all([
      first.treasuryWallet.disconnect(),
      first.merchantWallet.disconnect(),
      first.observerWallet.disconnect(),
    ]);

    const resumed = initializeLiveProof(path.join(root, "proof"), source, TEST_NODE_URL);
    assert.equal(JSON.stringify(resumed.config), firstConfig);
    await Promise.all([
      resumed.treasuryWallet.disconnect(),
      resumed.merchantWallet.disconnect(),
      resumed.observerWallet.disconnect(),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("surviving milestones without their exact Treasury journal fail before any RPC or spend", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-continuity-"));
  try {
    const initialized = initializeLiveProof(
      path.join(root, "proof"),
      path.join(root, "missing-source"),
      TEST_NODE_URL
    );
    const milestone = chainMilestone(
      "11".repeat(32),
      initialized.config.wallets.treasuryAddress,
      "500000000"
    );
    const recovery = readPrivateJsonState<LiveRecoveryRecord>(initialized.layout.recoveryPath);
    writeAtomicJson(initialized.layout.progressPath, {
      version: 1,
      runId: initialized.config.runId,
      updatedAt: new Date().toISOString(),
      bootstrap: milestone,
    });
    writeAtomicJson(initialized.layout.recoveryPath, {
      ...recovery,
      updatedAt: new Date().toISOString(),
      milestones: { bootstrap: milestone },
    });
    fs.unlinkSync(initialized.layout.bootstrapJournalPath);
    await assert.rejects(
      bootstrapLiveProof({ initialized }),
      /journal continuity is missing/
    );
    await closeInitialized(initialized);
    assert.equal(fs.existsSync(initialized.layout.bootstrapJournalPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a durable operation-start fence refuses a missing Treasury journal before RPC", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-start-fence-"));
  try {
    const initialized = initializeLiveProof(
      path.join(root, "proof"),
      path.join(root, "missing-source"),
      TEST_NODE_URL
    );
    const recovery = readPrivateJsonState<LiveRecoveryRecord>(initialized.layout.recoveryPath);
    writeAtomicJson(initialized.layout.recoveryPath, {
      ...recovery,
      updatedAt: new Date().toISOString(),
      startedOperations: ["bootstrap"],
    });
    fs.unlinkSync(initialized.layout.bootstrapJournalPath);
    await assert.rejects(
      bootstrapLiveProof({ initialized }),
      /journal continuity is missing/
    );
    await closeInitialized(initialized);
    assert.equal(fs.existsSync(initialized.layout.bootstrapJournalPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live state rejects symlink and hardlink substitution on restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-links-"));
  try {
    const firstRoot = path.join(root, "first");
    const first = initializeLiveProof(firstRoot, path.join(root, "source"), TEST_NODE_URL);
    await closeInitialized(first);
    const linked = path.join(root, "config-target");
    fs.copyFileSync(first.layout.configPath, linked);
    fs.chmodSync(linked, 0o600);
    fs.unlinkSync(first.layout.configPath);
    fs.symlinkSync(linked, first.layout.configPath);
    assert.throws(
      () => initializeLiveProof(firstRoot, path.join(root, "source"), TEST_NODE_URL),
      /symbolic link|regular file|real directory/
    );

    const second = initializeLiveProof(
      path.join(root, "second"),
      path.join(root, "source-two"),
      TEST_NODE_URL
    );
    await closeInitialized(second);
    fs.linkSync(second.layout.recoveryPath, path.join(root, "recovery-hardlink"));
    assert.throws(
      () => initializeLiveProof(
        path.join(root, "second"),
        path.join(root, "source-two"),
        TEST_NODE_URL
      ),
      /exactly one filesystem link/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("surviving proof identity refuses missing config, recovery, or either precreated journal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-root-continuity-"));
  try {
    for (const missing of ["config", "recovery", "bootstrap-journal", "purchase-journal"] as const) {
      const proof = path.join(root, missing);
      const source = path.join(root, `${missing}-source`);
      const initialized = initializeLiveProof(proof, source, TEST_NODE_URL);
      await closeInitialized(initialized);
      const filename = {
        config: initialized.layout.configPath,
        recovery: initialized.layout.recoveryPath,
        "bootstrap-journal": initialized.layout.bootstrapJournalPath,
        "purchase-journal": initialized.layout.purchaseJournalPath,
      }[missing];
      fs.unlinkSync(filename);
      assert.throws(
        () => initializeLiveProof(proof, source, TEST_NODE_URL),
        /identity is missing|recovery continuity is missing|journal continuity is missing/
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart inclusion proof is transaction and accepting-block exact without a live UTXO", async () => {
  const milestone = chainMilestone(
    "21".repeat(32),
    "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    "1"
  );
  const wallet = {
    client: async () => ({
      getVirtualChainFromBlock: async () => ({
        acceptedTransactionIds: [{
          acceptingBlockHash: milestone.acceptingBlockHash,
          acceptedTransactionIds: [milestone.transactionId],
        }],
      }),
      getBlock: async () => ({
        block: {
          header: {
            hash: milestone.acceptingBlockHash,
            daaScore: milestone.acceptingBlockDaaScore,
          },
          verboseData: { hash: milestone.acceptingBlockHash },
        },
      }),
    }),
  } as unknown as KaspaWallet;
  await verifyLiveChainMilestoneInclusion(milestone, wallet);
  await assert.rejects(
    verifyLiveChainMilestoneInclusion(
      { ...milestone, acceptingBlockHash: "24".repeat(32) },
      wallet
    ),
    /accepting-block proof changed/
  );
  await assert.rejects(
    verifyLiveChainMilestoneInclusion(
      { ...milestone, acceptingBlockDaaScore: "106" },
      wallet
    ),
    /accepting-block proof changed/
  );
});

test("restart reconciliation refreshes only a DAG-reaccepted transaction's accepting block", async () => {
  const milestone = Object.freeze({
    ...chainMilestone(
      "26".repeat(32),
      "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
      "1"
    ),
    covenantId: "27".repeat(32),
  });
  const currentHash = "28".repeat(32);
  const currentDaaScore = "107";
  const wallet = {
    client: async () => ({
      getVirtualChainFromBlock: async () => ({
        acceptedTransactionIds: [{
          acceptingBlockHash: currentHash,
          acceptedTransactionIds: [milestone.transactionId],
        }],
      }),
      getBlock: async () => ({
        block: {
          header: { hash: currentHash, daaScore: currentDaaScore },
          verboseData: { hash: currentHash },
        },
      }),
    }),
  } as unknown as KaspaWallet;

  const reconciled = await reconcileLiveChainMilestoneInclusion(milestone, wallet);
  assert.notEqual(reconciled, milestone);
  assert.deepEqual(reconciled, {
    ...milestone,
    acceptingBlockHash: currentHash,
    acceptingBlockDaaScore: currentDaaScore,
  });
  assert.equal(reconciled.transactionId, milestone.transactionId);
  assert.equal(reconciled.outpoint, milestone.outpoint);
  assert.equal(reconciled.observationStartHash, milestone.observationStartHash);
  assert.equal(reconciled.covenantId, milestone.covenantId);
  await assert.rejects(
    verifyLiveChainMilestoneInclusion(milestone, wallet),
    /accepting-block proof changed/
  );
  await verifyLiveChainMilestoneInclusion(reconciled, wallet);
});

test("recovery milestones remain authoritative when the progress cache is newer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-recovery-source-"));
  try {
    const initialized = initializeLiveProof(
      path.join(root, "proof"),
      path.join(root, "source"),
      TEST_NODE_URL
    );
    const recovery = readPrivateJsonState<LiveRecoveryRecord>(initialized.layout.recoveryPath);
    const durableMilestone = chainMilestone(
      "29".repeat(32),
      initialized.config.wallets.treasuryAddress,
      "500000000"
    );
    const cacheOnlyMilestone = {
      ...durableMilestone,
      transactionId: "2a".repeat(32),
      outpoint: `${"2a".repeat(32)}:0`,
    };
    writeAtomicJson(initialized.layout.recoveryPath, {
      ...recovery,
      updatedAt: "2026-07-11T00:00:00.000Z",
      milestones: { bootstrap: durableMilestone },
    });
    writeAtomicJson(initialized.layout.progressPath, {
      version: 1,
      runId: initialized.config.runId,
      updatedAt: "2026-07-11T00:00:01.000Z",
      bootstrap: cacheOnlyMilestone,
    });

    const resumed = readProgress(initialized.layout.progressPath, initialized.config.runId);
    assert.deepEqual(resumed.bootstrap, durableMilestone);
    assert.equal(resumed.updatedAt, "2026-07-11T00:00:00.000Z");
    await closeInitialized(initialized);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live bootstrap capacity and Treasury dispatch preserve restart idempotency", async () => {
  const milestone = chainMilestone(
    "25".repeat(32),
    "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et",
    "1"
  );
  assert.equal(liveBootstrapNeedsCapacity(undefined, false), true);
  assert.equal(liveBootstrapNeedsCapacity(undefined, true), false);
  assert.equal(liveBootstrapNeedsCapacity(milestone, false), false);
  assert.equal(liveBootstrapNeedsCapacity(milestone, true), false);

  const request: TreasuryOperationRequest = {
    operationKey: "e2e:test:dispatch",
    kind: "wallet_send",
    destination: milestone.address,
    amountAtomic: "1",
  };
  const completed: TreasuryOperationView = {
    operationKey: request.operationKey,
    kind: request.kind,
    state: "completed",
    summary: "completed",
    destination: request.destination,
    requestedAmountAtomic: request.amountAtomic,
    feeCeilingAtomic: "1",
    amountAtomic: "1",
    feeAtomic: "1",
    transactionId: milestone.transactionId,
    retryCount: 0,
    recoveryRequired: false,
    safeToRetry: false,
  cancellationRequested: false,
  preparationFenced: false,
  };
  let executeCalls = 0;
  let recoverCalls = 0;
  const module = {
    execute: async () => {
      executeCalls += 1;
      return completed;
    },
    recover: async () => {
      recoverCalls += 1;
      return completed;
    },
  } as unknown as TreasuryOperationModule;

  await driveLiveTreasuryOperation(module, request, undefined, false);
  assert.equal(executeCalls, 1);
  assert.equal(recoverCalls, 0);

  executeCalls = 0;
  recoverCalls = 0;
  await driveLiveTreasuryOperation(module, request, undefined, true);
  assert.equal(executeCalls, 0);
  assert.equal(recoverCalls, 1);
});

test("Merchant verifier rejects an additive head outside configured live state before RPC", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-merchant-pin-"));
  try {
    const initialized = initializeLiveProof(
      path.join(root, "proof"),
      path.join(root, "source"),
      TEST_NODE_URL
    );
    const codec = new KaspaTestnet10AddressCodec();
    const expectedHead = "31".repeat(32);
    const headTransactionId = "32".repeat(32);
    const verifier = new LiveMerchantExactVerifier({
      wallet: initialized.merchantWallet,
      statePath: initialized.layout.merchantVerifierStatePath,
      expected: {
        profile: "additive",
        payTo: initialized.config.additiveHead.address,
        payToScriptPublicKey: codec.scriptPublicKeyForAddress(
          initialized.config.additiveHead.address,
          LIVE_NETWORK
        ).toLowerCase(),
        head: {
          headId: expectedHead,
          headVersion: "0",
          transactionId: headTransactionId,
          index: 0,
          amountAtomic: LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
          scriptPublicKey: initialized.config.additiveHead.scriptPublicKey,
          redeemScript: initialized.config.additiveHead.redeemScript,
          additiveThresholdAtomic: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
        },
      },
    });
    const request = {
      network: LIVE_NETWORK,
      profile: "additive",
      transaction: "{}",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      amount: "20000000",
      payTo: initialized.config.additiveHead.address,
      payToScriptPublicKey: codec.scriptPublicKeyForAddress(
        initialized.config.additiveHead.address,
        LIVE_NETWORK
      ),
      requiredFinality: "accepted",
      requestHash: "33".repeat(32),
      paymentRequirementsHash: "34".repeat(32),
      authorization: {
        version: "kaspa-x402-exact-request-authorization-v1",
        inputIndex: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        digest: "35".repeat(32),
        signature: "36".repeat(64),
      },
      head: {
        templateId: "kaspa-x402-kip10-additive-v1",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        headId: "37".repeat(32),
        headVersion: "0",
        expectedHeadOutpoint: { txid: headTransactionId, index: 0 },
        headAmount: LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC,
        headScriptPublicKey: initialized.config.additiveHead.scriptPublicKey,
        headRedeemScript: initialized.config.additiveHead.redeemScript,
        additiveThresholdSompi: LIVE_ADDITIVE_THRESHOLD_ATOMIC,
        paymentOutputIndex: 0,
        challengeId: "38".repeat(32),
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    } satisfies ExactTransactionVerificationRequest;
    await assert.rejects(
      verifier.verifyExactPayment(request),
      /differs from the configured profile/
    );
    await closeInitialized(initialized);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Merchant verifier refuses a first-seen accepted output without a durable pre-submission plan", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-merchant-accepted-shortcut-"));
  try {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const purchaseId = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
    const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
    const keyStore = new StagingKeyStore({
      directory: path.join(root, "keys"),
      now: () => now,
      generatePrivateKey: () => "01".padStart(64, "0"),
    });
    const staging = keyStore.create({ purchaseId, paymentIdentifier });
    const codec = new KaspaTestnet10AddressCodec();
    const payTo = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
    const payToScriptPublicKey = codec.scriptPublicKeyForAddress(payTo, LIVE_NETWORK).toLowerCase();
    const requestHash = "41".repeat(32);
    const paymentRequirementsHash = "42".repeat(32);
    const amount = "20000000";
    const builder = new ExactTransactionBuilder({ keyStore, now: () => now });
    const built = await builder.build({
      purchaseId,
      paymentIdentifier,
      request: {
        network: LIVE_NETWORK,
        profile: "standard-native",
        origin: "https://merchant.example",
        resourceUrl: "https://merchant.example/report",
        amount,
        payTo,
        payToScriptPublicKey,
        paymentOutputIndex: 0,
        requestHash,
        paymentRequirementsHash,
        authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        requiredFinality: "accepted",
        fundingSource: "vault-treasury",
      },
      staging: {
        outpoint: { txid: "43".repeat(32), index: 0 },
        amountAtomic: (BigInt(amount) + BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi)).toString(),
        scriptPublicKey: staging.scriptPublicKey,
        address: staging.address,
        blockDaaScore: "500000000",
        keyReference: staging.keyReference,
      },
      additionalCostCeilingAtomic: "2050000",
      stagingTransactionFeeAtomic: "50000",
    });
    const wallet = {
      networkId: "testnet-10",
      client: async () => ({
        getUtxosByAddresses: async () => ({
          entries: [{
            outpoint: { transactionId: built.transactionId, index: 0 },
            amount,
            scriptPublicKey: { version: 0, script: payToScriptPublicKey.slice(4) },
            blockDaaScore: 500000001n,
          }],
        }),
      }),
      serverInfo: async () => ({ virtualDaaScore: 500000002n }),
    } as unknown as KaspaWallet;
    const verifier = new LiveMerchantExactVerifier({
      wallet,
      statePath: path.join(root, "merchant-verifier.json"),
      expected: { profile: "standard-native", payTo, payToScriptPublicKey },
      now: () => now,
    });
    const verificationRequest = {
      network: LIVE_NETWORK,
      profile: "standard-native",
      transaction: built.transaction,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      amount,
      payTo,
      payToScriptPublicKey,
      requiredFinality: "accepted",
      requestHash,
      paymentRequirementsHash,
      authorization: built.authorization,
    } satisfies ExactTransactionVerificationRequest;

    await assert.rejects(
      verifier.verifyExactPayment(verificationRequest),
      /accepted exact output requires a durable pre-submission plan/
    );

    writeAtomicJson(path.join(root, "merchant-verifier.json"), {
      version: 2,
      transactionId: built.transactionId,
      transactionDigest: sha256Hex(built.transaction),
      binding: {
        profile: "standard-native",
        requestHash,
        paymentRequirementsHash,
        requestAuthorizationDigest: built.authorization.digest,
        requestAuthorizationPublicKey: staging.publicKey,
        payerAddress: staging.address,
        staging: {
          outpoint: `${"43".repeat(32)}:0`,
          amountAtomic: (BigInt(amount) + BigInt(SOMPI_EXACT_FEE_POLICY.feeSompi)).toString(),
          scriptPublicKey: staging.scriptPublicKey,
        },
      },
      paymentOutpoint: `${built.transactionId}:0`,
      state: "planned",
      plannedAt: "2030-01-01T00:00:00.000Z",
    });
    const replayed = await verifier.verifyExactPayment(verificationRequest);
    assert.equal(replayed.transactionId, built.transactionId);
    assert.equal(verifier.state().state, "observed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live Merchant composition validates before any funded Purchase begins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-merchant-compose-"));
  const exactStore = new SqliteMerchantServerStateStore(":memory:");
  const authorizationStore = new SqliteDemoCommerceAuthorizationStore(":memory:");
  try {
    const initialized = initializeLiveProof(
      path.join(root, "proof"),
      path.join(root, "source"),
      TEST_NODE_URL
    );
    const additiveHead = chainMilestone(
      "35".repeat(32),
      initialized.config.additiveHead.address,
      LIVE_ADDITIVE_HEAD_AMOUNT_ATOMIC
    );
    await createLiveMerchant(
      initialized,
      {
        version: 1,
        runId: initialized.config.runId,
        updatedAt: new Date().toISOString(),
        additiveHead: additiveHead,
      },
      exactStore,
      authorizationStore,
      {
        verifyExactPayment: async () => {
          throw new Error("composition test must not verify a payment");
        },
      } as unknown as LiveMerchantExactVerifier,
      "additive"
    );
    const [registered] = await exactStore.listExactHeads();
    assert.ok(registered);
    const successorTransactionId = "36".repeat(32);
    const successorAmount = (
      BigInt(registered.currentAmount) + BigInt(LIVE_ADDITIVE_THRESHOLD_ATOMIC)
    ).toString();
    await exactStore.applyExactHeadLineage({
      headId: registered.headId,
      expectedVersion: registered.version,
      expectedOutpoint: registered.currentOutpoint,
      expectedAmount: registered.currentAmount,
      steps: [{
        transactionId: successorTransactionId,
        spentOutpoint: registered.currentOutpoint,
        successor: {
          outpoint: { txid: successorTransactionId, index: 0 },
          amount: successorAmount,
          scriptPublicKey: registered.scriptPublicKey,
        },
        finality: "accepted",
      }],
      observedAt: "2026-07-17T00:00:00.000Z",
    });
    const persistedAdvanced = await exactStore.loadExactHead(registered.headId);
    assert.ok(persistedAdvanced);

    await createLiveMerchant(
      initialized,
      {
        version: 1,
        runId: initialized.config.runId,
        updatedAt: new Date().toISOString(),
        additiveHead,
      },
      exactStore,
      authorizationStore,
      {
        verifyExactPayment: async () => {
          throw new Error("composition restart test must not verify a payment");
        },
      } as unknown as LiveMerchantExactVerifier,
      "additive"
    );
    assert.deepEqual(await exactStore.loadExactHead(registered.headId), persistedAdvanced);
    await closeInitialized(initialized);
  } finally {
    exactStore.close();
    authorizationStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Merchant ingress durably retries the same paid request without protocol-side recovery logic", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-merchant-recovery-"));
  try {
    const purchaseId = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
    const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
    const request = {
      purchaseId,
      merchantCheckout: "merchant-checkout-artifact",
      paymentRequiredHeader: "payment-required-artifact",
      paymentIdentifier,
      headers: { "PAYMENT-SIGNATURE": "payment-signature-artifact" },
    };
    const calls: string[] = [];
    let merchantAttempts = 0;
    const endpoint = new LiveMerchantPaidEndpoint({
      ingressPath: path.join(root, "merchant", "paid-ingress.json"),
      merchant: {
        handlePaid: async () => {
          calls.push("merchant");
          merchantAttempts += 1;
          if (merchantAttempts === 1) throw new Error("simulated post-consume crash");
          return { response: { status: 200, headers: {} } };
        },
      },
    });
    await assert.rejects(endpoint.handlePaid(request), /post-consume crash/);
    const recovered = await endpoint.resumeDurableIngress(purchaseId);
    assert.ok(recovered);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(calls, ["merchant", "merchant"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live report has an exact honest schema and excludes actual key bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-proof-report-"));
  try {
    const initialized = initializeLiveProof(
      path.join(root, "proof"),
      path.join(root, "source"),
      TEST_NODE_URL
    );
    const report = fakeReport(initialized);
    writeAtomicJson(initialized.layout.merchantOfferPath, {
      version: 1,
      purchaseId: report.purchase.id,
      merchantCheckout: "merchant-checkout-signed-artifact-value",
      paymentRequiredHeader: "payment-required-signed-artifact-value",
      issuedAtSec: Math.floor(Date.now() / 1000),
    });
    writeAtomicJson(initialized.layout.paidReplayCapsulePath, {
      version: 1,
      purchaseId: report.purchase.id,
      merchantCheckout: "merchant-checkout-signed-artifact-value",
      paymentRequiredHeader: "payment-required-signed-artifact-value",
      paymentIdentifier: report.purchase.paymentIdentifier,
      paymentSignature: "payment-signature-signed-artifact-value",
      firstPresentedAtMs: Date.now(),
    });
    const filename = path.join(root, "public", "report.json");
    writeLiveTestnetProofReport(filename, report, initialized);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(report.ap2HumanPresentConformanceClaimed, false);
    assert.equal(report.authorityIsolationAppliedToThisRun, false);
    const humanPresentReport: LiveTestnetProofReport = {
      ...report,
      ap2HumanPresentConformanceClaimed: true,
      authorityMode: "separate-process-human-present",
      authorityIsolationAppliedToThisRun: true,
      separateAuthorityIsolationProofAvailable: true,
    };
    assert.doesNotThrow(() => writeLiveTestnetProofReport(
      path.join(root, "public", "human-present.json"),
      humanPresentReport,
      initialized
    ));
    assert.throws(
      () => writeLiveTestnetProofReport(
        path.join(root, "public", "incoherent-authority.json"),
        { ...humanPresentReport, authorityIsolationAppliedToThisRun: false },
        initialized
      ),
      /claims or protocol pins changed/
    );
    assert.throws(
      () => writeLiveTestnetProofReport(
        path.join(root, "public", "extra.json"),
        { ...report, unexpected: true } as LiveTestnetProofReport,
        initialized
      ),
      /shape changed/
    );
    const key = fs.readFileSync(
      path.join(initialized.config.wallets.treasuryDirectory, "wallet-key"),
      "utf8"
    ).trim();
    assert.throws(
      () => writeLiveTestnetProofReport(
        path.join(root, "public", "leak.json"),
        { ...report, generatedAt: key },
        initialized
      ),
      /private state/
    );
    assert.throws(
      () => writeLiveTestnetProofReport(
        path.join(root, "public", "artifact-leak.json"),
        { ...report, generatedAt: "payment-signature-signed-artifact-value" },
        initialized
      ),
      /paid-request artifact|private state/
    );
    const configBefore = fs.readFileSync(initialized.layout.configPath);
    assert.throws(
      () => writeLiveTestnetProofReport(initialized.layout.configPath, report, initialized),
      /shape changed/
    );
    assert.deepEqual(fs.readFileSync(initialized.layout.configPath), configBefore);
    await closeInitialized(initialized);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live proof paths reject every private-state and report overlap direction", () => {
  const root = path.resolve("/tmp/sompi-live-path-test");
  const proof = path.join(root, "proof");
  const source = path.join(root, "source");
  const report = path.join(root, "public", "report.json");
  assert.doesNotThrow(() => assertLiveTestnetProofPaths({
    directory: proof,
    sourceWalletDirectory: source,
    reportFilename: report,
  }));
  for (const invalid of [
    { directory: proof, sourceWalletDirectory: path.join(proof, "source"), reportFilename: report },
    { directory: path.join(source, "proof"), sourceWalletDirectory: source, reportFilename: report },
    { directory: proof, sourceWalletDirectory: source, reportFilename: path.join(proof, "report.json") },
    { directory: proof, sourceWalletDirectory: source, reportFilename: path.join(source, "wallet-key") },
  ]) {
    assert.throws(() => assertLiveTestnetProofPaths(invalid), /disjoint|outside/);
  }
});

test("live report target is validated before side effects can begin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-live-report-preflight-"));
  try {
    const filename = path.join(root, "public", "report.json");
    const purchaseId = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
    assert.doesNotThrow(() =>
      preflightLiveTestnetProofReportTarget(filename, purchaseId)
    );
    writeAtomicJson(filename, { not: "a live report" });
    assert.throws(
      () => preflightLiveTestnetProofReportTarget(filename, purchaseId),
      /shape changed/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function chainMilestone(
  transactionId: string,
  address: string,
  amountAtomic: string
): LiveChainMilestone {
  return Object.freeze({
    transactionId,
    outpoint: `${transactionId}:0`,
    address,
    amountAtomic,
    blockDaaScore: "100",
    virtualDaaScore: "120",
    finality: "confirmed" as const,
    observationStartHash: "22".repeat(32),
    acceptingBlockHash: "23".repeat(32),
    acceptingBlockDaaScore: "105",
  });
}

async function closeInitialized(initialized: ReturnType<typeof initializeLiveProof>): Promise<void> {
  await Promise.all([
    initialized.treasuryWallet.disconnect(),
    initialized.merchantWallet.disconnect(),
    initialized.observerWallet.disconnect(),
  ]);
}

function fakeReport(
  initialized: ReturnType<typeof initializeLiveProof>
): LiveTestnetProofReport {
  const bootstrap = chainMilestone(
    "41".repeat(32),
    initialized.config.wallets.treasuryAddress,
    "500000000"
  );
  const additiveHead = chainMilestone(
    "42".repeat(32),
    initialized.config.additiveHead.address,
    "100000000"
  );
  const deposit = chainMilestone(
    "43".repeat(32),
    initialized.config.vault.address,
    "300000000"
  );
  const report: LiveTestnetProofReport = Object.freeze({
    profile: "urn:sompi:e2e:live-testnet10-ap2-kaspa-x402-exact:2",
    generatedAt: new Date().toISOString(),
    network: LIVE_NETWORK,
    chainMode: "operator-pinned-live-testnet-10-wrpc",
    chainProvenance: {
      nodeVersion: "2.0.0",
      nodeNetwork: "testnet-10" as const,
      nodeVirtualDaaScore: "160",
      nodeSynced: true as const,
      nodeUtxoIndex: true as const,
      kaspaWasmSourceCommit: "78257f273a26c4be085bab0f79437dee99ca8835" as const,
      kaspaWasmVersion: "2.0.1" as const,
    },
    liveKaspaTestnet10ExecutionProved: true,
    exactProfile: "additive",
    purchaseIngress: "http-api",
    ap2HumanPresentConformanceClaimed: false,
    authorityMode: "in-process-local-auto-approved-test-fixture",
    authorityIsolationAppliedToThisRun: false,
    separateAuthorityIsolationProofAvailable: false,
    merchantMode: "in-process-local-merchant-independent-wrpc-verifier",
    protocolPins: SUPPORTED_PROTOCOL_PROFILES,
    bootstrapFunding: bootstrap,
    additiveHead: {
      created: additiveHead,
      additiveContinuation: {
        transactionId: "44".repeat(32),
        outpoint: `${"44".repeat(32)}:0`,
        address: initialized.config.additiveHead.address,
        amountAtomic: "120000000",
        blockDaaScore: "130",
        virtualDaaScore: "140",
        finality: "confirmed" as const,
      },
    },
    vaultDeposit: {
      ...deposit,
      covenantId: "45".repeat(32),
      requestedDepositAtomic: "300000000" as const,
    },
    purchase: {
      id: `pur_${"A".repeat(22)}` as LiveTestnetProofReport["purchase"]["id"],
      state: "receipted" as const,
      paymentIdentifier: `pay_${"A".repeat(43)}`,
      checkoutDigest: `sha256:${"A".repeat(43)}` as LiveTestnetProofReport["purchase"]["checkoutDigest"],
      authorizationEvidenceDigest: `sha256:${"B".repeat(43)}` as LiveTestnetProofReport["purchase"]["authorizationEvidenceDigest"],
      settlementEvidenceDigest: `sha256:${"C".repeat(43)}` as LiveTestnetProofReport["purchase"]["settlementEvidenceDigest"],
      fulfilmentDigest: `sha256:${"D".repeat(43)}` as LiveTestnetProofReport["purchase"]["fulfilmentDigest"],
      receiptEvidenceDigests: [`sha256:${"E".repeat(43)}` as LiveTestnetProofReport["purchase"]["checkoutDigest"]],
    },
    transactions: {
      stagingTransactionId: "46".repeat(32),
      stagingOutpoint: `${"46".repeat(32)}:0`,
      stagingObservedAtDaa: "150",
      stagingFinality: "confirmed" as const,
      exactTransactionId: "47".repeat(32),
      merchantOutpoint: `${"47".repeat(32)}:0`,
    },
    exactFinality: {
      merchantVerifier: "accepted" as const,
      merchantObservedAtDaa: "151",
      clientObserver: "confirmed" as const,
      clientObservedAtMs: Date.now(),
    },
    economics: {
      advertisedAmountAtomic: "20000000" as const,
      merchantGainAtomic: "20000000" as const,
      payerTransactionCostAtomic: "22000000",
      exactFeeAtomic: "2000000",
      minimumSdkFeeAtomic: "128200",
      transactionMass: "1282",
      transactionVersion: 1 as const,
      inputCount: 2 as const,
      outputCount: 1 as const,
    },
    idempotency: {
      duplicatePurchaseReturnedSameId: true as const,
      duplicateMerchantPaidRequestReturnedSameTransaction: true as const,
      uniqueMerchantExactTransactions: 1 as const,
    },
    protocolSeparation: {
      paidRequestExtensionKeys: ["payment-identifier"] as const,
      ap2DataInX402Request: false as const,
    },
    evidenceHandling: {
      reportMode: "0600" as const,
      publicFactsOnly: true as const,
      recoveryRecordStoredSeparately: true as const,
      outputBlockDaaScoreMeaning:
        "utxo-creation-daa-observed-while-output-was-live" as const,
      acceptingBlockDaaScoreMeaning:
        "current-virtual-chain-accepting-block-header-daa" as const,
    },
    lifecycleLimitations: {
      additiveChallenges: "offer-scoped-read-only-until-paid" as const,
      expiredRunAction:
        "fail-closed-recover-staging-and-require-new-explicit-run" as const,
      missingStateAction:
        "fail-closed-while-run-identity-survives-total-state-loss-requires-operator-accounting" as const,
    },
  });
  return report;
}
