# Purchase Journal

The SQLite Journal is Sompi's durable source of truth. Epoch **15** is the only
active schema.

## Rules

- WAL mode with explicit durability settings.
- One writer/recovery coordinator.
- Foreign keys and integrity checks enabled.
- Owner-only database, WAL, SHM, and evidence paths.
- Raw evidence stored as content-addressed 0600 files, not SQLite blobs.
- Unknown schema epoch fails closed.
- Protocol SDK objects never become schema.

## Records

The Journal stores:

- Purchase and transition history;
- Checkout Terms and evidence attachments;
- Authority decisions and verification facts;
- policy reservations and Admission Leases;
- Treasury Movements and effect generations;
- staging/payment plans and secure key references;
- settlements and Chain Evidence;
- batch Channels, vouchers, claims, continuations, and refunds;
- fulfilment and one receipt per Purchase;
- reconciliation and operator actions.

## Transaction boundaries

State that grants authority or precedes an irreversible effect is committed in
one transaction:

- canonical intent;
- exact authorization;
- policy reservation;
- prepared bytes or secure reference;
- idempotency and payment identity;
- expected outputs/effects;
- lease/fencing generation;
- next recovery action.

The external effect then runs. Observation and state promotion occur in a later
transaction. A crash cannot leave an effect without a durable identity and
recovery path.

## Evidence

Evidence Attachment metadata records digest, media type, profile, issuer, kind,
storage reference, and verification history. Content files are immutable and
verified on read.

Raw AP2-derived authority evidence, x402 headers/payloads, transaction bytes,
settlement responses, and Merchant responses remain attachments. Canonical
Purchase state stores only stable facts and digests.

## Idempotency

- Caller request key identifies one logical Purchase.
- Purchase ID, payment identifier, transaction/commitment ID, Movement ID, and
  effect generation have unique constraints.
- A duplicate request returns the same Purchase.
- A changed request cannot reuse an existing key.
- A possible submission keeps its effect fence until observation resolves it.

## Recovery

Startup recovery:

1. acquires the single-writer lease;
2. validates schema and integrity;
3. finds non-terminal Purchases and Movements;
4. expires only leases whose recovery rules permit takeover;
5. observes external effects before any retry;
6. applies the next idempotent transition.

Payment recovery never creates a new signed artifact. Fulfilment recovery never
repays. Unknown or contradictory evidence remains recoverable/blocked for the
operator.

## Operations

Back up the database, WAL/SHM when present, evidence directory, secure key
references, and Operator Manifest as one consistent set. Never edit Journal
rows manually. Use `sompi-agent status`, `sompi-agent recover`, or the operator
runbooks.

See [`../runbooks/JOURNAL.md`](../runbooks/JOURNAL.md) and
[`../runbooks/RECONCILIATION.md`](../runbooks/RECONCILIATION.md).
