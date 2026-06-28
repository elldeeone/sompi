/**
 * The SompiEscrow covenant template, derived from SilverScript compiler output.
 *
 * Compiled shape of `contracts/escrow.sil` (SompiEscrow) with the constructor
 * values — client pubkey, server pubkey, network hash, timeout — as fill-in
 * slots, plus the voucher/spend encodings.
 *
 * Trust model:
 *   claim  (selector 0): server closes with the client's latest voucher.
 *     The voucher is a BIP340 signature over a domain-separated message:
 *       sha256(domain32 || network32 || sha256(serialized inputSpk) || txid32 || vout4 || amount8)
 *     verified on-chain by OpCheckSigFromStack. Because the message commits to
 *     the full outpoint of the escrow UTXO being spent, the voucher is
 *     single-use: after a claim the change returns to escrow under a NEW
 *     outpoint, so the same voucher no longer verifies and consensus rejects
 *     any replay/drain. The server takes at most the authorized amount; the
 *     remainder returns to escrow.
 *   refund (selector 1): client reclaims everything after `timeout` (CLTV).
 *
 * The voucher message binding (txid + vout) is what makes the channel
 * trust-minimized: see scripts/escrow-live.js for the live proof harness that
 * submits the replay/drain attempt to a node.
 *
 * Redeem layout (slot order: server, network-id-hash, client, client, timeout):
 *   SEG_0  6b6c76009c63755279
 *          push(server)
 *   SEG_1  ac6978201543...0e906a
 *          push(network-id-hash)
 *   SEG_2  7eb9bfa87eb9ba7eb9bb54cd7e52797ea8
 *          push(client)            ; CheckSigFromStack pubkey
 *   SEG_3  d76976b4529c69...637576
 *          push(client)            ; refund CheckSig pubkey
 *   SEG_4  ac69
 *          push(timeout)
 *   SEG_5  b07551677500696868
 *
 * Disassembly of the claim path (data stack starts [serverSig, voucher, amount, selector]):
 *   6b 6c            ToAltStack/FromAltStack (normalize selector)
 *   76 00 9c 63      Dup Op0 NumEqual If         ; selector == 0 -> claim
 *   75               Drop selector
 *   52 79            Op2 Pick  -> copy serverSig
 *   <push server>
 *   ac 69            CheckSig Verify             ; server authorized this tx
 *   78               Over      -> copy voucher (the datasig)
 *   <push domain32>  ; sha256("sompi:escrow-voucher:v2")
 *   <push network32>
 *   7e               OpCat     -> domain || network
 *   b9 bf a8         TxInputIndex TxInputSpk SHA256
 *   7e               OpCat     -> ... || sha256(serialized input scriptPubKey)
 *   b9 ba            TxInputIndex OutpointTxId   ; txid of the spent UTXO
 *   7e               OpCat     -> ... || txid
 *   b9 bb 54 cd      TxInputIndex OutpointIndex Op4 Num2Bin ; fixed vout_le4
 *   7e               OpCat     -> ... || vout_le4
 *   52 79            Op2 Pick  -> copy amount (byte[8])
 *   7e               OpCat     -> ... || amount
 *   a8               SHA256    -> message
 *   <push client>
 *   d7 69            CheckSigFromStack Verify
 *   76 b4 52 9c 69   Dup TxOutputCount Op2 NumEqual Verify ; exactly 2 outputs
 *   00 c2 78 a1 69   outputs[0].value <= amount  (server claim bounded)
 *   51 c3 b9 bf 87 69  outputs[1].spk == input.spk (change returns to escrow)
 *   51 c2 b9 be 52 79 94 a2 69  outputs[1].value >= input - amount (remainder preserved)
 *   00 7a 75 75 75 75 51  Op0 Rot Drop x4, push true
 */
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes, bytesToHex, pushData, pushNumber } from "../vault/template";

const SEG_0 = "6b6c76009c63755279";
const SEG_1 = "ac69782015436b1356689a0646b884da4d7599ba22dc8b49336224e48983e8e0c90e906a";
const SEG_2 = "7eb9bfa87eb9ba7eb9bb54cd7e52797ea8";
const SEG_3 = "d76976b4529c6900c278a16951c3b9bf876951c2b9be527994a269007a75757575516776519c637576";
const SEG_4 = "ac69";
const SEG_5 = "b07551677500696868";

export const ESCROW_TEMPLATE_VERSION = "sompi-escrow-1";
export const ESCROW_VOUCHER_DOMAIN = "sompi:escrow-voucher:v2";

/** Build the escrow redeem script. Slot order in-script: server, network, client, client, timeout. */
export function buildEscrowRedeemScript(
  clientPublicHex: string,
  serverPublicHex: string,
  timeout: bigint,
  networkId: string
): Uint8Array {
  const client = hexToBytes(clientPublicHex);
  const server = hexToBytes(serverPublicHex);
  if (client.length !== 32 || server.length !== 32) throw new Error("public keys must be 32-byte x-only (64 hex chars)");
  if (timeout < 0n) throw new Error("timeout must be non-negative");
  return concat(
    hexToBytes(SEG_0),
    pushData(server),
    hexToBytes(SEG_1),
    pushData(networkIdHash(networkId)),
    hexToBytes(SEG_2),
    pushData(client),
    hexToBytes(SEG_3),
    pushData(client),
    hexToBytes(SEG_4),
    pushNumber(timeout),
    hexToBytes(SEG_5)
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

/** Encode a claim amount as the 8-byte little-endian value used in the voucher message and claim args. */
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

/** Encode a transaction output index as the fixed 4-byte little-endian value used in voucher messages. */
export function outpointIndexToLe4(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error("outpoint index out of u32 range");
  const out = new Uint8Array(4);
  let v = index >>> 0;
  for (let i = 0; i < 4; i++) {
    out[i] = v & 0xff;
    v >>>= 8;
  }
  return out;
}

export function voucherDomainTag(): Uint8Array {
  return sha256(Buffer.from(ESCROW_VOUCHER_DOMAIN, "utf8"));
}

export function networkIdHash(networkId: string): Uint8Array {
  if (!networkId) throw new Error("network id is required");
  return sha256(Buffer.from(networkId, "utf8"));
}

/**
 * The preimage for the 32-byte voucher message digest the client signs.
 *
 * The claim script reconstructs exactly this byte string from constants and
 * transaction introspection, then checks the BIP340 signature over sha256(...).
 */
export function voucherMessage(
  networkId: string,
  escrowScriptPubKeyHash: Uint8Array,
  outpointTxidHex: string,
  outpointIndex: number,
  amountSompi: bigint
): Uint8Array {
  const txid = hexToBytes(outpointTxidHex);
  if (txid.length !== 32) throw new Error("outpoint txid must be 32 bytes (64 hex chars)");
  if (escrowScriptPubKeyHash.length !== 32) throw new Error("escrow scriptPubKey hash must be 32 bytes");
  return concat(
    voucherDomainTag(),
    networkIdHash(networkId),
    escrowScriptPubKeyHash,
    txid,
    outpointIndexToLe4(outpointIndex),
    amountToLe8(amountSompi)
  );
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
