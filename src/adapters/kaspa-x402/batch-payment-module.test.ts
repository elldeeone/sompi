import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  MemoryChannelStore,
  type ChannelSigner,
  type DirectModeChannel,
} from "@kaspa-x402/client";
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  sha256Hex,
  withKaspaSettlementExtension,
  type Hash32Hex,
  type PaymentRequired,
  type SignatureHex,
} from "@kaspa-x402/core";

import { evidenceDigest } from "../../purchase/identity.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  requestFingerprint,
} from "../../purchase/identity.js";
import { authorizationFactsDigest } from "../../purchase/contracts.js";
import {
  PurchaseJournal,
  type BatchTreasuryMovementRecord,
} from "../../purchase/journal.js";
import type { PurchaseId, Sha256Digest } from "../../purchase/types.js";
import { JournalBatchChannelStore } from "./batch-channel-store.js";
import {
  JournalBatchVoucherAuthorizer,
  KaspaX402BatchPaymentModule,
} from "./batch-payment-module.js";

const CHANNEL_ID = "11".repeat(32) as Hash32Hex;
const CLIENT_KEY = "22".repeat(32) as Hash32Hex;
const SERVER_KEY = "33".repeat(32) as Hash32Hex;
const ACTIVE_TX = "44".repeat(32) as Hash32Hex;
const SCRIPT = `000020${"55".repeat(32)}`;
const SIGNATURE = "66".repeat(64) as SignatureHex;
const PAY_TO = "kaspatest:payee";
const RESOURCE = "https://merchant.example/batch";

test("batch module signs one authorized voucher against an existing epoch and applies actual charge", async () => {
  const store = new MemoryChannelStore([channel()]);
  const authorizations: Array<Record<string, unknown>> = [];
  const module = new KaspaX402BatchPaymentModule({
    store,
    signer: signer(),
    addressCodec: {
      scriptPublicKeyForAddress: () => SCRIPT,
      encodeScriptAddress: () => "kaspatest:escrow",
    },
    chain: {
      getVirtualDaaScore: async () => "400000000",
      getUtxos: async () => [{
        outpoint: { txid: ACTIVE_TX, index: 0 },
        amount: "1000",
        scriptPublicKey: SCRIPT,
        address: "kaspatest:escrow",
      }],
    },
    authorizer: {
      authorize(input: Parameters<JournalBatchVoucherAuthorizer["authorize"]>[0]) {
        authorizations.push(structuredClone(input) as Record<string, unknown>);
        return movement(input.purchaseId, input.voucherCeilingAtomic);
      },
    } as never,
    claimFeeReserveAtomic: "10",
    transport: disabledTransport(),
  });
  const prepared = await module.prepare(input());
  const envelope = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
  assert.equal(authorizations.length, 1);
  assert.equal(prepared.mechanism, "channel-voucher");
  assert.equal(prepared.requiredAssurance, "channel-commitment");
  assert.equal(envelope.channelId, CHANNEL_ID);
  assert.equal(envelope.maximumAuthorizedAtomic, "20");
  assert.equal(envelope.voucherCeilingAtomic, "20");
  assert.match(module.signatureHeader(prepared.preparedBytes), /^[A-Za-z0-9+/]+=*$/);

  const commitmentId = "77".repeat(32) as Hash32Hex;
  const response = withKaspaSettlementExtension({
    success: true,
    transaction: commitmentId,
    network: "kaspa:testnet-10",
    amount: "12",
  }, {
    commitmentId,
    chargedAmount: "12",
    channelId: CHANNEL_ID,
    channelState: {
      channelId: CHANNEL_ID,
      activeOutpoint: { txid: ACTIVE_TX, index: 0 },
      activeScriptPublicKey: SCRIPT,
      fundingAmount: "1000",
      chargedCumulativeAmount: "12",
      claimedCumulativeAmount: "0",
      signedMaxClaimable: "20",
    },
  });
  const applied = await module.applySettlement(
    prepared.preparedBytes,
    encodePaymentResponseHeader(response)
  );
  assert.equal(applied.chargedAmountAtomic, "12");
  assert.equal(applied.maximumAuthorizedAtomic, "20");
  assert.equal((await store.loadChannels({}))[0]?.chargedCumulativeAmount, "12");
});

