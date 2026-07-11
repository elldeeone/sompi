export const PAYMENT_FINALITIES = ["mempool", "accepted", "confirmed"] as const;
export type PaymentFinality = (typeof PAYMENT_FINALITIES)[number];

const FINALITY_RANK: Readonly<Record<PaymentFinality, number>> = Object.freeze({
  mempool: 0,
  accepted: 1,
  confirmed: 2,
});

export function requirePaymentFinality(value: string, label = "payment finality"): PaymentFinality {
  if (!Object.prototype.hasOwnProperty.call(FINALITY_RANK, value)) {
    throw new Error(`${label} is unsupported`);
  }
  return value as PaymentFinality;
}

export function paymentFinalityMeets(actual: string, required: string): boolean {
  const actualFinality = requirePaymentFinality(actual, "actual payment finality");
  const requiredFinality = requirePaymentFinality(required, "required payment finality");
  return FINALITY_RANK[actualFinality] >= FINALITY_RANK[requiredFinality];
}
