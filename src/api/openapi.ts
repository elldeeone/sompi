import {
  SOMPI_API_ERROR_SCHEMA,
  SOMPI_API_VERSION,
  PURCHASE_CREATE_REQUEST_SCHEMA,
  PURCHASE_VIEW_SCHEMA,
  TRANSFER_CREATE_REQUEST_SCHEMA,
  TRANSFER_VIEW_SCHEMA,
  WALLET_ACTIVITY_SCHEMA,
  WALLET_VIEW_SCHEMA,
} from "./contracts.js";

export const SOMPI_OPENAPI_VERSION = "3.2.0" as const;

/** Canonical generated description of Sompi's least-authority agent API. */
export function sompiOpenApiDocument(version: string): Readonly<Record<string, unknown>> {
  if (!version || version.length > 100 || /[\u0000-\u001f\u007f]/.test(version)) {
    throw new Error("Sompi API version is invalid");
  }
  return Object.freeze({
    openapi: SOMPI_OPENAPI_VERSION,
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Sompi API",
      version,
      description: "Authenticated wallet view, direct KAS Transfer, and protocol-neutral Purchase lifecycles for Sompi.",
    },
    security: [{ AgentCredential: [] }],
    paths: {
      "/purchases": {
        post: {
          operationId: "createPurchase",
          summary: "Create or idempotently resume a Purchase",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/PurchaseCreateRequest" } } },
          },
          responses: purchaseResponses("Purchase state"),
        },
      },
      "/purchases/{purchaseId}": {
        get: {
          operationId: "getPurchase",
          summary: "Read a durable Purchase without an external side effect",
          parameters: [purchaseIdParameter()],
          responses: purchaseResponses("Purchase state"),
        },
      },
      "/purchases/{purchaseId}/recover": {
        post: {
          operationId: "recoverPurchase",
          summary: "Reconcile a Purchase without blind resubmission",
          parameters: [purchaseIdParameter()],
          responses: purchaseResponses("Reconciled Purchase state"),
        },
      },
      "/wallet": {
        get: {
          operationId: "getWallet",
          summary: "Read the receive address, useful balances, deposit status, and spending limits",
          responses: apiResponses("Wallet state", "WalletView"),
        },
      },
      "/wallet/activity": {
        get: {
          operationId: "listWalletActivity",
          summary: "List recent deposits, securing operations, Purchases, and Transfers",
          parameters: [{
            name: "limit", in: "query", required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          }],
          responses: apiResponses("Wallet activity", "WalletActivity"),
        },
      },
      "/transfers": {
        post: {
          operationId: "createTransfer",
          summary: "Create or idempotently resume a human-approved direct KAS Transfer",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/TransferCreateRequest" } } },
          },
          responses: apiResponses("Transfer state", "TransferView"),
        },
      },
      "/transfers/{transferId}": {
        get: {
          operationId: "getTransfer",
          summary: "Read a durable Transfer without an external side effect",
          parameters: [transferIdParameter()],
          responses: apiResponses("Transfer state", "TransferView"),
        },
      },
      "/transfers/{transferId}/recover": {
        post: {
          operationId: "recoverTransfer",
          summary: "Reconcile a Transfer without replacement authorization or payment",
          parameters: [transferIdParameter()],
          responses: apiResponses("Reconciled Transfer state", "TransferView"),
        },
      },
    },
    components: {
      securitySchemes: {
        AgentCredential: { type: "http", scheme: "bearer", bearerFormat: SOMPI_API_VERSION },
      },
      schemas: {
        PurchaseCreateRequest: withoutId(PURCHASE_CREATE_REQUEST_SCHEMA),
        PurchaseView: withoutId(PURCHASE_VIEW_SCHEMA),
        SompiApiError: withoutId(SOMPI_API_ERROR_SCHEMA),
        TransferCreateRequest: withoutId(TRANSFER_CREATE_REQUEST_SCHEMA),
        TransferView: withoutId(TRANSFER_VIEW_SCHEMA),
        WalletView: withoutId(WALLET_VIEW_SCHEMA),
        WalletActivity: withoutId(WALLET_ACTIVITY_SCHEMA),
      },
    },
  });
}

export function canonicalOpenApiBytes(version: string): Buffer {
  return Buffer.from(`${JSON.stringify(sompiOpenApiDocument(version), null, 2)}\n`, "utf8");
}

function purchaseIdParameter(): Readonly<Record<string, unknown>> {
  return {
    name: "purchaseId",
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^pur_[A-Za-z0-9_-]{22}$" },
  };
}

function purchaseResponses(description: string): Readonly<Record<string, unknown>> {
  return apiResponses(description, "PurchaseView");
}

function transferIdParameter(): Readonly<Record<string, unknown>> {
  return {
    name: "transferId", in: "path", required: true,
    schema: { type: "string", pattern: "^trf_[A-Za-z0-9_-]{22}$" },
  };
}

function apiResponses(description: string, schema: string): Readonly<Record<string, unknown>> {
  const error = {
    description: "Bounded structured error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/SompiApiError" } } },
  };
  return {
    "200": {
      description,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
    },
    "400": error,
    "401": error,
    "404": error,
    "409": error,
    "413": error,
    "429": error,
    "500": error,
    "504": error,
  };
}

function withoutId<T extends object>(schema: T): Omit<T, "$id"> {
  const { $id: _id, ...rest } = schema as T & { readonly $id?: unknown };
  return rest;
}
