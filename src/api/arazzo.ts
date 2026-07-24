import * as fs from "node:fs";
import { createHash } from "node:crypto";

import * as Ajv2020Module from "ajv/dist/2020.js";
import type { Ajv2020 as Ajv2020Instance, Options as AjvOptions } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import {
  sompiArazzoOperationReference,
  sompiOperationRequestSchema,
} from "./operation-contract.js";
import { sompiOpenApiDocument } from "./openapi.js";

export const SOMPI_ARAZZO_VERSION = "1.1.0" as const;
export const SOMPI_ARAZZO_SCHEMA_REVISION = "2026-04-15" as const;
export const SOMPI_ARAZZO_SCHEMA_SHA256 =
  "37be908409bdb2f7bffe61fa23685c7e84cbeebfafac475a1d01dbc50ff7ab9e" as const;

type JsonObject = Record<string, unknown>;

/** Canonical recovery workflows for Sompi's durable mutation lifecycles. */
export function sompiArazzoDocument(version: string): Readonly<JsonObject> {
  assertVersion(version);
  return Object.freeze({
    arazzo: SOMPI_ARAZZO_VERSION,
    info: {
      title: "Sompi recovery workflows",
      summary: "Operate and recover Sompi wallet, Transfer, Purchase, and protection changes.",
      description:
        "Uses only the authenticated, protocol-neutral Sompi API. " +
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
        inputs: sompiOperationRequestSchema("createPurchase"),
        steps: [
          {
            stepId: "createPurchase",
            operationId: sompiArazzoOperationReference("createPurchase"),
            requestBody: { contentType: "application/json", payload: "$inputs" },
            successCriteria: [{ condition: "$statusCode == 200" }],
            outputs: { purchaseId: "$response.body#/id" },
          },
          {
            stepId: "inspectRecoverablePurchase",
            operationId: sompiArazzoOperationReference("getPurchase"),
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
            operationId: sompiArazzoOperationReference("recoverPurchase"),
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
            operationId: sompiArazzoOperationReference("getPurchase"),
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
      {
        workflowId: "recoverInterruptedTransfer",
        summary: "Send KAS with human approval and recover an interrupted Transfer",
        description:
          "Creates one durable direct Transfer, reads its status, invokes idempotent recovery when needed, " +
          "and reads the same Transfer receipt. Recovery cannot create replacement authorization or payment.",
        inputs: sompiOperationRequestSchema("createTransfer"),
        steps: [
          {
            stepId: "createTransfer",
            operationId: sompiArazzoOperationReference("createTransfer"),
            requestBody: { contentType: "application/json", payload: "$inputs" },
            successCriteria: [{ condition: "$statusCode == 200" }],
            outputs: { transferId: "$response.body#/id" },
          },
          {
            stepId: "inspectTransfer",
            operationId: sompiArazzoOperationReference("getTransfer"),
            parameters: [{ name: "transferId", in: "path", value: "$steps.createTransfer.outputs.transferId" }],
            successCriteria: [{ condition: "$statusCode == 200" }],
          },
          {
            stepId: "recoverTransfer",
            operationId: sompiArazzoOperationReference("recoverTransfer"),
            parameters: [{ name: "transferId", in: "path", value: "$steps.createTransfer.outputs.transferId" }],
            successCriteria: [{ condition: "$statusCode == 200" }],
          },
          {
            stepId: "readTransferReceipt",
            operationId: sompiArazzoOperationReference("getTransfer"),
            parameters: [{ name: "transferId", in: "path", value: "$steps.createTransfer.outputs.transferId" }],
            successCriteria: [
              { condition: "$statusCode == 200" },
              { condition: "$response.body#/state == 'receipted'" },
              { condition: "$response.body#/receipt/transactionId != null" },
            ],
            outputs: { transfer: "$response.body", receipt: "$response.body#/receipt" },
          },
        ],
        outputs: {
          transferId: "$steps.createTransfer.outputs.transferId",
          transfer: "$steps.readTransferReceipt.outputs.transfer",
          receipt: "$steps.readTransferReceipt.outputs.receipt",
        },
      },
      {
        workflowId: "changeEverydaySpendingLimits",
        summary: "Change the everyday spending limits with exact owner approval",
        description:
          "Proposes the new per-payment and hourly limits, resumes the same durable change if needed, " +
          "and verifies that one approved policy version was applied.",
        inputs: sompiOperationRequestSchema("createPolicyChange"),
        steps: [
          {
            stepId: "createPolicyChange",
            operationId: sompiArazzoOperationReference("createPolicyChange"),
            requestBody: { contentType: "application/json", payload: "$inputs" },
            successCriteria: [{ condition: "$statusCode == 200" }],
            outputs: { policyChangeId: "$response.body#/id" },
          },
          {
            stepId: "recoverPolicyChange",
            operationId: sompiArazzoOperationReference("recoverPolicyChange"),
            parameters: [{ name: "policyChangeId", in: "path", value: "$steps.createPolicyChange.outputs.policyChangeId" }],
            successCriteria: [{ condition: "$statusCode == 200" }],
          },
          {
            stepId: "readAppliedPolicyChange",
            operationId: sompiArazzoOperationReference("getPolicyChange"),
            parameters: [{ name: "policyChangeId", in: "path", value: "$steps.createPolicyChange.outputs.policyChangeId" }],
            successCriteria: [
              { condition: "$statusCode == 200" },
              { condition: "$response.body#/state == 'applied'" },
            ],
            outputs: { policyChange: "$response.body" },
          },
        ],
        outputs: {
          policyChangeId: "$steps.createPolicyChange.outputs.policyChangeId",
          policyChange: "$steps.readAppliedPolicyChange.outputs.policyChange",
        },
      },
      {
        workflowId: "changeVaultProtection",
        summary: "Approve a new on-chain vault protection maximum",
        description:
          "Proposes the exact new vault maximum and returns the durable identity used by the operator-only " +
          "offline-owner execution. The user's public receive address remains unchanged.",
        inputs: sompiOperationRequestSchema("createVaultMigration"),
        steps: [
          {
            stepId: "createVaultMigration",
            operationId: sompiArazzoOperationReference("createVaultMigration"),
            requestBody: { contentType: "application/json", payload: "$inputs" },
            successCriteria: [
              { condition: "$statusCode == 200" },
              { condition: "$response.body#/receiveAddressUnchanged == true" },
              { condition: "$response.body#/requiresOfflineOwnerKey == true" },
            ],
            outputs: { vaultMigrationId: "$response.body#/id" },
          },
          {
            stepId: "readVaultMigration",
            operationId: sompiArazzoOperationReference("getVaultMigration"),
            parameters: [{ name: "vaultMigrationId", in: "path", value: "$steps.createVaultMigration.outputs.vaultMigrationId" }],
            successCriteria: [{ condition: "$statusCode == 200" }],
            outputs: { vaultMigration: "$response.body" },
          },
        ],
        outputs: {
          vaultMigrationId: "$steps.createVaultMigration.outputs.vaultMigrationId",
          vaultMigration: "$steps.readVaultMigration.outputs.vaultMigration",
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

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
