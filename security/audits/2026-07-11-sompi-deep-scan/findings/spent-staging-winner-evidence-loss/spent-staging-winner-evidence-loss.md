# Spending a staging-race winner erases the evidence needed to close recovery accounting

## Executive Summary

Sompi's abandoned-staging recovery distinguishes an exact Merchant payment
from a wallet recovery transaction by looking for each candidate's output in
the current UTXO set and, if the output is absent, looking for the transaction
in the current mempool. These are transient views. Once the winning output is
spent and the winning transaction has left the mempool, both immutable
candidates appear absent even though one necessarily spent the common staging
outpoint.

A configured malicious Merchant can reach this state without forging a
transaction or compromising Sompi. After an exact payment accepts, the
Merchant can delay or disrupt application completion and immediately spend its
received output. Delayed recovery then loses the evidence that the exact
transaction won. Sompi correctly refuses to guess, but it records an
`unknown_staging_spender` conflict as terminal, stops re-observing the race,
and leaves the Purchase's Treasury Reservation `in_flight`. That reservation
continues consuming hourly policy capacity indefinitely. Repeating the timing
against later human-approved Purchases can therefore create a cumulative
accounting and Treasury-availability denial of service.

I rate this issue **medium severity / P2**. It does not enable a duplicate
spend, false Settlement, key compromise, or direct theft: the fail-closed
classification is an important control. The impact is instead durable
paid-versus-recovered ambiguity and retained policy capacity requiring manual
repair.

The affected recovery implementation first appears in commit
`52080d1278e8514dbfe453b352d71396d64fee50` and remains affected at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`. No fixed revision was available
for comparison. I reviewed that affected revision directly, ran the included
production observer/classifier probe against a clean build, and ran the two
targeted project regressions covering classification and coordinator state.
I did not submit or mine chained transactions on a Kaspa testnet node, so node
history, pruning, and reorganisation behaviour remain deployment questions
for the fix rather than claims made by this report.

## Background

Sompi's stable `Purchase` record owns the lifecycle from authorization through
payment, fulfilment, failure, and recovery. Before Treasury movement, the
Purchase module durably reserves the Merchant price and bounded additional
costs. Once staging begins, that reservation becomes `in_flight`; releasing or
accounting it must be backed by an observed outcome rather than by elapsed
time.

For the supported Kaspa-x402 exact flow, Sompi first creates a staging output.
Two immutable transactions can then compete to spend the same staging
outpoint:

- the exact-payment transaction sends the authorised amount to the Merchant;
- the recovery transaction returns the staged principal to Sompi, less the
  authorised staging and recovery fees.

Kaspa's one-spend rule ensures that at most one candidate can win. It does not,
however, guarantee that the winner's own output remains unspent. The recipient
of the exact payment controls the Merchant output as soon as it is accepted,
and Sompi's wallet can later spend a recovered output. Winner attribution must
therefore survive a second transaction consuming that output.

`RpcStagingRecoveryRaceSource.observeRace()` obtains one current UTXO response
for the staging, exact-payment, and recovery addresses, then observes both
candidates. The class comment in
`src/adapters/kaspa-x402/staging-recovery-rpc.ts` describes the intended safety
property:

```ts
/**
 * Testnet-10-only read source for the two transactions competing for one
 * staging outpoint. It queries both candidate identities and the source UTXO;
 * it never submits, signs, or infers a winner from one candidate alone.
 */
