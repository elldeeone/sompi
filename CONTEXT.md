# Sompi context

## Product definition

Sompi is a deterministic agent treasury and purchasing system for Kaspa. It
lets an agent request a purchase while keeping authorization, keys, spending
policy, payment execution, recovery, and audit evidence outside the agent's
control.

Sompi is not a new commerce protocol, an AP2 fork, or an x402 implementation.
It composes evolving standards around a stable local Purchase model:

- AP2 expresses user intent, merchant terms, authorization, and evidence.
- x402 carries HTTP payment negotiation and settlement.
- Kaspa-x402 executes supported x402 payments on Kaspa.
- Sompi owns the user/agent experience, treasury controls, orchestration,
  durable history, and recovery.

## Actors

### User

Owns the treasury and decides the policy under which an agent may purchase.
For human-present purchases, the User approves exact terms through the Trusted
Authority.

### Agent

Requests purchases through the authenticated Purchase API or its MCP
compatibility adapter and receives structured status and receipts. The Agent is
untrusted for authorization, key custody, evidence validation, policy
enforcement, and payment state transitions.

### Merchant

Offers a resource under signed or otherwise verifiable terms, verifies the
relevant authorization, accepts x402 payment, fulfils the resource, and emits
receipt evidence.

### Trusted Authority

A deterministic, non-agentic executable and security context. It displays the
exact merchant, resource, amount, asset, network, expiry, and request identity;
then returns approval evidence or denial. It owns or reaches the authority
credential. The MCP process cannot invoke its signer without the deterministic
approval ceremony.

### Kaspa network

The external settlement system. Blockchain submission cannot be transacted
atomically with Sompi's SQLite journal, so every submitted operation must be
recoverable and reconcilable.

## Domain language

### Purchase Intent

The Agent's request to acquire one resource from one Merchant, including the
HTTP method and resource identity needed to prevent request substitution. It is
not authorization.

### Checkout Terms

The Merchant's exact proposed terms: Merchant identity, resource, amount,
asset, network, expiry, and relevant request fingerprint. Signed AP2 artifacts
or x402 offers may be attached as evidence, but their SDK types are not the
canonical representation.

### Purchase

Sompi's durable record of one acquisition from intent through authorization,
payment, fulfilment, receipt, failure, and recovery. `PurchaseId` is the
canonical correlation identifier inside Sompi.

### Purchase API

The canonical authenticated HTTP projection of the Purchase module's
`purchase`, `status`, and `recover` operations. Its OpenAPI description and
runtime validation share the same schemas. MCP is a stateless compatibility
projection over the same operations, not a separate lifecycle or authority
surface.

### Purchase Authorization

The decision that this Agent may buy this exact resource from this exact
Merchant under these exact Checkout Terms. AP2 belongs here.

### Treasury Reservation

The durable reservation of spending capacity required before signing or
submitting a payment. It covers the Merchant price plus explicitly bounded
additional treasury costs, including network, vault-staging, claim, refund, or
recovery fees. For batch, it may also reserve an authorized channel ceiling.
The KIP-10 additive successor delta is the Merchant price itself; there is no
additional Merchant top-up. A Treasury Reservation is not Purchase
Authorization.

### Treasury Movement

Funding, deposit, payment, refund, claim, or recovery executed by the wallet or
consensus vault. Vault policy governs this movement separately from Purchase
Authorization.

### Payment Attempt

One idempotent attempt to execute an authorized Purchase through Kaspa-x402,
either as one exact transaction authorization or one batch voucher increment.
It has a stable payment identifier and enough persisted material to determine
whether an interrupted external action occurred.

### Settlement

Verified evidence that the payment reached the required Kaspa finality and
matches the authorized Merchant, resource, amount, asset, network, request, and
Payment Attempt.

### Fulfilment

The Merchant's delivery of the purchased resource. Payment success and
Fulfilment are separate facts.

### Receipt

Evidence linking Checkout Terms, Purchase Authorization, Payment Attempt,
Settlement, and Fulfilment. A Receipt does not replace the underlying signed
artifacts.

### Evidence Attachment

An immutable protocol artifact stored with media type or format, exact
protocol profile, issuer, digest, creation time, and verification status.
Examples include AP2 mandates and receipts, x402 requirements and settlement
responses, merchant offers, and Kaspa transaction evidence.

### Purchase Journal

The authoritative SQLite record of Purchase state, idempotency, policy
reservations, planned external effects, observations, and Evidence Attachment
metadata.

### Reconciliation

Deterministic recovery that compares persisted intent with Kaspa and Merchant
observations after interruption. It advances or repairs state without blindly
repeating an irreversible action.

### Operator Provisioning

