import {
  PURCHASE_API_ERROR_SCHEMA,
  PURCHASE_API_VERSION,
  PURCHASE_CREATE_REQUEST_SCHEMA,
  PURCHASE_VIEW_SCHEMA,
} from "./contracts.js";

export const SOMPI_OPENAPI_VERSION = "3.2.0" as const;

/** The canonical, generated description of Sompi's public Purchase seam. */
export function sompiOpenApiDocument(version: string): Readonly<Record<string, unknown>> {
  if (!version || version.length > 100 || /[\u0000-\u001f\u007f]/.test(version)) {
    throw new Error("Sompi API version is invalid");
  }
  return Object.freeze({
    openapi: SOMPI_OPENAPI_VERSION,
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Sompi Purchase API",
      version,
      description: "Authenticated, protocol-neutral Purchase lifecycle for Sompi.",
    },
    servers: [{ url: "http://127.0.0.1:7442", description: "Default local service" }],
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
    },
    components: {
      securitySchemes: {
        AgentCredential: { type: "http", scheme: "bearer", bearerFormat: PURCHASE_API_VERSION },
      },
      schemas: {
        PurchaseCreateRequest: withoutId(PURCHASE_CREATE_REQUEST_SCHEMA),
        PurchaseView: withoutId(PURCHASE_VIEW_SCHEMA),
        PurchaseApiError: withoutId(PURCHASE_API_ERROR_SCHEMA),
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
  const error = {
    description: "Bounded structured error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/PurchaseApiError" } } },
  };
  return {
    "200": {
      description,
      content: { "application/json": { schema: { $ref: "#/components/schemas/PurchaseView" } } },
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
