# Purchase reconciliation

Reconciliation continues one interrupted Purchase from durable evidence.
It does not create a replacement payment.

`sompi-agent purchase` already performs bounded continuation.
Use explicit recovery only when its final view requests recovery.

## First response

1. Stop repeated calls.
2. Preserve the Purchase ID, request key, version, manifest identity, and error code.
3. Read status.
4. Call recovery once for the same Purchase ID when the view requests it.
5. Read status again.

Do not change the request key, Merchant, amount, profile, fee limit, channel, or payment bytes.
Do not submit a transaction manually.

## State guide

| State | Action |
|---|---|
| `created`, `terms_bound` | Follow the displayed action. |
| `awaiting_authority` | Wait for the exact human decision. |
| `authorised` | Keep the same Purchase. |
| `execution_prepared`, `submitted` | Observe and recover the same effect. |
| `settled` | Recover fulfillment or receipt only. |
| `fulfilled` | Recover receipt only. |
| `receipted` | Stop. The Purchase is complete. |
| `expired` | Do not start new payment execution. Resolve any existing staging output. |
| `failed_recoverable` | Recover once and read status. |
| terminal failure or conflict | Stop automation and preserve evidence. |

An explorer miss, RPC error, or empty UTXO result does not prove non-execution.

## Permitted recovery

Recovery can observe saved payment effects and reuse saved immutable bytes when the durable state permits it.
It can replay idempotent fulfillment and receipt lookups.

Recovery cannot rebuild, re-sign, change terms, reduce finality, or increase a fee limit.
It cannot treat timeout as proof of non-execution.

Use the mechanism-specific runbooks for [staging](STAGING_RECOVERY.md) and [channels](CHANNEL_RECOVERY.md).
Use the [Journal runbook](JOURNAL.md) for corrupt or missing state.

## Escalation record

Keep public versions, times, IDs, states, finality, manifest identity, and evidence digests.
Do not copy secrets, signed headers, prepared transactions, content, node URLs, secret paths, or raw exceptions.