A short-lived, non-agentic ceremony that validates and installs one immutable
Operator Manifest before either production executable starts. It owns the
recovery public key, vault cap/window, Treasury policy, Merchant HTTPS allow
rules, supported testnet profile, trusted chain-evidence sources, and finality
floors. The Agent and MCP process cannot create, replace, or loosen it.

### Operator Manifest

The canonical, versioned operator configuration installed by Operator
Provisioning. Its exact bytes have a stable digest and monotonic revision.
Runtime modules receive immutable typed projections plus that identity; they do
not independently parse environment variables or policy files. A funded vault
is bound to the static manifest facts from which its script and address were
derived.

### Chain Evidence

A durable, typed assertion about one Kaspa transaction, outpoint, spend, or
continuation. It records canonical facts, observation/proof profile, source
identity, finality level, time, and digest. Current UTXO or mempool presence is
an observation, not durable accepted history and not Kaspa consensus finality.

### Finality Floor

The operator-owned minimum evidence level required before a specific Purchase
or Treasury transition becomes terminal. Protocol finality, local
depth-confirmation policy, and Kaspa consensus finality remain separate facts.
A Merchant may require a stronger floor but cannot lower Sompi's floor. The
effective floor is part of exact human-present Purchase Authorization.

### Admission Lease

A bounded, expiring right to consume one scarce runtime resource such as an
Authority socket/prompt, pre-validation Purchase/evidence capacity, or direct
Treasury preparation slot. The owning module durably defines acquisition,
cancellation, expiry, recovery, and terminal release; cancellation after a
possible external effect always enters Reconciliation.

## Product invariants

1. The Agent can request but cannot authorize its own Purchase.
2. The MCP process cannot access authority signing credentials.
3. A Purchase Authorization binds exact Merchant, resource/request, amount,
   asset, network, expiry, and Purchase identity.
4. Treasury capacity is reserved durably before payment signing or submission.
5. A batch/channel deposit never authorizes its later individual purchases.
6. Every external side effect has a persisted idempotency identity and a
   recovery path.
7. Settlement must match the authorization and payment attempt before Sompi
   marks a Purchase paid.
8. Payment does not imply Fulfilment; both are recorded.
9. Canonical Purchase state never depends on an AP2 or x402 library object.
10. Unknown protocol profiles, malformed evidence, mismatched hashes, replay,
    and ambiguous recovery fail closed.
11. Agent-controlled URLs are subject to egress policy, redirect checks,
    private-network protection, and request fingerprinting.
12. Mainnet remains disabled until every recorded mainnet gate is satisfied.
13. Only Operator Provisioning may establish or loosen operator trust,
    recovery authority, policy, Merchant transport, or chain-evidence floors.
14. Only the Chain Evidence module may promote raw node observations into facts
    that terminalize Settlement, Treasury Movement, or recovery.
15. `mempool`, `accepted`, local depth confirmation, and Kaspa consensus
    finality are never treated as interchangeable.
16. Scarce work acquires a bounded Admission Lease before consuming sockets,
    prompts, evidence bytes, Purchase rows, or exclusive Treasury preparation.
17. HTTP and MCP call the same Purchase interface; neither transport owns
    lifecycle or recovery state.
18. Every exact payment uses `kaspa-exact-v2` with an explicitly supported
    `standard-native` or `additive` profile.
19. An additive successor delta is the entire Merchant payment and no separate
    Merchant output is allowed.
20. A batch voucher ceiling never replaces the individual Purchase
    Authorization or the separately recorded actual charge.

## Non-goals for the first end-to-end release

- Maintaining Sompi's bespoke x402 v1 protocol or its state.
- Creating a competing AP2 specification or a Sompi-specific x402 standard.
- Modifying Kaspa-x402 to understand AP2.
- Supporting carts, tax, shipping, fulfilment orchestration, or order lifecycle
  through UCP.
- Autonomous/open AP2 mandates.
- Making WebAuthn/passkeys mandatory before the authority threat model and
  recovery requirements are understood.
- A generic multi-rail plugin marketplace.
- Public OAuth, A2A, or another generic agent protocol before the local
  Purchase API proves its lifecycle.
- Compatibility readers or migrations for pre-cutover development Journal
  epochs.
- Mainnet production claims.

## Success for the first end-to-end release

A human-present testnet Purchase can be initiated through the authenticated
Purchase API or its MCP compatibility adapter, bound to verified Merchant
terms, deterministically approved outside the agent process, reserved in the
Purchase Journal, paid through either Kaspa-x402 `kaspa-exact-v2` profile,
reconciled after injected crashes, fulfilled by a demo Merchant, and returned
with linked AP2, x402, and Kaspa evidence. The separately gated batch proof
demonstrates deposit, individually authorized voucher increments, claim,
continuation, and strict-boundary refund without treating the channel as
authorization. Replays, substitutions, unknown versions, unsafe egress, and
state mismatches are rejected.
