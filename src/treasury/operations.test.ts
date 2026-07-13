import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { authorizationFactsDigest } from "../purchase/contracts.js";
import {
  assertPurchaseRequestKey,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "../purchase/identity.js";
import {
  PolicyReservationError,
  PurchaseJournal,
  type PolicySnapshotRecord,
} from "../purchase/journal.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import { PolicyEngine } from "../policy.js";
import type {
  PreparedTreasuryOperationMaterial,
  TreasuryOperationKind,
  TreasuryOperationRecord,
} from "./operation-journal.js";
import type {
  TreasuryOperationAdapter,
  TreasuryOperationProbe,
} from "./operation-adapters.js";
import { TreasuryOperationModule } from "./operations.js";

const NOW = 1_900_000_000_000;
const DESTINATION = "kaspatest:merchant";

test("direct Treasury execution persists intent and signed bytes before one submission", async () => {
  await withFixture(async ({ journal, module, wallet }) => {
    wallet.onSubmit = (intent) => {
      assert.equal(journal.requireTreasuryOperation(intent.operationKey).state, "submission_planned");
      assert.match(
        journal.readPreparedTreasuryOperation(intent.operationKey).toString("utf8"),
        /immutable/
      );
    };
    wallet.probes.push(observed(wallet.transactionId));
    const completed = await module.execute({
      operationKey: "direct:wallet:one",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(completed.state, "completed");
    assert.equal(wallet.submitCalls, 1);
    assert.equal(wallet.commitCalls, 1);
    assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);

    const replay = await module.execute({
      operationKey: "direct:wallet:one",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(replay.state, "completed");
    assert.equal(wallet.submitCalls, 1);
    await assert.rejects(
      module.execute({
        operationKey: "direct:wallet:one",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "101",
      }),
      /different immutable intent/
    );
  });
});

test("ambiguous submission stays pending and retries only after exact non-submission proof", async () => {
  await withFixture(async ({ module, wallet }) => {
    wallet.submitErrors = 1;
    wallet.probes.push(pending(wallet.transactionId), pending(wallet.transactionId));
    const first = await module.execute({
      operationKey: "direct:wallet:ambiguous",
      kind: "wallet_send",
      destination: DESTINATION,
      amountAtomic: "100",
    });
    assert.equal(first.state, "submission_planned");
    assert.equal(first.recoveryRequired, true);
    assert.equal(wallet.submitCalls, 1);

    const stillPending = await module.recover("direct:wallet:ambiguous");
    assert.equal(stillPending.state, "submission_planned");
    assert.equal(wallet.submitCalls, 1, "pending observation must never rebroadcast");

    wallet.probes.push(notSubmitted(wallet.transactionId), observed(wallet.transactionId));
    const recovered = await module.recover("direct:wallet:ambiguous");
    assert.equal(recovered.state, "completed");
    assert.equal(recovered.retryCount, 1);
    assert.equal(wallet.submitCalls, 2);
    assert.equal(new Set(wallet.submittedArtifacts).size, 1, "retry must reuse exact signed bytes");
  });
});

test("observed fact survives a local commit crash without observation or submission replay", async () => {
  await withFixture(async ({ journal, module, vault }) => {
    vault.probes.push(observed(vault.transactionId));
    vault.commitErrors = 1;
    await assert.rejects(
      module.execute({
        operationKey: "direct:vault:commit-crash",
        kind: "vault_send",
        destination: DESTINATION,
        amountAtomic: "100",
      }),
      /injected commit crash/
    );
    assert.equal(journal.requireTreasuryOperation("direct:vault:commit-crash").state, "observed");
    assert.equal(vault.submitCalls, 1);
    assert.equal(vault.observeCalls, 1);

    const recovered = await module.recover("direct:vault:commit-crash");
    assert.equal(recovered.state, "completed");
    assert.equal(vault.submitCalls, 1);
    assert.equal(vault.observeCalls, 1);
    assert.equal(vault.commitCalls, 2);
  });
});

test("direct and Purchase reservations share one transactional hourly capacity", async () => {
  await withFixture(
    async ({ directory, journal, policy, wallet, vault, deposit }) => {
      wallet.prepareErrors = 1;
      const module = new TreasuryOperationModule({
        journal,
        policy,
        adapters: [wallet, vault, deposit],
        feeCeilingAtomic: "10",
      });
      await assert.rejects(
        module.execute({
          operationKey: "direct:capacity:first",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "590",
        }),
        /injected prepare crash/
      );
      assert.equal(journal.treasuryPolicyCapacityUsed(), 600n);

      const purchaseId = authorizedPurchase(journal, 71, "390");
      const snapshot = journal.requireActivePolicy();
      reservePurchase(journal, purchaseId, snapshot, "res_combined_exact", "390", "10");
      assert.equal(journal.treasuryPolicyCapacityUsed(), 1_000n);

      const otherHandle = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
        now: () => NOW,
      });
      try {
        const otherPurchase = authorizedPurchase(otherHandle, 72, "1");
        assert.throws(
          () => reservePurchase(otherHandle, otherPurchase, snapshot, "res_combined_over", "1", "0"),
          PolicyReservationError
        );
      } finally {
        otherHandle.close();
      }
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("Purchase capacity blocks a direct operation before signing or submission", async () => {
  await withFixture(
    async ({ journal, module, wallet }) => {
      const purchaseId = authorizedPurchase(journal, 73, "600");
      reservePurchase(journal, purchaseId, journal.requireActivePolicy(), "res_purchase_first", "600", "10");
      await assert.rejects(
        module.execute({
          operationKey: "direct:capacity:blocked",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "400",
        }),
        PolicyReservationError
      );
      assert.equal(wallet.prepareCalls, 0);
      assert.equal(wallet.submitCalls, 0);
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("fee ceiling is reserved before signing", async () => {
  await withFixture(
    async ({ module, wallet }) => {
      await assert.rejects(
        module.execute({
          operationKey: "direct:fee:blocked",
          kind: "wallet_send",
          destination: DESTINATION,
          amountAtomic: "100",
        }),
        PolicyReservationError
      );
      assert.equal(wallet.prepareCalls, 0);
      assert.equal(wallet.submitCalls, 0);
    },
    { maxPerPaymentAtomic: "105", maxPerHourAtomic: "105" }
  );
});

test("the full fee ceiling is visible to Purchase reservations before adapter preparation", async () => {
  await withFixture(
    async ({ journal, module, wallet }) => {
      wallet.onPrepare = () => {
        assert.equal(journal.treasuryPolicyCapacityUsed(), 110n);
        const purchaseId = authorizedPurchase(journal, 74, "881");
        assert.throws(
          () => reservePurchase(
            journal,
            purchaseId,
            journal.requireActivePolicy(),
            "res_fee_race",
            "881",
            "10"
          ),
          PolicyReservationError
        );
      };
      wallet.probes.push(observed(wallet.transactionId));
      const completed = await module.execute({
        operationKey: "direct:fee:race",
        kind: "wallet_send",
        destination: DESTINATION,
        amountAtomic: "100",
      });
      assert.equal(completed.state, "completed");
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("vault deposit principal is audited but only its bounded fee consumes spend capacity", async () => {
  await withFixture(
    async ({ journal, module, deposit }) => {
      deposit.probes.push(observed(deposit.transactionId));
      const completed = await module.execute({
        operationKey: "direct:vault:deposit",
        kind: "vault_deposit",
        destination: DESTINATION,
        amountAtomic: "max",
        keepFloatAtomic: "20",
      });
      assert.equal(completed.state, "completed");
      assert.equal(completed.amountAtomic, "100", "moved principal remains an audited fact");
      assert.equal(journal.treasuryPolicyCapacityUsed(), 10n, "only actual deposit fee consumes capacity");

      const purchaseId = authorizedPurchase(journal, 75, "980");
      reservePurchase(
        journal,
        purchaseId,
        journal.requireActivePolicy(),
        "res_after_deposit",
        "980",
        "10"
      );
      assert.equal(journal.treasuryPolicyCapacityUsed(), 1_000n);
    },
    { maxPerPaymentAtomic: "1000", maxPerHourAtomic: "1000" }
  );
});

test("vault send maximum is rejected before intent or signing", async () => {
  await withFixture(async ({ journal, module, vault }) => {
    await assert.rejects(
      module.execute({
        operationKey: "direct:vault:max-disabled",
        kind: "vault_send",
        destination: DESTINATION,
        amountAtomic: "max",
      }),
      /require an exact amount/
    );
    assert.equal(vault.prepareCalls, 0);
    assert.throws(
      () => journal.requireTreasuryOperation("direct:vault:max-disabled"),
      /does not exist/
    );
  });
});

class FakeAdapter implements TreasuryOperationAdapter {
  readonly transactionId: string;
  prepareCalls = 0;
  submitCalls = 0;
  observeCalls = 0;
  commitCalls = 0;
  prepareErrors = 0;
  submitErrors = 0;
  commitErrors = 0;
  feeAtomic = "10";
  readonly probes: TreasuryOperationProbe[] = [];
  readonly submittedArtifacts: string[] = [];
  onSubmit?: (intent: TreasuryOperationRecord) => void;
  onPrepare?: (intent: TreasuryOperationRecord) => void;

  constructor(readonly kind: TreasuryOperationKind, txByte: string) {
    this.transactionId = txByte.repeat(64);
  }

  async prepare(
    intent: TreasuryOperationRecord,
    authorize: (destination: string, amountAtomic: bigint) => void
  ): Promise<PreparedTreasuryOperationMaterial> {
    this.prepareCalls += 1;
    if (this.prepareErrors-- > 0) throw new Error("injected prepare crash");
    this.onPrepare?.(intent);
    const amount = intent.requestedAmountAtomic === "max" ? 100n : BigInt(intent.requestedAmountAtomic);
    if (this.kind !== "vault_deposit") authorize(intent.destination, amount);
    return {
      bytes: Buffer.from(`immutable:${intent.operationKey}:${this.transactionId}`, "utf8"),
      transactionId: this.transactionId,
      amountAtomic: amount.toString(),
      feeAtomic: this.feeAtomic,
    };
  }

  async submit(
    intent: TreasuryOperationRecord,
    preparedBytes: Uint8Array
  ): Promise<{ readonly transactionId: string }> {
    this.submitCalls += 1;
    this.onSubmit?.(intent);
    this.submittedArtifacts.push(Buffer.from(preparedBytes).toString("base64"));
    if (this.submitErrors-- > 0) throw new Error("injected ambiguous submission");
    return { transactionId: this.transactionId };
  }

  async observe(): Promise<TreasuryOperationProbe> {
    this.observeCalls += 1;
    return this.probes.shift() ?? pending(this.transactionId);
  }

  async commit(): Promise<void> {
    this.commitCalls += 1;
    if (this.commitErrors-- > 0) throw new Error("injected commit crash");
  }
}

function observed(transactionId: string): TreasuryOperationProbe {
  return {
    status: "observed",
    detail: {
      profile: "urn:sompi:treasury-operation:observation:1",
      status: "observed",
      transactionId,
    },
  };
}

function pending(transactionId: string): TreasuryOperationProbe {
  return { status: "pending", detail: { status: "pending", transactionId } };
}

function notSubmitted(transactionId: string): TreasuryOperationProbe {
  return { status: "not_submitted", detail: { status: "not_submitted", transactionId } };
}

async function withFixture(
  run: (fixture: {
    directory: string;
    journal: PurchaseJournal;
    policy: PolicyEngine;
    wallet: FakeAdapter;
    vault: FakeAdapter;
    deposit: FakeAdapter;
    module: TreasuryOperationModule;
  }) => Promise<void>,
  limits: { maxPerPaymentAtomic?: string; maxPerHourAtomic?: string } = {}
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-treasury-operation-"));
  fs.chmodSync(directory, 0o700);
  const journal = new PurchaseJournal(path.join(directory, "purchase.sqlite"), {
    now: () => NOW,
  });
  const policy = new PolicyEngine({
    maxSompiPerTx: BigInt(limits.maxPerPaymentAtomic ?? "1000"),
    maxSompiPerHour: BigInt(limits.maxPerHourAtomic ?? "10000"),
    requireApprovalAboveSompi: 0n,
    allowlist: [DESTINATION],
  });
  const wallet = new FakeAdapter("wallet_send", "1");
  const vault = new FakeAdapter("vault_send", "2");
  const deposit = new FakeAdapter("vault_deposit", "3");
  const module = new TreasuryOperationModule({
    journal,
    policy,
    adapters: [wallet, vault, deposit],
    feeCeilingAtomic: "10",
  });
  try {
    await run({ directory, journal, policy, wallet, vault, deposit, module });
  } finally {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function authorizedPurchase(
  journal: PurchaseJournal,
  seed: number,
  amountAtomic: string
): PurchaseId {
  const id = createPurchaseId(new Uint8Array(16).fill(seed));
  const resource = { url: `https://merchant.example/resource/${seed}`, method: "GET" };
  const purchase = journal.createPurchase({
    id,
    requestKey: assertPurchaseRequestKey(`treasury:test:${seed}`),
    resourceUrl: resource.url,
    method: resource.method,
    resourceFingerprint: requestFingerprint(resource),
    expectedMerchantId: "merchant:test",
    expectedMerchantOrigin: "https://merchant.example",
  });
  const checkoutEvidence = verifiedEvidence(
    journal,
    id,
    `checkout-${seed}`,
    "checkout-terms",
    "merchant:test"
  );
  const requirements = verifiedEvidence(
    journal,
    id,
    `requirements-${seed}`,
    "payment-requirements",
    "merchant:test"
  );
  journal.bindCheckoutTerms(id, {
    terms: {
      merchant: { id: "merchant:test", name: "Test", origin: "https://merchant.example" },
      resourceFingerprint: purchase.resourceFingerprint,
      amountAtomic,
      asset: "KAS",
      network: "kaspa:testnet-10",
      payTo: DESTINATION,
      expiresAt: "2099-01-01T00:00:00.000Z",
      checkoutDigest: checkoutEvidence,
    },
    checkoutEvidenceDigest: checkoutEvidence,
    checkoutVerificationProfile: "test-profile-v1",
    checkoutVerifierId: "test-verifier",
    paymentRequirementsDigest: requirements,
    paymentRequirementsVerificationProfile: "test-profile-v1",
    paymentRequirementsVerifierId: "test-verifier",
  });
  const requestDigest = evidenceDigest(`auth-request-${seed}`);
  const requestBodyDigest = evidenceDigest(new Uint8Array());
  verifiedEvidence(journal, id, `auth-request-${seed}`, "authorization-request");
  journal.storeEvidence(id, {
    bytes: new Uint8Array(),
    mediaType: "application/octet-stream",
    profile: "urn:sompi:purchase-request-body:1",
    kind: "purchase-request-body",
  });
  const nonceDigest = evidenceDigest(`nonce-${seed}`);
  const expiresAtMs = Date.parse("2099-01-01T00:00:00.000Z");
  journal.recordAuthorizationRequest(id, {
    checkoutDigest: checkoutEvidence,
    requestDigest,
    nonceDigest,
    requestMediaType: "",
    requestBodyDigest,
    additionalCostCeilingAtomic: "10",
    effectiveFinalityFloor: "accepted",
    expiresAtMs,
  });
  const authEvidence = verifiedEvidence(journal, id, `auth-${seed}`, "purchase-authorization");
  const terms = journal.requireCheckoutTerms(id);
  journal.recordAuthorizationDecision(id, {
    decision: "approved",
    authorityId: "authority:test",
    checkoutDigest: checkoutEvidence,
    approvedFactsDigest: authorizationFactsDigest({
      purchaseId: id,
      resourceUrl: purchase.resourceUrl,
      method: purchase.method,
      requestMediaType: "",
      requestBodyDigest,
      terms,
      requestDigest,
      nonceDigest,
      additionalCostCeilingAtomic: "10",
      effectiveFinalityFloor: "accepted",
      createdAtMs: journal.requireAuthorizationRequest(id).createdAtMs,
      expiresAtMs,
    }),
    evidenceDigest: authEvidence,
    verificationProfile: "test-profile-v1",
    verifierId: "test-verifier",
    requestDigest,
    nonceDigest,
    expiresAtMs,
  });
  return id;
}

function reservePurchase(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  policy: PolicySnapshotRecord,
  id: string,
  amountAtomic: string,
  additionalCostCeilingAtomic: string
): void {
  const authorization = journal.requireAuthorization(purchaseId);
  journal.reservePolicy({
    id,
    purchaseId,
    policyDigest: policy.digest,
    payee: DESTINATION,
    amountAtomic,
    additionalCostCeilingAtomic,
    fundingSource: "vault-treasury",
    expiresAtMs: NOW + 60_000,
    approvalEvidenceDigest: authorization.evidenceDigest,
    approvalVerificationProfile: authorization.verificationProfile,
    approvalVerifierId: authorization.verifierId,
  });
}

function verifiedEvidence(
  journal: PurchaseJournal,
  purchaseId: PurchaseId,
  value: string,
  kind: string,
  issuer = "test-issuer"
): Sha256Digest {
  const artifact = journal.storeEvidence(purchaseId, {
    bytes: Buffer.from(value, "utf8"),
    mediaType: "application/octet-stream",
    profile: "test-profile-v1",
    issuer,
    kind,
  });
  journal.recordEvidenceVerification(artifact.digest, {
    verifierId: "test-verifier",
    profile: "test-profile-v1",
    detailDigest: evidenceDigest(`verified:${value}`),
  });
  return artifact.digest;
}
