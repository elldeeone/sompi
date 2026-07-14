# Untrusted RPC metadata can spoof mempool transaction identity

## Executive Summary

Sompi 0.8.0 at revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
accepts a Kaspa RPC transaction's `verboseData.transactionId` as its canonical
identity. When an expected Merchant output is absent from the UTXO index, a
selected malicious RPC can return an incomplete transaction body, repeat the
requested transaction ID in that verbose field, and provide the expected
Merchant output. Sompi then reports the transaction as observed in the
mempool even though the supplied body cannot be finalized to establish that
identity.

The immediate consequence is a bounded integrity failure in exact-payment
recovery. A fabricated observation changes recovery from `pending` to
`transaction_observed`, causing Sompi to replay the original immutable paid
request. When a signed requirement explicitly permits mempool finality, the
same primitive can also contribute the chain-observation half of a false
Settlement, but only alongside separately valid, semantically false Merchant
evidence. The bug does not disclose keys, authorize a new payee, modify the
prepared transaction, or create an arbitrary or duplicate spend.

I reviewed the affected revision and its history directly, then reproduced the
positive and negative cases against a clean, independently installed and
compiled copy of that revision. The included local PoC returned
`observed/mempool` for a deliberately non-hydratable body carrying the expected
verbose ID; deleting only `verboseData` made the same body fail with
`Kaspa RPC transaction identity cannot be derived`. I did not connect the PoC
to a live Kaspa node, Merchant, wallet, or public service. No fixed revision is
known. Source history places the vulnerable helper in the exact-payment
cutover commit `52080d1278e8514dbfe453b352d71396d64fee50`, and it remains present
at the assessed revision.

Severity is **low (P3)**: the selected RPC crosses a real recovery boundary,
but immutable signed payment state, output equality, idempotent replay, and
consensus/finality controls substantially bound the result.

## Background

Sompi's Kaspa-x402 adapter performs a read-only chain observation before it
trusts an exact payment during recovery or Settlement. The adapter is given a
durable transaction ID, output index, Merchant address, amount, script, and
minimum finality. Its observation interface deliberately exposes no submission
method:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts
export interface ChainObservationSource {
  observeExactOutput(
    request: Readonly<ChainObservationRequest>
  ): Promise<ChainObservation>;
}

/**
 * Read-only testnet-10 observation adapter backed by Kaspa wRPC. It checks the
 * UTXO index first, then the transaction pool, and never broadcasts.
 */
