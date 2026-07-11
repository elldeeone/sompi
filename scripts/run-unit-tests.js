#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "dist");
const tests = [];

walk(root);
if (tests.length === 0) {
  console.error("No compiled unit tests found under dist");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests.sort()], { stdio: "inherit" });
process.exit(result.status ?? 1);

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".test.js")) tests.push(full);
  }
}
