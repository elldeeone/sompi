import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { PurchaseApiClient, PurchaseApiClientError } from "./client.js";
import { generateAgentApiCredential } from "./credential.js";
import type { PurchaseApplication } from "./contracts.js";
import { startPurchaseApiServer } from "./server.js";
import type { PurchaseView } from "../purchase/types.js";

test("API client authenticates over a verified permissioned Unix socket", async () => {
  const fixture = socketFixture();
  const credential = generateAgentApiCredential();
  const calls: string[] = [];
  const application: PurchaseApplication = {
    async purchase() { calls.push("purchase"); return fakeView(); },
    async status() { calls.push("status"); return fakeView(); },
    async recover() { calls.push("recover"); return fakeView(); },
  };
  const running = await startPurchaseApiServer({ application, credential, ...fixture.access, socketPath: fixture.socketPath });
  try {
    const client = new PurchaseApiClient({ credential, ...fixture.access, socketPath: fixture.socketPath });
    assert.equal((await client.purchase({ requestKey: "api:one", url: "https://merchant.example/" })).id, fakeView().id);
    assert.equal((await client.status(fakeView().id)).id, fakeView().id);
    assert.deepEqual(calls, ["purchase", "status"]);
  } finally {
    await running.close();
    fixture.close();
  }
});

test("API client rejects an insecure socket directory before disclosing its bearer", async () => {
  const fixture = socketFixture();
  const credential = generateAgentApiCredential();
  let observedAuthorization: string | undefined;
  const server = http.createServer((request, response) => {
    observedAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(fakeView()));
  });
  await listen(server, fixture.socketPath);
  fs.chownSync(fixture.socketPath, fixture.access.expectedServerUserId, fixture.access.runtimeGroupId);
  fs.chmodSync(fixture.socketPath, 0o660);
  fs.chmodSync(fixture.directory, 0o770);
  try {
    const client = new PurchaseApiClient({ credential, ...fixture.access, socketPath: fixture.socketPath });
    await assert.rejects(() => client.status(fakeView().id), (error: unknown) =>
      error instanceof PurchaseApiClientError && error.code === "API_UNAVAILABLE");
    assert.equal(observedAuthorization, undefined);
  } finally {
    await close(server);
    fixture.close();
  }
});

test("API client rejects oversized and malformed local responses", async () => {
  const fixture = socketFixture();
  const credential = generateAgentApiCredential();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("not-json");
  });
  await listen(server, fixture.socketPath);
  fs.chownSync(fixture.socketPath, fixture.access.expectedServerUserId, fixture.access.runtimeGroupId);
  fs.chmodSync(fixture.socketPath, 0o660);
  fs.chmodSync(fixture.directory, 0o710);
  try {
    const client = new PurchaseApiClient({ credential, ...fixture.access, socketPath: fixture.socketPath });
    await assert.rejects(() => client.status(fakeView().id), (error: unknown) =>
      error instanceof PurchaseApiClientError && error.code === "INVALID_API_RESPONSE");
  } finally {
    await close(server);
    fixture.close();
  }
});

function socketFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-api-client-"));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o710);
  return {
    directory,
    socketPath: path.join(directory, "api.sock"),
    access: { expectedServerUserId: uid, runtimeGroupId: gid },
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  } as const;
}

function listen(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function fakeView(): PurchaseView {
  return {
    id: "pur_0123456789ABCDEFGHIJKL" as PurchaseView["id"],
    requestKey: "api:one" as PurchaseView["requestKey"], state: "created", summary: "Purchase created.",
    resourceFingerprint: `sha256:${"A".repeat(43)}` as PurchaseView["resourceFingerprint"],
    authorization: { status: "not_requested" }, treasury: { status: "unreserved" },
    paymentAttempts: [], receiptEvidence: [],
  };
}
