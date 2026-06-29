/**
 * The SompiVault covenant template, derived from SilverScript compiler output.
 *
 * The mutable state is encoded as two fixed-width int fields:
 *   - windowStart: DAA score at which the active window began
 *   - spentInWindow: cumulative outflow in the active window
 *
 * Static parameters are agent pubkey, owner pubkey, maxOutflow, and
 * windowSize. The agent path requires a covenant-bound singleton UTXO and
 * validates exactly one covenant continuation with updated state.
 */

const SEGMENT_0 = "6b";
const SEGMENT_1 = "6c76009c63755279";
const SEGMENT_2 =
  "ac69b3519c69b9bd0058cd8769b4529c69b9cf76d0519c697600d1b99c6976d2519c697600d376519c69b9be78c2947600a26954795479527993b55779";
const SEGMENT_3 = "93a2b5b9c0";
const SEGMENT_4 = "93a29a63b57b7552797b756876";
const SEGMENT_5 =
  "a16978787858cd01087c7e7858cd01087c7e7eb976c9";
const SEGMENT_6 =
  "94765193bc7c7eb976c976";
const SEGMENT_7 = "940113937cbc7eaa02000001aa7e01207e7c7e01877e5679c38769007a75007a75007a75007a75007a75007a75007a75757575516776519c63755279";
const SEGMENT_8 =
  "ac69b352a269b9009c69b9bd0058cd8769b9cf76d0519c697600d1b99c6976d2519c697600d376009c6976c2b9bea26953795379b55679";
const SEGMENT_9 = "93a2b5b9c0";
const SEGMENT_10 = "93a29a63b57b75007b756878787858cd01087c7e7858cd01087c7e7eb976c9";
const SEGMENT_11 = "94765193bc7c7eb976c976";
const SEGMENT_12 = "940113937cbc7eaa02000001aa7e01207e7c7e01877e5579c38769007a75007a75007a75007a75007a75007a75757575516776529c63755279";
const SEGMENT_13 = "ac697575755167750069686868";

const SCRIPT_BASE_LEN = 482;

export const VAULT_TEMPLATE_VERSION = "sompi-vault-1";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) throw new Error(`invalid hex: ${hex.slice(0, 40)}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Minimal data push (OpDataN / OpPushData1/2). */
export function pushData(data: Uint8Array): Uint8Array {
  if (data.length <= 75) return concat(Uint8Array.of(data.length), data);
  if (data.length <= 0xff) return concat(Uint8Array.of(0x4c, data.length), data);
  if (data.length <= 0xffff) return concat(Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8), data);
  throw new Error("data too large for push");
}

/** Minimal script-number push (Op0/Op1..Op16/minimal little-endian). */
export function pushNumber(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative numbers not supported");
  if (value === 0n) return Uint8Array.of(0x00);
  if (value <= 16n) return Uint8Array.of(0x50 + Number(value));
  const bytes: number[] = [];
  let v = value;
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return pushData(Uint8Array.from(bytes));
}

function pushStateInt(value: bigint): Uint8Array {
  if (value < 0n || value > 0x7fffffffffffffffn) throw new Error("state int out of signed 64-bit range");
  const bytes = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return pushData(bytes);
}

export interface VaultState {
  windowStartDaa: bigint;
  spentInWindowSompi: bigint;
}

/** Build the vault redeem script for the given static parameters and state. */
export function buildRedeemScript(
  agentPublicHex: string,
  ownerPublicHex: string,
  maxOutflowSompi: bigint,
  windowSizeDaa: bigint,
  state: VaultState
): Uint8Array {
  const agent = hexToBytes(agentPublicHex);
  const owner = hexToBytes(ownerPublicHex);
  if (agent.length !== 32 || owner.length !== 32) throw new Error("public keys must be 32-byte x-only (64 hex chars)");
  if (maxOutflowSompi <= 0n) throw new Error("maxOutflowSompi must be positive");
  if (windowSizeDaa <= 0n) throw new Error("windowSizeDaa must be positive");
  const maxOutflowPush = pushNumber(maxOutflowSompi);
  const windowSizePush = pushNumber(windowSizeDaa);
  const scriptSizePush = pushNumber(BigInt(SCRIPT_BASE_LEN + maxOutflowPush.length + 4 * windowSizePush.length));
  return concat(
    hexToBytes(SEGMENT_0),
    pushStateInt(state.windowStartDaa),
    pushStateInt(state.spentInWindowSompi),
    hexToBytes(SEGMENT_1),
    pushData(agent),
    hexToBytes(SEGMENT_2),
    windowSizePush,
    hexToBytes(SEGMENT_3),
    windowSizePush,
    hexToBytes(SEGMENT_4),
    maxOutflowPush,
    hexToBytes(SEGMENT_5),
    scriptSizePush,
    hexToBytes(SEGMENT_6),
    scriptSizePush,
    hexToBytes(SEGMENT_7),
    pushData(agent),
    hexToBytes(SEGMENT_8),
    windowSizePush,
    hexToBytes(SEGMENT_9),
    windowSizePush,
    hexToBytes(SEGMENT_10),
    scriptSizePush,
    hexToBytes(SEGMENT_11),
    scriptSizePush,
    hexToBytes(SEGMENT_12),
    pushData(owner),
    hexToBytes(SEGMENT_13)
  );
}

/**
 * Entrypoint argument blob for a vault spend: push(signature) + selector.
 * Wrap with payToScriptHashSignatureScript(redeemScript, blob) to form the
 * full signature script.
 */
export function buildSigArgs(signature: Uint8Array, fn: "withdraw" | "topup" | "recover"): Uint8Array {
  if (signature.length !== 65) throw new Error("expected 65-byte signature (64-byte schnorr + sighash type)");
  const selector = fn === "withdraw" ? Uint8Array.of(0x00) : fn === "topup" ? Uint8Array.of(0x51) : Uint8Array.of(0x52);
  return concat(pushData(signature), selector);
}

export { bytesToHex, hexToBytes };