export class RpcStagingRecoveryRaceSource implements StagingRecoveryRaceSource {
```

That conservative rule is sound. The missing piece is durable evidence. A
current UTXO entry proves that an output exists now, and a current mempool entry
proves that a transaction is pending now. Neither answers the historical
question Sompi needs after the output has been spent: which immutable candidate
was accepted as the spender of the staging outpoint?

## Vulnerability Details

We first reach the gap in `observeCandidate()` in
`src/adapters/kaspa-x402/staging-recovery-rpc.ts`. The method treats a matching
current output as observed. If no such output exists, its remaining control
flow asks only for a current mempool entry; a not-found response becomes
`absent`:

```ts
try {
  const response = await raceSignal(
    rpc.getMempoolEntry({
      transactionId: expected.transactionId,
      includeOrphanPool: false,
      filterTransactionPool: false,
    }),
    signal
  );
  if (response.mempoolEntry.isOrphan) {
    return partialCandidate(expected, "orphan-transaction");
  }
  if (!mempoolMatches(response.mempoolEntry.transaction, expected)) {
    return partialCandidate(expected, "mempool-transaction-mismatch");
  }
  return observedCandidate(expected, "mempool", digest({
    source: "kaspa-wrpc-mempool",
    transactionId: expected.transactionId,
    inputOutpoint: expected.inputOutpoint,
    outputOutpoint: expected.outputOutpoint,
    outputAmountAtomic: expected.outputAmountAtomic,
    outputScriptPublicKey: expected.outputScriptPublicKey,
    finality: "mempool",
  }));
} catch (cause) {
  if (signal.aborted) throw abortError(signal);
  if (!isMempoolNotFound(cause)) throw cause;
  return Object.freeze({
    status: "absent" as const,
    detailDigest: digest({
      source: "kaspa-wrpc",
      status: "not-in-utxo-index-or-mempool",
      transactionId: expected.transactionId,
      outputOutpoint: expected.outputOutpoint,
    }),
  });
}
```

The amount, script, transaction identity, and finality checks on observable
data are valuable. The problem is the meaning assigned to absence: the code
has ruled out only a *currently unspent output* and a *currently pooled
transaction*. It has not ruled out an accepted transaction whose output was
subsequently spent.

We then carry the two candidate observations into `observeStaging()`. If the
staging output itself is absent, the method supplies a spender transaction ID
only when exactly one candidate is still observable:

```ts
const winner =
  exactTransactionId !== undefined && recoveryTransactionId === undefined
    ? exactTransactionId
    : recoveryTransactionId !== undefined && exactTransactionId === undefined
      ? recoveryTransactionId
      : undefined;
return Object.freeze({
  status: "spent" as const,
  ...(winner === undefined ? {} : { spendingTransactionId: winner }),
  detailDigest: digest({
    status: "staging-outpoint-absent",
    outpoint: request.staging.outpoint,
    ...(winner === undefined ? {} : { observedSpender: winner }),
  }),
});
```

Consider an exact-payment winner with transaction ID `E` and recovery
candidate `R`:

| Observation time | Exact output | Recovery output | Staging output | Result |
|---|---|---|---|---|
| before the Merchant spends | present | absent | spent | spender `E` |
| after the Merchant spends and `E` leaves mempool | absent | absent | spent | spender unknown |

Consensus state did not change the historical winner between these rows. Only
the observer's ability to see the winner's *current output* changed. Because
`E` and `R` are both recorded as absent in the second row,
`spendingTransactionId` is omitted.

The adapter-local classifier in
`src/adapters/kaspa-x402/abandoned-staging-recovery.ts` correctly refuses to
turn that ambiguity into an exact or recovery winner:

```ts
if (exact.status === "observed") {
  // Validate the optional inferred spender, then return exact_payment_won.
}
if (recovery.status === "observed") {
  // Validate the optional inferred spender, then return recovery_won.
}
return conflict("unknown_staging_spender", evidenceDigest);
```

At the Purchase seam,
`src/adapters/kaspa-x402/staging-recovery-module.ts` maps that result to a
generic conflict. The durable consequence appears in
`src/purchase/journal.ts`: the observation makes the recovery effect terminal
without creating winner accounting or changing the reservation.

```ts
} else if (input.status === "conflict") {
  if (effect.state !== "failed_terminal") {
    this.insertEffectObservation(
      effect.id, "conflict", undefined, input.evidenceDigest, lease, now
    );
    this.updateEffectState(
      effect,
      "failed_terminal",
      "staging_recovery_conflict",
      input.evidenceDigest,
      now,
      { errorCode: "staging_recovery_conflict" }
    );
  }
}
```

This differs from a successfully observed recovery winner. In that path,
`finalizeTreasuryStagingRecoveryInternal()` inserts recovery accounting and
atomically changes the reservation from `in_flight` to `released`. No
equivalent closure is safe for an unknown winner, so the conflict path leaves
the reservation untouched.

Finally, `src/purchase/coordinator.ts` makes terminality permanent for normal
recovery calls:

```ts
if (recovery.accounting) return "recovery_won";
if (recovery.effect.state === "observed") return "exact_payment_won";
if (recovery.effect.state === "failed_terminal") return "conflict";
```

We never reach `stagingRecovery.observe()` again after that third branch.
Meanwhile, `policyCapacityUsedInternal()` explicitly includes every
`in_flight` reservation with no expiry predicate:

```sql
SELECT amount_atomic, additional_cost_ceiling_atomic
FROM treasury_reservations
WHERE (state = 'active' AND expires_at_ms > ?) OR state = 'in_flight'
```

The full bad state is therefore deterministic: the recovery effect is
terminal, exact-versus-recovery accounting is absent, the reservation remains
`in_flight`, later recovery calls do not re-observe, and the reserved amount
plus additional-cost ceiling continues counting against policy capacity.

## Exploitability Analysis

The strongest attacker is a configured Merchant that legitimately receives an
exact payment. We do not need to control Sompi's wallet, RPC node, authority,
or consensus. A practical sequence is:

1. A human approves a Purchase and the exact transaction wins the staging
   race.
2. The Merchant causes application completion to remain unavailable, for
   example by dropping or delaying the post-payment response. The Purchase
   later enters abandoned-staging recovery.
3. The Merchant spends its received output promptly. This is an ordinary
   transaction signed with the Merchant's own key.
4. By the time Sompi observes recovery, the exact output is no longer in the
   UTXO set and the exact transaction is no longer in mempool. The recovery
   candidate was never accepted, so it is absent too.
5. Sompi reaches `unknown_staging_spender`, terminalises recovery, and retains
   the reservation.

The timing does not require a consensus race after the exact payment is
accepted. The Merchant controls when it spends its own output, and the
vulnerable observer has no historical fallback. Reliability depends on when
Sompi begins recovery and how long a node retains the original transaction in
its mempool view, but spending before delayed observation is a normal and
repeatable Merchant capability.

The immediate reach is one Purchase and one reservation. Repetition requires
additional approved Purchases, so this is not an unauthenticated unbounded
storage attack. It is still useful to an adversarial Merchant: each successful
iteration removes the Purchase amount plus its authorised additional-cost
ceiling from available hourly capacity. Because `in_flight` rows do not age
out of the capacity calculation, the effect accumulates until an operator
performs a repair that the normal coordinator path cannot perform.

A second route exists without a malicious Merchant. If the recovery
transaction wins and Sompi's wallet later spends the recovered output before a
delayed observation, the same current-state loss can erase evidence of the
recovery winner. That route is operational rather than attacker-driven, but it
shows that the root cause is not Merchant identity: any secondary spend can
destroy the only evidence source.

Several controls materially limit the issue:

- Kaspa consensus still permits only one spend of the staging outpoint.
- Candidate amount, script, transaction ID, and finality facts are checked
  while evidence is visible.
- The classifier does not guess a winner and does not submit another recovery
  transaction after the ambiguous spend.
- The Merchant cannot redirect additional funds or obtain Sompi keys through
  this path.

Those controls are why the issue is not a theft or false-Settlement finding.
They also explain why simply treating the exact candidate as the winner would
be the wrong fix: the indistinguishable recovery-winner variant would then be
misaccounted. We need durable historical evidence, not a more optimistic
classification rule.

## Proof of Concept

The `poc/` directory contains a deterministic probe that loads the built
production observer and classifier. It provides a current UTXO entry for the
exact-payment output as a control, then removes that entry to model the
Merchant's secondary spend after the original transaction has left mempool.
The probe asserts that the first observation identifies the exact winner and
the second loses `spendingTransactionId` and returns
`conflict/unknown_staging_spender`.

The runner then executes the project's focused classifier regression and its
coordinator regression. The latter asserts that the conflict produces a
`failed_terminal` recovery effect while its reservation remains `in_flight`.
To run from the report directory, place a checkout of the affected revision at
`../sompi` and use:

```sh
git -C ../sompi checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix ../sompi ci
npm --prefix ../sompi run build
cd poc
make SOMPI_TARGET=../../sompi
```

Representative output is:

```text
[+] before secondary spend: exact=observed, recovery=absent
[+] attributed staging spender: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
[+] after secondary spend: exact=absent, recovery=absent
[+] attributed staging spender: <missing>
[+] classifier before: conflict/exact_payment_won
[+] classifier after: conflict/unknown_staging_spender
✔ both candidates, partial evidence, unknown spenders, and mismatched spenders fail closed
ℹ tests 1
ℹ pass 1
ℹ fail 0
[+] production classifier regression passed
✔ unknown staging spender fails closed and over-ceiling recovery remains persisted for manual authority
ℹ tests 1
ℹ pass 1
ℹ fail 0
[+] coordinator regression confirmed failed_terminal with in_flight reservation
```

This is a safe local reproduction: it performs no network connection,
signature, submission, or wallet mutation. Its deliberate limit is that it
models the post-spend node view rather than mining an exact payment and chained
Merchant spend. A local Testnet-10 integration test should be added as part of
the fix to establish the chosen history provider's behaviour under pruning and
reorganisation.

## Remediation

The invariant to restore is: **winner evidence for an irreversible staging
race must outlive the winner's spendable output, mempool residency, process
restart, and the supported pruning window**. Current UTXO or mempool presence
may be a fast path, but it cannot be the only source used to close durable
Purchase accounting.

The minimal structural fix is to give the Kaspa-x402 recovery adapter an
accepted-history source that can look up both immutable candidate transaction
IDs against an anchored chain view. The result must verify the candidate's
transaction ID, staging input, expected output facts, acceptance anchor, and
required finality before returning `observed`. The following sketch shows the
shape; `acceptedHistory` is an explicit trusted interface, not an assumed RPC
method name:

```ts
// After current UTXO and mempool checks fail:
const accepted = await this.acceptedHistory.findCandidate({
  transactionId: expected.transactionId,
  inputOutpoint: expected.inputOutpoint,
  outputOutpoint: expected.outputOutpoint,
  anchor: request.observationAnchor,
  signal,
});

