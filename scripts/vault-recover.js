#!/usr/bin/env node
/**
 * Operator-side vault recovery: drain a vault via the unrestricted owner path.
 * Run this on YOUR machine (where the owner private key lives), never on the
 * agent's host.
 *
 * Usage:
 *   SOMPI_NODE_URL=<node> node scripts/vault-recover.js \
 *     <ownerPrivateKey> <agentPublicKey> <maxOutflowSompi> \
 *     <windowSizeDaa> <windowStartDaa> <spentInWindowSompi> <destinationAddress> [feeSompi]
 */
const os = require("node:os");
const path = require("node:path");
const { PrivateKey } = require("../vendor/kaspa-wasm/kaspa");
const { spendVault } = require("../dist/vault");
const { KaspaWallet } = require("../dist/wallet");

async function main() {
  const [ownerPriv, agentPublic, maxOutflow, windowSize, windowStart, spentInWindow, destination, fee] = process.argv.slice(2);
  if (!ownerPriv || !agentPublic || !maxOutflow || !windowSize || !windowStart || !spentInWindow || !destination) {
    console.error(
      "usage: vault-recover.js <ownerPrivateKey> <agentPublicKey> <maxOutflowSompi> " +
        "<windowSizeDaa> <windowStartDaa> <spentInWindowSompi> <destination> [feeSompi]"
    );
    process.exit(2);
  }
  const network = process.env.SOMPI_NETWORK ?? "testnet-10";
  const ownerPublic = String(new PrivateKey(ownerPriv).toKeypair().xOnlyPublicKey);

  const wallet = new KaspaWallet({
    networkId: network,
    dataDir: path.join(os.homedir(), ".sompi", network),
    nodeUrl: process.env.SOMPI_NODE_URL,
  });

  // Reconstruct the vault address from the template (no agent cooperation needed).
  const { VAULT_TEMPLATE_VERSION } = require("../dist/vault/template");
  const { buildRedeemScript } = require("../dist/vault/template");
  const { payToScriptHashScript, addressFromScriptPublicKey } = require("../vendor/kaspa-wasm/kaspa");
  const state = { windowStartDaa: BigInt(windowStart), spentInWindowSompi: BigInt(spentInWindow) };
  const redeem = buildRedeemScript(agentPublic, ownerPublic, BigInt(maxOutflow), BigInt(windowSize), state);
  const address = addressFromScriptPublicKey(payToScriptHashScript(redeem), network).toString();
  console.log(`vault address: ${address}`);

  const { txid } = await spendVault({
    wallet,
    config: {
      template: VAULT_TEMPLATE_VERSION,
      agentPublic,
      ownerPublic,
      maxOutflowSompi: maxOutflow,
      windowSizeDaa: windowSize,
      windowStartDaa: windowStart,
      spentInWindowSompi: spentInWindow,
      address,
    },
    fn: "recover",
    privateKey: ownerPriv,
    destination,
    feeSompi: fee ? BigInt(fee) : undefined,
  });
  console.log(`recovered: ${txid}`);
  await wallet.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("recovery failed:", e.message ?? e);
  process.exit(1);
});
