# Spent Merchant Outputs Become Invisible to Exact-Payment Recovery

## Executive Summary

Sompi revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
(package version 0.8.0) can lose the evidence needed to settle an exact
Kaspa-x402 Purchase after the Merchant spends the output it received. The
exact-payment observer looks for the output in the current UTXO index and then
for its parent transaction in the current mempool. Once the transaction has
been accepted, has left the mempool, and its Merchant output has been spent,
both current views are empty even though the payment happened.

This matters when the original paid HTTP response was lost or a process crash
occurred before Sompi durably recorded Settlement. A malicious Merchant can
make that ambiguity deterministic by withholding the response and promptly
spending its output. Recovery then remains `pending`, so Sompi cannot close the
Settlement, obtain Fulfilment and Receipts through the paid-request replay, or
resolve the associated accounting state.

I reviewed the affected revision directly and reproduced the double-miss
behavior against its independently built JavaScript output. The included PoC
uses the production `RpcChainObservationSource` and a local fake RPC; it does
not broadcast, mine, or spend a live testnet transaction. I did not identify or
test a fixed revision.

The issue is low severity (P3). Recovery fails closed: it does not invent a
Settlement, alter the approved payment, or send a second payment. The Merchant
has already received an authorized, policy-bounded testnet payment, and each
ambiguous Purchase must meet the preconditions independently.

## Background

Sompi's Purchase module separates durable Purchase state from its Kaspa-x402
wire adapter. For an exact payment, Sompi prepares and binds one transaction to
the approved payee, amount, request, reservation, and payment identifier. A
paid Merchant response can complete Settlement immediately. If execution
becomes ambiguous, recovery must determine whether that exact transaction was
observed before it can safely replay the immutable paid request.

The production runtime constructs one chain verifier backed by the wallet's
Kaspa RPC connection. It uses a deliberately absent Merchant-status adapter
unless a caller provides a durable Merchant response store:

```ts
// src/runtime/purchase-runtime.ts:188-199
const chainVerifier = new KaspaExactChainVerifier({
  stagingMetadata: new JournalChainTreasuryMetadataSource(
    canonicalStaging,
    observedStaging,
    now
  ),
  chain: new RpcChainObservationSource({ rpc: wallet, now }),
  merchantResponses:
    dependencies.merchantResponses ?? new AbsentMerchantPaymentResponseLookup(),
  addressCodec: new KaspaTestnet10AddressCodec(),
  now,
});
```

That default is reasonable because the pinned public Merchant profile has no
generic status endpoint. It also makes chain observation the generic recovery
source when the original response is unavailable.

The normal invariant is subtle: an exact transaction's identifier remains a
historical fact after acceptance, but the UTXO created by that transaction is
only a current-state fact. Spending the output removes it from the UTXO set.
Similarly, acceptance removes the parent from the mempool. Therefore, absence
from both indexes cannot prove that the transaction was never accepted.

## Vulnerability Details

Recovery first asks the Merchant response source for already-committed
evidence. On a miss, it asks the chain source for the exact output. An observed
result becomes `transaction_observed`; every non-observed result becomes
`pending`:

```ts
// src/adapters/kaspa-x402/chain-verifier.ts:433-475
const paymentResponse = await boundedCall(
  "Merchant payment-response lookup",
  deadlineAtMs,
  this.now,
  input.signal,
  (signal) => this.merchantResponses.findByPaymentIdentifier({
    purchaseId: parsed.context.execution.purchaseId,
    paymentIdentifier: parsed.paymentIdentifier,
    transactionId: parsed.transactionId,
    deadlineAtMs,
    signal,
  })
);
if (paymentResponse !== undefined) {
  return {
    status: "payment_response",
    paymentResponseHeader: snapshotPaymentResponseHeader(paymentResponse),
  };
}

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
return { status: "pending", detailDigest: chainObservation.detailDigest /* ... */ };
```

We then reach the RPC observer. Its first query is an address-wide current UTXO
lookup, narrowed to the immutable transaction ID and output index. When the
Merchant output is still unspent, the observer also verifies its amount,
script, and DAA-derived finality. Those checks are strong, but their evidence
vanishes as soon as the Merchant spends the output.

```ts
// src/adapters/kaspa-x402/chain-verifier.ts:591-603
const utxos = await raceSignal(
  rpc.getUtxosByAddresses([request.merchantAddress]),
  request.signal
);
const matches = (utxos.entries as unknown[]).filter((entry) => {
  const outpoint = rpcOutpoint(entry);
  return outpoint?.transactionId === request.transactionId &&
    outpoint.index === request.outputIndex;
});
if (matches.length > 1) {
  throw error("source_failure", "Kaspa RPC returned a duplicate exact output outpoint");
}
if (matches.length === 1) {
  // Validate the live output and return status: "observed".
}
```

