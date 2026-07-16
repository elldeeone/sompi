#!/usr/bin/env node
import * as path from "node:path";

import type { JournalFaultPoint } from "./purchase/journal.js";
import {
  runLocalTestnetProof,
  writeLocalTestnetProofReport,
} from "./e2e/local-testnet-proof.js";

const ALLOWED_FAULT_POINTS = new Set<JournalFaultPoint>([
  "treasury_staging_plan.after_insert",
  "payment_preparation.after_insert",
  "settlement.after_insert",
  "fulfilment.after_insert",
  "receipt.after_insert",
]);

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const report = await runLocalTestnetProof({
    ...(parsed.faultPoint ? { faultPoint: parsed.faultPoint } : {}),
    ...(parsed.stagingVisibilityRestart
      ? { stagingVisibleOnSubmit: false }
      : {}),
  });
  writeLocalTestnetProofReport(parsed.output, report);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidenceReport: parsed.output,
    chainMode: report.chainMode,
    liveNetworkConformanceClaimed: report.liveNetworkConformanceClaimed,
    purchaseId: report.purchase.id,
    state: report.purchase.state,
    stagingTransactionId: report.transactions.stagingTransactionId,
    exactTransactionId: report.transactions.exactTransactionId,
    restartCount: report.recovery.restartCount,
  })}\n`);
}

function parseArguments(args: readonly string[]): {
  output: string;
  faultPoint?: JournalFaultPoint;
  stagingVisibilityRestart: boolean;
} {
  let output = path.resolve(process.cwd(), "evidence", "local-testnet-proof.json");
  let faultPoint: JournalFaultPoint | undefined;
  let stagingVisibilityRestart = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--output") {
      const value = args[++index];
      if (!value) throw new Error("--output requires a filename");
      output = path.resolve(value);
      continue;
    }
    if (argument === "--fault-point") {
      const value = args[++index] as JournalFaultPoint | undefined;
      if (!value || !ALLOWED_FAULT_POINTS.has(value)) {
        throw new Error("--fault-point is not a supported deterministic crash point");
      }
      faultPoint = value;
      continue;
    }
    if (argument === "--staging-visibility-restart") {
      stagingVisibilityRestart = true;
      continue;
    }
    throw new Error(`unknown E2E argument ${argument}`);
  }
  if (faultPoint && stagingVisibilityRestart) {
    throw new Error("select one deterministic restart scenario per evidence report");
  }
  return { output, faultPoint, stagingVisibilityRestart };
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: "local E2E proof failed safely; inspect the local test configuration",
  })}\n`);
  process.exitCode = 1;
});
