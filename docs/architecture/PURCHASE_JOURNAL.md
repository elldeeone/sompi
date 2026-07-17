# Purchase Journal

Status: alpha.8 clean-cutover architecture.

The Purchase Journal is the API-owned SQLite source of truth for Purchase,
Treasury, protocol evidence, and recovery state.

## Schema boundary

The only supported schema is epoch **14**.

- A new empty database is created directly at epoch 14.
- Every older, newer, unversioned, corrupted, or substituted database is
  rejected unchanged.
- There is no runtime migration, compatibility reader, import command, or
  alpha.6 state path.

The Journal verifies its application ID, schema version, schema checksum,
filesystem identity, SQLite integrity, foreign keys, and immutable transition
history at open.

## Owned state

The Journal records:

- Purchase identity, intent, state, and transition history;
- Checkout Terms and AP2 authorization decisions;
- policy snapshots, Reservations, capacity, and observed spend;
- Treasury Movements, prepared material, attempts, effects, and observations;
- exact staging and abandoned-staging recovery;
- Kaspa-x402 exact profile and Settlement facts;
- additive head state and lineage evidence;
- batch channels, voucher Movements, claim/refund attempts, and scan progress;
- Fulfilment and linked receipts;
- Admission Leases and fencing generations;
- immutable Operator Manifest and Chain Evidence identities.

Raw protocol bytes are not stored in canonical domain columns. They live in
content-addressed evidence/prepared stores beside SQLite. The Journal stores
their digest, length, profile, role, and relative reference.

## Filesystem unit

The Operator Manifest binds one absolute API-owned data directory containing:

- `purchase.sqlite` and SQLite WAL/SHM files;
- `purchase.sqlite.evidence/`;
- `purchase.sqlite.prepared/`;
- `staging-keys/`;
- wallet and vault state;
- Authority-client replay state.

The directory is mode `0700`; private files are `0600`. Symlinks, unsafe hard
links, ownership drift, and group/other access fail closed. Backup and restore
operate on the complete directory, not individual files.

## Transaction rule

Before an irreversible Merchant or blockchain effect, Sompi commits:

1. canonical intent and authorization;
2. policy/Treasury capacity;
3. immutable prepared material or its secure reference;
4. stable idempotency identity;
5. effect claim and fencing generation.

After the effect, Sompi records the exact observation and advances state in a
separate transaction. SQLite and the external system are not atomically
committable, so interruption always enters deterministic reconciliation.

## Recovery rule

Recovery is observation-first. It may adopt a proven winner or replay an
idempotent Merchant lookup. It may submit saved bytes only under the exact
durable proof contract for that effect.

Temporary absence, cancellation after invocation, timeout, process death, or a
new worker generation cannot prove non-execution. They do not release capacity
or authorize a replacement payment.

## Concurrency

- Request keys identify one immutable Purchase intent.
- Payment identifiers identify one immutable attempt.
- Effect capabilities are generation-bound.
- Stale workers cannot mutate newer state.
- Policy Reservations serialize shared capacity.
- Additive head and batch channel transitions use compare-and-swap invariants.
- Admission Leases bound Purchase, evidence, Authority, and Treasury work.

## Evidence and finality

Chain Evidence is durable and source-separated. Mempool presence, accepted
history, operator depth, and Kaspa consensus finality are distinct facts. Only
the configured effective Finality Floor may terminalize Settlement or release
effect-capable capacity.

Protocol verification rows are append-only. Settlement, Fulfilment, and
receipts remain separate facts linked to the same Purchase and attempt.

## Operational rules

- Stop API before a planned backup.
- Never edit Journal rows or prepared/evidence files.
- Never delete WAL files to repair state.
- Never open an old database with a newer runtime expecting migration.
- Never reset while an external effect is unresolved.

See [`../runbooks/JOURNAL.md`](../runbooks/JOURNAL.md) and
[`../runbooks/RECONCILIATION.md`](../runbooks/RECONCILIATION.md).
