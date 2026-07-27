#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STOP_TRIGGER = "sompi live proof: live Purchase is failed_recoverable";
const PROFILE = "urn:sompi:evidence:phase4-c7-restart-proof:1";
const options = parseArgs(process.argv.slice(2));
const nodeUrl = readNodeUrl(options.nodeConfig);
const childEnvironment = { ...process.env, SOMPI_NODE_URL: nodeUrl };
delete childEnvironment.SOMPI_PRIVATE_KEY;

assertFreshTarget(options.directory);
assertAbsent(options.report, "live report");
assertAbsent(options.restartEvidence, "restart evidence");
runBuild();
const { createPhase4RestartEvidence } = await import(
  pathToFileURL(
    path.join(
      root,
      "dist",
      "e2e",
      "phase4-c7-restart-evidence.js",
    ),
  ).href
);

const first = await runLiveInvocation(true);
if (!first.stopRequested || first.signal !== "SIGTERM") {
  throw new Error("first live invocation did not stop at recoverable ambiguity");
}
const beforeRestart = readPublicSnapshot(options.directory, "before_restart");
if (beforeRestart.purchase.state !== "failed_recoverable") {
  throw new Error("pre-restart Purchase is not recoverable");
}
const firstBoundary = readFirstInvocationBoundary(
  options.directory,
  beforeRestart.purchase.id,
);

const second = await runLiveInvocation(false);
const secondCompletedAt = new Date().toISOString();
if (second.code !== 0 || second.signal !== null) {
  throw new Error("second live invocation did not complete");
}
const afterRestart = readPublicSnapshot(options.directory, "after_restart");
const report = readJson(options.report);
writeRestartEvidence({
  beforeRestart,
  afterRestart,
  report,
  process: Object.freeze({
    ...firstBoundary,
    firstDurableRecoveryAtMs: readFirstDurableRecoveryAt(
      options.directory,
      afterRestart.purchase.id,
      firstBoundary.durableStopRecordedAtMs,
    ),
    secondCompletedAt,
    firstExitSignal: first.signal,
    secondExitCode: second.code,
  }),
});

function runLiveInvocation(stopAtRecoverable) {
  const args = [
    path.join(root, "dist", "e2e", "live-testnet-main.js"),
    "--directory",
    options.directory,
    "--source-wallet",
    options.sourceWalletDirectory,
    "--report",
    options.report,
    "--profile",
    "standard-native",
    "--ingress",
    "http-api",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stopRequested = false;
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      stderr = `${stderr}${text}`.slice(-16_384);
      if (stopAtRecoverable && !stopRequested && stderr.includes(STOP_TRIGGER)) {
        stopRequested = child.kill("SIGTERM");
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (stopAtRecoverable && !stopRequested) {
        reject(new Error("first live invocation ended before recoverable ambiguity"));
        return;
      }
      resolve(Object.freeze({ code, signal, stopRequested }));
    });
  });
}

function writeRestartEvidence(input) {
  const evidence = createPhase4RestartEvidence({
    beforeRestart: input.beforeRestart,
    afterRestart: input.afterRestart,
    report: input.report,
    process: input.process,
  });
  writeAtomicJson(options.restartEvidence, evidence);
  process.stdout.write(`${JSON.stringify({
    profile: PROFILE,
    restartEvidence: options.restartEvidence,
    purchaseId: input.afterRestart.purchase.id,
    recoveredEffectIds: evidence.recoveredEffectIds,
    exactTransactionId: input.afterRestart.merchantExactTransactionIds[0],
  }, null, 2)}\n`);
}

function readFirstInvocationBoundary(directory, purchaseId) {
  const purchase = openReadOnly(
    path.join(directory, "purchase", "journal.sqlite"),
  );
  try {
    const row = purchase.prepare(`
      SELECT
        MIN(created_at_ms) AS durable_activity_started_at_ms,
        MAX(
          CASE
            WHEN to_state = 'failed_recoverable'
             AND reason_code = 'treasury_staging_requires_reconciliation'
            THEN created_at_ms
          END
        ) AS durable_stop_recorded_at_ms
      FROM purchase_transitions
      WHERE purchase_id = ?
    `).get(purchaseId);
    const durableActivityStartedAtMs =
      row?.durable_activity_started_at_ms;
    const durableStopRecordedAtMs =
      row?.durable_stop_recorded_at_ms;
    if (
      !Number.isSafeInteger(durableActivityStartedAtMs) ||
      !Number.isSafeInteger(durableStopRecordedAtMs) ||
      durableActivityStartedAtMs > durableStopRecordedAtMs
    ) {
      throw new Error(
        "first invocation has no valid durable Purchase boundary",
      );
    }
    return Object.freeze({
      durableActivityStartedAtMs,
      durableStopRecordedAtMs,
    });
  } finally {
    purchase.close();
  }
}

function readFirstDurableRecoveryAt(
  directory,
  purchaseId,
  durableStopRecordedAtMs,
) {
  const purchase = openReadOnly(
    path.join(directory, "purchase", "journal.sqlite"),
  );
  try {
    const row = purchase.prepare(`
      SELECT MIN(effect_transitions.created_at_ms) AS first_recovery_at_ms
      FROM effect_transitions
      JOIN effects
        ON effects.id = effect_transitions.effect_id
      WHERE effects.purchase_id = ?
        AND effect_transitions.created_at_ms > ?
    `).get(purchaseId, durableStopRecordedAtMs);
    if (!Number.isSafeInteger(row?.first_recovery_at_ms)) {
      throw new Error(
        "second invocation has no durable recovery transition",
      );
    }
    return row.first_recovery_at_ms;
  } finally {
    purchase.close();
  }
}

