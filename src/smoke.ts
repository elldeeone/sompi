/**
 * End-to-end smoke test against a live network (default testnet-10).
 * Exercises: resolver connection, server info, address derivation,
 * balance, fee estimation, and local policy enforcement.
 *
 * Usage: npm run build && npm run smoke
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { PolicyEngine, PolicyViolation } from "./policy";
import { buildRedeemScript, buildSigArgs, bytesToHex } from "./vault/template";
import { buildEscrowRedeemScript, buildClaimArgs, buildRefundArgs } from "./x402/escrow-template";
import { KaspaWallet, formatKas } from "./wallet";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK);

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  // --- offline checks: policy engine ---
  const policy = new PolicyEngine(os.tmpdir());
  check("policy: defaults load", policy.policy.maxSompiPerTx === 100_000_000n);

  let denied = false;
  try {
    policy.authorize("kaspatest:qq000", 200_000_000n);
  } catch (e) {
    denied = e instanceof PolicyViolation;
  }
  check("policy: per-tx cap denies 2 KAS", denied);

  denied = false;
  try {
    policy.authorize("kaspatest:qq000", -5n);
  } catch (e) {
    denied = e instanceof PolicyViolation;
  }
  check("policy: negative amount denied", denied);

  policy.record(450_000_000n);
  denied = false;
  try {
    policy.authorize("kaspatest:qq000", 100_000_000n);
  } catch (e) {
    denied = e instanceof PolicyViolation;
  }
  check("policy: hourly cap denies after 4.5 KAS spent", denied);

  // --- offline checks: policy hot-reload ---
  const hotDir = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-smoke-"));
  const hotPolicyPath = path.join(hotDir, "policy.json");
  fs.writeFileSync(hotPolicyPath, JSON.stringify({ maxSompiPerTx: "100", maxSompiPerHour: "1000" }));
  const hotEngine = new PolicyEngine(hotDir, hotPolicyPath);
  let hotDenied = false;
  try {
    hotEngine.authorize("kaspatest:qq000", 200n);
  } catch {
    hotDenied = true;
  }
  // rewrite with a looser cap and a bumped mtime; no new engine instance
  fs.writeFileSync(hotPolicyPath, JSON.stringify({ maxSompiPerTx: "500", maxSompiPerHour: "1000" }));
  fs.utimesSync(hotPolicyPath, new Date(), new Date(Date.now() + 5));
  let hotAllowed = true;
  try {
    hotEngine.authorize("kaspatest:qq000", 200n);
  } catch {
    hotAllowed = false;
  }
  check("policy: hot-reload picks up file edits without restart", hotDenied && hotAllowed);

  fs.writeFileSync(hotPolicyPath, "{not json");
  fs.utimesSync(hotPolicyPath, new Date(), new Date(Date.now() + 10));
  let hotFailedClosed = false;
  try {
    hotEngine.authorize("kaspatest:qq000", 1n);
  } catch (e) {
    hotFailedClosed = e instanceof PolicyViolation && e.message.includes("malformed");
  }
  check("policy: malformed file fails closed", hotFailedClosed);
  fs.rmSync(hotDir, { recursive: true, force: true });

  // --- offline checks: vault template byte-equality vs compiler fixtures ---
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "scripts", "vault-fixtures.json"), "utf8"));
  let templateMatches = 0;
  for (const f of fixtures) {
    const redeem = bytesToHex(buildRedeemScript(f.agent, f.owner, BigInt(f.maxOutflow)));
    const withdrawArgs = bytesToHex(buildSigArgs(new Uint8Array(65).fill(0xab), "withdraw"));
    const recoverArgs = bytesToHex(buildSigArgs(new Uint8Array(65).fill(0xab), "recover"));
    if (redeem === f.redeemScript && withdrawArgs === f.withdrawArgsWithDummySig && recoverArgs === f.recoverArgsWithDummySig) {
      templateMatches++;
    } else {
      console.log(`  fixture mismatch: agent=${f.agent.slice(0, 8)} max=${f.maxOutflow}`);
    }
  }
  check(
    `vault template: byte-identical to compiler output (${templateMatches}/${fixtures.length} fixtures)`,
    templateMatches === fixtures.length
  );

  // --- offline checks: escrow template byte-equality vs compiler fixtures ---
  const escrowFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "scripts", "escrow-fixtures.json"), "utf8"));
  let escrowMatches = 0;
  for (const f of escrowFixtures) {
    const redeem = bytesToHex(buildEscrowRedeemScript(f.client, f.server, BigInt(f.timeout)));
    const claim = bytesToHex(
      buildClaimArgs(new Uint8Array(65).fill(0xab), new Uint8Array(64).fill(0xcd), new Uint8Array(8).fill(0xef))
    );
    const refund = bytesToHex(buildRefundArgs(new Uint8Array(65).fill(0xab)));
    if (redeem === f.redeemScript && claim === f.claimArgsWithDummies && refund === f.refundArgsWithDummySig) {
      escrowMatches++;
    } else {
      console.log(`  escrow fixture mismatch: client=${f.client.slice(0, 8)} timeout=${f.timeout}`);
    }
  }
  check(
    `escrow template: byte-identical to compiler output (${escrowMatches}/${escrowFixtures.length} fixtures)`,
    escrowMatches === escrowFixtures.length
  );

  // --- online checks: live network ---
  if (process.env.SOMPI_SMOKE_OFFLINE) {
    console.log(`\nSOMPI_SMOKE_OFFLINE set; skipping live network checks.`);
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }
  console.log(`\nConnecting to ${NETWORK} via public resolver...`);
  const wallet = new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: process.env.SOMPI_NODE_URL });
  check("wallet: address derived", wallet.address.length > 0, wallet.address);

  try {
    const info = await wallet.serverInfo();
    check("rpc: connected to node", true, `version ${info.serverVersion}, synced=${info.isSynced}`);
    check("rpc: node has utxoindex", info.hasUtxoIndex === true);
    check(
      "rpc: virtual DAA score sane",
      BigInt(info.virtualDaaScore) > 0n,
      `daa=${info.virtualDaaScore}`
    );

    const balance = await wallet.balanceSompi();
    check("rpc: balance query", balance >= 0n, `${formatKas(balance)} KAS`);

    const fees = await wallet.feeEstimate();
    const normal = (fees as any).estimate?.normalBuckets?.[0]?.feerate;
    check("rpc: fee estimate", normal !== undefined, `normal feerate=${normal} sompi/gram`);
  } catch (e) {
    check("rpc: live network checks", false, e instanceof Error ? e.message : String(e));
  } finally {
    await wallet.disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
