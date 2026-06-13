# SompiEscrow proof-of-concept: on-chain voucher replay protection

**Network:** Kaspa testnet-10 (Toccata active) · **Status:** vulnerability found; v3 fix live-proven on 2026-06-23 against node `10.0.3.26`

## Summary

The `kaspa-escrow` x402 channel lets a client fund a covenant once and pay a
server with cumulative off-chain vouchers, with the promise that **the server
can claim at most what the client signed for**. The first implementation did not
deliver that promise on-chain: a malicious server could drain the entire deposit
with a single voucher. This doc records the flaw, the v3 fix, and the live proof
harness that must be rerun whenever the pinned bytes change.

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
byte-pinned template: [`src/x402/escrow-template.ts`](../src/x402/escrow-template.ts)
(`ESCROW_TEMPLATE_VERSION = "sompi-escrow-3"`).

## The on-chain proof harness

`scripts/escrow-live.js` builds and submits each transaction to the real node —
the rejections below are consensus rejections, not client-side guards:

| # | Action | Result | Evidence from 2026-06-23 run |
|---|---|---|---|
| 1 | Honest claim within the voucher (bound to funding outpoint `3f088f4fe0ee84ff48f5f9fdaf13235733b0f34ce5df8454dea058dd77b336f8:0`) | **Accepted** | claim tx `031f4e9a01dfd4b25042e135d6c65015b95e908c24698820aa6b8d5dd4193638` |
| 2 | Replay the **same** voucher against the claim's change output | **Rejected by the node** | signed replay tx `099a3a9cac135992d128aba205e2f368750f331189ba5084c7530c12ab1d091c` rejected; cleanup refund `a94d158e32d3e0e41c2ca24de7843be2a6e510223d44f19402f581af5a6249e4` |
| 3 | Present a 1-KAS voucher but try to take 2 KAS in `outputs[0]` from funding outpoint `a59debbcc502a8cef46294eb8e012e2d1ace0076f5f6db7b23aba44d2ae5d298:0` | **Rejected by the node** | rejected before mempool entry; cleanup refund `8bb41e1ce529366af8bd245facce2ff5634c698c04e537fab9caa6f0beeb1eb0` |
| 4 | Client refunds the full balance after the timeout from funding outpoint `55b92ed697f079c3eded1d14bbd6ea4ee41f828dc4e653d6372ba3c61b11cf5a:0` | **Accepted** | refund tx `7acb43be038bd21c8d289fb352bd3c9b70be6f7d26f3f8a29792c1be36ed6832` |

Proof #2 is the point: the server's transaction signature was valid and the
transaction well-formed — the covenant rejected the replayed voucher because its
message no longer matched the new outpoint. A malicious server can take at most
what the client authorized, exactly once, enforced by every node.

Reproduce: `SOMPI_NODE_URL=<node> node scripts/escrow-live.js` after `npm run
build` (all four checks must print `PASS`). Earlier txid-only branch txids do
not prove the v3 byte template.

## Scope / notes

- The binding is to the full outpoint: transaction id plus output index. The
  bundled client stores the funding `txid:vout`, sends both fields with each
  voucher, and the server claims that exact UTXO.
- The `.sil` file is reference text. The authoritative artifact is the
  byte-pinned template in `src/x402/escrow-template.ts` until a source-level
  SilverScript v3 artifact is wired as the template oracle and live-proven.
- This is independent of the covenant **vault** (KIP-16, `docs/vault-poc.md`),
  which uses only `OpCheckSig` and a per-transaction outflow cap; it has no
  voucher and was not affected by this issue.