function readPublicSnapshot(directory, stage) {
  const bootstrap = openReadOnly(path.join(directory, "bootstrap", "journal.sqlite"));
  const purchase = openReadOnly(path.join(directory, "purchase", "journal.sqlite"));
  const merchant = openReadOnly(path.join(directory, "merchant", "exact.sqlite"));
  try {
    const purchaseRows = purchase.prepare(
      "SELECT id, state FROM purchases ORDER BY created_at_ms"
    ).all();
    if (purchaseRows.length !== 1) {
      throw new Error("restart snapshot requires exactly one Purchase");
    }
    const directMovements = [
      ...readDirectMovements(bootstrap),
      ...readDirectMovements(purchase),
    ];
    const effectRows = purchase.prepare(`
      SELECT
        effects.id,
        effects.kind,
        effects.state,
        COALESCE(
          treasury_staging_plans.planned_transaction_id,
          payment_preparations.transaction_id
        ) AS transaction_id
      FROM effects
      LEFT JOIN treasury_staging_plans
        ON treasury_staging_plans.effect_id = effects.id
      LEFT JOIN payment_preparations
        ON payment_preparations.purchase_id = effects.purchase_id
       AND payment_preparations.attempt = effects.attempt
      ORDER BY effects.created_at_ms, effects.id
    `).all();
    const effectTransition = purchase.prepare(`
      SELECT to_state
      FROM effect_transitions
      WHERE effect_id = ?
      ORDER BY sequence
    `);
    const effects = effectRows.map((effect) => Object.freeze({
      id: effect.id,
      kind: effect.kind,
      state: effect.state,
      transactionId: effect.transaction_id,
      transitions: Object.freeze(
        effectTransition.all(effect.id).map((transition) => transition.to_state)
      ),
    }));
    const paymentAttempts = purchase.prepare(`
      SELECT purchase_id, attempt, identifier, state
      FROM payment_attempts
      ORDER BY purchase_id, attempt
    `).all().map((attempt) => Object.freeze({
      purchaseId: attempt.purchase_id,
      attempt: attempt.attempt,
      identifier: attempt.identifier,
      state: attempt.state,
    }));
    const settlements = purchase.prepare(`
      SELECT purchase_id, attempt, transaction_id
      FROM purchase_settlements
      ORDER BY purchase_id, attempt
    `).all().map((settlement) => Object.freeze({
      purchaseId: settlement.purchase_id,
      attempt: settlement.attempt,
      transactionId: settlement.transaction_id,
    }));
    const merchantExactTransactionIds = merchant.prepare(`
      SELECT transaction_id
      FROM exact_payments
      ORDER BY transaction_id
    `).all().map((payment) => payment.transaction_id);
    return Object.freeze({
      stage,
      capturedAt: new Date().toISOString(),
      purchase: Object.freeze({
        id: purchaseRows[0].id,
        state: purchaseRows[0].state,
      }),
      directMovements: Object.freeze(directMovements),
      effects: Object.freeze(effects),
      paymentAttempts: Object.freeze(paymentAttempts),
      settlements: Object.freeze(settlements),
      merchantExactTransactionIds: Object.freeze(merchantExactTransactionIds),
    });
  } finally {
    merchant.close();
    purchase.close();
    bootstrap.close();
  }
}

function readDirectMovements(database) {
  return database.prepare(`
    SELECT kind, state, transaction_id
    FROM treasury_operations
    ORDER BY created_at_ms, operation_key
  `).all().map((movement) => Object.freeze({
    kind: movement.kind,
    state: movement.state,
    transactionId: movement.transaction_id,
  }));
}

function openReadOnly(filename) {
  return new Database(filename, {
    readonly: true,
    fileMustExist: true,
  });
}

function runBuild() {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("Phase 4 C7 restart proof build failed");
  }
}

function readNodeUrl(filename) {
  const value = readJson(filename)?.nodeUrl;
  if (typeof value !== "string" || !/^wss?:\/\/[^@\s]+$/u.test(value)) {
    throw new Error("private node configuration does not contain a safe node URL");
  }
  return value;
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function writeAtomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, filename);
}

function assertFreshTarget(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw new Error("proof directory must be an absolute canonical path");
  }
  if (fs.existsSync(directory) && fs.readdirSync(directory).length !== 0) {
    throw new Error("proof directory must be fresh");
  }
}

function assertAbsent(filename, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) {
    throw new Error(`${label} path must be absolute and canonical`);
  }
  if (fs.existsSync(filename)) {
    throw new Error(`${label} target already exists`);
  }
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(usage());
    }
    if (values.has(name)) throw new Error(usage());
    values.set(name, path.resolve(value));
  }
  const directory = values.get("--directory");
  const sourceWalletDirectory = values.get("--source-wallet");
  const report = values.get("--report");
  const restartEvidence = values.get("--restart-evidence");
  const nodeConfig = values.get("--node-config");
  if (
    values.size !== 5 ||
    !directory ||
    !sourceWalletDirectory ||
    !report ||
    !restartEvidence ||
    !nodeConfig
  ) {
    throw new Error(usage());
  }
  if (
    directory === sourceWalletDirectory ||
    directory.startsWith(`${sourceWalletDirectory}${path.sep}`) ||
    report.startsWith(`${directory}${path.sep}`) ||
    restartEvidence.startsWith(`${directory}${path.sep}`)
  ) {
    throw new Error("proof, source-wallet, and public evidence paths must be disjoint");
  }
  return Object.freeze({
    directory,
    sourceWalletDirectory,
    report,
    restartEvidence,
    nodeConfig,
  });
}

function usage() {
  return "usage: run-phase4-c7-restart-proof --directory PATH --source-wallet PATH " +
    "--report PATH --restart-evidence PATH --node-config PRIVATE_RUN_CONFIG";
}
