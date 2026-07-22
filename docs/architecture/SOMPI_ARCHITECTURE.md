# Sompi architecture

Status: accepted and implemented.

## System shape

Sompi is a modular monolith with deep `Purchase` and `Transfer` modules.

```text
Agent skill / sompi-agent / sompi-mcp
                  |
                  v
       authenticated local API
          /               \
         v                 v
 Purchase module     Transfer module
          \               /
           v             v
      Trusted Authority and Treasury
                  |
                  v
           Chain Evidence

receive address -> Funding Intake -> Treasury -> SompiVault
```

The CLI, skill, and MCP wrapper project the same API interfaces.
They do not own payment or recovery behavior.

## Stable records

`Purchase` is the stable record for a paid resource lifecycle.
It contains the canonical request, verified terms, authorization, payment, settlement, fulfillment, and receipt.

`Transfer` is the stable record for a direct KAS send.
It has no Merchant, x402, AP2 Payment Mandate, or fulfillment meaning.

Protocol bytes are immutable Evidence Attachments.
Protocol SDK types do not become Journal schema.

## Deep modules

### Purchase module

The Purchase module owns orchestration, idempotency, effect fencing, recovery, fulfillment, and the public Purchase view.

### Transfer module

The Transfer module owns direct-send intent, approval, policy reservation, Treasury movement, settlement, receipt, and recovery.

### Wallet modules

The Wallet View module shows the stable receive address and bounded Sompi activity.
It also shows KAS-first balances, limits, deposit state, and chain status.
It has no mutation or signing function.

The Funding Intake module detects eligible receive-address UTXOs.
It moves them into the exact vault in the immutable Operator Manifest.
It uses one deterministic Treasury operation, the operator fee ceiling, and
the full Chain Evidence recovery lifecycle.

The Wallet Experience module hides vault addresses, DAA, atomic values, and protocol details by default.

### Protection modules

The Policy Change module owns exact before-and-after policy facts.
It records owner approval and activates immutable policy revisions.
Existing work keeps its original policy snapshot.

Activation uses compare-and-swap against the expected policy digest, generation, and vault digest.
Policy activation and vault migration share one Journal transition gate.
Stale, substituted, replayed, or concurrent changes fail closed.

The Vault Migration module owns a change to the on-chain protection limit.
It pauses outward work and preserves window accounting.
It requires an offline owner signature before it activates the replacement vault.

Before owner execution, one Journal transaction proves that no Treasury or staging effect can conflict.
A prepared vault spend checks the local migration fence before submission.
Replacement launch needs independently accepted recovery evidence at the configured finality floor.

Migration carries the current window start and spent value forward.
It does not create new capacity.
Unknown submission evidence stays in reconciliation and cannot start a replacement transaction.

### Protocol seams

The Checkout Terms seam verifies one supported x402 offer.
The AP2 adapter creates internal human-present authorization evidence.
The Kaspa-x402 adapter executes the payment.

The Treasury seam owns policy capacity, vault funding, fee limits, and ambiguous-effect recovery.
It gives a payment adapter only an attempt-bound capability.

The Chain Evidence seam checks the operator node and independent witness.
The Fulfillment seam accepts content only after verified settlement.
It binds the response to the authorized request, Payment Identifier, and x402 response.
It also checks the bounded body and each precommitted resource digest.

## SompiVault

SompiVault is a stateful KIP-16 covenant on Testnet-10.
The capped Agent path funds Purchases and Transfers.
The offline owner path can recover the vault.

The vault limit and the software policy are independent controls.
A stolen Agent payment key cannot exceed the on-chain rolling-window limit.
The API cannot loosen the operator-owned manifest policy.

The hot wallet is setup and top-up float.
It is not an alternative payment path.

## Agent permissions

The agent can:

- create, inspect, and recover its Purchases
- inspect the read-only wallet view and bounded activity
- propose, inspect, and recover exact Transfers
- propose and inspect protection changes
- receive fulfilled content
- report denials and required operator actions

