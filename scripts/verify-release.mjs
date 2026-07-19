#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-release-"));

try {
  assertExactDependencyPins();
  run("npm", ["test"], root, { SOMPI_SMOKE_OFFLINE: "1" });
  run("python3", [
    "-m",
    "unittest",
    "discover",
    "-s",
    "integrations/hermes/plugin/tests",
    "-p",
    "test_*.py",
    "-v",
  ], root, { PYTHONDONTWRITEBYTECODE: "1" });
  run("npm", ["run", "test:conformance"], root);
  run(process.execPath, [path.join(root, "scripts", "verify-live-evidence.mjs")], root);
  run(process.execPath, [
    path.join(root, "scripts", "run-local-e2e.mjs"),
    "--output",
    path.join(temporary, "local-proof.json"),
  ], root);
  run(process.execPath, [path.join(root, "dist", "openapi-main.js"), "check"], root);
  run(process.execPath, [path.join(root, "dist", "arazzo-main.js"), "check"], root);
  run("npm", ["audit", "--omit=dev"], root);
  run("npm", ["pack", "--pack-destination", temporary], root);

  const archives = fs.readdirSync(temporary)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(temporary, entry));
  if (archives.length !== 1) fail("npm pack did not produce exactly one archive");
  const archive = archives[0];
  run(process.execPath, [path.join(root, "scripts", "verify-packed-artifact.mjs"), archive], root);

  const consumer = path.join(temporary, "consumer");
  fs.mkdirSync(consumer, { mode: 0o700 });
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" })}\n`,
    { mode: 0o600 }
  );
  run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    archive,
  ], consumer);
  assertInstalledPackage(consumer);
  assertInstalledLicences(consumer);
  run(process.execPath, [
    path.join(consumer, "node_modules", "@elldeeone", "sompi", "dist", "smoke.js"),
  ], consumer, { SOMPI_SMOKE_OFFLINE: "1" });

  const status = runCapture("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status.trim() !== "") fail(`release verification changed the source tree:\n${status}`);

  process.stdout.write(`${JSON.stringify({
    status: "pass",
    archive: path.basename(archive),
    cleanInstall: true,
    installedLicenceAudit: true,
    productionAudit: "clean",
  })}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function assertExactDependencyPins() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const field of ["dependencies", "devDependencies"]) {
    const declared = manifest[field] ?? {};
    const locked = lock.packages?.[""]?.[field] ?? {};
    if (JSON.stringify(declared) !== JSON.stringify(locked)) {
      fail(`${field} differ between package.json and package-lock.json`);
    }
    for (const [name, version] of Object.entries(declared)) {
      if (typeof version !== "string" || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        fail(`${field} dependency ${name} is not pinned to one exact version`);
      }
    }
  }
}

function assertInstalledPackage(consumer) {
  const packageRoot = path.join(consumer, "node_modules", "@elldeeone", "sompi");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (
    manifest.name !== "@elldeeone/sompi" ||
    manifest.version !== "0.9.0" ||
    Object.prototype.hasOwnProperty.call(manifest, "main") ||
    JSON.stringify(manifest.exports) !== JSON.stringify({ "./package.json": "./package.json" })
  ) fail("clean installation exposed an unexpected package identity or export");
  for (const command of Object.keys(manifest.bin ?? {})) {
    const link = path.join(consumer, "node_modules", ".bin", command);
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink() && !stat.isFile()) fail(`installed command ${command} is unavailable`);
  }
}

function assertInstalledLicences(consumer) {
  const roots = [path.join(consumer, "node_modules")];
  const visited = new Set();
  while (roots.length > 0) {
    const directory = roots.pop();
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".bin") continue;
      const target = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        roots.push(target);
        continue;
      }
      const filename = path.join(target, "package.json");
      if (!fs.existsSync(filename)) continue;
      const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
      const licence = manifest.license ?? manifest.licenses;
      if (
        (typeof licence !== "string" || licence.trim() === "" || licence === "UNLICENSED") &&
        (!Array.isArray(licence) || licence.length === 0)
      ) fail(`installed dependency ${manifest.name ?? entry.name} has no declared licence`);
      const nested = path.join(target, "node_modules");
      if (fs.existsSync(nested)) roots.push(nested);
    }
  }
}

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
  return result.stdout;
}

function fail(message) {
  throw new Error(`release verification failed: ${message}`);
}
