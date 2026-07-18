# ADR-0003: Sompi, AP2, x402, and Kaspa-x402 ownership

- Status: Accepted
- Date: 2026-07-11
- Amended by: ADR-0015 (HTTP/MCP transport ownership) and ADR-0017 (generic
  x402 Merchant path; AP2-derived local evidence)

## Context

AP2 and x402 solve different problems. Treating either as a complete replacement
for Sompi or treating them as competitors causes authorization, commerce, and
payment execution to collapse into one layer.

## Decision

Use this ownership split:

- **Sompi:** Agent/MCP UX, canonical Purchase lifecycle, durable journal,
  policy, wallet, consensus vault, orchestration, recovery, and linked receipts.
- **AP2 adapter:** Merchant terms, User authorization, mandates, verification,
  and AP2 evidence.
- **x402/Kaspa-x402:** HTTP payment requirements, payment payload, supported
  schemes, Kaspa execution, settlement, and payment-protocol validation.
- **Merchant commerce implementation:** offer creation, authorization checking,
  fulfilment, and Merchant receipts.

AP2 does not authorize treasury mechanics. Vault funding does not authorize a
Purchase. Payment does not prove fulfilment.

## Consequences

- AP2 and x402 can be used together without either implementing the other.
- Sompi retains the product-level control and audit model.
- Raw protocol types do not become Sompi's durable state.
- Merchant and payment evidence must be linked explicitly in the Purchase
  Journal.

## Rejected alternatives

- AP2 replaces Sompi: AP2 does not supply treasury custody, policy, execution,
  MCP UX, or recovery.
- x402 alone is Purchase Authorization: payment requirements originate at the
  payment layer and do not prove User intent.
- Sompi owns another x402 implementation: duplicates Kaspa-x402.
