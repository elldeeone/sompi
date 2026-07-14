import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const configuredRoot = process.env.SOMPI_SOURCE_ROOT ?? process.argv[2];
if (!configuredRoot) {
  console.error("usage: SOMPI_SOURCE_ROOT=relative/path/to/sompi node reproduce.mjs");
  process.exit(2);
}

const sourceRoot = resolve(configuredRoot);
const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
assert.equal(packageJson.name, "@elldeeone/sompi", "SOMPI_SOURCE_ROOT is not a Sompi source root");

const addressModule = await import(pathToFileURL(
  join(sourceRoot, "dist/adapters/kaspa-x402/address-codec.js"),
).href);
const verifierModule = await import(pathToFileURL(
  join(sourceRoot, "dist/adapters/kaspa-x402/chain-verifier.js"),
).href);

const { KaspaTestnet10AddressCodec } = addressModule;
const { RpcChainObservationSource } = verifierModule;
console.log("[+] loaded Sompi RPC observation adapter");

const now = Date.parse("2030-01-01T00:00:00.000Z");
const transactionId = "11".repeat(32);
const merchantAddress =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const scriptPublicKey = new KaspaTestnet10AddressCodec().scriptPublicKeyForAddress(
  merchantAddress,
  "kaspa:testnet-10",
);

const calls = { serverInfo: 0, utxos: 0, mempool: 0 };

// This object has no blockchain behind it. It supplies all node-health,
// membership, output, and DAA/finality facts used by the production adapter.
const fakeRpc = {
  getServerInfo: async () => {
    calls.serverInfo += 1;
    return {
      isSynced: true,
      hasUtxoIndex: true,
      networkId: "testnet-10",
      virtualDaaScore: 200n,
    };
  },
  getUtxosByAddresses: async () => {
    calls.utxos += 1;
    return {
      entries: [{
        outpoint: { transactionId, index: 1 },
        amount: 123n,
        scriptPublicKey: { version: 0, script: scriptPublicKey.slice(4) },
        blockDaaScore: 100n,
      }],
    };
  },
  getMempoolEntry: async () => {
    calls.mempool += 1;
    throw new Error("mempool lookup must not be reached");
  },
};

const source = new RpcChainObservationSource({
  rpc: { client: async () => fakeRpc },
  confirmedDaaDepth: 10,
  now: () => now,
});

const result = await source.observeExactOutput({
  network: "kaspa:testnet-10",
  transactionId,
  outpoint: `${transactionId}:1`,
  outputIndex: 1,
  merchantAddress,
  expectedAmountAtomic: "123",
  expectedScriptPublicKey: scriptPublicKey,
  minimumFinality: "confirmed",
  deadlineAtMs: now + 1_000,
  signal: new AbortController().signal,
});

assert.equal(result.status, "observed");
assert.equal(result.finality, "confirmed");
assert.deepEqual(calls, { serverInfo: 1, utxos: 1, mempool: 0 });

console.log(
  `[+] fake RPC calls: serverInfo=${calls.serverInfo} utxos=${calls.utxos} mempool=${calls.mempool}`,
);
console.log(JSON.stringify({
  acceptedFabrication: true,
  status: result.status,
  finality: result.finality,
}));
