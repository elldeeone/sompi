import type { PurchaseJournal } from "../purchase/journal.js";
import type { ChainEvidenceRecord, ChainEvidenceStore } from "./types.js";

export class JournalChainEvidenceStore implements ChainEvidenceStore {
  constructor(private readonly journal: PurchaseJournal) {
    if (!journal || typeof journal.recordChainEvidence !== "function") {
      throw new Error("Purchase Journal Chain Evidence store is required");
    }
  }

  findAccepted(transactionId: string): ChainEvidenceRecord | undefined {
    return this.journal.findAcceptedChainEvidence(transactionId);
  }

  record(record: Readonly<ChainEvidenceRecord>): ChainEvidenceRecord {
    return this.journal.recordChainEvidence(record);
  }
}
