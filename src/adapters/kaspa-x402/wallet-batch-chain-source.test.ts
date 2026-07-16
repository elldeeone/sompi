import * as assert from "node:assert/strict";
import test from "node:test";

import { KaspaTestnet10AddressCodec } from "./address-codec.js";
import { WalletBatchChainSource } from "./wallet-batch-chain-source.js";

const ADDRESS = "kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et";
const SCRIPT = new KaspaTestnet10AddressCodec().scriptPublicKeyForAddress(
  ADDRESS,
  "kaspa:testnet-10"
);

test("batch chain source exposes only bounded accepted Testnet-10 UTXOs", async () => {
  const source = new WalletBatchChainSource(provider({
    entries: [{
      address: ADDRESS,
      outpoint: { transactionId: "11".repeat(32), index: 2 },
      amount: 123n,
      scriptPublicKey: { version: 0, script: SCRIPT.slice(4) },
      blockDaaScore: 456n,
    }],
  }));
  assert.equal(await source.getVirtualDaaScore(), "500");
  assert.deepEqual(await source.getUtxos([ADDRESS]), [{
    outpoint: { txid: "11".repeat(32), index: 2 },
    amount: "123",
    scriptPublicKey: SCRIPT,
    address: ADDRESS,
  }]);
});

test("batch chain source rejects wrong network, duplicates, provisional, and unrequested data", async () => {
  assert.throws(
    () => new WalletBatchChainSource({ ...provider({ entries: [] }), networkId: "mainnet" }),
    /Testnet-10/
  );
  const duplicate = new WalletBatchChainSource(provider({ entries: [] }));
  await assert.rejects(duplicate.getUtxos([ADDRESS, ADDRESS]), /unique/);

  const provisional = new WalletBatchChainSource(provider({
    entries: [{
      outpoint: { transactionId: "22".repeat(32), index: 0 },
      amount: "1",
      scriptPublicKey: { version: 0, script: SCRIPT.slice(4) },
      blockDaaScore: 0,
    }],
  }));
  await assert.rejects(provisional.getUtxos([ADDRESS]), /not accepted/);

  const unrequested = new WalletBatchChainSource(provider({
    entries: [{
      outpoint: { transactionId: "33".repeat(32), index: 0 },
      amount: "1",
      scriptPublicKey: { version: 0, script: "51" },
      blockDaaScore: 1,
    }],
  }));
  await assert.rejects(unrequested.getUtxos([ADDRESS]), /requested address/);
});

test("batch chain source fails closed on unsynced or non-Testnet-10 evidence", async () => {
  const unsynced = new WalletBatchChainSource(provider({ entries: [], isSynced: false }));
  await assert.rejects(unsynced.getVirtualDaaScore(), /synced/);
  const wrongDag = new WalletBatchChainSource(provider({ entries: [], network: "mainnet" }));
  await assert.rejects(wrongDag.getUtxos([ADDRESS]), /not Testnet-10/);
});

function provider(options: Readonly<{
  entries: readonly unknown[];
  isSynced?: boolean;
  network?: string;
}>) {
  return {
    networkId: "testnet-10",
    serverInfo: async () => ({
      isSynced: options.isSynced ?? true,
      hasUtxoIndex: true,
      virtualDaaScore: "500",
    }),
    client: async () => ({
      getBlockDagInfo: async () => ({ network: options.network ?? "testnet-10" }),
      getUtxosByAddresses: async () => ({ entries: options.entries }),
    }),
  };
}
