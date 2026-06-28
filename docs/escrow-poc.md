# SompiEscrow proof-of-concept: on-chain voucher replay protection

**Network:** Kaspa testnet-10 (Toccata active) · **Status:** vulnerability found; current SilverScript compiler-derived template live-proven on 2026-06-28 against node `10.0.3.26`

## Summary

The `kaspa-escrow` scheme for x402-style HTTP payments lets a client fund a
covenant once and pay a server with cumulative off-chain vouchers, with the
promise that **the server can claim at most what the client signed for**. The
first implementation did not deliver that promise on-chain: a malicious server
could drain the entire deposit with a single voucher. This doc records the flaw,
the outpoint-bound fix, and the live proof harness that must be rerun whenever
the compiler-derived escrow template changes.

## The flaw (original design)

The voucher was a BIP340 signature over `sha256(amount_le8)` — it committed to
the amount and nothing else. The claim covenant only enforced, per transaction:

- `outputs[0].value <= authorized` (server takes ≤ the voucher amount), and
- `outputs[1]` returns to the **same** escrow script with `value >= input - authorized`.

Because the change loops back to the same escrow address and the voucher is
bound to nothing but the amount, the **same voucher stays valid against the
change UTXO**. A server claims `authorized`, the change returns to escrow, the
server claims `authorized` again, … draining the whole deposit `authorized`
sompi at a time. The only thing standing in the way was off-chain bookkeeping
(the server's own request counter) and a client-side `claim > voucher` guard —
neither is enforced by consensus.

### Exploit, proven on-chain

`scripts/escrow-exploit.js` funded **3 KAS**, signed **one 1-KAS voucher**, and
replayed it:

| Claim | Result | txid |
|---|---|---|
| #1 | 0.98 KAS extracted | `bcd10b074d2a0016…` |
| #2 (replay vs. change) | **another 0.98 KAS extracted** | `4dedc53403348034…` |

One 1-KAS authorization yielded **~1.96 KAS**, and only stopped because the
remaining balance no longer covered a claim — a larger deposit drains fully. The
"trust-minimized" guarantee was false.

## The fix

Bind every voucher to the **full funding outpoint** and escrow context of the
UTXO it pays from:

```
voucher = schnorr_sign(
  sha256(
    domain_tag32
    ‖ network_id_hash32
    ‖ sha256(serialized_active_input_scriptPublicKey)
    ‖ outpointTxId32
    ‖ outpointIndex_le32
    ‖ amount_le64
  ),
  clientKey
)
```

The covenant reconstructs that exact message on-chain and verifies it:

```
<domain_tag32>
<network_id_hash32>
OpCat
OpTxInputIndex OpTxInputSpk OpSHA256 ; serialized ScriptPublicKey bytes
OpCat
OpTxInputIndex OpOutpointTxId   ; funding txid of the UTXO being spent
OpCat
OpTxInputIndex OpOutpointIndex Op4 OpNum2Bin
OpCat                           ; fixed outpointIndex_le32
<amount from args>
OpCat
OpSHA256
<client pubkey>
OpCheckSigFromStack             ; 0xd7, live in Toccata consensus
```

After a claim, the change returns to escrow under a **new** outpoint (the claim
transaction's output). A replayed voucher now hashes against that new outpoint,
which the client never signed, so `OpCheckSigFromStack` fails and the node
rejects the transaction. A voucher is single-use; the channel is genuinely
one-shot. The client still reclaims any unspent balance via the timeout refund
path.

Both opcodes the fix relies on are live in Toccata and can be checked with the
included harnesses: `OpCat` (`0x7e`) via `scripts/opcat-probe.js`, and
`OpCheckSigFromStack` (`0xd7`) via the honest claim in `scripts/escrow-live.js`.

Contract: [`contracts/escrow.sil`](../contracts/escrow.sil) ·
compiler-derived template: [`src/x402/escrow-template.ts`](../src/x402/escrow-template.ts)
(`ESCROW_TEMPLATE_VERSION = "sompi-escrow-1"`).

## The on-chain proof harness

`scripts/escrow-live.js` builds and submits each transaction to the real node —
the rejections below are consensus rejections, not client-side guards:

| # | Action | Result | Evidence from 2026-06-28 run |
|---|---|---|---|
| 1 | Honest claim within the voucher (bound to funding outpoint `f3efcc3c896ae493f08d2c95050068a58902a41a19310c144a810662f14be1e0:0`) | **Accepted** | claim tx `34ad4368d1658a6b42aa3f1261a58a12a7de69f2d143ae228b4a3e5361474b3c` |
| 2 | Replay the **same** voucher against the claim's change output | **Rejected by the node** | signed replay tx `a6da61c5261379c90fa1c8b22ff5b14be8d2b51fe089b4939fa848b08e7f4c33` rejected; cleanup refund `16dedab955dc0db5dbd92dee411006b1aa69a42753e23711f3a68caa453c00a6` |
| 3 | Present a 1-KAS voucher but try to take 2 KAS in `outputs[0]` from funding outpoint `b7dc8f32e24cc75a984a99136b0d06d620b5f05ca04f1ad03ff2334f6ddd794c:0` | **Rejected by the node** | rejected before mempool entry; cleanup refund `e139f26eb7874d179fa0f40b9a97b684bf705d8280572d4a881cadcd5a4c5209` |
| 4 | Client refunds the full balance after the timeout from funding outpoint `629f622d47d63fe96f306d0bb16fb6288d94a81507df2970bc6bcaf5363cc45b:0` | **Accepted** | refund tx `c6172242391b49c35d2e708bb7293cf4e54e78990203017ff82ecbec42b487e8` |

Proof #2 is the point: the server's transaction signature was valid and the
transaction well-formed — the covenant rejected the replayed voucher because its
message no longer matched the new outpoint. A malicious server can take at most
what the client authorized, exactly once, enforced by every node.

Reproduce: `SOMPI_NODE_URL=<node> node scripts/escrow-live.js` after `npm run
build` (all four checks must print `PASS`). Earlier txid-only branch txids do
not prove the current compiler-derived template.

## Scope / notes

- The binding is to the full outpoint: transaction id plus output index. The
  bundled client stores the funding `txid:vout`, sends both fields with each
  voucher, and the server claims that exact UTXO.
- `contracts/escrow.sil` is the source contract. The TypeScript template is a
  parameterized runtime form of upstream SilverScript compiler output; verify it
  with `SILVERC=/path/to/silverc npm run fixtures:escrow:check` and `npm run
  smoke`.
- This is independent of the covenant **vault** (KIP-16, `docs/vault-poc.md`),
  which uses only `OpCheckSig` and a per-transaction outflow cap; it has no
  voucher and was not affected by this issue.
