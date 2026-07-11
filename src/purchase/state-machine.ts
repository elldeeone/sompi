import type { PurchaseState } from "./types";

const ALLOWED_TRANSITIONS = {
  created: ["terms_bound", "cancelled"],
  terms_bound: ["awaiting_authority", "expired", "cancelled"],
  awaiting_authority: ["authorised", "denied", "expired", "cancelled"],
  authorised: ["execution_prepared", "expired", "cancelled"],
  execution_prepared: ["submitted", "failed_recoverable"],
  submitted: ["settled", "failed_recoverable"],
  settled: ["fulfilled", "failed_recoverable"],
  fulfilled: ["receipted"],
  receipted: [],
  denied: [],
  cancelled: [],
  expired: [],
  failed_recoverable: [
    "execution_prepared",
    "submitted",
    "settled",
    "failed_terminal",
  ],
  failed_terminal: [],
} as const satisfies Readonly<Record<PurchaseState, readonly PurchaseState[]>>;

export function canTransitionPurchase(from: PurchaseState, to: PurchaseState): boolean {
  return from === to || (ALLOWED_TRANSITIONS[from] as readonly PurchaseState[]).includes(to);
}

export function assertPurchaseTransition(from: PurchaseState, to: PurchaseState): void {
  if (!canTransitionPurchase(from, to)) {
    throw new Error(`invalid Purchase transition ${from} -> ${to}`);
  }
}

export function terminalPurchaseState(state: PurchaseState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}
