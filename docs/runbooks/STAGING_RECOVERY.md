# Exact-payment staging recovery

Scope: an observed Testnet-10 staging UTXO created for one Purchase.

Staging value is not temporary. Its key and recovery plan are bound to the
Purchase, payment identity, Operator Manifest, and API data directory. Deleting
the Journal or `staging-keys/` can make it unrecoverable.

## Candidate model

Recovery supports exactly two cases:

1. An immutable exact-payment candidate already exists. That transaction and
   the saved recovery sweep compete for the same staging outpoint.
2. No exact candidate was created before expiry/failure. The durable plan says
   so explicitly, and recovery must never create one later.

The recovery output is the manifest-bound Sompi wallet. Agent, MCP, and
Merchant input cannot choose another destination.

## Before recovery

1. Stop repeated calls for the Purchase.
2. Preserve its Purchase ID, request key, version, manifest, API data directory,
   and node/witness configuration.
3. Read status. If Settlement exists, recover fulfilment/receipts instead.
4. Confirm the same synced Testnet-10 evidence sources are available.
5. Back up the complete API state using [`JOURNAL.md`](JOURNAL.md).

Do not import the staging key into a wallet, edit SQLite, replace prepared
bytes, or construct a manual sweep.

## Recovery loop

1. Read status for the original Purchase ID.
2. Call recover once for that ID.
3. Read status again.
4. If still pending, wait for evidence to change and repeat the same recovery
   call.

The operation observes the exact staging outpoint, exact-payment candidate,
recovery candidate, mempool/accepted history, and required finality. A timeout,
RPC error, or missing explorer entry never grants retry permission.

## Outcomes

| Outcome | Action |
|---|---|
| exact payment won | Stop sweeping; continue Settlement and fulfilment recovery |
| recovery sweep won but is not final enough | Wait and observe |
| recovery sweep won at the required floor | Retain recovery accounting and close without payment |
| neither candidate is proven | Remain pending; do not submit manually |
| unknown spender or contradictory evidence | Stop and escalate |

If a saved submission is retried, Sompi reuses the same bytes only under its
single-use durable readiness proof. It never rebuilds the transaction.

## Expiry and cost

Expiry forbids new authorization, staging, exact preparation, signing, and
first payment submission. It does not erase staged value.

The recovery sweep is allowed only when:

```text
observed staging fee + saved recovery fee
<= original authorized additional-cost ceiling
```

The agent cannot raise this ceiling. If it no longer fits, stop and require an
explicit operator recovery procedure; do not edit the Journal.

## Evidence

Preserve public identifiers, amounts, fees, finality, evidence digests, and the
projected action. Never publish staging keys, signed transaction bytes, wallet
or Authority credentials, raw payment headers, local paths, or node URLs.
