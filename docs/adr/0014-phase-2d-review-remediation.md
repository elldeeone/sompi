# ADR-0014: Phase 2D review remediation lifecycles

- Status: Accepted
- Date: 2026-07-14

## Context

The Phase 2D independent review identified lifecycle races in the already
accepted bounded-operation design. The fixes require durable ownership and
compound admission at the existing Journal, Authority, and MCP seams, while
preserving the clean-cutover model and the separation between AP2
authorization, Sompi Purchase state, and Kaspa-x402 payment execution.

## Decision

Treasury operations use a Journal-owned transition reducer with a durable
driver owner, monotonically increasing generation, bounded lease expiry, and a
generation-bound effect capability. Every preparation, plan, submission,
observation, and completion transition checks the current generation and the
cancellation/preparation fences. If a driver expires after an effect
capability was issued, the capability's old generation remains as a historical
fence; a successor may observe and reconcile but cannot submit until exact
non-submission proof clears that marker and a new capability is issued. Unknown
failures remain fenced; only typed, proven no-effect outcomes can retry or
terminalize.

Authority forwards one transport AbortSignal through the production Unix
endpoint and human decision seam. Prompt admission is reserved before fresh
replay acquisition, and the replay store has bounded durable row, token, and
result storage high-water marks with eager expiry cleanup.

Purchase admission reserves the count and mandatory request evidence together
in a Journal-owned pending admission intent. Evidence is staged reversibly and
the Purchase row, immutable artifact, link, and quota transitions commit as
one durable lifecycle. Digest cleanup is allowed only after a transactional
ownership check. Startup recovers only expired admission owners and rebuilds
committed evidence bytes from unique committed artifacts.

These are separate enforcement mechanisms inside their owning boundaries. No
universal scheduler, broker, cross-process lease service, workflow engine, or
payment-rail plugin system is introduced.

## Consequences

The Journal schema is a clean-cutover epoch and rejects every older schema
untouched. Production budgets continue to come only from the Operator
Manifest; explicit projections remain test-only. Signed/prepared Treasury
bytes and accepted evidence remain immutable, and ambiguous or possibly
effectful work stays in reconciliation until authoritative proof permits a
terminal outcome.

## Amendment: 2026-07-14 stale-predecessor and local invariant remediation

The follow-up independent review found that a driver generation fence cannot
revoke an already-running external submission. Treasury therefore enters the
durable `submission_in_flight` state immediately before invoking an adapter's
submit operation. Lease expiry, cancellation, chain absence, and takeover do
not terminalize, release capacity, or issue a second submit while that state
may still have a live predecessor. A successor is observation/reconciliation
only; the stale predecessor cannot mutate canonical state, and capacity is
retained until accepted or rejected effect evidence is authoritative.

The driver implementation owns the exact Journal lease it acquired. Initial
claims and waiter takeovers use the same generation-scoped driver helper rather
than re-entering the public same-key coalescer. A successful claim without its
lease is a Journal invariant failure.

Retained compound Purchase admissions are represented by the same completed
`prevalidation_purchase` lease used by ordinary Purchase creation. The
reservation is converted, never decremented, when the compound Purchase is
retained, so restart derives one count for every retained Purchase.

Vault preparation uses an exhaustive typed error seam for proven no-effect
terminal and transient outcomes. Unknown exceptions are fenced for
reconciliation and are never guessed safe from their message text.

This amendment changes the clean-cutover Journal schema epoch to 10 so the
new durable effect-possible state is explicit; epochs 1 through 9 remain
rejected without compatibility readers.

## Amendment: 2026-07-14 exact submission outcomes

An issued effect capability remains authoritative after cancellation. If the
adapter returns the exact prepared transaction identity, the Journal records
that acceptance even when cancellation was requested after capability issue.
Journal acceptance failures are not adapter failures and must never be caught
or downgraded to ambiguous submission.

Submission reconciliation uses explicit outcomes rather than Promise
quiescence. `in_flight`, `ambiguous`, and `accepted` all retain the effect
capability and policy reservation when observers report temporary absence.
Only a separately typed `proven_not_executed` outcome may clear the capability,
retry, or terminalize a cancelled operation. Corroborated current chain
absence is not by itself proof of node rejection because an accepted
transaction may not yet be visible to either observer.

Known read-only Kaspa RPC awaits before the first Vault signature are typed at
the Vault boundary as `rpc_unavailable`. They consume the manifest-bounded
preparation retry budget and never create signed bytes or an external effect.
The wrapper ends at the individual RPC await: normalization, transaction
construction, signing, serialization, submission, and unknown exceptions
remain fail-closed and are not guessed transient.
