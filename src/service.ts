/**
 * The sompi demo service: a public paid API on Kaspa testnet-10.
 *
 * Demonstrates the trust-minimized kaspa-escrow scheme for x402-style HTTP
 * payments end to end: unpaid requests get HTTP 402 with a kaspa-escrow offer;
 * the client funds a covenant escrow once, then pays each request with a
 * cumulative off-chain voucher. The server claims earned funds with the latest
 * voucher; the client can refund the unspent balance after a timeout.
 *
 * Free:  GET /            human landing page
 *        GET /llms.txt    agent-readable instructions
 *        GET /healthz     liveness + node status
 * Paid:  GET /api/network live network stats incl. canonical-chain verdict
 *        GET /api/verify?txid=..&address=..  payment verification
 *        GET /api/joke    the classics
 *
 * Usage: SOMPI_NODE_URL=<node> node dist/service.js
 * Env:   PORT (default 8642), SOMPI_NETWORK (default testnet-10),
 *        SOMPI_DATA_DIR, X402_MIN_DEPOSIT_SOMPI, X402_PRICE_SOMPI
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { KaspaWallet } from "./wallet";
import { generateChannelKey } from "./x402/escrow";
import { EscrowTabServer } from "./x402/escrow-server";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const PORT = Number(process.env.PORT ?? 8642);
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK, "service");
const MIN_DEPOSIT = BigInt(process.env.X402_MIN_DEPOSIT_SOMPI ?? "90000000"); // 0.9 KAS
const PRICE = BigInt(process.env.X402_PRICE_SOMPI ?? "1000000"); // 0.01 KAS

const wallet = new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: process.env.SOMPI_NODE_URL });

// Stable server channel key + refund timeout, persisted so escrows funded
// before a restart stay claimable and the escrow addresses don't change.
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const cfgPath = path.join(DATA_DIR, "escrow-server-config.json");

/** EscrowTabServer, constructed in main() once the refund timeout is known. */
let tabs: EscrowTabServer;

async function loadServerConfig(): Promise<{ privateKey: string; publicKey: string; refundTimeout: bigint }> {
  if (fs.existsSync(cfgPath)) {
    const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return { privateKey: c.privateKey, publicKey: c.publicKey, refundTimeout: BigInt(c.refundTimeout) };
  }
  const key = generateChannelKey();
  const info = await (await wallet.client()).getServerInfo();
  // Refund window ~1M DAA (~28 hours at 10 bps) ahead of the current tip.
  const refundTimeout = BigInt(info.virtualDaaScore) + 1_000_000n;
  fs.writeFileSync(cfgPath, JSON.stringify({ ...key, refundTimeout: refundTimeout.toString() }), { mode: 0o600 });
  return { ...key, refundTimeout };
}

const JOKES = [
  "Why did the UTXO cross the DAG? To get to the other tip.",
  "I'd tell you a storage mass joke, but it's too dusty.",
  "10 blocks per second walk into a bar. The bar reorgs.",
  "An agent walks into a bar and opens a tab. The bartender is consensus.",
  "What do you call a covenant that lets you spend anything? A bug.",
];
let served = 0;

const LANDING = `<!doctype html>
<html><head><meta charset="utf-8"><title>sompi demo API — pay with KAS over HTTP 402</title>
<style>body{font-family:ui-monospace,monospace;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5;background:#0b0d10;color:#d8dee9}
a{color:#70c7ba}code,pre{background:#16191d;padding:.15rem .4rem;border-radius:4px}pre{padding:.8rem;overflow-x:auto}</style></head>
<body>
<h1>sompi demo API</h1>
<p>A paid API on <b>Kaspa testnet-10</b>. Machines pay for it autonomously using
HTTP 402 and KAS — fund a trust-minimized covenant escrow once (~1 second), then
each request is paid by an instant off-chain voucher.</p>
<p><b>Paid endpoints</b> (${PRICE} sompi each, ${Number(MIN_DEPOSIT) / 1e8} tKAS escrow deposit):</p>
<ul>
<li><code>GET /api/network</code> — live network stats + canonical-chain verdict</li>
<li><code>GET /api/verify?txid=&lt;txid&gt;&amp;address=&lt;addr&gt;</code> — did a payment land?</li>
<li><code>GET /api/joke</code> — premium humor</li>
</ul>
<p><b>How to pay (trust-minimized escrow):</b> request any endpoint → you get a
<code>402</code> with a <code>kaspa-escrow</code> offer → fund a covenant escrow
once → pay each request with a cumulative voucher. The server can only claim what
you signed for; you reclaim the rest after a timeout. Or skip the plumbing:</p>
<pre>claude mcp add sompi -- npx -y @elldeeone/sompi
# then ask your agent to fetch this URL — paid_fetch handles the 402 itself</pre>
<p>Agents: see <a href="/llms.txt">/llms.txt</a>. Humans: source &amp; docs at
<a href="https://github.com/elldeeone/sompi">github.com/elldeeone/sompi</a>.
Testnet KAS only — get some from the faucet, this is a demo.</p>
</body></html>`;

