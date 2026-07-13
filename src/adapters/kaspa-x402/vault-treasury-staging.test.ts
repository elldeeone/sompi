import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { encodePaymentRequiredHeader, paymentIdentifierExtension, stableStringify } from "@kaspa-x402/core";

import { Transaction, payToScriptHashScript } from "../../kaspa-wasm.js";
import {
  assertPurchaseId,
  createPaymentIdentifier,
  evidenceDigest,
} from "../../purchase/identity.js";
import { buildRedeemScript } from "../../vault/template.js";
import { VaultManager, generateOwnerKey } from "../../vault.js";
import { KaspaWallet } from "../../wallet.js";
import { StagingKeyStore } from "./staging-key-store.js";
import {
  CanonicalTreasuryStagingMetadataSource,
  VaultTreasuryStaging,
  decodeTreasuryStagingObservationEvidence,
  decodeVaultTreasuryStagingEnvelope,
} from "./vault-treasury-staging.js";

const PURCHASE_ID = assertPurchaseId("pur_AQEBAQEBAQEBAQEBAQEBAQ");
const PAYMENT_ID = createPaymentIdentifier(PURCHASE_ID, 1);
const MERCHANT_ADDRESS =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const PRICE = "20000000";
const THRESHOLD = "10000000";
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const FIXED_STAGING_PRIVATE_KEY = "01".padStart(64, "0");

test("vault staging converges inside the complete cost cap and exposes canonical public metadata", async () => {
  await withFixture(async (fixture) => {
    const input = fixture.prepareInput("30000000");
    const prepared = await fixture.staging.prepare(input);
    const envelope = decodeVaultTreasuryStagingEnvelope(prepared.preparedBytes, {
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_ID,
    });
    const total = BigInt(envelope.spend.amountAtomic) + BigInt(envelope.spend.feeAtomic);
    assert.ok(total <= BigInt(PRICE) + 30_000_000n);
    assert.ok(BigInt(envelope.spend.amountAtomic) >= 32_000_000n);
    const exactChange = BigInt(envelope.spend.amountAtomic) - 32_000_000n;
    assert.ok(exactChange === 0n || exactChange >= 10_000_000n);
    assert.equal(envelope.spend.destination, envelope.stagingKey.address);
    assert.equal(envelope.spend.destinationOutpoint.index, 0);
    assert.equal(envelope.spend.transactionId, prepared.transactionId);
    assert.equal(envelope.binding.additionalCostCeilingAtomic, "30000000");
    assert.equal(envelope.binding.additiveThresholdAtomic, THRESHOLD);

    const text = Buffer.from(prepared.preparedBytes).toString("utf8");
    assert.equal(stableStringify(JSON.parse(text)), text);
    assert.equal(text.includes(FIXED_STAGING_PRIVATE_KEY), false);
    assert.equal(text.includes("privateKey"), false);

    const source = new CanonicalTreasuryStagingMetadataSource({
      readPreparedEnvelope: async () => prepared.preparedBytes,
    });
    const metadata = await source.read({
      purchaseId: PURCHASE_ID,
      paymentIdentifier: PAYMENT_ID,
    });
    assert.equal(metadata.stagingFeeAtomic, envelope.spend.feeAtomic);
    assert.equal(metadata.outpoint, `${prepared.transactionId}:0`);
    assert.equal(metadata.keyReference, envelope.stagingKey.keyReference);

    const replay = await fixture.staging.prepare(input);
    const replayEnvelope = decodeVaultTreasuryStagingEnvelope(replay.preparedBytes);
    assert.equal(replayEnvelope.stagingKey.keyReference, envelope.stagingKey.keyReference);
    assert.equal(replayEnvelope.stagingKey.publicKey, envelope.stagingKey.publicKey);
  });
});

