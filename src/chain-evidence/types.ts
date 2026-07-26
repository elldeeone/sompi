export const CHAIN_EVIDENCE_PROFILE = "urn:sompi:chain-evidence:testnet-10:1" as const;
export const CHAIN_EVIDENCE_OPERATOR_PROFILE = "kaspa-operator-wrpc-v1" as const;
export const CHAIN_EVIDENCE_WITNESS_PROFILE = "kaspa-rest-accepted-history-v1" as const;

export type ChainEvidenceLevel =
  | "provisional"
  | "accepted"
  | "depth-confirmed"
  | "consensus-final";

export type ChainEvidenceStatus = "present" | "absent" | "unknown" | "unavailable";
export type ChainEvidenceView = "current" | "historical";
export type ChainMechanism = "ordinary" | "native-covenant" | "kip10-script-template";
export type FinalityFloor = "accepted" | "depth-confirmed";
export const CHAIN_EVIDENCE_OPERATIONS = [
  "settlement",
  "direct-treasury",
  "vault",
  "staging",
  "recovery-release",
] as const;
export type ChainEvidenceOperation = (typeof CHAIN_EVIDENCE_OPERATIONS)[number];
export type ProtocolFinality = "mempool" | "accepted" | "confirmed";

export function chainEvidenceEffectiveFloor(
  protocolFinality: ProtocolFinality,
  operatorFloor: FinalityFloor
): FinalityFloor {
  return protocolFinality === "confirmed" ||
    operatorFloor === "depth-confirmed"
    ? "depth-confirmed"
    : "accepted";
}

export type ChainEvidenceFinalityPolicy = Readonly<
  Record<ChainEvidenceOperation, FinalityFloor>
>;

export interface ChainEvidenceFinalitySelection {
  readonly operation: ChainEvidenceOperation;
  readonly protocolFinality: ProtocolFinality;
  readonly operatorFloor: FinalityFloor;
  readonly effectiveFloor: FinalityFloor;
  /** Canonical DAA depth that gives meaning to `depth-confirmed`. */
  readonly depthConfirmationDaa: string;
}

export interface ChainEvidenceFinalitySelector {
  selectFinality(
    operation: ChainEvidenceOperation,
    protocolFinality: ProtocolFinality
  ): ChainEvidenceFinalitySelection;
}

export interface ExpectedChainOutput {
  readonly index: number;
  readonly amountAtomic: string;
  readonly scriptPublicKey: string;
  readonly address: string;
  readonly covenantId?: string;
}

export interface ExpectedChainInput {
  readonly transactionId: string;
  readonly index: number;
}

export interface ChainEvidenceRequest {
  readonly operationId: string;
  readonly operation: ChainEvidenceOperation;
  readonly network: "kaspa:testnet-10";
  readonly transactionId: string;
  readonly expectedOutputs: readonly ExpectedChainOutput[];
  readonly expectedInputs?: readonly ExpectedChainInput[];
  readonly watchedAddresses: readonly string[];
  readonly mechanism: ChainMechanism;
  readonly protocolFinality: ProtocolFinality;
  readonly signal: AbortSignal;
}

export interface ChainSourceAcceptedEvidence {
  readonly status: "present";
  readonly level: "accepted" | "depth-confirmed";
  readonly view: ChainEvidenceView;
  readonly sourceProfile: string;
  readonly transactionId: string;
  readonly blockHash: string;
  readonly acceptingBlockHash: string;
  readonly acceptingBlockDaaScore: string;
  readonly virtualDaaScore: string;
  readonly outputsDigest: string;
  readonly detailDigest: string;
  readonly observedAtMs: number;
}

export interface ChainSourceProvisionalEvidence {
  readonly status: "present";
  readonly level: "provisional";
  readonly view: "current";
  readonly sourceProfile: string;
  readonly transactionId: string;
  readonly outputsDigest: string;
  readonly detailDigest: string;
  readonly observedAtMs: number;
}

export interface ChainSourceNonPresentEvidence {
  readonly status: "absent" | "unknown" | "unavailable";
  readonly sourceProfile: string;
  readonly detailDigest: string;
  readonly observedAtMs: number;
}

export type ChainSourceEvidence =
  | ChainSourceAcceptedEvidence
  | ChainSourceProvisionalEvidence
  | ChainSourceNonPresentEvidence;

export interface ChainEvidenceRecord {
  readonly profile: typeof CHAIN_EVIDENCE_PROFILE;
  readonly operationId: string;
  readonly operation: ChainEvidenceRequest["operation"];
  readonly transactionId: string;
  readonly status: ChainEvidenceStatus;
  readonly level?: ChainEvidenceLevel;
  readonly view?: ChainEvidenceView;
  readonly mechanism: ChainMechanism;
  readonly protocolFinality: ChainEvidenceRequest["protocolFinality"];
  readonly operatorFloor: FinalityFloor;
  readonly effectiveFloor: FinalityFloor;
  readonly primaryProfile: string;
  readonly witnessProfile: string;
  readonly blockHash?: string;
  readonly acceptingBlockHash?: string;
  readonly acceptingBlockDaaScore?: string;
  readonly virtualDaaScore?: string;
  readonly outputsDigest: string;
  readonly detailDigest: string;
  readonly observedAtMs: number;
}

export type AcceptedChainEvidenceRecord = ChainEvidenceRecord & Readonly<{
  status: "present";
  level: "accepted" | "depth-confirmed" | "consensus-final";
  view: ChainEvidenceView;
  blockHash: string;
  acceptingBlockHash: string;
  acceptingBlockDaaScore: string;
  virtualDaaScore: string;
}>;

export type ChainEvidenceObservation =
  | Readonly<{
      interpretation: "accepted";
      evidence: AcceptedChainEvidenceRecord;
      finality: ChainEvidenceFinalitySelection;
    }>
  | Readonly<{
      interpretation: "provisional" | "absent" | "unknown" | "unavailable";
      evidence: ChainEvidenceRecord;
      finality: ChainEvidenceFinalitySelection;
    }>;

export interface IndependentChainWitness {
  readonly depthConfirmationDaa: string;
  observe(request: Readonly<ChainEvidenceRequest>): Promise<ChainSourceEvidence>;
}

export interface OperatorChainObserver {
  readonly depthConfirmationDaa: string;
  observe(
    request: Readonly<ChainEvidenceRequest>,
    witness: Readonly<ChainSourceEvidence>
  ): Promise<ChainSourceEvidence>;
}

export interface AcceptedChainEvidenceQuery {
  readonly profile: typeof CHAIN_EVIDENCE_PROFILE;
  readonly operationId: string;
  readonly operation: ChainEvidenceOperation;
  readonly transactionId: string;
  readonly outputsDigest: string;
  readonly mechanism: ChainMechanism;
  readonly protocolFinality: ProtocolFinality;
  readonly operatorFloor: FinalityFloor;
  readonly effectiveFloor: FinalityFloor;
}

export interface ChainEvidenceStore {
  findRetained(
    query: Readonly<AcceptedChainEvidenceQuery>
  ): readonly ChainEvidenceRecord[];
  record(record: Readonly<ChainEvidenceRecord>): ChainEvidenceRecord;
}
