# Sompi architecture

Status: accepted target and current implementation.

## Shape

Sompi is a modular monolith centred on one deep `Purchase module`.

```text
Agent skill / sompi-agent / MCP compatibility
                    |
                    v
          authenticated local API
                    |
                    v
              Purchase module
       +------------+-------------+
       |            |             |
       v            v             v
 generic x402   Trusted       policy and
 Merchant seam  Authority     Treasury
       |            |             |
       +------------+-------------+
                    |
                    v
          Kaspa-x402 execution
                    |
                    v
             Chain Evidence
                    |
                    v
       fulfilment and one receipt
```

API, CLI, skill, and MCP do not own purchasing behavior. They project the same
Purchase interface.

## Stable domain

`Purchase` is protocol-neutral. It records:

- identity and caller request key;
- canonical HTTP resource request;
- verified Merchant and Checkout Terms;
- authorization decision and evidence references;
- policy reservation and total cost ceiling;
- payment attempt and Treasury movement references;
- settlement and chain evidence;
- fulfilled content digest/reference;
- one receipt;
- current state, transitions, and recovery action.

AP2-derived/x402 bytes remain immutable Evidence Attachments. SDK types never
become Journal schema.

## Deep modules and seams

### Purchase module

Owns orchestration, idempotency, effect fencing, state transitions, recovery,
and the public Purchase view.

### Checkout Terms seam

Makes a bounded address-pinned request, accepts one supported x402 offer, and
projects canonical Merchant/request/payment facts. It does not require Merchant
AP2 support.

### Authority seam

Sends the exact canonical decision facts to a separate deterministic process.
The Authority displays them, obtains one human decision, signs it, and persists
the decision before replying.

### Treasury seam

Owns policy capacity, vault funding, staging, signing capability, fee ceilings,
and ambiguous-effect recovery. Payment adapters receive only a Purchase-bound
capability.

### Kaspa-x402 seam

Uses the pinned public packages for exact transaction construction, payment
transport, settlement verification, reusable additive heads, batch vouchers,
claims, continuation, and refunds.

### Chain Evidence seam

Combines the configured operator node with the independent witness and records
the exact observation used by each privileged transition.

### Fulfilment seam

Accepts content only after settlement. It binds the final response to the
authorized request, payment identifier, x402 response, bounded body, and any
precommitted resource digest. The receipt is a Sompi lifecycle fact, not a
Merchant protocol.

## Process and privilege layout

```text
agent account
  -> sompi-agent
  -> agent API socket + agent credential

sompi-api account
  -> Purchase Journal
  -> wallet/vault runtime
  -> Authority decision socket (client only)
  -> Merchant and chain egress under Operator Manifest policy

sompi-authority account
  -> Authority signing key
  -> decision/replay store
  -> Telegram bot token when Telegram is enabled

operator
  -> immutable manifest installation
  -> recovery socket/credential
  -> backup and explicit recovery commands
```

The agent account is not a member of wallet, Authority, operator, or recovery
groups. MCP runs with no additional capability.

## Journal-first effects

Before any irreversible blockchain or Merchant action, one transaction commits:

- canonical intent and selected terms;
- verified authorization;
- policy reservation;
- prepared bytes or secure reference;
- idempotency and payment identities;
- expected outputs/effects;
- lease generation and recovery state.

The effect then executes outside the database transaction. Its result is
observed and committed separately. A timeout or crash after possible submission
enters reconciliation; it never grants permission to rebuild or resend.

Journal epoch 15 is the only active schema.

## Exact payment

### Standard-native

```text
payer input(s) -> Merchant output == advertised amount
               -> optional payer change
```

The initial supported proof shape uses a version-0 transaction. Sompi verifies
the authoritative input UTXOs, signatures, txid, amount, fee, mass, request
authorization, settlement, and chain evidence.

### Additive

```text
input[0]  = current Merchant head
input[1+] = payer funding
output[0] = same-script successor, old amount + advertised amount
```

The successor delta is the only Merchant payment. Offers are read-only. A
valid signed candidate atomically claims a selected head; one conflict wins and
the loser requires a new offer and a separately authorized attempt. Unknown
lineage marks only that head unavailable until trusted recovery proves it.

## Batch settlement

Batch is a separate lifecycle:

1. Operator-capitalized escrow channel.
2. Purchase-specific human authorization for a maximum charge.
3. Monotonic signed cumulative voucher.
4. Merchant claim with exact continuation accounting.
5. Client refund only after the strict absolute DAA boundary.

Deposit/top-up authorization is never treated as Purchase authorization. Every
charge increment has its own Purchase, policy reservation, Authority evidence,
Movement, settlement, fulfilment, and receipt.

## API and agent integration

The canonical operations are:

- `POST /purchases`
- `GET /purchases/{purchaseId}`
- `POST /purchases/{purchaseId}/recover`

`sompi-agent` is the normal agent integration. The packaged skill instructs an
agent to use only this CLI and to reuse stable request keys. MCP provides the
same three operations as a compatibility projection over the API.

Telegram is an Authority projection, not an Agent approval capability. Callback
data is bound to one user, chat, prompt, Purchase, decision, and expiry.

## Protocol versioning

Pre-1.0 dependencies are pinned exactly. Unknown network, scheme, profile,
algorithm, transaction encoding, finality, or evidence profile fails closed.

An upgrade replaces the active adapter and Journal epoch after conformance; it
does not accumulate permanent dual-version paths.

## Out of scope

- Mainnet.
- Autonomous/open authorization.
- Passkeys and phone applications.
- UCP.
- Official AP2/x402 interoperability.
- Hosted multi-user custody.
- A generic payment-rail plugin framework.

## Decision records

Accepted decisions are in [`../adr/`](../adr/README.md). The current cutover is
defined by ADR-0015, ADR-0016, and ADR-0017 together with the earlier Journal,
Authority, provisioning, chain-evidence, and lifecycle records.