test("actual staging fee and signed transaction cap are fail-closed", async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      fixture.staging.prepare(fixture.prepareInput("12000000")),
      /actual vault staging fee exceeds|authorized additional-cost ceiling/
    );

    const prepared = await fixture.staging.prepare(fixture.prepareInput("30000000"));
    const changed = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
    changed.spend.feeAtomic = (BigInt(changed.spend.feeAtomic) + 1n).toString();
    const tampered = Buffer.from(stableStringify(changed), "utf8");
    assert.throws(
      () => decodeVaultTreasuryStagingEnvelope(tampered),
      /declared staging fee does not equal the signed transaction fee/
    );

    changed.spend.feeAtomic = (BigInt(changed.spend.feeAtomic) - 1n).toString();
    changed.binding.additionalCostCeilingAtomic = "10000000";
    const narrowed = Buffer.from(stableStringify(changed), "utf8");
    assert.throws(
      () => decodeVaultTreasuryStagingEnvelope(narrowed),
      /outside its authorized exact-payment bounds|cannot fund/
    );
  });
});

test("restart submits exact prepared bytes, observes both outputs, and commits idempotently", async () => {
  await withFixture(async (fixture) => {
    const input = fixture.prepareInput("30000000");
    const prepared = await fixture.staging.prepare(input);
    const context = fixture.context(input, prepared);

    const restarted = new VaultTreasuryStaging({
      vault: fixture.vault,
      wallet: fixture.wallet,
      keyStore: fixture.keyStore,
      chainEvidence: fixture.chainEvidence,
      finalityFloor: "accepted",
    });
    const submitted = await restarted.submit({
      context,
      effect: fixture.effect(prepared.preparedDigest),
      signal: new AbortController().signal,
    });
    assert.equal(submitted.status, "submitted");
    assert.equal(fixture.submitCount(), 1);
    assert.equal(fixture.vault.config().currentOutpoint?.txid, fixture.fundingTxid);

    const pending = await restarted.observe({
      context,
      effect: { ...fixture.effect(prepared.preparedDigest), state: "ambiguous" },
    });
    assert.equal(pending.status, "pending");
    assert.equal(fixture.submitCount(), 1, "observe must never rebroadcast");

    fixture.makeVisible();
    const staged = await restarted.observe({
      context,
      effect: { ...fixture.effect(prepared.preparedDigest), state: "submitted" },
    });
    assert.equal(staged.status, "staged");
    if (staged.status !== "staged") throw new Error("expected observed staging");
    assert.equal(staged.staging.transactionId, prepared.transactionId);
    assert.equal(staged.staging.outpoint, prepared.expectedOutpoint);
    assert.equal(
      staged.staging.evidence.declaredDigest,
      evidenceDigest(staged.staging.evidence.bytes)
    );
    const evidence = JSON.parse(Buffer.from(staged.staging.evidence.bytes).toString("utf8"));
    assert.equal(evidence.stagingScriptPublicKey, decodeVaultTreasuryStagingEnvelope(prepared.preparedBytes).stagingKey.scriptPublicKey);
    assert.equal(evidence.observedAtDaa, "9");
    const decodedEvidence = decodeTreasuryStagingObservationEvidence(
      staged.staging.evidence.bytes,
      { purchaseId: PURCHASE_ID, paymentIdentifier: PAYMENT_ID }
    );
    assert.equal(decodedEvidence.stagingOutpoint, prepared.expectedOutpoint);
    assert.equal(decodedEvidence.stagingFeeAtomic, decodeVaultTreasuryStagingEnvelope(prepared.preparedBytes).spend.feeAtomic);
    assert.equal(fixture.vault.config().currentOutpoint?.txid, prepared.transactionId);

    const again = await restarted.observe({
      context,
      effect: { ...fixture.effect(prepared.preparedDigest), state: "submitted" },
    });
    assert.equal(again.status, "staged");
    const recoveredSubmit = await restarted.submit({
      context,
      effect: fixture.effect(prepared.preparedDigest),
      signal: new AbortController().signal,
    });
    assert.equal(recoveredSubmit.status, "staged");
    assert.equal(fixture.submitCount(), 1, "an observed transaction must not be blindly resubmitted");
  });
});

