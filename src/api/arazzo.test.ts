import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SompiApiClient } from "./client.js";
import { generateAgentApiCredential } from "./credential.js";
import type { SompiApplication, PurchaseCreateRequest } from "./contracts.js";
import {
  SOMPI_ARAZZO_SCHEMA_SHA256,
  canonicalArazzoBytes,
  sompiArazzoDocument,
  validateSompiArazzoDocument,
} from "./arazzo.js";
import { sompiOpenApiDocument } from "./openapi.js";
import { startSompiApiServer } from "./server.js";
import type { PurchaseView } from "../purchase/types.js";

const PURCHASE_ID = "pur_0123456789ABCDEFGHIJKL" as PurchaseView["id"];
const RECEIPT_DIGEST = `sha256:${"B".repeat(43)}` as PurchaseView["resourceFingerprint"];

test("Arazzo 1.1 workflow validates against the pinned schema and canonical OpenAPI operations", () => {
  const document = sompiArazzoDocument("0.8.1") as any;
  validateSompiArazzoDocument(document, sompiOpenApiDocument("0.8.1"));
  assert.equal(document.arazzo, "1.1.0");
  assert.match(SOMPI_ARAZZO_SCHEMA_SHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    document.workflows[0].steps.map((step: any) => step.operationId),
    [
      "$sourceDescriptions.sompi.createPurchase",
      "$sourceDescriptions.sompi.getPurchase",
      "$sourceDescriptions.sompi.recoverPurchase",
      "$sourceDescriptions.sompi.getPurchase",
    ],
  );
  assert.equal(canonicalArazzoBytes("0.8.1").toString("utf8").endsWith("\n"), true);

  const changed = structuredClone(document);
  changed.workflows[0].steps[2].operationId = "$sourceDescriptions.sompi.unknownOperation";
  assert.throws(
    () => validateSompiArazzoDocument(changed, sompiOpenApiDocument("0.8.1")),
    /unknown OpenAPI operationId/,
  );
  const missingParameter = structuredClone(document);
  delete missingParameter.workflows[0].steps[2].parameters;
  assert.throws(
    () => validateSompiArazzoDocument(missingParameter, sompiOpenApiDocument("0.8.1")),
    /omits required OpenAPI parameter purchaseId/,
  );
});

test("Arazzo recovery scenario runs create, status, recover, and terminal receipt over HTTP", async () => {
  const calls: string[] = [];
  const application: SompiApplication = {
    async purchase() {
      calls.push("createPurchase");
      return view("failed_recoverable", []);
    },
    async status() {
      calls.push("getPurchase");
      return calls.includes("recoverPurchase")
        ? view("receipted", [RECEIPT_DIGEST])
        : view("failed_recoverable", []);
    },
    async recover() {
      calls.push("recoverPurchase");
      return view("receipted", [RECEIPT_DIGEST]);
    },
    async wallet() { throw new Error("unused"); },
    async activity() { return []; },
    async transfer() { throw new Error("unused"); },
    async transferStatus() { throw new Error("unused"); },
    async transferRecover() { throw new Error("unused"); },
  };
  const credential = generateAgentApiCredential();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-arazzo-api-"));
  const access = {
    expectedServerUserId: typeof process.getuid === "function" ? process.getuid() : 0,
    runtimeGroupId: typeof process.getgid === "function" ? process.getgid() : 0,
  };
  fs.chownSync(directory, access.expectedServerUserId, access.runtimeGroupId);
  fs.chmodSync(directory, 0o710);
  const socketPath = path.join(directory, "api.sock");
  const running = await startSompiApiServer({ application, credential, socketPath, ...access });
  try {
    const client = new SompiApiClient({ socketPath, credential, ...access });
    const inputs: PurchaseCreateRequest = {
      requestKey: "workflow:recoverable",
      url: "https://merchant.example/paid-resource",
    };
    const workflow = (sompiArazzoDocument("0.8.1") as any).workflows[0];
    let purchaseId: string | undefined;
    let terminal: PurchaseView | undefined;
    for (const step of workflow.steps as Array<{ operationId: string }>) {
      const operationId = step.operationId.split(".").at(-1);
      if (operationId === "createPurchase") {
        terminal = await client.purchase(inputs);
        purchaseId = terminal.id;
      } else if (operationId === "getPurchase") {
        assert.ok(purchaseId);
        terminal = await client.status(purchaseId);
      } else if (operationId === "recoverPurchase") {
        assert.ok(purchaseId);
        terminal = await client.recover(purchaseId);
      } else {
        assert.fail(`unexpected workflow operation ${operationId}`);
      }
    }
    assert.deepEqual(calls, ["createPurchase", "getPurchase", "recoverPurchase", "getPurchase"]);
    assert.equal(terminal?.state, "receipted");
    assert.deepEqual(terminal?.receiptEvidence, [RECEIPT_DIGEST]);
  } finally {
    await running.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function view(
  state: PurchaseView["state"],
  receiptEvidence: PurchaseView["receiptEvidence"],
): PurchaseView {
  return {
    id: PURCHASE_ID,
    requestKey: "workflow:recoverable" as PurchaseView["requestKey"],
    state,
    summary: state === "receipted" ? "Purchase receipted." : "Purchase needs recovery.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "approved", authorityId: "authority:test" },
    treasury: { status: state === "receipted" ? "committed" : "reserved" },
    paymentAttempts: [],
    receiptEvidence,
  };
}
