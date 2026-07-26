import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_ROOT = path.join(ROOT, "src");
const OWNED_POLICY_FILES = new Set([
  "chain-evidence/module.ts",
  "chain-evidence/types.ts",
  "purchase/journal.ts",
]);
const NON_PRODUCTION_ROOTS = ["conformance", "demo", "e2e"];

test("production Chain Evidence callers do not select floors or interpret evidence rank", () => {
  const violations: string[] = [];
  for (const filename of sourceFiles(SOURCE_ROOT)) {
    const relative = path.relative(SOURCE_ROOT, filename);
    if (
      relative.endsWith(".test.ts") ||
      OWNED_POLICY_FILES.has(relative) ||
      NON_PRODUCTION_ROOTS.some(
        (directory) => relative.startsWith(`${directory}${path.sep}`)
      )
    ) {
      continue;
    }
    const source = fs.readFileSync(filename, "utf8");
    if (/\boperatorFloor\s*:/.test(source)) {
      violations.push(`${relative} supplies an operator floor`);
    }
    if (/\bFinalityFloor\b/.test(source)) {
      violations.push(`${relative} depends on the floor type`);
    }
    if (/\bmeets\s*\(/.test(source)) {
      violations.push(`${relative} interprets evidence rank`);
    }
    if (
      /\boperatorFinalityFloor\s*===\s*["']depth-confirmed["']/.test(source) ||
      /["']depth-confirmed["']\s*===\s*\boperatorFinalityFloor\b/.test(source)
    ) {
      violations.push(`${relative} reimplements the effective finality rule`);
    }
  }
  assert.deepEqual(violations, []);
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(filename));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(filename);
  }
  return files;
}
