# ADR-0001: Clean cutover without backwards compatibility

- Status: Accepted
- Date: 2026-07-11

## Context

Sompi has no external users, production state, or published compatibility
obligation. Existing packages and deployments were for development and testing.
The current code owns a bespoke x402 v1 protocol that the target architecture
replaces with Kaspa-x402 v2.

## Decision

Perform one clean cutover. Delete the replaced implementation and all of its
supporting surface in the same change:

- old wire types, headers, parsers, and encoders;
- old escrow client/server orchestration and duplicated covenant mechanics;
- old state files and state readers;
- old fixtures, scripts, commands, examples, service text, and documentation;
- compatibility shims, version negotiation, fallback paths, and feature flags.

No migration reader will be written for development-only state. Tests may
compare old and new behaviour during implementation, but only the new runtime
path remains after cutover.

## Consequences

- The new model can be coherent rather than constrained by dead shapes.
- The deletion list and documentation audit are part of the cutover acceptance
  gate.
- A rollback is a Git operation, not a permanent runtime compatibility layer.
- Future real user state will require deliberate migrations; that obligation
  does not exist yet.

## Rejected alternatives

- Keep v1 behind a flag: rejected because it creates two protocol truths.
- Import old JSON state: rejected because it preserves development-only schema
  and recovery assumptions.
- Deprecate gradually: rejected because there are no users benefiting from the
  extra complexity.
