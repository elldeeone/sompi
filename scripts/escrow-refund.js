#!/usr/bin/env node
/**
 * Client-side: refund unspent balances from your escrow channels (active and
 * retired) after their refund timeout has passed. Use this to reclaim funds
 * left in escrows the server never fully claimed.
 *
 * Usage: SOMPI_NODE_URL=<node> node scripts/escrow-refund.js <clientDataDir> <destinationAddress>
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KaspaWallet, formatKas } = require("../dist/wallet");
const { PolicyEngine } = require("../dist/policy");
const { X402Client } = require("../dist/x402/client");
const { refundEscrow } = require("../dist/x402/escrow");

async function main() {
  const [dataDirArg, destination] = process.argv.slice(2);
  if (!dataDirArg || !destination) {
    console.error("usage: escrow-refund.js <clientDataDir> <destinationAddress>");
    process.exit(2);
  }
  const dataDir = dataDirArg.replace(/^~/, os.homedir());
  const network = process.env.SOMPI_NETWORK ?? "testnet-10";
  const wallet = new KaspaWallet({
    networkId: network,
    dataDir: path.join(os.homedir(), ".sompi", network),
    nodeUrl: process.env.SOMPI_NODE_URL,
  });
  const client = new X402Client(wallet, new PolicyEngine(dataDir), dataDir);
  const { active, retired } = client.escrowChannels();
  const all = [...active, ...retired];
  if (!all.length) {
    console.log("no escrow channels found");
    process.exit(0);
  }

  for (const e of all) {
    try {
      const txid = await refundEscrow(
        wallet,
        { clientPublic: e.clientPublic, serverPublic: e.serverPublic, timeout: BigInt(e.refundTimeout) },
        e.clientPrivate,
        destination,
        undefined
      );
      console.log(`refunded ${e.escrowAddress.slice(0, 16)}… txid ${txid}`);
    } catch (err) {
      console.log(`skip ${e.escrowAddress.slice(0, 16)}…: ${String(err.message ?? err).slice(0, 80)}`);
    }
  }
  await wallet.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("escrow-refund failed:", e.message ?? e);
  process.exit(1);
});
