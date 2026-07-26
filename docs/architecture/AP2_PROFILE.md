# AP2-derived authorization profile

## Claim boundary

Sompi does not implement or claim AP2 interoperability.
It uses an internal, human-present authorization artifact that uses the AP2 mandate model.

| Item | Value |
|---|---|
| Authorization profile | `urn:sompi:ap2-derived-human-present:2` |
| Decision evidence profile | `urn:sompi:authority-decision:ap2-derived-human-present:3` |
| Mode | human-present |
| Signature | ES256 |
| Issuer | operator-configured Trusted Authority |
| Audience | one exact Purchase decision |
| Merchant transport | none |

The Merchant wire contract is x402 only.
Sompi derives decision facts from verified x402 evidence and signs them locally.
It does not send Authority evidence to the Merchant.

## Signed facts

An approval binds these fact groups:

- Authority profile, issuer, key, issue time, and expiry
- Purchase identity and request key
- Merchant, request, resource, and x402 requirement identities
- network, scheme, payee, and execution profile
- Merchant settlement assurance, operator floor, effective floor, and DAA depth
- amount, batch charge, fee, and total-cost limits
- instrument and channel facts when they apply

A denial signs the same decision facts with a denied result.
It gives no payment authority.

## Verification

Sompi accepts only the exact profile, algorithm, issuer, key, and canonical field set.
The decision must be current and unexpired.
Every decision fact must equal its durable Journal fact.

Unknown fields, profile drift, key substitution, expired evidence, and cross-Purchase reuse fail closed.
The Authority exchange must be fresh and replay-safe.
An approved result must exist before Treasury reservation or signing.

Direct Transfers use the separate `sompi.transfer.1` decision profile.
They have no Merchant, Checkout, x402, or AP2 Payment Mandate facts.

## Isolation

The Authority owns its signing key, decision store, replay store, and human input surface.
The agent can request work and inspect its result.
It cannot make the decision or read Authority material.

Telegram is a human-interface projection.
The callback must match the configured bot, user, chat, prompt, decision, and expiry.
The Hermes plugin has no signing or wallet capability.

## Upstream watch

Conformance checks pin AP2 release `v0.2.0` and its source and schema bytes.
These checks detect upstream drift.
They do not make Sompi AP2-conformant.
