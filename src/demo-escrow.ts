/**
 * Live demo of the trust-minimized x402 escrow channel over HTTP, testnet-10.
 *
 * A paid API gates requests with EscrowTabServer; a buyer's X402Client funds an
 * escrow, then pays per request with cumulative vouchers (no on-chain cost per
 * request). Finally the seller claims its earned funds with the latest voucher.
 *
 * Usage: SOMPI_NODE_URL=<node> node dist/demo-escrow.js
 */
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PolicyEngine } from "./policy";
import { KaspaWallet, formatKas } from "./wallet";
import { X402Client } from "./x402/client";
import { generateChannelKey } from "./x402/escrow";
import { EscrowTabServer } from "./x402/escrow-server";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const NODE = process.env.SOMPI_NODE_URL;
const PORT = 8650;

async function main() {
  const sellerWallet = new KaspaWallet({
    networkId: NETWORK,
    dataDir: path.join(os.homedir(), ".sompi", NETWORK, "demo-escrow-seller"),
    nodeUrl: NODE,
  });
  // Refund timeout: comfortably ahead of the current DAA so the demo's claims
  // happen well before clients could refund.
  const info = await (await sellerWallet.client()).getServerInfo();
  const refundTimeout = BigInt(info.virtualDaaScore) + 1_000_000n;
  const serverKey = generateChannelKey();

  const escrow = new EscrowTabServer({
    networkId: NETWORK,
    rpc: () => sellerWallet.client(),
    wallet: () => sellerWallet,
    serverPrivateHex: serverKey.privateKey,
    serverPublicHex: serverKey.publicKey,
    refundTimeout,
    minDepositSompi: 90_000_000n, // 0.9 KAS escrow (within the buyer's 1 KAS/tx policy)
    pricePerRequestSompi: 20_000_000n, // 0.2 KAS per request
    dataDir: path.join(os.homedir(), ".sompi", NETWORK, "demo-escrow-seller"),
    description: "sompi escrow demo: trust-minimized API",
  });

  let served = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (await escrow.gate(req, res)) return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: `served request #${++served}`, daa: String(info.virtualDaaScore) }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`[seller] escrow-gated API on :${PORT} (0.2 KAS/request, 0.9 KAS escrow, refund@DAA ${refundTimeout})`);

  const buyerWallet = new KaspaWallet({ networkId: NETWORK, dataDir: path.join(os.homedir(), ".sompi", NETWORK), nodeUrl: NODE });
  const policy = new PolicyEngine(path.join(os.homedir(), ".sompi", NETWORK));
  const client = new X402Client(buyerWallet, policy, path.join(os.homedir(), ".sompi", NETWORK, "demo-escrow-buyer"));
  console.log(`[buyer]  ${buyerWallet.address} — ${formatKas(await buyerWallet.balanceSompi())} KAS\n`);

  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    const r = await client.paidFetch(`http://127.0.0.1:${PORT}/api/data`);
    console.log(`request ${i} (${Date.now() - t0}ms): HTTP ${r.status} ${r.body}  [authorized ${r.authorizedSompi} sompi]`);
  }

  // Seller claims earned funds with the latest voucher (3 requests x 0.5 KAS = 1.5 KAS authorized).
  console.log("\n[seller] claiming earned funds with the latest voucher...");
  const claims = await escrow.claimAll(sellerWallet.address);
  for (const c of claims) {
    console.log(`         claimed ${formatKas(BigInt(c.amountSompi))} KAS from client ${c.clientPublic.slice(0, 12)}… txid ${c.txid}`);
  }

  server.close();
  await buyerWallet.disconnect();
  await sellerWallet.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("demo-escrow failed:", e);
  process.exit(1);
});
