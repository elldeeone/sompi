# Abandoned Treasury staging recovery

Status: initial testnet-10 operator runbook

This procedure resolves a vault-funded staging output after the Purchase can no
longer safely start or complete its Kaspa-x402 exact payment. It applies only to
Sompi's initial testnet-10 profile and only through `purchase_recover`.

A staging output is not disposable temporary state. It is an on-chain,
attempt-specific P2PK UTXO created from the consensus vault. Deleting the
Purchase Journal or `staging-keys/` directory can make that value
unrecoverable.

## Recovery model

Exactly two kinds of immutable candidate set are supported:

1. **Exact candidate exists.** Sompi had already persisted the exact payment
   transaction. That exact transaction and one recovery sweep both spend the
   same staging outpoint; observation must determine which one won.
2. **No exact candidate exists.** Expiry or terminal failure occurred after
   staging was observed but before exact preparation. The plan records this as
   an explicit null exact candidate. Recovery must never create an exact
   transaction after expiry.

In both cases the recovery module prepares one signed, single-input/single-
output sweep from the exact journal-observed staging outpoint to the Sompi
wallet address configured by the same `SOMPI_DATA_DIR`. Merchant, Agent, and
MCP inputs cannot select another recovery address.

The current adapter profile pins a `1000000` sompi recovery fee. The immutable
plan records that fee, the already-incurred staging fee, canonical sweep bytes,
digest, transaction ID, output, required finality, Purchase/Payment identities,
and original additional-cost ceiling before it may observe or submit anything.

## Expiry boundary

After Checkout/authority expiry, Sompi must not begin a new authority decision,
Merchant authorization, Treasury staging transaction, exact-payment
preparation/signing, or first exact-payment submission. It also must not reclaim
a proof-backed exact retry whose first submission never occurred.

The dedicated return sweep is different. It may sign the already-observed
staging output solely to return treasury value to the configured wallet. It
does not pay the Merchant, change Checkout Terms, or create new Purchase
Authorization. Its staging plus recovery fees must remain within the ceiling
the User already approved.

## Before running recovery

1. Stop repeated Agent calls for the Purchase.
2. Preserve the exact `purchaseId`, `requestKey`, data directory, policy,
   package version, wallet/vault state, authority client state, and node
   configuration.
3. Confirm `purchase_status` reports `failed_recoverable`, `expired`, or an
   explicit recovery requirement after Treasury staging. If it reports
   `settled`, recover fulfilment/receipts instead; never sweep.
4. Confirm the same testnet-10 runtime has a synced RPC endpoint with the UTXO
   index enabled. Do not switch networks or use an explorer page as proof.
5. Back up the complete MCP data directory using [`JOURNAL.md`](JOURNAL.md).
6. Do not import a staging key into a general wallet, copy it into chat, edit
   SQLite, replace prepared bytes, or construct a manual transaction.

If any required state is missing or corrupt, stop. A reset is not recovery.

## Safe operator sequence

1. Read `purchase_status` with the original `purchaseId` and retain its
   secret-free projection.
2. Call `purchase_recover` once with that same identifier.
3. Read `purchase_status` again.
4. If recovery remains pending, wait for the node/chain observation to change
   and call the same recovery operation again. Do not create another Purchase
   or transaction.
5. Continue until status proves the exact payment won, the recovery sweep won
   at required finality, or a terminal conflict requires escalation.

`purchase_recover` is idempotent around one journaled recovery Effect. Repeating
that tool is not a blind blockchain retry: the Effect first observes the
immutable candidates and source outpoint under a recovery lease.

## What Sompi checks

Before any recovery submission Sompi queries, from one bounded observation:

- the exact staging outpoint, amount, script, and DAA score;
- the immutable recovery transaction and output;
- the immutable exact transaction and Merchant output, when one exists;
- UTXO-index and mempool evidence for all applicable candidates;
- the synced testnet-10 node identity.