test("batch module refuses implicit deposit and preserves the claim-fee reserve", async () => {
  const noChannel = new KaspaX402BatchPaymentModule({
    store: new MemoryChannelStore(), signer: signer(),
    addressCodec: { scriptPublicKeyForAddress: () => SCRIPT, encodeScriptAddress: () => "kaspatest:escrow" },
    chain: { getVirtualDaaScore: async () => "1", getUtxos: async () => [] },
    authorizer: { authorize() { throw new Error("must not authorize"); } } as never,
    claimFeeReserveAtomic: "10",
    transport: disabledTransport(),
  });
  await assert.rejects(noChannel.prepare(input()), /no funding or broadcast authority|already accepted channel/);
});

test("batch settlement rejects overcharge, cross-channel state, and stale active outpoints", async () => {
  const mutations: Array<(extra: Record<string, unknown>) => void> = [
    (extra) => { extra.channelId = "99".repeat(32); },
    (extra) => {
      extra.chargedAmount = "21";
      (extra.channelState as Record<string, unknown>).chargedCumulativeAmount = "21";
      (extra.channelState as Record<string, unknown>).signedMaxClaimable = "21";
    },
    (extra) => {
      (extra.channelState as Record<string, unknown>).activeOutpoint = {
        txid: "98".repeat(32), index: 0,
      };
    },
  ];
  for (const mutate of mutations) {
    const store = new MemoryChannelStore([channel()]);
    const module = batchModule(store);
    const prepared = await module.prepare(input());
    const commitmentId = "77".repeat(32) as Hash32Hex;
    const extra: Record<string, unknown> = {
      commitmentId,
      chargedAmount: "12",
      channelId: CHANNEL_ID,
      channelState: {
        channelId: CHANNEL_ID,
        activeOutpoint: { txid: ACTIVE_TX, index: 0 },
        activeScriptPublicKey: SCRIPT,
        fundingAmount: "1000",
        chargedCumulativeAmount: "12",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "20",
      },
    };
    mutate(extra);
    const response = withKaspaSettlementExtension({
      success: true,
      transaction: commitmentId,
      network: "kaspa:testnet-10",
      amount: String(extra.chargedAmount),
    }, extra as never);
    await assert.rejects(
      module.applySettlement(prepared.preparedBytes, encodePaymentResponseHeader(response))
    );
  }
});

test("batch channel selection is resource-bound and never falls back across routes", async () => {
  const store = new MemoryChannelStore([{ ...channel(), resourceUrl: "https://merchant.example/other" }]);
  await assert.rejects(
    batchModule(store).prepare(input()),
    /no funding or broadcast authority|already accepted channel/
  );
});

