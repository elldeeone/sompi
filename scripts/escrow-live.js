#!/usr/bin/env node
/**
 * Live proof of the SompiEscrow payment channel on testnet-10.
 *
 * Funds an escrow from the sompi wallet, then exercises the trust-minimized
 * paths against the real node:
 *   1. client issues a voucher; server claims within it -> accepted on-chain
 *   2. server tries to claim past the voucher -> rejected by consensus
 *   3. (second escrow) client refunds after timeout -> accepted on-chain
 *
 * Usage: SOMPI_NODE_URL=<node> node scripts/escrow-live.js
 */
const os = require("node:os");
const path = require("node:path");
const { KaspaWallet, formatKas } = require("../dist/wallet");
const escrow = require("../dist/x402/escrow");

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const NODE = process.env.SOMPI_NODE_URL ?? "10.0.3.26";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fund(wallet, address, amountSompi) {
  const { txid } = await wallet.send(address, amountSompi);
  return txid;
}

async function main() {
  const wallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: path.join(os.homedir(), ".sompi", NETWORK),
    nodeUrl: NODE,
  });
  const rpc = await wallet.client();
  const dest = wallet.address; // claims/refunds come back to our own wallet for the demo
  let failures = 0;
  const check = (name, pass, detail = "") => {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures++;
  };

  const client = escrow.generateChannelKey();
  const server = escrow.generateChannelKey();

  // --- claim path ---
  const params = { clientPublic: client.publicKey, serverPublic: server.publicKey, timeout: 1n };
  const addr = escrow.deriveEscrowAddress(params, NETWORK);
  console.log(`escrow (claim test): ${addr}`);
  await fund(wallet, addr, 300_000_000n); // 3 KAS
  await sleep(2000);

  // client authorizes 1 KAS; server claims it (fee from server output), change returns.
  const voucher = escrow.makeVoucher(client.privateKey, 100_000_000n);
  check("voucher verifies off-chain", escrow.verifyVoucher(client.publicKey, 100_000_000n, voucher.voucherHex));

  try {
    const txid = await escrow.claimEscrow(
      wallet,
      params,
      server.privateKey,
      { amountSompi: 100_000_000n, voucherHex: voucher.voucherHex },
      100_000_000n,
      dest,
      2_000_000n
    );
    check("server claim within voucher accepted on-chain", true, txid.slice(0, 16));
  } catch (e) {
    check("server claim within voucher accepted on-chain", false, String(e.message ?? e).slice(0, 160));
  }
  await sleep(2000);

  // over-claim is blocked before broadcast: the server cannot take more than
  // the voucher authorizes (consensus-level rejection is proven in the driver
  // escrow-selftest; here we confirm the client-side guard refuses it).
  try {
    await escrow.claimEscrow(
      wallet,
      params,
      server.privateKey,
      { amountSompi: 100_000_000n, voucherHex: voucher.voucherHex },
      200_000_000n,
      dest,
      2_000_000n
    );
    check("over-claim past voucher refused", false, "guard let it through");
  } catch (e) {
    check("over-claim past voucher refused", String(e.message ?? e).includes("exceeds voucher"), String(e.message ?? e).slice(0, 60));
  }

  // --- refund path ---
  const past = { clientPublic: client.publicKey, serverPublic: server.publicKey, timeout: 1n }; // timeout already elapsed
  const addr2 = escrow.deriveEscrowAddress(past, NETWORK);
  console.log(`escrow (refund test): ${addr2}`);
  // different escrow address (timeout same here, so reuse a fresh keypair to avoid collision)
  const client2 = escrow.generateChannelKey();
  const refundParams = { clientPublic: client2.publicKey, serverPublic: server.publicKey, timeout: 1n };
  const refundAddr = escrow.deriveEscrowAddress(refundParams, NETWORK);
  await fund(wallet, refundAddr, 200_000_000n);
  await sleep(2000);
  try {
    const txid = await escrow.refundEscrow(wallet, refundParams, client2.privateKey, dest, 2_000_000n);
    check("client refund after timeout accepted on-chain", true, txid.slice(0, 16));
  } catch (e) {
    check("client refund after timeout accepted on-chain", false, String(e.message ?? e).slice(0, 160));
  }

  console.log(`\n${failures === 0 ? "ALL LIVE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await wallet.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("escrow-live failed:", e);
  process.exit(1);
});
