import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PurchaseApiClientError } from "../api/client.js";
import { PurchaseApiClient } from "../api/client.js";
import { generateAgentApiCredential } from "../api/credential.js";
import { startPurchaseApiServer } from "../api/server.js";
import type { PurchaseApplication } from "../api/contracts.js";
import type { PurchaseView } from "../purchase/types.js";
import {
  createSompiMcpServer,
  registerSompiTools,
  type McpRequestExtra,
  type McpToolRegistrar,
  type McpToolResult,
} from "./server.js";

const EXPECTED_TOOLS = ["purchase", "purchase_recover", "purchase_status"] as const;

test("MCP exposes exactly three stateless Purchase compatibility tools", () => {
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, fakeApplication());
  assert.deepEqual([...registrar.tools.keys()].sort(), EXPECTED_TOOLS);
});

test("real MCP transport delegates all behavior to the Purchase application", async () => {
  const calls: string[] = [];
  const application = fakeApplication({
    async purchase() { calls.push("purchase"); return fakeView(); },
    async status() { calls.push("status"); return fakeView(); },
    async recover() { calls.push("recover"); return fakeView(); },
  });
  const server = createSompiMcpServer(application, "test");
  const client = new Client({ name: "sompi-mcp-test", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    await client.callTool({
      name: "purchase",
      arguments: { requestKey: "mcp:purchase:one", url: "https://merchant.example/resource", method: "GET" },
    });
    await client.callTool({ name: "purchase_status", arguments: { purchaseId: fakeView().id } });
    await client.callTool({ name: "purchase_recover", arguments: { purchaseId: fakeView().id } });
    assert.deepEqual(calls, ["purchase", "status", "recover"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP projects bounded structured API failures without leaking causes", async () => {
  const secret = `private-key=${"a".repeat(5_000)}`;
  const application = fakeApplication({
    async purchase() { throw new PurchaseApiClientError("API_BUSY", "The API is busy.", true, { cause: new Error(secret) }); },
    async status() { throw new Error(secret); },
    async recover() { throw new Error(secret); },
  });
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, application);
  const purchase = await registrar.call("purchase", { requestKey: "mcp:one", url: "https://merchant.example/" });
  const status = await registrar.call("purchase_status", { purchaseId: fakeView().id });
  assert.equal(purchase.isError, true);
  assert.deepEqual(JSON.parse(purchase.content[0].text), { error: { code: "API_BUSY", message: "The API is busy.", retryable: true } });
  assert.equal(status.content[0].text.includes("private-key"), false);
  assert.ok(Buffer.byteLength(status.content[0].text) < 1_000);
});

test("MCP passes request cancellation to the API client", async () => {
  let observed: AbortSignal | undefined;
  const application = fakeApplication({
    async recover(_id, signal) { observed = signal; return fakeView(); },
  });
  const registrar = new CapturingRegistrar();
  registerSompiTools(registrar, application);
  const controller = new AbortController();
  await registrar.call("purchase_recover", { purchaseId: fakeView().id }, { signal: controller.signal });
  assert.equal(observed, controller.signal);
});

test("HTTP and MCP return the same canonical view through the production API seam", async () => {
  const credential = generateAgentApiCredential();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-mcp-api-"));
  const socketPath = path.join(directory, "api.sock");
  const access = {
    expectedServerUserId: typeof process.getuid === "function" ? process.getuid() : 0,
    runtimeGroupId: typeof process.getgid === "function" ? process.getgid() : 0,
  };
  fs.chownSync(directory, access.expectedServerUserId, access.runtimeGroupId);
  fs.chmodSync(directory, 0o710);
  const running = await startPurchaseApiServer({ application: fakeApplication(), credential, socketPath, ...access });
  try {
    const client = new PurchaseApiClient({ socketPath, credential, ...access });
    const direct = await client.status(fakeView().id);
    const registrar = new CapturingRegistrar();
    registerSompiTools(registrar, client);
    const throughMcp = JSON.parse((await registrar.call("purchase_status", { purchaseId: fakeView().id })).content[0].text);
    assert.deepEqual(throughMcp, direct);
  } finally {
    await running.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

class CapturingRegistrar implements McpToolRegistrar {
  readonly tools = new Map<string, (args: any, extra?: McpRequestExtra) => Promise<McpToolResult>>();
  registerTool(name: string, _config: unknown, handler: (args: any, extra?: McpRequestExtra) => Promise<McpToolResult>): void {
    this.tools.set(name, handler);
  }
  call(name: string, args: unknown, extra?: McpRequestExtra): Promise<McpToolResult> {
    const handler = this.tools.get(name);
    if (!handler) throw new Error(`missing tool ${name}`);
    return handler(args, extra);
  }
}

function fakeApplication(overrides: Partial<PurchaseApplication> = {}): PurchaseApplication {
  return {
    async purchase() { return fakeView(); },
    async status() { return fakeView(); },
    async recover() { return fakeView(); },
    ...overrides,
  };
}

function fakeView(): PurchaseView {
  return {
    id: "pur_0123456789ABCDEFGHIJKL" as PurchaseView["id"],
    requestKey: "mcp:purchase:one" as PurchaseView["requestKey"],
    state: "created",
    summary: "Purchase created.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "not_requested" },
    treasury: { status: "unreserved" },
    paymentAttempts: [],
    receiptEvidence: [],
  };
}