test("batch module coordinates the real Journal authorization, channel epoch, and accepted charge", async () => {
  await withAuthorizedBatchJournal(async ({ journal, purchaseId, store }) => {
    const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
    journal.createPaymentAttempt({ purchaseId, attempt: 1, identifier: paymentIdentifier });
    await store.saveChannel(channel());
    const authorizer = new JournalBatchVoucherAuthorizer(journal, "10");
    const module = new KaspaX402BatchPaymentModule({
      store,
      signer: signer(),
      addressCodec: {
        scriptPublicKeyForAddress: () => SCRIPT,
        encodeScriptAddress: () => "kaspatest:escrow",
      },
      chain: {
        getVirtualDaaScore: async () => "400000000",
        getUtxos: async () => [{
          outpoint: { txid: ACTIVE_TX, index: 0 },
          amount: "1000",
          scriptPublicKey: SCRIPT,
          address: "kaspatest:escrow",
        }],
      },
      authorizer,
      claimFeeReserveAtomic: "10",
      transport: disabledTransport(),
    });
    const prepared = await module.prepare({
      ...input(),
      execution: {
        ...input().execution,
        purchaseId,
        paymentIdentifier,
        authorizationRequest: {
          ...input().execution.authorizationRequest,
          purchaseId,
        },
        authorization: {
          ...input().execution.authorization,
          purchaseId,
          facts: {
            ...input().execution.authorization.facts,
            purchaseId,
          },
        },
      },
    });
    const contenderId = createPurchaseId(new Uint8Array(16).fill(0x4c));
    journal.createPurchase({
      id: contenderId,
      requestKey: assertPurchaseRequestKey("test:batch-payment:contender"),
      resourceUrl: RESOURCE,
      method: "GET",
      resourceFingerprint: requestFingerprint({ url: RESOURCE, method: "GET" }),
      expectedMerchantId: "merchant:test",
      expectedMerchantOrigin: "https://merchant.example",
    });
    assert.throws(
      () => journal.planBatchTreasuryMovement({
        movementId: `batch-voucher:${contenderId}`,
        channelId: CHANNEL_ID,
        purchaseId: contenderId,
        kind: "voucher",
        requestDigest: evidenceDigest("competing-batch-voucher"),
        activeOutpointBefore: { txid: ACTIVE_TX, index: 0 },
        maximumAuthorizedAtomic: "20",
        voucherCeilingAtomic: "20",
      }),
      /already has open voucher Movement/
    );
    const commitmentId = "77".repeat(32) as Hash32Hex;
    const response = withKaspaSettlementExtension({
      success: true,
      transaction: commitmentId,
      network: "kaspa:testnet-10",
      amount: "12",
    }, {
      commitmentId,
      chargedAmount: "12",
      channelId: CHANNEL_ID,
      channelState: {
        channelId: CHANNEL_ID,
        activeOutpoint: { txid: ACTIVE_TX, index: 0 },
        activeScriptPublicKey: SCRIPT,
        fundingAmount: "1000",
        chargedCumulativeAmount: "12",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "20",
      },
    });
    const applied = await module.applySettlement(
      prepared.preparedBytes,
      encodePaymentResponseHeader(response)
    );
    const evidenceBytes = Buffer.from(encodePaymentResponseHeader(response), "ascii");
    authorizer.accept({
      purchaseId,
      paymentIdentifier,
      merchantId: "merchant:test",
      movementId: `batch-voucher:${purchaseId}`,
      actualChargeAtomic: applied.chargedAmountAtomic,
      commitmentId,
      evidenceBytes,
      verification: {
        verifierId: "sompi-kaspa-x402-alpha8-batch",
        profile: "kaspa-x402-0.1.0-alpha.8-batch-settlement",
        detailDigest: evidenceDigest(evidenceBytes),
      },
    });
    const movement = journal.requireBatchTreasuryMovement(`batch-voucher:${purchaseId}`);
    assert.equal(applied.chargedAmountAtomic, "12");
    assert.equal(movement.state, "accepted");
    assert.equal(movement.maximumAuthorizedAtomic, "20");
    assert.equal(movement.actualChargeAtomic, "12");
    assert.equal(movement.transactionId, commitmentId);
    assert.ok(movement.evidenceDigest);
  });
});

