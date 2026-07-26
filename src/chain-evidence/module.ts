import { createHash } from "node:crypto";

import {
  CHAIN_EVIDENCE_OPERATOR_PROFILE,
  CHAIN_EVIDENCE_PROFILE,
  CHAIN_EVIDENCE_OPERATIONS,
  CHAIN_EVIDENCE_WITNESS_PROFILE,
  chainEvidenceEffectiveFloor,
  type AcceptedChainEvidenceRecord,
  type ChainEvidenceFinalityPolicy,
  type ChainEvidenceFinalitySelection,
  type ChainEvidenceObservation,
  type ChainEvidenceOperation,
  type ChainEvidenceRecord,
  type ChainEvidenceRequest,
  type ChainEvidenceStore,
  type ChainSourceAcceptedEvidence,
  type ChainSourceEvidence,
  type FinalityFloor,
  type IndependentChainWitness,
  type OperatorChainObserver,
  type ProtocolFinality,
} from "./types.js";

const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
export const ABSENCE_PROPAGATION_INTERVAL_MS = 1_000;
const ABSENCE_RETENTION_MS = 30_000;
const MAX_TRACKED_ABSENCES = 1_024;

interface AbsenceObservationWindow {
  readonly firstSeenAtMs: number;
  lastSeenAtMs: number;
}

export class ChainEvidenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainEvidenceError";
  }
}

export class ChainEvidenceModule {
  private readonly absenceWindows = new Map<string, AbsenceObservationWindow>();
  private readonly finalityPolicy: ChainEvidenceFinalityPolicy;
  private readonly depthConfirmationDaa: string;

  constructor(
    private readonly primary: OperatorChainObserver,
    private readonly witness: IndependentChainWitness,
    private readonly store: ChainEvidenceStore,
    finalityPolicy: ChainEvidenceFinalityPolicy,
    private readonly now: () => number = Date.now
  ) {
    if (typeof primary?.observe !== "function" || typeof witness?.observe !== "function") {
      throw new ChainEvidenceError("both independent Chain Evidence sources are required");
    }
    if (typeof store?.findRetained !== "function" || typeof store?.record !== "function") {
      throw new ChainEvidenceError("durable Chain Evidence store is required");
    }
    this.finalityPolicy = readFinalityPolicy(finalityPolicy);
    const primaryDepth = readDepthConfirmationDaa(
      primary.depthConfirmationDaa,
      "operator"
    );
    const witnessDepth = readDepthConfirmationDaa(
      witness.depthConfirmationDaa,
      "witness"
    );
    if (primaryDepth !== witnessDepth) {
      throw new ChainEvidenceError(
        "Chain Evidence sources use different depth-confirmation DAA values"
      );
    }
    this.depthConfirmationDaa = primaryDepth;
    readTime(now());
  }

  selectFinality(
    operation: ChainEvidenceOperation,
    protocolFinality: ProtocolFinality
  ): ChainEvidenceFinalitySelection {
    if (
      !CHAIN_EVIDENCE_OPERATIONS.includes(operation) ||
      !["mempool", "accepted", "confirmed"].includes(protocolFinality)
    ) {
      throw new ChainEvidenceError("Chain Evidence finality request is invalid");
    }
    const operatorFloor = this.finalityPolicy[operation];
    return Object.freeze({
      operation,
      protocolFinality,
      operatorFloor,
      effectiveFloor: chainEvidenceEffectiveFloor(protocolFinality, operatorFloor),
      depthConfirmationDaa: this.depthConfirmationDaa,
    });
  }

