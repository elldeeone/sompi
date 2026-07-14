import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const targetArgument = process.argv[2];
if (!targetArgument) {
  console.error("usage: node reproduce.mjs <relative-path-to-built-sompi-checkout>");
  process.exit(2);
}

const target = resolve(process.cwd(), targetArgument);
const addressModulePath = join(
  target,
  "dist/adapters/kaspa-x402/address-codec.js",
);
const verifierModulePath = join(
  target,
  "dist/adapters/kaspa-x402/chain-verifier.js",
);

for (const path of [addressModulePath, verifierModulePath]) {
  if (!existsSync(path)) {
    console.error(`missing built target module: ${path}`);
    console.error("run npm ci and npm run build in the target checkout first");
    process.exit(2);
  }
}

const { KaspaTestnet10AddressCodec } = await import(
  pathToFileURL(addressModulePath).href
);
const { RpcChainObservationSource } = await import(
  pathToFileURL(verifierModulePath).href
);

const now = Date.parse("2030-01-01T00:00:00.000Z");
const expectedTransactionId = "11".repeat(32);
const merchantAddress =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const expectedScriptPublicKey =
  new KaspaTestnet10AddressCodec().scriptPublicKeyForAddress(
    merchantAddress,
    "kaspa:testnet-10",
  );

// This is deliberately not a complete Kaspa transaction. In particular, it
// lacks the fields needed to hydrate and finalize a canonical transaction ID.
const incompleteTransaction = {
  verboseData: { transactionId: expectedTransactionId },
  outputs: [
    { value: 1n, scriptPublicKey: { version: 0, script: "51" } },
    {
      value: 123n,
      scriptPublicKey: {
        version: 0,
        script: expectedScriptPublicKey.slice(4),
      },
    },
  ],
};

let returnedTransaction = incompleteTransaction;
const rpc = {
  getServerInfo: async () => ({
    isSynced: true,
    hasUtxoIndex: true,
    networkId: "testnet-10",
    virtualDaaScore: 200n,
  }),
  getUtxosByAddresses: async (addresses) => {
    assert.deepEqual(addresses, [merchantAddress]);
    return { entries: [] };
  },
  getMempoolEntry: async (request) => {
    assert.deepEqual(request, {
      transactionId: expectedTransactionId,
      includeOrphanPool: false,
      filterTransactionPool: false,
    });
    return {
      mempoolEntry: {
        isOrphan: false,
        transaction: returnedTransaction,
      },
    };
  },
};

const source = new RpcChainObservationSource({
  rpc: { client: async () => rpc },
  now: () => now,
});
const request = {
  network: "kaspa:testnet-10",
  transactionId: expectedTransactionId,
  outpoint: `${expectedTransactionId}:1`,
  outputIndex: 1,
  merchantAddress,
  expectedAmountAtomic: "123",
  expectedScriptPublicKey,
  minimumFinality: "mempool",
  deadlineAtMs: now + 1_000,
  signal: new AbortController().signal,
};

const observed = await source.observeExactOutput(request);
assert.equal(observed.status, "observed");
assert.equal(observed.finality, "mempool");

returnedTransaction = structuredClone(incompleteTransaction);
delete returnedTransaction.verboseData;

let fallbackError;
try {
  await source.observeExactOutput(request);
} catch (error) {
  fallbackError = error instanceof Error ? error.message : String(error);
}
assert.match(
  fallbackError ?? "",
  /Kaspa RPC transaction identity cannot be derived/,
);

console.log(JSON.stringify({
  verboseOnlyAccepted: true,
  status: observed.status,
  finality: observed.finality,
  sameIncompleteObjectWithoutVerbose: `rejected: ${fallbackError}`,
}, null, 2));
