import * as assert from "node:assert/strict";
import test from "node:test";

import { SOMPI_API_VERSION } from "./contracts.js";
import { SOMPI_OPERATIONS } from "./operation-contract.js";
import { canonicalOpenApiBytes, sompiOpenApiDocument } from "./openapi.js";

test("OpenAPI 3.2 exposes the canonical wallet and durable mutation lifecycles", () => {
  const document = sompiOpenApiDocument("0.8.1") as any;
  assert.equal(document.openapi, "3.2.0");
  assert.equal(document.components.securitySchemes.AgentCredential.bearerFormat, SOMPI_API_VERSION);
  assert.deepEqual(
    Object.keys(document.paths).sort(),
    [...new Set(SOMPI_OPERATIONS.map(({ pathTemplate }) => pathTemplate))].sort(),
  );
  const schemaNames = new Set(["SompiApiError"]);
  for (const operation of SOMPI_OPERATIONS) {
    const projection = document.paths[operation.pathTemplate][operation.method.toLowerCase()];
    assert.equal(projection.operationId, operation.operationId);
    assert.equal(projection.summary, operation.summary);
    assert.equal(
      projection.responses["200"].content["application/json"].schema.$ref,
      `#/components/schemas/${operation.responseSchemaName}`,
    );
    assert.deepEqual(
      Object.keys(projection.responses),
      ["200", ...operation.errorStatuses.map(String)],
    );
    assert.deepEqual(
      document.components.schemas[operation.responseSchemaName],
      withoutId(operation.responseSchema),
    );
    schemaNames.add(operation.responseSchemaName);
    if (operation.requestSchemaName === undefined || operation.requestSchema === undefined) {
      assert.equal(projection.requestBody, undefined);
    } else {
      schemaNames.add(operation.requestSchemaName);
      assert.equal(
        projection.requestBody.content["application/json"].schema.$ref,
        `#/components/schemas/${operation.requestSchemaName}`,
      );
      assert.deepEqual(
        document.components.schemas[operation.requestSchemaName],
        withoutId(operation.requestSchema),
      );
    }
  }
  assert.deepEqual(Object.keys(document.components.schemas).sort(), [...schemaNames].sort());
  const snapshot = canonicalOpenApiBytes("0.8.1").toString("utf8");
  assert.equal(snapshot.includes("wallet"), true);
  assert.equal(snapshot.includes("treasury"), true, "the protocol-neutral public view includes Treasury status");
  assert.equal(snapshot.endsWith("\n"), true);
});

function withoutId(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { $id: _id, ...projection } = schema;
  return projection;
}
