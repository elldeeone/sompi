import * as fs from "node:fs";
import { createHash } from "node:crypto";

import * as Ajv2020Module from "ajv/dist/2020.js";
import type { Ajv2020 as Ajv2020Instance, Options as AjvOptions } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { PURCHASE_CREATE_REQUEST_SCHEMA } from "./contracts.js";
import { sompiOpenApiDocument } from "./openapi.js";

export const SOMPI_ARAZZO_VERSION = "1.1.0" as const;
export const SOMPI_ARAZZO_SCHEMA_REVISION = "2026-04-15" as const;
export const SOMPI_ARAZZO_SCHEMA_SHA256 =
  "37be908409bdb2f7bffe61fa23685c7e84cbeebfafac475a1d01dbc50ff7ab9e" as const;

type JsonObject = Record<string, unknown>;

/** Canonical workflow for recovering one interrupted Purchase through the HTTP API. */
export function sompiArazzoDocument(version: string): Readonly<JsonObject> {
  assertVersion(version);
  return Object.freeze({
    arazzo: SOMPI_ARAZZO_VERSION,
    info: {
      title: "Sompi interrupted Purchase recovery",
      summary: "Create, inspect, recover, and verify a terminal Purchase receipt.",
      description:
        "Uses only the authenticated, protocol-neutral Sompi Purchase API. " +
        "The recovery step reconciles durable evidence and never authorizes blind resubmission.",
      version,
    },
    sourceDescriptions: [
      { name: "sompi", url: "./sompi.openapi.json", type: "openapi" },
    ],
    workflows: [
      {
        workflowId: "recoverInterruptedPurchase",
        summary: "Recover a Purchase that stopped in a recoverable state",
        description:
          "The scenario expects createPurchase to return a durable Purchase identity, " +
          "confirms a recoverable interruption, invokes explicit recovery once, and then " +
          "reads a terminal receipted state.",
        inputs: withoutId(PURCHASE_CREATE_REQUEST_SCHEMA),
        steps: [
          {
            stepId: "createPurchase",
            operationId: "$sourceDescriptions.sompi.createPurchase",
            requestBody: { contentType: "application/json", payload: "$inputs" },
            successCriteria: [{ condition: "$statusCode == 200" }],
            outputs: { purchaseId: "$response.body#/id" },
          },
          {
            stepId: "inspectRecoverablePurchase",
            operationId: "$sourceDescriptions.sompi.getPurchase",
            parameters: [
              {
                name: "purchaseId",
                in: "path",
                value: "$steps.createPurchase.outputs.purchaseId",
              },
            ],
            successCriteria: [
              { condition: "$statusCode == 200" },
              { condition: "$response.body#/state == 'failed_recoverable'" },
            ],
          },
          {
            stepId: "recoverPurchase",
            operationId: "$sourceDescriptions.sompi.recoverPurchase",
            parameters: [
              {
                name: "purchaseId",
                in: "path",
                value: "$steps.createPurchase.outputs.purchaseId",
              },
            ],
            successCriteria: [{ condition: "$statusCode == 200" }],
          },
          {
            stepId: "readTerminalReceipt",
            operationId: "$sourceDescriptions.sompi.getPurchase",
            parameters: [
              {
                name: "purchaseId",
                in: "path",
                value: "$steps.createPurchase.outputs.purchaseId",
              },
            ],
            successCriteria: [
              { condition: "$statusCode == 200" },
              { condition: "$response.body#/state == 'receipted'" },
              {
                context: "$response.body",
                condition: "$.receiptEvidence[*]",
                type: "jsonpath",
              },
            ],
            outputs: {
              purchase: "$response.body",
              receiptEvidence: "$response.body#/receiptEvidence",
            },
          },
        ],
        outputs: {
          purchaseId: "$steps.createPurchase.outputs.purchaseId",
          purchase: "$steps.readTerminalReceipt.outputs.purchase",
          receiptEvidence: "$steps.readTerminalReceipt.outputs.receiptEvidence",
        },
      },
    ],
  });
}

export function canonicalArazzoBytes(version: string): Buffer {
  return Buffer.from(`${JSON.stringify(sompiArazzoDocument(version), null, 2)}\n`, "utf8");
}

