# Purchase Journal contract

Status: current v4 implementation contract

The Purchase Journal is Sompi's durable source of truth for Purchase state,
Merchant authorization, treasury capacity, prepared execution,
external-effect ambiguity, evidence, direct Treasury Movements, abandoned
staging recovery, and recovery coordination. It does not perform AP2
verification, x402 parsing, Kaspa submission, Merchant requests, or
Agent-facing projection.

## Durable storage

For a journal at `purchase.sqlite`, the default storage set is:

- `purchase.sqlite`: SQLite workflow facts, mode `0600`;
- `purchase.sqlite.evidence/`: immutable protocol evidence, directory mode
  `0700`, content files mode `0600`;
- `purchase.sqlite.prepared/`: immutable bytes required to execute or replay an
  effect, with the same secure modes;
- `staging-keys/`: attempt-specific staging keys, outside SQLite and protected
  as private MCP-owned state.

SQLite uses WAL, `synchronous=FULL`, foreign keys, `trusted_schema=OFF`, a busy
timeout, an application identifier, migration checksum, and schema fingerprint.
The containing directory must be owned by the current user and inaccessible to
group or other users.

Evidence and prepared bytes are content-addressed. The database retains only
their SHA-256 digest, exact byte length, and relative storage reference. Every
security-sensitive use rereads and rehashes the file. A backup therefore has to
preserve the complete data directory, not only the SQLite file.

## Schema versions

The current schema is version 4:

| Version | Durable responsibility |
|---|---|
| v1 | Purchase/effect histories, Evidence Attachments, policy reservations, Payment Attempts, immutable preparations, observations, spends, and leases |
| v2 | Canonical Checkout Terms, authority requests/decisions, fulfilment, receipts, and the two-stage vault-staging plan/observation |
| v3 | Direct `wallet_send`, `vault_send`, and `vault_deposit` Treasury Movements in the same policy-capacity ledger |
| v4 | Immutable abandoned-staging recovery plans, race observations, finality, and recovery accounting |

A verified v3 journal migrates additively to v4 without discarding existing
policy or operation facts. Migration checks the exact prior checksum and schema
fingerprint before changing anything, then records the new checksum in the same
transaction. Verified empty v1 development journals may migrate through all
versions; non-empty v1 development state is deliberately rejected by the clean
cutover. Unknown, drifted, unversioned, or newer schemas fail closed.

## Durable facts

The schema separates facts that must not be conflated:

- Purchase state and append-only transition history;
- immutable Checkout Terms and authority requests/decisions;
- immutable Evidence Attachments and append-only verification facts;
- immutable policy snapshots and one active snapshot;
- Treasury Reservations and their capacity state;
- Payment Attempts and append-only transition history;
- durable Merchant authorization Effects and verified acceptance evidence;
- immutable vault-staging plans and independently verified staging outputs;
- immutable exact-payment preparation, including exact amount, asset, network,
  payee, required finality, transaction identity, and prepared bytes;
- planned effects, execution claims, submission acknowledgements, and
  append-only observations;
- immutable observed Merchant spends;
- direct Treasury Movement intent, preparation, observations, and completion;
- immutable staging-recovery plans, observations, and fee accounting;
- monotonic recovery leases and typed reconciliation records.

Prepared material, evidence, transitions, observations, policy snapshots,
spends, direct-operation facts, and staging-recovery facts have no update or
delete path once immutable. SQLite triggers reject mutation of immutable fact
tables.

## Merchant authorization before Treasury staging

The Merchant's acceptance of the AP2 Purchase and Payment authorization is a
separate HTTP stage, not an x402 extension. Before Sompi may plan Treasury
staging, the journal requires exactly one `merchant-authorization` Effect for
the Purchase. Its idempotency key is bound to the Payment identifier, its state
must be `observed`, and its result must be verified evidence linked to the same
Payment Attempt.

The Effect is persisted before the Merchant call. A lost response is ambiguous
and must be observed through the Merchant authorization status interface. An
HTTP or transport failure is not permission to stage funds. This ordering
keeps Merchant acceptance, Treasury Movement, and exact payment as three
distinct durable decisions.

