import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { payToAddressScript } from "./kaspa-wasm.js";
import { KaspaWallet, WalletPreparationError } from "./wallet.js";

test("wallet exposes bounded canonical receive UTXOs in deterministic order", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-wallet-funding-utxos-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: directory });
  const scriptPublicKey = payToAddressScript(wallet.address);
  (wallet as any).client = async () => ({
    getUtxosByAddresses: async () => ({ entries: [
      { outpoint: { transactionId: "b".repeat(64), index: 1 }, amount: 3n, scriptPublicKey },
      { entry: { outpoint: { transactionId: "a".repeat(64), index: 2 }, amount: 2n, scriptPublicKey } },
    ] }),
  });
  try {
    assert.deepEqual(await wallet.fundingUtxos(), [
      { transactionId: "a".repeat(64), index: 2, amountAtomic: "2" },
      { transactionId: "b".repeat(64), index: 1, amountAtomic: "3" },
    ]);
  } finally {
    await wallet.disconnect();
    scriptPublicKey.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("wallet rejects duplicated or malformed receive UTXO evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-wallet-funding-invalid-"));
  fs.chmodSync(directory, 0o700);
  const wallet = new KaspaWallet({ networkId: "testnet-10", dataDir: directory });
  const scriptPublicKey = payToAddressScript(wallet.address);
  const duplicate = { outpoint: { transactionId: "c".repeat(64), index: 0 }, amount: 1n, scriptPublicKey };
  (wallet as any).client = async () => ({ getUtxosByAddresses: async () => ({ entries: [duplicate, duplicate] }) });
  try {
    await assert.rejects(
      () => wallet.fundingUtxos(),
      (error: unknown) => error instanceof WalletPreparationError && error.code === "rpc_unavailable",
    );
  } finally {
    await wallet.disconnect();
    scriptPublicKey.free();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
