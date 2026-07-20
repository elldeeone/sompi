import assert from "node:assert/strict";
import { test } from "node:test";

import { assertPurchaseId, assertPurchaseRequestKey, evidenceDigest } from "../purchase/identity.js";
import type { PurchaseModule, PurchaseView } from "../purchase/types.js";
import {
  SompiApiContractError,
  assertSompiApiError,
  assertPurchaseView,
  assertTransferView,
  assertWalletActivity,
  assertWalletView,
  assertWalletTechnicalView,
  assertPolicyChangeView,
  assertVaultMigrationView,
  createPurchaseApplication,
  parsePurchaseCreateRequest,
  parseTransferCreateRequest,
  parsePolicyChangeCreateRequest,
  parseVaultMigrationCreateRequest,
  purchaseIntent,
  transferIntent,
} from "./contracts.js";

test("canonical Purchase contract drives input, module calls, and public result", async () => {
  const view = fakeView();
  let called = 0;
  const module: PurchaseModule = {
    async purchase(intent) {
      called += 1;
      assert.equal(intent.requestKey, "agent:request:1");
      assert.equal(intent.resource.url, "https://merchant.example/resource");
      assert.equal(intent.resource.method, "POST");
      assert.deepEqual(intent.resource.body, Uint8Array.from([1, 2, 3]));
      assert.deepEqual(intent.expectedMerchant, {
        id: "merchant:test",
        origin: "https://merchant.example",
      });
      return view;
    },
    async status(id) { assert.equal(id, view.id); return view; },
    async recover(id) { assert.equal(id, view.id); return view; },
  };
  const application = createPurchaseApplication(module);
  const input = {
    requestKey: "agent:request:1",
    url: "https://merchant.example/resource",
    method: "POST",
    bodyBase64: "AQID",
    mediaType: "application/json",
    expectedMerchant: { id: "merchant:test", origin: "https://merchant.example" },
  };
  assert.deepEqual(purchaseIntent(parsePurchaseCreateRequest(input)).resource.body, Uint8Array.from([1, 2, 3]));
  assert.equal(await application.purchase(input), view);
  assert.equal(await application.status(view.id), view);
  assert.equal(await application.recover(view.id), view);
  assert.equal(called, 1);
});

test("wallet and Transfer contracts reject unknown fields, wrong networks, and oversized values", () => {
  const address = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
  assert.deepEqual(parseTransferCreateRequest({ requestKey: "send:one", destination: address, amountKas: "0.00000001" }), {
    requestKey: "send:one", destination: address, amountKas: "0.00000001",
  });
  assert.equal(transferIntent({ requestKey: "send:one", destination: address, amountKas: "0.00000001" }).amountAtomic, "1");
  assert.throws(() => parseTransferCreateRequest({ requestKey: "send:one", destination: address, amountKas: "1", privateKey: "secret" }), SompiApiContractError);
  assert.throws(() => parseTransferCreateRequest({ requestKey: "send:one", destination: address.replace("kaspatest", "kaspa"), amountKas: "1" }), SompiApiContractError);
  assert.throws(() => parseTransferCreateRequest({ requestKey: "send:one", destination: address, amountKas: "184467440737.09551616" }), SompiApiContractError);
  const transfer = {
    id: "trf_0123456789ABCDEFGHIJKL", requestKey: "send:one", requestDigest: `sha256:${"A".repeat(43)}`,
    state: "created", summary: "Transfer request recorded.", display: { amount: amount("1"), feeCeiling: amount("1"), maximumTotal: amount("2") }, destination: address, amountAtomic: "1", asset: "KAS", network: "kaspa:testnet-10",
    sourceVaultAddress: address, sourceVaultDigest: `sha256:${"B".repeat(43)}`, feeCeilingAtomic: "1",
    maximumTotalAtomic: "2", expiresAtMs: 2_000_000_000_000, policyDigest: `sha256:${"C".repeat(43)}`,
    manifestRevision: 1, manifestDigest: `sha256:${"D".repeat(43)}`, finalityFloor: "accepted", version: 0,
    createdAtMs: 1_900_000_000_000, updatedAtMs: 1_900_000_000_000,
    recoveryRequired: false, safeToRetry: true, userAction: "none",
  };
  assert.equal(assertTransferView(transfer).id, transfer.id);
  assert.equal(assertTransferView({
    ...transfer,
    state: "failed_terminal",
    failureCode: "treasury_operation_failed",
    authorization: {
      transferId: transfer.id,
      facts: {
        profile: "sompi.transfer.1",
        transferId: transfer.id,
        requestKey: transfer.requestKey,
        sourceVaultAddress: transfer.sourceVaultAddress,
        sourceVaultDigest: transfer.sourceVaultDigest,
        destination: transfer.destination,
        amountAtomic: transfer.amountAtomic,
        asset: "KAS",
        network: "kaspa:testnet-10",
        feeCeilingAtomic: transfer.feeCeilingAtomic,
        maximumTotalAtomic: transfer.maximumTotalAtomic,
        issuedAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-01T00:02:00.000Z",
        policyDigest: transfer.policyDigest,
        operatorManifestRevision: transfer.manifestRevision,
        operatorManifestDigest: transfer.manifestDigest,
        finalityFloor: "accepted",
      },
      factsDigest: `sha256:${"E".repeat(43)}`,
      decision: "approved",
      authorityId: "urn:sompi:authority:test",
      evidenceDigest: `sha256:${"F".repeat(43)}`,
      verificationProfile: "urn:sompi:authority-decision:owner:1",
      verifierId: "urn:sompi:authority:test",
      decidedAtMs: 1_900_000_000_001,
      expiresAtMs: 2_000_000_000_000,
    },
  }).state, "failed_terminal");
  assert.throws(() => assertTransferView({ ...transfer, rawTransaction: "secret" }), SompiApiContractError);
  const wallet = {
    network: "kaspa:testnet-10", asset: "KAS",
    receive: { address, qrPayload: address, networkLabel: "Kaspa Testnet-10", warning: "Testnet funds only — do not send mainnet KAS." },
    balance: { total: amount("1"), available: amount("1"), incoming: amount("0"), pending: amount("0"), provenance: "operator-node-and-local-vault-lineage", observedAt: "2030-01-01T00:00:00.000Z" },
    securing: { automatic: true, state: "idle", summary: "No incoming funds are waiting to be secured.", userAction: "none", minimumAmount: amount("1") },
    spendingProtection: { maximumPerPayment: amount("1"), maximumPerHour: amount("1"), everyPaymentRequiresApproval: true, vaultProtection: { maximumPerWindow: amount("1"), remainingInWindow: amount("1"), window: "approximately 1 hour", summary: "Protected." } },
    chainStatus: "observed",
  };
  assert.equal(assertWalletView(wallet).balance.available.atomic, "1");
  assert.throws(() => assertWalletView({ ...wallet, privateKey: "secret" }), SompiApiContractError);
  assert.deepEqual(assertWalletActivity([]), []);
});