The agent cannot:

- read wallet, vault, Authority, bot, API, or recovery secrets
- approve a Purchase, Transfer, or policy change
- execute a vault replacement or use the offline owner key
- call Kaspa or x402 directly
- use a new request key to bypass denial or recovery
- use operator recovery

## Process boundaries

| Principal | Permitted access |
|---|---|
| Agent account | Agent API socket and Agent credential |
| `sompi-api` | Journal, Treasury, protocol adapters, Authority client socket |
| `sompi-authority` | Authority key, decision store, replay store, Telegram token |
| Operator | Manifest, recovery transport, backup, offline-owner actions |

The agent account has no wallet, Authority, operator, or recovery group access.
`sompi-mcp` has no capability beyond the Agent API.

Telegram is an Authority display and input surface.
It is not an agent approval capability.

## Journal-first effects

Before an irreversible effect, the Journal records:

- canonical intent and terms
- verified authorization
- policy reservation
- prepared bytes or secure reference
- idempotency and payment identities
- expected effects
- recovery fence and next action

The effect runs after this transaction commits.
Sompi then observes and records the result in a separate transaction.

A timeout after possible submission is ambiguous.
Recovery checks the original effect before it permits another action.
Journal epoch 19 is the only active schema.

## Bounded lifecycles

Each module that consumes a scarce resource owns its Admission Lease.
Authority owns socket and prompt admission. Purchase and Journal own Purchase
count and evidence-byte admission. Treasury owns retries and execution slots.
Admission limits apply before untrusted work consumes expensive resources.

Cancellation before an external effect can release capacity.
Cancellation after possible invocation keeps the effect fenced.
Operator recovery has independent admission capacity that an agent cannot consume.

| Effect | Durable facts required before execution |
|---|---|
| Vault or staging submission | intent, reservation, prepared data, expected outputs, fence |
| Exact payment | verified offer, approval, cost reservation, immutable payment, fence |
| Batch voucher | channel epoch, charge ceiling, accepted-actual-charge rule, cumulative value, Movement |
| Claim or refund | prepared transaction, expected continuation, DAA rule, fence |
| Paid Merchant request | exact request, signature, Payment Identifier, settlement expectation |
| Fulfillment | settled payment, authorized request, Payment Identifier, bounded resource facts |
| Direct Transfer | Transfer intent, exact approval, policy capacity, Treasury operation key, prepared bytes, exact recipient, vault continuation, fence |

## Payment profiles

### Standard-native

The transaction pays the exact Merchant amount and can return payer change.
Sompi verifies inputs, signatures, txid, value, fee, mass, settlement, and chain evidence.

### Additive

The transaction spends one Merchant head and creates its exact successor.
The successor value increases by the advertised amount.

Unpaid offers do not reserve a head.
One valid conflicting transaction wins.
Unknown lineage disables only that head until trusted recovery proves its state.

### Batch settlement

The operator funds a channel before Purchases use it.
Each charge needs a separate Purchase and human authorization.

A voucher increases the authorized cumulative value.
The Merchant claim must preserve exact continuation value.
The client refund is valid only after the strict absolute DAA boundary.

## Interfaces

The Agent API provides wallet, activity, Purchase, Transfer, Policy Change, and Vault Migration views.
It also provides bounded create and recovery operations.

The operator interface provisions the runtime and completes approved vault migrations.
See [the runbook index](../runbooks/README.md) for operator procedures.

## Version rules

Sompi pins unstable protocol dependencies exactly.
Unknown networks, schemes, profiles, algorithms, encodings, and finality rules fail closed.

An upgrade replaces the active adapter and Journal epoch after conformance passes.
It does not keep permanent dual-version paths.

## Excluded scope

- mainnet
- autonomous authorization
- passkeys and phone applications
- UCP
- AP2 interoperability
- hosted multi-user custody
- a general payment-rail interface

Accepted decisions are in the [ADR index](../adr/README.md).
ADR-0023 defines the current alpha.9 cutover and Journal epoch.