After a UTXO miss, the only fallback is the current mempool. A normal
not-found response is immediately converted to `pending`:

```ts
// src/adapters/kaspa-x402/chain-verifier.ts:645-668
try {
  mempool = await raceSignal(
    rpc.getMempoolEntry({
      transactionId: request.transactionId,
      includeOrphanPool: false,
      filterTransactionPool: false,
    }),
    request.signal
  );
} catch (cause) {
  if (request.signal.aborted) throw abortError(request.signal);
  if (isMempoolNotFound(cause)) {
    return Object.freeze({
      status: "pending" as const,
      detailDigest: digestCanonical({
        source: "kaspa-wrpc",
        status: "not-in-utxo-index-or-mempool",
        transactionId: request.transactionId,
        outpoint: request.outpoint,
      }),
    });
  }
  throw error("source_failure", "Kaspa mempool observation failed", { cause });
}
```

At this point we have carried an accepted transaction into a state where its
output has been spent and its parent has left the pool. The observer has no
accepted-history request, persisted start hash, block lookup, or inclusion
proof, so the result is indistinguishable from a never-broadcast transaction.

| Transaction state | Current Merchant UTXO | Current mempool | Observer result |
|---|---:|---:|---|
| Submitted, not accepted | no | yes | `observed` |
| Accepted, output unspent | yes | no | `observed` |
| Accepted, output spent | no | no | `pending` |
| Never submitted | no | no | `pending` |

The last two rows are security-significant opposites but collapse to the same
result. The next adapter layer only replays the immutable paid request when it
receives `transaction_observed`:

```ts
// src/adapters/kaspa-x402/exact-payment-module.ts:494-523
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
  // Require and verify the PAYMENT-RESPONSE, then return settled.
}
validatePassiveRecoveryObservation(probe);
return structuredClone(probe);
```

Consequently, reconciliation retains the payment Effect as ambiguous and can
move the Purchase to `failed_recoverable`; no observed spend is recorded. This
is an evidence and accounting-closure failure, not a false attribution. The
immutable transaction bindings remain intact throughout.

The repository's direct-wallet recovery demonstrates the missing control. Its
`KaspaWallet.observePreparedSend` performs the same UTXO and mempool checks,
then calls `getVirtualChainFromBlock` with
`includeAcceptedTransactionIds: true` from a stored observation start hash.
The regression test at `src/wallet-preparation.test.ts:95-100` explicitly
spends the recipient output and still obtains `observed`. Exact-payment
recovery has no equivalent branch.

## Exploitability Analysis

The strongest adversarial route is a configured malicious Merchant. We begin
with a normal, human-authorized exact Purchase; the Merchant cannot choose a
different amount, payee, or payment identity. The Merchant accepts or
broadcasts the signed transaction but drops the paid HTTP response. After the
transaction is accepted, it spends the output before Sompi's recovery worker
observes it. If no durable Merchant store response is available, the two
current-index queries miss and recovery remains pending.

This route is reliable once the timing preconditions are established because
the blind spot is not a short race window after the spend. A spent outpoint
does not return to the current UTXO set, and an accepted parent does not return
to the ordinary mempool. Repeating recovery against the same views therefore
repeats `pending`. The Merchant can control response withholding and its own
spend timing, although it cannot directly invoke Sompi's local reconciliation
code.

An ordinary failure route reaches the same state without malicious behavior.
A legitimate Merchant may return a valid paid response, but a connection loss
or process crash can prevent Sompi from durably consuming it. Automated
sweeping can then spend the Merchant output before recovery. This variant is
less attacker-directed but shows why current-state queries are insufficient
for crash recovery even when counterparties are honest.

Several constraints keep the impact bounded:

- A real, separately approved payment must already exist. The primitive cannot
  create an unauthorized transaction or redirect funds.
- `pending` is fail-closed. It does not trigger a second payment or fabricate
  Settlement evidence.
- A configured, honest Merchant idempotency store is queried first and can
  return the original `PAYMENT-RESPONSE` without consulting the chain.
- Each attempt is bounded by Sompi's authorization and Treasury policy. The
  issue does not expose keys or allow arbitrary Purchases to be affected.
- The affected runtime is explicitly restricted to Kaspa testnet-10. No
  mainnet impact is established.

The practical security effect is denial of durable lifecycle and accounting
closure for an already-paid Purchase. Settlement, Fulfilment, and Receipt
recovery can be obstructed, and unresolved in-flight state can consume
operator attention and policy or reservation capacity. It would be inaccurate
to describe this as theft: the Merchant receives only the authorized payment,
while Sompi refuses to make an unsupported success claim.

## Proof of Concept

The `poc/reproduce.mjs` program imports the production
`RpcChainObservationSource` and address codec from a built checkout of the
affected revision. Its fake RPC models the state after acceptance and spend:

