#!/usr/bin/env node
/**
 * Live proof of the SompiEscrow payment channel on testnet-10.
 *
 * Exercises the trust-minimized paths against the real node:
 *   1. client issues a voucher bound to the full funding outpoint; server claims
 *      within it -> ACCEPTED on-chain
 *   2. server replays the SAME voucher against the claim's change output to try
 *      to drain the escrow -> REJECTED by consensus (the replay protection)
 *   3. server tries to claim MORE than the voucher authorizes -> REJECTED
 *   4. (second escrow) client refunds after timeout -> ACCEPTED on-chain
 *
 * Checks 2 and 3 are real consensus rejections (the signed transaction is
 * built and submitted; the node refuses it), not client-side guards.
 *
 * Usage: SOMPI_NODE_URL=<node> node scripts/escrow-live.js
 */
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { KaspaWallet } = require("../dist/wallet");
const escrow = require("../dist/x402/escrow");
const { buildEscrowRedeemScript, buildClaimArgs, amountToLe8 } = require("../dist/x402/escrow-template");
const {
  PrivateKey,
  SighashType,
  Transaction,
  createInputSignature,
  payToAddressScript,
  payToScriptHashScript,
  payToScriptHashSignatureScript,
} = require("../vendor/kaspa-wasm/kaspa");

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const NODE = process.env.SOMPI_NODE_URL ?? "10.0.3.26";
const DATA_DIR = path.join(os.homedir(), ".sompi", NETWORK);
const RECOVERY_PATH = path.join(DATA_DIR, `escrow-live-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const WAIT_SECONDS = Number(process.env.SOMPI_ESCROW_LIVE_WAIT_SECONDS ?? 240);
if (!Number.isFinite(WAIT_SECONDS) || WAIT_SECONDS < 1) throw new Error("SOMPI_ESCROW_LIVE_WAIT_SECONDS must be a positive number");
const SUBNETWORK_NATIVE = "00".repeat(20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h, "hex"));

function writeRecovery(recovery) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(RECOVERY_PATH, `${JSON.stringify(recovery, null, 2)}\n`, { mode: 0o600 });
}

function addRecoveryEscrow(recovery, kind, params, client, server, address) {
  const entry = {
    kind,
    address,
    clientPrivate: client.privateKey,
    clientPublic: client.publicKey,
    serverPrivate: server.privateKey,
    serverPublic: server.publicKey,
    timeout: params.timeout.toString(),
    fundingSubmitTxid: null,
    fundingOutpoint: null,
    claimTxid: null,
    cleanupTxid: null,
  };
  recovery.escrows.push(entry);
  writeRecovery(recovery);
  return entry;
}

async function waitForEscrowFunding(wallet, params, expectedTxid, label) {
  let last = "not checked";
  for (let attempt = 0; attempt < WAIT_SECONDS; attempt++) {
    try {
      const funding = await escrow.escrowFunding(wallet, params);
      if (!expectedTxid || funding.txid === expectedTxid) return funding;
      last = `saw ${funding.txid}:${funding.index}, waiting for ${expectedTxid}`;
    } catch (e) {
      last = String(e.message ?? e);
    }
    await sleep(1_000);
  }
  throw new Error(`${label} funding ${expectedTxid} was not indexed after ${WAIT_SECONDS}s (${last})`);
}

async function waitForEscrowChange(wallet, params, previous, label) {
  let last = "not checked";
  for (let attempt = 0; attempt < WAIT_SECONDS; attempt++) {
    try {
      const funding = await escrow.escrowFunding(wallet, params);
      if (funding.txid !== previous.txid || funding.index !== previous.index) return funding;
      last = `still seeing ${funding.txid}:${funding.index}`;
    } catch (e) {
      last = String(e.message ?? e);
    }
    await sleep(1_000);
  }
  throw new Error(`${label} change UTXO was not indexed after ${WAIT_SECONDS}s (${last})`);
}

/**
 * Build and submit a claim against a SPECIFIC escrow UTXO with a SPECIFIC
 * voucher — bypassing the client-side guards so we test consensus directly.
 * Returns the txid on acceptance; throws with the node's rejection otherwise.
 */
async function rawClaim(wallet, params, serverPrivateHex, utxo, voucherHex, voucherAmount, claimSompi, dest, feeSompi) {
  const rpc = await wallet.client();
  const redeem = buildEscrowRedeemScript(params.clientPublic, params.serverPublic, params.timeout, wallet.networkId);
  const escrowSpk = payToScriptHashScript(redeem);
  const destSpk = payToAddressScript(dest);
  const base = {
    previousOutpoint: { transactionId: utxo.txid, index: utxo.index },
    sequence: 0n,
    sigOpCount: 3,
    utxo: {
      outpoint: { transactionId: utxo.txid, index: utxo.index },
      amount: utxo.amountSompi,
      scriptPublicKey: escrowSpk,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
  const outputs = [
    { value: claimSompi - feeSompi, scriptPublicKey: destSpk },
    { value: utxo.amountSompi - claimSompi, scriptPublicKey: escrowSpk },
  ];
  const txShape = { version: 0, outputs, lockTime: 0n, subnetworkId: SUBNETWORK_NATIVE, gas: 0n, payload: "" };
  const unsigned = new Transaction({ ...txShape, inputs: [{ ...base, signatureScript: "" }] });
  const serverSig = hexToBytes(createInputSignature(unsigned, 0, new PrivateKey(serverPrivateHex), SighashType.All)).slice(1);
  const args = buildClaimArgs(serverSig, hexToBytes(voucherHex), amountToLe8(voucherAmount));
  const signatureScript = payToScriptHashSignatureScript(redeem, args);
  const transaction = { ...txShape, inputs: [{ ...base, signatureScript }] };
  const { transactionId } = await rpc.submitTransaction({ transaction, allowOrphan: false });
  return String(transactionId);
}

async function main() {
  const wallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: DATA_DIR,
    nodeUrl: NODE,
  });
  const recovery = {
    createdAt: new Date().toISOString(),
    network: NETWORK,
    node: NODE,
    note: "Temporary escrow-live keys for recovering testnet funds if this harness exits early.",
    escrows: [],
  };
  const dest = wallet.address;
  let failures = 0;
  const check = (name, pass, detail = "") => {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures++;
  };

  const client = escrow.generateChannelKey();
  const server = escrow.generateChannelKey();
  const params = { clientPublic: client.publicKey, serverPublic: server.publicKey, timeout: 1n };
  const addr = escrow.deriveEscrowAddress(params, NETWORK);
  const replayRecovery = addRecoveryEscrow(recovery, "claim-replay", params, client, server, addr);
  console.log(`escrow (claim/replay test): ${addr}`);

  const replayDeposit = await wallet.send(addr, 300_000_000n); // 3 KAS
  replayRecovery.fundingSubmitTxid = replayDeposit.txid;
  writeRecovery(recovery);
  console.log(`funding tx (claim/replay test): ${replayDeposit.txid}`);

  // Bind the voucher to the full funding outpoint (what the node will introspect).
  const funding = await waitForEscrowFunding(wallet, params, replayDeposit.txid, "claim/replay");
  replayRecovery.fundingOutpoint = { txid: funding.txid, index: funding.index, amountSompi: funding.amountSompi.toString() };
  writeRecovery(recovery);
  const AUTH = 100_000_000n; // client authorizes 1 KAS, once
  const voucher = escrow.makeVoucher(client.privateKey, params, NETWORK, funding, AUTH);
  check("voucher verifies off-chain (bound to full funding outpoint)",
    escrow.verifyVoucher(params, NETWORK, funding, AUTH, voucher.voucherHex));

  // 1. honest claim within the voucher -> accepted
  let claimTxid;
  try {
    claimTxid = await rawClaim(wallet, params, server.privateKey, funding, voucher.voucherHex, AUTH, AUTH, dest, 2_000_000n);
    replayRecovery.claimTxid = claimTxid;
    writeRecovery(recovery);
    check("honest claim within voucher accepted on-chain", true, claimTxid.slice(0, 16));
  } catch (e) {
    check("honest claim within voucher accepted on-chain", false, String(e.message ?? e).slice(0, 160));
  }

  // 2. REPLAY the same voucher against the change output (new outpoint) -> must be rejected
  if (claimTxid) {
    const change = await waitForEscrowChange(wallet, params, funding, "claim/replay"); // the change UTXO, new outpoint
    const replayBoundToOldOutpoint = change.txid !== funding.txid || change.index !== funding.index;
    try {
      await rawClaim(wallet, params, server.privateKey, change, voucher.voucherHex, AUTH, AUTH, dest, 2_000_000n);
      check("voucher replay against change REJECTED by consensus", false, "drain succeeded — VULNERABLE");
    } catch (e) {
      const msg = String(e.message ?? e);
      check("voucher replay against change REJECTED by consensus",
        replayBoundToOldOutpoint && /verif|script|signature|reject|invalid/i.test(msg),
        msg.slice(0, 120));
    }
    try {
      const cleanupTxid = await escrow.refundEscrow(wallet, params, client.privateKey, dest, 2_000_000n);
      replayRecovery.cleanupTxid = cleanupTxid;
      writeRecovery(recovery);
      check("cleanup refund of replay-test change accepted on-chain", true, cleanupTxid.slice(0, 16));
    } catch (e) {
      check("cleanup refund of replay-test change accepted on-chain", false, String(e.message ?? e).slice(0, 160));
    }
  }

  // 3. over-claim past the voucher amount on the original funding (consensus, not a guard)
  //    (fresh escrow so the funding UTXO is unspent)
  const c2 = escrow.generateChannelKey();
  const s2 = escrow.generateChannelKey();
  const p2 = { clientPublic: c2.publicKey, serverPublic: s2.publicKey, timeout: 1n };
  const addr2 = escrow.deriveEscrowAddress(p2, NETWORK);
  const overclaimRecovery = addRecoveryEscrow(recovery, "overclaim", p2, c2, s2, addr2);
  const overclaimDeposit = await wallet.send(addr2, 300_000_000n);
  overclaimRecovery.fundingSubmitTxid = overclaimDeposit.txid;
  writeRecovery(recovery);
  console.log(`funding tx (over-claim test): ${overclaimDeposit.txid}`);
  const f2 = await waitForEscrowFunding(wallet, p2, overclaimDeposit.txid, "over-claim");
  overclaimRecovery.fundingOutpoint = { txid: f2.txid, index: f2.index, amountSompi: f2.amountSompi.toString() };
  writeRecovery(recovery);
  const v2 = escrow.makeVoucher(c2.privateKey, p2, NETWORK, f2, AUTH); // authorizes 1 KAS
  try {
    // present the real 1-KAS voucher but try to take 2 KAS in outputs[0]
    await rawClaim(wallet, p2, s2.privateKey, f2, v2.voucherHex, AUTH, 200_000_000n, dest, 2_000_000n);
    check("over-claim past voucher REJECTED by consensus", false, "over-claim succeeded — VULNERABLE");
  } catch (e) {
    check("over-claim past voucher REJECTED by consensus", true, String(e.message ?? e).slice(0, 90));
    try {
      const cleanupTxid = await escrow.refundEscrow(wallet, p2, c2.privateKey, dest, 2_000_000n);
      overclaimRecovery.cleanupTxid = cleanupTxid;
      writeRecovery(recovery);
      check("cleanup refund of over-claim escrow accepted on-chain", true, cleanupTxid.slice(0, 16));
    } catch (refundError) {
      check("cleanup refund of over-claim escrow accepted on-chain", false, String(refundError.message ?? refundError).slice(0, 160));
    }
  }

  // 4. refund path
  const c3 = escrow.generateChannelKey();
  const refundParams = { clientPublic: c3.publicKey, serverPublic: server.publicKey, timeout: 1n };
  const refundAddr = escrow.deriveEscrowAddress(refundParams, NETWORK);
  const refundRecovery = addRecoveryEscrow(recovery, "refund", refundParams, c3, server, refundAddr);
  console.log(`escrow (refund test): ${refundAddr}`);
  const refundDeposit = await wallet.send(refundAddr, 200_000_000n);
  refundRecovery.fundingSubmitTxid = refundDeposit.txid;
  writeRecovery(recovery);
  console.log(`funding tx (refund test): ${refundDeposit.txid}`);
  const refundFunding = await waitForEscrowFunding(wallet, refundParams, refundDeposit.txid, "refund");
  refundRecovery.fundingOutpoint = { txid: refundFunding.txid, index: refundFunding.index, amountSompi: refundFunding.amountSompi.toString() };
  writeRecovery(recovery);
  try {
    const txid = await escrow.refundEscrow(wallet, refundParams, c3.privateKey, dest, 2_000_000n);
    refundRecovery.claimTxid = txid;
    writeRecovery(recovery);
    check("client refund after timeout accepted on-chain", true, txid.slice(0, 16));
  } catch (e) {
    check("client refund after timeout accepted on-chain", false, String(e.message ?? e).slice(0, 160));
  }

  console.log(`\n${failures === 0 ? "ALL LIVE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log(`recovery file: ${RECOVERY_PATH}`);
  await wallet.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("escrow-live failed:", e);
  process.exit(1);
});
