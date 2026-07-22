#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const expectedBins = Object.freeze({
  "sompi-agent": "dist/agent-main.js",
  "sompi-api": "dist/api-main.js",
  "sompi-authority": "dist/authority-main.js",
  "sompi-mcp": "dist/index.js",
  "sompi-operator": "dist/operator-main.js",
  "sompi-vault-recover": "scripts/vault-recover.js",
  "sompi-verify-authority-isolation": "scripts/verify-authority-isolation.js",
});
const expectedExports = Object.freeze({
  "./package.json": "./package.json",
});
const requiredFileRules = [
  "dist",
  "!dist/**/*.test.js",
  "!dist/e2e/**",
  "!dist/e2e-main.js",
  "!dist/adapters/ap2/authority-test-fixtures.js",
  "!docs/IMPLEMENTATION_PLAN_THROUGH_V0.12.0.md",
  "integrations",
  "host-bootstrap.example.json",
  "!integrations/**/__pycache__/**",
  "!integrations/**/*.pyc",
  "!integrations/**/tests/**",
  "scripts/install-runtime-package.mjs",
  "scripts/prepare-package.mjs",
  "scripts/require-source-tree.mjs",
  "scripts/verify-packed-artifact.mjs",
];
const roots = [
  "CONTEXT.md",
  "CURRENT_STATE.md",
  "LICENSE",
  "README.md",
  "contracts",
  "dist",
  "docs",
  "host-bootstrap.example.json",
  "integrations",
  "package.json",
  "operator.example.json",
  "scripts/package.json",
  "scripts/install-runtime-package.mjs",
  "scripts/prepare-package.mjs",
  "scripts/require-source-tree.mjs",
  "scripts/run-protocol-conformance.mjs",
  "scripts/vault-fixtures.json",
  "scripts/vault-recover.js",
  "scripts/verify-authority-isolation.js",
  "scripts/verify-packed-artifact.mjs",
  "test/conformance",
  "vendor/ap2-v0.2-schemas",
  "vendor/kaspa-x402-alpha.9-conformance",
  "vendor/kaspa-wasm",
];
const executableFiles = new Set([
  "dist/agent-main.js",
  "dist/api-main.js",
  "dist/authority-main.js",
  "dist/index.js",
  "dist/operator-main.js",
  "scripts/prepare-package.mjs",
  "scripts/require-source-tree.mjs",
  "scripts/run-protocol-conformance.mjs",
  "scripts/vault-recover.js",
  "scripts/verify-authority-isolation.js",
  "scripts/verify-packed-artifact.mjs",
]);

assertJsonEqual(packageJson.bin, expectedBins, "package bins");
assertJsonEqual(packageJson.exports, expectedExports, "package exports");
if (Object.prototype.hasOwnProperty.call(packageJson, "main")) {
  fail("the CLI-only package must not expose a side-effectful main module");
}
if (!Array.isArray(packageJson.files)) fail("package files must be an explicit array");
for (const rule of requiredFileRules) {
  if (!packageJson.files.includes(rule)) fail(`package files are missing ${rule}`);
}

const requiredFiles = [
  "dist/agent-main.js",
  "dist/api-main.js",
  "dist/authority-main.js",
  "dist/index.js",
  "dist/operator-main.js",
  "dist/conformance/kaspa-x402-alpha9.js",
  "dist/smoke.js",
  "integrations/hermes/plugin/__init__.py",
  "integrations/hermes/plugin/plugin.yaml",
  "integrations/hermes/sompi/SKILL.md",
  "integrations/hermes/compat/callback-hook.patch",
  "host-bootstrap.example.json",
  "scripts/install-runtime-package.mjs",
  "scripts/run-protocol-conformance.mjs",
  "scripts/vault-recover.js",
  "scripts/verify-authority-isolation.js",
  "test/conformance/README.md",
  "vendor/ap2-v0.2-schemas/LICENSE",
  "vendor/kaspa-wasm/LICENSE",
  "vendor/kaspa-wasm/kaspa_bg.wasm",
  "vendor/kaspa-x402-alpha.9-conformance/LICENSE",
];
for (const relative of requiredFiles) requireRegularFile(relative);

for (const relativeRoot of roots) normalize(relativeRoot);

for (const relative of requiredFiles) {
  const mode = fs.statSync(path.join(root, relative)).mode & 0o777;
  const expected = executableFiles.has(relative) ? 0o755 : 0o644;
  if (mode !== expected) fail(`${relative} mode is not ${expected.toString(8)}`);
}

process.stderr.write("package manifest and public file modes prepared\n");

function normalize(relative) {
  const filename = path.join(root, relative);
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) fail(`${relative} must not be a symbolic link`);
  if (stat.isDirectory()) {
    fs.chmodSync(filename, 0o755);
    for (const entry of fs.readdirSync(filename)) {
      normalize(path.join(relative, entry));
    }
    return;
  }
  if (!stat.isFile()) fail(`${relative} must be a regular file or directory`);
  const excluded =
    (relative.startsWith("dist/") && relative.endsWith(".test.js")) ||
    /^dist\/e2e\/live-testnet-[^/]+\.js$/.test(relative);
  if (excluded) return;
  fs.chmodSync(filename, executableFiles.has(relative) ? 0o755 : 0o644);
}

function requireRegularFile(relative) {
  const filename = path.join(root, relative);
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    fail(`required package file ${relative} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    fail(`required package file ${relative} is invalid`);
  }
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} do not match the supported release surface`);
  }
}

function fail(message) {
  throw new Error(`package preparation failed: ${message}`);
}
