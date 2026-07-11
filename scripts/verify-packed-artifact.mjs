#!/usr/bin/env node

import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const archivePath = process.argv[2];
if (!archivePath || process.argv.length !== 3) {
  process.stderr.write("usage: verify-packed-artifact.mjs PACKAGE.tgz\n");
  process.exit(2);
}

const archive = fs.readFileSync(path.resolve(archivePath));
const tar = gunzipSync(archive);
const entries = readTar(tar);
const byName = new Map(entries.map((entry) => [entry.name, entry]));

for (const required of [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.js",
  "package/dist/authority-main.js",
  "package/dist/e2e-main.js",
  "package/scripts/run-local-e2e.mjs",
  "package/scripts/run-protocol-conformance.mjs",
  "package/scripts/vault-recover.js",
  "package/scripts/verify-authority-isolation.js",
  "package/vendor/kaspa-wasm/kaspa_bg.wasm",
]) {
  if (!byName.has(required)) fail(`required entry ${required} is missing`);
}

for (const entry of entries) {
  if (
    entry.name.startsWith("/") ||
    entry.name.split("/").includes("..") ||
    !entry.name.startsWith("package/")
  ) {
    fail(`unsafe archive path ${entry.name}`);
  }
  if (entry.type !== "file" && entry.type !== "directory") {
    fail(`archive entry ${entry.name} has unsupported type ${entry.type}`);
  }
  if (
    /(^|\/)src\//.test(entry.name) ||
    /\.test\.js$/.test(entry.name) ||
    /^package\/dist\/e2e\/live-testnet-[^/]+\.js$/.test(entry.name) ||
    /(^|\/)evidence\//.test(entry.name) ||
    /(^|\/)goal\.md$/.test(entry.name) ||
    /(^|\/)scripts\/compile-vault-fixtures\.js$/.test(entry.name) ||
    /\.(?:sqlite(?:-wal|-shm)?|key|pem|env|log)$/.test(entry.name)
  ) {
    fail(`forbidden release artifact ${entry.name}`);
  }
  const expectedMode =
    entry.type === "directory"
      ? 0o755
      : executable(entry.name)
        ? 0o755
        : 0o644;
  if (entry.mode !== expectedMode) {
    fail(
      `${entry.name} mode ${entry.mode.toString(8)} is not ${expectedMode.toString(8)}`
    );
  }
}

const manifestEntry = byName.get("package/package.json");
if (!manifestEntry || manifestEntry.type !== "file") fail("package.json is unavailable");
const manifest = JSON.parse(manifestEntry.bytes.toString("utf8"));
if (Object.prototype.hasOwnProperty.call(manifest, "main")) {
  fail("packed manifest exposes a side-effectful main module");
}
if (JSON.stringify(manifest.exports) !== JSON.stringify({ "./package.json": "./package.json" })) {
  fail("packed manifest exports are invalid");
}
if (
  JSON.stringify(manifest.bin) !==
  JSON.stringify({
    "sompi-authority": "dist/authority-main.js",
    "sompi-mcp": "dist/index.js",
    "sompi-vault-recover": "scripts/vault-recover.js",
    "sompi-verify-authority-isolation": "scripts/verify-authority-isolation.js",
  })
) {
  fail("packed manifest bins are invalid");
}

process.stdout.write(
  `${JSON.stringify({
    status: "pass",
    archive: path.resolve(archivePath),
    entries: entries.length,
    packedBytes: archive.byteLength,
    unpackedFileBytes: entries.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.bytes.byteLength : 0),
      0
    ),
  })}\n`
);

function executable(name) {
  return new Set([
    "package/dist/authority-main.js",
    "package/dist/index.js",
    "package/scripts/prepare-package.mjs",
    "package/scripts/require-source-tree.mjs",
    "package/scripts/run-local-e2e.mjs",
    "package/scripts/run-protocol-conformance.mjs",
    "package/scripts/vault-recover.js",
    "package/scripts/verify-authority-isolation.js",
    "package/scripts/verify-packed-artifact.mjs",
  ]).has(name);
}

function readTar(bytes) {
  const result = [];
  const names = new Set();
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = text(header.subarray(0, 100));
    const prefix = text(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const mode = octal(header.subarray(100, 108), "mode");
    const size = octal(header.subarray(124, 136), "size");
    const typeFlag = header[156];
    const type =
      typeFlag === 0 || typeFlag === 0x30
        ? "file"
        : typeFlag === 0x35
          ? "directory"
          : `type-${String.fromCharCode(typeFlag)}`;
    if (!fullName || names.has(fullName)) fail("archive contains an empty or duplicate path");
    names.add(fullName);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.byteLength) fail(`archive entry ${fullName} is truncated`);
    result.push({
      name: fullName.replace(/\/$/, ""),
      mode,
      type,
      bytes: Buffer.from(bytes.subarray(dataStart, dataEnd)),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return result;
}

function text(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function octal(bytes, label) {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) fail(`archive ${label} is invalid`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`archive ${label} is invalid`);
  return parsed;
}

function fail(message) {
  throw new Error(`packed artifact verification failed: ${message}`);
}
