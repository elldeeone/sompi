# ADR-0006: Pinned, replaceable protocol adapters and immutable evidence

- Status: Accepted
- Date: 2026-07-11

## Context

AP2 and x402 are growing standards. Their packages, schemas, extension models,
and integration guidance can change. Letting upstream types leak through Sompi
would spread each upgrade across policy, MCP, persistence, receipts, and wallet
code.

## Decision

- Pin each supported AP2, x402, and Kaspa-x402 version/profile exactly while it
  is unstable.
- Keep one central supported-profile declaration.
- Parse, construct, and verify protocol objects only inside their adapters.
- Store original signed artifacts as immutable, version-tagged Evidence
  Attachments and copy verified stable facts into canonical Purchase fields.
- Reject unknown required profiles and capabilities.
- Upgrade the pin, adapter, fixtures, support declaration, and interoperability
  evidence together.
- Use temporary dual-version conformance tests if needed, then remove the old
  runtime path.

Initially, AP2 and x402 are correlated through Purchase/payment identifiers and
evidence digests. Sompi does not invent or claim an official AP2-x402 wire
extension. When an official integration is available, replace the binding
adapter without changing the Purchase model.

## Consequences

- Protocol churn stays local to one adapter and its tests.
- Historical evidence remains verifiable with recorded provenance.
- Upgrades are deliberate rather than silently accepted by broad dependency
  ranges.
- Sompi can adopt an official future integration without durable-schema lock-in.

## Rejected alternatives

- Persist SDK objects as application state: couples history to package shapes.
- Broad semver ranges: can change security semantics without review.
- Best-effort support for unknown versions: fails open on authorization/payment
  semantics.
- Permanent old/new adapters: recreates the compatibility burden rejected by
  ADR-0001.
