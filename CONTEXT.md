# Sompi context

## Product

Sompi is a local purchasing runtime for agents. It converts one paid HTTP
request into a durable `Purchase`: verified Merchant terms, exact user
authorization, policy reservation, KAS payment, settlement evidence,
fulfilment, and one receipt.

The agent never receives wallet keys, Authority keys, policy credentials, bot
tokens, or operator recovery access.

## Current scope

- Network: Kaspa Testnet-10.
- Authorization: human-present, AP2-derived internal evidence.
- Payment: Kaspa-x402 `0.1.0-alpha.8`.
- Exact profiles: `standard-native` and `additive`.
- Batch: capital-backed channels with approval for every charge increment.
- Agent interface: authenticated local API and `sompi-agent`.
- Compatibility: stateless MCP wrapper.
- Approval projection: terminal or Telegram through the isolated Authority.

AP2 v0.2 source and schemas are pinned for provenance monitoring. Sompi does
not emit AP2 Merchant artifacts or claim AP2 interoperability. A generic
supported x402 Merchant needs no Sompi integration.

## Domain model

### Purchase

The stable lifecycle record. It owns:

- caller request key and canonical resource request;
- Merchant origin and verified x402 requirements;
- authorization and policy reservation;
- payment attempt and Treasury movement references;
- settlement and chain evidence;
- fulfilment digest and content reference;
- one canonical receipt;
- durable recovery state.

Raw AP2-derived and x402 bytes are immutable Evidence Attachments, not fields
in the stable domain model.

### Purchase module

The deep module owning orchestration and recovery. API, CLI, skill, and MCP all
call this same module.

### Trusted Authority

A separate deterministic, non-agentic process. It displays and signs the exact
Purchase decision. It cannot alter the request and the agent cannot produce an
approval.

### Treasury

Operator-controlled policy and money movement. It reserves capacity before
signing, owns the vault and staging lifecycle, and exposes only bounded
capabilities to payment execution.

### Chain Evidence

The only module allowed to turn raw node/witness observations into privileged
state transitions. Temporary absence, contradiction, pruning, or unavailable
history fails closed.

## Protocol ownership

Sompi owns the Purchase lifecycle, policy, authorization, Treasury, Journal,
fulfilment, receipt, and recovery.

The AP2 adapter owns only internal authorization/evidence encoding and upstream
source monitoring.

The Kaspa-x402 adapter owns payment-requirement validation, client transaction
construction, payment transport, settlement verification, and channel
operations. Sompi does not reimplement the x402 schemes.

There is no universal payment-rail plugin system. A broader execution seam is
introduced only after a second real payment adapter demonstrates the common
contract.

## Canonical interfaces

The authenticated local API exposes:

- `POST /purchases`
- `GET /purchases/{purchaseId}`
- `POST /purchases/{purchaseId}/recover`

The `sompi-agent` CLI uses that API. `sompi-mcp` exposes only `purchase`,
`purchase_status`, and `purchase_recover`, and holds no privileged capability
beyond the agent API credential.

## Lifecycle

```text
created
  -> terms_verified
  -> authorized or denied
  -> funds_reserved
  -> payment_prepared
  -> payment_submitted
  -> settled
  -> fulfilled
  -> receipted
```

Every irreversible edge is Journal-first. Before a blockchain or Merchant
effect, Sompi commits canonical intent, authorization, policy reservation,
prepared bytes or a secure reference, idempotency identity, and an effect
fence.

Ambiguous outcomes enter recovery. Recovery observes before retrying and never
creates replacement payment authority. Fulfilment recovery reuses the same
settled payment and request.

Journal epoch 15 is the only active schema.

## Authorization facts

The signed decision binds at least:

- Purchase ID and request key;
- Merchant identity and origin;
- URL, method, body digest, and resource identity;
- x402 requirements digest and payee;
- network, scheme, exact profile or batch channel epoch;
- advertised amount or maximum batch charge;
- effective fee and total-cost ceilings;
- effective finality floor;
- expiry and Authority identity.

For batch, the accepted actual charge must be no greater than the authorized
ceiling and is recorded separately.

## Payment rules

### Standard-native

A version-0 transaction pays exactly the advertised amount to the Merchant.
The payer cost is that amount plus the explicit bounded network fee.

### Additive

A version-1 KIP-10-based transaction advances a reusable Merchant head. The
successor increase equals the advertised amount and is the only Merchant gain.
Unpaid offers do not reserve or retire heads. Unknown lineage disables that
head until trusted recovery proves the successor.

### Batch

Channel funding is capital, not Purchase authorization. Every voucher increase
requires a separate signed decision. Charges are cumulative and monotonic,
preserve the claim-fee reserve, and recover through an accepted claim and
continuation or a refund after the strict absolute DAA boundary.

## Trust boundaries

- Agent and MCP are untrusted.
- Merchant and all HTTP inputs are untrusted until verified.
- Telegram transports controls but does not create authority.
- Authority signing material is unavailable to Agent/API/MCP processes.
- Wallet, vault, and operator recovery are unavailable to the agent account.
- Node observations require the configured Chain Evidence policy.
- All protocol versions, algorithms, networks, schemes, and profiles are
  exact allowlists.

## Delivery boundary

This is a testnet alpha. Mainnet, autonomous authorization, passkeys, UCP, and
official AP2/x402 interoperability require separate accepted gates. Historical
proofs and ADRs remain evidence of earlier development decisions; current
behavior is defined by this file, the architecture, accepted ADRs, the
implementation plan, and `CURRENT_STATE.md`.