  async observe(request: Readonly<ChainEvidenceRequest>): Promise<ChainEvidenceObservation> {
    validateRequest(request);
    request.signal.throwIfAborted();
    const finality = this.selectFinality(request.operation, request.protocolFinality);
    const expectedOutputsDigest = outputsDigest(request);
    const retained = this.store.findRetained({
      profile: CHAIN_EVIDENCE_PROFILE,
      operationId: request.operationId,
      operation: request.operation,
      transactionId: request.transactionId,
      outputsDigest: expectedOutputsDigest,
      mechanism: request.mechanism,
      protocolFinality: finality.protocolFinality,
      operatorFloor: finality.operatorFloor,
      effectiveFloor: finality.effectiveFloor,
    });
    for (const candidate of retained) {
      const rederived = rederiveRetainedEvidence(candidate, finality);
      const evidence = rederived.persist
        ? this.store.record(rederived.evidence)
        : rederived.evidence;
      const historical = interpret(evidence, finality, request);
      if (historical.interpretation === "accepted") return historical;
    }

    const witness = await this.safeWitness(request);
    request.signal.throwIfAborted();
    const primary = await this.safePrimary(request, witness);
    request.signal.throwIfAborted();
    const observedAt = readTime(this.now());
    this.pruneAbsenceWindows(observedAt);
    let record = merge(request, primary, witness, finality, observedAt);
    if (record.status === "absent") {
      const key = `${request.operation}:${request.transactionId}:${expectedOutputsDigest}`;
      const window = this.absenceWindows.get(key);
      if (
        window === undefined ||
        observedAt - window.firstSeenAtMs < ABSENCE_PROPAGATION_INTERVAL_MS
      ) {
        if (window === undefined) {
          this.trackAbsence(key, observedAt);
        } else {
          window.lastSeenAtMs = observedAt;
        }
        record = Object.freeze({
          ...record,
          status: "unknown",
          detailDigest: digest({
            prior: record.detailDigest,
            result: "absence-propagation-interval-pending",
            firstSeenAtMs: window?.firstSeenAtMs ?? observedAt,
          }),
        });
      } else {
        // Retain the corroborated window briefly. Recovery deliberately checks
        // candidate absence once while reconciling and again under the live
        // Effect fence immediately before submission. Forgetting the first
        // interval here makes those two safe checks oscillate forever between
        // `absent` and `unknown`.
        window.lastSeenAtMs = observedAt;
      }
    } else if (record.status === "present") {
      this.absenceWindows.delete(
        `${request.operation}:${request.transactionId}:${expectedOutputsDigest}`
      );
    }
    return interpret(this.store.record(record), finality, request);
  }

  private trackAbsence(key: string, observedAtMs: number): void {
    if (this.absenceWindows.size >= MAX_TRACKED_ABSENCES) {
      const oldest = this.absenceWindows.keys().next().value as string | undefined;
      if (oldest !== undefined) this.absenceWindows.delete(oldest);
    }
    this.absenceWindows.set(key, {
      firstSeenAtMs: observedAtMs,
      lastSeenAtMs: observedAtMs,
    });
  }

  private pruneAbsenceWindows(observedAtMs: number): void {
    for (const [key, window] of this.absenceWindows) {
      if (observedAtMs - window.lastSeenAtMs > ABSENCE_RETENTION_MS) {
        this.absenceWindows.delete(key);
      }
    }
  }

  private async safeWitness(request: Readonly<ChainEvidenceRequest>): Promise<ChainSourceEvidence> {
    try {
      return await this.witness.observe(request);
    } catch (cause) {
      if (request.signal.aborted) throw request.signal.reason;
      return nonPresent("unavailable", "sompi:chain-witness:error", digest({ source: "witness", error: "unavailable" }), readTime(this.now()));
    }
  }

  private async safePrimary(request: Readonly<ChainEvidenceRequest>, witness: ChainSourceEvidence): Promise<ChainSourceEvidence> {
    try {
      return await this.primary.observe(request, witness);
    } catch (cause) {
      if (request.signal.aborted) throw request.signal.reason;
      return nonPresent("unavailable", "sompi:operator-chain:error", digest({ source: "primary", error: "unavailable" }), readTime(this.now()));
    }
  }
}