- the exact transaction is present in a fixture accepted-history set;
- the Merchant's current UTXO list is empty;
- the current mempool lookup returns a normal not-found error; and
- a history method is available, allowing us to count whether the observer
  tries to use it.

The PoC verifies the compiled `chain-verifier.js` hash for the reviewed
revision, calls the production observation method, and asserts both that the
result is `pending` and that accepted history was never queried. It performs
no network access, transaction submission, or state mutation.

Arrange a disposable affected checkout and this report directory as siblings,
build Sompi, and run from the report directory:

```sh
cd poc
make run SOMPI_ROOT=../../sompi
```

Representative output from the reviewed revision is:

```text
target_module_sha256=fdcc120c4424b38f87dfac8f1ff90bb7138fc686e5315f7c488ca63a292627f7
current_utxo_entries=0
current_mempool_contains_transaction=false
accepted_history_contains_transaction=true
accepted_history_queries=0
observer_status=pending
result=VULNERABLE
```

The result proves the precise primitive: the production observer cannot
distinguish a historically accepted and now-spent payment from one absent from
both current indexes. A corrected implementation should query a durable
history source and return an observed status for the fixture transaction. The
PoC does not claim that a live Merchant response, block archival policy, or
operational timeout was exercised.

## Remediation

The invariant to restore is: **absence from current UTXO and mempool views must
never be treated as the complete observation result for an ambiguously
submitted payment**. Before the irreversible send, Sompi should durably record
a chain observation start anchor in the Purchase Effect or prepared payment
context. After the two cheap current-view checks miss, exact recovery should
query accepted history from that anchor by the immutable transaction ID.

The direct-wallet implementation already provides an appropriate local model.
A minimal exact-observer branch would look like the following, with the start
hash carried in the durable `ChainObservationRequest`:

```ts
// After the current UTXO and mempool checks miss.
if (request.observationStartHash !== undefined) {
  const history = await raceSignal(
    rpc.getVirtualChainFromBlock({
      startHash: request.observationStartHash,
      includeAcceptedTransactionIds: true,
    }),
    request.signal
  );
  const accepted = history.acceptedTransactionIds.some((block) =>
    block.acceptedTransactionIds.some(
      (transactionId) => String(transactionId) === request.transactionId
    )
  );
  if (accepted) {
    return Object.freeze({
      status: "observed" as const,
      network: request.network,
      transactionId: request.transactionId,
      outpoint: request.outpoint,
      amountAtomic: request.expectedAmountAtomic,
      scriptPublicKey: request.expectedScriptPublicKey,
      finality: "accepted" as const,
      observedAtMs: readClock(this.now),
      detailDigest: digestCanonical({
        source: "kaspa-wrpc-accepted-history",
        transactionId: request.transactionId,
        outpoint: request.outpoint,
        observationStartHash: request.observationStartHash,
      }),
    });
  }
}
```

This shape is safe only because the existing preparation path recomputes and
binds the transaction ID to immutable transaction bytes, including the exact
Merchant output. If that invariant changes, recovery must fetch and validate
the accepted transaction itself rather than filling output fields from the
request. A `confirmed` requirement also needs the accepting block's DAA data or
an equivalent confirmation proof; an accepted-history hit must not silently
upgrade finality.

If the start hash has been pruned or history is unavailable, recovery should
remain fail-closed and raise a durable operational signal. Sompi should retain
the current response-first lookup, exact live-output checks, idempotent retry,
and no-repayment behavior. For stronger evidence, it can persist a verified
inclusion certificate when first observed and validate historical results
through an independently trusted source.

Regression tests should cover the full lifecycle rather than only a synthetic
double miss:

1. Persist an observation anchor before marking payment submission ambiguous.
2. Accept the exact parent transaction, remove it from the mempool, and spend
   the Merchant output.
3. Return the parent ID from accepted history and require
   `transaction_observed` followed by the immutable paid-request replay.
4. Verify that a different historical transaction ID, a pruned start hash, or
   unavailable history remains `pending` and never causes repayment.
5. Preserve the existing wrong-amount, wrong-script, orphan, network, and
   finality negative tests.

## Summary

Sompi's exact-payment recovery correctly validates evidence that remains in
the current UTXO set or mempool, but those indexes do not retain historical
acceptance. After a Merchant spends a legitimately received output, a lost
response or crash can leave an already-paid Purchase permanently
indistinguishable from a never-observed one.

We reproduced that collapse through the production observer and confirmed
that it never asks the available history source. The existing fail-closed and
immutable-binding controls prevent false attribution, duplicate payment, and
theft, which bounds this to a low-severity recovery and accounting denial.
Persisting a pre-submission observation anchor and consulting accepted history
after current-view misses restores the missing invariant while preserving
Sompi's conservative recovery posture.