Submission is allowed only after a fresh `safe_to_submit` proof establishes
that the staging output still matches and is unspent, the recovery transaction
is absent, and the exact transaction—when present—is absent. The proof is
short-lived and single-use. The planned Effect and prepared bytes are already
durable before this observation.

## Outcome interpretation

| Outcome | Meaning | Operator action |
|---|---|---|
| `safe_to_submit` | Both applicable candidates are absent and the exact staging output remains unspent | Let the same recovery call submit the already-persisted sweep; do not submit separately |
| `pending` | Evidence is incomplete, submission is ambiguous, or required finality has not arrived | Observe again later with the same Purchase ID |
| `exact_payment_won` | The immutable exact transaction spent the staging output | Stop sweeping; let normal Settlement, Fulfilment, and Receipt reconciliation continue |
| `recovery_won` before required finality | The recovery candidate is visible but not final enough | Wait and observe; do not release capacity or spend the recovery output based on this projection alone |
| `recovery_won` at required finality | The configured wallet received the immutable recovery output | Confirm the Purchase is terminal without Settlement and retain the accounting evidence |
| `conflict` | Partial/contradictory evidence, both candidates, or an unknown spender was observed | Stop both automated and manual submission; preserve evidence for operator review |

A timeout or cancellation after RPC submission is `pending`/ambiguous even if
the node may have accepted the transaction. Sompi must observe again. It may
return the same Effect to `retryable` only from a fresh proof that the exact
immutable candidates remain absent and the source is still unspent; it then
requires another fresh readiness proof. An RPC exception, HTTP status, or
explorer absence never grants retry permission.

## Accounting after a recovery win

Sompi waits until the recovery winner meets the plan's required finality, then
performs one journal transaction that:

- records the recovery transaction, output, returned amount, finality, and
  evidence digest;
- releases the original in-flight Purchase Reservation so the unspent Merchant
  price is not counted as a Merchant payment;
- retains the actual staging fee plus recovery fee in the shared rolling
  software-policy capacity window;
- fails the Payment Attempt as recovered without payment and moves the
  recoverable Purchase to its terminal no-payment state.

The earlier vault withdrawal still consumed the consensus vault's rolling
window. Returning its staging output to the hot wallet does not rewrite vault
state or restore that on-chain allowance.

## Fee ceiling and manual authority

Automatic recovery requires:

```text
observed staging fee + pinned recovery fee
<= original authorized additional-cost ceiling
```

If this inequality fails, `purchase_recover` refuses before claiming or
submitting the sweep. The Agent cannot raise the ceiling, a new AP2 approval
cannot rewrite the old Reservation, and the operator must not edit the journal
or re-sign different bytes behind Sompi's back.

This condition requires an explicit, human-controlled recovery decision outside
the Agent/MCP path. The initial release intentionally provides no automatic
ceiling override. Preserve the data directory and staging outpoint, record the
shortfall and current fee policy, and escalate for a reviewed operator recovery
procedure or software update that keeps the manual decision and resulting
accounting explicit. Until then the Purchase remains unresolved.

## Evidence to preserve for escalation

Preserve, without publishing secrets:

- package version/Git commit, UTC time, and testnet-10 node identity;
- Purchase ID, Payment identifier, projected state, and bounded error code;
- staging transaction ID/outpoint and staging evidence digest;
- exact transaction ID when the plan has an exact candidate;
- recovery transaction ID/output and prepared-artifact digest;
- every race-observation digest, observed finality, and policy digest;
- original authorized additional-cost ceiling plus staging/recovery fees.

Never publish the staging private key, signed sweep bytes, wallet/vault keys,
authority MAC/key material, raw payment headers, local secret paths, or raw
exceptions.

## Completion check

Recovery is complete only when one of these is durable:

- exact Settlement is independently verified and the Purchase continues to
  Fulfilment/Receipt; or
- the recovery transaction meets required finality, recovery accounting exists,
  and the original Reservation is released.

Do not reset or archive the active runtime merely because a transaction is in
the mempool. Follow [`TESTNET_RESET.md`](TESTNET_RESET.md) only after every
operation is terminal and its funds are accounted for.
