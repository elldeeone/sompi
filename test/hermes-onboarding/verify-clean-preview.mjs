#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-hermes-onboarding-"));
const packageSource = parseArguments(process.argv.slice(2));

try {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const sourceSkill = fs.readFileSync(
    path.join(root, "integrations", "hermes", "sompi", "SKILL.md"),
    "utf8",
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const installSection = readme
    .split("## Install with Hermes")[1]
    ?.split("## Wallet")[0] ?? "";
  const skillUrl =
    `https://raw.githubusercontent.com/elldeeone/sompi/v${manifest.version}/integrations/hermes/sompi/SKILL.md`;
  if (!installSection.includes(skillUrl)) fail("README does not point to the canonical remote skill");
  if (/bootstrap-preview|host-bootstrap\.example\.json|nextCommand|activateCommand|^\d+\.\s/m.test(installSection)) {
    fail("README duplicates the remote installation procedure");
  }

  let skill = sourceSkill;
  if (packageSource) {
    skill = readArchiveEntry(
      packageSource,
      "package/integrations/hermes/sompi/SKILL.md",
    ).toString("utf8");
    if (skill !== sourceSkill) fail("candidate package skill differs from the source skill");
  } else {
    const skillResponse = await fetch(skillUrl, { redirect: "follow" });
    if (!skillResponse.ok) fail(`README skill URL returned HTTP ${skillResponse.status}`);
    skill = await skillResponse.text();
    if (skill !== sourceSkill) fail("remote skill differs from the source skill");
  }

  const templateMatch = skill.match(
    /https:\/\/raw\.githubusercontent\.com\/elldeeone\/sompi\/v([0-9]+\.[0-9]+\.[0-9]+)\/host-bootstrap\.example\.json/,
  );
  if (!templateMatch || templateMatch[1] !== manifest.version) {
    fail("skill does not pin the request template to its package release");
  }
  const localTemplate = fs.readFileSync(path.join(root, "host-bootstrap.example.json"));
  let templateBytes;
  if (packageSource) {
    templateBytes = readArchiveEntry(packageSource, "package/host-bootstrap.example.json");
    if (!templateBytes.equals(localTemplate)) {
      fail("candidate package request template differs from the source template");
    }
  } else {
    const templateResponse = await fetch(templateMatch[0], { redirect: "follow" });
    if (!templateResponse.ok) fail(`request template returned HTTP ${templateResponse.status}`);
    templateBytes = Buffer.from(await templateResponse.arrayBuffer());
    if (!templateBytes.equals(localTemplate)) fail("remote request template differs from the source template");
  }

  const request = JSON.parse(templateBytes.toString("utf8"));
  if (request.packageVersion !== manifest.version) fail("request template package version is stale");
  const requestFile = path.join(temporary, "bootstrap-request.json");
  fs.writeFileSync(requestFile, templateBytes, { mode: 0o600 });

  const packageSpec = `@elldeeone/sompi@${manifest.version}`;
  const npmPackage = packageSource ?? packageSpec;
  const preview = runJson("npm", [
    "exec",
    "--yes",
    "--allow-scripts=better-sqlite3@12.11.1",
    `--package=${npmPackage}`,
    "--",
    "sompi-operator",
    "bootstrap-preview",
    requestFile,
  ], temporary);
  if (
    preview.package !== packageSpec ||
    typeof preview.requestDigest !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(preview.requestDigest)
  ) {
    fail("published package returned an invalid bootstrap preview");
  }
  if (
    !skill.includes(`--package=${packageSpec}`) ||
    !skill.includes("sompi-operator bootstrap ~/.sompi/bootstrap-request.json REQUEST_DIGEST") ||
    skill.includes("\nsudo sompi-operator bootstrap")
  ) {
    fail("skill does not contain the package-resolving manual bootstrap command");
  }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const result = run("npm", [
      "exec",
      "--yes",
      "--allow-scripts=better-sqlite3@12.11.1",
      `--package=${npmPackage}`,
      "--",
      "sompi-operator",
      "bootstrap",
      requestFile,
      preview.requestDigest,
    ], temporary);
    if (
      result.status !== 1 ||
      !result.stderr.includes("host bootstrap must run as root outside the agent session")
    ) {
      fail("manual bootstrap command did not reach the privileged boundary");
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: "pass",
    prompt: "remote-skill-only",
    templateRelease: `v${templateMatch[1]}`,
    package: packageSpec,
    packageSource: packageSource ? "candidate-archive" : "published-package",
    preview: "pass",
    privilegedBoundary: typeof process.getuid === "function" && process.getuid() !== 0
      ? "reached"
      : "not-run-as-root",
  })}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function runJson(command, args, cwd) {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${args.join(" ")} failed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("bootstrap preview did not return JSON");
  }
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function parseArguments(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--package") {
    fail("usage: verify-clean-preview.mjs [--package PACKAGE.tgz]");
  }
  const filename = path.resolve(args[1]);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("candidate package must be one regular archive");
  return filename;
}

function readArchiveEntry(filename, expectedName) {
  const archive = gunzipSync(fs.readFileSync(filename));
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const rawSize = tarText(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(rawSize)) fail("candidate package contains an invalid tar size");
    const size = Number.parseInt(rawSize, 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.byteLength) fail("candidate package contains a truncated tar entry");
    if (fullName === expectedName) return Buffer.from(archive.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  fail(`candidate package is missing ${expectedName}`);
}

function tarText(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function fail(message) {
  process.stderr.write(`Hermes onboarding verification failed: ${message}\n`);
  process.exit(1);
}
