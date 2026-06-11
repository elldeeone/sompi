/**
 * Wire types for the sompi x402 flow.
 *
 * Tab-based by design: KIP-9 storage mass makes sub-KAS on-chain sends pay
 * >1% fees, so clients deposit once (>= minDepositSompi) into a per-tab
 * address and the server charges requests against that credit off-chain.
 */

/** Body of an HTTP 402 response. */
export interface PaymentRequired {
  x402Version: 1;
  accepts: PaymentOffer[];
}

export interface PaymentOffer {
  scheme: "kaspa-tab";
  network: string;
  /** Deposit address unique to this tab. */
  payTo: string;
  /** Minimum first deposit, in sompi (chosen so fee overhead stays low). */
  minDepositSompi: string;
  /** Price charged against the tab per request, in sompi. */
  pricePerRequestSompi: string;
  /** Opaque tab identifier; echo it back in the X-Payment header. */
  tabId: string;
  description?: string;
}

/** JSON carried in the X-Payment request header (base64-encoded). */
export interface PaymentHeader {
  scheme: "kaspa-tab";
  tabId: string;
  /** Optional txid hint after a fresh deposit (server verifies on-chain regardless). */
  depositTxid?: string;
}

export const X_PAYMENT_HEADER = "x-payment";
export const X_PAYMENT_RESPONSE_HEADER = "x-payment-response";

export function encodePaymentHeader(p: PaymentHeader): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

export function decodePaymentHeader(value: string): PaymentHeader {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}