test("limit and vault-protection contracts are KAS-first, closed, and explicit about offline ownership", () => {
  const address = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
  assert.deepEqual(parsePolicyChangeCreateRequest({ requestKey: "limits:one", maximumPerPaymentKas: "1", maximumPerHourKas: "2.5" }), {
    requestKey: "limits:one", maximumPerPaymentKas: "1", maximumPerHourKas: "2.5",
  });
  assert.throws(() => parsePolicyChangeCreateRequest({ requestKey: "limits:one", maximumPerPaymentKas: "1", maximumPerHourKas: "2", approvalThresholdKas: "1" }), SompiApiContractError);
  assert.deepEqual(parseVaultMigrationCreateRequest({ requestKey: "vault:one", vaultProtectionMaximumKas: "10" }), {
    requestKey: "vault:one", vaultProtectionMaximumKas: "10",
  });
  assert.throws(() => parseVaultMigrationCreateRequest({ requestKey: "vault:one", vaultProtectionMaximumKas: "10", ownerKey: "secret" }), SompiApiContractError);
  assert.equal(assertPolicyChangeView({
    id: "pcg_0123456789ABCDEFGHIJKL", requestKey: "limits:one", state: "applied", summary: "Spending limits updated.",
    previous: { maximumPerPayment: amount("100000000"), maximumPerHour: amount("200000000") },
    proposed: { maximumPerPayment: amount("200000000"), maximumPerHour: amount("300000000") },
    vaultProtectionMaximum: amount("1000000000"), everyPaymentRequiresApproval: true,
    expiresAt: "2030-01-01T00:00:00.000Z",
  }).state, "applied");
  assert.equal(assertVaultMigrationView({
    id: "vmg_0123456789ABCDEFGHIJKL", requestKey: "vault:one", state: "awaiting_owner",
    summary: "Vault protection change approved. Finish it with the offline owner key.",
    userAction: "Ask the operator to finish the protected vault update locally.",
    previousVaultProtectionMaximum: amount("500000000"), proposedVaultProtectionMaximum: amount("1000000000"),
    receiveAddressUnchanged: true, requiresOfflineOwnerKey: true, expiresAt: "2030-01-01T00:00:00.000Z",
  }).requiresOfflineOwnerKey, true);
  assert.equal(assertWalletTechnicalView({
    receiveAddress: address,
    activeVault: { address, maximumOutflowAtomic: "1000000000", windowSizeDaa: "36000", windowStartDaa: "0", spentInWindowAtomic: "0" },
    allowlist: [],
  }).activeVault.address, address);
});

function amount(atomic: string) {
  const kas = atomic === "0" ? "0" : `0.${atomic.padStart(8, "0").replace(/0+$/, "")}`;
  return { atomic, kas, unit: "tKAS", display: `${kas} tKAS` };
}

test("canonical Purchase contract rejects unknown, ambiguous, oversized, and secret-shaped data", () => {
  assert.throws(
    () => parsePurchaseCreateRequest({ requestKey: "agent:request:1", url: "https://merchant.example/", unknown: true }),
    SompiApiContractError
  );
  assert.throws(
    () => parsePurchaseCreateRequest({ requestKey: "agent:request:1", url: "https://user:secret@merchant.example/" }),
    SompiApiContractError
  );
  assert.throws(
    () => parsePurchaseCreateRequest({ requestKey: "agent:request:1", url: "https://merchant.example/", bodyBase64: "AQI" }),
    SompiApiContractError
  );
  assert.throws(() => assertPurchaseView({ ...fakeView(), authorityPrivateKey: "secret" }), SompiApiContractError);
  assert.throws(
    () => assertSompiApiError({ error: { code: "BAD", message: "safe", retryable: false }, raw: "secret" }),
    SompiApiContractError
  );
});

function fakeView(): PurchaseView {
  return {
    id: assertPurchaseId("pur_0123456789ABCDEFGHIJKL"),
    requestKey: assertPurchaseRequestKey("agent:request:1"),
    state: "created",
    summary: "Purchase request recorded.",
    userAction: "none",
    resourceFingerprint: evidenceDigest("resource"),
    authorization: { status: "not_requested" },
    treasury: { status: "unreserved" },
    paymentAttempts: [],
    receiptEvidence: [],
  };
}
