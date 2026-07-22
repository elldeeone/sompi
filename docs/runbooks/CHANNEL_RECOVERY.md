# Additive and batch recovery

Scope: Kaspa-x402 alpha.9 on Testnet-10.

Recovery uses the saved head, channel, signed artifact, effect fence, and chain evidence.
It never creates a replacement payment.

## Rules

- Keep the same Sompi version, manifest, state directory, wallet, and evidence sources.
- Read Purchase status before recovery.
- Do not change or re-sign saved bytes.
- Do not edit head or channel records.
- Do not adopt an output from its address or script alone.
- Treat missing chain data as unknown.

## Additive conflict

Unpaid offers can reference one head.
The first accepted spend advances that head.

For a losing candidate:

1. Keep the Purchase and artifact unchanged.
2. Recover the same Purchase until trusted evidence resolves it.
3. Resolve its staging value.
4. Start new work only after the old Purchase terminates.

If proven lineage is not available, disable that head.
Do not guess from a same-address output.

## Batch claim

Stop new vouchers on an interrupted channel epoch.
Preserve each Purchase, voucher, and signed ceiling.

Accept a continuation only after all exact claim values match.
These values include the input, payout, continuation, fee, index, script, and finality.

The continuation equals active funding minus the authorized cumulative claim.
The Merchant claim fee cannot reduce it.

## Refund race

Refund is valid only when chain DAA is greater than `refundTimeoutDaa`.
Stop new channel Purchases before refund.

Record the refund Movement and transaction before submission.
If claim and refund race, trusted chain evidence selects one winner.
Do not resubmit the loser.

## Evidence

Keep public versions, identifiers, transactions, values, fees, DAA, finality, and evidence digests.
Do not publish signed payloads, keys, local paths, node URLs, or content bodies.

## Channel rotation

Create a new channel epoch only after the old epoch is terminal.
Account for every fund, artifact, outpoint, and Movement before rotation.

Rotation does not resolve ambiguity, corruption, or unknown lineage.
For missing or corrupt state, stop and use the [Journal runbook](JOURNAL.md).
