# Purchase reconciliation

Reconciliation resolves one interrupted Purchase from durable evidence. It
never creates a replacement payment.

Use either the canonical API or the three-tool MCP wrapper:

- `status` / `purchase_status` is read-only;
- `recover` / `purchase_recover` advances only the same Purchase.

Operator recovery uses its separate socket and credential. MCP cannot access
that transport.

## First response

1. Stop repeated calls for the Purchase.
2. Preserve the Purchase ID, request key, Sompi version, Operator Manifest
   identity, and projected error code.
3. Read status before calling recover.
4. If recovery is requested, call it once with the same Purchase ID.
5. Read status again. Repeat only when the projection explicitly says to
   observe or recover the same Purchase.

Do not change the request key, amount, Merchant, profile, fee ceiling, channel,
or payment bytes. Do not submit a transaction manually.

## State guide

| State | Meaning | Action |
|---|---|---|
| `created`, `terms_bound` | No authorization or payment | Follow the displayed action |
| `awaiting_authority` | Human decision pending | Approve only in the Authority terminal |
| `authorised` | Authorized; payment not yet settled | Do not create a second Purchase |
| `execution_prepared` | Immutable execution material exists | Recover the same Purchase if requested |
| `submitted` | Submission may have succeeded | Observe; never repay |
| `settled` | Payment verified | Recover fulfilment or receipts only |
| `fulfilled` | Resource is durable | Recover receipts only |
| `receipted` | Complete | No action |
| `expired` | No new payment execution may begin | Resolve any existing staging output |
| `failed_recoverable` | Durable evidence requires work | Recover once, then read status |
| `failed_terminal` or conflict | Automation is unsafe | Stop and inspect preserved evidence |

`not found`, an explorer miss, an RPC exception, or one empty UTXO view is not
proof that a transaction did not execute.

## What recover may do

Recovery may:

- reacquire the same Authority request without repeating a completed human
  decision;
- query the exact Merchant payment identity;
- observe the saved staging, exact, claim, refund, or continuation transaction;
- adopt a proven accepted winner;
- replay the same idempotent fulfilment or receipt lookup;
- submit the exact saved bytes only when the durable proof contract permits it.

Recovery may not rebuild, re-sign, change terms, lower finality, increase a
fee ceiling, or treat a timeout as non-execution.

## Mechanism-specific recovery

- Staged exact funds: [`STAGING_RECOVERY.md`](STAGING_RECOVERY.md)
- Additive heads and batch channels: [`CHANNEL_RECOVERY.md`](CHANNEL_RECOVERY.md)
- Corrupt or missing state: [`JOURNAL.md`](JOURNAL.md)

Expiry blocks new authorization, staging, exact preparation, signing, and
first submission. It does not erase an already-created staging UTXO. The
staging recovery path may return that exact value to the configured wallet only
within the original authorized additional-cost ceiling.

## Escalation record

Preserve these public facts:

- Sompi version and Git commit;
- UTC time and Testnet-10 identity;
- Purchase ID and projected state;
- payment, transaction, outpoint, and evidence identifiers;
- manifest, policy, Authority, and Merchant key identities;
- observed finality and bounded error code.

Do not copy private keys, Authority MAC material, raw signed headers, prepared
transactions, fulfilment bodies, node URLs, local secret paths, or raw
exceptions into chat or an issue.
