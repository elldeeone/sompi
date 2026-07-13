import type { RpcClient } from "../kaspa-wasm.js";
import { evidenceDigest } from "../purchase/identity.js";
import type { Sha256Digest } from "../purchase/types.js";
import type {
  StagingRecoveryCandidateObservation,
  StagingRecoveryExpectedCandidate,
  StagingRecoveryOutpointObservation,
  StagingRecoveryRaceEvidence,
  StagingRecoveryRaceRequest,
  StagingRecoveryRaceSource,
} from "../adapters/kaspa-x402/abandoned-staging-recovery.js";
import type { ChainEvidenceModule } from "./module.js";
import type { FinalityFloor } from "./types.js";

export class ChainEvidenceStagingRecoveryRaceSource implements StagingRecoveryRaceSource {
  constructor(
    private readonly chainEvidence: ChainEvidenceModule,
    private readonly rpc: { client(): Promise<RpcClient> },
    private readonly floor: FinalityFloor
  ) {}

  async observeRace(request: Readonly<StagingRecoveryRaceRequest>): Promise<Readonly<StagingRecoveryRaceEvidence>> {
    request.signal.throwIfAborted();
    const [exactPayment, recovery, staging] = await Promise.all([
      request.exactPayment ? this.candidate(request, request.exactPayment, "exact") : Promise.resolve(null),
      this.candidate(request, request.recovery, "recovery"),
      this.staging(request),
    ]);
    const exactId = exactPayment?.status === "observed" ? exactPayment.transactionId : undefined;
    const recoveryId = recovery.status === "observed" ? recovery.transactionId : undefined;
    const boundStaging = staging.status === "spent" && staging.spendingTransactionId === undefined
      ? Object.freeze({
          ...staging,
          ...(exactId && !recoveryId ? { spendingTransactionId: exactId } : {}),
          ...(recoveryId && !exactId ? { spendingTransactionId: recoveryId } : {}),
        })
      : staging;
    return Object.freeze({ staging: boundStaging, exactPayment, recovery });
  }

  private async candidate(
    request: Readonly<StagingRecoveryRaceRequest>,
    candidate: Readonly<StagingRecoveryExpectedCandidate>,
    role: "exact" | "recovery"
  ): Promise<StagingRecoveryCandidateObservation> {
    const input = parseOutpoint(candidate.inputOutpoint);
    const evidence = await this.chainEvidence.observe({
      operationId: `staging-recovery:${role}:${candidate.transactionId}`,
      operation: "recovery-release",
      network: "kaspa:testnet-10",
      transactionId: candidate.transactionId,
      expectedOutputs: [{
        index: candidate.outputIndex,
        amountAtomic: candidate.outputAmountAtomic,
        scriptPublicKey: candidate.outputScriptPublicKey,
        address: candidate.outputAddress,
      }],
      expectedInputs: [input],
      watchedAddresses: [request.staging.address, candidate.outputAddress],
      mechanism: role === "exact" ? "kip10-script-template" : "ordinary",
      protocolFinality: "accepted",
      operatorFloor: this.floor,
      signal: request.signal,
    });
    if (evidence.status === "absent") return Object.freeze({ status: "absent" as const, detailDigest: evidence.detailDigest as Sha256Digest });
    if (evidence.status !== "present" || !evidence.level) return Object.freeze({ status: "partial" as const, detailDigest: evidence.detailDigest as Sha256Digest });
    const finality = evidence.level === "provisional" ? "mempool" as const : evidence.level === "accepted" ? "accepted" as const : "confirmed" as const;
    return Object.freeze({
      status: "observed" as const,
      transactionId: candidate.transactionId,
      inputOutpoint: candidate.inputOutpoint,
      outputOutpoint: candidate.outputOutpoint,
      outputAmountAtomic: candidate.outputAmountAtomic,
      outputScriptPublicKey: candidate.outputScriptPublicKey,
      finality,
      detailDigest: evidence.detailDigest as Sha256Digest,
    });
  }

  private async staging(request: Readonly<StagingRecoveryRaceRequest>): Promise<StagingRecoveryOutpointObservation> {
    try {
      const rpc = await this.rpc.client();
      const response = await rpc.getUtxosByAddresses([request.staging.address]);
      const matches = (response.entries as any[]).filter((entry) => {
        const outpoint = entry?.outpoint ?? entry?.entry?.outpoint;
        return `${String(outpoint?.transactionId)}:${Number(outpoint?.index)}` === request.staging.outpoint;
      });
      if (matches.length > 1) return Object.freeze({ status: "partial" as const, detailDigest: evidenceDigest("duplicate-staging-outpoint") });
      if (matches.length === 0) return Object.freeze({ status: "spent" as const, detailDigest: evidenceDigest(`spent:${request.staging.outpoint}`) });
      const entry = matches[0];
      const amount = BigInt(entry?.amount ?? entry?.entry?.amount ?? -1).toString();
      const blockDaaScore = BigInt(entry?.blockDaaScore ?? entry?.entry?.blockDaaScore ?? -1).toString();
      const script = serializedScript(entry?.scriptPublicKey ?? entry?.entry?.scriptPublicKey);
      if (amount !== request.staging.amountAtomic || blockDaaScore !== request.staging.blockDaaScore || script !== request.staging.scriptPublicKey) {
        return Object.freeze({ status: "partial" as const, detailDigest: evidenceDigest("staging-facts-mismatch") });
      }
      return Object.freeze({
        status: "unspent" as const,
        outpoint: request.staging.outpoint,
        amountAtomic: amount,
        scriptPublicKey: script,
        blockDaaScore,
        detailDigest: evidenceDigest(`unspent:${request.staging.outpoint}`),
      });
    } catch {
      return Object.freeze({ status: "unknown" as const, detailDigest: evidenceDigest(`staging-unavailable:${request.staging.outpoint}`) });
    }
  }
}

function parseOutpoint(value: string): { transactionId: string; index: number } {
  const match = /^([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error("staging recovery outpoint is invalid");
  return Object.freeze({ transactionId: match[1], index: Number(match[2]) });
}

function serializedScript(value: any): string {
  const version = Number(value?.version ?? -1);
  const script = typeof value?.script === "string" ? value.script.toLowerCase() : "";
  if (!Number.isSafeInteger(version) || version < 0 || version > 0xffff || !/^[a-f0-9]+$/.test(script)) throw new Error("staging script is invalid");
  return `${version.toString(16).padStart(4, "0")}${script}`;
}
