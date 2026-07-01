#!/usr/bin/env node
/**
 * Verify a deployed Sompi paid API demo.
 *
 * Default mode is read-only: it checks the public docs, health endpoint, and
 * HTTP 402 kaspa-escrow offer. Pass --paid to run a real paid_fetch through the
 * local MCP server; that can spend testnet KAS if a new escrow is needed.
 */
const { spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const args = process.argv.slice(2);
let baseUrl;
let paid = false;
let jsonOutput = false;
let allowPrivate = false;
let allowHttp = false;
let timeoutMs = 10_000;

function usage(exitCode = 2) {
  const msg = [
    "usage: node scripts/public-demo-check.js <https://host> [options]",
    "",
    "options:",
    "  --paid             run a real paid_fetch against /api/joke",
    "  --json             print machine-readable JSON",
    "  --allow-private    allow localhost/private/LAN hosts for local smoke checks",
    "  --allow-http       allow plain HTTP for local smoke checks",
    "  --timeout <sec>    per-request timeout, default 10",
  ].join("\n");
  console.error(msg);
  process.exit(exitCode);
}

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") usage(0);
  if (arg === "--paid") {
    paid = true;
    continue;
  }
  if (arg === "--json") {
    jsonOutput = true;
    continue;
  }
  if (arg === "--allow-private") {
    allowPrivate = true;
    continue;
  }
  if (arg === "--allow-http") {
    allowHttp = true;
    continue;
  }
  if (arg === "--timeout") {
    const value = Number(args[i + 1]);
    if (!Number.isFinite(value) || value <= 0) usage();
    timeoutMs = value * 1000;
    i += 1;
    continue;
  }
  if (arg.startsWith("--")) usage();
  if (baseUrl) usage();
  baseUrl = arg;
}

if (!baseUrl) usage();

let url;
try {
  url = new URL(baseUrl);
} catch {
  fail(`Invalid URL: ${baseUrl}`);
}

url.pathname = url.pathname.replace(/\/+$/, "");
url.search = "";
url.hash = "";
const normalizedBase = url.toString().replace(/\/$/, "");

if (!["http:", "https:"].includes(url.protocol)) {
  fail("Demo URL must use http or https.");
}
if (url.protocol !== "https:" && !allowHttp) {
  fail("Public demo URLs should use HTTPS. Pass --allow-http only for local or LAN smoke checks.");
}
if (isPrivateHost(url.hostname) && !allowPrivate) {
  fail("Demo URL points at localhost or a private network. Pass --allow-private only for local or LAN smoke checks.");
}

main().catch((error) => fail(error.message ?? String(error)));

async function main() {
  const checks = [];

  checks.push(await checkLanding());
  checks.push(await checkLlms());
  checks.push(await checkHealth());
  checks.push(await checkOffer());

  let paidFetch;
  if (paid) {
    paidFetch = checkPaidFetch();
    checks.push(paidFetch);
  }

  const result = {
    summary: paid
      ? "Public paid demo is reachable and a vault-backed paid_fetch completed."
      : "Public paid demo is reachable and advertises a valid kaspa-escrow offer.",
    url: normalizedBase,
    paidFetchRan: paid,
    checks,
    paidFetch,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.summary);
    console.log(`URL: ${normalizedBase}`);
    for (const check of checks) console.log(`- ${check.name}: ${check.summary}`);
  }
}

async function checkLanding() {
  const response = await getText("/");
  if (response.status !== 200) throw new Error(`landing page returned HTTP ${response.status}`);
  requireIncludes(response.text, ["sompi demo API", "/api/joke", "/llms.txt", "KAS"], "landing page");
  return { name: "landing", status: response.status, summary: "landing page is live and KAS-first" };
}

async function checkLlms() {
  const response = await getText("/llms.txt");
  if (response.status !== 200) throw new Error(`/llms.txt returned HTTP ${response.status}`);
  requireIncludes(response.text, ["kaspa-escrow", "paid_fetch", "minDepositSompi", "pricePerRequestSompi"], "/llms.txt");
  return { name: "llms", status: response.status, summary: "agent-readable instructions are available" };
}