function input(): Parameters<KaspaX402BatchPaymentModule["prepare"]>[0] {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepts: [{
      scheme: "batch-settlement",
      network: "kaspa:testnet-10",
      amount: "20",
      asset: "KAS",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: {
        binding: "kaspa-escrow-v1",
        templateId: "kaspa-x402-escrow-v1",
        serverPublicKey: SERVER_KEY,
        minDepositSompi: "100",
        refundTimeoutDaa: "500000000",
      },
    }],
  };
  const bytes = Buffer.from(encodePaymentRequiredHeader(required), "ascii");
  const purchaseId = createPurchaseId(new Uint8Array(16).fill(9));
  const checkoutDigest = evidenceDigest(Buffer.from("checkout"));
  const resourceFingerprint = evidenceDigest(Buffer.from("resource"));
  const executionPlanDigest = evidenceDigest(Buffer.from("batch-plan"));
  const terms = {
    merchant: { id: "merchant:test", name: "Test Merchant", origin: "https://merchant.example" },
    resourceFingerprint,
    amountAtomic: "20",
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: PAY_TO,
    expiresAt: "2099-01-01T00:00:00.000Z",
    checkoutDigest,
  };
  const authorizationRequest = {
    purchaseId,
    resourceUrl: RESOURCE,
    method: "GET",
    requestMediaType: "application/octet-stream",
    requestBodyDigest: evidenceDigest(new Uint8Array()),
    terms,
    requestDigest: evidenceDigest(Buffer.from("authorization-request")),
    nonceDigest: evidenceDigest(Buffer.from("authorization-nonce")),
    additionalCostCeilingAtomic: "0",
    effectiveFinalityFloor: "accepted" as const,
    executionPlanDigest,
    executionMechanism: "channel-voucher" as const,
    executionProfile: "kaspa-escrow-v1:batch-settlement",
    settlementAssurance: "channel-commitment" as const,
    maximumAuthorizedChargeAtomic: "20",
    channelId: CHANNEL_ID,
    channelEpochDigest: evidenceDigest(Buffer.from("channel-epoch")),
    createdAtMs: 1,
    expiresAtMs: Date.parse(terms.expiresAt),
  };
  return {
    execution: {
      purchaseId,
      terms,
      authorizationRequest,
      authorization: {
        purchaseId,
        checkoutDigest,
        decision: "approved" as const,
        authorityId: "authority:test",
        evidenceDigest: evidenceDigest(Buffer.from("authority")),
        facts: {
          purchaseId,
          resourceUrl: RESOURCE,
          method: "GET",
          requestMediaType: "application/octet-stream",
          requestBodyDigest: authorizationRequest.requestBodyDigest,
          resourceFingerprint,
          merchantId: "merchant:test",
          merchantOrigin: "https://merchant.example",
          amountAtomic: "20",
          asset: "KAS",
          network: "kaspa:testnet-10",
          payTo: PAY_TO,
          expiresAt: terms.expiresAt,
          checkoutDigest,
          requestDigest: authorizationRequest.requestDigest,
          nonceDigest: authorizationRequest.nonceDigest,
          additionalCostCeilingAtomic: "0",
          effectiveFinalityFloor: "accepted" as const,
          executionPlanDigest,
          executionMechanism: "channel-voucher" as const,
          executionProfile: "kaspa-escrow-v1:batch-settlement",
          settlementAssurance: "channel-commitment" as const,
          maximumAuthorizedChargeAtomic: "20",
          channelId: CHANNEL_ID,
          channelEpochDigest: authorizationRequest.channelEpochDigest,
        },
      },
      paymentIdentifier: "pay_test-batch-identifier" as never,
    },
    request: {
      url: RESOURCE,
      method: "GET",
      body: new Uint8Array(),
      requestFingerprint: resourceFingerprint,
    },
    paymentRequirements: bytes,
    additionalCostCeilingAtomic: "0",
  };
}

function disabledTransport() {
  return {
    send: async (): Promise<never> => {
      throw new Error("paid HTTP transport is outside this test");
    },
  };
}

function batchModule(store: MemoryChannelStore): KaspaX402BatchPaymentModule {
  return new KaspaX402BatchPaymentModule({
    store,
    signer: signer(),
    addressCodec: {
      scriptPublicKeyForAddress: () => SCRIPT,
      encodeScriptAddress: () => "kaspatest:escrow",
    },
    chain: {
      getVirtualDaaScore: async () => "400000000",
      getUtxos: async () => [{
        outpoint: { txid: ACTIVE_TX, index: 0 },
        amount: "1000",
        scriptPublicKey: SCRIPT,
        address: "kaspatest:escrow",
      }],
    },
    authorizer: {
      authorize(input: Parameters<JournalBatchVoucherAuthorizer["authorize"]>[0]) {
        return movement(input.purchaseId, input.voucherCeilingAtomic);
      },
    } as never,
    claimFeeReserveAtomic: "10",
    transport: disabledTransport(),
  });
}

