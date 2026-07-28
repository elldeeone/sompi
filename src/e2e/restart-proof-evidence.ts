const NETWORK = "kaspa:testnet-10";
const EXACT_PROFILE = "standard-native";
const RECONSTRUCTION = "durable-journal-transition-prefix";

export type RestartEvidenceSet = "phase4-c7" | "phase5-c5";

interface RestartEvidenceConfiguration {
  readonly restartProfile: string;
  readonly verificationProfile: string;
  readonly phaseBase?: string;
  readonly assertions?: Readonly<Record<string, true>>;
}

const CONFIGURATIONS: Readonly<
  Record<RestartEvidenceSet, RestartEvidenceConfiguration>
> = Object.freeze({
  "phase4-c7": Object.freeze({
    restartProfile: "urn:sompi:evidence:phase4-c7-restart-proof:1",
    verificationProfile: "urn:sompi:evidence:phase4-c7:2",
  }),
  "phase5-c5": Object.freeze({
    restartProfile: "urn:sompi:evidence:phase5-c5-restart-proof:1",
    verificationProfile: "urn:sompi:evidence:phase5-c5:1",
    phaseBase: "a258727aca0e735fe5ca97253c20abe9eb6a742f",
    assertions: Object.freeze({
      samePurchaseAcrossRestart: true,
      sameStagingEffectAcrossRestart: true,
      sameStagingTransactionAcrossRestart: true,
      onePaymentEffect: true,
      oneMerchantExactTransaction: true,
    }),
  }),
});

export interface RestartMovement {
  readonly kind: string;
  readonly state: string;
  readonly transactionId: string;
}

export interface RestartEffect {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly transactionId: string | null;
  readonly transitions: readonly string[];
}

export interface RestartPaymentAttempt {
  readonly purchaseId: string;
  readonly attempt: number;
  readonly identifier: string;
  readonly state: string;
}

export interface RestartSettlement {
  readonly purchaseId: string;
  readonly attempt: number;
  readonly transactionId: string;
}

export interface RestartSnapshot {
  readonly stage: "before_restart" | "after_restart";
  readonly capturedAt: string;
  readonly purchase: {
    readonly id: string;
    readonly state: string;
  };
  readonly directMovements: readonly RestartMovement[];
  readonly effects: readonly RestartEffect[];
  readonly paymentAttempts: readonly RestartPaymentAttempt[];
  readonly settlements: readonly RestartSettlement[];
  readonly merchantExactTransactionIds: readonly string[];
}

export interface RestartReport {
  readonly network?: string;
  readonly purchase?: {
    readonly id?: string;
    readonly state?: string;
  };
  readonly transactions?: {
    readonly exactTransactionId?: string;
  };
}

export interface RestartProcessFacts {
  readonly durableActivityStartedAtMs: number;
  readonly durableStopRecordedAtMs: number;
  readonly firstDurableRecoveryAtMs: number;
  readonly secondCompletedAt: string;
  readonly firstExitSignal: "SIGTERM";
  readonly secondExitCode: 0;
}

export function restartEvidenceConfiguration(
  evidenceSet: string,
): RestartEvidenceConfiguration {
  const configuration =
    CONFIGURATIONS[evidenceSet as RestartEvidenceSet];
  if (configuration === undefined) {
    throw new Error(`unsupported restart evidence set: ${evidenceSet}`);
  }
  return configuration;
}

export function createRestartEvidence(input: {
  readonly evidenceSet: string;
  readonly beforeRestart: RestartSnapshot;
  readonly afterRestart: RestartSnapshot;
  readonly report: RestartReport;
  readonly process: RestartProcessFacts;
  readonly generatedAt?: string;
}) {
  const configuration = restartEvidenceConfiguration(input.evidenceSet);
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
    profile: configuration.restartProfile,
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

export function createRestartVerification(input: {
  readonly evidenceSet: string;
  readonly report: RestartReport;
  readonly reportSha256: string;
  readonly restartSha256: string;
  readonly generatedAt?: string;
}) {
  const configuration = restartEvidenceConfiguration(input.evidenceSet);
  if (
    input.report.network !== NETWORK ||
    typeof input.report.purchase?.id !== "string" ||
    input.report.purchase?.state !== "receipted"
  ) {
    throw new Error("restart verification report is invalid");
  }
  requireSha256(input.reportSha256, "standard report");
  requireSha256(input.restartSha256, "restart proof");
  return Object.freeze({
    profile: configuration.verificationProfile,
    generatedAt: requireIsoTimestamp(
      input.generatedAt ?? new Date().toISOString(),
      "restart verification generation",
    ),
    network: NETWORK,
    ...(configuration.phaseBase === undefined
      ? {}
      : { phaseBase: configuration.phaseBase }),
    purchaseId: input.report.purchase.id,
    purchaseState: input.report.purchase.state,
    artifacts: Object.freeze({
      standardReport: Object.freeze({
        filename: "standard-native.json",
        sha256: input.reportSha256,
      }),
      restartProof: Object.freeze({
        filename: "restart-proof.json",
        sha256: input.restartSha256,
      }),
    }),
    ...(configuration.assertions === undefined
      ? {}
      : { assertions: configuration.assertions }),
    privateMaterialIncluded: false,
  });
}

function processBoundaryFrom(process: RestartProcessFacts) {
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
    RestartSnapshot & { readonly captureMethod: string }
  >,
  after: RestartSnapshot,
  report: RestartReport,
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

function requireSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
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
