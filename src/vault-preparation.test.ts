import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  Transaction,
  payToScriptHashScript,
} from "./kaspa-wasm.js";
import { buildRedeemScript } from "./vault/template.js";
import { KaspaWallet } from "./wallet.js";
import { VaultManager, generateOwnerKey } from "./vault.js";

test("vault staging is prepared, submitted, observed, and committed at separate durable edges", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-vault-prepared-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({
    networkId: "testnet-10",
    dataDir: path.join(directory, "wallet"),
  });
  const vault = new VaultManager(directory, "testnet-10");
  const created = vault.create(500_000_000n, generateOwnerKey().publicKey, 300n);
  const covenantId = "aa".repeat(32);
  const fundingTxid = "bb".repeat(32);
  const funded = {
    ...created,
    covenantId,
    currentOutpoint: { txid: fundingTxid, index: 0 },
  };
  const configPath = path.join(directory, "vault", "config.json");
  fs.writeFileSync(configPath, JSON.stringify(funded, null, 2), { mode: 0o600 });

  const vaultAmount = 400_000_000n;
  const vaultScript = payToScriptHashScript(
    buildRedeemScript(
      funded.agentPublic,
      funded.ownerPublic,
      BigInt(funded.maxOutflowSompi),
      BigInt(funded.windowSizeDaa),
      {
        windowStartDaa: BigInt(funded.windowStartDaa),
        spentInWindowSompi: BigInt(funded.spentInWindowSompi),
      }
    )
  );
  let submitted: Transaction | undefined;
  (wallet as any).client = async () => ({
    getUtxosByAddresses: async (addresses: string[]) => {
      if (addresses.length === 1 && addresses[0] === funded.address) {
        return {
          entries: [
            {
              outpoint: { transactionId: fundingTxid, index: 0 },
              amount: vaultAmount,
              scriptPublicKey: vaultScript,
              blockDaaScore: 1n,
              isCoinbase: false,
              covenantId,
            },
          ],
        };
      }
      if (!submitted) return { entries: [] };
      const txid = String(submitted.finalize());
      return {
        entries: [
          {
            outpoint: { transactionId: txid, index: 0 },
            amount: submitted.outputs[0].value,
            scriptPublicKey: submitted.outputs[0].scriptPublicKey,
            blockDaaScore: 9n,
            isCoinbase: false,
          },
          {
            outpoint: { transactionId: txid, index: 1 },
            amount: submitted.outputs[1].value,
            scriptPublicKey: submitted.outputs[1].scriptPublicKey,
            blockDaaScore: 9n,
            isCoinbase: false,
            covenantId,
          },
        ],
      };
    },
    getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
    getServerInfo: async () => ({ virtualDaaScore: "100" }),
    submitTransaction: async ({ transaction }: { transaction: Transaction }) => {
      submitted?.free();
      submitted = new Transaction(transaction);
      return { transactionId: String(submitted.finalize()) };
    },
  });

  try {
    const before = vault.config();
    const prepared = await vault.prepareSend(wallet, wallet.address, 70_000_000n);
    const agentPrivate = fs.readFileSync(path.join(directory, "vault", "agent-key"), "utf8").trim();
    assert.equal(vault.config().currentOutpoint?.txid, fundingTxid);
    assert.equal(prepared.destinationOutpoint.txid, prepared.transactionId);
    assert.equal(prepared.continuationOutpoint.txid, prepared.transactionId);
    assert.equal(prepared.amountSompi, 70_000_000n);
    assert.equal(prepared.transaction.includes(agentPrivate), false);
    assert.equal(await vault.observePreparedSend(wallet, prepared), undefined);

    assert.equal((await vault.submitPreparedSend(wallet, prepared)).transactionId, prepared.transactionId);
    assert.equal(vault.config().currentOutpoint?.txid, fundingTxid);
    const observed = await vault.observePreparedSend(wallet, prepared);
    assert.ok(observed);
    assert.equal(observed.destinationOutpoint.txid, prepared.transactionId);
    assert.equal(observed.continuationOutpoint.index, 1);

    const committed = vault.commitObservedSend(prepared, observed);
    assert.equal(committed.currentOutpoint?.txid, prepared.transactionId);
    assert.equal(committed.currentOutpoint?.index, 1);
    assert.equal(vault.commitObservedSend(prepared, observed).address, committed.address);

    fs.writeFileSync(configPath, JSON.stringify(before, null, 2), { mode: 0o600 });
    const stale = { ...prepared, baseConfigDigest: "sha256:" + "A".repeat(43) };
    assert.throws(() => vault.commitObservedSend(stale, observed), /state advanced|metadata is invalid/);
  } finally {
    submitted?.free();
    vaultScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
