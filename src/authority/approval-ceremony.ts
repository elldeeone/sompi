import type {
  PolicyChangeFacts,
} from "../policy-change/types.js";
import type {
  AuthorityApprovalFacts,
} from "./protocol.js";
import type {
  TransferAuthorizationFacts,
} from "../transfer/types.js";
import type {
  VaultMigrationFacts,
} from "../vault-migration/types.js";

export interface AuthorityApprovalDisplay {
  readonly kind?: "purchase";
  readonly profile: "sompi.purchase-approval.1";
  readonly authorityRequestDigest: string;
  readonly purchaseId: string;
  readonly merchant: Readonly<{ id: string; name: string; origin: string }>;
  readonly request: Readonly<{
    url: string;
    method: string;
    mediaType: string;
    bodyDigest: string;
    fingerprint: string;
  }>;
  readonly price: Readonly<{ amountAtomic: string; asset: string; network: string; payTo: string }>;
  readonly checkoutDigest: string;
  readonly purchaseAuthorizationRequestDigest: string;
  readonly purchaseAuthorizationNonceDigest: string;
  readonly purchaseAuthorizationFactsDigest: string;
  readonly termsExpiresAt: string;
  readonly additionalCostCeilingAtomic: string;
  readonly effectiveFinalityFloor: "accepted" | "depth-confirmed";
  readonly execution: Readonly<{
    planDigest: string;
    mechanism: "single-transaction" | "channel-voucher";
    profile: string;
    settlementAssurance: "accepted" | "confirmed" | "channel-commitment";
    maximumChargeAtomic: string;
    channelId: string | null;
    channelEpochDigest: string | null;
  }>;
  readonly recoveryRetry: boolean;
}

export interface TransferAuthorityApprovalDisplay {
  readonly kind: "transfer";
  readonly profile: "sompi.transfer.1";
  readonly authorityRequestDigest: string;
  readonly transferId: string;
  readonly requestKey: string;
  readonly sourceVaultAddress: string;
  readonly sourceVaultDigest: string;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly asset: "KAS";
  readonly network: "kaspa:testnet-10";
  readonly feeCeilingAtomic: string;
  readonly maximumTotalAtomic: string;
  readonly issuedAt: string;
  readonly termsExpiresAt: string;
  readonly policyDigest: string;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: string;
  readonly finalityFloor: "accepted" | "depth-confirmed";
  readonly recoveryRetry: boolean;
}

export interface PolicyChangeAuthorityApprovalDisplay {
  readonly kind: "policy-change";
  readonly profile: "sompi.policy-change.1";
  readonly authorityRequestDigest: string;
  readonly policyChangeId: string;
  readonly requestKey: string;
  readonly expectedPolicyDigest: string;
  readonly expectedPolicyVersion: number;
  readonly expectedPolicyGeneration: number;
  readonly expectedVaultDigest: string;
  readonly previousMaximumPerPaymentAtomic: string;
  readonly previousMaximumPerHourAtomic: string;
  readonly proposedMaximumPerPaymentAtomic: string;
  readonly proposedMaximumPerHourAtomic: string;
  readonly vaultMaximumOutflowAtomic: string;
  readonly everyPaymentRequiresApproval: true;
  readonly issuedAt: string;
  readonly termsExpiresAt: string;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: string;
}

export interface VaultMigrationAuthorityApprovalDisplay {
  readonly kind: "vault-migration";
  readonly profile: "sompi.vault-migration.1";
  readonly authorityRequestDigest: string;
  readonly vaultMigrationId: string;
  readonly requestKey: string;
  readonly oldVaultDigest: string;
  readonly expectedPolicyDigest: string;
  readonly expectedPolicyGeneration: number;
  readonly oldMaximumOutflowAtomic: string;
  readonly newMaximumOutflowAtomic: string;
  readonly windowSizeDaa: string;
  readonly windowStartDaa: string;
  readonly spentInWindowAtomic: string;
  readonly stableReceiveAddress: string;
  readonly stableReceiveAddressWillNotChange: true;
  readonly requiresOfflineOwnerKey: true;
  readonly issuedAt: string;
  readonly termsExpiresAt: string;
  readonly operatorManifestRevision: number;
  readonly operatorManifestDigest: string;
}

export type PurchaseAuthorityApprovalDisplay = AuthorityApprovalDisplay;

