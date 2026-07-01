#!/usr/bin/env node
/**
 * Server-side: claim earned kaspa-escrow funds to an address.
 *
 * Reads the EscrowServer state (server key, refund timeout, client
 * channels) from a service data dir and claims each client's authorized
 * amount with its latest voucher.
 *
 * Usage:
 *   SOMPI_NODE_URL=<node> node scripts/escrow-claim.js --preview <serviceDataDir>
 *   SOMPI_NODE_URL=<node> node scripts/escrow-claim.js <serviceDataDir> <destinationAddress>
 *   e.g. node scripts/escrow-claim.js ~/.sompi/testnet-10/service kaspatest:qq...
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KaspaWallet, formatKas } = require("../dist/wallet");
const { EscrowServer } = require("../dist/x402/escrow-server");

async function main() {
  const preview = process.argv.includes("--preview");
  const args = process.argv.slice(2).filter((arg) => arg !== "--preview");
  const [dataDirArg, destination] = args;
  if (!dataDirArg || (!preview && !destination)) {
    console.error("usage: escrow-claim.js [--preview] <serviceDataDir> [destinationAddress]");
    process.exit(2);
  }
  const dataDir = dataDirArg.replace(/^~/, os.homedir());
  const network = process.env.SOMPI_NETWORK ?? "testnet-10";
  const cfgPath = path.join(dataDir, "escrow-server-config.json");
  const cfg = loadServerConfig(cfgPath, preview);
  if (!cfg) process.exit(preview ? 0 : 1);

  const wallet = new KaspaWallet({
    networkId: network,
    dataDir: path.join(os.homedir(), ".sompi", network),
    nodeUrl: process.env.SOMPI_NODE_URL,
  });
  const server = new EscrowServer({
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

  const claimable = server.claimableChannels();
  if (preview) {
    if (!claimable.length) {
      console.log(JSON.stringify({ summary: "No escrow revenue is claimable right now.", claimableCount: 0 }, null, 2));
    } else {
      const total = claimable.reduce((sum, c) => sum + BigInt(c.authorizedSompi), 0n);
      console.log(
        JSON.stringify(
          {
            summary: `${claimable.length} channel(s) are claimable for ${formatKas(total)} KAS total.`,
            claimableCount: claimable.length,
            totalClaimableSompi: total.toString(),
            totalClaimableKas: formatKas(total),
            claimable: claimable.map((c) => ({
              ...c,
              authorizedKas: formatKas(BigInt(c.authorizedSompi)),
            })),
          },
          null,
          2
        )
      );
    }
    await wallet.disconnect();
    process.exit(0);
  }

  const claims = await server.claimAll(destination);
  if (!claims.length) {
    console.log(JSON.stringify({ summary: "No escrow revenue was claimable.", claimedCount: 0 }, null, 2));
  }
  let total = 0n;
  const receipts = [];
  for (const c of claims) {
    total += BigInt(c.amountSompi);
    receipts.push({
      clientPublic: c.clientPublic,
      txid: c.txid,
      amountSompi: c.amountSompi,
      amountKas: formatKas(BigInt(c.amountSompi)),
    });
  }
  if (claims.length) {
    console.log(
      JSON.stringify(
        {
          summary: `Claimed ${formatKas(total)} KAS from ${claims.length} escrow channel(s).`,
          claimedCount: claims.length,
          totalClaimedSompi: total.toString(),
          totalClaimedKas: formatKas(total),
          destination,
          receipts,
        },
        null,
        2
      )
    );
  }
  await wallet.disconnect();
  process.exit(0);
}

function loadServerConfig(cfgPath, preview) {
  if (!fs.existsSync(cfgPath)) {
    const response = {
      summary: "No escrow service state was found, so there is nothing claimable from this directory.",
      status: "not_configured",
      claimableCount: 0,
      configPath: cfgPath,
      userAction:
        "Start the demo service once to create seller escrow state, or pass the correct service data directory.",
    };
    console[preview ? "log" : "error"](JSON.stringify(response, null, 2));
    return null;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (!cfg.privateKey || !cfg.publicKey || cfg.refundTimeout === undefined) {
      throw new Error("missing privateKey, publicKey, or refundTimeout");
    }
    return cfg;
  } catch (error) {
    const response = {
      summary: "The escrow service state exists but is not readable.",
      status: "invalid_config",
      claimableCount: 0,
      configPath: cfgPath,
      userAction: "Restore the service data directory from backup or restart the demo service with fresh state.",
      error: String(error.message ?? error),
    };
    console.error(JSON.stringify(response, null, 2));
    return null;
  }
}

main().catch((e) => {
  console.error("escrow-claim failed:", e.message ?? e);
  process.exit(1);
});
