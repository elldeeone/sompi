/**
 * Live x402 demo: a paid API and an agent-side client paying for it
 * with real KAS on testnet-10.
 *
 * Flow demonstrated:
 *   1. First request -> 402 with a kaspa-tab offer
 *   2. Client deposits (policy-gated, on-chain, ~1s confirmation)
 *   3. Request retried and served, charged against the tab
 *   4. Further requests served instantly with zero on-chain cost
 *
 * Usage: SOMPI_NODE_URL=<node> npm run build && node dist/demo-x402.js
 */
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PolicyEngine } from "./policy";
import { KaspaWallet, formatKas } from "./wallet";
import { X402Client } from "./x402/client";
import { TabServer } from "./x402/server";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const PORT = 8642;

const JOKES = [
  "Why did the UTXO cross the DAG? To get to the other tip.",
  "I'd tell you a storage mass joke, but it's too dusty.",
  "10 blocks per second walk into a bar. The bar reorgs.",
];

async function main() {
  // --- the seller: a paid API ---
  const sellerWallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: path.join(os.homedir(), ".sompi", NETWORK, "demo-seller"),
    nodeUrl: process.env.SOMPI_NODE_URL,
  });
  const tabs = new TabServer({
    networkId: NETWORK,
    rpc: () => sellerWallet.client(),
    minDepositSompi: 100_000_000n, // 1 KAS tab deposit
    pricePerRequestSompi: 1_000n, // 0.00001 KAS per request
    dataDir: path.join(os.homedir(), ".sompi", NETWORK, "demo-seller"),
    description: "sompi demo: jokes, 1000 sompi each",
  });

  let served = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (await tabs.gate(req, res)) return; // answered with 402
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ joke: JOKES[served++ % JOKES.length] }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`[seller] paid API listening on :${PORT} (1000 sompi/request, 1 KAS min deposit)`);

  // --- the buyer: an agent's wallet + policy + x402 client ---
  const buyerWallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: path.join(os.homedir(), ".sompi", NETWORK),
    nodeUrl: process.env.SOMPI_NODE_URL,
  });
  const policy = new PolicyEngine(path.join(os.homedir(), ".sompi", NETWORK));
  const client = new X402Client(buyerWallet, policy, path.join(os.homedir(), ".sompi", NETWORK));

  console.log(`[buyer]  wallet ${buyerWallet.address}`);
  console.log(`[buyer]  balance ${formatKas(await buyerWallet.balanceSompi())} KAS\n`);

  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    const result = await client.paidFetch(`http://127.0.0.1:${PORT}/api/joke`);
    const ms = Date.now() - t0;
    console.log(`request ${i} (${ms}ms): HTTP ${result.status} ${result.body}`);
    if (result.deposit) {
      console.log(
        `          paid on-chain deposit: ${formatKas(BigInt(result.deposit.amountSompi))} KAS, txid ${result.deposit.txid}`
      );
    }
    if (result.remainingSompi) {
      console.log(`          tab remaining: ${result.remainingSompi} sompi`);
    }
  }

  console.log(`\n[buyer]  final balance ${formatKas(await buyerWallet.balanceSompi())} KAS`);
  server.close();
  await buyerWallet.disconnect();
  await sellerWallet.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
