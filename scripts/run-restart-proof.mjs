#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STOP_TRIGGER = "sompi live proof: live Purchase is failed_recoverable";
const PRIVATE_BOUNDARY_PROFILE =
  "urn:sompi:private-evidence:restart-process-boundary:1";
const options = parseArgs(process.argv.slice(2));
const privateBoundary = path.join(
  options.directory,
  "restart-process-boundary.json",
);
const childEnvironment =
  options.mode === "live"
    ? liveEnvironment(readNodeUrl(options.nodeConfig))
    : undefined;

if (options.mode === "live") {
  assertFreshTarget(options.directory);
  assertAbsent(options.report, "live report");
  assertAbsent(options.restartEvidence, "restart evidence");
  assertAbsent(options.verification, "verification evidence");
} else {
  assertRetainedDirectory(options.directory);
  assertPresent(options.report, "live report");
  assertRegenerationTarget(
    options.restartEvidence,
    "restart evidence",
    options.replaceExisting,
  );
  assertRegenerationTarget(
    options.verification,
    "verification evidence",
    options.replaceExisting,
  );
}
runBuild();
const {
  createRestartEvidence,
  createRestartVerification,
} = await import(
  pathToFileURL(
    path.join(
      root,
      "dist",
      "e2e",
      "restart-proof-evidence.js",
    ),
  ).href
);

if (options.mode === "live") {
  await runLiveProof();
} else {
  regenerateRetainedProof();
}

async function runLiveProof() {
  const first = await runLiveInvocation(true);
  if (!first.stopRequested || first.signal !== "SIGTERM") {
    throw new Error(
      "first live invocation did not stop at recoverable ambiguity",
    );
  }
  const beforeRestart = readPublicSnapshot(
    options.directory,
    "before_restart",
  );
  if (beforeRestart.purchase.state !== "failed_recoverable") {
    throw new Error("pre-restart Purchase is not recoverable");
  }
  const firstBoundary = readFirstInvocationBoundary(
    options.directory,
    beforeRestart.purchase.id,
  );
  const firstProcessBoundary = Object.freeze({
    profile: PRIVATE_BOUNDARY_PROFILE,
    evidenceSet: options.evidenceSet,
    state: "first_stopped",
    firstInvocation: Object.freeze({
      ...firstBoundary,
      exitSignal: first.signal,
    }),
  });
  writeAtomicJson(privateBoundary, firstProcessBoundary);

  const second = await runLiveInvocation(false);
  const secondCompletedAt = new Date().toISOString();
  if (second.code !== 0 || second.signal !== null) {
    throw new Error("second live invocation did not complete");
  }
  const afterRestart = readPublicSnapshot(
    options.directory,
    "after_restart",
  );
  const generatedAt = new Date().toISOString();
  const completedProcessBoundary = Object.freeze({
    ...firstProcessBoundary,
    state: "second_completed",
    secondInvocation: Object.freeze({
      firstDurableRecoveryAtMs: readFirstDurableRecoveryAt(
        options.directory,
        afterRestart.purchase.id,
        firstBoundary.durableStopRecordedAtMs,
      ),
      completedAt: secondCompletedAt,
      exitCode: second.code,
    }),
    publicEvidence: Object.freeze({
      afterRestartCapturedAt: afterRestart.capturedAt,
      generatedAt,
    }),
  });
  writeAtomicJson(privateBoundary, completedProcessBoundary);
  writeEvidenceSet({
    beforeRestart,
    afterRestart,
    report: readJson(options.report),
    process: processFactsFrom(completedProcessBoundary),
    generatedAt,
  });
}

function regenerateRetainedProof() {
  const report = readJson(options.report);
  if (
    typeof report.generatedAt !== "string" ||
    typeof report.purchase?.id !== "string"
  ) {
    throw new Error("retained live report is incomplete");
  }
  const firstBoundary = readFirstInvocationBoundary(
    options.directory,
    report.purchase.id,
  );
  const completedProcessBoundary = readCompletedProcessBoundary(
    firstBoundary,
    report.purchase.id,
  );
  const beforeRestart = readPublicSnapshot(
    options.directory,
    "before_restart",
    firstBoundary.durableStopRecordedAtMs,
  );
  const afterRestart = readPublicSnapshot(
    options.directory,
    "after_restart",
    undefined,
    completedProcessBoundary.publicEvidence.afterRestartCapturedAt,
  );
  writeEvidenceSet({
    beforeRestart,
    afterRestart,
    report,
    process: processFactsFrom(completedProcessBoundary),
    generatedAt: completedProcessBoundary.publicEvidence.generatedAt,
  });
}

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

