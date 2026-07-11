# Supported AP2 profile

Status: Phase 1 pinned profile

Profile ID: `ap2-v0.2-hp-direct-sd-jwt-es256`

## Upstream provenance

- Repository: `https://github.com/google-agentic-commerce/AP2`
- Release: `v0.2.0`
- Commit: `b4587ac1d055888a73b4b21750973cffba961793`
- Mode: Human Present / Direct
- Checkout Mandate VCT: `mandate.checkout.1`
- Payment Mandate VCT: `mandate.payment.1`
- Mandate format: root SD-JWT, SHA-256 disclosures, ES256 issuer signature
- Receipt format: compact ES256 JWS/JWT

The Git commit, not the Python package's internal version string, is normative
for Sompi. No official AP2 TypeScript package exists at this release.

## Direct flow

The first implementation uses two independent User/authority-signed closed
mandates. It does not use open mandates, delegation chains, `cnf`, KB-SD-JWT,
agent signing, autonomous constraints, or verifier nonce flow.

```text
Merchant Checkout JWT
       │ exact UTF-8 SHA-256
       ▼
checkout_hash
  ├── Checkout Mandate root SD-JWT
  └── Payment Mandate root SD-JWT
```

The Trusted Authority receives both closed mandate contents, renders their
canonical Purchase facts, obtains User consent, and creates the signed
artifacts. Sompi independently verifies those artifacts before marking the
Purchase authorized.

## Merchant Checkout JWT

AP2 intentionally leaves Checkout content to the commerce protocol. Because
UCP is deferred, the demo Merchant uses the local profile
`urn:sompi:checkout:single-resource:1` with:

- `iss`, `aud`, `kid`, `jti`, `iat`, and `exp`;
- random 256-bit checkout nonce;
- Purchase ID;
- Merchant ID, name, website/origin;
- resource URL, method, and request fingerprint;
- exact atomic amount as a decimal string;
- asset `KAS`, network `kaspa:testnet-10`, and exact `payTo`;
- x402 version, scheme, binding, and Payment Requirements digest;
- expected fulfilment identity/digest when knowable;
- explicit treasury fee ceiling or a statement that fees are separately
  reserved and not Merchant revenue.

It is a compact ES256 JWS signed by the configured Merchant key. Hash the exact
compact ASCII/UTF-8 bytes received. Never decode/re-encode before computing
`checkout_hash`.

## Closed Checkout Mandate

Required disclosed content:

```json
{
  "vct": "mandate.checkout.1",
  "checkout_jwt": "<exact merchant compact JWS>",
  "checkout_hash": "<base64url SHA-256 of checkout_jwt bytes>",
  "iat": 0,
  "exp": 0
}
```

Sompi requires `iat` and `exp` even though the upstream schema makes them
optional. Maximum TTL for the initial profile is five minutes.

## Closed Payment Mandate

Required disclosed content:

```json
{
  "vct": "mandate.payment.1",
  "transaction_id": "<same checkout_hash>",
  "payee": {
    "id": "<merchant-id>",
    "name": "<merchant-name>",
    "website": "https://merchant.example"
  },
  "payment_amount": {
    "amount": 20000000,
    "currency": "KAS"
  },
  "payment_instrument": {
    "id": "<authority-visible instrument instance>",
    "type": "urn:sompi:ap2:payment-instrument:kaspa-x402:1",
    "description": "Native KAS via Kaspa-x402 exact",
    "network": "kaspa:testnet-10",
    "asset": "KAS",
    "atomicUnit": "sompi",
    "decimals": 8,
    "scheme": "exact"
  },
  "iat": 0,
  "exp": 0
}
```

`transaction_id` is the Checkout JWT hash. It is not Purchase ID, x402 payment
identifier, or Kaspa transaction ID. Those remain separate correlated facts.

The KAS amount profile is the explicitly experimental profile in ADR-0010.
Sompi accepts it on testnet only, requires a JSON-safe integer, and compares it
back to the canonical decimal-string amount without rounding.

## SD-JWT requirements

- root SD-JWT compact serialization only;
- protected `alg` exactly `ES256` and exact trusted `kid`;
- P-256 public key from a configured local trust entry;
- `_sd_alg` exactly `sha-256`;
- exactly one fully presented `delegate_payload` object;
- no `~~` delegation segment, KB-JWT, `cnf`, open constraint, or unexpected
  mandate field;
