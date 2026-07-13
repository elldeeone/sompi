# Mempool-Only RPC Evidence Can Permanently Complete a Direct Wallet Send

## Executive Summary

Sompi revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
(package version 0.8.0) can mark a direct wallet send `completed` after a
single selected Kaspa RPC reports the exact transaction as a non-orphan
mempool entry. A mempool entry is provisional: it does not establish accepted
chain inclusion, a minimum DAA depth, or durable consensus finality. The same
RPC response nevertheless crosses Sompi's `observed` boundary and becomes a
terminal SQLite journal fact.

If the entry was fabricated by the selected RPC or the transaction is later
evicted, Sompi continues to report the send as completed. Restart does not
repair the record because recovery returns terminal operations without another
network observation. This can leave the operator and callers with a false
payment-success record and temporarily incorrect rolling-capacity accounting.

The issue is rated **low severity (P3)**. The selected RPC must learn the
transaction ID for an otherwise valid, policy-admissible Testnet-10 send.
Sompi also reconstructs the immutable prepared transaction and binds its
transaction ID, destination outpoint, and amount, so the RPC cannot substitute
an arbitrary transfer or make Sompi sign different bytes through this path.
There is no wallet-key disclosure, mainnet claim, or policy bypass.

I reviewed the affected revision directly and ran the included PoC against a
clean archive build of that revision. The PoC exercised the compiled production
wallet, Treasury adapter, operation module, policy engine, and journal with a
local deterministic RPC replacement; I did not contact a public node or send
real funds. No fixed revision was available at the time of writing.

## Background

Sompi exposes a local MCP tool for direct Testnet-10 wallet movement. The tool
accepts a caller-stable operation key, destination, and exact amount, then
hands the request to the Treasury operation deep module. In
`src/mcp/server.ts:160-182`, we can see that MCP never calls the wallet's
mutation methods directly:

```typescript
const result = await requireTreasuryOperations(treasuryOperations).execute({
  operationKey,
  kind: "wallet_send",
  destination: to,
  amountAtomic: amount.toString(),
});
```

The operation module owns the safety properties around that call. It records
durable intent, reserves policy capacity, prepares one exact signed
transaction, records the planned submission, and reconciles an ambiguous RPC
outcome before any retry. The transaction material includes the exact
transaction ID, source inputs, destination outpoint, amount, and fee. Those
controls are important because they prevent a recovery attempt from building
a different transfer after a crash.

Observation is a separate step. The wallet asks its selected RPC for the exact
destination UTXO, mempool entry, accepted-chain history, and source-input
state. The selected RPC is either an explicitly configured endpoint or one
chosen by the public resolver. `src/wallet.ts:85-125` checks broad node health
and public-node DAA drift, but the connection remains the source of individual
transaction facts. A healthy-looking node can therefore still be wrong or
malicious about one transaction.

For a direct wallet send, the relevant durable states are:

```text
intent -> prepared -> submission_planned -> submitted
                                  |             |
                                  +-- observe --+
                                          |
                              pending / not_submitted / observed
                                                        |
                                                    completed
```

`pending` preserves ambiguity. `not_submitted` returns the operation to its
prepared state so the same signed bytes can be retried. `observed`, however,
is treated as sufficient for the adapter's local commit and the terminal
`completed` transition. The security invariant should therefore be that only
evidence strong enough to justify terminal settlement can produce
`observed`.

## Vulnerability Details

### Exact binding is present, but finality binding is absent

The wallet first validates that the stored transaction still matches the
prepared envelope. It then looks for an exact output at the destination.
`src/wallet.ts:308-334` checks transaction ID, output index, and amount before
returning `observed`. Those equality checks protect transaction identity, but
the response still comes from one RPC and no accepted block or finality depth
is attached to it.

When no matching destination UTXO is returned, execution reaches the decisive
mempool branch at `src/wallet.ts:336-348`:

```typescript
const mempool = await rpc.getMempoolEntry({
  transactionId: prepared.transactionId,
  includeOrphanPool: false,
  filterTransactionPool: false,
});
if (mempool.mempoolEntry.isOrphan) {
  return Object.freeze({ status: "pending" as const });
}
return Object.freeze({
  status: "observed" as const,
  transactionId: prepared.transactionId,
  destinationOutpoint: prepared.destinationOutpoint,
  amountSompi: prepared.amountSompi,
});
```

Here we reach the missing invariant. `isOrphan === false` only distinguishes
which pool contains the transaction. It does not say that any block accepted
the transaction, how deep that block is, or whether the transaction will
remain viable. Nevertheless, the function upgrades this provisional fact to
the same `observed` status used by stronger evidence.

The transaction ID is not a secret. Sompi submits the prepared transaction to
the selected RPC immediately before observation, and
`submitPreparedSend()` verifies only that the RPC returns the expected ID.
Consequently, a malicious endpoint does not need to guess any value. It can
return the correct ID for submission and then return the accepted mempool
shape for that same ID.

