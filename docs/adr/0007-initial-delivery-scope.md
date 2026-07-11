# ADR-0007: Human-present, exact, testnet-first delivery

- Status: Accepted
- Date: 2026-07-11

## Context

The complete design includes several independently risky capabilities. Shipping
all of them at once would obscure whether authorization, payment, recovery, and
fulfilment are individually correct.

## Decision

The first end-to-end vertical slice is:

- AP2 v0.2 human-present with exact closed terms and an exact upstream
  commit/schema pin;
- deterministic Trusted Authority approval;
- Kaspa-x402 `exact` payments;
- Kaspa testnet only;
- one AP2-aware demo Merchant;
- linked Settlement, Fulfilment, and receipt evidence;
- crash/replay/tampering/egress tests.

Defer:

- `batch-settlement` until exact recovery is proven and every resource purchase
  receives its own authorization;
- autonomous/open AP2 mandates until direct mode, escalation, revocation, and
  policy semantics are proven;
- UCP until Sompi actually owns carts, tax, shipping, orders, or fulfilment
  lifecycle;
- passkeys until ADR-0005's design gates are met;
- mainnet until independent review, durable-store, runbook, current live-proof,
  and all repository readiness gates pass.

## Consequences

- The first proof is small enough to reason about end to end.
- Deferred capabilities cannot silently enter the initial critical path.
- Testnet success is not described as mainnet readiness.

## Rejected alternatives

- Batch first: channel funding can obscure per-Purchase authorization and
  recovery.
- Autonomous first: combines delegation policy with an unproven direct flow.
- UCP from day one: imports commerce lifecycle that paid HTTP resources do not
  yet need.
