# Kaspa-x402 integration

## Supported profile

Sompi supports Kaspa-x402 `0.1.0-alpha.9` on `kaspa:testnet-10`.
It pins the core, covenant, client, and server packages exactly.

`npm run test:conformance` checks package integrity, source identity, HTTP vectors, and consensus vectors.

Kaspa-x402 owns payment execution.
Sompi owns authorization, policy, Treasury, Purchase state, fulfillment, receipt, and recovery.

## Common flow

1. Send the canonical bounded HTTP request.
2. Verify one supported `PAYMENT-REQUIRED` offer.
3. Store the offer and derive canonical Checkout Terms.
4. Obtain human approval and reserve policy capacity.
5. Store the prepared payment and effect fence.
6. Send one immutable `PAYMENT-SIGNATURE` retry.
7. Verify payment response, settlement, chain evidence, and content.
8. Record fulfillment and one receipt.

Sompi rejects paid redirects.
It does not make a corrective payment automatically.
A changed offer needs a new Purchase decision.

## Standard-native

Binding: `kaspa-exact-v2` with profile `standard-native`.

The payer creates a version-0 transaction with one exact Merchant output.
The transaction can also contain payer change.

Sompi verifies:

- canonical safe JSON and transaction identity
- authoritative input UTXOs and signatures
- the exact Merchant output and no extra Merchant benefit
- value conservation, mass, fee, and configured fee limit
- native subnetwork, gas, payload, and supported transaction fields
- request authorization, settlement, and Chain Evidence

```text
Merchant gain = advertised amount
Payer cost = advertised amount + explicit fee
```

## Additive

Binding: `kaspa-exact-v2` with profile `additive`.

```text
input[0]  = current Merchant head
input[1+] = payer funding
output[0] = same-script successor with the advertised increase
```

The successor increase is the only Merchant payment.
An unpaid offer does not reserve or retire a head.

The head and successor must use the same index and script.
The Merchant amount must meet the KIP-10 additive threshold.
The transaction must not give the Merchant another benefit.

One valid conflicting transaction wins the head.
A losing Purchase needs a new offer and separate approval.
Unknown lineage disables that head until trusted recovery proves its state.

## Batch settlement

Binding: `kaspa-escrow-v1` with scheme `batch-settlement`.

The operator funds a channel before Purchases use it.
Each Purchase authorizes one maximum charge and exact channel epoch.

The voucher contains a monotonic cumulative value.
The Merchant claim must preserve exact continuation accounting.
The claim fee cannot reduce the client continuation.

A refund is valid only when chain DAA is greater than the absolute timeout.

## Treasury boundary

The adapter has no unrestricted vault authority.
Treasury gives it one attempt-bound capability for the reserved amount and bounded fees.

Prepared staging and payment data is durable before submission.
After possible submission, Sompi holds the capability until authoritative observation resolves the effect.

## Recovery

1. Check durable Merchant and payment evidence.
2. Check chain evidence for the exact expected effect.
3. Require authoritative protocol and Chain Evidence for safe reuse.
4. Reuse only the same immutable paid request and payload.
5. Never create a replacement payment to escape ambiguity.

An accepted payment can recover fulfillment without a second payment.
Contradictory or unavailable evidence fails closed for operator review.

## Evidence

See the [alpha.9 clean-cutover evidence](https://github.com/elldeeone/sompi/blob/c8fd02fa403b7e4f43dfa91653c0c232867d8ed8/evidence/alpha9-clean-cutover/README.md).
It covers funded Testnet-10 standard-native and batch lifecycles.

The evidence does not prove mainnet readiness or general wallet compatibility.