export class RpcChainObservationSource implements ChainObservationSource {
```

We first ask the selected RPC for server status and the Merchant's current
UTXOs. If the exact outpoint is present, Sompi derives finality from the UTXO's
DAA score. If it is absent, the adapter falls back to
`getMempoolEntry`, keyed by the already-known transaction ID:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts
mempool = await raceSignal(
  rpc.getMempoolEntry({
    transactionId: request.transactionId,
    includeOrphanPool: false,
    filterTransactionPool: false,
  }),
  request.signal
);
if (mempool.mempoolEntry.isOrphan) {
  throw error("chain_mismatch", "exact transaction is only present in the orphan pool");
}
```

That request narrows what the node should return, but it is not a cryptographic
proof. The RPC controls the response body and its verbose metadata. The normal
security invariant is therefore that Sompi must derive the canonical
transaction ID from a complete transaction body and compare it with the
durable expected ID. Verbose metadata can be cross-checked, but cannot replace
that derivation.

The recovery consequence matters because `KaspaExactChainVerifier.observe`
turns any accepted mempool result into a privileged recovery fact:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts
const chainObservation = await this.observeChain(
  parsed,
  "mempool",
  deadlineAtMs,
  input.signal
);
if (chainObservation.status === "observed") {
  validateChainObservation(chainObservation, parsed, "mempool", readClock(this.now));
  this.recordFinality(parsed, chainObservation.finality);
  return { status: "transaction_observed" };
}
```

This is an outbound dependency boundary rather than an unauthenticated inbound
Sompi listener. The attacker must control the configured or resolver-selected
RPC, or its response path, when an ambiguous Purchase reaches the mempool
fallback.

## Vulnerability Details

The vulnerable transition is in `rpcTransactionId`. We reach it after the UTXO
lookup misses and the selected RPC returns a non-orphan mempool entry. The
function gives the verbose field priority over local transaction hydration:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts
function rpcTransactionId(transaction: unknown): string {
  const record = requireRecord(transaction, "Kaspa mempool transaction");
  const verbose = isRecord(record.verboseData) ? record.verboseData : undefined;
  if (typeof verbose?.transactionId === "string") {
    return requireHash(verbose.transactionId.toLowerCase(), "Kaspa mempool transaction ID");
  }
  let hydrated: Transaction | undefined;
  try {
    hydrated = new Transaction(transaction as never);
    return requireHash(String(hydrated.finalize()).toLowerCase(), "Kaspa mempool transaction ID");
  } catch (cause) {
    throw error("source_failure", "Kaspa RPC transaction identity cannot be derived", { cause });
  } finally {
    hydrated?.free();
  }
}
```

`requireHash` checks only that the claimed value has the expected 32-byte hex
shape. If the RPC supplies that string, we never construct `Transaction` and
never call `finalize()`. We can therefore carry forward a transaction object
that is too incomplete to have a locally derivable identity.

The caller next compares the returned value with the same expected ID that the
RPC just received, then selects only one output from the unbound body:

```typescript
// src/adapters/kaspa-x402/chain-verifier.ts
const transaction = mempool.mempoolEntry.transaction;
const observedTransactionId = rpcTransactionId(transaction);
if (observedTransactionId !== request.transactionId) {
  throw error("chain_mismatch", "Kaspa mempool returned a different transaction identity");
}
const output = transaction.outputs[request.outputIndex];
if (!output) {
  throw error("chain_mismatch", "Kaspa mempool transaction has no Merchant output index");
}
const amount = rpcBigInt(output.value, "Kaspa mempool output amount");
const script = rpcScriptPublicKey(output.scriptPublicKey);
return Object.freeze({
  status: "observed" as const,
  transactionId: observedTransactionId,
  amountAtomic: amount.toString(),
  scriptPublicKey: script,
  finality: "mempool" as const,
  // ...
});
```

The later `validateChainObservation` comparison is also circular with respect
to identity: it sees the expected ID copied into the observation, not a hash
derived from the returned body. Amount, script, output index, orphan status,
network, deadline, and finality checks all still apply, but none binds the
selected output to the claimed transaction ID.

A minimal malicious response therefore needs only:

1. `verboseData.transactionId` equal to the ID in the RPC request;
2. `isOrphan: false`;
3. an `outputs[1]` entry with the exact expected amount and Merchant script;
4. any remaining body shape, including one that cannot be finalized.

Once accepted, recovery promotes this to `transaction_observed`. We can then
follow the state into `KaspaX402ExactPaymentModule.observe`, where Sompi sends
the previously prepared payment payload to the Merchant again:

```typescript
// src/adapters/kaspa-x402/exact-payment-module.ts
if (probe.status === "transaction_observed") {
  const signatureHeader = encodePaymentSignatureHeader(
    rehydrated.payment.paymentPayload
  );
  const response = await this.sendPreparedPayment(
    input.context,
    input.egress,
    signatureHeader,
    new AbortController().signal
  );
  // ... validate the Merchant response and Settlement
}
```

That retry is the bad control-flow decision proved by the primitive: Sompi acts
as if the original transaction exists based on an RPC-controlled assertion
that was never tied to a canonical body. Importantly, the code rehydrates the
same durable payment and reuses its stable identifier. The attacker does not
gain a way to substitute a new transaction, payee, amount, or signing request.

## Exploitability Analysis

The strongest reliable route is a recovery-integrity attack. We wait for an
ambiguous exact Purchase whose Merchant output is absent from the current UTXO
view and answer the resulting mempool lookup as the selected RPC. The query
reveals the expected transaction ID. Under Merchant/RPC collusion, the exact
amount and script are already known; without collusion, those facts may still
be available from the payment protocol or transaction context, but the
attacker must obtain them accurately. We echo the requested ID, set the orphan
bit to false, and place the required output at index 1. The vulnerable branch
then succeeds deterministically without requiring a valid full transaction.

This gives the RPC a useful but narrow primitive: it can replace a passive
`pending` result with an active `transaction_observed` result for one exact
Purchase. That causes a Merchant retry of the immutable paid request and can
keep an ambiguous workflow from following its normal absence path. The effect
is repeatable while the malicious node remains selected and the workflow keeps
reaching this observation, although downstream idempotency is intended to
collapse repeated use of the same payment identity.

There is a second, more conditional route. If the verified signed requirement
selects the supported `mempool` finality and a malicious Merchant also returns
a structurally valid but semantically false success response, the spoofed
observation can satisfy the chain-presence half of Settlement verification.
That route needs both Merchant evidence and the weaker finality profile.
Requirements for `accepted` or `confirmed` reject a mempool-only result, so we
should not generalize this into arbitrary false Settlement.

Several dead ends define the boundary clearly:

- a different or malformed verbose ID fails the expected-ID or hash-shape
  check;
- a missing, wrong-index, wrong-amount, or wrong-script Merchant output fails
  the exact-output checks;
- an orphan entry is rejected;
- omitting verbose metadata forces the local hydration/finalization path, so
  the incomplete PoC body is rejected;
- the observer has no broadcast or signing method, and the recovery path uses
  the already prepared, immutable payload;
- accepted or confirmed finality cannot be fabricated by this mempool-only
  primitive; and
- an honest kaspad response normally binds its verbose ID to the body, so node
  control or response-path compromise is a prerequisite.

These barriers rule out key compromise, arbitrary signing, payee substitution,
and a general second-payment primitive. They do not restore the missing
body-to-identity binding at the trust boundary, which is why the bounded
recovery and evidence-integrity impact remains reportable.

## Proof of Concept

The `poc/reproduce.mjs` script instantiates the production
`RpcChainObservationSource` from a built checkout and supplies a fully local
mock RPC. It makes no network connection and exposes no wallet or broadcast
method. The positive case returns a transaction with only two outputs plus the
expected verbose ID. The negative control removes only that verbose field and
repeats the observation against the same incomplete body.

From this report directory, prepare the exact affected revision and run the
PoC with relative paths:

```sh
git clone https://github.com/elldeeone/sompi.git lab/sompi
git -C lab/sompi checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix lab/sompi ci
npm --prefix lab/sompi run build
cd poc
node reproduce.mjs ../lab/sompi
```

Representative output from the affected revision is:

```text
{
  "verboseOnlyAccepted": true,
  "status": "observed",
  "finality": "mempool",
  "sameIncompleteObjectWithoutVerbose": "rejected: Kaspa RPC transaction identity cannot be derived"
}
```

The first result proves that untrusted metadata is sufficient to establish
identity even though the body is incomplete. The negative control proves the
same object cannot satisfy the intended canonicalization path. The script exits
non-zero if either property changes. It does not alter chain state or local
application state. After testing, the optional checkout can be removed from
the report directory with `rm -rf lab`.

## Remediation

Restore one invariant: every mempool observation must contain a complete
transaction whose canonical ID Sompi derives locally. Treat the verbose ID as
optional redundant metadata and reject it if it disagrees with the derived
value. It must never select a shortcut around hydration and finalization.

A minimal source shape is:

```typescript
function rpcTransactionId(transaction: unknown): string {
  const record = requireRecord(transaction, "Kaspa mempool transaction");
  const verbose = isRecord(record.verboseData) ? record.verboseData : undefined;
  const claimed = typeof verbose?.transactionId === "string"
    ? requireHash(verbose.transactionId.toLowerCase(), "Kaspa mempool transaction ID")
    : undefined;

  let hydrated: Transaction | undefined;
  let canonical: string;
  try {
    hydrated = new Transaction(transaction as never);
    canonical = requireHash(
      String(hydrated.finalize()).toLowerCase(),
      "Kaspa mempool transaction ID"
    );
  } catch (cause) {
    throw error("source_failure", "Kaspa RPC transaction identity cannot be derived", { cause });
  } finally {
    hydrated?.free();
  }

  if (claimed !== undefined && claimed !== canonical) {
    throw error("chain_mismatch", "Kaspa mempool metadata disagrees with the transaction body");
  }
  return canonical;
}
```

The production patch should confirm the pinned Kaspa SDK's deserialization and
`finalize()` semantics with complete wRPC transaction fixtures, rather than
accepting a convenient partial representation. Keeping the metadata comparison
outside the hydration `catch` also preserves a deliberate `chain_mismatch`
instead of wrapping it as `source_failure`.

We should add regression tests for all important edges:

1. the PoC's partial body with a correct verbose ID must be rejected;
2. a complete body with a wrong but well-formed verbose ID must be rejected;
3. a complete body whose derived and verbose IDs agree must remain accepted;
4. an absent verbose field with a complete body must use the same canonical
   derivation; and
5. a spoofed recovery observation must leave the Purchase pending and must not
   invoke the Merchant transport.

Canonical derivation fixes this independently actionable bug. As additional
hardening, deployments can require stronger accepted/confirmed finality for
Settlement and obtain chain evidence from independently trusted observations
when a single selected RPC is not an acceptable integrity root. Those controls
complement, rather than replace, local body-to-ID verification.

## Summary

Sompi's mempool fallback validates an RPC-supplied transaction ID for shape and
equality but does not bind it to the transaction body whenever verbose metadata
is present. We reproduced that an incomplete, non-hydratable object becomes an
`observed/mempool` fact solely because it repeats the requested ID, while the
same body without that metadata is rejected.

The practical result is bounded recovery and chain-evidence manipulation by a
selected malicious RPC. Immutable payment preparation, exact output checks,
idempotent replay, and stronger consensus finality prevent the primitive from
becoming key compromise or arbitrary spend. The direct fix is nevertheless
clear: always derive the canonical transaction ID from a complete body, use
verbose metadata only as a consistency check, and test that recovery remains
passive when that binding cannot be established. Future variant review should
apply the same rule anywhere RPC-supplied identity or current mempool state is
promoted into durable Purchase decisions.
