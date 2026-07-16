# ADR-0009: Use Kaspa-x402 unchanged for initial AP2 integration

- Status: Accepted
- Date: 2026-07-11
- Amended by: ADR-0015 (pinned alpha.8 exact and batch scope)

## Context

Kaspa-x402 already exposes useful client seams and owns the Kaspa x402 v2
mechanisms. x402 itself already has an official extension model. AP2's exact
x402 integration is still evolving, creating a risk that Sompi-specific needs
could distort the general Kaspa-x402 library.

## Decision

Initial Sompi integration consumes the current Kaspa-x402 interfaces, including
`FundingProvider`, `ChannelSigner`, `ChannelStore`, and `AddressCodec`. Sompi
implements its own wallet/vault and durable-store adapters at those seams.

Do not add AP2 types, mandates, semantics, or a Sompi-specific extension to
Kaspa-x402. Link AP2 and x402 at the Sompi Purchase layer using the Purchase
identifier, payment identifier, canonical facts, and evidence digests.

Do not reproduce x402's generic extension lifecycle in Kaspa-x402 for Sompi.
Possible future work to register Kaspa mechanisms beneath official x402 core is
a separate, generally useful upstream-alignment project and is not required to
begin or complete Sompi's initial AP2 flow.

## Consequences

- Sompi can begin without waiting for a Kaspa-x402 release.
- Kaspa-x402 remains reusable by non-AP2 clients.
- The official future AP2/x402 integration can replace Sompi's correlation
  adapter without changing Kaspa payment mechanics.
- Any sibling-repository change needs separate scope and justification.

## Rejected alternatives

- Add AP2 directly to Kaspa-x402: couples payment execution to one authorization
  framework.
- Ask x402 to change for Sompi: unnecessary because x402 already supports
  schemes and extensions.
- Fork Kaspa-x402 inside Sompi: creates long-term divergence and duplicated
  protocol ownership.
