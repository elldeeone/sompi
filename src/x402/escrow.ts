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
} from "../../vendor/kaspa-wasm/kaspa";
import type { KaspaWallet } from "../wallet";
import {
  amountToLe8,
  bytesToHex,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  hexToBytes,
} from "./escrow-template";
import { estimateVaultSpendFeeSompi } from "../vault";

/**
 * Trust-minimized x402 payment channel (SompiEscrow covenant), pure JS.
 *
 * The client funds an escrow address once. As it consumes requests it issues
 * off-chain vouchers — BIP340 schnorr signatures over sha256(amount_le8) —
 * authorizing a running claim total. The server closes with the latest voucher
 * (taking at most the authorized amount, change back to escrow); the client
 * reclaims everything after the timeout if the server goes silent. Neither
 * party has to trust the other.
 */

const SUBNETWORK_NATIVE = "00".repeat(20);

export interface EscrowParams {
  clientPublic: string; // 32-byte x-only hex
  serverPublic: string; // 32-byte x-only hex
  timeout: bigint; // DAA score / locktime after which client may refund
}

/** Channel keypair (x-only public, raw private) for one escrow party. */
export function generateChannelKey(): { privateKey: string; publicKey: string } {
  const priv = schnorr.utils.randomPrivateKey();
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(schnorr.getPublicKey(priv)) };
}

export function deriveEscrowAddress(params: EscrowParams, networkId: string): string {
  const redeem = buildEscrowRedeemScript(params.clientPublic, params.serverPublic, params.timeout);
  const address = addressFromScriptPublicKey(payToScriptHashScript(redeem), networkId);
  if (!address) throw new Error("could not derive escrow address");
  return address.toString();
}

/**
 * Client-side: produce a voucher authorizing the server to claim up to
 * `amountSompi`. Vouchers are cumulative — issue a fresh one for the new
 * running total each time the client consumes more service.
 */
export function makeVoucher(clientPrivateHex: string, amountSompi: bigint): { amountSompi: string; voucherHex: string } {
  const amountLe8 = amountToLe8(amountSompi);
  const sig = schnorr.sign(sha256(amountLe8), hexToBytes(clientPrivateHex));
  return { amountSompi: amountSompi.toString(), voucherHex: bytesToHex(sig) };
}

/** Verify a voucher off-chain (server checks before serving). */
export function verifyVoucher(clientPublicHex: string, amountSompi: bigint, voucherHex: string): boolean {
  try {
    return schnorr.verify(hexToBytes(voucherHex), sha256(amountToLe8(amountSompi)), hexToBytes(clientPublicHex));
  } catch {
    return false;
  }
}

interface EscrowUtxo {
  txid: string;
  index: number;
  amount: bigint;
}

async function escrowUtxo(wallet: KaspaWallet, address: string): Promise<EscrowUtxo> {
  const rpc = await wallet.client();
  const { entries } = await rpc.getUtxosByAddresses([address]);
  if (!entries.length) throw new Error(`escrow ${address} has no UTXOs; fund it first`);
  return (entries as any[])
    .map((e) => ({
      txid: String(e?.outpoint?.transactionId ?? e?.entry?.outpoint?.transactionId),
      index: Number(e?.outpoint?.index ?? e?.entry?.outpoint?.index),
      amount: BigInt(e?.amount ?? e?.entry?.amount ?? 0),
    }))
    .sort((a, b) => (a.amount > b.amount ? -1 : 1))[0];
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
  voucher: { amountSompi: bigint; voucherHex: string },
  claimSompi: bigint,
  destination: string,
  feeSompi?: bigint
): Promise<string> {
  if (claimSompi > voucher.amountSompi) {
    throw new Error(`claim ${claimSompi} exceeds voucher authorization ${voucher.amountSompi}`);
  }
  if (!verifyVoucher(params.clientPublic, voucher.amountSompi, voucher.voucherHex)) {
    throw new Error("voucher signature does not verify against the client public key");
  }
  const redeem = buildEscrowRedeemScript(params.clientPublic, params.serverPublic, params.timeout);
  const escrowSpk = payToScriptHashScript(redeem);
  const utxo = await escrowUtxo(wallet, deriveEscrowAddress(params, wallet.networkId));
  const rpc = await wallet.client();

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
      `claim ${claimSompi} sompi does not cover the estimated fee ${resolvedFee} sompi — ` +
        `accumulate more before claiming`
    );
  }

  const outputs = [
    { value: claimSompi - resolvedFee, scriptPublicKey: destSpk },
    { value: utxo.amount - claimSompi, scriptPublicKey: escrowSpk },
  ];
  if (outputs.some((o) => o.value <= 0n)) throw new Error("escrow UTXO too small for this claim");

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
  const redeem = buildEscrowRedeemScript(params.clientPublic, params.serverPublic, params.timeout);
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
  if (outputs[0].value <= 0n) throw new Error("escrow UTXO too small to refund");

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
