import * as Ajv2020Module from "ajv/dist/2020.js";
import type {
  Ajv2020 as Ajv2020Instance,
  JSONSchemaType,
  Options as AjvOptions,
} from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { assertPurchaseId, assertPurchaseRequestKey } from "../purchase/identity.js";
import type { PurchaseIntent, PurchaseModule, PurchaseView } from "../purchase/types.js";
import { TRANSFER_STATES, type TransferIntent, type TransferView } from "../transfer/types.js";
import type { TransferModule } from "../transfer/module.js";
import type { WalletActivityItem, WalletTechnicalView, WalletView, WalletViewModule } from "../wallet-view/module.js";
import { parseKasAmount } from "../amount-display.js";
import type { PolicyChangeModule } from "../policy-change/module.js";
import type { PolicyChangeView } from "../policy-change/types.js";
import type { VaultMigrationModule } from "../vault-migration/module.js";
import type { VaultMigrationView } from "../vault-migration/types.js";

export const SOMPI_API_VERSION = "sompi-agent-api-v2" as const;
export const MAX_SOMPI_API_BODY_BYTES = 1_500_000;
export const MAX_PURCHASE_BODY_BYTES = 1024 * 1024;
export const MAX_SOMPI_API_RESPONSE_BYTES = 64 * 1024;

const PURCHASE_ID_PATTERN = "^pur_[A-Za-z0-9_-]{22}$";
const TRANSFER_ID_PATTERN = "^trf_[A-Za-z0-9_-]{22}$";
const POLICY_CHANGE_ID_PATTERN = "^pcg_[A-Za-z0-9_-]{22}$";
const VAULT_MIGRATION_ID_PATTERN = "^vmg_[A-Za-z0-9_-]{22}$";
const REQUEST_KEY_PATTERN = "^[A-Za-z0-9._:-]{1,160}$";
const DIGEST_PATTERN = "^sha256:[A-Za-z0-9_-]{43}$";
const POSITIVE_ATOMIC_PATTERN = "^[1-9][0-9]*$";
const NONNEGATIVE_ATOMIC_PATTERN = "^(?:0|[1-9][0-9]*)$";
const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

const KAS_AMOUNT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["atomic", "kas", "unit", "display"],
  properties: {
    atomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
    kas: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?$", maxLength: 32 },
    unit: { const: "tKAS" },
    display: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})? tKAS$", maxLength: 40 },
  },
} as const;

export interface PurchaseCreateRequest {
  readonly requestKey: string;
  readonly url: string;
  readonly method?: string;
  readonly bodyBase64?: string;
  readonly mediaType?: string;
  readonly expectedMerchant?: Readonly<{
    id?: string;
    origin?: string;
  }>;
}

export interface SompiApiErrorBody {
  readonly error: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
}

export interface PurchaseApplication {
  purchase(input: PurchaseCreateRequest, signal?: AbortSignal): Promise<PurchaseView>;
  status(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView>;
  recover(purchaseId: string, signal?: AbortSignal): Promise<PurchaseView>;
}

export interface TransferCreateRequest {
  readonly requestKey: string;
  readonly destination: string;
  readonly amountKas: string;
}

export interface PolicyChangeCreateRequest {
  readonly requestKey: string;
  readonly maximumPerPaymentKas: string;
  readonly maximumPerHourKas: string;
}

export interface VaultMigrationCreateRequest {
  readonly requestKey: string;
  readonly vaultProtectionMaximumKas: string;
}

export interface SompiApplication extends PurchaseApplication {
  wallet(signal?: AbortSignal): Promise<WalletView>;
  walletTechnical(signal?: AbortSignal): Promise<WalletTechnicalView>;
  activity(limit: number, signal?: AbortSignal): Promise<readonly WalletActivityItem[]>;
  transfer(input: TransferCreateRequest, signal?: AbortSignal): Promise<TransferView>;
  transferStatus(transferId: string, signal?: AbortSignal): Promise<TransferView>;
  transferRecover(transferId: string, signal?: AbortSignal): Promise<TransferView>;
  changePolicy(input: PolicyChangeCreateRequest, signal?: AbortSignal): Promise<PolicyChangeView>;
  policyChangeStatus(policyChangeId: string, signal?: AbortSignal): Promise<PolicyChangeView>;
  policyChangeRecover(policyChangeId: string, signal?: AbortSignal): Promise<PolicyChangeView>;
  vaultMigration(input: VaultMigrationCreateRequest, signal?: AbortSignal): Promise<VaultMigrationView>;
  vaultMigrationStatus(vaultMigrationId: string, signal?: AbortSignal): Promise<VaultMigrationView>;
}

export const PURCHASE_CREATE_REQUEST_SCHEMA: JSONSchemaType<PurchaseCreateRequest> = {
  $id: "https://sompi.local/schemas/purchase-create-request.json",
  type: "object",
  additionalProperties: false,
  required: ["requestKey", "url"],
  properties: {
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    url: { type: "string", minLength: 1, maxLength: 2048, format: "uri" },
    method: {
      type: "string",
      pattern: "^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$",
      nullable: true,
    },
    bodyBase64: {
      type: "string",
      minLength: 4,
      maxLength: 1_398_104,
      pattern: BASE64_PATTERN,
      nullable: true,
    },
    mediaType: { type: "string", minLength: 1, maxLength: 200, nullable: true },
    expectedMerchant: {
      type: "object",
      additionalProperties: false,
      required: [],
      nullable: true,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 256, nullable: true },
        origin: { type: "string", minLength: 1, maxLength: 2048, format: "uri", nullable: true },
      },
    },
  },
};

