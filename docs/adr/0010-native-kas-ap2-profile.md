# ADR-0010: Isolate an experimental native-KAS AP2 payment instrument profile

- Status: Accepted
- Date: 2026-07-11

## Context

AP2 v0.2's Payment Mandate requires `payment_amount` using ISO-4217 currency
and minor-unit semantics. Native KAS and sompi do not have a standardized AP2
mapping. The schema permits a custom Payment Instrument type and additional
instrument properties, but that does not make `KAS` an ISO-4217 currency.

The first release is testnet-only and must bind the exact KAS amount approved by
the User to the exact x402/Kaspa payment. Omitting the Payment Mandate or
pretending a fiat amount is equivalent would weaken the authorization chain.

## Decision

Implement one explicitly experimental adapter-local profile:

- profile identifier: `urn:sompi:ap2:payment-instrument:kaspa-x402:1`;
- Payment Instrument `type` uses that identifier;
- `payment_amount.currency` is `KAS`;
- `payment_amount.amount` is the exact sompi integer and is accepted only when
  it is within JSON's safe integer range for this testnet profile;
- instrument extension properties carry `network`, `asset`, `atomicUnit`,
  `decimals`, and the x402/Kaspa payment-method identity;
- canonical Purchase state continues to store amount as a decimal string and
  never relies on the JSON number;
- every adapter mapping compares the canonical string and rejects rounding,
  overflow, asset, network, or payee mismatch.

This profile is not embedded in x402/Kaspa-x402 wire objects and is not claimed
as strict native-KAS AP2 interoperability. The supported-profile declaration
sets `nativeKasStrictlyStandardized` to `false`.

If AP2/FIDO standardizes non-ISO digital assets, this adapter is replaced and
the old runtime profile is removed after conformance. Historical evidence keeps
its recorded profile identifier.

## Consequences

- The first end-to-end proof can authorize the same atomic KAS amount it pays.
- The standards gap remains explicit rather than hidden behind a misleading
  compliance claim.
- AP2 churn is contained in one adapter and evidence profile.
- Amounts above `Number.MAX_SAFE_INTEGER` fail closed in this profile even
  though Sompi's canonical model supports larger integer strings.

## Rejected alternatives

- Use an unrelated ISO fiat currency: breaks exact payment authorization.
- Use `XTS` as if it represented KAS: it denotes testing, not the asset paid.
- Omit the Payment Mandate: no AP2 payment authorization evidence.
- Put KAS/AP2 fields into Kaspa-x402: violates protocol ownership.
- Claim `KAS` is ISO-4217: factually incorrect.
