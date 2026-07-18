import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP help and invalid commands terminate before runtime state", () => {
  const directory = temporaryDirectory("sompi-mcp-cli-");
  try {
    const help = run(path.join(DIST_ROOT, "index.js"), ["--help"], directory);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: sompi-mcp/m);
    assert.equal(help.stderr, "");
    assert.deepEqual(fs.readdirSync(directory), []);

    const invalid = run(path.join(DIST_ROOT, "index.js"), ["not-a-command"], directory);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /unsupported sompi-mcp command/);
    assert.equal(invalid.stderr.includes("not-a-command"), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("API help and invalid commands terminate before runtime or credential state", () => {
  const directory = temporaryDirectory("sompi-api-cli-");
  try {
    const help = run(path.join(DIST_ROOT, "api-main.js"), ["--help"], directory);
    assert.equal(help.status, 0);
    assert.equal(help.stdout, "usage: sompi-api [start]\n");
    assert.equal(help.stderr, "");
    assert.deepEqual(fs.readdirSync(directory), []);

    const invalid = run(path.join(DIST_ROOT, "api-main.js"), ["not-a-command"], directory);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /usage: sompi-api/);
    assert.equal(invalid.stderr.includes("not-a-command"), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("authority help and invalid commands terminate before authority path creation", () => {
  const directory = temporaryDirectory("sompi-authority-cli-");
  try {
    const help = run(path.join(DIST_ROOT, "authority-main.js"), ["--help"], directory);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: sompi-authority/m);
    assert.equal(help.stderr, "");
    assert.deepEqual(fs.readdirSync(directory), []);

    const invalid = run(
      path.join(DIST_ROOT, "authority-main.js"),
      ["not-a-command"],
      directory
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /unsupported sompi-authority command/);
    assert.equal(invalid.stderr.includes("not-a-command"), false);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("package self-import and fixed-fixture deep import are not exported", async () => {
  for (const specifier of [
    "@elldeeone/sompi",
    "@elldeeone/sompi/dist/adapters/ap2/authority-test-fixtures.js",
  ]) {
    await assert.rejects(
      import(specifier),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    );
  }
});

function run(entrypoint: string, args: readonly string[], home: string) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("SOMPI_"))
  );
  return spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: "utf8",
    env: {
      ...environment,
      HOME: home,
      SOMPI_NETWORK: "mainnet",
      SOMPI_DATA_DIR: path.join(home, "must-not-exist"),
      SOMPI_AUTHORITY_ROOT_DIR: path.join(home, "must-not-exist-authority"),
    },
  });
}

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}
