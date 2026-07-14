import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package manifest exposes only supported executables and no import side effect", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    main?: unknown;
    exports?: unknown;
    bin?: unknown;
    files?: unknown;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "main"), false);
  assert.deepEqual(manifest.exports, { "./package.json": "./package.json" });
  assert.deepEqual(manifest.bin, {
    "sompi-authority": "dist/authority-main.js",
    "sompi-mcp": "dist/index.js",
    "sompi-operator": "dist/operator-main.js",
    "sompi-vault-recover": "scripts/vault-recover.js",
    "sompi-verify-authority-isolation": "scripts/verify-authority-isolation.js",
  });
  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.includes("!dist/**/*.test.js"));
  assert.ok(manifest.files.includes("!dist/e2e/live-testnet-*.js"));
  assert.equal(manifest.files.includes("scripts/run-live-testnet-e2e.mjs"), false);
  assert.equal(manifest.files.includes("scripts/compile-vault-fixtures.js"), false);

  assert.match(manifest.scripts?.prepack ?? "", /^npm run build && /);
  assert.match(manifest.scripts?.build ?? "", /^node scripts\/require-source-tree\.mjs build && /);
  assert.match(manifest.scripts?.clean ?? "", /^node scripts\/require-source-tree\.mjs clean && /);
  assert.match(manifest.scripts?.["test:unit"] ?? "", /^node scripts\/require-source-tree\.mjs test:unit && /);
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    assert.match(version, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/, `${name} must remain exactly pinned`);
  }
});

test("npm ignore and package preparation retain defence-in-depth exclusions", () => {
  const npmIgnore = fs.readFileSync(path.join(ROOT, ".npmignore"), "utf8").split(/\r?\n/);
  assert.ok(npmIgnore.includes("dist/**/*.test.js"));
  assert.ok(npmIgnore.includes("dist/e2e/live-testnet-*.js"));
  assert.ok(npmIgnore.includes("src/"));
  for (const filename of [
    "scripts/prepare-package.mjs",
    "scripts/require-source-tree.mjs",
    "scripts/verify-packed-artifact.mjs",
  ]) {
    const stat = fs.lstatSync(path.join(ROOT, filename));
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
  }
});

test("fixed AP2 proof identities have no production import path", () => {
  const offenders: string[] = [];
  for (const filename of sourceFiles(path.join(ROOT, "src"))) {
    const relative = path.relative(ROOT, filename).split(path.sep).join("/");
    if (
      relative.endsWith(".test.ts") ||
      relative === "src/adapters/ap2/test-fixtures.ts" ||
      relative.startsWith("src/e2e/") ||
      relative.startsWith("src/conformance/")
    ) {
      continue;
    }
    if (fs.readFileSync(filename, "utf8").includes("test-fixtures")) offenders.push(relative);
  }
  assert.deepEqual(offenders, []);
});

function sourceFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(filename));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(filename);
  }
  return result;
}
