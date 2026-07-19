import type {
  ChainObservation,
  ChainObservationRequest,
  ChainObservationSource,
} from "../adapters/kaspa-x402/chain-verifier.js";
import type { ChainEvidenceModule } from "./module.js";
import type { Sha256Digest } from "../purchase/types.js";

export class ChainEvidenceExactOutputSource implements ChainObservationSource {
  constructor(
    private readonly evidence: ChainEvidenceModule,
    private readonly operatorFloor: "accepted" | "depth-confirmed"
  ) {}

  async observeExactOutput(request: Readonly<ChainObservationRequest>): Promise<ChainObservation> {
    const result = await this.evidence.observe({
      operationId: `settlement:${request.transactionId}`,
      operation: "settlement",
      network: "kaspa:testnet-10",
      transactionId: request.transactionId,
      expectedOutputs: [{
        index: request.outputIndex,
        amountAtomic: request.expectedAmountAtomic,
        scriptPublicKey: request.expectedScriptPublicKey,
        address: request.merchantAddress,
      }],
      watchedAddresses: [request.merchantAddress],
      mechanism:
        request.profile === "additive" ? "kip10-script-template" : "ordinary",
      protocolFinality: request.minimumFinality,
      operatorFloor: this.operatorFloor,
      signal: request.signal,
    });
    if (result.status !== "present" || !result.level) {
      return Object.freeze({ status: "pending" as const, detailDigest: result.detailDigest as Sha256Digest });
    }
    if (result.level === "provisional") {
      if (request.minimumFinality !== "mempool") return Object.freeze({ status: "pending" as const, detailDigest: result.detailDigest as Sha256Digest });
      return Object.freeze({
        status: "observed" as const,
        network: "kaspa:testnet-10" as const,
        transactionId: request.transactionId,
        outpoint: request.outpoint,
        amountAtomic: request.expectedAmountAtomic,
        scriptPublicKey: request.expectedScriptPublicKey,
        finality: "mempool" as const,
        observedAtMs: result.observedAtMs,
        detailDigest: result.detailDigest as Sha256Digest,
      });
    }
    return Object.freeze({
      status: "observed" as const,
      network: "kaspa:testnet-10" as const,
      transactionId: request.transactionId,
      outpoint: request.outpoint,
      amountAtomic: request.expectedAmountAtomic,
      scriptPublicKey: request.expectedScriptPublicKey,
      finality: result.level === "accepted" ? "accepted" as const : "confirmed" as const,
      observedAtMs: result.observedAtMs,
      detailDigest: result.detailDigest as Sha256Digest,
    });
  }
}
