import assert from "node:assert/strict";
import test from "node:test";

import type { PolicyChangeFacts } from "../policy-change/types.js";
import type { PurchaseId, Sha256Digest } from "../purchase/types.js";
import type { TransferAuthorizationFacts } from "../transfer/types.js";
import type { VaultMigrationFacts } from "../vault-migration/types.js";
import {
  authorityApprovalSubject,
  isAuthorityApprovalSubjectId,
  ownerAuthorityApprovalDisplay,
  purchaseAuthorityApprovalDisplay,
  type AnyAuthorityApprovalDisplay,
} from "./approval-ceremony.js";
import type { AuthorityApprovalFacts } from "./protocol.js";

const REQUEST_DIGEST = digest("R");

test("Purchase ceremony displays every exact signed fact without changing its shape", () => {
  const facts = purchaseFacts();
  const display = purchaseAuthorityApprovalDisplay(facts, REQUEST_DIGEST, true);

  assert.deepEqual(display, {
    profile: "sompi.purchase-approval.2",
    authorityRequestDigest: REQUEST_DIGEST,
    purchaseId: facts.purchaseId,
    merchant: {
      id: facts.merchantId,
      name: facts.merchantName,
      origin: facts.merchantOrigin,
    },
    request: {
      url: facts.resourceUrl,
      method: facts.method,
      mediaType: facts.requestMediaType,
      bodyDigest: facts.requestBodyDigest,
      fingerprint: facts.resourceFingerprint,
    },
    price: {
      amountAtomic: facts.amountAtomic,
      asset: facts.asset,
      network: facts.network,
      payTo: facts.payTo,
    },
    checkoutDigest: facts.checkoutDigest,
    purchaseAuthorizationRequestDigest: facts.purchaseAuthorizationRequestDigest,
    purchaseAuthorizationNonceDigest: facts.purchaseAuthorizationNonceDigest,
    purchaseAuthorizationFactsDigest: facts.purchaseAuthorizationFactsDigest,
    termsExpiresAt: facts.termsExpiresAt,
    additionalCostCeilingAtomic: facts.additionalCostCeilingAtomic,
    operatorFinalityFloor: facts.operatorFinalityFloor,
    effectiveFinalityFloor: facts.effectiveFinalityFloor,
    depthConfirmationDaa: facts.depthConfirmationDaa,
    execution: {
      planDigest: facts.executionPlanDigest,
      mechanism: facts.executionMechanism,
      profile: facts.executionProfile,
      settlementAssurance: facts.settlementAssurance,
      maximumChargeAtomic: facts.maximumAuthorizedChargeAtomic,
      channelId: facts.channelId,
      channelEpochDigest: facts.channelEpochDigest,
    },
    recoveryRetry: true,
  });
  assert.equal(Object.hasOwn(display, "kind"), false);
  assert.deepEqual(authorityApprovalSubject(display), {
    kind: "purchase",
    id: facts.purchaseId,
    label: "Purchase",
  });
});