## Effect state contract

```text
planned -> executing -> submitted -> observed
   |          |             |
   |          +-> ambiguous-+
   |                 |
   |                 +-> retryable -> executing
   |                 +-> observed
   |                 +-> failed_terminal
   +-> abandoned
```

- `planned` means the effect is durable but has never been claimed. The normal
  executor may claim it once.
- `executing` is committed before any external call. A crash in this state is
  ambiguous, even if no local submission acknowledgement exists.
- `submitted` means an external acknowledgement digest was recorded. It is not
  Settlement.
- `ambiguous` requires observation; it is never blindly retried.
- `retryable` requires an append-only, proof-bearing not-found observation.
- `observed` requires an immutable result digest. Payment effects reach it only
  in the same transaction that records the observed treasury spend.
- `failed_terminal` cannot be automatically retried.
- `abandoned` is permitted only for a never-claimed, expired effect whose
  specific journal operation proves no external action began.

An effect claim has its own lease and generation. Recovery cannot inspect or
change an effect while that executor fence remains live. Once the claim expires,
the global recovery lease may record observations. A stale generation cannot
write, even if its network call later returns.

## Treasury staging and payment submission

Vault-backed exact payment has two separately journaled irreversible effects.

`beginTreasuryStaging` atomically verifies the active, unexpired Reservation,
verified Merchant authorization, staging preparation digest, and exact staging
identity; moves the Reservation to `in_flight`; and claims the staging Effect.
Only then may the vault withdrawal be submitted. An `in_flight` Reservation
never expires automatically.

After the staging outpoint is independently observed and linked as verified
evidence, exact payment preparation may consume only that immutable outpoint.
`beginPaymentSubmission` then verifies the same Reservation, prepared bytes,
transaction identity, and Effect relationship; moves the Payment Attempt to
`submitted`; and claims the payment Effect. Only after that transaction commits
may the adapter send the paid Merchant request.

If authority expires after staging but before exact preparation or first exact
submission, Sompi must not prepare, sign, or submit an exact payment. The
already-created staging output is instead resolved by the dedicated recovery
plan below.

## Direct Treasury Movements

`send_payment`, `vault_send`, and `vault_deposit` do not bypass the journal.
Each uses a stable `operationKey` that binds its kind, destination, requested or
resolved amount, fee ceiling, input set, prepared bytes, and transaction ID.
Intent and gross capacity are committed before signing; submission is planned
before broadcast; and ambiguity is resolved by observing the same immutable
inputs and transaction.

Only one unresolved direct Treasury Movement is admitted at a time. Its
reserved or completed cost is counted in the same rolling software-policy
window as Purchases. A vault deposit's principal is an internal transfer and is
audited but excluded from third-party-spend capacity; its fee still counts.
Wallet and vault sends count principal plus fee.

## Reservation and spend accounting

Reservations use one persisted policy snapshot rather than caller-supplied
limits. A reservation records exact Merchant price, bounded additional-cost
ceiling, payee, expiry, funding source, policy digest, and the exact verified
authorization evidence/profile/verifier.

Capacity is calculated as:

```text
active unexpired Purchase reservation ceilings
+ all in-flight Purchase reservation ceilings
+ actual observed Purchase spends inside the rolling window
+ actual abandoned-staging recovery fees inside the rolling window
+ reserved or completed direct Treasury Movement costs inside the window
```

The reservation ceases to count only when an immutable Merchant spend replaces
it or proof-backed recovery safely releases it. Merchant spend finalization
requires exact equality with the immutable preparation for amount, asset,
network, payee, transaction identity, and required finality. Actual additional
cost may be lower than, but never exceed, its ceiling.

When the recovery sweep wins at required finality, the Merchant principal is
returned to the configured Sompi wallet and the Reservation is released. The
journal retains only the actual staging fee plus recovery fee in the rolling
capacity window. That return does not reverse the consensus vault's already
consumed rolling-window outflow.

