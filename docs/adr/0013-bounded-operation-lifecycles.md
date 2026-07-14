# ADR-0013: Bound scarce operation lifecycles inside their owning modules

- Status: Accepted
- Date: 2026-07-13

## Context

Unauthenticated Authority sockets, queued human prompts, pre-validation
Purchase/evidence creation, and direct Treasury preparation can retain scarce
resources without a complete bounded lifecycle. One global scheduler would mix
different trust and durability semantics and create another shallow pass-through.

## Decision

Each owning module implements its own Admission Lease with explicit budgets,
deadlines, cancellation, persistence, observability, terminal release, and
operator recovery:

- the Trusted Authority owns pre-authentication socket and authenticated prompt
  admission;
- the Purchase module and Purchase Journal own pre-validation Purchase count
  and Evidence Attachment byte admission;
- the Treasury module owns preparation retries and its exclusive execution slot.

Admission occurs before the scarce resource is consumed. Cancellation is
terminal only while non-execution is proven. Once a blockchain or Merchant
effect may have occurred, cancellation yields pending Reconciliation and keeps
the relevant reservation/lease fenced. Startup deterministically expires or
recovers abandoned leases without repeating an irreversible action.

Budgets are installed through the Operator Manifest. Defaults are conservative,
bounded, and observable; exhaustion returns a stable secret-free result rather
than retaining partial state indefinitely.

## Consequences

- Resource exhaustion fixes remain local to the module that understands the
  resource and its safe terminal states.
- Legitimate concurrent Purchases remain possible within explicit budgets.
- Cancellation cannot manufacture proof that an external action did not occur.
- Tests exercise the same module interface used by production callers.

## Rejected alternatives

- Unlimited queues with timeouts at callers: retained work can still accumulate.
- One central scheduler: erases distinct authority, evidence, and Treasury
  invariants.
- Release on cancellation after invocation: can enable duplicate effects or
  capacity reuse while the first effect is still live.