function merge(
  request: Readonly<ChainEvidenceRequest>,
  primary: ChainSourceEvidence,
  witness: ChainSourceEvidence,
  finality: ChainEvidenceFinalitySelection,
  observedAtMs: number
): ChainEvidenceRecord {
  const base = {
    profile: CHAIN_EVIDENCE_PROFILE,
    operationId: request.operationId,
    operation: request.operation,
    transactionId: request.transactionId,
    mechanism: request.mechanism,
    protocolFinality: finality.protocolFinality,
    operatorFloor: finality.operatorFloor,
    effectiveFloor: finality.effectiveFloor,
    primaryProfile: primary.sourceProfile,
    witnessProfile: witness.sourceProfile,
    outputsDigest: outputsDigest(request),
    observedAtMs,
  } as const;
  if (isAccepted(primary) && isAccepted(witness)) {
    if (!hasPinnedSourceProfiles(primary, witness)) {
      return freezeRecord({
        ...base,
        status: "unknown",
        detailDigest: digest({
          ...base,
          result: "source-profile-unsupported",
          primary: primary.detailDigest,
          witness: witness.detailDigest,
        }),
      });
    }
    if (
      primary.transactionId !== witness.transactionId ||
      primary.transactionId !== request.transactionId ||
      primary.blockHash !== witness.blockHash ||
      primary.acceptingBlockHash !== witness.acceptingBlockHash ||
      primary.acceptingBlockDaaScore !== witness.acceptingBlockDaaScore ||
      primary.outputsDigest !== witness.outputsDigest ||
      primary.outputsDigest !== base.outputsDigest
    ) {
      return freezeRecord({ ...base, status: "unknown", detailDigest: digest({ ...base, result: "source-conflict", primary: primary.detailDigest, witness: witness.detailDigest }) });
    }
    const level = primary.level === "depth-confirmed" && witness.level === "depth-confirmed"
      ? "depth-confirmed" as const
      : "accepted" as const;
    return freezeRecord({
      ...base,
      status: "present",
      level,
      view: primary.view === "historical" || witness.view === "historical" ? "historical" : "current",
      blockHash: primary.blockHash,
      acceptingBlockHash: primary.acceptingBlockHash,
      acceptingBlockDaaScore: primary.acceptingBlockDaaScore,
      virtualDaaScore: minimumDecimal(primary.virtualDaaScore, witness.virtualDaaScore),
      detailDigest: digest({ ...base, result: "corroborated", level, primary: primary.detailDigest, witness: witness.detailDigest }),
    });
  }
  if (primary.status === "present" || witness.status === "present") {
    return freezeRecord({ ...base, status: "present", level: "provisional", view: "current", detailDigest: digest({ ...base, result: "provisional", primary: primary.detailDigest, witness: witness.detailDigest }) });
  }
  if (primary.status === "absent" && witness.status === "absent") {
    if (!hasPinnedSourceProfiles(primary, witness)) {
      return freezeRecord({
        ...base,
        status: "unknown",
        detailDigest: digest({
          ...base,
          result: "source-profile-unsupported",
          primary: primary.detailDigest,
          witness: witness.detailDigest,
        }),
      });
    }
    return freezeRecord({ ...base, status: "absent", detailDigest: digest({ ...base, result: "corroborated-absence", primary: primary.detailDigest, witness: witness.detailDigest }) });
  }
  const status = primary.status === "unavailable" || witness.status === "unavailable" ? "unavailable" : "unknown";
  return freezeRecord({ ...base, status, detailDigest: digest({ ...base, result: status, primary: primary.detailDigest, witness: witness.detailDigest }) });
}

function validateRequest(request: Readonly<ChainEvidenceRequest>): void {
  if (
    !request ||
    request.network !== "kaspa:testnet-10" ||
    !ID.test(request.operationId) ||
    !HASH32.test(request.transactionId) ||
    !CHAIN_EVIDENCE_OPERATIONS.includes(request.operation) ||
    !["ordinary", "native-covenant", "kip10-script-template"].includes(request.mechanism) ||
    !["mempool", "accepted", "confirmed"].includes(request.protocolFinality) ||
    !request.signal ||
    typeof request.signal.throwIfAborted !== "function"
  ) {
    throw new ChainEvidenceError("Chain Evidence request identity is invalid");
  }
  if (!Array.isArray(request.expectedOutputs) || request.expectedOutputs.length < 1 || request.expectedOutputs.length > 16) {
    throw new ChainEvidenceError("Chain Evidence expected outputs are invalid");
  }
  const indexes = new Set<number>();
  for (const output of request.expectedOutputs) {
    if (
      !Number.isSafeInteger(output.index) ||
      output.index < 0 ||
      indexes.has(output.index) ||
      !/^(?:0|[1-9][0-9]*)$/.test(output.amountAtomic) ||
      !/^[a-f0-9]+$/.test(output.scriptPublicKey) ||
      typeof output.address !== "string" ||
      output.address.length === 0 ||
      output.address.length > 256
    ) {
      throw new ChainEvidenceError("Chain Evidence expected output is invalid");
    }
    indexes.add(output.index);
  }
  if (
    request.expectedInputs !== undefined &&
    (
      !Array.isArray(request.expectedInputs) ||
      request.expectedInputs.length > 64 ||
      request.expectedInputs.some(
        (input) =>
          !HASH32.test(input.transactionId) ||
          !Number.isSafeInteger(input.index) ||
          input.index < 0 ||
          input.index > 0xffff_ffff
      )
    )
  ) {
    throw new ChainEvidenceError("Chain Evidence expected inputs are invalid");
  }
  if (!Array.isArray(request.watchedAddresses) || request.watchedAddresses.length < 1 || request.watchedAddresses.length > 16 || request.watchedAddresses.some((value) => typeof value !== "string" || value.length > 256)) {
    throw new ChainEvidenceError("Chain Evidence watched addresses are invalid");
  }
  if (request.signal?.aborted) request.signal.throwIfAborted();
}

