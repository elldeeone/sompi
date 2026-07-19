# ADR-0019: Wallet visibility and vault-backed direct transfers

- Status: Accepted
- Date: 2026-07-19
- Amends: ADR-0002, ADR-0003, ADR-0005, ADR-0007, and ADR-0015

## Context

Sompi can purchase x402 resources safely, but an agent cannot answer ordinary
wallet questions or send native KAS to an arbitrary Kaspa address. The existing
runtime already owns the relevant security mechanisms: isolated human
authorization, operator policy, a spending-limited SilverScript vault, durable
Treasury Movements, Chain Evidence, and recovery.

Treating a direct transfer as a fake Purchase would invent a Merchant,
Checkout, and fulfilment that do not exist. Exposing `TreasuryOperationModule`
directly would let an Agent-facing caller bypass exact human authorization and
would leak mutation and recovery details across the Treasury seam.

AP2 v0.2 standardizes payments linked to Merchant Checkouts. It does not
standardize arbitrary wallet-to-wallet transfers. Its Agent Authorization
model remains useful as a pattern, but Sompi must not label a direct transfer
as an AP2 Payment Mandate or claim AP2 transfer interoperability.

## Decision

Add a protocol-neutral, deep `Transfer module` beside the existing `Purchase
module`. `Transfer` is Sompi's stable lifecycle record for one native-KAS send
and owns:

- a caller request key and canonical recipient/amount/network intent;
- a canonical fee and total-cost ceiling;
- exact isolated-Authority authorization or denial;
- policy capacity reservation;
- one vault-backed Treasury Movement;
- submission, settlement, Chain Evidence, receipt, and recovery;
- durable idempotency and effect fencing before any signature or broadcast.

The initial lifecycle is human-present and Testnet-10 only:

```text
created
  -> awaiting_authority
  -> authorised or denied
  -> funds_reserved
  -> prepared
  -> submitted
  -> settled
  -> receipted
```

An ambiguous submission remains recoverable and never creates replacement
authority. The Transfer module calls the existing `vault_send` Treasury
adapter. The SilverScript continuation, operator hard limits, fee ceiling,
Chain Evidence floor, and Journal-first effect rules remain authoritative.

The Trusted Authority signs an internal `sompi.transfer.1` decision that binds
at least Transfer ID, request key, source vault identity, exact canonical
recipient, amount, network, maximum fee, maximum total cost, expiry, policy and
manifest identities, and effective finality floor. The deterministic approval
display shows those same facts. Plain agent or chat text only proposes the
Transfer; one matching trusted approval authorizes it.

Add a read-only Treasury projection for agent wallet questions. It reports
network, public funding/receive identity, vault identity, observed vault
balance, policy-reserved amount, available amount, hard limits, chain status,
and bounded Sompi-recorded activity. It does not expose keys, raw credentials,
operator recovery, or mutation methods. Values state their provenance and do
not pretend that Journal activity is a complete chain index.

The canonical local interface gains wallet-view and Transfer operations. The
agent CLI and optional MCP process remain thin adapters over that interface.
Neither owns authorization, signing, Treasury, settlement, or recovery.

This change starts a clean Journal schema epoch. There is no compatibility
reader because Sompi remains a development-only testnet alpha.

## Later recipient grants

Pre-approved recipients are a separately gated authorization feature. A grant
must be Authority-signed, revocable, network/address exact, bounded by
per-transfer and period limits, and time-limited. It may narrow but never loosen
operator hard ceilings. Until that design is accepted, every Transfer requires
one exact human-present approval.

## Consequences

- Purchase remains commerce-specific and Transfer remains money-movement
  specific.
- Existing Authority, Treasury, Chain Evidence, policy, and recovery
  implementations gain leverage without widening their interfaces to agents.
- x402 and Kaspa-x402 remain unchanged and are not involved in a direct send.
- AP2 claims remain honest: the transfer authorization is AP2-derived internal
  evidence, not an AP2 Payment Mandate.
- Wallet visibility is useful without granting wallet authority.

## Rejected alternatives

- Fake a zero-item Purchase: invents Merchant and Checkout semantics.
- Use `mandate.payment.1`: AP2 requires a payment linked to a Checkout.
- Expose Treasury operations directly: bypasses human authorization.
- Run signing in the Agent or MCP process: collapses the trust model.
- Implement recipient preauthorization immediately: combines a new Transfer
  lifecycle with autonomous authorization before the human-present flow is
  proven.
