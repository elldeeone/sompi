#!/usr/bin/env node
/**
 * Sweep x402 tab deposits to an address.
 *
 * Usage: SOMPI_NODE_URL=<node> node scripts/sweep-tabs.js <tabsDataDir> <destination> [--all]
 *
 * Default sweeps only exhausted tabs; --all also takes unspent client credit
 * (use when decommissioning a seller).
 */
const os = require("node:os");
const path = require("node:path");
const { TabServer } = require("../dist/x402/server");
const { KaspaWallet } = require("../dist/wallet");

async function main() {
  const [dataDir, destination, flag] = process.argv.slice(2);
  if (!dataDir || !destination) {
    console.error("usage: sweep-tabs.js <tabsDataDir> <destination> [--all]");
    process.exit(2);
  }
  const network = process.env.SOMPI_NETWORK ?? "testnet-10";
  const wallet = new KaspaWallet({
    networkId: network,
    dataDir: path.join(os.homedir(), ".sompi", network),
    nodeUrl: process.env.SOMPI_NODE_URL,
  });
  const tabs = new TabServer({
    networkId: network,
    rpc: () => wallet.client(),
    minDepositSompi: 0n,
    pricePerRequestSompi: 1_000n,
    dataDir,
  });
  const results = await tabs.sweep(destination, flag === "--all");
  if (!results.length) {
    console.log("nothing to sweep");
  }
  for (const r of results) {
    console.log(`swept tab ${r.tabId}: ${r.sweptSompi} sompi, txid ${r.txid}`);
  }
  await wallet.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("sweep failed:", e);
  process.exit(1);
});