const LLMS_TXT = `# sompi demo API (Kaspa testnet-10)

This is a paid API. Payment protocol: x402, trust-minimized kaspa-escrow scheme.

How it works:
1. GET any /api/* endpoint. You will receive HTTP 402 with a JSON body:
   { "x402Version": 1, "accepts": [{ "scheme": "kaspa-escrow", "network": "testnet-10",
     "serverPublic": "<32-byte hex>", "refundTimeout": "<DAA score>",
     "minDepositSompi": "${MIN_DEPOSIT}", "pricePerRequestSompi": "${PRICE}" }] }
2. Generate a client keypair. Derive the escrow address from (clientPublic,
   serverPublic, refundTimeout) — the SompiEscrow covenant. Deposit at least
   minDepositSompi to it on testnet-10.
3. Wait until the escrow funding UTXO is indexed and record its full outpoint:
   outpointTxid and outpointIndex.
4. For each request, sign a cumulative voucher, where totalAuthorized grows by
   pricePerRequestSompi each request. The BIP340 schnorr signature signs:
   sha256(
     sha256("sompi:escrow-voucher:v2") ||
     sha256(network) ||
     sha256(uint16le(scriptPublicKey.version) || scriptPublicKey.script bytes) ||
     outpointTxid32 ||
     outpointIndex_le32 ||
     totalAuthorizedSompi_le64
   )
   Send:
   X-Payment: base64({"scheme":"kaspa-escrow","clientPublic":"<hex>",
     "voucherAmountSompi":"<total>","voucherHex":"<64-byte sig hex>",
     "outpointTxid":"<funding txid>","outpointIndex":<funding vout>})
5. The server serves while the voucher authorizes >= the running total it is
   owed for that exact outpoint, and claims earned funds with your latest
   voucher. You can refund the unspent balance after refundTimeout.

Easiest client: the @elldeeone/sompi MCP server (npm). Its paid_fetch tool does
this whole flow automatically within a local spending policy.

Endpoints:
- GET /api/network  -> {networkId, virtualDaaScore, serverVersion, feerate, canonicalChain}
- GET /api/verify?txid=<txid>&address=<addr> -> {found, amountSompi}
- GET /api/joke     -> {joke}
- GET /healthz      -> free liveness check
`;

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "x-payment");

  // free endpoints
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(LANDING);
    return;
  }
  if (url.pathname === "/llms.txt") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(LLMS_TXT);
    return;
  }
  if (url.pathname === "/healthz") {
    try {
      const info = await wallet.serverInfo();
      json(res, 200, { ok: true, network: NETWORK, synced: info.isSynced, daa: String(info.virtualDaaScore) });
    } catch (e) {
      json(res, 503, { ok: false, error: String(e).slice(0, 200) });
    }
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    json(res, 404, { error: "not found; see / for endpoints" });
    return;
  }

  // paid endpoints behind the tab gate
  if (await tabs.gate(req, res)) return; // answered with 402

  switch (url.pathname) {
    case "/api/joke":
      json(res, 200, { joke: JOKES[served++ % JOKES.length] });
      return;
    case "/api/network": {
      const rpc = await wallet.client();
      const info = await rpc.getServerInfo();
      const fees = await rpc.getFeeEstimate();
      json(res, 200, {
        networkId: NETWORK,
        virtualDaaScore: String(info.virtualDaaScore),
        serverVersion: info.serverVersion,
        isSynced: info.isSynced,
        normalFeerate: fees.estimate?.normalBuckets?.[0]?.feerate ?? null,
        canonicalChain: true, // this service's own connection passed the sompi chain guard
      });
      return;
    }
    case "/api/verify": {
      const txid = url.searchParams.get("txid");
      const address = url.searchParams.get("address");
      if (!txid || !address) {
        json(res, 400, { error: "txid and address query params required" });
        return;
      }
      const result = await wallet.verifyPayment(txid, address);
      json(res, 200, { found: result.found, amountSompi: result.amountSompi.toString() });
      return;
    }
    default:
      json(res, 404, { error: "unknown endpoint; see /" });
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("handler error:", e);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

async function main(): Promise<void> {
  const cfg = await loadServerConfig();
  tabs = new EscrowTabServer({
    networkId: NETWORK,
    rpc: () => wallet.client(),
    wallet: () => wallet,
    serverPrivateHex: cfg.privateKey,
    serverPublicHex: cfg.publicKey,
    refundTimeout: cfg.refundTimeout,
    minDepositSompi: MIN_DEPOSIT,
    pricePerRequestSompi: PRICE,
    dataDir: DATA_DIR,
    description: `sompi escrow demo API: ${PRICE} sompi per request, ${MIN_DEPOSIT} sompi escrow deposit`,
  });
  server.listen(PORT, () => {
    console.log(`sompi escrow demo on :${PORT} (${NETWORK}); ${PRICE} sompi/request, ${MIN_DEPOSIT} sompi escrow, refund@DAA ${cfg.refundTimeout}`);
    console.log(`claim earnings: in a node REPL, new EscrowTabServer(...).claimAll(<address>)`);
  });
}

main().catch((e) => {
  console.error("service failed to start:", e);
  process.exit(1);
});
