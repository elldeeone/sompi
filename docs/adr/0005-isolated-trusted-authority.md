# ADR-0005: Separate deterministic Trusted Authority

- Status: Accepted
- Date: 2026-07-11

## Context

The Agent and MCP process are agentic and exposed to untrusted Merchant content.
They cannot be the AP2 trusted approval surface or hold credentials capable of
authorizing purchases.

## Decision

Ship `sompi-authority` as a separate deterministic executable/process and
security context. It receives canonical approval facts over authenticated local
IPC, independently validates and displays them, and returns approval evidence
or denial.

The MCP process never holds authority credentials. Every request/response is
bound to one Purchase, exact terms, freshness, and anti-replay data.

Implement the signer behind an internal seam. WebAuthn/passkeys are not required
for the first implementation; they may be added after RP identity, origin,
enrolment, recovery, and credential portability are specified and threat-modelled.

## Consequences

- Compromise or prompt injection in the MCP process cannot silently authorize a
  Purchase.
- IPC authentication and process/key lifecycle become explicit security work.
- A simple deterministic local approval implementation can precede passkeys
  without changing Purchase or AP2 semantics.

## Rejected alternatives

- Approval in chat: the LLM conversation is not a trusted surface.
- Authority as an in-process callback: no meaningful security isolation.
- Mandatory passkeys immediately: introduces deployment and recovery decisions
  before the authority interface is proven.
