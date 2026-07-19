import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SompiApiClient, SompiApiClientError } from "./client.js";
import { generateAgentApiCredential } from "./credential.js";
import type { SompiApplication } from "./contracts.js";
import { startSompiApiServer } from "./server.js";
import type { PurchaseView } from "../purchase/types.js";
import type { TransferView } from "../transfer/types.js";
import type { WalletView } from "../wallet-view/module.js";

test("API client authenticates over a verified permissioned Unix socket", async () => {
  const fixture = socketFixture();
  const credential = generateAgentApiCredential();
  const calls: string[] = [];
  const application: SompiApplication = {
    async purchase() { calls.push("purchase"); return fakeView(); },
    async status() { calls.push("status"); return fakeView(); },
    async recover() { calls.push("recover"); return fakeView(); },
    async wallet() { calls.push("wallet"); return fakeWallet(); },
    async activity() { calls.push("activity"); return []; },
    async transfer() { calls.push("transfer"); return fakeTransfer(); },
    async transferStatus() { calls.push("transferStatus"); return fakeTransfer(); },
    async transferRecover() { calls.push("transferRecover"); return fakeTransfer(); },
  };
  const running = await startSompiApiServer({ application, credential, ...fixture.access, socketPath: fixture.socketPath });
  try {
    const client = new SompiApiClient({ credential, ...fixture.access, socketPath: fixture.socketPath });
    assert.equal((await client.purchase({ requestKey: "api:one", url: "https://merchant.example/" })).id, fakeView().id);
    assert.equal((await client.status(fakeView().id)).id, fakeView().id);
    assert.equal((await client.wallet()).balance.availableAtomic, "10000");
    assert.deepEqual(await client.activity(5), []);
    assert.equal((await client.transfer({ requestKey: "api:transfer:one", destination: ADDRESS, amountAtomic: "1000" })).id, fakeTransfer().id);
    assert.equal((await client.transferStatus(fakeTransfer().id)).id, fakeTransfer().id);
    assert.equal((await client.transferRecover(fakeTransfer().id)).id, fakeTransfer().id);
    assert.deepEqual(calls, ["purchase", "status", "wallet", "activity", "transfer", "transferStatus", "transferRecover"]);
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
    const client = new SompiApiClient({ credential, ...fixture.access, socketPath: fixture.socketPath });
    await assert.rejects(() => client.status(fakeView().id), (error: unknown) =>
      error instanceof SompiApiClientError && error.code === "API_UNAVAILABLE");
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
    const client = new SompiApiClient({ credential, ...fixture.access, socketPath: fixture.socketPath });
    await assert.rejects(() => client.status(fakeView().id), (error: unknown) =>
      error instanceof SompiApiClientError && error.code === "INVALID_API_RESPONSE");
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

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";

function fakeTransfer(): TransferView {
  return {
    id: "trf_0123456789ABCDEFGHIJKL", requestKey: "api:transfer:one", requestDigest: `sha256:${"B".repeat(43)}`,
    state: "created", destination: ADDRESS, amountAtomic: "1000", asset: "KAS", network: "kaspa:testnet-10",
    sourceVaultAddress: ADDRESS, sourceVaultDigest: `sha256:${"C".repeat(43)}`, feeCeilingAtomic: "100",
    maximumTotalAtomic: "1100", expiresAtMs: 2_000_000_000_000, policyDigest: `sha256:${"D".repeat(43)}`,
    manifestRevision: 1, manifestDigest: `sha256:${"E".repeat(43)}`, finalityFloor: "accepted", version: 0,
    createdAtMs: 1_900_000_000_000, updatedAtMs: 1_900_000_000_000,
    recoveryRequired: false, safeToRetry: true, userAction: "none",
  };
}

function fakeWallet(): WalletView {
  return {
    network: "kaspa:testnet-10", asset: "KAS", fundingAddress: ADDRESS, vaultAddress: ADDRESS,
    balance: { observedAtomic: "10000", unboundAtomic: "0", reservedAtomic: "0", availableAtomic: "10000", provenance: "operator-node-and-local-vault-lineage", observedAt: "2030-01-01T00:00:00.000Z" },
    limits: { maxPerTransferAtomic: "1000", maxPerHourAtomic: "5000", approvalThresholdAtomic: "1", allowlist: [], vaultMaxOutflowAtomic: "5000", vaultWindowSizeDaa: "100", vaultSpentInWindowAtomic: "0" },
    chainStatus: "observed",
  };
}
