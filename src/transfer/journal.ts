import type { TreasuryOperationView } from "../treasury/operation-journal.js";
import type {
  TransferAuthorizationFacts,
  TransferAuthorizationRecord,
  TransferAuthorityDecision,
  TransferReceipt,
  TransferRecord,
  TransferState,
} from "./types.js";

export interface TransferJournalIntent {
  readonly id: string;
  readonly requestKey: string;
  readonly requestDigest: string;
  readonly destination: string;
  readonly amountAtomic: string;
  readonly sourceVaultAddress: string;
  readonly sourceVaultDigest: string;
  readonly feeCeilingAtomic: string;
  readonly maximumTotalAtomic: string;
  readonly expiresAtMs: number;
  readonly policyDigest: string;
  readonly manifestRevision: number;
  readonly manifestDigest: string;
  readonly finalityFloor: "accepted" | "depth-confirmed";
}

export interface TransferJournal {
  claimTransferIntent(input: TransferJournalIntent): TransferRecord;
  findTransferByRequestKey(requestKey: string): TransferRecord | undefined;
  findTransfer(id: string): TransferRecord | undefined;
  transitionTransfer(id: string, to: TransferState, reasonCode: string, detailDigest?: string): TransferRecord;
  recordTransferAuthorization(
    id: string,
    facts: TransferAuthorizationFacts,
    decision: TransferAuthorityDecision,
  ): TransferAuthorizationRecord;
  findTransferAuthorization(id: string): TransferAuthorizationRecord | undefined;
  readTransferAuthorizationEvidence(id: string): Buffer;
  bindTransferTreasuryOperation(id: string, operationKey: string): TransferRecord;
  syncTransferTreasuryOperation(id: string, operation: TreasuryOperationView): TransferRecord;
  recordTransferReceipt(id: string, receipt: TransferReceipt): TransferReceipt;
  findTransferReceipt(id: string): TransferReceipt | undefined;
  listTransfers(limit: number): readonly TransferRecord[];
}
