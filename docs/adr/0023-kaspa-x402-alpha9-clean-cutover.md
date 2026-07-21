# ADR-0023: Kaspa-x402 alpha.9 clean cutover

- Status: Accepted
- Date: 2026-07-21
- Supersedes: the active alpha.8 implementation in ADR-0015
- Amends: ADR-0006, ADR-0009, ADR-0015

## Context

Kaspa-x402 `0.1.0-alpha.9` preserves Sompi's enabled exact
standard-native/additive and batch-settlement profiles while adding canonical
rules for exact payer-authorization expiry and batch commitment construction.
Because the dependency is pre-1.0 and protocol artifacts are durable evidence,
silently running old and new behavior against one Journal epoch would make
recovery semantics ambiguous.

Sompi has no external users or production state requiring compatibility.

## Decision

Sompi replaces alpha.8 with exactly pinned Kaspa-x402 `0.1.0-alpha.9` packages
and source provenance. The adapter:

- applies the canonical exact authorization expiry verifier before normal
  settlement work;
- permits expired authorization only while observing an already-durable exact
  attempt, while still rejecting malformed, overlong, or challenge-exceeding
  authorization;
- verifies the upstream exact and batch interoperability vectors, including
  canonical batch payment-requirements and commitment identifiers;
- continues to support only testnet-10, human-present authorization, exact
  standard-native/additive, and the already-accepted batch-settlement lane.

The runtime begins Purchase Journal schema epoch 19. Epoch 19 deliberately has
the same physical SQLite shape as epoch 18, but it is a new semantic recovery
boundary. Existing epoch-18 state is rejected without mutation. There is no
migration, compatibility reader, dual-version adapter, or fallback path.

The Testnet-10 runtime is replaced with a fresh data directory, wallet/vault
identity, staging keys, evidence stores, and Authority replay state after local
conformance passes. The retired epoch-18 runtime remains an immutable operator
archive and is never merged into epoch 19.

## Consequences

- Alpha.8 code, packages, active fixtures, commands, and current documentation
  disappear in the same release; historical ADRs and evidence remain labelled
  as history.
- A clean runtime identity and fresh funded Testnet-10 proof are required before
  claiming the cutover operationally complete.
- Rollback means restoring the complete alpha.8 runtime and its epoch-18 state;
  partial rollback or cross-epoch state reuse is prohibited.

## Rejected alternatives

- In-place Journal migration: conflates protocol recovery semantics across an
  unstable dependency boundary.
- Dual alpha.8/alpha.9 support: adds a permanent compatibility path without a
  user or production-state requirement.
- Version-only dependency bump: omits the new normative expiry and commitment
  conformance obligations.
