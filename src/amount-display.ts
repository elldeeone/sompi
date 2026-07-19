const SOMPI_PER_KAS = 100_000_000n;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;

export type KasDisplayUnit = "KAS" | "tKAS";

export interface KasAmountView {
  /** Exact unsigned integer used by consensus and durable accounting. */
  readonly atomic: string;
  /** Exact decimal KAS value with no insignificant trailing zeroes. */
  readonly kas: string;
  readonly unit: KasDisplayUnit;
  /** Default human and agent presentation. */
  readonly display: string;
}

export function kasAmountView(
  atomic: string | bigint,
  network: "kaspa:testnet-10" | "kaspa:mainnet" = "kaspa:testnet-10",
): KasAmountView {
  const canonical = typeof atomic === "bigint" ? atomic.toString() : atomic;
  if (!ATOMIC.test(canonical)) throw new Error("KAS amount must be a canonical non-negative atomic integer");
  const value = BigInt(canonical);
  const kas = formatKas(value);
  const unit = network === "kaspa:mainnet" ? "KAS" as const : "tKAS" as const;
  return Object.freeze({ atomic: canonical, kas, unit, display: `${kas} ${unit}` });
}

export function formatKas(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / SOMPI_PER_KAS;
  const remainder = absolute % SOMPI_PER_KAS;
  if (remainder === 0n) return `${sign}${whole}`;
  const fraction = remainder.toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fraction}`;
}

export function displayKas(
  atomic: string | bigint,
  network: "kaspa:testnet-10" | "kaspa:mainnet" = "kaspa:testnet-10",
): string {
  return kasAmountView(atomic, network).display;
}

export function displayKasWithAtomic(
  atomic: string | bigint,
  network: "kaspa:testnet-10" | "kaspa:mainnet" = "kaspa:testnet-10",
): string {
  const amount = kasAmountView(atomic, network);
  return `${amount.display} (${amount.atomic} sompi)`;
}

/** Converts a user-facing KAS decimal into the exact positive atomic amount. */
export function parseKasAmount(value: string): string {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(value);
  if (!match) throw new Error("KAS amount must be a positive decimal with at most 8 places");
  const amount = BigInt(match[1]) * SOMPI_PER_KAS + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  if (amount <= 0n || amount > (1n << 64n) - 1n) {
    throw new Error("KAS amount must be positive and inside the supported range");
  }
  return amount.toString();
}
