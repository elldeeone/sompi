import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPhase4RestartEvidence,
  type Phase4RestartReport,
} from "./phase4-c7-restart-evidence.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Phase 4 restart evidence reconstructs the committed artifact exactly", () => {
  const committed = readJson<
    ReturnType<typeof createPhase4RestartEvidence>
  >("evidence/phase4-c7/restart-proof.json");
  const report = readJson<Phase4RestartReport>(
    "evidence/phase4-c7/standard-native.json",
  );
  const {
    captureMethod: _captureMethod,
    ...beforeRestart
  } = committed.beforeRestart;

  const reconstructed = createPhase4RestartEvidence({
    beforeRestart,
    afterRestart: committed.afterRestart,
    report,
    process: {
      durableActivityStartedAtMs: Date.parse(
        committed.processBoundary.firstInvocation
          .durableActivityStartedAt,
      ),
      durableStopRecordedAtMs: Date.parse(
        committed.processBoundary.firstInvocation
          .durableStopRecordedAt,
      ),
      firstDurableRecoveryAtMs: Date.parse(
        committed.processBoundary.secondInvocation
          .firstDurableRecoveryAt,
      ),
      secondCompletedAt:
        committed.processBoundary.secondInvocation.completedAt,
      firstExitSignal:
        committed.processBoundary.firstInvocation.exitSignal,
      secondExitCode:
        committed.processBoundary.secondInvocation.exitCode,
    },
    generatedAt: committed.generatedAt,
  });

  assert.deepEqual(reconstructed, committed);
});

function readJson<T>(filename: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(root, filename), "utf8"),
  ) as T;
}