export const PURCHASE_VIEW_SCHEMA = {
  $id: "https://sompi.local/schemas/purchase-view.json",
  type: "object",
  additionalProperties: false,
  required: [
    "id", "requestKey", "state", "summary", "resourceFingerprint",
    "authorization", "treasury", "paymentAttempts", "receiptEvidence",
  ],
  properties: {
    id: { type: "string", pattern: PURCHASE_ID_PATTERN },
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN },
    state: {
      enum: [
        "created", "terms_bound", "awaiting_authority", "authorised",
        "execution_prepared", "submitted", "settled", "fulfilled", "receipted",
        "denied", "cancelled", "expired", "failed_recoverable", "failed_terminal",
      ],
    },
    summary: { type: "string", minLength: 1, maxLength: 512 },
    userAction: { type: "string", minLength: 1, maxLength: 512 },
    resourceFingerprint: { type: "string", pattern: DIGEST_PATTERN },
    terms: {
      type: "object",
      additionalProperties: false,
      required: [
        "merchant", "resourceFingerprint", "amountAtomic", "asset", "network",
        "payTo", "expiresAt", "checkoutDigest",
      ],
      properties: {
        merchant: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "origin"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 256 },
            name: { type: "string", minLength: 1, maxLength: 256 },
            origin: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
        resourceFingerprint: { type: "string", pattern: DIGEST_PATTERN },
        amountAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 78 },
        asset: { type: "string", minLength: 1, maxLength: 64 },
        network: { type: "string", minLength: 1, maxLength: 128 },
        payTo: { type: "string", minLength: 1, maxLength: 256 },
        expiresAt: { type: "string", minLength: 1, maxLength: 100 },
        checkoutDigest: { type: "string", pattern: DIGEST_PATTERN },
      },
    },
    display: {
      type: "object",
      additionalProperties: false,
      required: ["price", "additionalCostCeiling", "maximumCharge"],
      properties: {
        price: KAS_AMOUNT_SCHEMA,
        additionalCostCeiling: KAS_AMOUNT_SCHEMA,
        maximumCharge: KAS_AMOUNT_SCHEMA,
      },
    },
    authorization: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { enum: ["not_requested", "pending", "approved", "denied", "expired"] },
        authorityId: { type: "string", minLength: 1, maxLength: 256 },
        evidenceDigest: { type: "string", pattern: DIGEST_PATTERN },
      },
    },
    treasury: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { enum: ["unreserved", "reserved", "committed", "released", "expired"] },
        amountAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 78 },
        additionalCostCeilingAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 78 },
        reservationId: { type: "string", minLength: 1, maxLength: 256 },
        fundingSource: { const: "vault-treasury" },
      },
    },
    paymentAttempts: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attempt", "identifier", "status", "evidenceDigests"],
        properties: {
          attempt: { type: "integer", minimum: 1, maximum: 0x7fffffff },
          identifier: { type: "string", minLength: 1, maxLength: 160 },
          status: { enum: ["planned", "prepared", "submitted", "observed", "failed"] },
          transactionId: { type: "string", minLength: 1, maxLength: 128 },
          finality: { type: "string", minLength: 1, maxLength: 100 },
          evidenceDigests: {
            type: "array",
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", pattern: DIGEST_PATTERN },
          },
        },
      },
    },
    settlementEvidence: { type: "string", pattern: DIGEST_PATTERN },
    fulfilmentDigest: { type: "string", pattern: DIGEST_PATTERN },
    receiptEvidence: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", pattern: DIGEST_PATTERN },
    },
    fulfilmentBody: { type: "string", maxLength: 8192 },
    fulfilmentHandle: { type: "string", minLength: 1, maxLength: 240 },
  },
} as const;