function channel(): DirectModeChannel {
  return {
    id: CHANNEL_ID,
    origin: "https://merchant.example",
    resourceUrl: RESOURCE,
    config: {
      network: "kaspa:testnet-10", asset: "KAS", templateId: "kaspa-x402-escrow-v1",
      clientPublicKey: CLIENT_KEY, serverPublicKey: SERVER_KEY, payTo: PAY_TO,
      refundAddress: "kaspatest:refund", refundTimeoutDaa: "500000000",
      salt: "88".repeat(32) as Hash32Hex,
    },
    clientPublicKey: CLIENT_KEY,
    serverPublicKey: SERVER_KEY,
    activeOutpoint: { txid: ACTIVE_TX, index: 0 },
    activeScriptPublicKey: SCRIPT,
    escrowAddress: "kaspatest:escrow",
    fundingSource: "vault-treasury",
    fundingAmount: "1000",
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedCumulativeAmount: "0",
    refundTimeoutDaa: "500000000",
    templateId: "kaspa-x402-escrow-v1",
    status: "active",
  };
}

function signer(): ChannelSigner {
  const disabled = async (): Promise<never> => { throw new Error("unexpected channel creation"); };
  return {
    generateChannelKey: disabled,
    randomSalt: disabled,
    randomNonce: disabled,
    signVoucher: async () => SIGNATURE,
  };
}

