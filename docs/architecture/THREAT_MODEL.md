# Threat model

## Protected assets

- wallet, vault, Authority, bot, API, and recovery credentials
- KAS and policy capacity
- exact user decisions
- Journal and lifecycle integrity
- prepared transactions and idempotency identities
- settlement, chain, fulfillment, and receipt evidence
- paid content and service availability

## Trust boundaries

The agent, Merchant, x402 data, callback data, chain responses, and caller input are untrusted.
Sompi verifies and bounds this data before use.

The Operator Manifest, Authority, Treasury, Journal, and pinned protocol code have narrow trusted roles.
No trusted role can silently take another role's authority.

## Required properties

1. An agent cannot approve work or loosen policy.
2. Human approval covers every payment fact.
3. A Merchant receives exactly the approved amount or batch charge.
4. Durable intent exists before an irreversible effect.
5. Ambiguous effects cannot gain new authority.
6. Fulfilment recovery cannot make a second payment.
7. Request, Merchant, profile, channel, and finality facts cannot be substituted.
8. Secrets do not enter agent output, packages, evidence reports, or the Journal.
9. Sompi bounds untrusted work before expensive processing.
10. A Transfer sends only the approved amount to the approved address.

## Main controls

| Threat | Control |
|---|---|
| Agent fabricates approval | A separate Authority owns the signing key. |
| Chat text becomes approval | Only exact Authority input or a bound Telegram callback is valid. |
| Merchant or resource changes | Signed request and requirement digests must match. |
| Paid redirect leaks payment | Sompi rejects redirects on paid transport. |
| Corrective retry spends twice | One immutable artifact exists for each authorization. |
| Fake transaction data | Sompi verifies inputs, signatures, txid, value, fee, and mass. |
| Extra Merchant value | Exact economic equality checks reject the transaction. |
| Additive head conflict | One compare-and-swap winner advances the head. |
| Batch overcharge | Ceiling, actual charge, voucher, route, and channel must match. |
| Early refund | The current DAA must be greater than the absolute timeout. |
| Crash after broadcast | Prepared data and the effect fence are durable. |
| Finality downgrade | Recovery cannot reduce the stored finality floor. |
| Chain-source spoofing | The operator node and independent witness must corroborate privileged transitions. |
| Callback replay | Bot, user, chat, prompt, decision, and expiry must match once. |
| Secret file leak | Reads use owner-only, no-follow, single-link files. Release checks inspect the exact tarball allowlist. |
| Transfer substitution | Intent, approval, policy, prepared outputs, exact observation, and receipt must match. |
| Wallet view leaks authority | The view is read-only and contains no secret or mutation capability. |

## Authorization joins

For a Purchase, these facts must match across intent, approval, payment, settlement, fulfillment, and receipt:

- Purchase ID and request key
- Merchant, URL, method, body digest, and resource identity
- x402 requirement and request hashes
- network, scheme, profile, payee, and channel epoch
- amount, charge, fee, and total-cost limits
- finality floor, expiry, Payment Identifier, and transaction identity

For a Transfer, these facts must match:

- Transfer ID and request key
- source vault, recipient, amount, and network
- fee and total ceilings, expiry, and finality floor
- policy identity and Operator Manifest identity
- Treasury operation key and transaction ID
- exact output observation

A Transfer is not x402 or an AP2 Payment Mandate. It has no Merchant,
Checkout, x402 profile, or fulfillment facts.

## Effect rules

Every external effect needs durable identity, authorization, expected results, and a recovery fence.
Recovery observes the exact original effect before it takes another action.

| Effect | Recovery rule |
|---|---|
| Vault or staging submission | Observe exact outputs and spenders before retry. |
| Exact payment | Check Merchant evidence, then Chain Evidence. Reuse the same artifact only. |
| Batch voucher | Never sign a sibling cumulative value. |
| Claim or refund | Observe the race before another action. |
| Paid Merchant request | Reuse only the exact durable request. |
| Fulfillment | Recover content without another payment. |
| Direct Transfer | Observe the original transaction and exact outputs. Never create replacement authority. |

A timeout does not prove that no effect occurred.
Unavailable or contradictory evidence stops recovery.

## Availability

Admission limits apply before authentication, parsing, evidence storage, prompts, chain reads, and signing.
Agent work has bounded connections, concurrency, deadlines, bytes, and result sizes.

Operator recovery has separate credentials, sockets, pools, and budgets.
Agent saturation cannot consume its capacity.

## Residual risks

- AP2-derived authorization is not AP2 interoperability.
- Kaspa-x402 and SilverScript are experimental dependencies.
- Node or witness failure can pause recovery.
- Telegram account security remains part of the trust boundary.
- Wallet activity is not a complete chain index.
- This release is testnet-only and operator-controlled.

See the [funded evidence](https://github.com/elldeeone/sompi/blob/c8fd02fa403b7e4f43dfa91653c0c232867d8ed8/evidence/alpha9-clean-cutover/README.md) and [mainnet boundary](../mainnet-readiness.md).
