# Kaspa-x402 exact integration profile

Status: Phase 1 integration map

Target: `@kaspa-x402/*@0.1.0-alpha.6`

## Dependency and provenance

Sompi consumes exact published versions, never `@alpha`, `latest`, or sibling
workspace paths:

- `@kaspa-x402/core@0.1.0-alpha.6`;
- `@kaspa-x402/covenant@0.1.0-alpha.6`;
- `@kaspa-x402/client@0.1.0-alpha.6`;
- `@kaspa-x402/server@0.1.0-alpha.6` as a demo/test dependency.

All alpha.6 packages report npm Git commit
`28ac222d3a375b9a2a56c11396f388086eeeae76`. Integrity hashes are recorded in
`src/protocols/profiles.ts` and the npm lockfile.

Kaspa-x402 is ESM-only. Phase 4 migrates Sompi runtime modules to NodeNext ESM
as part of the clean cutover. CommonJS-only retained scripts or vendored Kaspa
WASM loading must use one explicit compatibility loader; mixed loading must not
spread through adapters.

## Client sequencing

Do not use the `paidFetch()` convenience call because Sompi requires durable
checkpoints between payment preparation and the paid HTTP retry.

The Purchase module uses the lower-level sequence:

1. parse/select `PaymentRequired`;
2. compare selected requirements to canonical Checkout Terms;
3. persist requirements evidence and reserve treasury capacity;
4. call `DirectModeClient.createPayment()` with URL, method, body, request hash,
   and payment identifier;
5. persist prepared exact transaction and complete `PaymentPayload`;
6. commit a paid-retry outbox record;
7. send `PAYMENT-SIGNATURE` through controlled egress;
8. persist response and `PAYMENT-RESPONSE` evidence;
9. call `applySettlement()`;
10. independently compare Settlement to canonical Purchase facts.

A corrective 402, timeout, or lost response enters reconciliation. Sompi never
constructs a different payment before determining the first payment's outcome.

## Exact-only adapters

### FundingProvider

Sompi implements the public wallet/funding interface. For exact mode it:

- maps Sompi `testnet-10` to `kaspa:testnet-10` exactly once;
- exposes an attempt-specific public funding identity;
- prepares a KIP-10 exact transaction in `payExactTransaction()` from the
  public reservation terms and public covenant primitives;
- validates every reservation and prepared transaction field independently;
- returns source `vault-treasury`;
- does not broadcast the exact transaction; the Merchant submits it;
- rejects escrow deposit or unsupported scheme calls.

This is the intended FundingProvider responsibility, not a second x402 parser
or settlement implementation. Transaction assembly receives characterized
vectors against the Kaspa-x402 reference proof.

### ChannelSigner and ChannelStore

Exact mode does not use channel signing or channel persistence. Supply
exact-only adapters that return empty reads where the interface requires them
and throw on any batch mutation. Do not create or persist unused channel keys.
Durable channel state belongs to the deferred batch-settlement track.

### AddressCodec

Use vendored Kaspa WASM to validate testnet addresses, derive serialized script
public keys, and encode script addresses. Reject prefix/network mismatch.

## Vault staging

The current consensus vault withdrawal shape cannot directly be the KIP-10
exact transaction: the vault covenant requires one input/two outputs, while the
exact payment combines a Merchant borrow input with a payer input.

Use a journaled two-stage Treasury Movement:

1. reserve the complete gross outflow;
2. create an attempt-specific ephemeral P2PK staging key outside SQLite
   plaintext;
3. persist the planned vault withdrawal and expected staging output;
4. prepare, persist, and submit the vault withdrawal;
5. reconcile and reserve the observed staging outpoint;
6. use only that outpoint for the exact payment;
7. persist the exact transaction before the paid HTTP retry;
8. if abandoned before exact settlement, recover the staging output through a
   separately journaled vault top-up/recovery action.

The treasury reservation covers:

```text
resource amount
+ KIP-10 additive threshold
+ exact transaction fee
+ vault staging transaction fee
```

The last three terms are one explicitly bounded `additionalCost` amount. The
threshold is real payer-funded value moved into a Merchant-controlled KIP-10
continuation output; it is not a network fee. Neither the threshold nor either
transaction fee is Merchant price or AP2 Purchase amount.

## Exact transaction invariants

Before returning from `payExactTransaction()`, validate:

- network, amount, asset, payee, and request hash;
- KIP-10 template and safe-JSON transaction encoding;
- reservation ID and expiry;
- borrow outpoint, amount, serialized script, and redeem script;
- additive threshold and payment output index;
- the exact journal-reserved staging outpoint and amount;
- Merchant payment output value/script;
- borrow continuation output value/script;
- change policy and the complete additional-cost ceiling;
- transaction ID derived from the final signed artifact;
- funding source exactly `vault-treasury`.

## Recovery

- Before vault broadcast: release an unused reservation.
- Ambiguous vault broadcast: query planned txid and expected outputs.
- Staging observed/exact not prepared: resume with the same outpoint.
- Exact prepared/retry not sent: send the same payload only.
- Retry sent/response lost: observe txid, then repeat the same payment
  identifier and payload to obtain the Merchant's idempotent response.
- Settlement observed/fulfilment missing: retry fulfilment with the same
  evidence; never repay.
- Abandoned staging: top up/recover through its recorded key reference.

Kaspa-x402 has no public persisted-result hydrator. Sompi may reconstruct the
client's result wrapper only from separately persisted and revalidated upstream
artifacts; it must not invent alternate wire schemas.

## Demo and live proof

Phase 6 uses a locally controlled demo Merchant and locally provisioned exact
borrow inventory. The public hosted gateway is optional evidence, not a build
dependency. No fallback to batch settlement is permitted when exact inventory
is unavailable.

The final proof checks the Merchant borrow input, attempt staging input,
payment/continuation/change outputs, request hash, payment identifier,
Settlement response, chain observation, idempotent replay, Fulfilment digest,
and all journal recovery points.
