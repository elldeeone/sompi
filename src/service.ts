/**
 * The sompi demo service: a public paid API on Kaspa testnet-10.
 *
 * Demonstrates x402 (kaspa-tab scheme) end to end: unpaid requests get
 * HTTP 402 with a payment offer; a single on-chain KAS deposit opens a tab;
 * subsequent requests are charged off the tab at no on-chain cost.
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
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { KaspaWallet } from "./wallet";
import { TabServer } from "./x402/server";

const NETWORK = process.env.SOMPI_NETWORK ?? "testnet-10";
const PORT = Number(process.env.PORT ?? 8642);
const DATA_DIR = process.env.SOMPI_DATA_DIR ?? path.join(os.homedir(), ".sompi", NETWORK, "service");
const MIN_DEPOSIT = BigInt(process.env.X402_MIN_DEPOSIT_SOMPI ?? "100000000"); // 1 KAS
const PRICE = BigInt(process.env.X402_PRICE_SOMPI ?? "1000");

const wallet = new KaspaWallet({ networkId: NETWORK, dataDir: DATA_DIR, nodeUrl: process.env.SOMPI_NODE_URL });
const tabs = new TabServer({
  networkId: NETWORK,
  rpc: () => wallet.client(),
  minDepositSompi: MIN_DEPOSIT,
  pricePerRequestSompi: PRICE,
  dataDir: DATA_DIR,
  description: `sompi demo API: ${PRICE} sompi per request, ${MIN_DEPOSIT} sompi minimum tab deposit`,
});

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
HTTP 402 and KAS — a deposit opens a tab in ~1 second, then requests are instant.</p>
<p><b>Paid endpoints</b> (${PRICE} sompi each, ${Number(MIN_DEPOSIT) / 1e8} tKAS min deposit):</p>
<ul>
<li><code>GET /api/network</code> — live network stats + canonical-chain verdict</li>
<li><code>GET /api/verify?txid=&lt;txid&gt;&amp;address=&lt;addr&gt;</code> — did a payment land?</li>
<li><code>GET /api/joke</code> — premium humor</li>
</ul>
<p><b>How to pay:</b> request any endpoint → you get a <code>402</code> with a JSON offer
(deposit address, tab id) → send the deposit on testnet-10 → retry with the
<code>X-Payment</code> header. Or skip the plumbing entirely:</p>
<pre>claude mcp add sompi -- npx -y @elldeeone/sompi
# then ask your agent to fetch this URL — paid_fetch handles the 402 itself</pre>
<p>Agents: see <a href="/llms.txt">/llms.txt</a>. Humans: source &amp; docs at
<a href="https://github.com/elldeeone/sompi">github.com/elldeeone/sompi</a>.
Testnet KAS only — get some from the faucet, this is a demo.</p>
</body></html>`;

const LLMS_TXT = `# sompi demo API (Kaspa testnet-10)

This is a paid API. Payment protocol: x402 / kaspa-tab scheme.

How it works:
1. GET any /api/* endpoint. You will receive HTTP 402 with a JSON body:
   { "x402Version": 1, "accepts": [{ "scheme": "kaspa-tab", "network": "testnet-10",
     "payTo": "<deposit address>", "minDepositSompi": "${MIN_DEPOSIT}",
     "pricePerRequestSompi": "${PRICE}", "tabId": "<id>" }] }
2. Send at least minDepositSompi to payTo on Kaspa testnet-10 (confirms in ~1s).
3. Retry the request with header:
   X-Payment: base64({"scheme":"kaspa-tab","tabId":"<id>"})
4. Each request deducts ${PRICE} sompi from your tab. The
   x-payment-remaining-sompi response header shows remaining credit.

Easiest client: the @elldeeone/sompi MCP server (npm). Its paid_fetch tool
performs this whole flow automatically within a local spending policy.

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

server.listen(PORT, () => {
  console.log(`sompi demo service on :${PORT} (${NETWORK}); ${PRICE} sompi/request, min deposit ${MIN_DEPOSIT} sompi`);
  console.log(`tab deposits land in ${DATA_DIR}; sweep with scripts/sweep-tabs.js`);
});
