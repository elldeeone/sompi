#!/usr/bin/env node
/**
 * Server-side: claim earned kaspa-escrow funds to an address.
 *
 * Reads the EscrowTabServer state (server key, refund timeout, client
 * channels) from a service data dir and claims each client's authorized
 * amount with its latest voucher.
 *
 * Usage: SOMPI_NODE_URL=<node> node scripts/escrow-claim.js <serviceDataDir> <destinationAddress>
 *   e.g. node scripts/escrow-claim.js ~/.sompi/testnet-10/service kaspatest:qq...
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KaspaWallet, formatKas } = require("../dist/wallet");
const { EscrowTabServer } = require("../dist/x402/escrow-server");

async function main() {
  const [dataDirArg, destination] = process.argv.slice(2);
  if (!dataDirArg || !destination) {
    console.error("usage: escrow-claim.js <serviceDataDir> <destinationAddress>");
    process.exit(2);
  }
  const dataDir = dataDirArg.replace(/^~/, os.homedir());
  const network = process.env.SOMPI_NETWORK ?? "testnet-10";
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "escrow-server-config.json"), "utf8"));

  const wallet = new KaspaWallet({
    networkId: network,
    dataDir: path.join(os.homedir(), ".sompi", network),
    nodeUrl: process.env.SOMPI_NODE_URL,
  });
  const server = new EscrowTabServer({
    networkId: network,
    rpc: () => wallet.client(),
    wallet: () => wallet,
    serverPrivateHex: cfg.privateKey,
    serverPublicHex: cfg.publicKey,
    refundTimeout: BigInt(cfg.refundTimeout),
    minDepositSompi: 0n,
    pricePerRequestSompi: 1n,
    dataDir,
  });

  const claims = await server.claimAll(destination);
  if (!claims.length) {
    console.log("nothing to claim (no outstanding vouchers)");
  }
  let total = 0n;
  for (const c of claims) {
    total += BigInt(c.amountSompi);
    console.log(`claimed ${formatKas(BigInt(c.amountSompi))} KAS from ${c.clientPublic.slice(0, 12)}… txid ${c.txid}`);
  }
  if (claims.length) console.log(`total claimed: ${formatKas(total)} KAS`);
  await wallet.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("escrow-claim failed:", e.message ?? e);
  process.exit(1);
});