export function outputsDigest(request: Pick<ChainEvidenceRequest, "transactionId" | "expectedOutputs" | "expectedInputs" | "mechanism">): string {
  return digest({ transactionId: request.transactionId, mechanism: request.mechanism, inputs: request.expectedInputs ?? [], outputs: request.expectedOutputs });
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sort(value)), "utf8").digest("base64url")}`;
}

export function nonPresent(status: "absent" | "unknown" | "unavailable", sourceProfile: string, detailDigest: string, observedAtMs: number): ChainSourceEvidence {
  if (!DIGEST.test(detailDigest)) throw new ChainEvidenceError("Chain Evidence detail digest is invalid");
  return Object.freeze({ status, sourceProfile, detailDigest, observedAtMs });
}

function isAccepted(value: ChainSourceEvidence): value is ChainSourceAcceptedEvidence {
  return value.status === "present" && value.level !== "provisional";
}

function hasPinnedSourceProfiles(
  primary: ChainSourceEvidence,
  witness: ChainSourceEvidence
): boolean {
  return (
    primary.sourceProfile === CHAIN_EVIDENCE_OPERATOR_PROFILE &&
    witness.sourceProfile === CHAIN_EVIDENCE_WITNESS_PROFILE
  );
}

function levelMeets(level: string, floor: FinalityFloor): boolean {
  const rank: Record<string, number> = { provisional: 0, accepted: 1, "depth-confirmed": 2, "consensus-final": 3 };
  return (rank[level] ?? -1) >= rank[floor];
}

function rederiveRetainedEvidence(
  evidence: ChainEvidenceRecord,
  finality: ChainEvidenceFinalitySelection
): Readonly<{ evidence: ChainEvidenceRecord; persist: boolean }> {
  const historical = Object.freeze({ ...evidence, view: "historical" as const });
  if (
    evidence.status !== "present" ||
    (evidence.level !== "accepted" && evidence.level !== "depth-confirmed")
  ) {
    return Object.freeze({ evidence: historical, persist: false });
  }
  const level = rawDepthLevel(evidence, finality);
  if (level === undefined || level === evidence.level) {
    return Object.freeze({ evidence: historical, persist: false });
  }
  return Object.freeze({
    evidence: freezeRecord({
      ...historical,
      level,
      detailDigest: digest({
        result: "retained-finality-rederived",
        priorDetailDigest: evidence.detailDigest,
        priorLevel: evidence.level,
        level,
        depthConfirmationDaa: finality.depthConfirmationDaa,
        acceptingBlockDaaScore: evidence.acceptingBlockDaaScore,
        virtualDaaScore: evidence.virtualDaaScore,
      }),
    }),
    persist: true,
  });
}

function interpret(
  evidence: ChainEvidenceRecord,
  finality: ChainEvidenceFinalitySelection,
  request: Readonly<ChainEvidenceRequest>
): ChainEvidenceObservation {
  if (isAcceptedRecordFor(evidence, finality, request)) {
    return Object.freeze({
      interpretation: "accepted" as const,
      evidence,
      finality,
    });
  }
  const interpretation =
    evidence.status === "present"
      ? evidence.level === "provisional"
        ? "provisional"
        : "unknown"
      : evidence.status;
  return Object.freeze({ interpretation, evidence, finality });
}

function isAcceptedRecordFor(
  evidence: ChainEvidenceRecord,
  finality: ChainEvidenceFinalitySelection,
  request: Readonly<ChainEvidenceRequest>
): evidence is AcceptedChainEvidenceRecord {
  return (
    evidence.profile === CHAIN_EVIDENCE_PROFILE &&
    evidence.operationId === request.operationId &&
    evidence.operation === request.operation &&
    evidence.operation === finality.operation &&
    evidence.transactionId === request.transactionId &&
    HASH32.test(evidence.transactionId) &&
    evidence.mechanism === request.mechanism &&
    evidence.protocolFinality === request.protocolFinality &&
    evidence.protocolFinality === finality.protocolFinality &&
    evidence.operatorFloor === finality.operatorFloor &&
    evidence.effectiveFloor === finality.effectiveFloor &&
    evidence.outputsDigest === outputsDigest(request) &&
    DIGEST.test(evidence.outputsDigest) &&
    DIGEST.test(evidence.detailDigest) &&
    evidence.status === "present" &&
    (evidence.level === "accepted" ||
      evidence.level === "depth-confirmed" ||
      evidence.level === "consensus-final") &&
    levelMeets(evidence.level, finality.effectiveFloor) &&
    (evidence.view === "current" || evidence.view === "historical") &&
    evidence.primaryProfile === CHAIN_EVIDENCE_OPERATOR_PROFILE &&
    evidence.witnessProfile === CHAIN_EVIDENCE_WITNESS_PROFILE &&
    typeof evidence.blockHash === "string" &&
    HASH32.test(evidence.blockHash) &&
    typeof evidence.acceptingBlockHash === "string" &&
    HASH32.test(evidence.acceptingBlockHash) &&
    typeof evidence.acceptingBlockDaaScore === "string" &&
    DECIMAL.test(evidence.acceptingBlockDaaScore) &&
    typeof evidence.virtualDaaScore === "string" &&
    DECIMAL.test(evidence.virtualDaaScore) &&
    depthMeaningMeets(evidence, finality) &&
    Number.isSafeInteger(evidence.observedAtMs) &&
    evidence.observedAtMs > 0
  );
}

function depthMeaningMeets(
  evidence: ChainEvidenceRecord,
  finality: ChainEvidenceFinalitySelection
): boolean {
  if (evidence.level === "consensus-final") return true;
  const level = rawDepthLevel(evidence, finality);
  return (
    level !== undefined &&
    (
      finality.effectiveFloor === "accepted" ||
      level === "depth-confirmed"
    )
  );
}

function rawDepthLevel(
  evidence: ChainEvidenceRecord,
  finality: ChainEvidenceFinalitySelection
): "accepted" | "depth-confirmed" | undefined {
  if (
    typeof evidence.acceptingBlockDaaScore !== "string" ||
    !DECIMAL.test(evidence.acceptingBlockDaaScore) ||
    typeof evidence.virtualDaaScore !== "string" ||
    !DECIMAL.test(evidence.virtualDaaScore)
  ) {
    return undefined;
  }
  const acceptingDaa = BigInt(evidence.acceptingBlockDaaScore);
  const virtualDaa = BigInt(evidence.virtualDaaScore);
  if (virtualDaa < acceptingDaa) return undefined;
  return virtualDaa - acceptingDaa >= BigInt(finality.depthConfirmationDaa)
    ? "depth-confirmed"
    : "accepted";
}

function readFinalityPolicy(
  value: ChainEvidenceFinalityPolicy
): ChainEvidenceFinalityPolicy {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== CHAIN_EVIDENCE_OPERATIONS.length ||
    !CHAIN_EVIDENCE_OPERATIONS.every(
      (operation) =>
        Object.prototype.hasOwnProperty.call(value, operation) &&
        (value[operation] === "accepted" || value[operation] === "depth-confirmed")
    )
  ) {
    throw new ChainEvidenceError("Chain Evidence finality policy is invalid");
  }
  return Object.freeze(
    Object.fromEntries(
      CHAIN_EVIDENCE_OPERATIONS.map((operation) => [operation, value[operation]])
    ) as Record<ChainEvidenceOperation, FinalityFloor>
  );
}

function minimumDecimal(left: string, right: string): string {
  return (BigInt(left) < BigInt(right) ? BigInt(left) : BigInt(right)).toString();
}

function freezeRecord(value: ChainEvidenceRecord): ChainEvidenceRecord {
  return Object.freeze(value);
}

function readTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ChainEvidenceError("Chain Evidence clock is invalid");
  return value;
}

function readDepthConfirmationDaa(
  value: unknown,
  source: "operator" | "witness"
): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/.test(value) ||
    value.length > 78
  ) {
    throw new ChainEvidenceError(
      `Chain Evidence ${source} depth-confirmation DAA is invalid`
    );
  }
  return value;
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]));
}
