/**
 * The SompiEscrow covenant template, byte-pinned.
 *
 * Compiled output of `escrow.sil` (SompiEscrow) with the three constructor
 * values — client pubkey, server pubkey, timeout — as fill-in slots, plus the
 * voucher/spend encodings. Verified byte-for-byte against the SilverScript
 * compiler in CI (scripts/escrow-fixtures.json, regenerate with
 * `vault-driver escrow-dump`).
 *
 * Trust model:
 *   claim  (selector 0): server closes with the client's latest voucher
 *     (checkDataSig over sha256(amount_le8)); takes at most the authorized
 *     amount, remainder returns to escrow.
 *   refund (selector 1): client reclaims everything after `timeout`.
 */
import { hexToBytes, bytesToHex, pushData, pushNumber } from "../vault/template";

const SEG_0 = "6b6c76009c63755279";
const SEG_1 = "ac697878a8";
const SEG_2 = "d76976b4529c6900c278a16951c3b9bf876951c2b9be527994a269007a75757575516776519c637576";
const SEG_3 = "ac69";
const SEG_4 = "b07551677500696868";

export const ESCROW_TEMPLATE_VERSION = "sompi-escrow-1";

/** Build the escrow redeem script. Slot order in-script: server, client, client, timeout. */
export function buildEscrowRedeemScript(clientPublicHex: string, serverPublicHex: string, timeout: bigint): Uint8Array {
  const client = hexToBytes(clientPublicHex);
  const server = hexToBytes(serverPublicHex);
  if (client.length !== 32 || server.length !== 32) throw new Error("public keys must be 32-byte x-only (64 hex chars)");
  if (timeout < 0n) throw new Error("timeout must be non-negative");
  return concat(
    hexToBytes(SEG_0),
    pushData(server),
    hexToBytes(SEG_1),
    pushData(client),
    hexToBytes(SEG_2),
    pushData(client),
    hexToBytes(SEG_3),
    pushNumber(timeout),
    hexToBytes(SEG_4)
  );
}

/** Argument blob for the server's claim: serverSig(65) + voucher(64) + amount(8) + selector. */
export function buildClaimArgs(serverSig65: Uint8Array, voucher64: Uint8Array, amountLe8: Uint8Array): Uint8Array {
  if (serverSig65.length !== 65) throw new Error("server signature must be 65 bytes");
  if (voucher64.length !== 64) throw new Error("voucher (datasig) must be 64 bytes");
  if (amountLe8.length !== 8) throw new Error("amount must be 8 bytes (little-endian u64)");
  return concat(pushData(serverSig65), pushData(voucher64), pushData(amountLe8), Uint8Array.of(0x00));
}

/** Argument blob for the client's timeout refund: clientSig(65) + selector. */
export function buildRefundArgs(clientSig65: Uint8Array): Uint8Array {
  if (clientSig65.length !== 65) throw new Error("client signature must be 65 bytes");
  return concat(pushData(clientSig65), Uint8Array.of(0x51));
}

/** Encode a claim amount as the 8-byte little-endian message the client signs (over sha256). */
export function amountToLe8(amountSompi: bigint): Uint8Array {
  if (amountSompi < 0n || amountSompi > 0xffffffffffffffffn) throw new Error("amount out of u64 range");
  const out = new Uint8Array(8);
  let v = amountSompi;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
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

export { bytesToHex, hexToBytes };
