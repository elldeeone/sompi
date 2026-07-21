/**
 * Built-artifact smoke for the accepted AP2 + Kaspa-x402 exact architecture.
 * Unit/conformance suites own exhaustive adversarial coverage; this script
 * proves that the packaged runtime primitives load and retain their pinned
 * deterministic vectors. Live RPC checks are opt-in by omitting
 * SOMPI_SMOKE_OFFLINE.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Transaction,
  payToAddressScript,
} from "./kaspa-wasm.js";
import { PolicyEngine, PolicyViolation } from "./policy.js";
import {
  assertPurchaseId,
  assertPurchaseRequestKey,
  canonicalRequestUrl,
  createPaymentIdentifier,
  createPurchaseId,
  evidenceDigest,
  requestFingerprint,
} from "./purchase/identity.js";
import { PurchaseJournal } from "./purchase/journal.js";
import { PURCHASE_STATES } from "./purchase/types.js";
import { SUPPORTED_PROTOCOL_PROFILES } from "./protocols/profiles.js";
import { buildRedeemScript, buildSigArgs, bytesToHex } from "./vault/template.js";
import { KaspaWallet, formatKas } from "./wallet.js";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const DATA_DIRECTORY =
  process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);

async function main(): Promise<void> {
  let failures = 0;
  const check = (name: string, condition: boolean, detail = "") => {
    process.stdout.write(
      `${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}\n`
    );
    if (!condition) failures += 1;
  };

  const fixedPurchaseId = createPurchaseId(new Uint8Array(16).fill(0x42));
  check(
    "Purchase identity remains deterministic and runtime validated",
    fixedPurchaseId === "pur_QkJCQkJCQkJCQkJCQkJCQg" &&
      assertPurchaseId(fixedPurchaseId) === fixedPurchaseId
  );
  const requestKey = assertPurchaseRequestKey("agent-task:weather:0001");
  check(
    "caller request key remains the idempotency identity",
    requestKey === "agent-task:weather:0001"
  );
  const baseRequest = {
    url: "https://merchant.example:443/data?city=Perth#not-sent",
    method: "post",
    body: new TextEncoder().encode('{"units":"metric"}'),
  };
  const fingerprint = requestFingerprint(baseRequest);
  check(
    "request fingerprint binds canonical URL, method, and exact body",
    fingerprint ===
      requestFingerprint({
        ...baseRequest,
        url: "https://merchant.example/data?city=Perth",
        method: "POST",
      }) &&
      fingerprint !== requestFingerprint({ ...baseRequest, method: "PUT" }) &&
      fingerprint !==
        requestFingerprint({
          ...baseRequest,
          body: new TextEncoder().encode('{"units":"imperial"}'),
        })
  );
  let credentialsDenied = false;
  try {
    canonicalRequestUrl("https://user:secret@merchant.example/data");
  } catch {
    credentialsDenied = true;
  }
  check("credential-bearing Purchase URLs fail closed", credentialsDenied);
  check(
    "payment identifiers are deterministic per immutable attempt",
    createPaymentIdentifier(fixedPurchaseId, 1) ===
      createPaymentIdentifier(fixedPurchaseId, 1) &&
      createPaymentIdentifier(fixedPurchaseId, 1) !==
        createPaymentIdentifier(fixedPurchaseId, 2)
  );
  check(
    "evidence remains exact-byte content addressed",
    evidenceDigest("abc") ===
      "sha256:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0" &&
      evidenceDigest("abc") !== evidenceDigest("abc\n")
  );

  check(
    "protocol profile is AP2-derived human authorization plus Kaspa-x402 alpha.9 exact",
    SUPPORTED_PROTOCOL_PROFILES.ap2.release === "v0.2.0" &&
      SUPPORTED_PROTOCOL_PROFILES.ap2.mode === "human-present" &&
      SUPPORTED_PROTOCOL_PROFILES.ap2.interoperability === "none" &&
      SUPPORTED_PROTOCOL_PROFILES.ap2.sourceWatchOnly === true &&
      SUPPORTED_PROTOCOL_PROFILES.x402.version === 2 &&
      SUPPORTED_PROTOCOL_PROFILES.x402.scheme === "exact" &&
      SUPPORTED_PROTOCOL_PROFILES.x402.network === "kaspa:testnet-10" &&
      SUPPORTED_PROTOCOL_PROFILES.x402.packages.client.version ===
        "0.1.0-alpha.9" &&
      SUPPORTED_PROTOCOL_PROFILES.x402.allowMainnet === false &&
      PURCHASE_STATES.includes("failed_recoverable")
  );

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-smoke-"));
  try {
    walletVector(check, path.join(temporary, "wallet"));
    policyVector(check, path.join(temporary, "policy"));
    vaultFixtureVector(check);
    journalVector(check, path.join(temporary, "purchase.sqlite"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  if (process.env.SOMPI_SMOKE_OFFLINE) {
    process.stdout.write("\nSOMPI_SMOKE_OFFLINE set; skipping live testnet RPC checks.\n");
  } else {
    await liveRpcVector(check);
  }

  process.stdout.write(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function walletVector(
  check: (name: string, condition: boolean, detail?: string) => void,
  directory: string
): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, "wallet-key");
  fs.writeFileSync(
    keyPath,
    "0000000000000000000000000000000000000000000000000000000000000001",
    { mode: 0o600 }
  );
  const previousKey = process.env.SOMPI_PRIVATE_KEY;
  delete process.env.SOMPI_PRIVATE_KEY;
  try {
    const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: directory });
    check(
      "fixed wallet key derives the pinned testnet address with mode 0600",
      wallet.address ===
        "kaspatest:qpumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtes5z8rkmpd" &&
        (fs.statSync(keyPath).mode & 0o777) === 0o600
    );
    const script = payToAddressScript(wallet.address);
    const outpoint = { transactionId: "11".repeat(32), index: 0 };
    const transaction = new Transaction({
      version: 0,
      inputs: [
        {
          previousOutpoint: outpoint,
          signatureScript: "",
          sequence: 0n,
          sigOpCount: 1,
          computeBudget: 0n,
          utxo: {
            outpoint,
            amount: 100_000_000n,
            scriptPublicKey: script,
            blockDaaScore: 1n,
            isCoinbase: false,
          },
        },
      ],
      outputs: [{ value: 99_900_000n, scriptPublicKey: script }],
      lockTime: 0n,
      subnetworkId: "00".repeat(20),
      gas: 0n,
      payload: "",
    } as any);
    transaction.finalize();
    const signature = wallet.signInput(transaction, 0);
    check(
      "fixed wallet vector signs the pinned transaction identity",
      transaction.id ===
        "f595f033a6b2ce46809bf63899a91ea083bb3043b7f68ac94899a6e21e1b7273" &&
        /^41[0-9a-f]{130}$/.test(signature) &&
        signature.endsWith("01")
    );
    transaction.free();
    script.free();

    let mainnetDenied = false;
    try {
      new KaspaWallet({ networkId: "mainnet", dataDir: directory });
    } catch (error) {
      mainnetDenied =
        error instanceof Error && error.message.includes("only testnet-10");
    }
    check("non-testnet wallet profiles remain unavailable", mainnetDenied);
  } finally {
    if (previousKey === undefined) delete process.env.SOMPI_PRIVATE_KEY;
    else process.env.SOMPI_PRIVATE_KEY = previousKey;
  }
}

function policyVector(
  check: (name: string, condition: boolean, detail?: string) => void,
  directory: string
): void {
  const configured = {
    maxSompiPerTx: 100n,
    maxSompiPerHour: 1_000n,
    allowlist: [] as string[],
  };
  const policy = new PolicyEngine(configured);
  let denied = false;
  try {
    policy.authorize("kaspatest:qpolicy", 200n);
  } catch (error) {
    denied = error instanceof PolicyViolation;
  }
  configured.maxSompiPerTx = 500n;
  let remainedImmutable = false;
  try {
    policy.authorize("kaspatest:qpolicy", 200n);
  } catch (error) {
    remainedImmutable = error instanceof PolicyViolation;
  }
  check(
    "active policy revisions are immutable snapshots",
    denied && remainedImmutable && policy.policy.maxSompiPerTx === 100n
  );
}

function vaultFixtureVector(
  check: (name: string, condition: boolean, detail?: string) => void
): void {
  const fixtures = JSON.parse(
    fs.readFileSync(
      path.join(MODULE_DIRECTORY, "..", "scripts", "vault-fixtures.json"),
      "utf8"
    )
  ) as Array<Record<string, string>>;
  const matches = fixtures.every((fixture) => {
    const redeem = bytesToHex(
      buildRedeemScript(
        fixture.agent,
        fixture.owner,
        BigInt(fixture.maxOutflow),
        BigInt(fixture.windowSize),
        {
          windowStartDaa: BigInt(fixture.windowStart),
          spentInWindowSompi: BigInt(fixture.spentInWindow),
        }
      )
    );
    const signature = new Uint8Array(65).fill(0xab);
    return (
      redeem === fixture.redeemScript &&
      bytesToHex(buildSigArgs(signature, "withdraw")) ===
        fixture.withdrawArgsWithDummySig &&
      bytesToHex(buildSigArgs(signature, "topup")) ===
        fixture.topupArgsWithDummySig &&
      bytesToHex(buildSigArgs(signature, "recover")) ===
        fixture.recoverArgsWithDummySig
    );
  });
  check(
    `vault template remains compiler-byte-identical (${fixtures.length} vectors)`,
    matches && fixtures.length > 0
  );
}

function journalVector(
  check: (name: string, condition: boolean, detail?: string) => void,
  filename: string
): void {
  const id = createPurchaseId(new Uint8Array(16).fill(0x11));
  const requestKey = assertPurchaseRequestKey("smoke:journal:1");
  const resourceFingerprint = requestFingerprint({
    url: "https://merchant.example/smoke",
    method: "GET",
  });
  const first = new PurchaseJournal(filename);
  first.createPurchase({
    id,
    requestKey,
    resourceUrl: "https://merchant.example/smoke",
    method: "GET",
    resourceFingerprint,
  });
  first.close();
  const reopened = new PurchaseJournal(filename);
  try {
    const stored = reopened.requirePurchase(id);
    check(
      "SQLite Purchase Journal survives a verified restart",
      stored.id === id &&
        stored.requestKey === requestKey &&
        stored.resourceFingerprint === resourceFingerprint &&
        stored.state === "created" &&
        (fs.statSync(filename).mode & 0o077) === 0
    );
  } finally {
    reopened.close();
  }
}

async function liveRpcVector(
  check: (name: string, condition: boolean, detail?: string) => void
): Promise<void> {
  if (NETWORK !== "testnet-10") {
    check("live profile remains testnet-10 only", false, `configured ${NETWORK}`);
    return;
  }
  process.stdout.write("\nConnecting to testnet-10 for read-only RPC smoke...\n");
  const wallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: DATA_DIRECTORY,
    nodeUrl: process.env.SOMPI_NODE_URL,
  });
  try {
    const info = await wallet.serverInfo();
    check(
      "RPC node is synced with UTXO index",
      info.isSynced === true && info.hasUtxoIndex === true,
      `version=${info.serverVersion} daa=${info.virtualDaaScore}`
    );
    const balance = await wallet.balanceSompi();
    check("RPC balance query succeeds", balance >= 0n, `${formatKas(balance)} tKAS`);
    const fees = await wallet.feeEstimate();
    const normal = (fees as any).estimate?.normalBuckets?.[0]?.feerate;
    check(
      "RPC fee estimate succeeds",
      normal !== undefined,
      `normal=${String(normal)} sompi/gram`
    );
  } catch {
    check(
      "live testnet RPC checks",
      false,
      "read-only RPC verification failed; inspect the local node configuration"
    );
  } finally {
    await wallet.disconnect();
  }
}

void main().catch(() => {
  process.stderr.write(
    "sompi smoke failed safely; inspect the local build and test configuration\n"
  );
  process.exitCode = 1;
});