if (accepted !== null) {
  if (
    accepted.transactionId !== expected.transactionId ||
    accepted.inputOutpoint !== expected.inputOutpoint ||
    accepted.outputAmountAtomic !== expected.outputAmountAtomic ||
    accepted.outputScriptPublicKey !== expected.outputScriptPublicKey
  ) {
    return partialCandidate(expected, "accepted-history-mismatch");
  }
  return observedCandidate(
    expected,
    accepted.finality,
    digest({ source: "anchored-accepted-history", ...accepted })
  );
}
```

We should persist the verified acceptance anchor and winner evidence in the
Purchase Journal as soon as they are learned, bound to the immutable recovery
plan and evidence digest. On restart, the coordinator should prefer that
durable evidence and revalidate it according to the selected reorganisation
policy. This keeps protocol-specific history in the Kaspa-x402 adapter while
the Purchase module stores stable outcome facts and accounting.

If the history source is temporarily unavailable, the safe fallback remains
fail closed, but the state should stay recoverable rather than becoming an
automatic `failed_terminal` fast path. An `ambiguous` effect with bounded
backoff can be re-observed after the history service recovers. A separately
authenticated operator-resolution path may be useful for genuinely pruned or
irrecoverable cases, but it must require evidence identifying the exact winner
and must atomically close the corresponding reservation and accounting. It
must never release capacity merely because both current outputs are absent.

Regression coverage should include:

- an accepted exact winner followed by a Merchant spend, mempool absence, and
  delayed observation that still returns `exact_payment_won`;
- an accepted recovery winner followed by a wallet spend and delayed
  observation that still returns `recovery_won` and releases the reservation;
- restart after winner evidence is persisted;
- history unavailability, which remains retryable and never submits another
  recovery or releases capacity without a winner;
- a reorganisation invalidating a prior anchor, which returns to ambiguity
  without retaining stale accounting; and
- the existing both-candidates, mismatched-spender, and malformed-evidence
  fail-closed cases.

## Summary

Sompi safely constructs two immutable candidates for one staging outpoint and
correctly refuses to guess when their evidence conflicts. The vulnerability is
that its production observer equates absence from two current-state views with
absence of historical acceptance. Spending the winner's output makes a real
exact or recovery outcome disappear from those views.

We demonstrated that the exact winner is attributable before its output is
spent, that the same production code loses attribution afterward, and that the
resulting `unknown_staging_spender` conflict terminalises recovery while an
`in_flight` reservation continues consuming policy capacity. The robust fix is
to retain or query anchored accepted-history evidence and bind it durably to
the Purchase before closing accounting. Further work should concentrate on
Kaspa history/pruning and reorganisation semantics, because those determine
how long the recovery invariant remains provable without an operator-assisted
resolution path.