test("submission rejects canonical envelope and immutable-context substitutions before RPC", async () => {
  await withFixture(async (fixture) => {
    const input = fixture.prepareInput("30000000");
    const prepared = await fixture.staging.prepare(input);
    const original = fixture.context(input, prepared);
    const parsed = JSON.parse(Buffer.from(prepared.preparedBytes).toString("utf8"));
    parsed.binding.paymentIdentifier = createPaymentIdentifier(PURCHASE_ID, 2);
    const changedBytes = Buffer.from(stableStringify(parsed), "utf8");
    await assert.rejects(
      fixture.staging.submit({
        context: {
          ...original,
          staging: {
            ...original.staging,
            preparedBytes: changedBytes,
            preparedDigest: evidenceDigest(changedBytes),
          },
        },
        effect: fixture.effect(evidenceDigest(changedBytes)),
        signal: new AbortController().signal,
      }),
      /different Purchase or Payment Attempt|public staging key/
    );

    await assert.rejects(
      fixture.staging.submit({
        context: {
          ...original,
          staging: { ...original.staging, amountAtomic: "32000001" },
        },
        effect: fixture.effect(prepared.preparedDigest),
        signal: new AbortController().signal,
      }),
      /staging amount does not match/
    );
    assert.equal(fixture.submitCount(), 0);
  });
});

interface Fixture {
  staging: VaultTreasuryStaging;
  vault: VaultManager;
  wallet: KaspaWallet;
  keyStore: StagingKeyStore;
  chainEvidence: any;
  fundingTxid: string;
  prepareInput(additionalCostCeilingAtomic: string): any;
  context(input: any, prepared: any): any;
  effect(payloadDigest: string): any;
  makeVisible(): void;
  submitCount(): number;
}

