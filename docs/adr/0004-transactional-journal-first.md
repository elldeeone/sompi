# ADR-0004: Transactional Purchase Journal before payment cutover

- Status: Accepted
- Date: 2026-07-11

## Context

The current implementation writes policy, vault, and x402 JSON state around
external blockchain and Merchant actions. A crash can occur after an external
effect but before local state is recorded. SQLite cannot make a blockchain
broadcast or HTTP response part of the same transaction, but it can make the
intent and recovery information durable first.

## Decision

Implement the SQLite Purchase Journal before enabling the replacement payment
path. It is the source of truth for:

- Purchase transitions and history;
- policy reservations;
- payment identifiers and replay protection;
- planned external effects/outbox state;
- prepared payment material or secure references;
- submission and settlement observations;
- Evidence Attachment metadata and receipts;
- recovery coordination.

Reserve policy capacity and persist idempotency/preparation before signing or
submission. On ambiguous outcomes, reconcile against Kaspa, Kaspa-x402, and the
Merchant before retrying.

The journal does not store authority or wallet private keys in plaintext.

The implemented durability, fencing, effect-state, evidence, and accounting
contract is recorded in
[`docs/architecture/PURCHASE_JOURNAL.md`](../architecture/PURCHASE_JOURNAL.md).

## Consequences

- Recovery becomes part of payment correctness, not later operational polish.
- Failure-injection tests are required at every state/effect edge.
- Direct JSON workflow stores are deleted during cutover.
- Policy reservation and final spend become separate, reconcilable facts.

## Rejected alternatives

- Add SQLite after protocol integration: permits known crash/replay windows in
  the new path.
- Record only successful outcomes: cannot distinguish never-submitted from
  submitted-but-unobserved.
- Retry on timeout: risks duplicate payment or fulfilment.
