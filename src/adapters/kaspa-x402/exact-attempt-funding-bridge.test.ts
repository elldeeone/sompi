import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { ExactTransactionPaymentRequest } from "@kaspa-x402/client";
import * as core from "@kaspa-x402/core";
import {
  buildKip10AdditiveRedeemScript,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

import {
  assertPurchaseId,
  createPaymentIdentifier,
  evidenceDigest,
  requestFingerprint,
} from "../../purchase/identity.js";
import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import {
  VaultExactAttemptFundingBridge,
  type JournalObservedStaging,
} from "./exact-attempt-funding-bridge.js";
import {
  KaspaX402ExactPaymentModule,
  type ExactAttemptFundingContext,
} from "./exact-payment-module.js";
import { Kip10ExactTransactionBuilder } from "./exact-transaction-builder.js";
import { StagingKeyStore } from "./staging-key-store.js";
import type { TreasuryStagingMetadata } from "./vault-treasury-staging.js";

const FIXED_PRIVATE_KEY = "01".padStart(64, "0");
const OWNER_PUBLIC_KEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PURCHASE_ID = assertPurchaseId("pur_AAAAAAAAAAAAAAAAAAAAAA");
const PAYMENT_ID = createPaymentIdentifier(PURCHASE_ID, 1);
const MERCHANT_ADDRESS =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const STAGING_TXID = "33".repeat(32);
const BORROW_TXID = "22".repeat(32);
const PRICE = "20000000";
const THRESHOLD = "10000000";
const STAGING_AMOUNT = "31000000";
const STAGING_FEE = "50000";
const COST_CEILING = "11050000";
const REQUEST_HASH = "44".repeat(32);
const EVIDENCE_DIGEST = digest("observed-staging");
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

test("fresh attempt providers expose only the joined journal-observed staging output", async () => {
  await withBridgeFixture(async (fixture) => {
    const first = await fixture.bridge.createProvider(fixture.context);
    const second = await fixture.bridge.createProvider(fixture.context);
    assert.notEqual(first, second);
    assert.deepEqual(await first.getPublicIdentity(), {
      address: fixture.metadata.address,
      publicKey: fixture.metadata.publicKey,
    });
    assert.equal(await first.getVirtualDaaScore(), "123");
    assert.deepEqual(await first.getUtxos([fixture.metadata.address]), [
      {
        outpoint: { txid: STAGING_TXID, index: 0 },
        amount: STAGING_AMOUNT,
        scriptPublicKey: fixture.metadata.scriptPublicKey,
        address: fixture.metadata.address,
      },
    ]);
    await assert.rejects(
      first.getUtxos([MERCHANT_ADDRESS]),
      /only its journal-observed staging address/
    );
    assert.deepEqual(
      await first.estimateFees({
        network: "kaspa:testnet-10",
        action: "exact",
        amount: PRICE,
      }),
      { feeSompi: "1000000" }
    );

    const built = await first.payExactTransaction!(fixture.request);
    const replay = await first.payExactTransaction!(structuredClone(fixture.request));
    assert.equal(replay.transactionId, built.transactionId);
    assert.equal(built.fundingSource, "vault-treasury");
    assert.equal(built.paymentOutputIndex, 1);
    const transaction = JSON.parse(built.transaction) as {
      inputs: Array<{ transactionId: string }>;
      outputs: Array<{ value: string }>;
    };
    assert.deepEqual(
      transaction.inputs.map((input) => input.transactionId),
      [BORROW_TXID, STAGING_TXID]
    );
    assert.deepEqual(
      transaction.outputs.map((output) => output.value),
      ["110000000", PRICE]
    );
  });
});

test("outpoint, script, key, DAA, fee, and ceiling substitutions fail closed", async () => {
  await withBridgeFixture(async (fixture) => {
    const cases: Array<{
      name: string;
      metadata?: Partial<TreasuryStagingMetadata>;
      observed?: Partial<JournalObservedStaging>;
      context?: Partial<ExactAttemptFundingContext>;
      pattern: RegExp;
    }> = [
      {
        name: "outpoint",
        observed: { outpoint: `${"55".repeat(32)}:0` },
        pattern: /observed outpoint differs/,
      },
      {
        name: "script",
        observed: { scriptPublicKey: `0000${"aa".repeat(34)}` },
        pattern: /observed script differs/,
      },
      {
        name: "key",
        metadata: { keyReference: `stg_v1_${"A".repeat(43)}` },
        pattern: /metadata key reference differs/,
      },
      {
        name: "DAA",
        observed: { blockDaaScore: "01" },
        pattern: /DAA score must be a canonical/,
      },
      {
        name: "ceiling",
        metadata: { additionalCostCeilingAtomic: "11050001" },
        pattern: /ceiling differs/,
      },
      {
        name: "fee",
        metadata: { stagingFeeAtomic: "-1" },
        pattern: /staging fee must be a canonical/,
      },
    ];
    for (const candidate of cases) {
      const bridge = fixture.makeBridge(candidate.metadata, candidate.observed);
      await assert.rejects(
        bridge.createProvider({ ...fixture.context, ...candidate.context }),
        candidate.pattern,
        candidate.name
      );
    }

    const tooExpensive = fixture.makeBridge({ stagingFeeAtomic: "50001" });
    const provider = await tooExpensive.createProvider(fixture.context);
    await assert.rejects(
      provider.payExactTransaction!(fixture.request),
      /complete exact additional cost exceeds/
    );

    await assert.rejects(
      fixture.bridge.createProvider({
        ...fixture.context,
        staging: { ...fixture.context.staging, outpoint: `${STAGING_TXID}:1` },
      }),
      /not a journal-observed vault output/
    );
  });
});

test("ExactPaymentModule prepares through the concrete provider and KIP-10 builder", async () => {
  await withBridgeFixture(async (fixture) => {
    const body = Buffer.from("request-body", "utf8");
    const resourceUrl = "https://merchant.example/resource";
    const fingerprint = requestFingerprint({
      url: resourceUrl,
      method: "POST",
      mediaType: "application/json",
      body,
    });
    const requestHash = Buffer.from(
      fingerprint.slice("sha256:".length),
      "base64url"
    ).toString("hex");
    const checkoutDigest = digest("checkout");
    const authorizationEvidenceDigest = digest("authorization");
    const requestDigest = digest("authority-request");
    const nonceDigest = digest("authority-nonce");
    const terms = {
      merchant: {
        id: "merchant:test",
        name: "Test Merchant",
        origin: "https://merchant.example",
      },
      resourceFingerprint: fingerprint,
      amountAtomic: PRICE,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: MERCHANT_ADDRESS,
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest,
    };
    const authorizationRequest = {
      purchaseId: PURCHASE_ID,
      resourceUrl,
      method: "POST",
      requestMediaType: "application/json",
      requestBodyDigest: digest(body),
      terms,
      requestDigest,
      nonceDigest,
      additionalCostCeilingAtomic: COST_CEILING,
      expiresAtMs: Date.parse(terms.expiresAt),
    };
    const facts = {
      purchaseId: PURCHASE_ID,
      resourceUrl,
      method: "POST",
      requestMediaType: "application/json",
      requestBodyDigest: digest(body),
      resourceFingerprint: fingerprint,
      merchantId: "merchant:test",
      merchantOrigin: "https://merchant.example",
      amountAtomic: PRICE,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: MERCHANT_ADDRESS,
      expiresAt: terms.expiresAt,
      checkoutDigest,
      requestDigest,
      nonceDigest,
      additionalCostCeilingAtomic: COST_CEILING,
    };
    const execution = {
      purchaseId: PURCHASE_ID,
      terms,
      authorizationRequest,
      authorization: {
        purchaseId: PURCHASE_ID,
        checkoutDigest,
        decision: "approved",
        authorityId: "authority:test",
        evidenceDigest: authorizationEvidenceDigest,
        facts,
      },
      paymentIdentifier: PAYMENT_ID,
    };
    const purchaseRequest = {
      url: resourceUrl,
      method: "POST",
      mediaType: "application/json",
      body: Uint8Array.from(body),
      requestFingerprint: fingerprint,
    };
    const paymentRequired = paymentRequiredWire(fixture.request, resourceUrl);
    const paymentRequirements = Buffer.from(
      core.encodePaymentRequiredHeader(paymentRequired as any),
      "ascii"
    );

    const integrationMetadata: TreasuryStagingMetadata = {
      ...fixture.metadata,
      paymentRequirementsDigest: evidenceDigest(paymentRequirements),
    };
    const bridge = fixture.makeBridge(integrationMetadata);
    const module = new KaspaX402ExactPaymentModule({
      staging: {
        prepare: async () => {
          throw new Error("staging already observed");
        },
        submit: async () => {
          throw new Error("staging already observed");
        },
        observe: async () => ({ status: "pending" }),
      },
      funding: bridge,
      channelSigner: {
        generateChannelKey: async () => {
          throw new Error("batch disabled");
        },
        randomSalt: async () => {
          throw new Error("batch disabled");
        },
        signVoucher: async () => {
          throw new Error("batch disabled");
        },
      },
      channelStore: {
        loadChannels: async () => [],
        saveChannel: async () => {
          throw new Error("batch disabled");
        },
        retireChannel: async () => {
          throw new Error("batch disabled");
        },
        deleteChannel: async () => {
          throw new Error("batch disabled");
        },
        listRefundableChannels: async () => [],
      },
      addressCodec: new KaspaTestnet10AddressCodec(),
      transport: {
        send: async () => {
          throw new Error("submission is outside this preparation test");
        },
      },
      settlementVerifier: {
        verify: async () => {
          throw new Error("Settlement is outside this preparation test");
        },
      },
      recoveryObserver: {
        observe: async () => ({ status: "pending" }),
      },
      now: () => NOW,
    } as any);

    const prepared = await module.prepare({
      execution: execution as any,
      request: purchaseRequest,
      paymentRequirements,
      staging: {
        transactionId: STAGING_TXID,
        outpoint: `${STAGING_TXID}:0`,
        amountAtomic: STAGING_AMOUNT,
        evidenceDigest: EVIDENCE_DIGEST,
        fundingSource: "vault-treasury",
      },
      additionalCostCeilingAtomic: COST_CEILING,
    });
    assert.match(prepared.transactionId, /^[a-f0-9]{64}$/);
    const exactEnvelope = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
    assert.equal(exactEnvelope.paymentPayload.payload.type, "exact-transaction");
    assert.equal(
      exactEnvelope.paymentPayload.payload.transaction,
      exactEnvelope.paymentPayload.payload.transaction
    );
    assert.equal(exactEnvelope.paymentPayload.payload.payerAddress, fixture.metadata.address);
    assert.equal(exactEnvelope.paymentPayload.payload.requestHash, requestHash);
    assert.equal(exactEnvelope.transactionId, prepared.transactionId);
  });
});

interface BridgeFixture {
  bridge: VaultExactAttemptFundingBridge;
  context: ExactAttemptFundingContext;
  request: ExactTransactionPaymentRequest;
  metadata: TreasuryStagingMetadata;
  observed: JournalObservedStaging;
  makeBridge(
    metadata?: Partial<TreasuryStagingMetadata>,
    observed?: Partial<JournalObservedStaging>
  ): VaultExactAttemptFundingBridge;
}

async function withBridgeFixture(
  action: (fixture: BridgeFixture) => Promise<void>
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-funding-bridge-"));
  fs.chmodSync(directory, 0o700);
  try {
    const keyStore = new StagingKeyStore({
      directory: path.join(directory, "keys"),
      now: () => NOW,
      generatePrivateKey: () => FIXED_PRIVATE_KEY,
    });
    const key = keyStore.create({
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_ID,
    });
    const builder = new Kip10ExactTransactionBuilder({
      keyStore,
      now: () => NOW,
    });
    const borrowRedeemScript = buildKip10AdditiveRedeemScript({
      ownerPublicKey: OWNER_PUBLIC_KEY,
      amount: "100000000",
    }).toLowerCase();
    const borrowScriptPublicKey = serializedScriptPublicKey(
      kip10AdditiveScriptPublicKey({
        ownerPublicKey: OWNER_PUBLIC_KEY,
        amount: "100000000",
      })
    ).toLowerCase();
    const request: ExactTransactionPaymentRequest = {
      network: "kaspa:testnet-10",
      amount: PRICE,
      payTo: MERCHANT_ADDRESS,
      requestHash: REQUEST_HASH,
      requiredFinality: "accepted",
      fundingSource: "vault-treasury",
      reservation: {
        templateId: "kaspa-x402-kip10-additive-v1",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        borrowOutpoint: { txid: BORROW_TXID, index: 0 },
        borrowAmount: "100000000",
        borrowScriptPublicKey,
        borrowRedeemScript,
        additiveThresholdSompi: THRESHOLD,
        paymentOutputIndex: 1,
        reservationId: "55".repeat(32),
        reservationExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    const metadata: TreasuryStagingMetadata = {
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_ID,
      envelopeDigest: digest("staging-envelope"),
      paymentRequirementsDigest: digest("payment-requirements"),
      priceAtomic: PRICE,
      additionalCostCeilingAtomic: COST_CEILING,
      additiveThresholdAtomic: THRESHOLD,
      exactFeeAtomic: "1000000",
      transactionId: STAGING_TXID,
      outpoint: `${STAGING_TXID}:0`,
      stagingAmountAtomic: STAGING_AMOUNT,
      stagingFeeAtomic: STAGING_FEE,
      keyReference: key.keyReference,
      address: key.address,
      publicKey: key.publicKey,
      scriptPublicKey: key.scriptPublicKey,
    };
    const observed: JournalObservedStaging = {
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_ID,
      transactionId: STAGING_TXID,
      outpoint: `${STAGING_TXID}:0`,
      amountAtomic: STAGING_AMOUNT,
      address: key.address,
      scriptPublicKey: key.scriptPublicKey,
      blockDaaScore: "123",
      evidenceDigest: EVIDENCE_DIGEST,
    };
    function makeBridge(
      metadataChanges: Partial<TreasuryStagingMetadata> = {},
      observedChanges: Partial<JournalObservedStaging> = {}
    ) {
      const returnedMetadata = { ...metadata, ...metadataChanges };
      const returnedObserved = { ...observed, ...observedChanges };
      return new VaultExactAttemptFundingBridge({
        metadataSource: { read: async () => returnedMetadata },
        observedStagingSource: { read: async () => returnedObserved },
        builder,
      });
    }
    const context: ExactAttemptFundingContext = {
      purpose: "prepare",
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_ID,
      requestHash: REQUEST_HASH,
      amountAtomic: PRICE,
      payTo: MERCHANT_ADDRESS,
      staging: {
        transactionId: STAGING_TXID,
        outpoint: `${STAGING_TXID}:0`,
        amountAtomic: STAGING_AMOUNT,
        evidenceDigest: EVIDENCE_DIGEST,
        fundingSource: "vault-treasury",
      },
      additionalCostCeilingAtomic: COST_CEILING,
    };
    await action({
      bridge: makeBridge(),
      context,
      request,
      metadata,
      observed,
      makeBridge,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function paymentRequiredWire(
  request: ExactTransactionPaymentRequest,
  resourceUrl: string
) {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: request.network,
        amount: request.amount,
        asset: "KAS",
        payTo: request.payTo,
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v1",
          finality: request.requiredFinality,
          ...request.reservation,
          assetKind: "native",
          assetDecimals: 8,
        },
      },
    ],
    extensions: {
      "payment-identifier": core.paymentIdentifierExtension({ required: true }),
    },
  };
}

function digest(value: string | Uint8Array) {
  return evidenceDigest(value);
}