async function withFixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-staging-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({
    networkId: "testnet-10",
    dataDir: path.join(directory, "wallet"),
  });
  const vault = new VaultManager(directory, "testnet-10");
  const created = vault.create(700_000_000n, generateOwnerKey().publicKey, 300n);
  const covenantId = "aa".repeat(32);
  const fundingTxid = "bb".repeat(32);
  const funded = {
    ...created,
    covenantId,
    currentOutpoint: { txid: fundingTxid, index: 0 },
  };
  fs.writeFileSync(
    path.join(directory, "vault", "config.json"),
    JSON.stringify(funded, null, 2),
    { mode: 0o600 }
  );
  const vaultAmount = 600_000_000n;
  const vaultScript = payToScriptHashScript(
    buildRedeemScript(
      funded.agentPublic,
      funded.ownerPublic,
      BigInt(funded.maxOutflowSompi),
      BigInt(funded.windowSizeDaa),
      {
        windowStartDaa: BigInt(funded.windowStartDaa),
        spentInWindowSompi: BigInt(funded.spentInWindowSompi),
      }
    )
  );
  let submitted: Transaction | undefined;
  let visible = false;
  let submits = 0;
  (wallet as any).client = async () => ({
    getUtxosByAddresses: async (addresses: string[]) => {
      if (addresses.length === 1 && addresses[0] === funded.address) {
        return {
          entries: [
            {
              outpoint: { transactionId: fundingTxid, index: 0 },
              amount: vaultAmount,
              scriptPublicKey: vaultScript,
              blockDaaScore: 1n,
              isCoinbase: false,
              covenantId,
            },
          ],
        };
      }
      if (!submitted || !visible) return { entries: [] };
      const transactionId = String(submitted.finalize());
      return {
        entries: [
          {
            outpoint: { transactionId, index: 0 },
            amount: submitted.outputs[0].value,
            scriptPublicKey: submitted.outputs[0].scriptPublicKey,
            blockDaaScore: 9n,
            isCoinbase: false,
          },
          {
            outpoint: { transactionId, index: 1 },
            amount: submitted.outputs[1].value,
            scriptPublicKey: submitted.outputs[1].scriptPublicKey,
            blockDaaScore: 9n,
            isCoinbase: false,
            covenantId,
          },
        ],
      };
    },
    getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
    getServerInfo: async () => ({ virtualDaaScore: "100" }),
    submitTransaction: async ({ transaction }: { transaction: Transaction }) => {
      submits += 1;
      submitted?.free();
      submitted = new Transaction(transaction);
      return { transactionId: String(submitted.finalize()) };
    },
  });
  const keyStore = new StagingKeyStore({
    directory: path.join(directory, "staging-keys"),
    now: () => NOW,
    generatePrivateKey: () => FIXED_STAGING_PRIVATE_KEY,
  });
  const chainEvidence = {
    async observe(request: any) {
      if (!visible) return { status: "absent" as const, detailDigest: evidenceDigest("absent"), observedAtMs: NOW };
      return {
        status: "present" as const, level: "accepted" as const, view: "current" as const,
        detailDigest: evidenceDigest(`accepted:${request.transactionId}`),
        acceptingBlockDaaScore: "9", observedAtMs: NOW,
      };
    },
  };
  const staging = new VaultTreasuryStaging({ vault, wallet, keyStore, chainEvidence, finalityFloor: "accepted" });
  const checkoutDigest = evidenceDigest("checkout");
  const requestFingerprint = evidenceDigest("request");
  const authorizationEvidenceDigest = evidenceDigest("authorization");
  const terms = {
    merchant: {
      id: "merchant:test",
      name: "Test Merchant",
      origin: "https://merchant.example",
    },
    resourceFingerprint: requestFingerprint,
    amountAtomic: PRICE,
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: MERCHANT_ADDRESS,
    expiresAt: "2099-01-01T00:00:00.000Z",
    checkoutDigest,
  };

  function prepareInput(additionalCostCeilingAtomic: string) {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://merchant.example/resource", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: "kaspa:testnet-10",
          amount: PRICE,
          asset: "KAS",
          payTo: MERCHANT_ADDRESS,
          maxTimeoutSeconds: 60,
          extra: {
            binding: "kaspa-exact-v1",
            finality: "accepted",
            templateId: "kaspa-x402-kip10-additive-v1",
            transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
            borrowOutpoint: { txid: "22".repeat(32), index: 0 },
            borrowAmount: "100000000",
            borrowScriptPublicKey: "000051",
            borrowRedeemScript: "51",
            additiveThresholdSompi: THRESHOLD,
            paymentOutputIndex: 1,
            reservationId: "33".repeat(32),
            reservationExpiresAt: "2099-01-01T00:00:00.000Z",
            assetKind: "native",
            assetDecimals: 8,
          },
        },
      ],
      extensions: {
        "payment-identifier": paymentIdentifierExtension({ required: true }),
      },
    };
    const facts = {
      purchaseId: PURCHASE_ID,
      resourceFingerprint: requestFingerprint,
      amountAtomic: PRICE,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: MERCHANT_ADDRESS,
    };
    return {
      execution: {
        purchaseId: PURCHASE_ID,
        terms,
        authorizationRequest: {
          purchaseId: PURCHASE_ID,
          terms,
          additionalCostCeilingAtomic,
        },
        authorization: {
          purchaseId: PURCHASE_ID,
          checkoutDigest,
          decision: "approved",
          evidenceDigest: authorizationEvidenceDigest,
          facts,
        },
        paymentIdentifier: PAYMENT_ID,
      },
      request: {
        requestFingerprint,
      },
      paymentRequirements: Buffer.from(
        encodePaymentRequiredHeader(paymentRequired as any),
        "ascii"
      ),
      additionalCostCeilingAtomic,
    };
  }

  try {
    await action({
      staging,
      vault,
      wallet,
      keyStore,
      chainEvidence,
      fundingTxid,
      prepareInput,
      context(input, prepared) {
        return {
          execution: input.execution,
          request: input.request,
          paymentRequirements: input.paymentRequirements,
          staging: {
            preparedBytes: prepared.preparedBytes,
            preparedDigest: prepared.preparedDigest,
            transactionId: prepared.transactionId,
            expectedOutpoint: prepared.expectedOutpoint,
            amountAtomic: prepared.stagingAmountAtomic,
            fundingSource: prepared.fundingSource,
          },
        };
      },
      effect(payloadDigest) {
        return {
          id: "effect-staging",
          purchaseId: PURCHASE_ID,
          attempt: 1,
          kind: "treasury-staging",
          idempotencyKey: `treasury-staging:${PAYMENT_ID}`,
          state: "executing",
          version: 0,
          payloadDigest,
          preparedRef: payloadDigest,
          preparedByteLength: 1,
          createdAtMs: NOW,
          updatedAtMs: NOW,
        };
      },
      makeVisible() {
        visible = true;
      },
      submitCount() {
        return submits;
      },
    });
  } finally {
    submitted?.free();
    vaultScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
