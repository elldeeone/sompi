import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import {
  PrivateKey,
  SighashType,
  Transaction,
  addressFromScriptPublicKey,
  createInputSignature,
  payToAddressScript,
  payToScriptHashScript,
  payToScriptHashSignatureScript,
} from "../kaspa-wasm.js";
import type { KaspaWallet } from "../wallet.js";
import {
  amountToLe8,
  bytesToHex,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  hexToBytes,
  voucherMessage,
} from "./escrow-template.js";
import { estimateVaultSpendFeeSompi } from "../vault.js";

/**
 * Trust-minimized kaspa-escrow payment channel backed by the SompiEscrow
 * covenant, pure JS.
 *
 * The client funds an escrow address once. As it consumes requests it issues
 * off-chain vouchers — BIP340 schnorr signatures over a domain-separated
 * message bound to network, serialized escrow scriptPubKey, full outpoint, and amount —
 * authorizing a running claim total for one UTXO. The server closes with the
 * latest voucher (taking at most the authorized amount, change back to escrow);
 * the client reclaims everything after the timeout if the server goes silent.
 * Neither party has to trust the other.
 */

const SUBNETWORK_NATIVE = "00".repeat(20);

export interface EscrowParams {
  clientPublic: string; // 32-byte x-only hex
  serverPublic: string; // 32-byte x-only hex
  timeout: bigint; // DAA score / locktime after which client may refund
}

export interface EscrowOutpoint {
  txid: string;
  index: number;
}

/** Channel keypair (x-only public, raw private) for one escrow party. */
export function generateChannelKey(): { privateKey: string; publicKey: string } {
  const priv = schnorr.utils.randomPrivateKey();
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(schnorr.getPublicKey(priv)) };
}

function escrowRedeemScript(params: EscrowParams, networkId: string): Uint8Array {
  return buildEscrowRedeemScript(params.clientPublic, params.serverPublic, params.timeout, networkId);
}

function escrowScriptPublicKey(params: EscrowParams, networkId: string): any {
  return payToScriptHashScript(escrowRedeemScript(params, networkId));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function scriptPublicKeyBytes(spk: any): Uint8Array {
  const script = hexToBytes(String(spk.script));
  const version = Number(spk.version ?? 0);
  if (!Number.isInteger(version) || version < 0 || version > 0xffff) {
    throw new Error(`invalid scriptPublicKey version: ${spk.version}`);
  }
  return concatBytes(Uint8Array.of(version & 0xff, (version >>> 8) & 0xff), script);
}

export function escrowScriptPubKeyHash(params: EscrowParams, networkId: string): Uint8Array {
  return sha256(scriptPublicKeyBytes(escrowScriptPublicKey(params, networkId)));
}

export function deriveEscrowAddress(params: EscrowParams, networkId: string): string {
  const address = addressFromScriptPublicKey(escrowScriptPublicKey(params, networkId), networkId);
  if (!address) throw new Error("could not derive escrow address");
  return address.toString();
}

/**
 * Client-side: produce a voucher authorizing the server to claim up to
 * `amountSompi` from the escrow UTXO at `outpoint`. Vouchers are
 * cumulative — issue a fresh one for the new running total each time the client
 * consumes more service.
 *
 * The voucher commits to domain, network, serialized escrow scriptPubKey hash, full
 * outpoint, and amount, so it is single-use and script-specific.
 */
export function makeVoucher(
  clientPrivateHex: string,
  params: EscrowParams,
  networkId: string,
  outpoint: EscrowOutpoint,
  amountSompi: bigint
): { amountSompi: string; voucherHex: string; outpointTxid: string; outpointIndex: number } {
  const sig = schnorr.sign(
    sha256(voucherMessage(networkId, escrowScriptPubKeyHash(params, networkId), outpoint.txid, outpoint.index, amountSompi)),
    hexToBytes(clientPrivateHex)
  );
  return {
    amountSompi: amountSompi.toString(),
    voucherHex: bytesToHex(sig),
    outpointTxid: outpoint.txid,
    outpointIndex: outpoint.index,
  };
}

/** Verify a voucher off-chain (server checks before serving). Mirrors the on-chain check. */
export function verifyVoucher(
  params: EscrowParams,
  networkId: string,
  outpoint: EscrowOutpoint,
  amountSompi: bigint,
  voucherHex: string
): boolean {
  try {
    return schnorr.verify(
      hexToBytes(voucherHex),
      sha256(voucherMessage(networkId, escrowScriptPubKeyHash(params, networkId), outpoint.txid, outpoint.index, amountSompi)),
      hexToBytes(params.clientPublic)
    );
  } catch {
    return false;
  }
}

interface EscrowUtxo {
  txid: string;
  index: number;
  amount: bigint;
}

export class EscrowUtxoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowUtxoNotFoundError";
  }
}

