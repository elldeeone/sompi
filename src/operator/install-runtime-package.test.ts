import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

test("runtime installation is scriptless before one exact native rebuild", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-runtime-install-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prefix = path.join(directory, "prefix");
  const fakeBin = path.join(directory, "bin");
  const log = path.join(directory, "npm-calls.jsonl");
  const marker = path.join(directory, "unlisted-lifecycle-ran");
  fs.mkdirSync(fakeBin);
  const fakeNpm = path.join(fakeBin, "npm");
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = path.resolve(__dirname, "..");
const log = path.join(root, "npm-calls.jsonl");
const marker = path.join(root, "unlisted-lifecycle-ran");
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const prefix = args[args.indexOf("--prefix") + 1];
if (args[0] === "install") {
  if (!args.includes("--ignore-scripts")) fs.writeFileSync(marker, "executed");
  const sompi = path.join(prefix, "node_modules", "@elldeeone", "sompi");
  const native = path.join(prefix, "node_modules", "better-sqlite3");
  fs.mkdirSync(path.join(native, "lib"), { recursive: true });
  fs.mkdirSync(sompi, { recursive: true });
  fs.writeFileSync(path.join(sompi, "package.json"), JSON.stringify({
    name: "@elldeeone/sompi", version: "0.11.3", dependencies: { "better-sqlite3": "12.11.1" }
  }));
  const nativeScripts = { install: "prebuild-install || node-gyp rebuild --release" };
  if (fs.existsSync(path.join(root, "inject-extra-lifecycle"))) nativeScripts.postinstall = "node unexpected.js";
  fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({
    name: "better-sqlite3", version: "12.11.1", type: "module",
    scripts: nativeScripts
  }));
  fs.writeFileSync(path.join(native, "lib", "index.js"),
    "export default class Database { exec() {} prepare() { return { get() { return { value: 1 }; } }; } close() {} }\\n");
}
`, { mode: 0o700 });

  const result = spawnSync(process.execPath, [
    path.resolve("scripts/install-runtime-package.mjs"),
    "--prefix", prefix,
    "--package", "/reviewed/sompi.tgz",
    "--expected-version", "0.11.3",
  ], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(marker), false, "no unreviewed lifecycle may run during install");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.[0], "install");
  assert.ok(calls[0]?.includes("--ignore-scripts"));
  assert.deepEqual(calls[1], [
    "run", "install", "--prefix",
    path.join(prefix, "node_modules", "better-sqlite3"),
  ]);

  const rejectedPrefix = path.join(directory, "rejected-prefix");
  fs.writeFileSync(path.join(directory, "inject-extra-lifecycle"), "1");
  const rejected = spawnSync(process.execPath, [
    path.resolve("scripts/install-runtime-package.mjs"),
    "--prefix", rejectedPrefix,
    "--package", "/reviewed/sompi.tgz",
    "--expected-version", "0.11.3",
  ], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /native dependency identity or rebuild command is not reviewed/u);
});
