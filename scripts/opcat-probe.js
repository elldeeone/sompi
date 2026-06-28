#!/usr/bin/env node
/**
 * Probe: is OpCat (0x7e) enabled by consensus on this network?
 *
 * Builds a P2SH whose redeem script is:  OP_CAT  PUSH(0xaabb)  OP_EQUAL
 * and spends it with scriptSig args PUSH(0xaa) PUSH(0xbb). If the node accepts
 * the spend, OpCat concatenated them on-chain. The escrow covenant relies on
 * this to build its full voucher message in-script before CheckSigFromStack.
 *
 * Usage: SOMPI_NODE_URL=10.0.3.26 node scripts/opcat-probe.js
 */
const os = require("node:os");
const path = require("node:path");
const { KaspaWallet } = require("../dist/wallet");
const {
  Transaction,
  addressFromScriptPublicKey,
  payToScriptHashScript,
  payToScriptHashSignatureScript,
} = require("../vendor/kaspa-wasm/kaspa");

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const NODE = process.env.SOMPI_NODE_URL ?? "10.0.3.26";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUBNETWORK_NATIVE = "00".repeat(20);
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h, "hex"));

async function main() {
  const wallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: path.join(os.homedir(), ".sompi", NETWORK),
    nodeUrl: NODE,
  });
  const rpc = await wallet.client();

  // redeem: OP_CAT  OP_PUSH2 aa bb  OP_EQUAL
  const redeem = hexToBytes("7e02aabb87");
  const spk = payToScriptHashScript(redeem);
  const addr = addressFromScriptPublicKey(spk, NETWORK).toString();
  console.log(`probe P2SH address: ${addr}`);

  await wallet.send(addr, 50_000_000n);
  await sleep(3000);

  const { entries } = await rpc.getUtxosByAddresses([addr]);
  if (!entries.length) throw new Error("probe address unfunded");
  const e = entries[0];
  const utxo = {
    txid: String(e?.outpoint?.transactionId ?? e?.entry?.outpoint?.transactionId),
    index: Number(e?.outpoint?.index ?? e?.entry?.outpoint?.index),
    amount: BigInt(e?.amount ?? e?.entry?.amount ?? 0),
  };

  const base = {
    previousOutpoint: { transactionId: utxo.txid, index: utxo.index },
    sequence: 0n,
    sigOpCount: 0,
    utxo: {
      outpoint: { transactionId: utxo.txid, index: utxo.index },
      amount: utxo.amount,
      scriptPublicKey: spk,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };

  // args: PUSH(0xaa) PUSH(0xbb)  -> stack [aa, bb]
  const args = hexToBytes("01aa01bb");
  const signatureScript = payToScriptHashSignatureScript(redeem, args);
  const outputs = [{ value: utxo.amount - 2_000_000n, scriptPublicKey: payToScriptHashScript(hexToBytes("51")) }];
  const transaction = {
    version: 0, inputs: [{ ...base, signatureScript }], outputs,
    lockTime: 0n, subnetworkId: SUBNETWORK_NATIVE, gas: 0n, payload: "",
  };

  try {
    const { transactionId } = await rpc.submitTransaction({ transaction, allowOrphan: false });
    console.log(`OpCat ENABLED — spend accepted, txid ${String(transactionId).slice(0, 20)}`);
    console.log("RESULT: OPCAT_OK");
  } catch (err) {
    console.log(`OpCat spend rejected: ${String(err.message ?? err).slice(0, 200)}`);
    console.log("RESULT: OPCAT_FAIL");
  }
  await wallet.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error("probe failed:", e); process.exit(2); });
