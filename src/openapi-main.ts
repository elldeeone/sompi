#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

import { canonicalOpenApiBytes } from "./api/openapi.js";

const command = process.argv[2] ?? "check";
if (command !== "generate" && command !== "check") {
  process.stderr.write("usage: node dist/openapi-main.js [generate|check]\n");
  process.exit(2);
}
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { version?: unknown };
if (typeof packageJson.version !== "string") throw new Error("package version is invalid");
const filename = path.resolve("docs", "openapi", "sompi.openapi.json");
const expected = canonicalOpenApiBytes(packageJson.version);
try {
  if (command === "generate") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, expected);
  } else {
    const actual = fs.readFileSync(filename);
    try {
      if (!actual.equals(expected)) throw new Error("OpenAPI document is stale; run npm run openapi:generate");
    } finally {
      actual.fill(0);
    }
  }
} finally {
  expected.fill(0);
}
