# Sompi implementation plan

Status: **No active implementation phase**

Sompi `0.12.0` completed phases 0 through 21. The current release uses
Kaspa-x402 `0.1.0-alpha.9` and Journal epoch 19.

The completed plan is an archived historical record:
[`IMPLEMENTATION_PLAN_THROUGH_V0.12.0.md`](https://github.com/elldeeone/sompi/blob/c8fd02fa403b7e4f43dfa91653c0c232867d8ed8/docs/IMPLEMENTATION_PLAN.md).

Read [`CURRENT_STATE.md`](../CURRENT_STATE.md) for the current release status.

## Working rules

- Keep the repository buildable during each phase.
- Update `CURRENT_STATE.md` when a phase is complete.
- Mark a requirement complete only after its verification is complete.
- Add or change an ADR before you change an accepted design decision.
- Do not keep replaced runtime paths after a clean cutover.
- Do not change the sibling Kaspa-x402 repository without explicit scope.

## Deferred work

### Autonomous authorization

Do not start this work until human-present authorization has sufficient
evidence. A new ADR must specify limits, revocation, escalation, and recovery.

This work includes recipient grants. Each grant must have these properties:

- The Trusted Authority signs the grant.
- The user can revoke the grant.
- The grant specifies one network and one recipient.
- The grant specifies amount and time limits.
- The grant cannot increase Operator Manifest limits.

### Passkeys

Do not start this work until the threat model specifies enrollment, recovery,
key rotation, device loss, RP ID, and origins.

### UCP

Do not start this work unless Sompi owns a commerce lifecycle. This lifecycle
can include catalogs, carts, tax, shipping, orders, or fulfillment.

### Kaspa-x402 upstream alignment

This work belongs to Kaspa-x402. Sompi can use a future upstream release after
separate review and conformance verification.

### Mainnet

Mainnet requires a new ADR and explicit user approval. It also requires all
gates in [`mainnet-readiness.md`](mainnet-readiness.md).

## Start a new phase

1. Define one bounded objective.
2. Add or change the applicable ADRs.
3. Add numbered requirements and verification gates to this file.
4. Record the starting commit in `CURRENT_STATE.md`.
5. Complete the phase without work from a later phase.
