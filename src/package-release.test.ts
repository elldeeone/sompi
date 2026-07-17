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
    "sompi-api": "dist/api-main.js",
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

test("MCP production code has only the canonical API client capability", () => {
  const files = [
    path.join(ROOT, "src", "index.ts"),
    ...sourceFiles(path.join(ROOT, "src", "mcp")).filter((filename) => !filename.endsWith(".test.ts")),
  ];
  const forbidden = [
    "/runtime/", "/wallet", "/vault", "/treasury/", "/authority/",
    "/adapters/ap2/", "/adapters/kaspa-x402/", "/purchase/journal",
  ];
  for (const filename of files) {
    const source = fs.readFileSync(filename, "utf8");
    for (const fragment of forbidden) {
      assert.equal(source.includes(fragment), false, `${path.relative(ROOT, filename)} imports ${fragment}`);
    }
  }
});

test("current documentation exposes only the API-first alpha.8 cutover", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const required of [
    "Kaspa-x402 `0.1.0-alpha.8`",
    "`standard-native`",
    "`additive`",
    "Kaspa-x402 batch settlement",
    "`POST /purchases`",
    "`GET /purchases/{purchaseId}`",
    "`POST /purchases/{purchaseId}/recover`",
    "`purchase_status`",
    "`purchase_recover`",
  ]) {
    assert.ok(readme.includes(required), `README is missing ${required}`);
  }

  const currentDocuments = [
    "CURRENT_STATE.md",
    "README.md",
    "contracts/README.md",
    "docs/agent-interaction-ux.md",
    "docs/vault-poc.md",
    "docs/architecture/PURCHASE_JOURNAL.md",
    "docs/conformance/PROTOCOL_CONFORMANCE.md",
    "docs/runbooks/AUTHORITY.md",
    "docs/runbooks/CHANNEL_RECOVERY.md",
    "docs/runbooks/JOURNAL.md",
    "docs/runbooks/OPERATOR_PROVISIONING.md",
    "docs/runbooks/README.md",
    "docs/runbooks/RECONCILIATION.md",
    "docs/runbooks/STAGING_RECOVERY.md",
    "docs/runbooks/TESTNET_RESET.md",
  ];
  const forbidden = [
    "MCP-owned",
    "MCP Purchase state",
    "SOMPI_DATA_DIR",
    "/var/lib/sompi-mcp",
    "`payment_status`",
    "`get_address`",
    "`get_balance`",
    "`await_payment`",
    "`verify_payment`",
    "`send_payment`",
    "`vault_status`",
    "`vault_deposit`",
    "`vault_send`",
    "`treasury_operation_status`",
    "`treasury_operation_recover`",
    "`estimate_fee`",
    "`network_status`",
    "`get_policy`",
  ];
  for (const relative of currentDocuments) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    for (const value of forbidden) {
      assert.equal(source.includes(value), false, `${relative} contains obsolete ${value}`);
    }
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]?.split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      assert.equal(
        fs.existsSync(path.resolve(path.dirname(path.join(ROOT, relative)), target)),
        true,
        `${relative} contains a broken local link to ${target}`,
      );
    }
  }

  const journal = fs.readFileSync(
    path.join(ROOT, "docs", "architecture", "PURCHASE_JOURNAL.md"),
    "utf8",
  );
  assert.match(journal, /only supported schema is epoch \*\*14\*\*/);
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
