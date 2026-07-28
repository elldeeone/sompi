import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = path.join(root, "scripts", "run-restart-proof.mjs");

test("restart proof runner rejects noncanonical public artifact names", () => {
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--mode",
      "retained",
      "--evidence-set",
      "phase5-c5",
      "--directory",
      "/tmp/private-restart-proof",
      "--report",
      "/tmp/public/report.json",
      "--restart-evidence",
      "/tmp/public/proof.json",
      "--verification",
      "/tmp/public/digests.json",
      "--replace-existing",
      "false",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /public evidence must use one directory and the canonical filenames/u,
  );
});
