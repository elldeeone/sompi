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
import type { WalletActivityItem, WalletView, WalletViewModule } from "../wallet-view/module.js";

export const SOMPI_API_VERSION = "sompi-agent-api-v1" as const;
export const MAX_SOMPI_API_BODY_BYTES = 1_500_000;
export const MAX_PURCHASE_BODY_BYTES = 1024 * 1024;
export const MAX_SOMPI_API_RESPONSE_BYTES = 64 * 1024;

const PURCHASE_ID_PATTERN = "^pur_[A-Za-z0-9_-]{22}$";
const TRANSFER_ID_PATTERN = "^trf_[A-Za-z0-9_-]{22}$";
const REQUEST_KEY_PATTERN = "^[A-Za-z0-9._:-]{1,160}$";
const DIGEST_PATTERN = "^sha256:[A-Za-z0-9_-]{43}$";
const POSITIVE_ATOMIC_PATTERN = "^[1-9][0-9]*$";
const NONNEGATIVE_ATOMIC_PATTERN = "^(?:0|[1-9][0-9]*)$";
const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

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
  readonly amountAtomic: string;
}

export interface SompiApplication extends PurchaseApplication {
  wallet(signal?: AbortSignal): Promise<WalletView>;
  activity(limit: number, signal?: AbortSignal): Promise<readonly WalletActivityItem[]>;
  transfer(input: TransferCreateRequest, signal?: AbortSignal): Promise<TransferView>;
  transferStatus(transferId: string, signal?: AbortSignal): Promise<TransferView>;
  transferRecover(transferId: string, signal?: AbortSignal): Promise<TransferView>;
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
  $id: "https://sompi.local/schemas/purchase-api-error.json",
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
  required: ["requestKey", "destination", "amountAtomic"],
  properties: {
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    destination: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    amountAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
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
    "id", "requestKey", "requestDigest", "state", "destination", "amountAtomic", "asset",
    "network", "sourceVaultAddress", "sourceVaultDigest", "feeCeilingAtomic", "maximumTotalAtomic",
    "expiresAtMs", "policyDigest", "manifestRevision", "manifestDigest", "finalityFloor", "version",
    "createdAtMs", "updatedAtMs", "recoveryRequired", "safeToRetry", "userAction",
  ],
  properties: {
    id: { type: "string", pattern: TRANSFER_ID_PATTERN },
    requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
    requestDigest: { type: "string", pattern: DIGEST_PATTERN },
    state: { enum: TRANSFER_STATES },
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
        "network", "fundingSource", "transactionId", "finality", "settledAt",
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
  required: ["network", "asset", "fundingAddress", "vaultAddress", "balance", "limits", "chainStatus"],
  properties: {
    network: { const: "kaspa:testnet-10" },
    asset: { const: "KAS" },
    fundingAddress: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    vaultAddress: { type: "string", pattern: "^kaspatest:[a-z0-9]{20,256}$", maxLength: 266 },
    vaultOutpoint: {
      type: "object", additionalProperties: false, required: ["txid", "index"],
      properties: {
        txid: { type: "string", pattern: "^[a-f0-9]{64}$" },
        index: { type: "integer", minimum: 0, maximum: 0xffffffff },
      },
    },
    balance: {
      type: "object", additionalProperties: false,
      required: ["observedAtomic", "unboundAtomic", "reservedAtomic", "availableAtomic", "provenance", "observedAt"],
      properties: {
        observedAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        unboundAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        reservedAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        availableAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        provenance: { const: "operator-node-and-local-vault-lineage" },
        observedAt: { type: "string", format: "date-time", maxLength: 40 },
      },
    },
    limits: {
      type: "object", additionalProperties: false,
      required: ["maxPerTransferAtomic", "maxPerHourAtomic", "approvalThresholdAtomic", "allowlist", "vaultMaxOutflowAtomic", "vaultWindowSizeDaa", "vaultSpentInWindowAtomic"],
      properties: {
        maxPerTransferAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        maxPerHourAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        approvalThresholdAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        allowlist: { type: "array", maxItems: 1_000, uniqueItems: true, items: { type: "string", maxLength: 266 } },
        vaultMaxOutflowAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
        vaultWindowSizeDaa: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
        vaultSpentInWindowAtomic: { type: "string", pattern: NONNEGATIVE_ATOMIC_PATTERN, maxLength: 20 },
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
    required: ["kind", "id", "requestKey", "state", "createdAt", "updatedAt"],
    properties: {
      kind: { enum: ["purchase", "transfer"] },
      id: { type: "string", pattern: "^(?:pur|trf)_[A-Za-z0-9_-]{22}$" },
      requestKey: { type: "string", pattern: REQUEST_KEY_PATTERN, maxLength: 160 },
      state: { type: "string", minLength: 1, maxLength: 64 },
      amountAtomic: { type: "string", pattern: POSITIVE_ATOMIC_PATTERN, maxLength: 20 },
      counterparty: { type: "string", minLength: 1, maxLength: 2048 },
      transactionId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      createdAt: { type: "string", format: "date-time", maxLength: 40 },
      updatedAt: { type: "string", format: "date-time", maxLength: 40 },
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
const validateWalletView = ajv.compile<WalletView>(WALLET_VIEW_SCHEMA);
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
): SompiApplication {
  const purchaseApplication = createPurchaseApplication(purchase);
  return Object.freeze({
    ...purchaseApplication,
    wallet: async () => assertWalletView(await walletView.wallet()),
    activity: async (limit: number) => assertWalletActivity(walletView.activity(limit)),
    transfer: async (input: TransferCreateRequest, signal?: AbortSignal) =>
      assertTransferView(await transfer.transfer(transferIntent(input), signal)),
    transferStatus: async (transferId: string) => assertTransferView(transfer.status(assertTransferId(transferId))),
    transferRecover: async (transferId: string, signal?: AbortSignal) =>
      assertTransferView(await transfer.recover(assertTransferId(transferId), signal)),
  });
}

export function parseTransferCreateRequest(value: unknown): TransferCreateRequest {
  if (!validateTransferCreate(value) || BigInt(value.amountAtomic) > (1n << 64n) - 1n) {
    throw new SompiApiContractError("Transfer request does not match the canonical schema");
  }
  return Object.freeze({
    requestKey: value.requestKey,
    destination: value.destination,
    amountAtomic: value.amountAtomic,
  });
}

export function transferIntent(value: unknown): TransferIntent {
  return parseTransferCreateRequest(value);
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
