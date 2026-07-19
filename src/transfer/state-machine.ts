import type { TransferState } from "./types.js";

const ALLOWED = {
  created: ["awaiting_authority"],
  awaiting_authority: ["authorised", "denied", "failed_recoverable", "failed_terminal"],
  authorised: ["funds_reserved", "failed_terminal"],
  denied: [],
  funds_reserved: ["prepared", "submitted", "settled", "failed_recoverable", "failed_terminal"],
  prepared: ["submitted", "settled", "failed_recoverable", "failed_terminal"],
  submitted: ["settled", "failed_recoverable", "failed_terminal"],
  settled: ["receipted", "failed_recoverable"],
  receipted: [],
  failed_recoverable: ["funds_reserved", "prepared", "submitted", "settled", "receipted", "failed_terminal"],
  failed_terminal: [],
} as const satisfies Readonly<Record<TransferState, readonly TransferState[]>>;

export function assertTransferTransition(from: TransferState, to: TransferState): void {
  if (!(ALLOWED[from] as readonly TransferState[]).includes(to)) {
    throw new Error(`invalid Transfer transition ${from} -> ${to}`);
  }
}