### The adapter preserves the overly strong status

`WalletTreasuryOperationAdapter.observe()` in
`src/treasury/operation-adapters.ts:176-196` forwards the wallet status
without adding finality evidence:

```typescript
const observation = await this.wallet.observePreparedSend(
  walletPrepared(envelope),
  envelope.observationStartHash
);
return Object.freeze({
  status: observation.status,
  detail: Object.freeze({
    profile: OBSERVATION_PROFILE,
    kind: this.kind,
    status: observation.status,
    operationKey: intent.operationKey,
    transactionId: envelope.prepared.transactionId,
    destinationOutpoint:
      `${envelope.prepared.transactionId}:${envelope.prepared.destinationOutpoint.index}`,
    amountAtomic: envelope.prepared.amountAtomic,
  }),
});
```

The detail object reasserts the locally prepared identity, which is useful,
but contains no accepting block hash, inclusion DAA score, observed head DAA
score, confirmation threshold, independent observer identity, or proof
digest. We therefore carry a mempool claim into the journal with no way for a
later reader to distinguish it from accepted settlement.

### `observed` becomes terminal and restart-stable

The Treasury module records the adapter probe and immediately commits any
`observed` result. In `src/treasury/operations.ts:202-210`, the transition is:

```typescript
record = await this.reconcile(record, adapter);
if (record.state === "observed") {
  await adapter.commit(
    record,
    bytes,
    this.journal.readObservedTreasuryOperationDetail(operationKey)
  );
  record = this.journal.completeTreasuryOperation(operationKey);
}
```

For a regular wallet send, `commit()` intentionally has no additional chain
check: its comment says that the durable observed fact is the idempotent
commit. The journal then persists `observed -> completed` in
`src/purchase/journal.ts:1614-1638`.

Finally, `TreasuryOperationModule.drive()` returns immediately for terminal
states at `src/treasury/operations.ts:133-139`:

```typescript
let record = this.journal.requireTreasuryOperation(operationKey);
const adapter = this.requireAdapter(record.kind);

if (record.state === "completed" || record.state === "failed_terminal") {
  return view(record);
}
```

If we now remove the only mempool fact and restart Sompi, recovery never calls
the adapter. The false success is not a transient display error; it is the
durable state the recovery design is built to preserve.

## Exploitability Analysis

### Strongest route: the selected RPC equivocates

The clearest attacker position is control of the endpoint selected for Sompi's
outbound wRPC connection. The attacker waits for a normal, policy-authorised
direct send. Submission discloses the exact prepared transaction and ID to the
endpoint. The endpoint can acknowledge that exact ID, then answer the first
`getMempoolEntry()` with `{ isOrphan: false }` without making the transaction
part of canonical network state.

From there we do not need a race. The operation module consumes the response
synchronously, stores `observed`, runs the no-op wallet commit, and stores
`completed`. The endpoint may subsequently report the transaction missing,
disconnect, or be replaced; none of those events revisit the terminal record.
This makes the integrity effect reliable once the hostile endpoint is selected.

The public-resolver health guard raises the cost of becoming that endpoint,
but does not close the path. A node can truthfully report that it is synced,
run a UTXO index, and stay within the explorer DAA window while fabricating a
single mempool response. An explicitly configured node narrows selection to an
operator choice, but compromise or endpoint impersonation still places the
attacker at the relevant boundary. An ordinary remote caller cannot set the
node URL through `send_payment`, so endpoint control remains a real
precondition rather than a general unauthenticated-internet primitive.

### Natural route: provisional truth later becomes false

A malicious node is not required to demonstrate the state-machine error. A
well-behaved node can accurately expose a non-orphan mempool transaction that
is later evicted because of conflict, fee pressure, expiry, or network state.
At the instant Sompi observes it, the response is honest but still too weak
for a terminal transition. This route is less attacker-reliable because the
prepared transaction and its inputs constrain how eviction can be induced,
but it shows why mempool presence and settlement finality must remain distinct
states even when RPC provenance is trusted.

### Constraints on impact

The RPC controls observation, not transaction construction. Sompi verifies the
serialized prepared transaction before use, checks the returned submission ID,
and binds observation to the exact destination outpoint and amount. We cannot
use this path to redirect funds, increase the amount, replace the transaction,
extract the signing key, or escape the operator's per-transaction and rolling
limits. The direct send must already be admissible and signed.

The immediate impact is therefore integrity and recoverability. A caller can
be told that a payment completed when no accepted settlement exists. A
completed direct send is also counted in the rolling one-hour Treasury spend
calculation, so the false record can consume bounded policy capacity until it
ages out. The operation's terminal history remains false after that accounting
window. The current implementation is restricted to Testnet-10, and this
report makes no mainnet impact claim.

