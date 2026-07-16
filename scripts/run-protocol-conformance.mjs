#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceMarker = path.join(root, "src/conformance/ap2-v0.2.ts");
if (fs.existsSync(sourceMarker)) {
  run("npm", ["run", "build"], { cwd: root });
}
const { SUPPORTED_PROTOCOL_PROFILES } = await import(
  pathToFileURL(path.join(root, "dist/protocols/profiles.js")).href
);
const provenancePath = path.join(root, "test/conformance/provenance.json");
const provenance = readJson(provenancePath);
const ap2 = provenance.ap2;
const expectedRepository = "https://github.com/google-agentic-commerce/AP2.git";
const offline = process.env.SOMPI_CONFORMANCE_OFFLINE === "1";
const cacheRoot = path.resolve(
  process.env.SOMPI_CONFORMANCE_CACHE ??
    path.join(os.homedir(), ".cache", "sompi", "protocol-conformance")
);
const checkout = path.join(cacheRoot, `ap2-${SUPPORTED_PROTOCOL_PROFILES.ap2.gitCommit}`);
const lockPath = path.join(root, ap2.conformanceLock.path);
const environment = path.join(
  cacheRoot,
  `ap2-python-${ap2.conformanceLock.sha256.slice("sha256:".length, 18)}`
);

assertEqual(ap2.repository, expectedRepository, "AP2 repository provenance");
assertEqual(ap2.commit, SUPPORTED_PROTOCOL_PROFILES.ap2.gitCommit, "AP2 commit provenance");
assertFileDigest(lockPath, ap2.conformanceLock.sha256, "AP2 conformance lock");
for (const [relativePath, digest] of Object.entries(ap2.localFixtureFiles)) {
  assertFileDigest(path.join(root, relativePath), digest, `AP2 local fixture ${relativePath}`);
}

fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
assertPrivateOwnedDirectory(cacheRoot, "protocol conformance cache");
ensureExactAp2Checkout(checkout);
validateAp2Checkout(checkout);
syncPythonEnvironment(environment);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-protocol-conformance-"));
fs.chmodSync(work, 0o700);
try {
  const typescriptArtifacts = path.join(work, "typescript.json");
  const pythonArtifacts = path.join(work, "python.json");
  run(process.execPath, [
    path.join(root, "dist/conformance/ap2-v0.2.js"),
    "emit-typescript",
    typescriptArtifacts,
  ]);
  run(path.join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), [
    path.join(root, "test/conformance/ap2-v0.2/python_bridge.py"),
    "--fixture",
    path.join(root, "test/conformance/ap2-v0.2/fixture.json"),
    "--input",
    typescriptArtifacts,
    "--output",
    pythonArtifacts,
  ], {
    env: {
      ...process.env,
      PYTHONPATH: path.join(checkout, "code/sdk/python"),
      PYTHONDONTWRITEBYTECODE: "1",
      SOMPI_AP2_SOURCE_ROOT: checkout,
    },
  });
  run(process.execPath, [
    path.join(root, "dist/conformance/ap2-v0.2.js"),
    "verify-python",
    typescriptArtifacts,
    pythonArtifacts,
  ]);
  run(process.execPath, [
    "--test",
    path.join(root, "dist/conformance/kaspa-x402-alpha8.js"),
  ], { cwd: root });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

process.stdout.write(
  [
    "Protocol conformance passed.",
    `AP2: v0.2.0 @ ${ap2.commit} (Python 3.12, closed Human Present round trip and receipts).`,
    `Kaspa-x402: 0.1.0-alpha.8 @ ${provenance.kaspaX402.sourceCommit} (offline exact HTTP and full-consensus profile vectors).`,
    "Claim boundary: no live testnet, general AP2, standardized native-KAS AP2, or mainnet claim.",
    "",
  ].join("\n")
);

function ensureExactAp2Checkout(directory) {
  if (fs.existsSync(directory)) return;
  if (offline) {
    throw new Error("offline conformance requested but the exact AP2 checkout is not cached");
  }
  const temporary = `${directory}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
    run("git", ["init", "--quiet", temporary]);
    run("git", ["-C", temporary, "remote", "add", "origin", expectedRepository]);
    run("git", ["-C", temporary, "sparse-checkout", "init", "--cone"]);
    run("git", ["-C", temporary, "sparse-checkout", "set", "code/sdk/python"]);
    run("git", [
      "-C",
      temporary,
      "fetch",
      "--quiet",
      "--depth=1",
      "--filter=blob:none",
      "origin",
      SUPPORTED_PROTOCOL_PROFILES.ap2.gitCommit,
    ]);
    run("git", [
      "-C",
      temporary,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--quiet",
      "--detach",
      "FETCH_HEAD",
    ]);
    fs.renameSync(temporary, directory);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function validateAp2Checkout(directory) {
  assertPrivateOwnedDirectory(directory, "cached AP2 checkout");
  assertEqual(capture("git", ["-C", directory, "remote", "get-url", "origin"]), expectedRepository,
    "cached AP2 origin");
  assertEqual(capture("git", ["-C", directory, "rev-parse", "HEAD"]), ap2.commit,
    "cached AP2 commit");
  assertEqual(
    capture("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"]),
    "",
    "cached AP2 tracked worktree"
  );
  for (const [relativePath, digest] of Object.entries(ap2.upstreamFiles)) {
    assertFileDigest(path.join(directory, relativePath), digest, `AP2 ${relativePath}`);
  }
}

function syncPythonEnvironment(directory) {
  const args = [
    "sync",
    "--frozen",
    "--project",
    path.dirname(lockPath),
    "--python",
    "3.12",
    "--link-mode",
    "copy",
  ];
  if (offline) args.push("--offline");
  run("uv", args, {
    cwd: root,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: directory },
  });
}

function readJson(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path.basename(filePath)} must contain one JSON object`);
  }
  return value;
}

function assertFileDigest(filePath, expected, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`${label} has an invalid recorded digest`);
  }
  const status = fs.lstatSync(filePath);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real regular file`);
  }
  const actual = `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
  assertEqual(actual, expected, label);
}

function assertPrivateOwnedDirectory(directory, label) {
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current OS user`);
  }
  if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or other access`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match pinned provenance`);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} provenance check failed`);
  }
  return (result.stdout ?? "").trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} protocol conformance command failed`);
  }
}