async function escrowUtxo(wallet: KaspaWallet, address: string, outpoint?: EscrowOutpoint): Promise<EscrowUtxo> {
  const rpc = await wallet.client();
  const { entries } = await rpc.getUtxosByAddresses([address]);
  if (!entries.length) throw new EscrowUtxoNotFoundError(`escrow ${address} has no UTXOs; fund it first`);
  const utxos = (entries as any[])
    .map((e) => ({
      txid: String(e?.outpoint?.transactionId ?? e?.entry?.outpoint?.transactionId),
      index: Number(e?.outpoint?.index ?? e?.entry?.outpoint?.index),
      amount: BigInt(e?.amount ?? e?.entry?.amount ?? 0),
    }))
    .sort((a, b) => (a.amount > b.amount ? -1 : 1));
  if (!outpoint) return utxos[0];
  const exact = utxos.find((u) => u.txid === outpoint.txid && u.index === outpoint.index);
  if (!exact) throw new EscrowUtxoNotFoundError(`escrow ${address} has no UTXO ${outpoint.txid}:${outpoint.index}`);
  return exact;
}

/**
 * The funding outpoint of the (largest) UTXO at the escrow address, plus its
 * value. Pass `outpoint` to require an exact UTXO rather than selecting the
 * largest one.
 */
export async function escrowFunding(
  wallet: KaspaWallet,
  params: EscrowParams,
  outpoint?: EscrowOutpoint
): Promise<{ txid: string; index: number; amountSompi: bigint }> {
  const utxo = await escrowUtxo(wallet, deriveEscrowAddress(params, wallet.networkId), outpoint);
  return { txid: utxo.txid, index: utxo.index, amountSompi: utxo.amount };
}

