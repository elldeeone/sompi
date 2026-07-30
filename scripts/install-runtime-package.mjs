#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const NATIVE_PACKAGE = "better-sqlite3";
const NATIVE_VERSION = "12.11.1";
const NATIVE_INSTALL = "prebuild-install || node-gyp rebuild --release";
const NPM_REGISTRY = "https://registry.npmjs.org/";

const options = parseArguments(process.argv.slice(2));
// The runtime contains public program files. Host Bootstrap keeps a restrictive
// umask for state and credentials, so the installer must set its own code mode.
process.umask(0o022);
fs.mkdirSync(options.prefix, { recursive: true, mode: 0o755 });

runNpm([
  "install",
  "--prefix", options.prefix,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--package-lock=false",
  "--registry", NPM_REGISTRY,
  ...(options.omitDev ? ["--omit=dev"] : []),
  options.package,
]);

const sompiManifest = readManifest(path.join(
  options.prefix,
  "node_modules",
  "@elldeeone",
  "sompi",
  "package.json",
));
if (sompiManifest.name !== "@elldeeone/sompi" || sompiManifest.version !== options.expectedVersion) {
  fail("installed Sompi package identity does not match the reviewed release");
}
if (sompiManifest.dependencies?.[NATIVE_PACKAGE] !== NATIVE_VERSION) {
  fail("installed Sompi package does not pin the reviewed native dependency");
}

const nativeRoot = path.join(options.prefix, "node_modules", NATIVE_PACKAGE);
const nativeManifest = readManifest(path.join(nativeRoot, "package.json"));
const nativeLifecycleScripts = Object.fromEntries(
  ["preinstall", "install", "postinstall", "prepare"]
    .filter((name) => nativeManifest.scripts?.[name] !== undefined)
    .map((name) => [name, nativeManifest.scripts[name]]),
);
if (
  nativeManifest.name !== NATIVE_PACKAGE ||
  nativeManifest.version !== NATIVE_VERSION ||
  nativeManifest.scripts?.install !== NATIVE_INSTALL ||
  Object.keys(nativeLifecycleScripts).length !== 1
) {
  fail("installed native dependency identity or rebuild command is not reviewed");
}

// The ordinary install is unconditionally scriptless. Grant one explicit,
// name-, version-, and command-bound lifecycle capability only after inspecting
// the installed manifest. Running the package script directly avoids npm 10's
// fail-open allowScripts behavior and npm 12's project approval ambiguity.
runNpm([
  "run",
  "install",
  "--prefix", nativeRoot,
]);

const probe = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", [
    `import Database from ${JSON.stringify(path.join(nativeRoot, "lib", "index.js"))};`,
    "const db = new Database(':memory:');",
    "db.exec('CREATE TABLE probe(value INTEGER) STRICT; INSERT INTO probe VALUES (1)');",
    "if (db.prepare('SELECT value FROM probe').get().value !== 1) process.exit(1);",
    "db.close();",
  ].join("\n")],
  { cwd: options.prefix, env: minimalEnvironment(), encoding: "utf8" },
);
if (probe.status !== 0) {
  if (probe.stderr) process.stderr.write(probe.stderr);
  fail("reviewed native dependency failed its post-rebuild behavior probe");
}

process.stdout.write(`${JSON.stringify({
  status: "pass",
  scriptsDuringInstall: false,
  rebuilt: `${NATIVE_PACKAGE}@${NATIVE_VERSION}`,
  packageVersion: options.expectedVersion,
})}\n`);

function parseArguments(args) {
  const values = new Map();
  let omitDev = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--omit-dev") {
      omitDev = true;
      continue;
    }
    if (!value?.startsWith("--") || index + 1 >= args.length) fail("invalid install helper arguments");
    values.set(value, args[++index]);
  }
  const prefix = path.resolve(String(values.get("--prefix") ?? ""));
  const packageValue = String(values.get("--package") ?? "");
  const expectedVersion = String(values.get("--expected-version") ?? "");
  if (!path.isAbsolute(prefix) || packageValue.length < 1 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
    fail("install helper arguments are invalid");
  }
  return Object.freeze({ prefix, package: packageValue, expectedVersion, omitDev });
}

function readManifest(filename) {
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 128 * 1024) {
    fail("installed package manifest is unsafe");
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function runNpm(args) {
  const result = spawnSync("npm", args, {
    cwd: options?.prefix ?? process.cwd(),
    env: minimalEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "npm failed\n");
    fail("scriptless runtime installation failed");
  }
}

function minimalEnvironment() {
  const keep = ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const env = Object.create(null);
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.npm_config_ignore_scripts = "false";
  env.npm_config_update_notifier = "false";
  return env;
}

function fail(message) {
  process.stderr.write(`Sompi runtime install failed: ${message}\n`);
  process.exit(1);
}
