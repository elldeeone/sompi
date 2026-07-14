# Security Hardening Review: Sompi

## Evidence Basis

This portfolio is derived from the twenty-one reportable findings at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`, their executable validation and
attack-path records, the canonical threat model, and Sompi's accepted
architecture and ADRs. I inspected the source boundaries that turn RPC,
Merchant, Agent, local-file, and lifetime claims into Purchase, vault,
Treasury, policy, and authority state. Three structural opportunities qualify;
the remaining work is not a collection of unrelated line-level mistakes.

The evidence is unsealed because this analysis ran during final reporting.
That does not obscure the source identity: the tracked tree matched the exact
target revision with no drift. The detailed inventory and integrity references
are in [`context.md`](context.md). These proposals are design work only; none
of the findings is remediated by this portfolio.

## Constraints

We assume a balanced security and delivery profile, with no supplied latency,
memory, storage, or operational budget. The accepted constraints remain
binding: preserve the stable Purchase model; keep AP2 authorization separate
from Kaspa-x402 payment execution; retain journal-first durable intent and
recovery; keep the Trusted Authority isolated; support only human-present
Kaspa-x402 `exact` on Testnet-10; and do not create a universal payment-rail
system or require changes to the sibling Kaspa-x402 repository.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Proof-backed chain evidence and finality | 13 Settlement, recovery-winner, history-loss, and provisional-finality findings (`CAN-003`, `CAN-004`, `CAN-006`, `CAN-016`–`CAN-018`, `CAN-020`, `CAN-023`–`CAN-026`, `CAN-030`, `CAN-033`) | 1. local observer guards; 2. typed Chain Evidence Gateway; 3. trusted local evidence plane | Choose Option 2 for the current testnet cutover, while retaining Option 3 as a public/mainnet gate. | [Technical proposal](proposals/proof-backed-chain-evidence.md) |
| Trusted operator provisioning and configuration provenance | Vault recovery ownership, key validity, cleartext Merchant transport, and policy-file provenance (`CAN-001`, `CAN-007`, `CAN-008`, `CAN-032`) | 1. local provenance guards; 2. operator-provisioned manifest; 3. signed offline bundle | Choose Option 2 for a single-host deployment. Option 3 becomes attractive only with real multi-host or offline distribution. | [Technical proposal](proposals/trusted-operator-provisioning.md) |
| Bounded, cancellable operation lifecycles | Authority socket and prompt exhaustion, pre-validation evidence growth, and permanent direct-Treasury lockout (`CAN-009`, `CAN-013`, `CAN-027`, `CAN-031`) | 1. local limits and terminalization; 2. per-boundary admission leases | Choose Option 2, implemented separately inside the Authority and MCP/Purchase trust boundaries. | [Technical proposal](proposals/bounded-operation-lifecycles.md) |

## Recommendation Summary

I recommend a staged combination of the three Option 2 designs. First, give
Sompi one typed chain-evidence vocabulary that cannot confuse provisional,
accepted, historical, negative, or unknown observations; keep that boundary
inside Sompi and leave x402 mechanics in Kaspa-x402. Second, remove operator
configuration from the Agent-facing data path by installing one validated,
secure local manifest whose digest is durably recorded. Third, make retained
work acquire a bounded lease before it consumes sockets, prompt capacity,
immutable evidence bytes, or the direct-Treasury slot, with cancellation and
terminal release defined at admission time.

The important caveat is chain authenticity. Consolidating evidence checks
prevents control drift and closes many provisional/history failures, but it
does not by itself make one remote RPC truthful. For the current testnet
cutover, the gateway can fail closed when it cannot obtain the required proof
or independent witness. Before any public or mainnet claim, I would require
the stronger Option 3 evidence plane or a demonstrably equivalent verified
inclusion/finality source.

The local-guard options remain useful as immediate tactical work and should be
kept during migration. They are not a durable substitute for owned boundaries:
the source already shows the same finality, provenance, and lifetime decisions
being made differently at adjacent call sites.

## Next Decisions

- Confirm whether Testnet-10 may remain unavailable when authenticated chain
  proof is absent, or whether independently operated witnesses are an accepted
  temporary backend for the Chain Evidence Gateway.
- Set explicit accepted/confirmed finality floors for Settlement, direct
  Treasury movements, vault continuation, staging, and recovery-capacity
  release. Merchant-selected `mempool` must never lower an operator minimum.
- Decide whether the operator manifest is hot-reloadable. If it is, define a
  monotonic revision, descriptor-stable read, atomic activation, and rollback
  ceremony rather than inheriting the current mtime-only behavior.
- Supply admission budgets for pre-authentication sockets, authenticated
  prompts, Purchase count, evidence bytes, and direct-Treasury preparation
  retries, plus the observability and operator-recovery expectations at each
  limit.
- Select proposals before implementation. Implementation plans were
  deliberately not created in this analysis.