- `checkout_jwt` disclosed in the Checkout Mandate presentation;
- random salts with sufficient entropy for every disclosure;
- no `jku`, `x5u`, or token-controlled remote key resolution;
- unknown VCT, algorithm, key, field, or profile fails closed.

After cryptographic verification, Sompi validates the disclosed content against
the pinned schema and then independently compares every canonical Purchase
fact. A valid signature is necessary but insufficient.

## Receipts

Checkout and Payment Receipts are compact ES256 JWS/JWT artifacts, not SD-JWTs.
Merchant and payment-processing roles use distinct issuer identities and keys,
even when the demo Merchant hosts both roles.

Checkout success requires `status`, `iss`, `iat`, `reference`, and `order_id`.
Payment success additionally requires `payment_id`, `psp_confirmation_id`, and
`network_confirmation_id`. Error receipts use exact status `Error` plus `error`
and `error_description`; Payment errors still include `payment_id`.

The pinned reference implementation computes a Receipt `reference` as:

```text
base64url(SHA-256(UTF8(closed mandate issuer-JWT segment)))
```

For a direct SD-JWT, use the substring before the first `~`. Store the exact
compact mandate bytes so the reference remains reproducible.

## Schema provenance

Phase 5 vendors the following unmodified Apache-2.0 schemas from the pinned
commit and records these SHA-256 digests:

| Schema | SHA-256 |
|---|---|
| `checkout_mandate.json` | `10c0341edfeaa9084d3704ef8e94869de20499c8e357068d65f8d622bf79483a` |
| `payment_mandate.json` | `94c4af64ed29825cb956705ae763d42f3c04d22feb60b8d838dae2bb1eea1fb1` |
| `checkout_receipt.json` | `941198a1fc1916d04813a8b8ccba4b407471305a6eb1b5338b1f67b6299764ea` |
| `payment_receipt.json` | `e7d52266c407d32bcc49959f91e8ddb73024a1803bef75b7bd368fb93849ba88` |
| `types/amount.json` | `15271efa8064539b8ded7c69f213ed7a1e64f8d9634b405ce926c2dcbbc41c0f` |
| `types/merchant.json` | `13457334d8577230a1cce5265971cfc02f68f5d4e97f74bd2e78128105d3ab31` |
| `types/payment_instrument.json` | `b3bcea7a7b5bbf2b0aa781135ac3b6907280822aa84797161c2d3d104d0cbe8c` |
| `types/pisp.json` | `60a5c8c09236f5d1e84a25bff4fd4cff05fb3fa8e3648cbab483322f27388630` |
| `types/receipt_status.json` | `ad51c1c20be72e286f4ff6fe2819145dcec7e5e3e0f6dc7870fcf748c06c1da0` |

Upstream's `receipt_status.json` declares an ID ending in
`receipt-status.json`, while receipts reference `receipt_status.json`. The
unmodified evidence copy remains intact; the validator registers it under both
URIs.

## TypeScript implementation

Pinned runtime libraries:

- `@sd-jwt/core@0.20.0` for RFC 9901 issuance/presentation/verification;
- `jose@5.10.0` for CommonJS-compatible ES256 JWS/JWK operations;
- `ajv@8.20.0` and `ajv-formats@3.0.1` for pinned schema validation.

The authority owns signing. The Purchase/AP2 adapter holds public trust entries
and performs independent verification. The official Python SDK is used only to
generate and verify cross-language conformance fixtures; it is not a runtime
dependency.

## Required conformance

- Python-issued direct mandates accepted by TypeScript;
- TypeScript-issued direct mandates accepted by pinned Python;
- Checkout/Payment success and error Receipt variants;
- exact hash and reference fixtures;
- fixed authority, Merchant, and payment-role P-256 test keys;
- negative fixtures for VCT/algorithm/key/disclosure/hash/reference/field/time
  substitution;
- no byte-equality expectation for freshly issued artifacts because disclosure
  salts and ES256 signatures are intentionally non-deterministic.

The first release is accurately described as AP2 v0.2 Human Present with an
experimental native-KAS Payment Instrument profile, not general AP2/KAS
interoperability.
