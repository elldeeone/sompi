import { createHash } from "node:crypto";

import {
  CHAIN_EVIDENCE_PROFILE,
  type ChainEvidenceRecord,
  type ChainEvidenceRequest,
  type ChainEvidenceStore,
  type ChainSourceAcceptedEvidence,
  type ChainSourceEvidence,
  type FinalityFloor,
  type IndependentChainWitness,
  type OperatorChainObserver,
} from "./types.js";

const HASH32 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export class ChainEvidenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainEvidenceError";
  }
}

export class ChainEvidenceModule {
  private readonly absenceFirstSeen = new Map<string, number>();
  constructor(
    private readonly primary: OperatorChainObserver,
    private readonly witness: IndependentChainWitness,
    private readonly store: ChainEvidenceStore,
    private readonly now: () => number = Date.now
  ) {
    if (typeof primary?.observe !== "function" || typeof witness?.observe !== "function") {
      throw new ChainEvidenceError("both independent Chain Evidence sources are required");
    }
    if (typeof store?.findAccepted !== "function" || typeof store?.record !== "function") {
      throw new ChainEvidenceError("durable Chain Evidence store is required");
    }
    readTime(now());
  }

  async observe(request: Readonly<ChainEvidenceRequest>): Promise<ChainEvidenceRecord> {
    validateRequest(request);
    request.signal.throwIfAborted();
    const effectiveFloor = strongerFloor(protocolFloor(request.protocolFinality), request.operatorFloor);
    const expectedOutputsDigest = outputsDigest(request);
    const retained = this.store.findAccepted(request.transactionId);
    if (
      retained &&
      retained.status === "present" &&
      retained.level &&
      retained.outputsDigest === expectedOutputsDigest &&
      retained.mechanism === request.mechanism &&
      meets(retained.level, effectiveFloor)
    ) {
      return Object.freeze({ ...retained, view: "historical" });
    }

    const witness = await this.safeWitness(request);
    request.signal.throwIfAborted();
    const primary = await this.safePrimary(request, witness);
    request.signal.throwIfAborted();
    const observedAt = readTime(this.now());
    let record = merge(request, primary, witness, effectiveFloor, observedAt);
    if (record.status === "absent") {
      const key = `${request.operation}:${request.transactionId}:${expectedOutputsDigest}`;
      const first = this.absenceFirstSeen.get(key);
      if (first === undefined || observedAt - first < 1_000) {
        if (first === undefined) this.absenceFirstSeen.set(key, observedAt);
        record = Object.freeze({
          ...record,
          status: "unknown",
          detailDigest: digest({ prior: record.detailDigest, result: "absence-propagation-interval-pending", firstSeenAtMs: first ?? observedAt }),
        });
      } else {
        this.absenceFirstSeen.delete(key);
      }
    } else if (record.status === "present") {
      this.absenceFirstSeen.delete(`${request.operation}:${request.transactionId}:${expectedOutputsDigest}`);
    }
    return this.store.record(record);
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
  effectiveFloor: FinalityFloor,
  observedAtMs: number
): ChainEvidenceRecord {
  const base = {
    profile: CHAIN_EVIDENCE_PROFILE,
    operationId: request.operationId,
    operation: request.operation,
    transactionId: request.transactionId,
    mechanism: request.mechanism,
    protocolFinality: request.protocolFinality,
    operatorFloor: request.operatorFloor,
    effectiveFloor,
    primaryProfile: primary.sourceProfile,
    witnessProfile: witness.sourceProfile,
    outputsDigest: outputsDigest(request),
    observedAtMs,
  } as const;
  if (isAccepted(primary) && isAccepted(witness)) {
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
    return freezeRecord({ ...base, status: "absent", detailDigest: digest({ ...base, result: "corroborated-absence", primary: primary.detailDigest, witness: witness.detailDigest }) });
  }
  const status = primary.status === "unavailable" || witness.status === "unavailable" ? "unavailable" : "unknown";
  return freezeRecord({ ...base, status, detailDigest: digest({ ...base, result: status, primary: primary.detailDigest, witness: witness.detailDigest }) });
}

function validateRequest(request: Readonly<ChainEvidenceRequest>): void {
  if (!request || request.network !== "kaspa:testnet-10" || !ID.test(request.operationId) || !HASH32.test(request.transactionId)) {
    throw new ChainEvidenceError("Chain Evidence request identity is invalid");
  }
  if (!Array.isArray(request.expectedOutputs) || request.expectedOutputs.length < 1 || request.expectedOutputs.length > 16) {
    throw new ChainEvidenceError("Chain Evidence expected outputs are invalid");
  }
  const indexes = new Set<number>();
  for (const output of request.expectedOutputs) {
    if (!Number.isSafeInteger(output.index) || output.index < 0 || indexes.has(output.index) || !/^(?:0|[1-9][0-9]*)$/.test(output.amountAtomic) || !/^[a-f0-9]+$/.test(output.scriptPublicKey)) {
      throw new ChainEvidenceError("Chain Evidence expected output is invalid");
    }
    indexes.add(output.index);
  }
  if (!Array.isArray(request.watchedAddresses) || request.watchedAddresses.length < 1 || request.watchedAddresses.some((value) => typeof value !== "string" || value.length > 256)) {
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

function protocolFloor(value: ChainEvidenceRequest["protocolFinality"]): FinalityFloor {
  return value === "confirmed" ? "depth-confirmed" : "accepted";
}

function strongerFloor(left: FinalityFloor, right: FinalityFloor): FinalityFloor {
  return left === "depth-confirmed" || right === "depth-confirmed" ? "depth-confirmed" : "accepted";
}

export function meets(level: string, floor: FinalityFloor): boolean {
  const rank: Record<string, number> = { provisional: 0, accepted: 1, "depth-confirmed": 2, "consensus-final": 3 };
  return (rank[level] ?? -1) >= rank[floor];
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

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]));
}
