/**
 * The SompiVault covenant template, byte-pinned.
 *
 * This is the compiled output of `vault.sil` (SompiVault) from the
 * silverscript workspace, with the three constructor values — agent public
 * key, owner public key, max outflow — left as fill-in slots. Agents can
 * only instantiate this audited rule-shape; they cannot author covenant
 * logic. The Rust `vault-driver dump` command is the reference oracle:
 * `npm run test:template-fixtures` asserts byte-equality against fixtures
 * generated from it (see scripts/vault-fixtures.json).
 *
 * Rules encoded by the script:
 *   withdraw (selector 0): requires agent signature; exactly two outputs;
 *     output[1] must pay this same script; output[1].value >= input - maxOutflow.
 *   recover (selector 1): requires owner signature; no other constraints.
 */

const SEGMENT_0 = "6b6c76009c637576";
const SEGMENT_1 = "ac69b4529c6951c3b9bf876951c2b9be";
const SEGMENT_2 = "94a26975516776519c637576";
const SEGMENT_3 = "ac697551677500696868";

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
  // sign-bit padding for positive numbers
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return pushData(Uint8Array.from(bytes));
}

/** Build the vault redeem script for the given constructor values. */
export function buildRedeemScript(agentPublicHex: string, ownerPublicHex: string, maxOutflowSompi: bigint): Uint8Array {
  const agent = hexToBytes(agentPublicHex);
  const owner = hexToBytes(ownerPublicHex);
  if (agent.length !== 32 || owner.length !== 32) throw new Error("public keys must be 32-byte x-only (64 hex chars)");
  if (maxOutflowSompi <= 0n) throw new Error("maxOutflowSompi must be positive");
  return concat(
    hexToBytes(SEGMENT_0),
    pushData(agent),
    hexToBytes(SEGMENT_1),
    pushNumber(maxOutflowSompi),
    hexToBytes(SEGMENT_2),
    pushData(owner),
    hexToBytes(SEGMENT_3)
  );
}

/**
 * Entrypoint argument blob for a vault spend: push(signature) + selector.
 * Wrap with payToScriptHashSignatureScript(redeemScript, blob) to form the
 * full signature script.
 */
export function buildSigArgs(signature: Uint8Array, fn: "withdraw" | "recover"): Uint8Array {
  if (signature.length !== 65) throw new Error("expected 65-byte signature (64-byte schnorr + sighash type)");
  const selector = fn === "withdraw" ? Uint8Array.of(0x00) : Uint8Array.of(0x51);
  return concat(pushData(signature), selector);
}

export { bytesToHex, hexToBytes };
