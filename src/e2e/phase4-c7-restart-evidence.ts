const PROFILE = "urn:sompi:evidence:phase4-c7-restart-proof:1";
const NETWORK = "kaspa:testnet-10";
const EXACT_PROFILE = "standard-native";
const RECONSTRUCTION = "durable-journal-transition-prefix";

export interface Phase4RestartMovement {
  readonly kind: string;
  readonly state: string;
  readonly transactionId: string;
}

export interface Phase4RestartEffect {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly transactionId: string | null;
  readonly transitions: readonly string[];
}

export interface Phase4RestartPaymentAttempt {
  readonly purchaseId: string;
  readonly attempt: number;
  readonly identifier: string;
  readonly state: string;
}

export interface Phase4RestartSettlement {
  readonly purchaseId: string;
  readonly attempt: number;
  readonly transactionId: string;
}

export interface Phase4RestartSnapshot {
  readonly stage: "before_restart" | "after_restart";
  readonly capturedAt: string;
  readonly purchase: {
    readonly id: string;
    readonly state: string;
  };
  readonly directMovements: readonly Phase4RestartMovement[];
  readonly effects: readonly Phase4RestartEffect[];
  readonly paymentAttempts: readonly Phase4RestartPaymentAttempt[];
  readonly settlements: readonly Phase4RestartSettlement[];
  readonly merchantExactTransactionIds: readonly string[];
}

export interface Phase4RestartReport {
  readonly purchase?: {
    readonly id?: string;
    readonly state?: string;
  };
  readonly transactions?: {
    readonly exactTransactionId?: string;
  };
}

export interface Phase4RestartProcessFacts {
  readonly durableActivityStartedAtMs: number;
  readonly durableStopRecordedAtMs: number;
  readonly firstDurableRecoveryAtMs: number;
  readonly secondCompletedAt: string;
  readonly firstExitSignal: "SIGTERM";
  readonly secondExitCode: 0;
}

export function createPhase4RestartEvidence(input: {
  readonly beforeRestart: Phase4RestartSnapshot;
  readonly afterRestart: Phase4RestartSnapshot;
  readonly report: Phase4RestartReport;
  readonly process: Phase4RestartProcessFacts;
  readonly generatedAt?: string;
}) {
  const processBoundary = processBoundaryFrom(input.process);
  const beforeRestart = Object.freeze({
    ...input.beforeRestart,
    capturedAt:
      processBoundary.firstInvocation.durableStopRecordedAt,
    captureMethod: RECONSTRUCTION,
  });
  const recoveredEffectIds = verifyRestart(
    beforeRestart,
    input.afterRestart,
    input.report,
  );
  return Object.freeze({
    profile: PROFILE,
    generatedAt: requireIsoTimestamp(
      input.generatedAt ?? new Date().toISOString(),
      "restart evidence generation",
    ),
    network: NETWORK,
    exactProfile: EXACT_PROFILE,
    processBoundary,
    recoveredEffectIds: Object.freeze(recoveredEffectIds),
    beforeRestart,
    afterRestart: input.afterRestart,
  });
}

function processBoundaryFrom(process: Phase4RestartProcessFacts) {
  const durableActivityStartedAt = isoFromMilliseconds(
    process.durableActivityStartedAtMs,
    "first durable activity",
  );
  const durableStopRecordedAt = isoFromMilliseconds(
    process.durableStopRecordedAtMs,
    "durable stop",
  );
  const firstDurableRecoveryAt = isoFromMilliseconds(
    process.firstDurableRecoveryAtMs,
    "first durable recovery",
  );
  const completedAt = requireIsoTimestamp(
    process.secondCompletedAt,
    "second invocation completion",
  );
  const timestamps = [
    Date.parse(durableActivityStartedAt),
    Date.parse(durableStopRecordedAt),
    Date.parse(firstDurableRecoveryAt),
    Date.parse(completedAt),
  ];
  if (
    !(
      timestamps[0] <= timestamps[1] &&
      timestamps[1] < timestamps[2] &&
      timestamps[2] <= timestamps[3]
    )
  ) {
    throw new Error("restart process boundary is not chronological");
  }
  return Object.freeze({
    firstInvocation: Object.freeze({
      sequence: 1,
      durableActivityStartedAt,
      durableStopRecordedAt,
      stopTrigger: "purchase-failed-recoverable",
      exitSignal: process.firstExitSignal,
    }),
    secondInvocation: Object.freeze({
      sequence: 2,
      firstDurableRecoveryAt,
      completedAt,
      exitCode: process.secondExitCode,
    }),
    reconstruction: RECONSTRUCTION,
  });
}

function verifyRestart(
  before: Readonly<
    Phase4RestartSnapshot & { readonly captureMethod: string }
  >,
  after: Phase4RestartSnapshot,
  report: Phase4RestartReport,
): string[] {
  if (
    before.stage !== "before_restart" ||
    before.captureMethod !== RECONSTRUCTION ||
    after.stage !== "after_restart" ||
    before.purchase.id !== after.purchase.id ||
    before.purchase.state !== "failed_recoverable" ||
    after.purchase.state !== "receipted" ||
    report.purchase?.id !== after.purchase.id ||
    report.purchase?.state !== after.purchase.state
  ) {
    throw new Error("restart Purchase identity or lifecycle is invalid");
  }
  if (
    before.directMovements.length !== 3 ||
    before.directMovements.some(
      (movement) =>
        movement.state !== "completed" ||
        !isTransactionId(movement.transactionId),
    ) ||
    JSON.stringify(before.directMovements) !==
      JSON.stringify(after.directMovements)
  ) {
    throw new Error("restart changed a completed direct Movement");
  }
  assertUnique(
    before.effects.map((effect) => effect.id),
    "pre-restart Effect",
  );
  assertUnique(
    after.effects.map((effect) => effect.id),
    "post-restart Effect",
  );
  const afterEffects = new Map(
    after.effects.map((effect) => [effect.id, effect]),
  );
  const recoverableEffects = before.effects.filter(
    (effect) =>
      effect.state === "submitted" || effect.state === "ambiguous",
  );
  if (recoverableEffects.length === 0) {
    throw new Error(
      "pre-restart snapshot has no submitted or ambiguous Effect",
    );
  }
  for (const effect of recoverableEffects) {
    const recovered = afterEffects.get(effect.id);
    if (
      !isTransactionId(effect.transactionId) ||
      recovered?.state !== "observed" ||
      recovered.transactionId !== effect.transactionId
    ) {
      throw new Error(
        "restart did not observe the same ambiguous Effect",
      );
    }
  }
  if (
    after.effects.length !== 2 ||
    after.paymentAttempts.length !== 1 ||
    after.settlements.length !== 1 ||
    after.merchantExactTransactionIds.length !== 1 ||
    after.settlements[0].transactionId !==
      after.merchantExactTransactionIds[0] ||
    after.settlements[0].transactionId !==
      report.transactions?.exactTransactionId
  ) {
    throw new Error("post-restart payment evidence is incomplete");
  }
  assertUnique(
    after.effects
      .map((effect) => effect.transactionId)
      .filter(isTransactionId),
    "post-restart Effect transaction",
  );
  assertUnique(
    after.merchantExactTransactionIds,
    "Merchant exact transaction",
  );
  return recoverableEffects.map((effect) => effect.id).sort();
}

function isoFromMilliseconds(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return new Date(value).toISOString();
}

function requireIsoTimestamp(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return value;
}

function isTransactionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{64}$/.test(value)
  );
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} identity is duplicated`);
  }
}
