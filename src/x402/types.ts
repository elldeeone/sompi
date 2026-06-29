/**
 * Wire types for the sompi x402 flow.
 *
 * Escrow by design: KIP-9 storage mass makes sub-KAS on-chain sends inefficient,
 * so clients deposit once into a covenant escrow and pay each request with a
 * cumulative off-chain voucher.
 */

/** Body of an HTTP 402 response. */
export interface PaymentRequired {
  x402Version: 1;
  accepts: PaymentOffer[];
}

export type PaymentOffer = KaspaEscrowOffer;

export interface KaspaEscrowOffer {
  scheme: "kaspa-escrow";
  network: string;
  serverPublic: string;
  refundTimeout: string;
  minDepositSompi: string;
  pricePerRequestSompi: string;
  description?: string;
}

/** JSON carried in the X-Payment request header (base64-encoded). */
export type PaymentHeader = KaspaEscrowPaymentHeader;

export interface KaspaEscrowPaymentHeader {
  scheme: "kaspa-escrow";
  clientPublic: string;
  voucherAmountSompi: string;
  voucherHex: string;
  outpointTxid: string;
  outpointIndex: number;
}

export const X_PAYMENT_HEADER = "x-payment";
export const X_PAYMENT_RESPONSE_HEADER = "x-payment-response";

export function encodePaymentHeader(p: PaymentHeader): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

export function decodePaymentHeader(value: string): PaymentHeader {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}
