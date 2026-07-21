#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceMarker = path.join(root, "src/conformance/kaspa-x402-alpha9.ts");
if (fs.existsSync(sourceMarker)) {
  run("npm", ["run", "build"], { cwd: root });
}
const { SUPPORTED_PROTOCOL_PROFILES } = await import("../dist/protocols/profiles.js");
const provenancePath = path.join(root, "test/conformance/provenance.json");
const provenance = readJson(provenancePath);
const ap2 = provenance.ap2;
const kaspaX402 = provenance.kaspaX402;
const expectedRepository = "https://github.com/google-agentic-commerce/AP2.git";
const expectedKaspaX402Repository = "https://github.com/elldeeone/kaspa-x402.git";
const offline = process.env.SOMPI_CONFORMANCE_OFFLINE === "1";
const cacheRoot = path.resolve(
  process.env.SOMPI_CONFORMANCE_CACHE ??
    path.join(os.homedir(), ".cache", "sompi", "protocol-conformance")
);
const checkout = path.join(cacheRoot, `ap2-${SUPPORTED_PROTOCOL_PROFILES.ap2.gitCommit}`);
const kaspaX402Checkout = path.join(cacheRoot, `kaspa-x402-${kaspaX402.sourceCommit}`);

assertEqual(ap2.repository, expectedRepository, "AP2 repository provenance");
assertEqual(ap2.commit, SUPPORTED_PROTOCOL_PROFILES.ap2.gitCommit, "AP2 commit provenance");

fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
assertPrivateOwnedDirectory(cacheRoot, "protocol conformance cache");
ensureExactAp2Checkout(checkout);
validateAp2Checkout(checkout);
ensureExactKaspaX402Checkout(kaspaX402Checkout);
validateKaspaX402Checkout(kaspaX402Checkout);
verifyKaspaX402PublishedPackages(kaspaX402Checkout);
run(process.execPath, [
  "--test",
  path.join(root, "dist/conformance/kaspa-x402-alpha9.js"),
], { cwd: root });

process.stdout.write(
  [
    "Protocol conformance passed.",
    `AP2: v0.2.0 @ ${ap2.commit} (source and schema provenance watch only).`,
    `Kaspa-x402: 0.1.0-alpha.9 @ ${provenance.kaspaX402.sourceCommit} (published packages reproduced byte-for-byte; offline exact HTTP, exact/batch interoperability, and full-consensus vectors).`,
    "Claim boundary: no live testnet, general AP2, standardized native-KAS AP2, or mainnet claim.",
    "",
  ].join("\n")
);

function ensureExactAp2Checkout(directory) {
  if (fs.existsSync(directory)) {
    run("git", ["-C", directory, "sparse-checkout", "set", "code/sdk/schemas/ap2"]);
    return;
  }
  if (offline) {
    throw new Error("offline conformance requested but the exact AP2 checkout is not cached");
  }
  const temporary = `${directory}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
    run("git", ["init", "--quiet", temporary]);
    run("git", ["-C", temporary, "remote", "add", "origin", expectedRepository]);
    run("git", ["-C", temporary, "sparse-checkout", "init", "--cone"]);
    run("git", ["-C", temporary, "sparse-checkout", "set", "code/sdk/schemas/ap2"]);
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
  for (const [relativePath, digest] of Object.entries(ap2.schemaFiles)) {
    const upstream = path.join(directory, "code/sdk/schemas/ap2", relativePath);
    const vendored = path.join(root, "vendor/ap2-v0.2-schemas", relativePath);
    assertFileDigest(upstream, digest, `AP2 upstream schema ${relativePath}`);
    assertFileDigest(vendored, digest, `AP2 vendored schema ${relativePath}`);
  }
}

function ensureExactKaspaX402Checkout(directory) {
  if (fs.existsSync(directory)) return;
  if (offline) {
    throw new Error("offline conformance requested but the exact Kaspa-x402 checkout is not cached");
  }
  const temporary = `${directory}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
    run("git", ["init", "--quiet", temporary]);
    run("git", ["-C", temporary, "remote", "add", "origin", expectedKaspaX402Repository]);
    run("git", [
      "-C",
      temporary,
      "fetch",
      "--quiet",
      "--depth=1",
      "origin",
      kaspaX402.sourceCommit,
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

function validateKaspaX402Checkout(directory) {
  assertPrivateOwnedDirectory(directory, "cached Kaspa-x402 checkout");
  assertEqual(
    capture("git", ["-C", directory, "remote", "get-url", "origin"]),
    expectedKaspaX402Repository,
    "cached Kaspa-x402 origin",
  );
  assertEqual(
    capture("git", ["-C", directory, "rev-parse", "HEAD"]),
    kaspaX402.sourceCommit,
    "cached Kaspa-x402 commit",
  );
  assertEqual(
    capture("git", ["-C", directory, "status", "--porcelain", "--untracked-files=no"]),
    "",
    "cached Kaspa-x402 tracked worktree",
  );
}

function verifyKaspaX402PublishedPackages(directory) {
  const installArgs = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (offline) installArgs.push("--offline");
  run("npm", installArgs, { cwd: directory });
  for (const packageName of ["core", "covenant", "client", "server"]) {
    run("npm", ["--workspace", `@kaspa-x402/${packageName}`, "run", "build"], {
      cwd: directory,
    });
    const published = path.join(root, "node_modules", "@kaspa-x402", packageName);
    const rebuilt = path.join(directory, "packages", packageName);
    const expectedFiles = ["LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "package.json"];
    assertEqual(
      packageFiles(published).join("\n"),
      expectedFiles.join("\n"),
      `published @kaspa-x402/${packageName} file set`,
    );
    for (const relativePath of expectedFiles) {
      const publishedFile = path.join(published, relativePath);
      const rebuiltFile = path.join(rebuilt, relativePath);
      assertFileDigest(
        rebuiltFile,
        `sha256:${createHash("sha256").update(fs.readFileSync(publishedFile)).digest("hex")}`,
        `rebuilt @kaspa-x402/${packageName}/${relativePath}`,
      );
    }
  }
}

function packageFiles(directory) {
  const files = [];
  const visit = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(current, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`published package contains a non-regular entry: ${relativePath}`);
      }
    }
  };
  visit(directory, "");
  return files.sort();
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