test("Owner ceremony displays every exact Transfer, Policy Change and Vault Migration fact", () => {
  const transfer = transferFacts();
  const transferDisplay = ownerAuthorityApprovalDisplay(transfer, REQUEST_DIGEST);
  assert.deepEqual(transferDisplay, {
    kind: "transfer",
    profile: transfer.profile,
    authorityRequestDigest: REQUEST_DIGEST,
    transferId: transfer.transferId,
    requestKey: transfer.requestKey,
    sourceVaultAddress: transfer.sourceVaultAddress,
    sourceVaultDigest: transfer.sourceVaultDigest,
    destination: transfer.destination,
    amountAtomic: transfer.amountAtomic,
    asset: transfer.asset,
    network: transfer.network,
    feeCeilingAtomic: transfer.feeCeilingAtomic,
    maximumTotalAtomic: transfer.maximumTotalAtomic,
    issuedAt: transfer.issuedAt,
    termsExpiresAt: transfer.expiresAt,
    policyDigest: transfer.policyDigest,
    operatorManifestRevision: transfer.operatorManifestRevision,
    operatorManifestDigest: transfer.operatorManifestDigest,
    finalityFloor: transfer.finalityFloor,
    recoveryRetry: false,
  });
  assert.deepEqual(authorityApprovalSubject(transferDisplay), {
    kind: "transfer",
    id: transfer.transferId,
    label: "Transfer",
  });

  const policy = policyChangeFacts();
  const policyDisplay = ownerAuthorityApprovalDisplay(policy, REQUEST_DIGEST);
  assert.deepEqual(policyDisplay, {
    kind: "policy-change",
    profile: policy.profile,
    authorityRequestDigest: REQUEST_DIGEST,
    policyChangeId: policy.policyChangeId,
    requestKey: policy.requestKey,
    expectedPolicyDigest: policy.expectedPolicyDigest,
    expectedPolicyVersion: policy.expectedPolicyVersion,
    expectedPolicyGeneration: policy.expectedPolicyGeneration,
    expectedVaultDigest: policy.expectedVaultDigest,
    previousMaximumPerPaymentAtomic: policy.previousMaximumPerPaymentAtomic,
    previousMaximumPerHourAtomic: policy.previousMaximumPerHourAtomic,
    proposedMaximumPerPaymentAtomic: policy.proposedMaximumPerPaymentAtomic,
    proposedMaximumPerHourAtomic: policy.proposedMaximumPerHourAtomic,
    vaultMaximumOutflowAtomic: policy.vaultMaximumOutflowAtomic,
    everyPaymentRequiresApproval: true,
    issuedAt: policy.issuedAt,
    termsExpiresAt: policy.expiresAt,
    operatorManifestRevision: policy.operatorManifestRevision,
    operatorManifestDigest: policy.operatorManifestDigest,
  });
  assert.deepEqual(authorityApprovalSubject(policyDisplay), {
    kind: "policy-change",
    id: policy.policyChangeId,
    label: "Policy Change",
  });

  const migration = vaultMigrationFacts();
  const migrationDisplay = ownerAuthorityApprovalDisplay(migration, REQUEST_DIGEST);
  assert.deepEqual(migrationDisplay, {
    kind: "vault-migration",
    profile: migration.profile,
    authorityRequestDigest: REQUEST_DIGEST,
    vaultMigrationId: migration.vaultMigrationId,
    requestKey: migration.requestKey,
    oldVaultDigest: migration.oldVaultDigest,
    expectedPolicyDigest: migration.expectedPolicyDigest,
    expectedPolicyGeneration: migration.expectedPolicyGeneration,
    oldMaximumOutflowAtomic: migration.oldMaximumOutflowAtomic,
    newMaximumOutflowAtomic: migration.newMaximumOutflowAtomic,
    windowSizeDaa: migration.windowSizeDaa,
    windowStartDaa: migration.windowStartDaa,
    spentInWindowAtomic: migration.spentInWindowAtomic,
    stableReceiveAddress: migration.stableReceiveAddress,
    stableReceiveAddressWillNotChange: true,
    requiresOfflineOwnerKey: true,
    issuedAt: migration.issuedAt,
    termsExpiresAt: migration.expiresAt,
    operatorManifestRevision: migration.operatorManifestRevision,
    operatorManifestDigest: migration.operatorManifestDigest,
  });
  assert.deepEqual(authorityApprovalSubject(migrationDisplay), {
    kind: "vault-migration",
    id: migration.vaultMigrationId,
    label: "Vault Migration",
  });
});

test("subject rules bind each ceremony kind, profile and identity prefix", () => {
  const transfer = ownerAuthorityApprovalDisplay(transferFacts(), REQUEST_DIGEST);
  if (transfer.kind !== "transfer") throw new Error("expected Transfer display");
  assert.throws(
    () => authorityApprovalSubject({
      ...transfer,
      transferId: "pur_AAAAAAAAAAAAAAAAAAAAAA",
    }),
    /does not match/,
  );
  assert.throws(
    () => authorityApprovalSubject({
      ...transfer,
      profile: "sompi.policy-change.1",
    } as unknown as AnyAuthorityApprovalDisplay),
    /does not match/,
  );
  assert.throws(
    () => authorityApprovalSubject({
      ...purchaseAuthorityApprovalDisplay(purchaseFacts(), REQUEST_DIGEST, false),
      kind: "unsupported",
    } as unknown as AnyAuthorityApprovalDisplay),
    /unsupported/,
  );

  for (const id of [
    "pur_AAAAAAAAAAAAAAAAAAAAAA",
    "trf_AAAAAAAAAAAAAAAAAAAAAA",
    "pcg_AAAAAAAAAAAAAAAAAAAAAA",
    "vmg_AAAAAAAAAAAAAAAAAAAAAA",
  ]) {
    assert.equal(isAuthorityApprovalSubjectId(id), true);
  }
  for (const id of [
    "pur_AAAAAAAAAAAAAAAAAAAAA",
    "xxx_AAAAAAAAAAAAAAAAAAAAAA",
    "trf_AAAAAAAAAAAAAAAAAAAAAA ",
  ]) {
    assert.equal(isAuthorityApprovalSubjectId(id), false);
  }
});

