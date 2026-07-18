# AP2-derived authorization profile

## Claim boundary

Sompi does not implement or claim general AP2 interoperability.

The exact AP2 v0.2.0 source and schema revision is pinned as an upstream
provenance watch. Sompi's current runtime uses a smaller internal,
human-present authorization artifact inspired by AP2's mandate model.

Profile: `urn:sompi:ap2-derived-human-present:1`

- Mode: human-present.
- Signature: ES256.
- Issuer: the operator-configured Trusted Authority.
- Audience: Sompi's exact Purchase decision.
- Merchant transport: none.
- Interoperability: none.

## Why it is internal

The Merchant wire contract is x402 only. Sompi derives the decision from
verified x402 `PAYMENT-REQUIRED` evidence
and signs it locally. It does not fabricate Merchant AP2 artifacts or send its
Authority evidence to the Merchant.

Official AP2/x402 interoperability can later replace this adapter without
changing Purchase, Journal, Treasury, fulfilment, API, Telegram, or agent
interfaces.

## Signed facts

An approved decision binds:

- profile and decision type;
- Authority issuer and key ID;
- Purchase ID and caller request key;
- Merchant identity and origin;
- canonical request URL, method, and body digest;
- resource identity and request fingerprint;
- x402 requirements digest, network, scheme, payee, and execution profile;
- exact amount or batch maximum charge;
- channel ID/epoch and cumulative charge facts for batch;
- fee and total-cost ceilings;
- effective finality floor;
- instrument identity;
- issued-at and expiry.

A denial signs the same decision facts with `denied`. It creates no payment
authority.

## Verification

Sompi accepts only:

- the exact profile and ES256 algorithm;
- one configured issuer/key;
- canonical bytes and exact field set;
- a current, unexpired decision;
- exact equality with the Journal's Merchant/request/payment facts;
- a fresh, replay-safe Authority exchange;
- an approved result before Treasury reservation or signing.

Unknown fields, profile drift, issuer/key substitution, algorithm downgrade,
expired evidence, cross-Purchase reuse, or fact substitution fail closed.

## Isolation

The Authority runs outside the agent/API/MCP process and owns:

- its signing key;
- decision and replay stores;
- terminal input or Telegram bot token;
- callback validation and one-time prompt state.

The agent can request a Purchase and observe its result. It cannot approve,
deny, alter the displayed facts, read Authority material, or consume operator
recovery authority.

## Telegram

Telegram is only a human-interface projection. A callback is accepted only for
the configured bot, user, chat, prompt ID, decision, and expiry. The Hermes
plugin relays bounded callback data over a local Unix socket and has no signing
or wallet capability.

## Upstream watch

Conformance checks lock:

- AP2 release `v0.2.0`;
- commit `b4587ac1d055888a73b4b21750973cffba961793`;
- vendored schema bytes and licence.

These checks detect upstream drift. They do not turn the internal artifact into
an AP2-conformant Merchant protocol.
