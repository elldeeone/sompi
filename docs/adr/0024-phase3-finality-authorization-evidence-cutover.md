# ADR-0024: Phase 3 finality and authorization evidence cutover

- Status: Accepted
- Date: 2026-07-24
- Amends: ADR-0001, ADR-0005, ADR-0010, ADR-0012, ADR-0017, ADR-0023

## Context

Phase 3 makes Chain Evidence the owner of the operator Finality Floor and the
effective Finality Floor. Purchase Authorization must now bind four separate
facts:

- Merchant settlement assurance;
- Sompi operator Finality Floor;
- effective Finality Floor;
- DAA depth that defines `depth-confirmed`.

These facts change immutable Purchase Authorization bytes, Authority IPC
bytes, Authority approval facts, and AP2-derived decision evidence. Reusing the
old profiles or Journal epoch would give two meanings to one durable identity.

Sompi has no external users or production state that requires compatibility.

## Decision

Sompi makes one clean semantic cutover:

| Artifact | Replaced identity | Active identity |
|---|---|---|
| Purchase Authorization request | `urn:sompi:authorization-request:1` | `urn:sompi:authorization-request:2` |
| Purchase approval display | `sompi.purchase-approval.1` | `sompi.purchase-approval.2` |
| Authority IPC | version `1` | version `2` |
| Authority approval-facts digest | `sompi:authority-approval-facts:v1` | `sompi:authority-approval-facts:v2` |
| Authority IPC MAC domain | `sompi:authority-ipc:mac:v1` | `sompi:authority-ipc:mac:v2` |
| AP2-derived decision evidence | `urn:sompi:authority-decision:ap2-derived-human-present:2` | `urn:sompi:authority-decision:ap2-derived-human-present:3` |
| AP2-derived authorization | `urn:sompi:ap2-derived-human-present:1` | `urn:sompi:ap2-derived-human-present:2` |

The source runtime starts Journal epoch 20. Epoch 20 has the same physical
SQLite shape as epoch 19. It is a new semantic recovery boundary. The runtime
rejects epochs 1 through 19 without mutation.

There is no migration, compatibility reader, old-profile fallback, or dual
runtime path.

Chain Evidence also applies the exact operator and witness source profiles
before it accepts present or absent evidence. It derives current depth meaning
from the retained raw DAA scores. It does not trust an old derived level.

## Boundaries

- Kaspa-x402 source, wire behavior, package pins, and conformance profiles do
  not change.
- The AP2 upstream pin does not change.
- Sompi still makes no AP2 interoperability claim.
- This phase does not release, publish, deploy, change the live host, or modify
  a sibling repository.

## Consequences

- A future deployment must start a fresh epoch-20 runtime identity.
- Epoch-19 state remains an immutable historical runtime.
- All active golden evidence and exact-profile tests use the new identities.
- Rollback requires the complete epoch-19 software and state. Cross-epoch state
  reuse is prohibited.

## Rejected alternatives

- Reuse the old profiles: this gives one identity to two canonical shapes.
- Keep epoch 19: this makes recovery semantics depend on the running binary.
- Add migration or dual readers: this keeps replaced unstable semantics active.