// Post-Toccata the live node meters runtime script units at ~100_000 per
// committed sigop. The claim path runs two signature ops (checkSig +
// checkSigFromStack) plus OpSHA256/introspection (~200_544 units), so it must
// commit 3; the refund path runs a single checkSig and commits 1.
function inputBase(utxo: EscrowUtxo, escrowSpk: any, sequence: bigint, sigOpCount: number) {
  return {
    previousOutpoint: { transactionId: utxo.txid, index: utxo.index },
    sequence,
    sigOpCount,
    utxo: {
      outpoint: { transactionId: utxo.txid, index: utxo.index },
      amount: utxo.amount,
      scriptPublicKey: escrowSpk,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

/**
 * Server-side: close the channel by claiming `claimSompi` (≤ the voucher
 * amount) to `destination`, with the remainder returning to escrow. Fee comes
 * out of the server's own output.
 */
export async function claimEscrow(
  wallet: KaspaWallet,
  params: EscrowParams,
  serverPrivateHex: string,
  voucher: { amountSompi: bigint; voucherHex: string; outpointTxid: string; outpointIndex: number },
  claimSompi: bigint,
  destination: string,
  feeSompi?: bigint
): Promise<string> {
  if (claimSompi > voucher.amountSompi) {
    throw new Error(`claim ${displayAmount(claimSompi)} exceeds voucher authorization ${displayAmount(voucher.amountSompi)}`);
  }
  const redeem = escrowRedeemScript(params, wallet.networkId);
  const escrowSpk = payToScriptHashScript(redeem);
  const outpoint = { txid: voucher.outpointTxid, index: voucher.outpointIndex };
  const utxo = await escrowUtxo(wallet, deriveEscrowAddress(params, wallet.networkId), outpoint);
  const rpc = await wallet.client();

  // The voucher must authorize the claim against THIS specific UTXO.
  // Consensus enforces the same binding via OpCheckSigFromStack; verifying here
  // first turns a guaranteed on-chain rejection into a clear local error.
  if (!verifyVoucher(params, wallet.networkId, outpoint, voucher.amountSompi, voucher.voucherHex)) {
    throw new Error(
      `voucher does not authorize claiming escrow outpoint ${utxo.txid.slice(0, 16)}:${utxo.index} ` +
        `for ${displayAmount(voucher.amountSompi)} (wrong context, outpoint, amount, or client key)`
    );
  }

  const destSpk = payToAddressScript(destination);
  // Estimate the claim fee from the node (the demo's per-request price can be
  // smaller than a flat fee, so a realistic estimate matters).
  let resolvedFee = feeSompi;
  if (resolvedFee === undefined) {
    const est = await rpc.getFeeEstimate();
    const feerate = est.estimate?.normalBuckets?.[0]?.feerate ?? 100;
    resolvedFee = estimateVaultSpendFeeSompi(
      utxo.amount,
      [
        { value: claimSompi, spkScriptLen: String(destSpk.script).length / 2 },
        { value: utxo.amount - claimSompi, spkScriptLen: String(escrowSpk.script).length / 2 },
      ],
      redeem.length,
      feerate
    );
  }
  if (claimSompi <= resolvedFee) {
    throw new Error(
      `claim ${displayAmount(claimSompi)} does not cover the estimated fee ${displayAmount(resolvedFee)} — ` +
        `accumulate more before claiming`
    );
  }

  const outputs = [
    { value: claimSompi - resolvedFee, scriptPublicKey: destSpk },
    { value: utxo.amount - claimSompi, scriptPublicKey: escrowSpk },
  ];
  if (outputs.some((o) => o.value <= 0n)) {
    throw new Error(`escrow balance ${displayAmount(utxo.amount)} is too small for this claim`);
  }

  const base = inputBase(utxo, escrowSpk, 0n, 3); // claim: 2 sig ops + sha256/introspection
  const txShape = { version: 0, outputs, lockTime: 0n, subnetworkId: SUBNETWORK_NATIVE, gas: 0n, payload: "" };

  const unsigned = new Transaction({ ...txShape, inputs: [{ ...base, signatureScript: "" }] } as any);
  const pushedSig = createInputSignature(unsigned, 0, new PrivateKey(serverPrivateHex), SighashType.All);
  const serverSig = hexToBytes(pushedSig).slice(1); // strip push-65 opcode

  const args = buildClaimArgs(serverSig, hexToBytes(voucher.voucherHex), amountToLe8(voucher.amountSompi));
  const signatureScript = payToScriptHashSignatureScript(redeem, args);
  const transaction = { ...txShape, inputs: [{ ...base, signatureScript }] };
  const { transactionId } = await (rpc as any).submitTransaction({ transaction, allowOrphan: false });
  return String(transactionId);
}

/**
 * Client-side: reclaim the full escrow balance after the timeout. The spending
 * transaction's lockTime must be >= the escrow timeout and the input must not
 * be finalized (sequence < max), per OP_CHECKLOCKTIMEVERIFY.
 */
export async function refundEscrow(
  wallet: KaspaWallet,
  params: EscrowParams,
  clientPrivateHex: string,
  destination: string,
  feeSompi?: bigint
): Promise<string> {
  const redeem = escrowRedeemScript(params, wallet.networkId);
  const escrowSpk = payToScriptHashScript(redeem);
  const utxo = await escrowUtxo(wallet, deriveEscrowAddress(params, wallet.networkId));
  const rpc = await wallet.client();

  const info = await rpc.getServerInfo();
  const daa = BigInt(info.virtualDaaScore);
  if (daa < params.timeout) {
    throw new Error(`refund unavailable until DAA ${params.timeout}; current ${daa}`);
  }

  const destSpk = payToAddressScript(destination);
  let resolvedFee = feeSompi;
  if (resolvedFee === undefined) {
    const est = await rpc.getFeeEstimate();
    const feerate = est.estimate?.normalBuckets?.[0]?.feerate ?? 100;
    resolvedFee = estimateVaultSpendFeeSompi(
      utxo.amount,
      [{ value: utxo.amount, spkScriptLen: String(destSpk.script).length / 2 }],
      redeem.length,
      feerate
    );
  }
  const outputs = [{ value: utxo.amount - resolvedFee, scriptPublicKey: destSpk }];
  if (outputs[0].value <= 0n) {
    throw new Error(`escrow balance ${displayAmount(utxo.amount)} is too small for refund fee ${displayAmount(resolvedFee)}`);
  }

  // lockTime = timeout satisfies `tx.time >= timeout`; sequence 0 keeps the input non-final.
  const base = inputBase(utxo, escrowSpk, 0n, 1); // refund: single checkSig
  const txShape = { version: 0, outputs, lockTime: params.timeout, subnetworkId: SUBNETWORK_NATIVE, gas: 0n, payload: "" };

  const unsigned = new Transaction({ ...txShape, inputs: [{ ...base, signatureScript: "" }] } as any);
  const pushedSig = createInputSignature(unsigned, 0, new PrivateKey(clientPrivateHex), SighashType.All);
  const clientSig = hexToBytes(pushedSig).slice(1);

  const signatureScript = payToScriptHashSignatureScript(redeem, buildRefundArgs(clientSig));
  const transaction = { ...txShape, inputs: [{ ...base, signatureScript }] };
  const { transactionId } = await (rpc as any).submitTransaction({ transaction, allowOrphan: false });
  return String(transactionId);
}

function displayAmount(sompi: bigint): string {
  return `${formatKas(sompi)} KAS (${sompi} sompi)`;
}

function formatKas(sompi: bigint): string {
  const sign = sompi < 0n ? "-" : "";
  const absolute = sompi < 0n ? -sompi : sompi;
  const whole = absolute / 100_000_000n;
  const fraction = (absolute % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}
