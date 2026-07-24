import {
  SOMPI_API_ERROR_SCHEMA,
  SOMPI_API_VERSION,
} from "./contracts.js";
import {
  SOMPI_OPERATIONS,
  type SompiOperationContract,
} from "./operation-contract.js";

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
    paths: sompiOpenApiPaths(),
    components: {
      securitySchemes: {
        AgentCredential: { type: "http", scheme: "bearer", bearerFormat: SOMPI_API_VERSION },
      },
      schemas: sompiOpenApiSchemas(),
    },
  });
}

export function canonicalOpenApiBytes(version: string): Buffer {
  return Buffer.from(`${JSON.stringify(sompiOpenApiDocument(version), null, 2)}\n`, "utf8");
}

function sompiOpenApiPaths(): Readonly<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of SOMPI_OPERATIONS) {
    const projection: Record<string, unknown> = {
      operationId: operation.operationId,
      summary: operation.summary,
      ...(operation.parameters.length === 0
        ? {}
        : { parameters: operation.parameters }),
      ...(operation.requestSchemaName === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    $ref: `#/components/schemas/${operation.requestSchemaName}`,
                  },
                },
              },
            },
          }),
      responses: operationResponses(operation),
    };
    const path = paths[operation.pathTemplate] ?? {};
    path[operation.method.toLowerCase()] = Object.freeze(projection);
    paths[operation.pathTemplate] = path;
  }
  return Object.freeze(paths);
}

function operationResponses(
  operation: SompiOperationContract,
): Readonly<Record<string, unknown>> {
  const error = {
    description: "Bounded structured error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/SompiApiError" } } },
  };
  const responses: Record<string, unknown> = {
    "200": {
      description: operation.successDescription,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${operation.responseSchemaName}` },
        },
      },
    },
  };
  for (const status of operation.errorStatuses) responses[String(status)] = error;
  return Object.freeze(responses);
}

function sompiOpenApiSchemas(): Readonly<Record<string, unknown>> {
  const schemas: Record<string, unknown> = {
    SompiApiError: withoutId(SOMPI_API_ERROR_SCHEMA),
  };
  for (const operation of SOMPI_OPERATIONS) {
    if (operation.requestSchemaName !== undefined && operation.requestSchema !== undefined) {
      addSchema(schemas, operation.requestSchemaName, operation.requestSchema);
    }
    addSchema(schemas, operation.responseSchemaName, operation.responseSchema);
  }
  return Object.freeze(schemas);
}

function addSchema(
  schemas: Record<string, unknown>,
  name: string,
  schema: Readonly<Record<string, unknown>>,
): void {
  const projection = withoutId(schema);
  const existing = schemas[name];
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(projection)) {
    throw new Error(`Sompi operation schema ${name} has conflicting definitions`);
  }
  schemas[name] = projection;
}

function withoutId<T extends object>(schema: T): Omit<T, "$id"> {
  const { $id: _id, ...rest } = schema as T & { readonly $id?: unknown };
  return rest;
}
