#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const sourceInstaller = fs.readFileSync(
    path.join(root, "scripts", "install-runtime-package.mjs"),
  );
  const installerSha256 = createHash("sha256").update(sourceInstaller).digest("hex");
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
  const installerUrl =
    `https://raw.githubusercontent.com/elldeeone/sompi/v${manifest.version}/scripts/install-runtime-package.mjs`;
  if (!skill.includes(installerUrl) || !skill.includes(installerSha256)) {
    fail("skill does not pin the scriptless installer URL and SHA-256");
  }
  let installerBytes;
  if (packageSource) {
    installerBytes = readArchiveEntry(
      packageSource,
      "package/scripts/install-runtime-package.mjs",
    );
    if (!installerBytes.equals(sourceInstaller)) {
      fail("candidate package scriptless installer differs from the source installer");
    }
  } else {
    const installerResponse = await fetch(installerUrl, { redirect: "follow" });
    if (!installerResponse.ok) {
      fail(`scriptless installer returned HTTP ${installerResponse.status}`);
    }
    installerBytes = Buffer.from(await installerResponse.arrayBuffer());
    if (!installerBytes.equals(sourceInstaller)) {
      fail("remote scriptless installer differs from the source installer");
    }
  }
  if (createHash("sha256").update(installerBytes).digest("hex") !== installerSha256) {
    fail("scriptless installer does not match its pinned SHA-256");
  }
  const installerFile = path.join(temporary, "install-runtime-package.mjs");
  fs.writeFileSync(installerFile, installerBytes, { mode: 0o600 });

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
  const previewPrefix = path.join(temporary, "preview-runtime");
  const installReceipt = runJson(process.execPath, [
    installerFile,
    "--prefix", previewPrefix,
    "--package", npmPackage,
    "--expected-version", manifest.version,
    "--omit-dev",
  ], temporary);
  if (
    installReceipt.status !== "pass" ||
    installReceipt.scriptsDuringInstall !== false ||
    installReceipt.rebuilt !== "better-sqlite3@12.11.1" ||
    installReceipt.packageVersion !== manifest.version
  ) {
    fail("scriptless installer returned an invalid receipt");
  }
  const operatorBin = path.join(previewPrefix, "node_modules", ".bin", "sompi-operator");
  const preview = runJson(operatorBin, [
    "bootstrap-preview",
    requestFile,
  ], temporary);
  if (
    preview.package !== packageSpec ||
    typeof preview.requestDigest !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(preview.requestDigest) ||
    typeof preview.nextCommand !== "string"
  ) {
    fail("published package returned an invalid bootstrap preview");
  }
  if (
    !skill.includes(`--package ${packageSpec}`) ||
    !skill.includes("Show the exact `nextCommand` from the preview.") ||
    /^\s*(?:sudo\s+)?npm exec\b|--allow-scripts/m.test(skill)
  ) {
    fail("skill does not use the scriptless package installation flow");
  }
  if (
    !preview.nextCommand.startsWith("sudo sh -eu -c ") ||
    !preview.nextCommand.includes(installerUrl) ||
    !preview.nextCommand.includes(installerSha256) ||
    !preview.nextCommand.includes(`/opt/sompi/releases/${manifest.version}`) ||
    !preview.nextCommand.includes(packageSpec) ||
    !preview.nextCommand.includes(path.resolve(requestFile)) ||
    !preview.nextCommand.includes(preview.requestDigest) ||
    /npm exec|allow-scripts/.test(preview.nextCommand)
  ) {
    fail("preview did not return the pinned scriptless privileged command");
  }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const result = run(operatorBin, [
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
    installer: "sha256-pinned-scriptless",
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
