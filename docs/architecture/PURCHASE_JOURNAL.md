# Sompi Journal

The SQLite Journal is Sompi's durable source of truth.
Current source accepts only epoch **20**.
Epoch 20 has the same physical SQLite shape as epoch 19.
It is a new semantic boundary for finality and authorization evidence.

## Rules

- Use WAL mode and explicit durability settings.
- Use one writer and recovery coordinator.
- Enable foreign keys and integrity checks.
- Use owner-only paths for the database and evidence.
- Store raw evidence as content-addressed files with mode `0600`.
- Reject an unknown schema epoch.
- Keep protocol SDK objects out of the schema.

## Records

The Journal stores Purchases, Transfers, Policy Changes, Vault Migrations, and their transition history.
It also stores authorization, policy, Treasury, settlement, channel, fulfillment, receipt, and recovery records.

Raw protocol data stays in immutable Evidence Attachments.
Stable records store only canonical facts, references, and digests.
Each attachment records its kind, media type, profile, issuer, digest, storage reference, and verification history.
Every read verifies the saved length and digest.
Modified or incomplete evidence fails closed.

## Effect transaction

Before an irreversible effect, one transaction records:

- canonical intent
- exact authorization
- policy reservation
- prepared bytes or secure reference
- idempotency and payment identity
- expected effects
- lease generation and recovery action

The external effect runs after that transaction commits.
Observation and state promotion occur in a later transaction.

## Admission Leases

Each module that consumes a scarce resource owns its Admission Lease.
Authority owns sockets and prompts. Purchase and Journal own Purchase count
and evidence bytes. Treasury owns retries and its execution slot.
Admission occurs before expensive parsing, evidence storage, Authority prompts, chain reads, or signing.

Cancellation releases capacity only when no external effect can exist.
Possible invocation keeps the lease and effect fence until authoritative observation resolves it.
Operator recovery uses separate credentials, sockets, pools, and budgets.

## Idempotency

One caller request key identifies one logical operation.
A duplicate request returns the same record.
A changed request cannot reuse that key.

Possible submission keeps its effect fence until observation resolves it.
Recovery never creates a new signed payment artifact.

## Startup recovery

1. Acquire the single-writer lease.
2. Validate schema and integrity.
3. Find non-terminal operations.
4. Expire only eligible leases.
5. Observe external effects before retry.
6. Apply the next idempotent transition.

Unknown or contradictory evidence stays blocked for operator review.

## Operations

Back up the complete API runtime state as one set.
This set includes the database, WAL, SHM, evidence, prepared data, staging keys, and secure key references.
Include the exact Operator Manifest with that set.
Keep private Authority state in a separate backup.

Never edit Journal rows manually.
Use the [Journal](../runbooks/JOURNAL.md) and [reconciliation](../runbooks/RECONCILIATION.md) runbooks.
