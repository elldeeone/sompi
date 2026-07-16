#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

import {
  canonicalArazzoBytes,
  validateSompiArazzoDocument,
} from "./api/arazzo.js";

const command = process.argv[2] ?? "check";
if (command !== "generate" && command !== "check") {
  process.stderr.write("usage: node dist/arazzo-main.js [generate|check]\n");
  process.exit(2);
}
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
  version?: unknown;
};
if (typeof packageJson.version !== "string") throw new Error("package version is invalid");
const workflowFilename = path.resolve("docs", "openapi", "sompi.arazzo.json");
const openApiFilename = path.resolve("docs", "openapi", "sompi.openapi.json");
const expected = canonicalArazzoBytes(packageJson.version);
try {
  const openApi = JSON.parse(fs.readFileSync(openApiFilename, "utf8"));
  if (command === "generate") {
    const document = JSON.parse(expected.toString("utf8"));
    validateSompiArazzoDocument(document, openApi);
    fs.mkdirSync(path.dirname(workflowFilename), { recursive: true });
    fs.writeFileSync(workflowFilename, expected);
  } else {
    const actual = fs.readFileSync(workflowFilename);
    try {
      if (!actual.equals(expected)) {
        throw new Error("Arazzo document is stale; run npm run arazzo:generate");
      }
      validateSompiArazzoDocument(JSON.parse(actual.toString("utf8")), openApi);
    } finally {
      actual.fill(0);
    }
  }
} finally {
  expected.fill(0);
}
