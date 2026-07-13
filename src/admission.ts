/**
 * Boundary-neutral vocabulary for bounded retained work.
 *
 * This file deliberately contains no queue, scheduler, store, or cross-module
 * coordination. Each owning boundary enforces these invariants with storage
 * appropriate to its trust and durability requirements.
 */
export const ADMISSION_LEASE_STATES = [
  "offered",
  "admitted",
  "active",
  "completed",
  "cancelled",
  "expired",
  "failed_terminal",
] as const;

export type AdmissionLeaseState = (typeof ADMISSION_LEASE_STATES)[number];

export interface AdmissionBudgetProjection {
  readonly authorityPreauthSockets: number;
  readonly authorityPrompts: number;
  readonly prevalidationPurchases: number;
  readonly evidenceBytes: number;
  readonly directTreasuryRetries: number;
}

export interface AdmissionLease {
  readonly leaseId: string;
  readonly owner: string;
  readonly resource: string;
  readonly quantity: number;
  readonly state: AdmissionLeaseState;
  readonly deadlineAtMs?: number;
  readonly outcome?: string;
}

export class AdmissionError extends Error {
  readonly code: "invalid_budget" | "saturated" | "expired" | "cancelled";

  constructor(
    code: AdmissionError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AdmissionError";
    this.code = code;
  }
}

export function validateAdmissionBudgets(
  value: unknown,
): AdmissionBudgetProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdmissionError("invalid_budget", "admission budget projection is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "authorityPreauthSockets",
    "authorityPrompts",
    "prevalidationPurchases",
    "evidenceBytes",
    "directTreasuryRetries",
  ];
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new AdmissionError("invalid_budget", "admission budget projection is incomplete");
  }
  const result = Object.fromEntries(
    keys.map((key) => [key, positiveBudget(record[key], key)]),
  ) as unknown as AdmissionBudgetProjection;
  return Object.freeze(result);
}

function positiveBudget(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AdmissionError("invalid_budget", `${label} admission budget is invalid`);
  }
  return value as number;
}