These barriers are why the issue remains low/P3 despite crossing an external
RPC-to-durable-state trust boundary. A stronger exploit would need a separate
way to turn the false direct-send status into valuable fulfilment or to bypass
the exact transaction and policy controls; neither primitive is present here.

## Proof of Concept

The `poc/reproduce.mjs` harness drives the real compiled components while
replacing only `KaspaWallet.client()` with a deterministic local RPC object.
It prepares and submits an exact wallet transaction under an allowlisted,
bounded policy. The fake RPC returns:

- no destination UTXO;
- one source UTXO so the transaction can be prepared;
- one non-orphan mempool entry for the prepared transaction ID; and
- no accepted-chain transaction IDs.

After `execute()` returns, the harness asserts that the state is `completed`
even though no accepted-chain query occurred. It then makes the mempool entry
disappear, closes and reopens the SQLite journal, calls `recover()`, and
asserts that the state is still `completed` and that no additional RPC query
was made.

With a sibling checkout of the affected revision built as described in
`poc/README.md`, run:

```sh
cd poc
node reproduce.mjs ../../sompi
```

I ran this command against the exact affected build and observed exit status
zero with this output:

```json
{"provisionalObservationCompleted":true,"stateBeforeEviction":"completed","stateAfterEvictionAndRestart":"completed","mempoolQueriesBeforeEviction":1,"mempoolQueriesAfterRestart":1,"acceptedChainQueries":0,"independentAcceptedChainEvidence":false}
```

The PoC creates only a temporary test wallet, policy, and journal, never opens
a network connection, and removes its temporary directory in a `finally`
block. On a fixed build, the first assertion should fail because a
mempool-only response should leave the operation nonterminal.

## Remediation

The invariant to restore is straightforward: `observed` must mean that the
exact prepared transaction has independently trustworthy accepted-chain
evidence at or above the configured finality threshold. Mempool presence must
mean only `pending`, regardless of orphan-pool classification.

As an immediate fail-safe, change the mempool branch in
`observePreparedSend()` so it can never produce the terminal status:

```typescript
try {
  const mempool = await rpc.getMempoolEntry({
    transactionId: prepared.transactionId,
    includeOrphanPool: false,
    filterTransactionPool: false,
  });
  // Both orphan and regular mempool membership are provisional.
  if (mempool.mempoolEntry) {
    return Object.freeze({ status: "pending" as const });
  }
} catch (error) {
  if (!isMempoolNotFound(error)) throw error;
}
```

That narrow patch closes the reproduced path, but it is not the complete
trust-boundary fix. A malicious single RPC can also fabricate an exact UTXO or
accepted-history answer. We should introduce a finality verifier at the wallet
observation seam and require it before returning `observed`. The verifier
should bind, at minimum:

- the prepared transaction ID, destination outpoint, amount, and network;
- accepting block identity and inclusion DAA score;
- observed virtual DAA score and an operator-configured minimum depth;
- the identities and responses of independent observation sources; and
- a canonical digest of that evidence for the journal.

The adapter can then carry a distinction such as `mempool`, `accepted`, and
`final`, mapping only `final` to the operation module's `observed` status. If
independent sources disagree, the operation should remain recoverable and fail
closed rather than selecting the optimistic answer. Merely asking the same
untrusted endpoint for both inclusion and head DAA score does not provide
independence.

The journal should persist the finality evidence and threshold alongside the
observation detail. This preserves the current durable/idempotent design while
making the terminal decision auditable. Existing immutable preparation,
policy reservation, exact retry, and Testnet-10 gates should remain unchanged.

Regression coverage should include:

1. a non-orphan mempool response remains `pending`;
2. eviction plus restart remains unresolved and triggers re-observation;
3. a single endpoint's fabricated UTXO or history response cannot complete;
4. accepted inclusion below the configured DAA depth remains nonterminal;
5. matching independent evidence above the threshold completes exactly once;
6. observer disagreement fails closed; and
7. exact bytes, destination, amount, policy, and idempotency checks still hold.

## Summary

The direct wallet-send path correctly protects transaction identity and retry
idempotency, but collapses provisional mempool membership into terminal
settlement. We followed that status through the production wallet adapter,
operation module, and journal, then demonstrated that a vanished mempool entry
leaves a restart-stable `completed` record without any accepted-chain query.

The practical effect is bounded false payment success and accounting
corruption on Testnet-10, not arbitrary spending or key compromise. Treating
mempool membership as pending, then requiring durable, thresholded, and
independently trustworthy finality evidence before `observed`, restores the
intended boundary without weakening Sompi's existing exact-preparation and
policy controls. Future variant review should check every Treasury adapter for
the same semantic question: whether its terminal local state is justified by
evidence that remains valid after RPC replacement, restart, and provisional
chain facts disappearing.
