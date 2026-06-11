/**
 * End-to-end smoke test against a live network (default testnet-10).
 * Exercises: resolver connection, server info, address derivation,
 * balance, fee estimation, and local policy enforcement.
 *
 * Usage: npm run build && npm run smoke
 */
import * as os from "node:os";
import * as path from "node:path";
import { PolicyEngine, PolicyViolation } from "./policy";
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
