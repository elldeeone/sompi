# ADR-0002: Modular monolith centred on a deep Purchase module

- Status: Accepted
- Date: 2026-07-11

## Context

The existing product contains valuable wallet, vault, policy, MCP UX, and
operator behaviour. Its main architectural weakness is that purchase
orchestration, protocol state, policy calls, and presentation are spread across
the MCP entrypoint and bespoke x402 client. A greenfield monorepo would discard
working leverage and create speculative package interfaces.

## Decision

Keep one repository and initially one package. Build a deep Purchase module
whose narrow interface owns the whole purchase lifecycle and recovery model.
Keep AP2 and Kaspa-x402 behind separate internal seams.

The canonical Purchase interface uses Sompi domain terms only. MCP tools,
policy, wallet/vault, AP2, Kaspa-x402, and persistence do not call through each
other directly; orchestration belongs to the Purchase module.

Do not create a universal payment-rail plugin interface. Kaspa-x402 is the only
real execution adapter. A broader seam is justified only when a second real
adapter demonstrates common invariants.

## Consequences

- AP2 and x402 changes have locality in their adapters.
- Existing proven modules can be characterized and retained.
- Tests exercise the same Purchase interface used by MCP callers.
- Internal files may be reorganized without forcing independent package
  releases.

## Rejected alternatives

- Greenfield multi-package rewrite: too many simultaneous unknowns.
- Keep orchestration in MCP tools: leaves the Agent-facing module coupled to
  payment and recovery internals.
- Universal plugin framework: a hypothetical seam with only one adapter.