/** Validate the Arazzo shape and resolve every operation against canonical OpenAPI. */
export function validateSompiArazzoDocument(
  document: unknown,
  openApiDocument: unknown,
): void {
  const validate = officialArazzoValidator();
  if (!validate(document)) {
    throw new Error(`Arazzo document is invalid: ${formatErrors(validate.errors)}`);
  }
  if (!isRecord(document) || !Array.isArray(document.sourceDescriptions)) {
    throw new Error("Arazzo document does not contain source descriptions");
  }
  const source = document.sourceDescriptions.find(
    (candidate) => isRecord(candidate) && candidate.name === "sompi",
  );
  if (!isRecord(source) || source.url !== "./sompi.openapi.json" || source.type !== "openapi") {
    throw new Error("Arazzo source must resolve the canonical Sompi OpenAPI document");
  }

  const operations = openApiOperations(openApiDocument);
  if (!Array.isArray(document.workflows)) throw new Error("Arazzo workflows are missing");
  for (const workflow of document.workflows) {
    if (!isRecord(workflow) || !Array.isArray(workflow.steps)) {
      throw new Error("Arazzo workflow steps are malformed");
    }
    for (const step of workflow.steps) {
      if (!isRecord(step) || typeof step.operationId !== "string") {
        throw new Error("Sompi Arazzo steps must resolve OpenAPI operationIds");
      }
      const prefix = "$sourceDescriptions.sompi.";
      if (!step.operationId.startsWith(prefix)) {
        throw new Error("Arazzo step references an unknown source description");
      }
      const operationId = step.operationId.slice(prefix.length);
      const operation = operations.get(operationId);
      if (!operation) {
        throw new Error(`Arazzo step references unknown OpenAPI operationId ${operationId}`);
      }
      assertStepMatchesOperation(step, operationId, operation);
    }
  }
}

export function validateGeneratedSompiArazzo(version: string): void {
  validateSompiArazzoDocument(sompiArazzoDocument(version), sompiOpenApiDocument(version));
}

function officialArazzoValidator(): ReturnType<Ajv2020Instance["compile"]> {
  const filename = new URL(
    `../../vendor/arazzo-v1.1-schema/${SOMPI_ARAZZO_SCHEMA_REVISION}.json`,
    import.meta.url,
  );
  const bytes = fs.readFileSync(filename);
  try {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== SOMPI_ARAZZO_SCHEMA_SHA256) {
      throw new Error("pinned Arazzo schema digest does not match its reviewed revision");
    }
    const schema = JSON.parse(bytes.toString("utf8"));
    const Ajv2020 = (
      (Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module
    ) as new (options?: AjvOptions) => Ajv2020Instance;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    (addFormatsModule as unknown as (instance: Ajv2020Instance) => void)(ajv);
    return ajv.compile(schema);
  } finally {
    bytes.fill(0);
  }
}

function openApiOperations(document: unknown): ReadonlyMap<string, JsonObject> {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error("canonical OpenAPI paths are missing");
  }
  const operations = new Map<string, JsonObject>();
  for (const pathItem of Object.values(document.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const operation of Object.values(pathItem)) {
      if (isRecord(operation) && typeof operation.operationId === "string") {
        if (operations.has(operation.operationId)) {
          throw new Error(`duplicate OpenAPI operationId ${operation.operationId}`);
        }
        operations.set(operation.operationId, operation);
      }
    }
  }
  return operations;
}

function assertStepMatchesOperation(
  step: JsonObject,
  operationId: string,
  operation: JsonObject,
): void {
  const requiredParameters = Array.isArray(operation.parameters)
    ? operation.parameters.filter(
        (parameter): parameter is JsonObject => isRecord(parameter) && parameter.required === true,
      )
    : [];
  const suppliedParameters = Array.isArray(step.parameters)
    ? step.parameters.filter(isRecord)
    : [];
  for (const required of requiredParameters) {
    const match = suppliedParameters.find(
      (parameter) => parameter.name === required.name && parameter.in === required.in,
    );
    if (!match || typeof match.value !== "string" || match.value.length === 0) {
      throw new Error(`Arazzo step ${operationId} omits required OpenAPI parameter ${String(required.name)}`);
    }
  }
  if (isRecord(operation.requestBody) && operation.requestBody.required === true) {
    if (!isRecord(step.requestBody) || step.requestBody.contentType !== "application/json") {
      throw new Error(`Arazzo step ${operationId} omits its required JSON request body`);
    }
  }
}

function formatErrors(errors: null | undefined | ReadonlyArray<{ instancePath?: string; message?: string }>): string {
  if (!errors?.length) return "unknown schema failure";
  return errors.map((error) => `${error.instancePath || "/"} ${error.message || "invalid"}`).join("; ");
}

function assertVersion(version: string): void {
  if (!version || version.length > 100 || /[\u0000-\u001f\u007f]/.test(version)) {
    throw new Error("Sompi workflow version is invalid");
  }
}

function withoutId<T extends object>(schema: T): Omit<T, "$id"> {
  const { $id: _id, ...rest } = schema as T & { readonly $id?: unknown };
  return rest;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
