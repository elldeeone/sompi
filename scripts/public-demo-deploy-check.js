#!/usr/bin/env node
/**
 * Check whether a host is ready to run the stable public Sompi demo service.
 *
 * This is meant for the deployment host. It verifies the local service URL,
 * systemd unit installation, Cloudflare Tunnel token config, and optionally the
 * public URL. It does not spend unless --paid is passed.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
let publicUrl;
let localUrl = "http://127.0.0.1:8642";
let jsonOutput = false;
let paid = false;
let skipSystemd = false;
let skipLocal = false;
let allowTemporaryTunnel = false;
let timeoutSeconds = 10;

function usage(exitCode = 2) {
  const msg = [
    "usage: node scripts/public-demo-deploy-check.js [options]",
    "",
    "options:",
    "  --url <https://host>        public demo URL to verify",
    "  --local-url <url>           local service URL, default http://127.0.0.1:8642",
    "  --paid                      run paid public proof through paid_fetch",
    "  --json                      print JSON only",
    "  --skip-systemd              skip installed systemd/tunnel checks",
    "  --skip-local                skip local service check",
    "  --allow-temporary-tunnel    allow ephemeral tunnel URL for proof-only checks",
    "  --timeout <sec>             per-request timeout, default 10",
  ].join("\n");
  console.error(msg);
  process.exit(exitCode);
}

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") usage(0);
  if (arg === "--json") {
    jsonOutput = true;
    continue;
  }
  if (arg === "--paid") {
    paid = true;
    continue;
  }
  if (arg === "--skip-systemd") {
    skipSystemd = true;
    continue;
  }
  if (arg === "--skip-local") {
    skipLocal = true;
    continue;
  }
  if (arg === "--allow-temporary-tunnel") {
    allowTemporaryTunnel = true;
    continue;
  }
  if (arg === "--url") {
    publicUrl = args[i + 1];
    if (!publicUrl) usage();
    i += 1;
    continue;
  }
  if (arg === "--local-url") {
    localUrl = args[i + 1];
    if (!localUrl) usage();
    i += 1;
    continue;
  }
  if (arg === "--timeout") {
    const value = Number(args[i + 1]);
    if (!Number.isFinite(value) || value <= 0) usage();
    timeoutSeconds = value;
    i += 1;
    continue;
  }
  usage();
}

const checks = [];

if (!skipLocal) checks.push(runDemoCheck("local_service", localUrl, ["--allow-private", "--allow-http"]));
if (!skipSystemd) checks.push(...systemdChecks());
if (publicUrl) {
  const flags = [];
  if (paid) flags.push("--paid");
  if (allowTemporaryTunnel) flags.push("--allow-temporary-tunnel");
  checks.push(runDemoCheck("public_url", publicUrl, flags));
}

const blockers = checks.filter((check) => check.status === "blocked");
const warnings = checks.filter((check) => check.status === "warning");
const result = {
  summary:
    blockers.length === 0
      ? "Public demo deployment checks passed."
      : `Public demo deployment has ${blockers.length} blocker(s).`,
  status: blockers.length === 0 ? "ready" : "blocked",
  blockers: blockers.map((check) => check.summary),
  warnings: warnings.map((check) => check.summary),
  checks,
};

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.summary);
  for (const check of checks) {
    console.log(`- ${check.name}: ${check.status} - ${check.summary}`);
  }
}

process.exit(blockers.length === 0 ? 0 : 1);

function runDemoCheck(name, url, extraFlags) {
  const script = path.join(__dirname, "public-demo-check.js");
  const child = spawnSync(
    process.execPath,
    [script, url, "--json", "--timeout", String(timeoutSeconds), ...extraFlags],
    { cwd: path.join(__dirname, ".."), encoding: "utf8", env: process.env }
  );
  const output = [child.stdout, child.stderr].filter(Boolean).join("\n").trim();
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  if (child.status !== 0) {
    return {
      name,
      status: "blocked",
      summary: parsed?.error ?? output.slice(0, 400) ?? "demo check failed",
      url,
    };
  }
  return {
    name,
    status: "ok",
    summary: parsed?.summary ?? "demo check passed",
    url,
    stability: parsed?.stability,
    paidFetchRan: parsed?.paidFetchRan,
  };
}

function systemdChecks() {
  const results = [];
  results.push(fileCheck("sompi_service_unit", "/etc/systemd/system/sompi-service.service"));
  results.push(fileCheck("cloudflared_service_unit", "/etc/systemd/system/sompi-cloudflared.service"));
  results.push(fileCheck("cloudflared_env", "/etc/sompi/cloudflared.env", validateTunnelEnv));
  results.push(binaryCheck("cloudflared_binary", ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared"]));

  if (commandExists("systemctl")) {
    results.push(unitCheck("sompi_service_active", "sompi-service"));
    results.push(unitCheck("cloudflared_service_active", "sompi-cloudflared"));
  } else {
    results.push({
      name: "systemctl",
      status: "warning",
      summary: "systemctl is not available, so service runtime status was not checked.",
    });
  }
  return results;
}

function fileCheck(name, filePath, validate) {
  if (!fs.existsSync(filePath)) {
    return { name, status: "blocked", summary: `${filePath} is missing.` };
  }
  if (validate) return validate(name, filePath);
  return { name, status: "ok", summary: `${filePath} exists.` };
}

function validateTunnelEnv(name, filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith("CLOUDFLARED_TOKEN="));
  const token = line?.slice("CLOUDFLARED_TOKEN=".length).trim();
  if (!token || token === "REPLACE_ME") {
    return { name, status: "blocked", summary: `${filePath} does not contain a real CLOUDFLARED_TOKEN.` };
  }
  return { name, status: "ok", summary: `${filePath} contains a tunnel token.` };
}

function binaryCheck(name, candidates) {
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return { name, status: "ok", summary: `${found} exists.` };
  return { name, status: "blocked", summary: `cloudflared was not found at ${candidates.join(" or ")}.` };
}

function unitCheck(name, unit) {
  const active = spawnSync("systemctl", ["is-active", "--quiet", unit], { encoding: "utf8" });
  if (active.status === 0) return { name, status: "ok", summary: `${unit} is active.` };
  const status = spawnSync("systemctl", ["is-enabled", unit], { encoding: "utf8" });
  const detail = [status.stdout, status.stderr].filter(Boolean).join(" ").trim();
  return {
    name,
    status: "blocked",
    summary: `${unit} is not active${detail ? ` (${detail})` : ""}.`,
  };
}

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0;
}