function movement(purchaseId: ReturnType<typeof createPurchaseId>, ceiling: string): BatchTreasuryMovementRecord {
  return {
    movementId: `batch-voucher:${purchaseId}`,
    channelId: CHANNEL_ID,
    purchaseId,
    kind: "voucher",
    state: "planned",
    requestDigest: evidenceDigest(Buffer.from("movement")),
    activeOutpointBefore: { txid: ACTIVE_TX, index: 0 },
    maximumAuthorizedAtomic: "20",
    voucherCeilingAtomic: ceiling,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

async function withAuthorizedBatchJournal(
  run: (input: {
    journal: PurchaseJournal;
    purchaseId: PurchaseId;
    store: JournalBatchChannelStore;
  }) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-batch-payment-"));
  fs.chmodSync(root, 0o700);
  const now = 1_800_000_000_000;
  const journal = new PurchaseJournal(path.join(root, "purchase.sqlite"), {
    now: () => now,
    evidenceDirectory: path.join(root, "evidence"),
  });
  try {
    const purchaseId = createPurchaseId(new Uint8Array(16).fill(0x4b));
    const resource = { url: RESOURCE, method: "GET" } as const;
    const resourceFingerprint = requestFingerprint(resource);
    journal.createPurchase({
      id: purchaseId,
      requestKey: assertPurchaseRequestKey("test:batch-payment:authorized"),
      resourceUrl: resource.url,
      method: resource.method,
      resourceFingerprint,
      expectedMerchantId: "merchant:test",
      expectedMerchantOrigin: "https://merchant.example",
    });
    const checkoutDigest = verifiedEvidence(journal, purchaseId, "batch-checkout", "checkout-terms");
    const requirementsDigest = verifiedEvidence(
      journal,
      purchaseId,
      "batch-requirements",
      "payment-requirements"
    );
    const plan = journal.storeExecutionPlanEvidence(purchaseId, {
      mechanism: "channel-voucher",
      profile: "kaspa-escrow-v1:batch-settlement",
      requirementsDigest,
      maximumChargeAtomic: "20",
      settlementAssurance: "channel-commitment",
      channelEpoch: {
        channelId: CHANNEL_ID,
        activeOutpoint: { txid: ACTIVE_TX, index: 0 },
        activeScriptPublicKey: SCRIPT,
        fundingAmountAtomic: "1000",
        refundTimeoutDaa: "500000000",
      },
      claimFeeReserveAtomic: "10",
    });
    const expiresAt = "2099-01-01T00:00:00.000Z";
    journal.bindCheckoutTerms(purchaseId, {
      terms: {
        merchant: { id: "merchant:test", name: "Test Merchant", origin: "https://merchant.example" },
        resourceFingerprint,
        amountAtomic: "20",
        asset: "KAS",
        network: "kaspa:testnet-10",
        payTo: PAY_TO,
        expiresAt,
        checkoutDigest,
      },
      checkoutEvidenceDigest: checkoutDigest,
      checkoutVerificationProfile: "test-profile-v1",
      checkoutVerifierId: "test-verifier",
      paymentRequirementsDigest: requirementsDigest,
      paymentRequirementsVerificationProfile: "test-profile-v1",
      paymentRequirementsVerifierId: "test-verifier",
      executionPlan: plan.plan,
      executionPlanEvidenceDigest: plan.evidenceDigest,
    });
    const requestDigest = verifiedEvidence(
      journal,
      purchaseId,
      "batch-authorization-request",
      "authorization-request"
    );
    journal.storeEvidence(purchaseId, {
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream",
      profile: "urn:sompi:purchase-request-body:1",
      kind: "purchase-request-body",
    });
    const nonceDigest = evidenceDigest("batch-authorization-nonce");
    const expiresAtMs = Date.parse(expiresAt);
    journal.recordAuthorizationRequest(purchaseId, {
      checkoutDigest,
      requestDigest,
      nonceDigest,
      requestMediaType: "",
      requestBodyDigest: evidenceDigest(new Uint8Array()),
      additionalCostCeilingAtomic: "0",
      effectiveFinalityFloor: "accepted",
      expiresAtMs,
    });
    const authorizationRequest = journal.requireAuthorizationRequest(purchaseId);
    const authorizationEvidence = verifiedEvidence(
      journal,
      purchaseId,
      "batch-authorization",
      "purchase-authorization"
    );
    const terms = journal.requireCheckoutTerms(purchaseId);
    journal.recordAuthorizationDecision(purchaseId, {
      decision: "approved",
      authorityId: "authority:test",
      checkoutDigest,
      approvedFactsDigest: authorizationFactsDigest({
        purchaseId,
        resourceUrl: RESOURCE,
        method: "GET",
        requestMediaType: "",
        requestBodyDigest: evidenceDigest(new Uint8Array()),
        terms,
        requestDigest,
        nonceDigest,
        additionalCostCeilingAtomic: "0",
        effectiveFinalityFloor: "accepted",
        executionPlanDigest: authorizationRequest.executionPlanDigest,
        executionMechanism: authorizationRequest.executionMechanism,
        executionProfile: authorizationRequest.executionProfile,
        settlementAssurance: authorizationRequest.settlementAssurance,
        maximumAuthorizedChargeAtomic: authorizationRequest.maximumAuthorizedChargeAtomic,
        channelId: authorizationRequest.channelId,
        channelEpochDigest: authorizationRequest.channelEpochDigest,
        createdAtMs: authorizationRequest.createdAtMs,
        expiresAtMs,
      }),
      evidenceDigest: authorizationEvidence,
      verificationProfile: "test-profile-v1",
      verifierId: "test-verifier",
      requestDigest,
      nonceDigest,
      expiresAtMs,
    });
    await run({ journal, purchaseId, store: new JournalBatchChannelStore(journal) });
  } finally {
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function verifiedEvidence(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  value: string,
  kind: string
): Sha256Digest {
  const artifact = journal.storeEvidence(purchaseId, {
    bytes: Buffer.from(value, "utf8"),
    mediaType: "application/octet-stream",
    profile: "test-profile-v1",
    issuer: "merchant:test",
    kind,
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "test-verifier",
    profile: "test-profile-v1",
    detailDigest: evidenceDigest(`verified:${value}`),
  });
  return artifact.digest;
}