export type AnyAuthorityApprovalDisplay =
  | PurchaseAuthorityApprovalDisplay
  | TransferAuthorityApprovalDisplay
  | PolicyChangeAuthorityApprovalDisplay
  | VaultMigrationAuthorityApprovalDisplay;

export type AuthorityApprovalKind =
  | "purchase"
  | "transfer"
  | "policy-change"
  | "vault-migration";

export interface AuthorityApprovalSubject {
  readonly kind: AuthorityApprovalKind;
  readonly id: string;
  readonly label: "Purchase" | "Transfer" | "Policy Change" | "Vault Migration";
}

export interface AuthorityApprovalPrompt {
  /** Only the exact displayed subject ID confirms approval. */
  approve(display: AnyAuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean>;
}

type OwnerAuthorityFacts =
  | TransferAuthorizationFacts
  | PolicyChangeFacts
  | VaultMigrationFacts;

const SUBJECT_IDS = Object.freeze({
  purchase: /^pur_[A-Za-z0-9_-]{22}$/,
  transfer: /^trf_[A-Za-z0-9_-]{22}$/,
  "policy-change": /^pcg_[A-Za-z0-9_-]{22}$/,
  "vault-migration": /^vmg_[A-Za-z0-9_-]{22}$/,
});

export function authorityApprovalSubject(
  display: AnyAuthorityApprovalDisplay,
): AuthorityApprovalSubject {
  if (!display || typeof display !== "object") {
    throw new Error("Authority approval display is invalid");
  }
  if (display.kind === "transfer") {
    return subject(display.profile, "sompi.transfer.1", "transfer", display.transferId, "Transfer");
  }
  if (display.kind === "policy-change") {
    return subject(
      display.profile,
      "sompi.policy-change.1",
      "policy-change",
      display.policyChangeId,
      "Policy Change",
    );
  }
  if (display.kind === "vault-migration") {
    return subject(
      display.profile,
      "sompi.vault-migration.1",
      "vault-migration",
      display.vaultMigrationId,
      "Vault Migration",
    );
  }
  if (display.kind === undefined || display.kind === "purchase") {
    return subject(
      display.profile,
      "sompi.purchase-approval.1",
      "purchase",
      display.purchaseId,
      "Purchase",
    );
  }
  throw new Error("Authority approval display kind is unsupported");
}

export function isAuthorityApprovalSubjectId(value: unknown): value is string {
  return typeof value === "string" &&
    Object.values(SUBJECT_IDS).some((pattern) => pattern.test(value));
}

export function purchaseAuthorityApprovalDisplay(
  facts: AuthorityApprovalFacts,
  authorityRequestDigest: string,
  recoveryRetry: boolean,
): PurchaseAuthorityApprovalDisplay {
  return Object.freeze({
    profile: "sompi.purchase-approval.1",
    authorityRequestDigest,
    purchaseId: facts.purchaseId,
    merchant: Object.freeze({
      id: facts.merchantId,
      name: facts.merchantName,
      origin: facts.merchantOrigin,
    }),
    request: Object.freeze({
      url: facts.resourceUrl,
      method: facts.method,
      mediaType: facts.requestMediaType,
      bodyDigest: facts.requestBodyDigest,
      fingerprint: facts.resourceFingerprint,
    }),
    price: Object.freeze({
      amountAtomic: facts.amountAtomic,
      asset: facts.asset,
      network: facts.network,
      payTo: facts.payTo,
    }),
    checkoutDigest: facts.checkoutDigest,
    purchaseAuthorizationRequestDigest: facts.purchaseAuthorizationRequestDigest,
    purchaseAuthorizationNonceDigest: facts.purchaseAuthorizationNonceDigest,
    purchaseAuthorizationFactsDigest: facts.purchaseAuthorizationFactsDigest,
    termsExpiresAt: facts.termsExpiresAt,
    additionalCostCeilingAtomic: facts.additionalCostCeilingAtomic,
    effectiveFinalityFloor: facts.effectiveFinalityFloor,
    execution: Object.freeze({
      planDigest: facts.executionPlanDigest,
      mechanism: facts.executionMechanism,
      profile: facts.executionProfile,
      settlementAssurance: facts.settlementAssurance,
      maximumChargeAtomic: facts.maximumAuthorizedChargeAtomic,
      channelId: facts.channelId,
      channelEpochDigest: facts.channelEpochDigest,
    }),
    recoveryRetry,
  });
}

export function ownerAuthorityApprovalDisplay(
  facts: OwnerAuthorityFacts,
  authorityRequestDigest: string,
): TransferAuthorityApprovalDisplay
  | PolicyChangeAuthorityApprovalDisplay
  | VaultMigrationAuthorityApprovalDisplay {
  if (facts.profile === "sompi.vault-migration.1") {
    return Object.freeze({
      kind: "vault-migration",
      profile: facts.profile,
      authorityRequestDigest,
      vaultMigrationId: facts.vaultMigrationId,
      requestKey: facts.requestKey,
      oldVaultDigest: facts.oldVaultDigest,
      expectedPolicyDigest: facts.expectedPolicyDigest,
      expectedPolicyGeneration: facts.expectedPolicyGeneration,
      oldMaximumOutflowAtomic: facts.oldMaximumOutflowAtomic,
      newMaximumOutflowAtomic: facts.newMaximumOutflowAtomic,
      windowSizeDaa: facts.windowSizeDaa,
      windowStartDaa: facts.windowStartDaa,
      spentInWindowAtomic: facts.spentInWindowAtomic,
      stableReceiveAddress: facts.stableReceiveAddress,
      stableReceiveAddressWillNotChange: true,
      requiresOfflineOwnerKey: true,
      issuedAt: facts.issuedAt,
      termsExpiresAt: facts.expiresAt,
      operatorManifestRevision: facts.operatorManifestRevision,
      operatorManifestDigest: facts.operatorManifestDigest,
    });
  }
  if (facts.profile === "sompi.policy-change.1") {
    return Object.freeze({
      kind: "policy-change",
      profile: facts.profile,
      authorityRequestDigest,
      policyChangeId: facts.policyChangeId,
      requestKey: facts.requestKey,
      expectedPolicyDigest: facts.expectedPolicyDigest,
      expectedPolicyVersion: facts.expectedPolicyVersion,
      expectedPolicyGeneration: facts.expectedPolicyGeneration,
      expectedVaultDigest: facts.expectedVaultDigest,
      previousMaximumPerPaymentAtomic: facts.previousMaximumPerPaymentAtomic,
      previousMaximumPerHourAtomic: facts.previousMaximumPerHourAtomic,
      proposedMaximumPerPaymentAtomic: facts.proposedMaximumPerPaymentAtomic,
      proposedMaximumPerHourAtomic: facts.proposedMaximumPerHourAtomic,
      vaultMaximumOutflowAtomic: facts.vaultMaximumOutflowAtomic,
      everyPaymentRequiresApproval: true,
      issuedAt: facts.issuedAt,
      termsExpiresAt: facts.expiresAt,
      operatorManifestRevision: facts.operatorManifestRevision,
      operatorManifestDigest: facts.operatorManifestDigest,
    });
  }
  return Object.freeze({
    kind: "transfer",
    profile: facts.profile,
    authorityRequestDigest,
    transferId: facts.transferId,
    requestKey: facts.requestKey,
    sourceVaultAddress: facts.sourceVaultAddress,
    sourceVaultDigest: facts.sourceVaultDigest,
    destination: facts.destination,
    amountAtomic: facts.amountAtomic,
    asset: facts.asset,
    network: facts.network,
    feeCeilingAtomic: facts.feeCeilingAtomic,
    maximumTotalAtomic: facts.maximumTotalAtomic,
    issuedAt: facts.issuedAt,
    termsExpiresAt: facts.expiresAt,
    policyDigest: facts.policyDigest,
    operatorManifestRevision: facts.operatorManifestRevision,
    operatorManifestDigest: facts.operatorManifestDigest,
    finalityFloor: facts.finalityFloor,
    recoveryRetry: false,
  });
}

function subject(
  profile: string,
  expectedProfile: AnyAuthorityApprovalDisplay["profile"],
  kind: AuthorityApprovalKind,
  id: string,
  label: AuthorityApprovalSubject["label"],
): AuthorityApprovalSubject {
  if (profile !== expectedProfile || !SUBJECT_IDS[kind].test(id)) {
    throw new Error("Authority approval subject does not match its display");
  }
  return Object.freeze({ kind, id, label });
}
