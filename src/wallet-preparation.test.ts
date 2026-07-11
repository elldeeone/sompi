import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  Transaction,
  addressFromScriptPublicKey,
  payToAddressScript,
} from "./kaspa-wasm.js";
import { KaspaWallet, generateWalletKey } from "./wallet.js";

test("wallet send prepares once, enforces pre-sign fee ceiling, and observes spent outputs from chain history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-wallet-prepared-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: directory });
  const destination = generateWalletKey("testnet-10").address;
  const sourceScript = payToAddressScript(wallet.address);
  const entriesByAddress = new Map<string, any[]>([
    [wallet.address, [{
      outpoint: { transactionId: "77".repeat(32), index: 0 },
      amount: 300_000_000n,
      scriptPublicKey: sourceScript,
      blockDaaScore: 1n,
      isCoinbase: false,
    }]],
    [destination, []],
  ]);
  const accepted = new Set<string>();
  const transactions: Transaction[] = [];
  (wallet as any).client = async () => ({
    getUtxosByAddresses: async (addresses: string[]) => ({
      entries: addresses.flatMap((address) => entriesByAddress.get(address) ?? []),
    }),
    getFeeEstimate: async () => ({ estimate: { normalBuckets: [{ feerate: 100 }] } }),
    submitTransaction: async ({ transaction }: { transaction: Transaction }) => {
      const submitted = new Transaction(transaction);
      transactions.push(submitted);
      const transactionId = String(submitted.finalize());
      accepted.add(transactionId);
      entriesByAddress.set(wallet.address, []);
      for (let index = 0; index < submitted.outputs.length; index++) {
        const output = submitted.outputs[index];
        const address = addressFromScriptPublicKey(output.scriptPublicKey, wallet.networkId);
        try {
          const target = address?.toString();
          if (!target) throw new Error("test output address unavailable");
          entriesByAddress.set(target, [
            ...(entriesByAddress.get(target) ?? []),
            {
              outpoint: { transactionId, index },
              amount: BigInt(output.value),
              scriptPublicKey: output.scriptPublicKey,
              blockDaaScore: 10n,
              isCoinbase: false,
            },
          ]);
        } finally {
          address?.free();
        }
      }
      return { transactionId };
    },
    getMempoolEntry: async () => {
      throw new Error("transaction not found");
    },
    getVirtualChainFromBlock: async () => ({
      acceptedTransactionIds: [...accepted].map((transactionId) => ({
        acceptingBlockHash: "aa".repeat(32),
        acceptedTransactionIds: [transactionId],
      })),
    }),
  });

  try {
    await assert.rejects(
      wallet.prepareSend(destination, 100_000_000n, 1n),
      /fee estimate exceeds the capacity reserved before signing/
    );

    const prepared = await wallet.prepareSend(destination, 100_000_000n, 20_000_000n);
    const privateKey = fs.readFileSync(path.join(directory, "wallet-key"), "utf8").trim();
    assert.equal(prepared.transaction.includes(privateKey), false);
    assert.equal(
      (await wallet.observePreparedSend(prepared, "bb".repeat(32))).status,
      "not_submitted"
    );
    await wallet.submitPreparedSend(prepared);
    assert.equal(
      (await wallet.observePreparedSend(prepared, "bb".repeat(32))).status,
      "observed"
    );

    // The recipient can spend its output before a crashed caller records the
    // first observation. Accepted-chain history still proves this exact tx.
    entriesByAddress.set(destination, []);
    assert.equal(
      (await wallet.observePreparedSend(prepared, "bb".repeat(32))).status,
      "observed"
    );
  } finally {
    for (const transaction of transactions) transaction.free();
    sourceScript.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