function writeEvidenceSet(input) {
  const restartEvidence = createRestartEvidence({
    evidenceSet: options.evidenceSet,
    beforeRestart: input.beforeRestart,
    afterRestart: input.afterRestart,
    report: input.report,
    process: input.process,
    generatedAt: input.generatedAt,
  });
  const reportSha256 = sha256File(options.report);
  const restartSha256 = sha256Json(restartEvidence);
  const verification = createRestartVerification({
    evidenceSet: options.evidenceSet,
    report: input.report,
    reportSha256,
    restartSha256,
    generatedAt: input.generatedAt,
  });
  writeAtomicJson(options.restartEvidence, restartEvidence);
  writeAtomicJson(options.verification, verification);
  process.stdout.write(`${JSON.stringify({
    evidenceSet: options.evidenceSet,
    profile: restartEvidence.profile,
    restartEvidence: options.restartEvidence,
    restartSha256,
    verification: options.verification,
    purchaseId: input.afterRestart.purchase.id,
    recoveredEffectIds: restartEvidence.recoveredEffectIds,
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

function readCompletedProcessBoundary(firstBoundary, purchaseId) {
  const record = readPrivateJson(privateBoundary);
  const expectedFirstRecoveryAtMs = readFirstDurableRecoveryAt(
    options.directory,
    purchaseId,
    firstBoundary.durableStopRecordedAtMs,
  );
  if (
    record.profile !== PRIVATE_BOUNDARY_PROFILE ||
    record.evidenceSet !== options.evidenceSet ||
    record.state !== "second_completed" ||
    record.firstInvocation?.durableActivityStartedAtMs !==
      firstBoundary.durableActivityStartedAtMs ||
    record.firstInvocation?.durableStopRecordedAtMs !==
      firstBoundary.durableStopRecordedAtMs ||
    record.firstInvocation?.exitSignal !== "SIGTERM" ||
    record.secondInvocation?.firstDurableRecoveryAtMs !==
      expectedFirstRecoveryAtMs ||
    record.secondInvocation?.exitCode !== 0
  ) {
    throw new Error(
      "private restart process boundary does not match the retained Journal",
    );
  }
  const completedAt = requireIsoTimestamp(
    record.secondInvocation.completedAt,
    "second invocation completion",
  );
  const afterRestartCapturedAt = requireIsoTimestamp(
    record.publicEvidence?.afterRestartCapturedAt,
    "after-restart capture",
  );
  const generatedAt = requireIsoTimestamp(
    record.publicEvidence?.generatedAt,
    "evidence generation",
  );
  if (
    !(
      Date.parse(completedAt) <= Date.parse(afterRestartCapturedAt) &&
      Date.parse(afterRestartCapturedAt) <= Date.parse(generatedAt)
    )
  ) {
    throw new Error(
      "private restart process boundary timestamps are not chronological",
    );
  }
  return Object.freeze({
    ...record,
    secondInvocation: Object.freeze({
      ...record.secondInvocation,
      completedAt,
    }),
    publicEvidence: Object.freeze({
      afterRestartCapturedAt,
      generatedAt,
    }),
  });
}

function processFactsFrom(boundary) {
  return Object.freeze({
    durableActivityStartedAtMs:
      boundary.firstInvocation.durableActivityStartedAtMs,
    durableStopRecordedAtMs:
      boundary.firstInvocation.durableStopRecordedAtMs,
    firstDurableRecoveryAtMs:
      boundary.secondInvocation.firstDurableRecoveryAtMs,
    secondCompletedAt: boundary.secondInvocation.completedAt,
    firstExitSignal: boundary.firstInvocation.exitSignal,
    secondExitCode: boundary.secondInvocation.exitCode,
  });
}

function readPublicSnapshot(directory, stage, cutoffMs, retainedCapturedAt) {
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
    const purchaseState =
      cutoffMs === undefined
        ? purchaseRows[0].state
        : stateAt(
            purchase,
            "purchase_transitions",
            "purchase_id",
            purchaseRows[0].id,
            cutoffMs,
          );
    const directMovements = [
      ...readDirectMovements(bootstrap, cutoffMs),
      ...readDirectMovements(purchase, cutoffMs),
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
      ${cutoffMs === undefined ? "" : "WHERE effects.created_at_ms <= ?"}
      ORDER BY effects.created_at_ms, effects.id
    `).all(...(cutoffMs === undefined ? [] : [cutoffMs]));
    const effectTransition = purchase.prepare(`
      SELECT to_state
      FROM effect_transitions
      WHERE effect_id = ?
      ${cutoffMs === undefined ? "" : "AND created_at_ms <= ?"}
      ORDER BY sequence
    `);
    const effects = effectRows.map((effect) => {
      const transitions = effectTransition
        .all(...(cutoffMs === undefined ? [effect.id] : [effect.id, cutoffMs]))
        .map((transition) => transition.to_state);
      if (transitions.length === 0) {
        throw new Error("restart snapshot Effect has no durable state");
      }
      return Object.freeze({
        id: effect.id,
        kind: effect.kind,
        state:
          cutoffMs === undefined
            ? effect.state
            : transitions.at(-1),
        transactionId: effect.transaction_id,
        transitions: Object.freeze(transitions),
      });
    });
    const paymentAttempts = purchase.prepare(`
      SELECT purchase_id, attempt, identifier, state
      FROM payment_attempts
      ${cutoffMs === undefined ? "" : "WHERE created_at_ms <= ?"}
      ORDER BY purchase_id, attempt
    `).all(...(cutoffMs === undefined ? [] : [cutoffMs]))
      .map((attempt) => Object.freeze({
        purchaseId: attempt.purchase_id,
        attempt: attempt.attempt,
        identifier: attempt.identifier,
        state:
          cutoffMs === undefined
            ? attempt.state
            : paymentAttemptStateAt(
                purchase,
                attempt.purchase_id,
                attempt.attempt,
                cutoffMs,
              ),
      }));
    const settlements = purchase.prepare(`
      SELECT purchase_id, attempt, transaction_id
      FROM purchase_settlements
      ${cutoffMs === undefined ? "" : "WHERE observed_at_ms <= ?"}
      ORDER BY purchase_id, attempt
    `).all(...(cutoffMs === undefined ? [] : [cutoffMs]))
      .map((settlement) => Object.freeze({
        purchaseId: settlement.purchase_id,
        attempt: settlement.attempt,
        transactionId: settlement.transaction_id,
      }));
    const merchantExactTransactionIds =
      cutoffMs === undefined
        ? merchant.prepare(`
            SELECT transaction_id
            FROM exact_payments
            ORDER BY transaction_id
          `).all().map((payment) => payment.transaction_id)
        : settlements.map((settlement) => settlement.transactionId).sort();
    return Object.freeze({
      stage,
      capturedAt:
        cutoffMs === undefined
          ? requireIsoTimestamp(
              retainedCapturedAt ?? new Date().toISOString(),
              "restart snapshot capture",
            )
          : new Date(cutoffMs).toISOString(),
      purchase: Object.freeze({
        id: purchaseRows[0].id,
        state: purchaseState,
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

function readDirectMovements(database, cutoffMs) {
  return database.prepare(`
    SELECT operation_key, kind, state, transaction_id
    FROM treasury_operations
    ${cutoffMs === undefined ? "" : "WHERE created_at_ms <= ?"}
    ORDER BY created_at_ms, operation_key
  `).all(...(cutoffMs === undefined ? [] : [cutoffMs]))
    .map((movement) => Object.freeze({
      kind: movement.kind,
      state:
        cutoffMs === undefined
          ? movement.state
          : stateAt(
              database,
              "treasury_operation_transitions",
              "operation_key",
              movement.operation_key,
              cutoffMs,
            ),
      transactionId: movement.transaction_id,
    }));
}

function stateAt(database, table, identityColumn, identity, cutoffMs) {
  const row = database.prepare(`
    SELECT to_state
    FROM ${table}
    WHERE ${identityColumn} = ?
      AND created_at_ms <= ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(identity, cutoffMs);
  if (typeof row?.to_state !== "string") {
    throw new Error(`restart snapshot has no state in ${table}`);
  }
  return row.to_state;
}

function paymentAttemptStateAt(
  database,
  purchaseId,
  attempt,
  cutoffMs,
) {
  const row = database.prepare(`
    SELECT to_state
    FROM payment_attempt_transitions
    WHERE purchase_id = ?
      AND attempt = ?
      AND created_at_ms <= ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(purchaseId, attempt, cutoffMs);
  if (typeof row?.to_state !== "string") {
    throw new Error("restart snapshot Payment Attempt has no durable state");
  }
  return row.to_state;
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
    throw new Error("restart proof build failed");
  }
}

function liveEnvironment(nodeUrl) {
  const environment = { ...process.env, SOMPI_NODE_URL: nodeUrl };
  delete environment.SOMPI_PRIVATE_KEY;
  return environment;
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

function readPrivateJson(filename) {
  const metadata = fs.lstatSync(filename, { throwIfNoEntry: false });
  const currentUid = process.getuid();
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.uid !== currentUid
  ) {
    throw new Error("private restart process boundary is not owner-only");
  }
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const bytes = fs.readFileSync(descriptor);
    if (bytes.byteLength > 16_384) {
      throw new Error("private restart process boundary is too large");
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function requireIsoTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return value;
}

function sha256File(filename) {
  return createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

function sha256Json(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(value, null, 2)}\n`)
    .digest("hex");
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

function assertRetainedDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw new Error("proof directory must be an absolute canonical path");
  }
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("retained proof directory does not exist");
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

function assertPresent(filename, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) {
    throw new Error(`${label} path must be absolute and canonical`);
  }
  if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} source does not exist`);
  }
}

function assertRegenerationTarget(filename, label, replaceExisting) {
  if (replaceExisting) {
    assertPresent(filename, label);
  } else {
    assertAbsent(filename, label);
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
    values.set(name, value);
  }
  const mode = values.get("--mode");
  const evidenceSet = values.get("--evidence-set");
  if (
    !["live", "retained"].includes(mode) ||
    !["phase4-c7", "phase5-c5"].includes(evidenceSet)
  ) {
    throw new Error(usage());
  }
  const directory = resolvedPath(values, "--directory");
  const report = resolvedPath(values, "--report");
  const restartEvidence = resolvedPath(values, "--restart-evidence");
  const verification = resolvedPath(values, "--verification");
  const commonNames = [
    "--mode",
    "--evidence-set",
    "--directory",
    "--report",
    "--restart-evidence",
    "--verification",
  ];
  const modeNames =
    mode === "live"
      ? ["--source-wallet", "--node-config"]
      : ["--replace-existing"];
  if (
    values.size !== commonNames.length + modeNames.length ||
    [...commonNames, ...modeNames].some((name) => !values.has(name))
  ) {
    throw new Error(usage());
  }
  const sourceWalletDirectory =
    mode === "live"
      ? resolvedPath(values, "--source-wallet")
      : undefined;
  const nodeConfig =
    mode === "live"
      ? resolvedPath(values, "--node-config")
      : undefined;
  const replaceExisting =
    mode === "retained"
      ? parseBoolean(values.get("--replace-existing"))
      : false;
  if (
    (sourceWalletDirectory !== undefined &&
      (directory === sourceWalletDirectory ||
        directory.startsWith(`${sourceWalletDirectory}${path.sep}`))) ||
    report.startsWith(`${directory}${path.sep}`) ||
    restartEvidence.startsWith(`${directory}${path.sep}`) ||
    verification.startsWith(`${directory}${path.sep}`) ||
    new Set([report, restartEvidence, verification]).size !== 3
  ) {
    throw new Error(
      "proof, source-wallet, and public evidence paths must be disjoint",
    );
  }
  if (
    path.basename(report) !== "standard-native.json" ||
    path.basename(restartEvidence) !== "restart-proof.json" ||
    path.basename(verification) !== "verification.json" ||
    new Set([
      path.dirname(report),
      path.dirname(restartEvidence),
      path.dirname(verification),
    ]).size !== 1
  ) {
    throw new Error(
      "public evidence must use one directory and the canonical filenames",
    );
  }
  return Object.freeze({
    mode,
    evidenceSet,
    directory,
    sourceWalletDirectory,
    report,
    restartEvidence,
    verification,
    nodeConfig,
    replaceExisting,
  });
}

function resolvedPath(values, name) {
  const value = values.get(name);
  if (value === undefined) throw new Error(usage());
  return path.resolve(value);
}

function parseBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(usage());
}

function usage() {
  return "usage: run-restart-proof --mode live --evidence-set phase4-c7|phase5-c5 " +
    "--directory PATH --source-wallet PATH --report PATH --restart-evidence PATH " +
    "--verification PATH --node-config PRIVATE_RUN_CONFIG; or --mode retained " +
    "--evidence-set phase4-c7|phase5-c5 --directory PATH --report PATH " +
    "--restart-evidence PATH --verification PATH --replace-existing true|false";
}
