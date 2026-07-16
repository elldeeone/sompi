import * as assert from "node:assert/strict";
import test from "node:test";

import { PURCHASE_API_VERSION } from "./contracts.js";
import { canonicalOpenApiBytes, sompiOpenApiDocument } from "./openapi.js";

test("OpenAPI 3.2 exposes only the canonical Purchase lifecycle", () => {
  const document = sompiOpenApiDocument("0.8.0") as any;
  assert.equal(document.openapi, "3.2.0");
  assert.deepEqual(Object.keys(document.paths).sort(), [
    "/purchases",
    "/purchases/{purchaseId}",
    "/purchases/{purchaseId}/recover",
  ]);
  assert.equal(document.components.securitySchemes.AgentCredential.bearerFormat, PURCHASE_API_VERSION);
  assert.equal(document.paths["/purchases"].post.operationId, "createPurchase");
  assert.equal(document.paths["/purchases/{purchaseId}"].get.operationId, "getPurchase");
  assert.equal(document.paths["/purchases/{purchaseId}/recover"].post.operationId, "recoverPurchase");
  const snapshot = canonicalOpenApiBytes("0.8.0").toString("utf8");
  assert.equal(snapshot.includes("wallet"), false);
  assert.equal(snapshot.includes("treasury"), true, "the protocol-neutral public view includes Treasury status");
  assert.equal(snapshot.endsWith("\n"), true);
});
