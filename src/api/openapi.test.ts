import * as assert from "node:assert/strict";
import test from "node:test";

import { SOMPI_API_VERSION } from "./contracts.js";
import { canonicalOpenApiBytes, sompiOpenApiDocument } from "./openapi.js";

test("OpenAPI 3.2 exposes the canonical wallet, Transfer, and Purchase lifecycles", () => {
  const document = sompiOpenApiDocument("0.8.1") as any;
  assert.equal(document.openapi, "3.2.0");
  assert.deepEqual(Object.keys(document.paths).sort(), [
    "/purchases",
    "/purchases/{purchaseId}",
    "/purchases/{purchaseId}/recover",
    "/transfers",
    "/transfers/{transferId}",
    "/transfers/{transferId}/recover",
    "/wallet",
    "/wallet/activity",
  ]);
  assert.equal(document.components.securitySchemes.AgentCredential.bearerFormat, SOMPI_API_VERSION);
  assert.equal(document.paths["/purchases"].post.operationId, "createPurchase");
  assert.equal(document.paths["/purchases/{purchaseId}"].get.operationId, "getPurchase");
  assert.equal(document.paths["/purchases/{purchaseId}/recover"].post.operationId, "recoverPurchase");
  const snapshot = canonicalOpenApiBytes("0.8.1").toString("utf8");
  assert.equal(document.paths["/wallet"].get.operationId, "getWallet");
  assert.equal(document.paths["/transfers"].post.operationId, "createTransfer");
  assert.equal(document.paths["/transfers/{transferId}/recover"].post.operationId, "recoverTransfer");
  assert.equal(snapshot.includes("wallet"), true);
  assert.equal(snapshot.includes("treasury"), true, "the protocol-neutral public view includes Treasury status");
  assert.equal(snapshot.endsWith("\n"), true);
});
