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
    async walletTechnical() { calls.push("walletTechnical"); return fakeWalletTechnical(); },
    async activity() { calls.push("activity"); return []; },
    async transfer() { calls.push("transfer"); return fakeTransfer(); },
    async transferStatus() { calls.push("transferStatus"); return fakeTransfer(); },
    async transferRecover() { calls.push("transferRecover"); return fakeTransfer(); },
    async changePolicy() { calls.push("changePolicy"); return fakePolicyChange(); },
    async policyChangeStatus() { calls.push("policyChangeStatus"); return fakePolicyChange(); },
    async policyChangeRecover() { calls.push("policyChangeRecover"); return fakePolicyChange(); },
    async vaultMigration() { calls.push("vaultMigration"); return fakeVaultMigration(); },
    async vaultMigrationStatus() { calls.push("vaultMigrationStatus"); return fakeVaultMigration(); },
  };
  const running = await startSompiApiServer({ application, credential, ...fixture.access, socketPath: fixture.socketPath });
  try {
    const client = new SompiApiClient({ credential, ...fixture.access, socketPath: fixture.socketPath });
    assert.equal((await client.purchase({ requestKey: "api:one", url: "https://merchant.example/" })).id, fakeView().id);
    assert.equal((await client.status(fakeView().id)).id, fakeView().id);
    assert.equal((await client.recover(fakeView().id)).id, fakeView().id);
    assert.equal((await client.wallet()).balance.available.atomic, "10000");
    assert.equal((await client.walletTechnical()).receiveAddress, ADDRESS);
    assert.deepEqual(await client.activity(5), []);
    assert.equal((await client.transfer({ requestKey: "api:transfer:one", destination: ADDRESS, amountKas: "0.00001" })).id, fakeTransfer().id);
    assert.equal((await client.transferStatus(fakeTransfer().id)).id, fakeTransfer().id);
    assert.equal((await client.transferRecover(fakeTransfer().id)).id, fakeTransfer().id);
    assert.equal((await client.changePolicy({ requestKey: "limits:one", maximumPerPaymentKas: "1", maximumPerHourKas: "2" })).state, "applied");
    assert.equal((await client.policyChangeStatus(fakePolicyChange().id)).id, fakePolicyChange().id);
    assert.equal((await client.policyChangeRecover(fakePolicyChange().id)).id, fakePolicyChange().id);
    assert.equal((await client.vaultMigration({ requestKey: "vault:one", vaultProtectionMaximumKas: "10" })).state, "awaiting_owner");
    assert.equal((await client.vaultMigrationStatus(fakeVaultMigration().id)).id, fakeVaultMigration().id);
    assert.deepEqual(calls, ["purchase", "status", "recover", "wallet", "walletTechnical", "activity", "transfer", "transferStatus", "transferRecover", "changePolicy", "policyChangeStatus", "policyChangeRecover", "vaultMigration", "vaultMigrationStatus"]);
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
    state: "created", summary: "Transfer request recorded.", display: { amount: amount("1000"), feeCeiling: amount("100"), maximumTotal: amount("1100") }, destination: ADDRESS, amountAtomic: "1000", asset: "KAS", network: "kaspa:testnet-10",
    sourceVaultAddress: ADDRESS, sourceVaultDigest: `sha256:${"C".repeat(43)}`, feeCeilingAtomic: "100",
    maximumTotalAtomic: "1100", expiresAtMs: 2_000_000_000_000, policyDigest: `sha256:${"D".repeat(43)}`,
    manifestRevision: 1, manifestDigest: `sha256:${"E".repeat(43)}`, finalityFloor: "accepted", version: 0,
    createdAtMs: 1_900_000_000_000, updatedAtMs: 1_900_000_000_000,
    recoveryRequired: false, safeToRetry: true, userAction: "none",
  };
}

function fakeWallet(): WalletView {
  return {
    network: "kaspa:testnet-10", asset: "KAS",
    receive: { address: ADDRESS, qrPayload: ADDRESS, networkLabel: "Kaspa Testnet-10", warning: "Testnet funds only — do not send mainnet KAS." },
    balance: { total: amount("10000"), available: amount("10000"), incoming: amount("0"), pending: amount("0"), provenance: "operator-node-and-local-vault-lineage", observedAt: "2030-01-01T00:00:00.000Z" },
    securing: { automatic: true, state: "idle", summary: "No incoming funds are waiting to be secured.", userAction: "none", minimumAmount: amount("101") },
    spendingProtection: { maximumPerPayment: amount("1000"), maximumPerHour: amount("5000"), everyPaymentRequiresApproval: true, vaultProtection: { maximumPerWindow: amount("5000"), remainingInWindow: amount("5000"), window: "approximately 1 hour", summary: "Protected." } },
    chainStatus: "observed",
  };
}

function fakeWalletTechnical() { return { receiveAddress: ADDRESS, activeVault: { address: ADDRESS, maximumOutflowAtomic: "1000000000", windowSizeDaa: "36000", windowStartDaa: "0", spentInWindowAtomic: "0" }, allowlist: [] } as const; }
function fakePolicyChange() { return { id: "pcg_0123456789ABCDEFGHIJKL", requestKey: "limits:one", state: "applied", summary: "Spending limits updated. Every payment still requires your approval.", previous: { maximumPerPayment: amount("1000"), maximumPerHour: amount("5000") }, proposed: { maximumPerPayment: amount("2000"), maximumPerHour: amount("6000") }, vaultProtectionMaximum: amount("10000"), everyPaymentRequiresApproval: true, expiresAt: "2030-01-01T00:00:00.000Z", appliedPolicyDigest: `sha256:${"F".repeat(43)}`, appliedPolicyVersion: 2 } as const; }
function fakeVaultMigration() { return { id: "vmg_0123456789ABCDEFGHIJKL", requestKey: "vault:one", state: "awaiting_owner", summary: "Vault protection change approved. Finish it with the offline owner key.", userAction: "Ask the operator to finish the protected vault update locally.", previousVaultProtectionMaximum: amount("10000"), proposedVaultProtectionMaximum: amount("20000"), receiveAddressUnchanged: true, requiresOfflineOwnerKey: true, expiresAt: "2030-01-01T00:00:00.000Z" } as const; }

function amount(atomic: string) {
  const kas = atomic === "0" ? "0" : `0.${atomic.padStart(8, "0").replace(/0+$/, "")}`;
  return { atomic, kas, unit: "tKAS" as const, display: `${kas} tKAS` };
}
