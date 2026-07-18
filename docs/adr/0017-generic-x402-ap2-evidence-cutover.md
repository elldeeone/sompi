# ADR-0017: Generic x402 with internal AP2-derived authorization evidence

- Status: Accepted
- Date: 2026-07-18
- Amends: ADR-0003, ADR-0007, ADR-0009, ADR-0010, and ADR-0015

## Context

The completed alpha.8 vertical requires every Merchant to implement three
Sompi-specific AP2 HTTP artifacts in addition to ordinary x402:

- `SOMPI-CHECKOUT` during payment discovery;
- `SOMPI-CHECKOUT-RECEIPT` after payment;
- `SOMPI-PAYMENT-RECEIPT` after payment.

It also presents the closed mandates to Sompi-specific Merchant endpoints before
Treasury execution. That proves one bilateral fixture but makes a generic
Kaspa-x402 Merchant unusable even though AP2 and x402 are meant to vary at
separate seams.

The official AP2/x402 integration is still evolving. Sompi must retain the
human-present authorization, limits, evidence, and recovery benefits already
implemented without inventing a proprietary Merchant protocol or making the
current experimental AP2 mapping canonical Purchase state.

Sompi remains in development. There are no external users or production data
requiring compatibility with the bilateral fixture.

## Decision

### Generic Merchant path

An ordinary verified Kaspa-x402 `PAYMENT-REQUIRED` response is sufficient to
enter the Purchase lifecycle. Sompi derives canonical Checkout Terms from:

- the operator-allowed HTTPS Merchant origin;
- the exact resource URL, method, media type, body, and request fingerprint;
- the verified x402 amount, asset, network, payee, expiry, selected mechanism,
  profile, settlement requirement, and requirements digest.

The configured origin is the Merchant identity for this profile. The payee is a
separate exact authorized fact. Sompi does not claim that an unsigned x402 offer
cryptographically proves a legal or organizational Merchant identity.

Generic Merchants do not receive AP2 mandates and do not return Sompi-specific
AP2 headers or receipts.

### Purchase Authorization

Sompi's signed `PurchaseAuthorization` remains canonical. It binds the exact
Purchase, Merchant origin, payee, resource/request, x402 requirements digest,
amount or batch ceiling, actual charge where known, asset, network, expiry,
selected profile or channel epoch, fee ceiling, and effective Finality Floor.

The Trusted Authority remains deterministic, non-agentic, and isolated from the
Agent and MCP processes. Treasury and Kaspa-x402 may execute only the exact
durably authorized facts.

### AP2 evidence

For the generic path, the AP2 adapter is an internal evidence adapter over the
verified Purchase Authorization. Its experimental native-KAS artifacts are
recorded as AP2-derived Evidence Attachments and are never presented as
Merchant-issued, Merchant-verified, or strictly interoperable AP2 artifacts.

The adapter must not fabricate a Merchant Checkout Mandate or Merchant Receipt.
The signed Sompi Authority decision is sufficient authorization evidence for
the generic path.

When an official AP2-compatible x402 profile is available, Sompi implements it
as a deliberate replacement adapter at the existing AP2 and x402 seams. That
profile may exchange official mandates and receipts with an AP2-aware Merchant.
It must project into the unchanged Purchase model and pass the same
authorization, Treasury, settlement, fulfilment, and recovery invariants.

Temporary dual-profile conformance is allowed during that upgrade. Permanent
dual runtime compatibility is not.

### Fulfilment and Receipt

Generic Fulfilment is verified from the exact authorized request, the bounded
successful paid response, verified x402 Settlement, and any resource digest
that was committed before payment. Sompi creates one canonical Receipt linking
Checkout Terms, Purchase Authorization, Payment Attempt, Settlement,
Fulfilment, and evidence digests.

Official AP2 Receipts are optional Evidence Attachments supplied only by a
future explicitly supported AP2-aware profile. They do not define terminal
Purchase state.

### Clean cutover

The implementation starts the next Journal epoch and removes the bilateral
fixture from the active runtime:

- proprietary AP2 Merchant headers and verifier requirements;
- mandatory mandate-presentation HTTP effects and their recovery state;
- demo Merchant authorization stores and endpoints;
- Merchant AP2 receipt issuer configuration;
- Journal tables and invariants that require exactly two AP2 Merchant receipts;
- obsolete fixtures, commands, examples, tests, and current documentation.

Kaspa-x402 remains unchanged. Standard-native, additive, and batch all use the
same Purchase Authorization contract. Every batch voucher increase continues
to require its own exact human-present authorization.

## Consequences

- Any compliant supported Kaspa-x402 Merchant can be used without Sompi-specific
  integration.
- The human approval, policy, Treasury, replay, finality, and recovery model is
  preserved.
- AP2 claims remain honest: the generic path is AP2-derived local authorization,
  not end-to-end AP2 interoperability.
- Official AP2/x402 support can replace the evidence and wire adapters without
  changing Purchase, Treasury, Journal, Authority, Telegram, or agent
  interfaces.
- The old bilateral proof remains historical evidence only.

## Rejected alternatives

- Keep the proprietary headers as optional runtime compatibility: rejected
  because there are no users and it preserves two Merchant contracts.
- Put AP2 mandates into Kaspa-x402: rejected because authorization and payment
  execution have different ownership.
- Treat x402 payment requirements as User authorization: rejected because the
  Merchant cannot authorize Treasury spending for the User.
- Remove AP2 tracking entirely: rejected because official AP2/x402 composition
  is an intended future compatibility profile and the internal evidence remains
  useful.
- Add a universal commerce or payment plugin framework: rejected because there
  is still one real payment adapter.
