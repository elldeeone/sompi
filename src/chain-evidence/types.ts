export const CHAIN_EVIDENCE_PROFILE = "urn:sompi:chain-evidence:testnet-10:1" as const;

export type ChainEvidenceLevel =
  | "provisional"
  | "accepted"
  | "depth-confirmed"
  | "consensus-final";

export type ChainEvidenceStatus = "present" | "absent" | "unknown" | "unavailable";
export type ChainEvidenceView = "current" | "historical";
export type ChainMechanism = "ordinary" | "native-covenant" | "kip10-script-template";
export type FinalityFloor = "accepted" | "depth-confirmed";

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
  readonly operation: "settlement" | "direct-treasury" | "vault" | "staging" | "recovery-release";
  readonly network: "kaspa:testnet-10";
  readonly transactionId: string;
  readonly expectedOutputs: readonly ExpectedChainOutput[];
  readonly expectedInputs?: readonly ExpectedChainInput[];
  readonly watchedAddresses: readonly string[];
  readonly mechanism: ChainMechanism;
  readonly protocolFinality: "mempool" | "accepted" | "confirmed";
  readonly operatorFloor: FinalityFloor;
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

export interface IndependentChainWitness {
  observe(request: Readonly<ChainEvidenceRequest>): Promise<ChainSourceEvidence>;
}

export interface OperatorChainObserver {
  observe(
    request: Readonly<ChainEvidenceRequest>,
    witness: Readonly<ChainSourceEvidence>
  ): Promise<ChainSourceEvidence>;
}

export interface AcceptedChainEvidenceQuery {
  readonly transactionId: string;
  readonly outputsDigest: string;
  readonly mechanism: ChainMechanism;
  readonly minimumLevel: FinalityFloor;
}

export interface ChainEvidenceStore {
  findAccepted(
    query: Readonly<AcceptedChainEvidenceQuery>
  ): ChainEvidenceRecord | undefined;
  record(record: Readonly<ChainEvidenceRecord>): ChainEvidenceRecord;
}
