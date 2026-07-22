# Sompi context

## Product

Sompi is a local KAS authority and payment runtime for agents. It converts a
paid HTTP request into one durable `Purchase`. It converts a native-KAS send
into one durable `Transfer`.

The agent does not receive wallet keys, Authority keys, policy credentials,
bot tokens, or operator recovery access.

## Current scope

- Network: Kaspa Testnet-10.
- Authorization: Human-present with internal AP2-derived evidence.
- Payment: Kaspa-x402 `0.1.0-alpha.9`.
- Exact profiles: `standard-native` and `additive`.
- Batch: Capital-backed channels with approval for each charge increase.
- Agent interface: Authenticated local API and `sompi-agent`.
- Compatibility interface: Stateless `sompi-mcp` wrapper.
- Approval interface: Telegram or terminal through the Trusted Authority.
- Direct transfer: Human-approved native KAS from the protected vault.
- Wallet view: Read-only balance, identity, limits, and activity.
- Funding intake: Automatic movement from the receive address to the vault.

Sompi pins AP2 v0.2 source and schemas for provenance monitoring. Sompi does
not send AP2 Merchant artifacts. Sompi does not claim AP2 interoperability.

A Merchant needs only the supported x402 contract. It does not need Sompi
integration.

## Domain model

### Purchase

`Purchase` is the stable lifecycle record for one paid HTTP request. It owns:

- The caller request key and canonical resource request.
- The Merchant origin and verified x402 requirements.
- The authorization decision and policy reservation.
- The payment attempt and Treasury Movement references.
- The settlement and Chain Evidence references.
- The fulfillment digest and content reference.
- One canonical receipt.
- The durable recovery state.

Raw AP2-derived and x402 data are immutable Evidence Attachments. They are not
fields in the stable Purchase model.

### Purchase module

The Purchase module owns Purchase orchestration, idempotency, effect fencing,
state changes, and recovery. API, CLI, skill, and MCP clients use this module.

### Transfer

`Transfer` is the stable lifecycle record for one native-KAS send. It owns the
recipient, amount, authorization, policy reservation, Treasury Movement,
settlement evidence, receipt, and recovery state.

A Transfer has no Merchant, Checkout, x402 requirement, or fulfillment.

### Transfer module

The Transfer module owns direct-send orchestration and recovery. It uses the
Authority, Treasury, and Chain Evidence seams.

### Wallet View

Wallet View is a read-only Treasury projection. It shows one receive address,
balances, limits, chain status, and bounded activity.

Wallet View does not expose a signing capability or a recovery capability.

### Funding Intake

Funding Intake detects UTXOs at the receive address. It moves eligible funds
into the exact vault in the immutable Operator Manifest. It uses the operator
fee ceiling, durable Treasury lifecycle, and Chain Evidence.

Funding Intake cannot select an external recipient. It cannot create a
Purchase or Transfer. It cannot increase policy limits.

### Policy Change

`Policy Change` is the stable record for one owner-approved change to everyday
limits. The Agent can propose a change. The Trusted Authority approves or
denies the exact change.

An approved change activates one immutable Journal policy revision.
It cannot change these controls:

- keys or credentials
- vault script facts
- Merchant egress or allowlists
- Chain Evidence
- admission budgets
- fee ceilings
- recovery authority

### Vault Migration

`Vault Migration` is the operator-owned lifecycle for a vault-protection
change. It stops outward work, preserves usage, and requires the offline owner
key.

The Telegram decision approves the plan. It is not the owner recovery
signature. The receive address does not change during the migration.

### Wallet Experience

Wallet Experience is the user projection for all interfaces. It shows one
wallet, one receive address, KAS amounts, limits, and required actions.

Protocol, vault, DAA, and atomic data stay in technical details.

### Trusted Authority

The Trusted Authority is a separate deterministic process. It shows and signs
the exact decision facts. The agent cannot produce an approval.

### Treasury

Treasury owns policy capacity and money movement. It owns the vault, staging,
signing capability, fee limits, and effect recovery.

Treasury reserves capacity before signing. A payment adapter receives only a
Purchase-bound capability.

### Chain Evidence

Chain Evidence is the only module that can authorize a privileged state change
from chain observations. Missing, conflicting, pruned, or unavailable history
fails closed.

## Protocol ownership

Sompi owns Purchase, Transfer, policy, Treasury, Journal, fulfillment, receipt,
and recovery.

The AP2 adapter owns internal authorization and evidence encoding. It also
monitors the pinned upstream source.

The Kaspa-x402 adapter owns payment-requirement validation, payment
construction, transport, settlement verification, and channel operations.

Sompi does not implement another x402 mechanism. Sompi does not put AP2
semantics in Kaspa-x402.

There is no general payment-rail plugin system. A second real payment adapter
must exist before Sompi adds a general execution seam.

## Canonical interfaces

The authenticated local API includes these primary operations:

- `GET /wallet`
- `GET /wallet/activity`
- `POST /transfers`
- `GET /transfers/{transferId}`
- `POST /transfers/{transferId}/recover`
- `POST /purchases`
- `GET /purchases/{purchaseId}`
- `POST /purchases/{purchaseId}/recover`
- `POST /policy-changes`
- `POST /vault-migrations`

`sompi-agent` uses this API. `sompi-mcp` projects the same operations and has no
additional authority.

Public Testnet-10 amounts use tKAS. Canonical accounting uses integer sompi.

## Lifecycle rules

Each irreversible edge is Journal-first. Before an external effect, Sompi
records these items:

- Canonical intent.
- Exact authorization.
- Policy reservation.
- Prepared bytes or a secure reference.
- Idempotency and effect identities.
- Expected outputs.
- Recovery and fencing state.

Sompi observes an uncertain effect before it permits another action. Recovery
does not create replacement payment authority. Fulfillment recovery uses the
same settled payment and request.

Journal epoch 19 is the only active schema.

## Trust boundaries

- Agent and MCP input is untrusted.
- Merchant and HTTP input is untrusted until verification is complete.
- Telegram transports controls but does not create authority.
- Authority signing material is not available to Agent, API, or MCP processes.
- Wallet and operator recovery access is not available to the agent account.
- Node observations must satisfy the configured Chain Evidence policy.
- Protocol versions, networks, schemes, and profiles use exact allowlists.

## Delivery boundary

Sompi is a testnet alpha. Mainnet, autonomous authorization, passkeys, and UCP
require separate accepted gates.

This file, the architecture, accepted ADRs, the active implementation plan,
and `CURRENT_STATE.md` define current behavior. Historical plans and evidence
record earlier work.
