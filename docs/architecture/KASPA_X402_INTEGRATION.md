# Kaspa-x402 integration

## Pin

Sompi supports Kaspa-x402 `0.1.0-alpha.9` on `kaspa:testnet-10`.

Packages are pinned exactly:

- `@kaspa-x402/core`
- `@kaspa-x402/covenant`
- `@kaspa-x402/client`
- `@kaspa-x402/server`

The package tarballs, source commit, exact HTTP vector, and full-consensus
profile vectors are checked by `npm run test:conformance`.

## Boundary

Kaspa-x402 is the payment execution adapter. Sompi owns authorization, policy,
Treasury, Purchase state, fulfilment, receipt, and recovery.

A Merchant implements the supported x402 contract. It does not need Sompi or
AP2 integration.

## Common flow

1. Make the canonical bounded HTTP request.
2. Accept one `402` with one supported `PAYMENT-REQUIRED` offer.
3. Verify network, scheme, profile, payee, request binding, amount/ceiling,
   finality, expiry, and transaction encoding.
4. Persist the exact offer as evidence and derive canonical Checkout Terms.
5. Obtain signed human authorization and reserve policy capacity.
6. Persist prepared funding/payment material and the effect fence.
7. Send one immutable `PAYMENT-SIGNATURE` retry.
8. Verify `PAYMENT-RESPONSE`, settlement, authoritative chain evidence, and
   bounded resource content.
9. Record fulfilment and one receipt.

Paid redirects are forbidden. Automatic corrective re-signing is forbidden.
A changed offer requires a new Purchase decision.

## Exact: standard-native

Binding: `kaspa-exact-v2`, profile `standard-native`.

The payer constructs a version-0 transaction with an exact Merchant output and
optional change. Sompi verifies:

- canonical safe JSON and txid;
- trusted input UTXOs;
- Schnorr signatures;
- Merchant output equals the advertised amount;
- no unexpected Merchant benefit;
- value conservation, mass, fee, and configured fee cap;
- native subnetwork, gas/payload, and supported transaction fields;
- payer-signed request authorization;
- accepted/confirmed settlement under the effective finality floor.

For the current proof shape:

```text
Merchant gain = advertised amount
Payer cost = advertised amount + explicit fee
```

## Exact: additive

Binding: `kaspa-exact-v2`, profile `additive`.

The KIP-10-based head is a reusable Merchant UTXO chain:

```text
input[0]  = current head
input[1+] = payer funding
output[0] = same-script successor at old amount + advertised amount
```

Rules:

- successor and head use the same index and script;
- the successor delta equals the advertised amount exactly;
- there is no separate Merchant payment output;
- the payment amount is at least the script threshold;
- unpaid offers do not claim, reserve, or retire heads;
- one signed conflicting transaction claims a head by compare-and-swap;
- a loser obtains a fresh offer and separate authorization;
- unknown external advancement requires proven lineage or the head is disabled;
- public selection/reconciliation work is bounded.

KIP-10 supplies introspection primitives; this additive payment profile is a
Kaspa-x402 construction, not a claim that KIP-10 standardizes the wire scheme.

## Batch settlement

Binding: `kaspa-escrow-v1`, scheme `batch-settlement`.

Channel funding is a separate operator-capital operation. Each Purchase then:

1. selects a route-bound active channel;
2. obtains authorization for a maximum charge and exact channel epoch;
3. signs one monotonic cumulative voucher;
4. records the accepted actual charge separately;
5. records fulfilment and one receipt for that Purchase.

The Merchant claim must preserve exact continuation accounting. Fees come from
the Merchant payout or another Merchant input, never by silently reducing the
client continuation. The refund branch is valid only after the chain DAA is
strictly greater than the absolute timeout.

## Treasury and staging

The payment adapter never receives unrestricted vault authority. Treasury
reserves the amount plus bounded staging/payment fees and creates one
attempt-bound capability.

Prepared staging and payment bytes or secure key references are durable before
submission. A possible broadcast consumes the capability until authoritative
observation resolves it.

## Recovery

Recovery order:

1. Check durable Merchant/payment evidence.
2. Check authoritative chain evidence for the exact expected output/spend.
3. Reuse the same immutable paid request only when the protocol state proves it
   safe.
4. Never create a replacement signed payment to escape ambiguity.

An accepted payment can recover fulfilment without paying again. Contradictory
evidence, unavailable history, unknown head lineage, or a finality downgrade
fails closed for operator review.

## Current evidence

Fresh standard-native, additive, and batch TN10 summaries are in
[`../../evidence/generic-x402-cutover/`](../../evidence/generic-x402-cutover/README.md).

The evidence proves these exact transaction shapes and lifecycle paths. It does
not claim universal wallet compatibility, universal fees, mainnet readiness, or
general Kaspa payment support.
