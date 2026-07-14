#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markers = [
  "src/index.ts",
  "src/authority-main.ts",
  "scripts/run-unit-tests.js",
  "tsconfig.json",
];

for (const relative of markers) {
  const filename = path.join(root, relative);
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    fail();
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail();
}

function fail() {
  const command = process.argv[2] ?? "this command";
  process.stderr.write(
    `${command} is source-tree-only and cannot run from the installed runtime package\n`
  );
  process.exit(1);
}