export const SOMPI_API_ERROR_SCHEMA: JSONSchemaType<SompiApiErrorBody> = {
  $id: "https://sompi.local/schemas/sompi-api-error.json",
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable"],
      properties: {
        code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,79}$", maxLength: 80 },
        message: { type: "string", minLength: 1, maxLength: 512 },
        retryable: { type: "boolean" },
      },
    },
  },
};

export const TRANSFER_CREATE_REQUEST_SCHEMA = {
  $id: "https://sompi.local/schemas/transfer-create-request.json",
  type: "object",
  additionalProperties: false,
  required: ["requestKey", "destination", "amountKas"],
  properties: {
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    destination: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    amountKas: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?$", maxLength: 32 },
  },
} as const;

export const POLICY_CHANGE_CREATE_REQUEST_SCHEMA = {
  $id: "https://sompi.local/schemas/policy-change-create-request.json",
  type: "object",
  additionalProperties: false,
  required: ["requestKey", "maximumPerPaymentKas", "maximumPerHourKas"],
  properties: {
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    maximumPerPaymentKas: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?$", maxLength: 32 },
    maximumPerHourKas: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?$", maxLength: 32 },
  },
} as const;

export const POLICY_CHANGE_VIEW_SCHEMA = {
  $id: "https://sompi.local/schemas/policy-change-view.json",
  type: "object",
  additionalProperties: false,
  required: [
    "id", "requestKey", "state", "summary", "previous", "proposed",
    "vaultProtectionMaximum", "everyPaymentRequiresApproval", "expiresAt",
  ],
  properties: {
    id: { type: "string", pattern: POLICY_CHANGE_ID_PATTERN },
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    state: { enum: ["created", "awaiting_authority", "authorised", "applied", "denied", "expired", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 512 },
    userAction: { type: "string", minLength: 1, maxLength: 512 },
    previous: {
      type: "object", additionalProperties: false,
      required: ["maximumPerPayment", "maximumPerHour"],
      properties: { maximumPerPayment: KAS_AMOUNT_SCHEMA, maximumPerHour: KAS_AMOUNT_SCHEMA },
    },
    proposed: {
      type: "object", additionalProperties: false,
      required: ["maximumPerPayment", "maximumPerHour"],
      properties: { maximumPerPayment: KAS_AMOUNT_SCHEMA, maximumPerHour: KAS_AMOUNT_SCHEMA },
    },
    vaultProtectionMaximum: KAS_AMOUNT_SCHEMA,
    everyPaymentRequiresApproval: { const: true },
    expiresAt: { type: "string", format: "date-time", maxLength: 40 },
    appliedPolicyDigest: { type: "string", pattern: DIGEST_PATTERN },
    appliedPolicyVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

export const VAULT_MIGRATION_CREATE_REQUEST_SCHEMA = {
  $id: "https://sompi.local/schemas/vault-migration-create-request.json",
  type: "object", additionalProperties: false,
  required: ["requestKey", "vaultProtectionMaximumKas"],
  properties: {
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    vaultProtectionMaximumKas: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?$", maxLength: 32 },
  },
} as const;

export const VAULT_MIGRATION_VIEW_SCHEMA = {
  $id: "https://sompi.local/schemas/vault-migration-view.json",
  type: "object", additionalProperties: false,
  required: ["id", "requestKey", "state", "summary", "previousVaultProtectionMaximum", "proposedVaultProtectionMaximum", "receiveAddressUnchanged", "requiresOfflineOwnerKey", "expiresAt"],
  properties: {
    id: { type: "string", pattern: VAULT_MIGRATION_ID_PATTERN },
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    state: { enum: ["created", "awaiting_authority", "awaiting_owner", "executing", "applied", "denied", "expired", "reconciliation_required", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 512 },
    userAction: { type: "string", minLength: 1, maxLength: 512 },
    previousVaultProtectionMaximum: KAS_AMOUNT_SCHEMA,
    proposedVaultProtectionMaximum: KAS_AMOUNT_SCHEMA,
    receiveAddressUnchanged: { const: true }, requiresOfflineOwnerKey: { const: true },
    expiresAt: { type: "string", format: "date-time", maxLength: 40 },
    recoveryTransactionId: { type: "string", pattern: "^[a-f0-9]{64}$" },
    replacementTransactionId: { type: "string", pattern: "^[a-f0-9]{64}$" },
    receiptDigest: { type: "string", pattern: DIGEST_PATTERN },
  },
} as const;

export const WALLET_TECHNICAL_VIEW_SCHEMA = {
  $id: "https://sompi.local/schemas/wallet-technical-view.json",
  type: "object", additionalProperties: false,
  required: ["receiveAddress", "activeVault", "allowlist"],
  properties: {
    receiveAddress: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    activeVault: { type: "object", additionalProperties: false,
      required: ["address", "maximumOutflowAtomic", "windowSizeDaa", "windowStartDaa", "spentInWindowAtomic"],
      properties: {
        address: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
        maximumOutflowAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
        windowSizeDaa: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
        windowStartDaa: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        spentInWindowAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        outpoint: { type: "object", additionalProperties: false, required: ["txid", "index"], properties: { txid: { type: "string", pattern: "^[a-f0-9]{64}$" }, index: { type: "integer", minimum: 0, maximum: 0xffffffff } } },
      },
    },
    allowlist: { type: "array", maxItems: 1024, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 300 } },
  },
} as const;

const TRANSFER_FACTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "profile", "transferId", "requestKey", "sourceVaultAddress", "sourceVaultDigest",
    "destination", "amountAtomic", "asset", "network", "feeCeilingAtomic",
    "maximumTotalAtomic", "expiresAt", "policyDigest", "operatorManifestRevision",
    "operatorManifestDigest", "finalityFloor",
  ],
  properties: {
    profile: { const: "sompi.transfer.1" },
    transferId: { type: "string", pattern: TRANSFER_ID_PATTERN },
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    sourceVaultAddress: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    sourceVaultDigest: { type: "string", pattern: DIGEST_PATTERN },
    destination: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    amountAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
    asset: { const: "KAS" },
    network: { const: "kaspa:testnet-10" },
    feeCeilingAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
    maximumTotalAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
    expiresAt: { type: "string", format: "date-time", maxLength: 40 },
    policyDigest: { type: "string", pattern: DIGEST_PATTERN },
    operatorManifestRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    operatorManifestDigest: { type: "string", pattern: DIGEST_PATTERN },
    finalityFloor: { enum: ["accepted", "depth-confirmed"] },
  },
} as const;

export const TRANSFER_VIEW_SCHEMA = {
  $id: "https://sompi.local/schemas/transfer-view.json",
  type: "object",
  additionalProperties: false,
  required: [
    "id", "requestKey", "requestDigest", "state", "summary", "display", "destination", "amountAtomic", "asset",
    "network", "sourceVaultAddress", "sourceVaultDigest", "feeCeilingAtomic", "maximumTotalAtomic",
    "expiresAtMs", "policyDigest", "manifestRevision", "manifestDigest", "finalityFloor", "version",
    "createdAtMs", "updatedAtMs", "recoveryRequired", "safeToRetry", "userAction",
  ],
  properties: {
    id: { type: "string", pattern: TRANSFER_ID_PATTERN },
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    requestDigest: { type: "string", pattern: DIGEST_PATTERN },
    state: { enum: TRANSFER_STATES },
    summary: { type: "string", minLength: 1, maxLength: 512 },
    display: {
      type: "object", additionalProperties: false,
      required: ["amount", "feeCeiling", "maximumTotal"],
      properties: {
        amount: KAS_AMOUNT_SCHEMA,
        feeCeiling: KAS_AMOUNT_SCHEMA,
        maximumTotal: KAS_AMOUNT_SCHEMA,
        actualFee: KAS_AMOUNT_SCHEMA,
      },
    },
    destination: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    amountAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
    asset: { const: "KAS" },
    network: { const: "kaspa:testnet-10" },
    sourceVaultAddress: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    sourceVaultDigest: { type: "string", pattern: DIGEST_PATTERN },
    feeCeilingAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
    maximumTotalAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
    expiresAtMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    policyDigest: { type: "string", pattern: DIGEST_PATTERN },
    manifestRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    manifestDigest: { type: "string", pattern: DIGEST_PATTERN },
    finalityFloor: { enum: ["accepted", "depth-confirmed"] },
    treasuryOperationKey: { type: "string", minLength: 1, maxLength: 256 },
    transactionId: { type: "string", pattern: "^[a-f0-9]{64}$" },
    actualFeeAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
    failureCode: { type: "string", minLength: 1, maxLength: 160 },
    version: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    createdAtMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    updatedAtMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    authorization: {
      type: "object",
      additionalProperties: false,
      required: [
        "transferId", "facts", "factsDigest", "decision", "authorityId", "evidenceDigest",
        "verificationProfile", "verifierId", "decidedAtMs", "expiresAtMs",
      ],
      properties: {
        transferId: { type: "string", pattern: TRANSFER_ID_PATTERN },
        facts: TRANSFER_FACTS_SCHEMA,
        factsDigest: { type: "string", pattern: DIGEST_PATTERN },
        decision: { enum: ["approved", "denied"] },
        authorityId: { type: "string", minLength: 1, maxLength: 256 },
        denialCode: { type: "string", minLength: 1, maxLength: 100 },
        evidenceDigest: { type: "string", pattern: DIGEST_PATTERN },
        verificationProfile: { type: "string", minLength: 1, maxLength: 256 },
        verifierId: { type: "string", minLength: 1, maxLength: 256 },
        decidedAtMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        expiresAtMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    receipt: {
      type: "object",
      additionalProperties: false,
      required: [
        "profile", "transferId", "requestKey", "destination", "amountAtomic", "feeAtomic",
        "network", "fundingSource", "fundingSummary", "transactionId", "finality", "settledAt",
      ],
      properties: {
        profile: { const: "urn:sompi:receipt:transfer:1" },
        transferId: { type: "string", pattern: TRANSFER_ID_PATTERN },
        requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
        destination: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
        amountAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
        feeAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        network: { const: "kaspa:testnet-10" },
        fundingSource: { const: "vault-treasury" },
        fundingSummary: { const: "Sent securely from your protected Sompi wallet." },
        transactionId: { type: "string", pattern: "^[a-f0-9]{64}$" },
        finality: { enum: ["accepted", "depth-confirmed"] },
        settledAt: { type: "string", format: "date-time", maxLength: 40 },
      },
    },
    recoveryRequired: { type: "boolean" },
    safeToRetry: { type: "boolean" },
    userAction: { enum: ["approve_or_deny", "wait", "recover", "none"] },
  },
} as const;

export const WALLET_VIEW_SCHEMA = {
  $id: "https://sompi.local/schemas/wallet-view.json",
  type: "object",
  additionalProperties: false,
  required: ["network", "asset", "receive", "balance", "securing", "spendingProtection", "chainStatus"],
  properties: {
    network: { const: "kaspa:testnet-10" },
    asset: { const: "KAS" },
    receive: {
      type: "object", additionalProperties: false,
      required: ["address", "qrPayload", "networkLabel", "warning"],
      properties: {
        address: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
        qrPayload: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
        networkLabel: { const: "Kaspa Testnet-10" },
        warning: { const: "Testnet funds only — do not send mainnet KAS." },
      },
    },
    balance: {
      type: "object", additionalProperties: false,
      required: ["total", "available", "incoming", "pending", "provenance", "observedAt"],
      properties: {
        total: KAS_AMOUNT_SCHEMA,
        available: KAS_AMOUNT_SCHEMA,
        incoming: KAS_AMOUNT_SCHEMA,
        pending: KAS_AMOUNT_SCHEMA,
        provenance: { const: "operator-node-and-local-vault-lineage" },
        observedAt: { type: "string", format: "date-time", maxLength: 40 },
      },
    },
    securing: {
      type: "object", additionalProperties: false,
      required: ["automatic", "state", "summary", "userAction", "minimumAmount"],
      properties: {
        automatic: { const: true },
        state: { enum: ["idle", "detected", "securing", "attention", "unavailable"] },
        summary: { type: "string", minLength: 1, maxLength: 512 },
        userAction: { enum: ["none", "wait", "operator"] },
        minimumAmount: KAS_AMOUNT_SCHEMA,
        operationId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,160}$" },
        transactionId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
    },
    spendingProtection: {
      type: "object", additionalProperties: false,
      required: ["maximumPerPayment", "maximumPerHour", "everyPaymentRequiresApproval", "vaultProtection"],
      properties: {
        maximumPerPayment: KAS_AMOUNT_SCHEMA,
        maximumPerHour: KAS_AMOUNT_SCHEMA,
        everyPaymentRequiresApproval: { const: true },
        vaultProtection: {
          type: "object", additionalProperties: false,
          required: ["maximumPerWindow", "remainingInWindow", "window", "summary"],
          properties: {
            maximumPerWindow: KAS_AMOUNT_SCHEMA,
            remainingInWindow: KAS_AMOUNT_SCHEMA,
            window: { const: "approximately 1 hour" },
            summary: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    chainStatus: { enum: ["observed", "unfunded", "unavailable"] },
  },
} as const;

export const WALLET_ACTIVITY_SCHEMA = {
  $id: "https://sompi.local/schemas/wallet-activity.json",
  type: "array",
  maxItems: 100,
  items: {
    type: "object", additionalProperties: false,
    required: ["kind", "direction", "id", "state", "summary", "occurredAt"],
    properties: {
      kind: { enum: ["incoming", "securing", "purchase", "transfer"] },
      direction: { enum: ["incoming", "internal", "outgoing"] },
      id: { type: "string", minLength: 1, maxLength: 160 },
      requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
      state: { type: "string", minLength: 1, maxLength: 64 },
      summary: { type: "string", minLength: 1, maxLength: 512 },
      amount: KAS_AMOUNT_SCHEMA,
      fee: KAS_AMOUNT_SCHEMA,
      counterparty: { type: "string", minLength: 1, maxLength: 2048 },
      transactionId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      occurredAt: { type: "string", format: "date-time", maxLength: 40 },
    },
  },
} as const;

const Ajv2020 = (
  (Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module
) as new (options?: AjvOptions) => Ajv2020Instance;
const ajv = new Ajv2020({ allErrors: true, strict: true });
(addFormatsModule as unknown as (instance: Ajv2020Instance) => void)(ajv);
const validateCreate = ajv.compile(PURCHASE_CREATE_REQUEST_SCHEMA);
const validateView = ajv.compile<PurchaseView>(PURCHASE_VIEW_SCHEMA);
const validateError = ajv.compile(SOMPI_API_ERROR_SCHEMA);
const validateTransferCreate = ajv.compile<TransferCreateRequest>(TRANSFER_CREATE_REQUEST_SCHEMA);
const validateTransferView = ajv.compile<TransferView>(TRANSFER_VIEW_SCHEMA);
const validatePolicyChangeCreate = ajv.compile<PolicyChangeCreateRequest>(POLICY_CHANGE_CREATE_REQUEST_SCHEMA);
const validatePolicyChangeView = ajv.compile<PolicyChangeView>(POLICY_CHANGE_VIEW_SCHEMA);
const validateVaultMigrationCreate = ajv.compile<VaultMigrationCreateRequest>(VAULT_MIGRATION_CREATE_REQUEST_SCHEMA);
const validateVaultMigrationView = ajv.compile<VaultMigrationView>(VAULT_MIGRATION_VIEW_SCHEMA);
const validateWalletView = ajv.compile<WalletView>(WALLET_VIEW_SCHEMA);
const validateWalletTechnicalView = ajv.compile<WalletTechnicalView>(WALLET_TECHNICAL_VIEW_SCHEMA);
const validateWalletActivity = ajv.compile<readonly WalletActivityItem[]>(WALLET_ACTIVITY_SCHEMA);

export class SompiApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SompiApiContractError";
  }
}

export function parsePurchaseCreateRequest(value: unknown): PurchaseCreateRequest {
  if (!validateCreate(value)) throw new SompiApiContractError("Purchase request does not match the canonical schema");
  const body = value.bodyBase64 === undefined ? undefined : strictBase64(value.bodyBase64);
  return Object.freeze({
    requestKey: assertPurchaseRequestKey(value.requestKey),
    url: canonicalUrl(value.url),
    method: value.method ?? "GET",
    ...(body === undefined ? {} : { bodyBase64: Buffer.from(body).toString("base64") }),
    ...(value.mediaType === undefined ? {} : { mediaType: boundedText(value.mediaType, "media type", 200) }),
    ...(value.expectedMerchant === undefined
      ? {}
      : {
          expectedMerchant: Object.freeze({
            ...(value.expectedMerchant.id === undefined
              ? {}
              : { id: boundedText(value.expectedMerchant.id, "expected Merchant id", 256) }),
            ...(value.expectedMerchant.origin === undefined
              ? {}
              : { origin: canonicalOrigin(value.expectedMerchant.origin) }),
          }),
        }),
  });
}

export function purchaseIntent(input: PurchaseCreateRequest): PurchaseIntent {
  const parsed = parsePurchaseCreateRequest(input);
  return Object.freeze({
    requestKey: assertPurchaseRequestKey(parsed.requestKey),
    resource: Object.freeze({
      url: parsed.url,
      method: parsed.method ?? "GET",
      ...(parsed.bodyBase64 === undefined
        ? {}
        : { body: Uint8Array.from(Buffer.from(parsed.bodyBase64, "base64")) }),
      ...(parsed.mediaType === undefined ? {} : { mediaType: parsed.mediaType }),
    }),
    ...(parsed.expectedMerchant === undefined
      ? {}
      : { expectedMerchant: Object.freeze({ ...parsed.expectedMerchant }) }),
  });
}

export function createPurchaseApplication(module: PurchaseModule): PurchaseApplication {
  return Object.freeze({
    purchase: async (input: PurchaseCreateRequest, signal?: AbortSignal) =>
      assertPurchaseView(await module.purchase(purchaseIntent(input), signal)),
    status: async (purchaseId: string, signal?: AbortSignal) =>
      assertPurchaseView(await module.status(assertPurchaseId(purchaseId), signal)),
    recover: async (purchaseId: string, signal?: AbortSignal) =>
      assertPurchaseView(await module.recover(assertPurchaseId(purchaseId), signal)),
  });
}

export function createSompiApplication(
  purchase: PurchaseModule,
  transfer: TransferModule,
  walletView: WalletViewModule,
  policyChange: PolicyChangeModule,
  vaultMigration: VaultMigrationModule,
): SompiApplication {
  const purchaseApplication = createPurchaseApplication(purchase);
  return Object.freeze({
    ...purchaseApplication,
    wallet: async () => assertWalletView(await walletView.wallet()),
    walletTechnical: async () => assertWalletTechnicalView(walletView.technical()),
    activity: async (limit: number) => assertWalletActivity(await walletView.activity(limit)),
    transfer: async (input: TransferCreateRequest, signal?: AbortSignal) =>
      assertTransferView(await transfer.transfer(transferIntent(input), signal)),
    transferStatus: async (transferId: string) => assertTransferView(transfer.status(assertTransferId(transferId))),
    transferRecover: async (transferId: string, signal?: AbortSignal) =>
      assertTransferView(await transfer.recover(assertTransferId(transferId), signal)),
    changePolicy: async (input: PolicyChangeCreateRequest, signal?: AbortSignal) => {
      const request = parsePolicyChangeCreateRequest(input);
      return assertPolicyChangeView(await policyChange.propose({
        requestKey: request.requestKey,
        maximumPerPaymentAtomic: parseKasAmount(request.maximumPerPaymentKas),
        maximumPerHourAtomic: parseKasAmount(request.maximumPerHourKas),
      }, signal));
    },
    policyChangeStatus: async (policyChangeId: string) =>
      assertPolicyChangeView(policyChange.status(assertPolicyChangeId(policyChangeId))),
    policyChangeRecover: async (policyChangeId: string, signal?: AbortSignal) =>
      assertPolicyChangeView(await policyChange.recover(assertPolicyChangeId(policyChangeId), signal)),
    vaultMigration: async (input: VaultMigrationCreateRequest, signal?: AbortSignal) => {
      const request = parseVaultMigrationCreateRequest(input);
      return assertVaultMigrationView(await vaultMigration.propose({
        requestKey: request.requestKey,
        newMaximumOutflowAtomic: parseKasAmount(request.vaultProtectionMaximumKas),
      }, signal));
    },
    vaultMigrationStatus: async (vaultMigrationId: string) =>
      assertVaultMigrationView(vaultMigration.status(assertVaultMigrationId(vaultMigrationId))),
  });
}

export function parseVaultMigrationCreateRequest(value: unknown): VaultMigrationCreateRequest {
  if (!validateVaultMigrationCreate(value)) throw new SompiApiContractError("Vault Migration request does not match the canonical schema");
  try { if (BigInt(parseKasAmount(value.vaultProtectionMaximumKas)) <= 0n) throw new Error("zero"); }
  catch { throw new SompiApiContractError("Vault Migration request does not match the canonical schema"); }
  return Object.freeze({ ...value });
}

export function assertVaultMigrationView(value: unknown): VaultMigrationView {
  if (!validateVaultMigrationView(value)) throw new SompiApiContractError("Vault Migration response does not match the canonical schema");
  return value as VaultMigrationView;
}

export function assertVaultMigrationId(value: string): string {
  if (!/^vmg_[A-Za-z0-9_-]{22}$/.test(value)) throw new SompiApiContractError("Vault Migration ID is invalid");
  return value;
}

export function assertWalletTechnicalView(value: unknown): WalletTechnicalView {
  if (!validateWalletTechnicalView(value)) throw new SompiApiContractError("Wallet technical response does not match the canonical schema");
  return value as WalletTechnicalView;
}

export function parsePolicyChangeCreateRequest(value: unknown): PolicyChangeCreateRequest {
  if (!validatePolicyChangeCreate(value)) {
    throw new SompiApiContractError("Policy Change request does not match the canonical schema");
  }
  try {
    if (BigInt(parseKasAmount(value.maximumPerPaymentKas)) <= 0n || BigInt(parseKasAmount(value.maximumPerHourKas)) <= 0n) {
      throw new Error("zero");
    }
  } catch {
    throw new SompiApiContractError("Policy Change request does not match the canonical schema");
  }
  return Object.freeze({ ...value });
}

export function assertPolicyChangeView(value: unknown): PolicyChangeView {
  if (!validatePolicyChangeView(value)) {
    throw new SompiApiContractError("Policy Change response does not match the canonical schema");
  }
  return value as PolicyChangeView;
}

export function assertPolicyChangeId(value: string): string {
  if (typeof value !== "string" || !/^pcg_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new SompiApiContractError("Policy Change ID is invalid");
  }
  return value;
}

export function parseTransferCreateRequest(value: unknown): TransferCreateRequest {
  if (!validateTransferCreate(value)) {
    throw new SompiApiContractError("Transfer request does not match the canonical schema");
  }
  try {
    parseKasAmount(value.amountKas);
  } catch {
    throw new SompiApiContractError("Transfer request does not match the canonical schema");
  }
  return Object.freeze({
    requestKey: value.requestKey,
    destination: value.destination,
    amountKas: value.amountKas,
  });
}

export function transferIntent(value: unknown): TransferIntent {
  const request = parseTransferCreateRequest(value);
  return Object.freeze({
    requestKey: request.requestKey,
    destination: request.destination,
    amountAtomic: parseKasAmount(request.amountKas),
  });
}

export function assertTransferView(value: unknown): TransferView {
  if (!validateTransferView(value)) throw new SompiApiContractError("Transfer response does not match the canonical schema");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SOMPI_API_RESPONSE_BYTES) {
    throw new SompiApiContractError("Transfer response exceeds the canonical size limit");
  }
  return value as TransferView;
}

export function assertWalletView(value: unknown): WalletView {
  if (!validateWalletView(value)) throw new SompiApiContractError("Wallet response does not match the canonical schema");
  return value as WalletView;
}

export function assertWalletActivity(value: unknown): readonly WalletActivityItem[] {
  if (!validateWalletActivity(value)) throw new SompiApiContractError("Wallet activity does not match the canonical schema");
  return value as readonly WalletActivityItem[];
}

export function assertTransferId(value: string): string {
  if (typeof value !== "string" || !/^trf_[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new SompiApiContractError("Transfer ID is invalid");
  }
  return value;
}

export function assertPurchaseView(value: unknown): PurchaseView {
  if (!validateView(value)) {
    const detail = ajv.errorsText(validateView.errors, { separator: "; " });
    throw new SompiApiContractError(
      `Purchase response does not match the canonical schema: ${detail}`
    );
  }
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > MAX_SOMPI_API_RESPONSE_BYTES) {
    throw new SompiApiContractError("Purchase response exceeds the canonical size limit");
  }
  return value;
}

export function assertSompiApiError(value: unknown): SompiApiErrorBody {
  if (!validateError(value)) throw new SompiApiContractError("Purchase error does not match the canonical schema");
  return value;
}

function strictBase64(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_PURCHASE_BODY_BYTES || decoded.toString("base64") !== value) {
    throw new SompiApiContractError("Purchase body must be canonical padded base64 and at most 1 MiB");
  }
  return Uint8Array.from(decoded);
}

function canonicalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SompiApiContractError("Purchase URL is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.href !== value) {
    throw new SompiApiContractError("Purchase URL must be canonical HTTP without credentials");
  }
  return value;
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SompiApiContractError("expected Merchant origin is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.origin !== value) {
    throw new SompiApiContractError("expected Merchant origin must be canonical HTTP");
  }
  return value;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SompiApiContractError(`${label} is invalid`);
  }
  return value;
}
