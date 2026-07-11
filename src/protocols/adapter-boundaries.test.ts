import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("AP2 and Kaspa-x402 adapters have no imports of each other", () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sourceAdapters = path.join(projectRoot, "src", "adapters");
  assert.ok(fs.statSync(sourceAdapters).isDirectory(), "source adapter tree is unavailable");

  const violations = [
    ...forbiddenImports(path.join(sourceAdapters, "ap2"), isKaspaX402Import),
    ...forbiddenImports(path.join(sourceAdapters, "kaspa-x402"), isAp2Import),
  ];
  assert.deepEqual(violations, []);
});

function forbiddenImports(
  directory: string,
  forbidden: (specifier: string) => boolean
): string[] {
  const violations: string[] = [];
  for (const filename of sourceFiles(directory)) {
    const text = fs.readFileSync(filename, "utf8");
    for (const specifier of moduleSpecifiers(text)) {
      if (forbidden(specifier)) {
        violations.push(`${path.relative(directory, filename)} -> ${specifier}`);
      }
    }
  }
  return violations.sort();
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(filename));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(filename);
  }
  return files;
}

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  return specifiers;
}

function isKaspaX402Import(specifier: string): boolean {
  return specifier.startsWith("@kaspa-x402/") || hasPathSegment(specifier, "kaspa-x402");
}

function isAp2Import(specifier: string): boolean {
  return hasPathSegment(specifier, "ap2");
}

function hasPathSegment(specifier: string, segment: string): boolean {
  return specifier.split(/[\\/]/).includes(segment);
}
