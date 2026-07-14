#!/usr/bin/env node
"use strict";

/**
 * Operator-side owner recovery. The private key is accepted only from a
 * mode-0600 file so it does not enter shell history or process arguments.
 *
 * Usage:
 *   SOMPI_NODE_URL=wss://testnet-node/ws node scripts/vault-recover.js \
 *     --owner-key-file /secure/owner.key \
 *     --vault-config /secure/vault-config.json \
 *     --destination kaspatest:...
 */

globalThis.WebSocket = require("websocket").w3cwebsocket;

const fs = require("node:fs");
const { PrivateKey, RpcClient } = require("../vendor/kaspa-wasm/kaspa");

const NETWORK = "testnet-10";
const REQUIRED = Object.freeze(["owner-key-file", "vault-config", "destination"]);
const OPTIONAL = Object.freeze(["fee-sompi"]);
const HEX32 = /^[a-f0-9]{64}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;
const ADDRESS = /^kaspatest:[a-z0-9]{11,240}$/;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if ((process.env.SOMPI_NETWORK ?? NETWORK) !== NETWORK) {
    fail("owner recovery in this release supports only testnet-10");
  }
  const nodeUrl = requireNodeUrl(process.env.SOMPI_NODE_URL);
  const ownerPrivate = readPrivateKey(options["owner-key-file"]);
  const config = readVaultConfig(options["vault-config"]);
  if (!ADDRESS.test(options.destination)) fail("destination is not a testnet-10 Kaspa address");

  const [{ recoverVaultWithOwner }, { VAULT_TEMPLATE_VERSION }] = await Promise.all([
    import("../dist/vault.js"),
    import("../dist/vault/template.js"),
  ]);
  if (config.template !== VAULT_TEMPLATE_VERSION) {
    fail("vault configuration uses an unsupported template");
  }
  const ownerKey = new PrivateKey(ownerPrivate);
  const ownerKeypair = ownerKey.toKeypair();
  let ownerPublic;
  try {
    ownerPublic = String(ownerKeypair.xOnlyPublicKey);
  } finally {
    ownerKeypair.free();
    ownerKey.free();
  }
  if (ownerPublic !== config.ownerPublic) {
    fail("owner key does not match the vault configuration");
  }

  const rpc = new RpcClient({ url: nodeUrl, networkId: NETWORK });
  await rpc.connect({ timeoutDuration: 10_000, retries: 1 });
  try {
    const result = await recoverVaultWithOwner({
      wallet: {
        networkId: NETWORK,
        client: async () => rpc,
      },
      config,
      privateKey: ownerPrivate,
      destination: options.destination,
      ...(options["fee-sompi"] === undefined
        ? {}
        : { feeSompi: BigInt(options["fee-sompi"]) }),
    });
    process.stdout.write(`${JSON.stringify({
      status: "submitted",
      network: NETWORK,
      transactionId: result.txid,
      destination: options.destination,
      recoveredAtomic: result.amountSompi.toString(),
      feeAtomic: result.feeSompi.toString(),
    }, null, 2)}\n`);
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

function parseArguments(arguments_) {
  if (arguments_.includes("--help")) usage(0);
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) usage(2);
  const allowed = new Set([...REQUIRED, ...OPTIONAL]);
  const options = Object.create(null);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag.startsWith("--") || !value || value.startsWith("--")) usage(2);
    const key = flag.slice(2);
    if (!allowed.has(key) || options[key] !== undefined) usage(2);
    options[key] = value;
  }
  if (REQUIRED.some((key) => options[key] === undefined)) usage(2);
  if (options["fee-sompi"] !== undefined && !/^[1-9][0-9]*$/.test(options["fee-sompi"])) {
    fail("fee-sompi must be a positive canonical integer");
  }
  return options;
}

function usage(code) {
  process.stderr.write(
    "usage: vault-recover.js --owner-key-file PATH --vault-config PATH " +
      "--destination KASPATEST_ADDRESS [--fee-sompi INTEGER]\n"
  );
  process.exit(code);
}

function requireNodeUrl(value) {
  if (!value) fail("SOMPI_NODE_URL is required for owner recovery");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("SOMPI_NODE_URL is invalid");
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    fail("SOMPI_NODE_URL must be an uncredentialed ws/wss URL");
  }
  return parsed.href;
}

function readPrivateKey(filename) {
  const stat = secureRegularFile(filename, "owner key", 512);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.uid !== currentUid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
    fail("owner key file must be owned by this user, unlinked elsewhere, and inaccessible to group/other");
  }
  const bytes = fs.readFileSync(filename);
  try {
    const value = bytes.toString("utf8").trim();
    if (!HEX32.test(value)) fail("owner key file does not contain one canonical private key");
    return value;
  } finally {
    bytes.fill(0);
  }
}

function readVaultConfig(filename) {
  secureRegularFile(filename, "vault configuration", 64 * 1024);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    fail("vault configuration is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("vault configuration is invalid");
  }
  for (const field of [
    "template",
    "agentPublic",
    "ownerPublic",
    "maxOutflowSompi",
    "windowSizeDaa",
    "windowStartDaa",
    "spentInWindowSompi",
    "address",
    "covenantId",
  ]) {
    if (typeof value[field] !== "string") fail(`vault configuration field ${field} is invalid`);
  }
  if (
    !HEX32.test(value.agentPublic) ||
    !HEX32.test(value.ownerPublic) ||
    !HEX32.test(value.covenantId) ||
    !ATOMIC.test(value.maxOutflowSompi) ||
    value.maxOutflowSompi === "0" ||
    !ATOMIC.test(value.windowSizeDaa) ||
    value.windowSizeDaa === "0" ||
    !ATOMIC.test(value.windowStartDaa) ||
    !ATOMIC.test(value.spentInWindowSompi) ||
    !ADDRESS.test(value.address) ||
    !value.currentOutpoint ||
    typeof value.currentOutpoint !== "object" ||
    !HEX32.test(value.currentOutpoint.txid) ||
    !Number.isSafeInteger(value.currentOutpoint.index) ||
    value.currentOutpoint.index < 0 ||
    value.currentOutpoint.index > 0xffff_ffff
  ) {
    fail("vault configuration facts are invalid or incomplete");
  }
  return Object.freeze({
    template: value.template,
    agentPublic: value.agentPublic,
    ownerPublic: value.ownerPublic,
    maxOutflowSompi: value.maxOutflowSompi,
    windowSizeDaa: value.windowSizeDaa,
    windowStartDaa: value.windowStartDaa,
    spentInWindowSompi: value.spentInWindowSompi,
    address: value.address,
    covenantId: value.covenantId,
    currentOutpoint: Object.freeze({
      txid: value.currentOutpoint.txid,
      index: value.currentOutpoint.index,
    }),
  });
}

function secureRegularFile(filename, label, maximumBytes) {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    fail(`${label} file is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    fail(`${label} file is not a bounded regular file`);
  }
  return stat;
}

function fail(message) {
  process.stderr.write(`vault recovery failed safely: ${message}\n`);
  process.exit(1);
}

main().catch(() => fail("inspect the trusted node, vault state, and operator files before retrying"));
