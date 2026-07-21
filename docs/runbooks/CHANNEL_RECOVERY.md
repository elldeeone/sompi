# Additive and batch recovery

Scope: Kaspa-x402 alpha.9 on Testnet-10.

This covers two stateful payment mechanisms:

- reusable `additive` exact heads;
- separately capitalized `batch-settlement` channel epochs.

Recovery observes the saved head/channel, signed artifact, submission fence,
and trusted chain evidence. It never constructs a replacement payment.

## Rules

- Keep the same Sompi version, Operator Manifest, API data directory, trust,
  wallet, and Testnet-10 evidence sources.
- Read Purchase status before recovery.
- Never re-sign, rebroadcast different bytes, or edit head/channel rows.
- Never adopt an output merely because its address or script matches.
- Missing or unavailable chain data is not proof of absence.

## Additive contention

Several unpaid offers may reference one head. Offers do not reserve it. The
first accepted spend advances it by exactly the Merchant price.

For a losing candidate:

1. keep the Purchase and artifact unchanged;
2. recover the same Purchase until trusted evidence proves the candidate did
   not pay and its staging value is resolved;
3. start a new Purchase only after the old one terminates.

The new Purchase gets a new request key, authorization, staging capability, and
current head.

If the known head disappears without proven spender/successor lineage,
additive fails closed. Use `standard-native` or another independently known
head. Never guess from same-address outputs.

## Batch claim

One voucher is bound to one channel epoch, active outpoint, escrow script,
resource, authorization ceiling, actual charge, and refund DAA.

For an interrupted claim:

1. stop new vouchers on that epoch;
2. preserve every affected Purchase and signed ceiling;
3. recover only Purchases that request it;
4. accept a continuation only after validating the exact claim input,
   Merchant payout, continuation value/script/index, fee accounting, and
   finality.

The continuation equals active funding minus the authorized cumulative claim.
The claim fee cannot silently reduce it.

## Refund race

Refund is valid only when chain DAA is strictly greater than the absolute
`refundTimeoutDaa`.

Before refund, stop new channel Purchases and reconcile every open voucher or
claim. Persist the refund Movement and immutable transaction before
submission. If claim and refund race, only accepted trusted evidence selects
the winner; the loser is never resubmitted.

## Rotation

Create a new channel epoch only after the old epoch is terminal and every fund
and artifact is accounted for. Rotation is not recovery for ambiguity,
corruption, or unknown lineage.

For missing/corrupt state, stop and follow [`JOURNAL.md`](JOURNAL.md). Reset
only after every retained outpoint and Movement is terminal.

## Evidence

Retain public versions, Purchase/payment IDs, head/channel identity,
transactions, outpoints, amounts, fees, mass, DAA, finality, and evidence
digests. Do not publish signed payloads, voucher bytes, keys, local paths, node
URLs, or fulfilment bodies.
