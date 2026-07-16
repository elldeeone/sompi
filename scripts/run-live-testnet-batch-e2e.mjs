#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.existsSync(path.join(root, "src", "e2e", "live-testnet-batch-main.ts"))) {
  run("npm", ["run", "build"]);
}
run(process.execPath, [
  path.join(root, "dist", "e2e", "live-testnet-batch-main.js"),
  ...process.argv.slice(2),
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(
      "live Testnet-10 batch proof stopped safely; rerun the same command to resume its durable state\n"
    );
    process.exit(result.status ?? 1);
  }
}
