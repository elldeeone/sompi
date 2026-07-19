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
  createPurchaseApplication,
  parsePurchaseCreateRequest,
  parseTransferCreateRequest,
  purchaseIntent,
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
  assert.deepEqual(parseTransferCreateRequest({ requestKey: "send:one", destination: address, amountAtomic: "1" }), {
    requestKey: "send:one", destination: address, amountAtomic: "1",
  });
  assert.throws(() => parseTransferCreateRequest({ requestKey: "send:one", destination: address, amountAtomic: "1", privateKey: "secret" }), SompiApiContractError);
  assert.throws(() => parseTransferCreateRequest({ requestKey: "send:one", destination: address.replace("kaspatest", "kaspa"), amountAtomic: "1" }), SompiApiContractError);
  assert.throws(() => parseTransferCreateRequest({ requestKey: "send:one", destination: address, amountAtomic: (1n << 64n).toString() }), SompiApiContractError);
  const transfer = {
    id: "trf_0123456789ABCDEFGHIJKL", requestKey: "send:one", requestDigest: `sha256:${"A".repeat(43)}`,
    state: "created", destination: address, amountAtomic: "1", asset: "KAS", network: "kaspa:testnet-10",
    sourceVaultAddress: address, sourceVaultDigest: `sha256:${"B".repeat(43)}`, feeCeilingAtomic: "1",
    maximumTotalAtomic: "2", expiresAtMs: 2_000_000_000_000, policyDigest: `sha256:${"C".repeat(43)}`,
    manifestRevision: 1, manifestDigest: `sha256:${"D".repeat(43)}`, finalityFloor: "accepted", version: 0,
    createdAtMs: 1_900_000_000_000, updatedAtMs: 1_900_000_000_000,
    recoveryRequired: false, safeToRetry: true, userAction: "none",
  };
  assert.equal(assertTransferView(transfer).id, transfer.id);
  assert.throws(() => assertTransferView({ ...transfer, rawTransaction: "secret" }), SompiApiContractError);
  const wallet = {
    network: "kaspa:testnet-10", asset: "KAS", fundingAddress: address, vaultAddress: address,
    balance: { observedAtomic: "1", unboundAtomic: "0", reservedAtomic: "0", availableAtomic: "1", provenance: "operator-node-and-local-vault-lineage", observedAt: "2030-01-01T00:00:00.000Z" },
    limits: { maxPerTransferAtomic: "1", maxPerHourAtomic: "1", approvalThresholdAtomic: "1", allowlist: [], vaultMaxOutflowAtomic: "1", vaultWindowSizeDaa: "1", vaultSpentInWindowAtomic: "0" },
    chainStatus: "observed",
  };
  assert.equal(assertWalletView(wallet).balance.availableAtomic, "1");
  assert.throws(() => assertWalletView({ ...wallet, privateKey: "secret" }), SompiApiContractError);
  assert.deepEqual(assertWalletActivity([]), []);
});

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
