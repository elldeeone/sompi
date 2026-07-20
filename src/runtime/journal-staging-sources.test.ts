import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  encodePaymentRequiredHeader,
  paymentIdentifierExtension,
  stableStringify,
} from "@kaspa-x402/core";

import { Transaction, payToScriptHashScript } from "../kaspa-wasm.js";
import {
  authorizationFacts,
  authorizationFactsDigest,
} from "../purchase/contracts.js";
import {
  assertPurchaseRequestKey,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "../purchase/identity.js";
import {
  PurchaseJournal,
  TREASURY_STAGING_EVIDENCE_KIND,
} from "../purchase/journal.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { buildRedeemScript } from "../vault/template.js";
import { VaultManager, generateOwnerKey } from "../vault.js";
import { KaspaWallet } from "../wallet.js";
import { StagingKeyStore } from "../adapters/kaspa-x402/staging-key-store.js";
import {
  TREASURY_STAGING_OBSERVATION_MEDIA_TYPE,
  TREASURY_STAGING_OBSERVATION_PROFILE,
  TREASURY_STAGING_OBSERVATION_VERIFIER_ID,
  VaultTreasuryStaging,
  decodeTreasuryStagingObservationEvidence,
  decodeVaultTreasuryStagingEnvelope,
} from "../adapters/kaspa-x402/vault-treasury-staging.js";
import {
  JournalChainTreasuryMetadataSource,
  JournalTreasuryStagingObservationSource,
  createJournalTreasuryStagingMetadataSource,
} from "./journal-sources.js";

const NOW = 1_800_000_000_000;
const PRICE = "20000000";
const THRESHOLD = "10000000";
const ADDITIONAL_COST_CEILING = "30000000";
const MERCHANT_ADDRESS =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const FIXED_STAGING_PRIVATE_KEY = "01".padStart(64, "0");

test("journal sources recover the canonical staging envelope, observation, and actual fee after restart", async () => {
  await withStagingJournal(async (fixture) => {
    const metadata = await fixture.metadata.read(fixture.query);
    const envelope = decodeVaultTreasuryStagingEnvelope(fixture.preparedBytes, fixture.query);
    assert.equal(metadata.envelopeDigest, fixture.plan.payloadDigest);
    assert.equal(metadata.transactionId, fixture.plan.plannedTransactionId);
    assert.equal(metadata.outpoint, fixture.plan.expectedOutpoint);
    assert.equal(metadata.stagingAmountAtomic, fixture.plan.stagingAmountAtomic);
    assert.equal(metadata.stagingFeeAtomic, envelope.spend.feeAtomic);
    assert.equal(metadata.keyReference, envelope.stagingKey.keyReference);

    const observed = await fixture.observed.read({
      ...fixture.query,
      evidenceDigest: fixture.observationEvidenceDigest,
    });
    assert.deepEqual(observed, {
      purchaseId: fixture.purchaseId,
      paymentIdentifier: fixture.paymentIdentifier,
      transactionId: fixture.plan.plannedTransactionId,
      outpoint: fixture.plan.expectedOutpoint,
      amountAtomic: fixture.plan.stagingAmountAtomic,
      address: metadata.address,
      scriptPublicKey: metadata.scriptPublicKey,
      blockDaaScore: "9",
      evidenceDigest: fixture.observationEvidenceDigest,
    });

    const fee = await fixture.fees.actualTransactionFeeAtomic(
      fixture.feeRequest()
    );
    assert.equal(fee, envelope.spend.feeAtomic);

    const evidenceBytes = fixture.journal.readEvidence(
      fixture.observationEvidenceDigest
    );
    const evidence = decodeTreasuryStagingObservationEvidence(
      evidenceBytes,
      fixture.query
    );
    assert.equal(evidence.envelopeDigest, metadata.envelopeDigest);
    assert.equal(evidence.stagingFeeAtomic, fee);
    assert.equal(evidence.stagingScriptPublicKey, metadata.scriptPublicKey);
  });
});

test("journal source lookup and prepared material remain content-addressed and Payment-bound", async () => {
  await withStagingJournal(async (fixture) => {
    await assert.rejects(
      fixture.metadata.read({
        purchaseId: fixture.purchaseId,
        paymentIdentifier: createPaymentIdentifier(fixture.purchaseId, 2),
      }),
      /does not select exactly one durable Payment Attempt/
    );
    await assert.rejects(
      fixture.observed.read({
        ...fixture.query,
        evidenceDigest: evidenceDigest("different-staging-evidence"),
      }),
      /unavailable or differently bound/
    );

    fs.writeFileSync(
      path.join(fixture.preparedDirectory, fixture.plan.preparedRef),
      "tampered-prepared-envelope",
      { mode: 0o600 }
    );
    await assert.rejects(
      fixture.metadata.read(fixture.query),
      /digest|length|content|prepared/i
    );
  });
});

test("observed evidence is re-decoded and joined rather than trusted from its verification row", async () => {
  const cases: Array<{
    name: string;
    mutate: (facts: Record<string, unknown>) => void;
    pattern: RegExp;
  }> = [
    {
      name: "envelope",
      mutate: (facts) => {
        facts.envelopeDigest = evidenceDigest("different-envelope");
      },
      pattern: /observation envelope differs/,
    },
    {
      name: "fee",
      mutate: (facts) => {
        facts.stagingFeeAtomic = (
          BigInt(String(facts.stagingFeeAtomic)) + 1n
        ).toString();
      },
      pattern: /observation fee differs/,
    },
    {
      name: "script",
      mutate: (facts) => {
        facts.stagingScriptPublicKey = `0000${"aa".repeat(34)}`;
      },
      pattern: /observation script differs/,
    },
    {
      name: "DAA",
      mutate: (facts) => {
        facts.observedAtDaa = "01";
      },
      pattern: /DAA score must be a canonical atomic-unit integer/,
    },
  ];

  for (const candidate of cases) {
    await withStagingJournal(
      async (fixture) => {
        await assert.rejects(
          fixture.observed.read({
            ...fixture.query,
            evidenceDigest: fixture.observationEvidenceDigest,
          }),
          candidate.pattern,
          candidate.name
        );
      },
      { mutateObservationEvidence: candidate.mutate }
    );
  }
});

test("fee source rejects transaction, outpoint, amount, evidence, deadline, and cancellation substitutions", async () => {
  await withStagingJournal(async (fixture) => {
    const base = fixture.feeRequest();
    const cases: Array<{ value: typeof base; pattern: RegExp }> = [
      {
        value: { ...base, transactionId: "44".repeat(32) },
        pattern: /fee transaction differs/,
      },
      {
        value: { ...base, outpoint: `${fixture.plan.plannedTransactionId}:1` },
        pattern: /fee outpoint differs/,
      },
      {
        value: { ...base, amountAtomic: (BigInt(base.amountAtomic) + 1n).toString() },
        pattern: /fee amount differs/,
      },
      {
        value: { ...base, evidenceDigest: evidenceDigest("wrong-evidence") },
        pattern: /unavailable or differently bound|fee evidence differs/,
      },
      {
        value: { ...base, deadlineAtMs: Date.now() - 1 },
        pattern: /deadline expired/,
      },
    ];
    for (const candidate of cases) {
      await assert.rejects(
        fixture.fees.actualTransactionFeeAtomic(candidate.value),
        candidate.pattern
      );
    }

    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    await assert.rejects(
      fixture.fees.actualTransactionFeeAtomic({
        ...base,
        signal: controller.signal,
      }),
      /test cancellation/
    );
  });
});

interface StagingJournalFixture {
  journal: PurchaseJournal;
  purchaseId: PurchaseId;
  paymentIdentifier: string;
  query: { purchaseId: PurchaseId; paymentIdentifier: string };
  preparedBytes: Uint8Array;
  preparedDirectory: string;
  plan: ReturnType<PurchaseJournal["requireTreasuryStagingPlan"]>;
  observationEvidenceDigest: Sha256Digest;
  metadata: ReturnType<typeof createJournalTreasuryStagingMetadataSource>;
  observed: JournalTreasuryStagingObservationSource;
  fees: JournalChainTreasuryMetadataSource;
  feeRequest(): {
    purchaseId: PurchaseId;
    paymentIdentifier: string;
    transactionId: string;
    outpoint: string;
    amountAtomic: string;
    evidenceDigest: Sha256Digest;
    deadlineAtMs: number;
    signal: AbortSignal;
  };
}

interface StagingJournalOptions {
  mutateObservationEvidence?: (facts: Record<string, unknown>) => void;
}

async function withStagingJournal(
  action: (fixture: StagingJournalFixture) => Promise<void>,
  options: StagingJournalOptions = {}
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-journal-staging-source-"));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "purchase.sqlite");
  const evidenceDirectory = path.join(directory, "evidence");
  const preparedDirectory = path.join(directory, "prepared");
  let journal = new PurchaseJournal(filename, {
    now: () => NOW,
    evidenceDirectory,
    preparedMaterialDirectory: preparedDirectory,
  });
  const wallet = new KaspaWallet({
    networkId: "testnet-10",
    dataDir: path.join(directory, "wallet"),
  });
  const vault = new VaultManager(directory, "testnet-10");
  const created = vault.create(700_000_000n, generateOwnerKey().publicKey, 300n);
  const covenantId = "aa".repeat(32);
  const fundingTransactionId = "bb".repeat(32);
  const funded = {
    ...created,
    covenantId,
    currentOutpoint: { txid: fundingTransactionId, index: 0 },
  };
  fs.writeFileSync(
    path.join(directory, "vault", "config.json"),
    JSON.stringify(funded, null, 2),
    { mode: 0o600 }
  );
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
  (wallet as unknown as { client: () => Promise<unknown> }).client = async () => ({
    getUtxosByAddresses: async (addresses: string[]) => {
      if (addresses.length === 1 && addresses[0] === funded.address) {
        return {
          entries: [
            {
              outpoint: { transactionId: fundingTransactionId, index: 0 },
              amount: 600_000_000n,
              scriptPublicKey: vaultScript,
              blockDaaScore: 1n,
              isCoinbase: false,
              covenantId,
            },
          ],
        };
      }
      if (!submitted) return { entries: [] };
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
      submitted?.free();
      submitted = new Transaction(transaction);
      return { transactionId: String(submitted.finalize()) };
    },
  });

  try {
    const purchaseId = createPurchaseId(new Uint8Array(16).fill(0x31));
    const paymentIdentifier = createPaymentIdentifier(purchaseId, 1);
    const resource = {
      url: "https://merchant.example/resource",
      method: "GET",
    };
    const purchase = journal.createPurchase({
      id: purchaseId,
      requestKey: assertPurchaseRequestKey("test:journal-staging-source"),
      resourceUrl: resource.url,
      method: resource.method,
      resourceFingerprint: requestFingerprint(resource),
      expectedMerchantId: "merchant:test",
      expectedMerchantOrigin: "https://merchant.example",
    });
    const paymentRequirements = paymentRequiredBytes(resource.url);
    const checkoutEvidence = storeVerifiedEvidence(journal, purchaseId, {
      bytes: Buffer.from("generic-x402-offer", "utf8"),
      kind: "checkout-terms",
      profile: "test-checkout-profile",
      issuer: "merchant:test",
      verifierId: "test-checkout-verifier",
    });
    const requirementsEvidence = storeVerifiedEvidence(journal, purchaseId, {
      bytes: paymentRequirements,
      kind: "payment-requirements",
      profile: "test-payment-requirements-profile",
      issuer: "merchant:test",
      verifierId: "test-payment-requirements-verifier",
    });
    const terms = {
      merchant: {
        id: "merchant:test",
        name: "Test Merchant",
        origin: "https://merchant.example",
      },
      resourceFingerprint: purchase.resourceFingerprint,
      amountAtomic: PRICE,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: MERCHANT_ADDRESS,
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest: checkoutEvidence,
    };
    const executionPlan = journal.storeExecutionPlanEvidence(purchaseId, {
      mechanism: "single-transaction",
      profile: "kaspa-exact-v2:standard-native",
      requirementsDigest: requirementsEvidence,
      maximumChargeAtomic: PRICE,
      settlementAssurance: "accepted",
    });
    journal.bindCheckoutTerms(purchaseId, {
      terms,
      checkoutEvidenceDigest: checkoutEvidence,
      checkoutVerificationProfile: "test-checkout-profile",
      checkoutVerifierId: "test-checkout-verifier",
      paymentRequirementsDigest: requirementsEvidence,
      paymentRequirementsVerificationProfile: "test-payment-requirements-profile",
      paymentRequirementsVerifierId: "test-payment-requirements-verifier",
      executionPlan: executionPlan.plan,
      executionPlanEvidenceDigest: executionPlan.evidenceDigest,
    });
    const requestBody = journal.storeEvidence(purchaseId, {
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream",
      profile: "urn:sompi:purchase-request-body:1",
      issuer: "purchase-intent",
      kind: "purchase-request-body",
    });
    const requestDigest = storeVerifiedEvidence(journal, purchaseId, {
      bytes: Buffer.from("authorization-request", "utf8"),
      kind: "authorization-request",
      profile: "test-authorization-request-profile",
      issuer: "sompi-mcp:test",
      verifierId: "test-authorization-request-verifier",
    });
    const nonceDigest = evidenceDigest("authority-nonce");
    const expiresAtMs = Date.parse(terms.expiresAt);
    journal.recordAuthorizationRequest(purchaseId, {
      checkoutDigest: terms.checkoutDigest,
      requestDigest,
      nonceDigest,
      requestMediaType: "",
      requestBodyDigest: requestBody.digest,
      additionalCostCeilingAtomic: ADDITIONAL_COST_CEILING,
      effectiveFinalityFloor: "accepted",
      expiresAtMs,
    });
    const storedAuthorizationRequest = journal.requireAuthorizationRequest(purchaseId);
    const authorizationRequest = {
      purchaseId,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      requestMediaType: "",
      requestBodyDigest: requestBody.digest,
      terms,
      requestDigest,
      nonceDigest,
      additionalCostCeilingAtomic: ADDITIONAL_COST_CEILING,
      effectiveFinalityFloor: "accepted" as const,
      executionPlanDigest: storedAuthorizationRequest.executionPlanDigest,
      executionMechanism: storedAuthorizationRequest.executionMechanism,
      executionProfile: storedAuthorizationRequest.executionProfile,
      settlementAssurance: storedAuthorizationRequest.settlementAssurance,
      maximumAuthorizedChargeAtomic: storedAuthorizationRequest.maximumAuthorizedChargeAtomic,
      createdAtMs: storedAuthorizationRequest.createdAtMs,
      expiresAtMs,
    };
    const authorizationEvidence = storeVerifiedEvidence(journal, purchaseId, {
      bytes: Buffer.from("authority-decision", "utf8"),
      kind: "purchase-authorization",
      profile: "test-authorization-profile",
      issuer: "authority:test",
      verifierId: "test-authorization-verifier",
    });
    journal.recordAuthorizationDecision(purchaseId, {
      decision: "approved",
      authorityId: "authority:test",
      checkoutDigest: terms.checkoutDigest,
      approvedFactsDigest: authorizationFactsDigest(authorizationRequest),
      evidenceDigest: authorizationEvidence,
      verificationProfile: "test-authorization-profile",
      verifierId: "test-authorization-verifier",
      requestDigest,
      nonceDigest,
      expiresAtMs,
    });
    const policy = journal.installPolicy({
      maxPerPaymentAtomic: "1000000000",
      maxPerHourAtomic: "10000000000",
      allowlist: [MERCHANT_ADDRESS],
    });
    const reservation = journal.reservePolicy({
      id: "journal-staging-reservation",
      purchaseId,
      policyDigest: policy.digest,
      approvalEvidenceDigest: authorizationEvidence,
      approvalVerificationProfile: "test-authorization-profile",
      approvalVerifierId: "test-authorization-verifier",
      payee: MERCHANT_ADDRESS,
      amountAtomic: PRICE,
      additionalCostCeilingAtomic: ADDITIONAL_COST_CEILING,
      fundingSource: "vault-treasury",
      expiresAtMs: NOW + 60_000,
    });
    journal.createPaymentAttempt({
      purchaseId,
      attempt: 1,
      identifier: paymentIdentifier,
    });

    const keyStore = new StagingKeyStore({
      directory: path.join(directory, "staging-keys"),
      now: () => NOW,
      generatePrivateKey: () => FIXED_STAGING_PRIVATE_KEY,
    });
    const staging = new VaultTreasuryStaging({
      vault, wallet, keyStore,
      chainEvidence: {
        observe: async (request: any) => ({
          status: "present", level: "accepted", view: "current",
          detailDigest: evidenceDigest(`chain:${request.transactionId}`),
          acceptingBlockDaaScore: "9", observedAtMs: NOW,
        }),
      },
      finalityFloor: "accepted",
    });
    const execution = {
      purchaseId,
      terms,
      authorizationRequest,
      authorization: {
        purchaseId,
        checkoutDigest: terms.checkoutDigest,
        decision: "approved" as const,
        authorityId: "authority:test",
        evidenceDigest: authorizationEvidence,
        facts: authorizationFacts(authorizationRequest),
      },
      paymentIdentifier,
    };
    const request = {
      url: purchase.resourceUrl,
      method: purchase.method,
      body: new Uint8Array(),
      requestFingerprint: purchase.resourceFingerprint,
    };
    const prepared = await staging.prepare({
      execution,
      request,
      paymentRequirements,
      additionalCostCeilingAtomic: ADDITIONAL_COST_CEILING,
    });
    const plan = journal.planTreasuryStaging({
      purchaseId,
      attempt: 1,
      reservationId: reservation.id,
      idempotencyKey: `treasury-staging:${paymentIdentifier}`,
      payloadDigest: prepared.preparedDigest,
      preparedBytes: prepared.preparedBytes,
      plannedTransactionId: prepared.transactionId,
      expectedOutpoint: prepared.expectedOutpoint,
      stagingAmountAtomic: prepared.stagingAmountAtomic,
      fundingSource: prepared.fundingSource,
    });
    journal.transitionPurchase(
      purchaseId,
      "authorised",
      "execution_prepared",
      "treasury_staging_prepared",
      prepared.preparedDigest
    );
    const claim = journal.beginTreasuryStaging(
      plan.effectId,
      reservation.id,
      "runtime-source-test",
      60_000
    );
    assert.ok(claim);
    const staged = await staging.submit({
      context: {
        execution,
        request,
        paymentRequirements,
        staging: {
          preparedBytes: prepared.preparedBytes,
          preparedDigest: prepared.preparedDigest,
          transactionId: prepared.transactionId,
          expectedOutpoint: prepared.expectedOutpoint,
          amountAtomic: prepared.stagingAmountAtomic,
          fundingSource: prepared.fundingSource,
        },
      },
      effect: claim.effect,
      signal: new AbortController().signal,
    });
    assert.equal(staged.status, "staged");
    if (staged.status !== "staged") throw new Error("expected staged output");
    let observationBytes = Uint8Array.from(staged.staging.evidence.bytes);
    if (options.mutateObservationEvidence) {
      const facts = JSON.parse(Buffer.from(observationBytes).toString("utf8")) as Record<string, unknown>;
      options.mutateObservationEvidence(facts);
      observationBytes = Buffer.from(stableStringify(facts), "utf8");
    }
    const observationEvidence = journal.storeEvidence(purchaseId, {
      bytes: observationBytes,
      mediaType: TREASURY_STAGING_OBSERVATION_MEDIA_TYPE,
      profile: TREASURY_STAGING_OBSERVATION_PROFILE,
      issuer: TREASURY_STAGING_OBSERVATION_VERIFIER_ID,
      kind: TREASURY_STAGING_EVIDENCE_KIND,
      attempt: 1,
    });
    journal.recordEvidenceVerification(observationEvidence.digest, {
      verifierId: TREASURY_STAGING_OBSERVATION_VERIFIER_ID,
      profile: TREASURY_STAGING_OBSERVATION_PROFILE,
      detailDigest: evidenceDigest("runtime-source-test-verification"),
    });
    journal.recordObservedTreasuryStaging(claim.lease, {
      effectId: plan.effectId,
      reservationId: reservation.id,
      transactionId: prepared.transactionId,
      outpoint: prepared.expectedOutpoint,
      stagingAmountAtomic: prepared.stagingAmountAtomic,
      fundingSource: prepared.fundingSource,
      evidenceDigest: observationEvidence.digest,
      evidenceVerificationProfile: TREASURY_STAGING_OBSERVATION_PROFILE,
      evidenceVerifierId: TREASURY_STAGING_OBSERVATION_VERIFIER_ID,
    });

    journal.close();
    journal = new PurchaseJournal(filename, {
      now: () => NOW,
      evidenceDirectory,
      preparedMaterialDirectory: preparedDirectory,
    });
    const metadata = createJournalTreasuryStagingMetadataSource(journal);
    const observed = new JournalTreasuryStagingObservationSource(journal, metadata);
    const fees = new JournalChainTreasuryMetadataSource(metadata, observed);
    const query = Object.freeze({ purchaseId, paymentIdentifier });
    await action({
      journal,
      purchaseId,
      paymentIdentifier,
      query,
      preparedBytes: Uint8Array.from(prepared.preparedBytes),
      preparedDirectory,
      plan: journal.requireTreasuryStagingPlan(purchaseId, 1),
      observationEvidenceDigest: observationEvidence.digest,
      metadata,
      observed,
      fees,
      feeRequest() {
        return {
          purchaseId,
          paymentIdentifier,
          transactionId: prepared.transactionId,
          outpoint: prepared.expectedOutpoint,
          amountAtomic: prepared.stagingAmountAtomic,
          evidenceDigest: observationEvidence.digest,
          deadlineAtMs: Date.now() + 60_000,
          signal: new AbortController().signal,
        };
      },
    });
  } finally {
    journal.close();
    submitted?.free();
    vaultScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function storeVerifiedEvidence(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  input: {
    bytes: Uint8Array;
    kind: string;
    profile: string;
    issuer: string;
    verifierId: string;
    attempt?: number;
  }
): Sha256Digest {
  const attachment = journal.storeEvidence(purchaseId, {
    bytes: input.bytes,
    mediaType: "application/octet-stream",
    profile: input.profile,
    issuer: input.issuer,
    kind: input.kind,
    attempt: input.attempt,
  });
  journal.recordEvidenceVerification(attachment.digest, {
    verifierId: input.verifierId,
    profile: input.profile,
    detailDigest: evidenceDigest(`verified:${input.kind}`),
  });
  return attachment.digest;
}

function paymentRequiredBytes(resourceUrl: string): Buffer {
  return Buffer.from(
    encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: resourceUrl, mimeType: "application/octet-stream" },
      accepts: [
        {
          scheme: "exact",
          network: "kaspa:testnet-10",
          amount: PRICE,
          asset: "KAS",
          payTo: MERCHANT_ADDRESS,
          maxTimeoutSeconds: 60,
          extra: {
            binding: "kaspa-exact-v2",
            profile: "standard-native",
            finality: "accepted",
            transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
            payToScriptPublicKey: "000051",
            assetKind: "native",
            assetDecimals: 8,
          },
        },
      ],
      extensions: {
        "payment-identifier": paymentIdentifierExtension({ required: true }),
      },
    } as never),
    "ascii"
  );
}