## Abandoned-staging recovery contract

Schema v4 makes recovery a dedicated `treasury-staging-recovery` Effect. It may
be planned only for a recoverable Purchase with an observed staging output, an
in-flight Reservation, no recorded Merchant spend, and either:

- an exact payment already prepared: persist that immutable transaction as the
  only exact candidate; or
- no exact payment prepared: persist an explicit no-exact-candidate mode with a
  null exact transaction identity.

The recovery adapter signs one immutable sweep from the exact staging outpoint
to the Sompi wallet address configured by the same runtime. The journal stores
its canonical bytes, digest, transaction ID, output outpoint/amount, pinned
recovery fee, staging fee, required finality, and original authorized
additional-cost ceiling before observation or submission.

The observer always checks the staging outpoint and recovery transaction. When
an exact candidate exists it checks that transaction too. A fresh
`safe_to_submit` result requires the source outpoint to match and remain
unspent, and every applicable candidate to be absent. That readiness proof is
short-lived and single-use. A timeout or ambiguous submit returns to
observation; it is not permission to submit the bytes again.

Exactly one resolution is accepted:

- exact candidate wins: the normal exact Settlement reconciliation remains
  authoritative and no recovery accounting is recorded;
- recovery candidate wins: wait for the plan's required finality, release the
  principal Reservation, and append the actual staging plus recovery fees;
- neither candidate is resolved: remain pending and observe again;
- partial, contradictory, both-candidate, or unknown-spender evidence: mark
  terminal conflict and require operator review.

The sum of staging and recovery fees must not exceed the original authorized
additional-cost ceiling. There is no Agent or MCP override. If it does not fit,
automatic recovery stops before submission and explicit operator authority is
required; the operator must preserve the unresolved journal rather than edit
the ceiling, replace the transaction, or fabricate a retry observation.

See [`../runbooks/STAGING_RECOVERY.md`](../runbooks/STAGING_RECOVERY.md) for the
operator procedure.

## General recovery rules

- A live executor is reported as `executor_active`; recovery does not call its
  observer.
- A planned effect is reported as `ready_to_execute`, not "safe to retry". The
  generic reconciler does not execute it.
- An executing, submitted, or ambiguous effect requires its registered
  observer after the executor fence expires.
- A retryable effect retains its in-flight capacity until the Purchase module
  either reclaims the same immutable payload or abandons it using the recorded
  not-found proof.
- A submitted Payment Attempt cannot be failed by the generic failure
  interface. Only compound proof-backed reconciliation may fail it and release
  capacity.
- Reconciliation returns typed per-effect decisions and stores the same facts
  durably for later Purchase recovery.

## Startup validation

Every open fails closed unless all of the following pass:

- SQLite integrity and foreign-key checks;
- supported application and schema versions;
- migration checksum and exact schema fingerprint;
- Purchase, Payment Attempt, Effect, and direct Treasury Movement state replayed
  from immutable history;
- cross-table consistency among authorizations, reservations, staging,
  preparations, recovery plans/accounting, effects, spends, and terminal states;
- readback and digest verification of every stored Evidence Attachment and
  prepared artifact.

No automatic reset, destructive repair, legacy JSON import, or compatibility
reader exists.

## Secret boundary

The journal accepts bounded codes, canonical facts, digests, and secure
references. It has no arbitrary transition-metadata or raw-error field.
Authority, wallet, vault-owner, and staging private keys must never be supplied
as evidence or prepared material. They are never stored in SQLite plaintext or
emitted by the reconciler.

## Verification gate

The journal suite covers transaction rollback hooks, abrupt `SIGKILL` before
and after commit boundaries, Merchant-authorization acceptance across restart,
external-success-before-local-record recovery, prepared/submitted/settled/
fulfilled/receipted restart states, direct Treasury Movement ambiguity,
evidence and prepared-byte tampering, stale fencing generations, additive
v3-to-v4 migration, semantic/schema/page corruption, exact/no-exact staging
recovery, finality, fee accounting, and real multi-process reservation and
effect-claim races.
