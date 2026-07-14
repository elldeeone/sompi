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
