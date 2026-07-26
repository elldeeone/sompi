import type { PurchaseJournal } from "../purchase/journal.js";
import type {
  AcceptedChainEvidenceQuery,
  ChainEvidenceRecord,
  ChainEvidenceStore,
} from "./types.js";

export class JournalChainEvidenceStore implements ChainEvidenceStore {
  constructor(private readonly journal: PurchaseJournal) {
    if (
      !journal ||
      typeof journal.findRetainedChainEvidence !== "function" ||
      typeof journal.recordChainEvidence !== "function"
    ) {
      throw new Error("Purchase Journal Chain Evidence store is required");
    }
  }

  findRetained(
    query: Readonly<AcceptedChainEvidenceQuery>
  ): readonly ChainEvidenceRecord[] {
    return this.journal.findRetainedChainEvidence(query);
  }

  record(record: Readonly<ChainEvidenceRecord>): ChainEvidenceRecord {
    return this.journal.recordChainEvidence(record);
  }
}
