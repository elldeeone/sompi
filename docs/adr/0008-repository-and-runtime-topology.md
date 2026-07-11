# ADR-0008: One repository/package and two executables initially

- Status: Accepted
- Date: 2026-07-11

## Context

The greenfield proposal separated every architectural noun into a package and
created several applications. Clear locality is required, but independent
package versioning and deployment are not yet demonstrated requirements.

## Decision

Keep one Sompi repository and initially one npm package. Organize it into deep
internal modules and expose:

- `sompi-mcp` as the agent-facing executable;
- `sompi-authority` as the isolated deterministic approval executable.

Keep the demo Merchant as a development/conformance fixture. Split packages or
repositories only when independent release cadence, ownership, reuse, or
deployment is demonstrated.

Separate process isolation is mandatory for the Trusted Authority because it is
a security seam. Package separation alone is not a security control.

## Consequences

- Internal modules can evolve together during the clean cutover.
- There is less versioning and integration overhead.
- The authority receives real process isolation without speculative package
  proliferation.

## Rejected alternatives

- Immediate monorepo with many published packages: shallow interfaces and
  coordination cost before variation is known.
- Single executable: fails the authority trust requirement.
- Separate AP2 product repository: fragments the Purchase lifecycle without an
  independent product need.
