import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_ROOT = path.join(ROOT, "src");

test("Purchase uses the Treasury interface and not Treasury Journal commands", () => {
  const coordinator = fs.readFileSync(
    path.join(SOURCE_ROOT, "purchase", "coordinator.ts"),
    "utf8",
  );
  assert.match(
    coordinator,
    /import type \{ TreasuryModule \} from "\.\.\/treasury\/module\.js";/,
  );
  assert.doesNotMatch(coordinator, /export interface TreasuryModule/);
  assert.doesNotMatch(
    coordinator,
    /this\.journal\.(?:expireReservations|findTreasuryStaging|treasuryStaging|planTreasuryStaging|commitTreasuryStaging|beginTreasuryStaging|recordObservedTreasuryStaging|recordTreasuryStagingRecovery|abandonExpiredTreasuryStaging)/,
  );
});

test("the C6 compatibility types and unfenced staging planner do not exist", () => {
  const production = sourceFiles(SOURCE_ROOT)
    .filter((filename) => !filename.endsWith(".test.ts"))
    .map((filename) => fs.readFileSync(filename, "utf8"))
    .join("\n");
  const journal = fs.readFileSync(
    path.join(SOURCE_ROOT, "purchase", "journal.ts"),
    "utf8",
  );

  assert.doesNotMatch(
    production,
    /\b(?:PurchaseTreasuryCapacity|PurchaseTreasuryStagingPreparation|PurchaseTreasuryStagingExecution|PurchaseTreasuryStagingRecovery)\b/,
  );
  assert.doesNotMatch(
    journal,
    /export type \{\s*PlanTreasuryStagingInput/,
  );
  assert.doesNotMatch(journal, /\bplanTreasuryStaging\s*\(/);
});

test("runtime constructs one Treasury implementation for every current caller", () => {
  const runtime = fs.readFileSync(
    path.join(SOURCE_ROOT, "runtime", "purchase-runtime.ts"),
    "utf8",
  );
  const production = sourceFiles(SOURCE_ROOT)
    .filter((filename) => !filename.endsWith(".test.ts"))
    .map((filename) => fs.readFileSync(filename, "utf8"))
    .join("\n");

  assert.equal(
    runtime.match(/new TreasuryOperationModule\s*\(/g)?.length,
    1,
  );
  assert.match(
    runtime,
    /new KaspaX402BatchCapitalModule\(\s*journal,\s*treasuryOperations,/,
  );
  assert.match(
    runtime,
    /new KaspaX402BatchRefundModule\(\s*journal,\s*treasuryOperations,/,
  );
  assert.equal(
    runtime.match(/treasury:\s*treasuryOperations/g)?.length,
    3,
  );
  assert.match(
    runtime,
    /new PurchaseCoordinator\(\s*journal,\s*egress,\s*checkout,\s*authority,\s*treasuryOperations,/,
  );
  assert.doesNotMatch(production, /\bVaultTreasuryModule\b/);
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(filename));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(filename);
  }
  return files;
}
