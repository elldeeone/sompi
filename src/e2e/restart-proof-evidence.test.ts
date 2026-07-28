import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRestartEvidence,
  createRestartVerification,
  restartEvidenceConfiguration,
  type RestartReport,
} from "./restart-proof-evidence.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

for (const evidenceSet of ["phase4-c7", "phase5-c5"] as const) {
  test(`${evidenceSet} restart evidence reconstructs the committed artifacts exactly`, () => {
    const committedRestart = readJson<
      ReturnType<typeof createRestartEvidence>
    >(`evidence/${evidenceSet}/restart-proof.json`);
    const committedVerification = readJson<
      ReturnType<typeof createRestartVerification>
    >(`evidence/${evidenceSet}/verification.json`);
    const reportFilename =
      `evidence/${evidenceSet}/standard-native.json`;
    const restartFilename =
      `evidence/${evidenceSet}/restart-proof.json`;
    const report = readJson<RestartReport>(reportFilename);
    const {
      captureMethod: _captureMethod,
      ...beforeRestart
    } = committedRestart.beforeRestart;

    const reconstructedRestart = createRestartEvidence({
      evidenceSet,
      beforeRestart,
      afterRestart: committedRestart.afterRestart,
      report,
      process: {
        durableActivityStartedAtMs: Date.parse(
          committedRestart.processBoundary.firstInvocation
            .durableActivityStartedAt,
        ),
        durableStopRecordedAtMs: Date.parse(
          committedRestart.processBoundary.firstInvocation
            .durableStopRecordedAt,
        ),
        firstDurableRecoveryAtMs: Date.parse(
          committedRestart.processBoundary.secondInvocation
            .firstDurableRecoveryAt,
        ),
        secondCompletedAt:
          committedRestart.processBoundary.secondInvocation.completedAt,
        firstExitSignal:
          committedRestart.processBoundary.firstInvocation.exitSignal,
        secondExitCode:
          committedRestart.processBoundary.secondInvocation.exitCode,
      },
      generatedAt: committedRestart.generatedAt,
    });
    const reconstructedVerification = createRestartVerification({
      evidenceSet,
      report,
      reportSha256: sha256(reportFilename),
      restartSha256: sha256(restartFilename),
      generatedAt: committedVerification.generatedAt,
    });

    assert.deepEqual(reconstructedRestart, committedRestart);
    assert.deepEqual(reconstructedVerification, committedVerification);
  });
}

test("restart evidence sets fail closed", () => {
  assert.throws(
    () => restartEvidenceConfiguration("phase6-c1"),
    /unsupported restart evidence set/u,
  );
});

function readJson<T>(filename: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(root, filename), "utf8"),
  ) as T;
}

function sha256(filename: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(root, filename)))
    .digest("hex");
}