async function checkHealth() {
  const response = await getJson("/healthz");
  if (response.status !== 200) throw new Error(`/healthz returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  if (response.body?.ok !== true) throw new Error(`/healthz is not ready: ${JSON.stringify(response.body)}`);
  if (response.body?.network !== "testnet-10") throw new Error(`/healthz network is ${response.body?.network}, expected testnet-10`);
  return {
    name: "health",
    status: response.status,
    summary: `service is healthy on ${response.body.network}`,
    daa: response.body.daa,
  };
}

async function checkOffer() {
  const response = await getJson("/api/joke");
  if (response.status !== 402) throw new Error(`/api/joke without payment returned HTTP ${response.status}, expected 402`);
  const offer = response.body?.accepts?.[0];
  if (!offer || offer.scheme !== "kaspa-escrow") throw new Error("402 offer did not include accepts[0].scheme=kaspa-escrow");
  if (offer.network !== "testnet-10") throw new Error(`402 offer network is ${offer.network}, expected testnet-10`);
  for (const field of ["serverPublic", "refundTimeout", "minDepositSompi", "pricePerRequestSompi"]) {
    if (typeof offer[field] !== "string" || offer[field].length === 0) {
      throw new Error(`402 offer missing ${field}`);
    }
  }
  return {
    name: "offer",
    status: response.status,
    summary: `unpaid /api/joke returns kaspa-escrow offer at ${kasFromSompi(offer.pricePerRequestSompi)} tKAS/request`,
    pricePerRequestSompi: offer.pricePerRequestSompi,
    minDepositSompi: offer.minDepositSompi,
  };
}

function checkPaidFetch() {
  const jokeUrl = `${normalizedBase}/api/joke`;
  const driver = path.join(__dirname, "mcp-call.js");
  const child = spawnSync(
    process.execPath,
    [driver, "paid_fetch", JSON.stringify({ url: jokeUrl }), String(Math.ceil(timeoutMs / 1000) + 120)],
    { cwd: path.join(__dirname, ".."), encoding: "utf8", env: process.env }
  );
  if (child.status !== 0) {
    throw new Error(`paid_fetch failed:\n${[child.stderr, child.stdout].filter(Boolean).join("\n").trim()}`);
  }
  let receipt;
  try {
    receipt = JSON.parse(child.stdout.trim());
  } catch {
    throw new Error(`paid_fetch returned non-JSON output:\n${child.stdout}`);
  }
  if (receipt.status !== 200) throw new Error(`paid_fetch returned HTTP ${receipt.status}`);
  if (receipt.scheme !== "kaspa-escrow") throw new Error(`paid_fetch scheme is ${receipt.scheme}, expected kaspa-escrow`);
  if (receipt.fundingSource !== "vault") throw new Error(`paid_fetch fundingSource is ${receipt.fundingSource}, expected vault`);
  if (receipt.deposit && receipt.deposit.source !== "vault") {
    throw new Error(`paid_fetch deposit.source is ${receipt.deposit.source}, expected vault`);
  }
  if (!receipt.authorizedKas || !receipt.authorizedDisplay) {
    throw new Error("paid_fetch receipt did not include KAS-first authorized amount fields");
  }
  return {
    name: "paid_fetch",
    status: receipt.status,
    summary: receipt.summary,
    fundingSource: receipt.fundingSource,
    depositSource: receipt.deposit?.source ?? null,
    depositTxid: receipt.deposit?.txid ?? null,
    authorizedDisplay: receipt.authorizedDisplay,
    body: receipt.body,
  };
}

async function getText(pathname) {
  const response = await fetch(`${normalizedBase}${pathname}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  return { status: response.status, text: await response.text() };
}

async function getJson(pathname) {
  const response = await fetch(`${normalizedBase}${pathname}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${pathname} returned non-JSON body: ${text.slice(0, 200)}`);
  }
}

function requireIncludes(text, needles, label) {
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`${label} did not include ${needle}`);
  }
}

function kasFromSompi(sompi) {
  return (Number(BigInt(sompi)) / 100_000_000).toString();
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  }
  if (ipVersion !== 4) return false;
  const parts = host.split(".").map((part) => Number(part));
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  );
}

function fail(message) {
  if (jsonOutput) {
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`public demo check failed: ${message}`);
  }
  process.exit(1);
}
