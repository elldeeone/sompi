#!/usr/bin/env node
/**
 * Submit a raw transaction JSON object to a Kaspa node.
 *
 * Usage: SOMPI_NODE_URL=<node> node scripts/submit-tx.js <tx.json>
 */
globalThis.WebSocket = require("websocket").w3cwebsocket;
const fs = require("node:fs");
const { RpcClient } = require("../vendor/kaspa-wasm/kaspa");

async function main() {
  const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const transaction = {
    version: raw.version,
    inputs: raw.inputs.map((i) => ({
      previousOutpoint: i.previousOutpoint,
      signatureScript: i.signatureScript,
      sequence: BigInt(i.sequence),
      sigOpCount: i.sigOpCount,
    })),
    outputs: raw.outputs.map((o) => ({
      value: BigInt(o.value),
      scriptPublicKey: o.scriptPublicKey,
    })),
    lockTime: BigInt(raw.lockTime),
    subnetworkId: raw.subnetworkId,
    gas: BigInt(raw.gas),
    payload: raw.payload,
  };

  const rpc = new RpcClient({ url: process.env.SOMPI_NODE_URL ?? "10.0.3.26", networkId: "testnet-10" });
  await rpc.connect({ timeoutDuration: 10_000, retries: 1 });
  try {
    const { transactionId } = await rpc.submitTransaction({ transaction, allowOrphan: false });
    console.log("ACCEPTED", transactionId);
  } catch (e) {
    console.log("REJECTED", String(e));
    process.exitCode = 1;
  } finally {
    await rpc.disconnect();
  }
}

main();