function purchaseFacts(): AuthorityApprovalFacts {
  return Object.freeze({
    purchaseId: "pur_AAAAAAAAAAAAAAAAAAAAAA" as PurchaseId,
    merchantId: "https://merchant.example",
    merchantName: "Merchant",
    merchantOrigin: "https://merchant.example",
    resourceUrl: "https://merchant.example/resource",
    method: "GET",
    requestMediaType: "application/octet-stream",
    requestBodyDigest: digest("A"),
    resourceFingerprint: digest("B"),
    amountAtomic: "1000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    payTo: "kaspatest:qtest",
    termsExpiresAt: "2099-01-01T00:00:00.000Z",
    checkoutDigest: digest("C"),
    purchaseAuthorizationRequestDigest: digest("D"),
    purchaseAuthorizationNonceDigest: digest("E"),
    purchaseAuthorizationFactsDigest: digest("F"),
    additionalCostCeilingAtomic: "100",
    operatorFinalityFloor: "accepted",
    effectiveFinalityFloor: "accepted",
    depthConfirmationDaa: "10",
    executionPlanDigest: digest("G"),
    executionMechanism: "single-transaction",
    executionProfile: "kaspa-exact-v2:standard-native",
    settlementAssurance: "accepted",
    maximumAuthorizedChargeAtomic: "1000",
    channelId: null,
    channelEpochDigest: null,
  });
}

function transferFacts(): TransferAuthorizationFacts {
  return Object.freeze({
    profile: "sompi.transfer.1",
    transferId: "trf_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "telegram:transfer:test",
    sourceVaultAddress: "kaspatest:qsource",
    sourceVaultDigest: digest("H"),
    destination: "kaspatest:qdestination",
    amountAtomic: "2000",
    asset: "KAS",
    network: "kaspa:testnet-10",
    feeCeilingAtomic: "200",
    maximumTotalAtomic: "2200",
    issuedAt: "2098-12-31T23:58:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    policyDigest: digest("I"),
    operatorManifestRevision: 2,
    operatorManifestDigest: digest("J"),
    finalityFloor: "depth-confirmed",
  });
}

function policyChangeFacts(): PolicyChangeFacts {
  return Object.freeze({
    profile: "sompi.policy-change.1",
    policyChangeId: "pcg_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "telegram:policy:test",
    expectedPolicyDigest: digest("K"),
    expectedPolicyVersion: 2,
    expectedPolicyGeneration: 3,
    expectedVaultDigest: digest("L"),
    previousMaximumPerPaymentAtomic: "1000",
    previousMaximumPerHourAtomic: "5000",
    proposedMaximumPerPaymentAtomic: "2000",
    proposedMaximumPerHourAtomic: "4000",
    vaultMaximumOutflowAtomic: "5000",
    everyPaymentRequiresApproval: true,
    operatorManifestRevision: 4,
    operatorManifestDigest: digest("M"),
    issuedAt: "2098-12-31T23:58:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

function vaultMigrationFacts(): VaultMigrationFacts {
  return Object.freeze({
    profile: "sompi.vault-migration.1",
    vaultMigrationId: "vmg_AAAAAAAAAAAAAAAAAAAAAA",
    requestKey: "telegram:vault:test",
    oldVaultDigest: digest("N"),
    expectedPolicyDigest: digest("O"),
    expectedPolicyGeneration: 5,
    oldMaximumOutflowAtomic: "5000",
    newMaximumOutflowAtomic: "6000",
    windowSizeDaa: "36000",
    windowStartDaa: "123000",
    spentInWindowAtomic: "1000",
    stableReceiveAddress: "kaspatest:qreceive",
    stableReceiveAddressWillNotChange: true,
    requiresOfflineOwnerKey: true,
    operatorManifestRevision: 6,
    operatorManifestDigest: digest("P"),
    issuedAt: "2098-12-31T23:58:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(43)}` as Sha256Digest;
}
