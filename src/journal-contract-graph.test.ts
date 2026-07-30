import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(ROOT, "src");

const CHARACTERIZED_COMPONENT = [
  "purchase/journal.ts",
  "transfer/journal.ts",
  "treasury/lease-lifecycle.ts",
  "treasury/operation-adapters.ts",
  "treasury/operation-journal.ts",
  "treasury/operations.ts",
] as const;

const CHARACTERIZED_EDGES = [
  "purchase/journal.ts -> transfer/journal.ts",
  "purchase/journal.ts -> treasury/operation-journal.ts",
  "purchase/journal.ts -> treasury/operations.ts",
  "transfer/journal.ts -> treasury/operations.ts",
  "treasury/lease-lifecycle.ts -> purchase/journal.ts",
  "treasury/lease-lifecycle.ts -> treasury/operation-journal.ts",
  "treasury/operation-adapters.ts -> treasury/operation-journal.ts",
  "treasury/operation-journal.ts -> purchase/journal.ts",
  "treasury/operations.ts -> purchase/journal.ts",
  "treasury/operations.ts -> treasury/lease-lifecycle.ts",
  "treasury/operations.ts -> treasury/operation-adapters.ts",
  "treasury/operations.ts -> treasury/operation-journal.ts",
] as const;

test("the production Journal contract graph has one characterized cycle", () => {
  const graph = productionImportGraph();
  const components = cyclicComponents(graph);

  assert.deepEqual(components, [[...CHARACTERIZED_COMPONENT]]);
  assert.deepEqual(
    componentEdges(graph, new Set(CHARACTERIZED_COMPONENT)),
    [...CHARACTERIZED_EDGES],
  );
});

function productionImportGraph(): ReadonlyMap<string, readonly string[]> {
  const filenames = sourceFiles(SOURCE_ROOT)
    .filter((filename) => !filename.endsWith(".test.ts"))
    .sort();
  const productionFiles = new Set(filenames.map(normalizeFilename));
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  };
  const graph = new Map<string, readonly string[]>();

  for (const filename of filenames) {
    const source = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const dependencies = new Set<string>();
    for (const specifier of staticModuleSpecifiers(source)) {
      const resolved = ts.resolveModuleName(
        specifier,
        filename,
        compilerOptions,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const normalized = normalizeFilename(resolved);
      if (productionFiles.has(normalized)) {
        dependencies.add(relativeSourceFilename(normalized));
      }
    }
    graph.set(
      relativeSourceFilename(filename),
      [...dependencies].sort(),
    );
  }
  return graph;
}

function staticModuleSpecifiers(source: ts.SourceFile): readonly string[] {
  return source.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function cyclicComponents(
  graph: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, indices.get(dependency)!),
        );
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    component.sort();
    if (
      component.length > 1 ||
      (graph.get(component[0]) ?? []).includes(component[0])
    ) {
      components.push(component);
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0"))
  );
}

function componentEdges(
  graph: ReadonlyMap<string, readonly string[]>,
  component: ReadonlySet<string>,
): readonly string[] {
  return [...component]
    .sort()
    .flatMap((source) =>
      (graph.get(source) ?? [])
        .filter((target) => component.has(target))
        .map((target) => `${source} -> ${target}`)
    );
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

function normalizeFilename(filename: string): string {
  return path.normalize(filename);
}

function relativeSourceFilename(filename: string): string {
  return path.relative(SOURCE_ROOT, filename).split(path.sep).join("/");
}
