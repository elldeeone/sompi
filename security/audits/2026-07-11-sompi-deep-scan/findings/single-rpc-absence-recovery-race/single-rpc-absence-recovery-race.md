# Single-RPC Absence Evidence Can Authorize a Competing Staging-Recovery Transaction

## Executive Summary

Sompi's abandoned-staging recovery path treats one selected Kaspa RPC's
current view as sufficient proof that neither of two competing transactions
exists. If that RPC reports the immutable exact Merchant payment absent, the
immutable recovery transaction absent, and their shared staging outpoint
unspent, Sompi issues a short-lived `safe_to_submit` token. The Purchase module
then uses that token to broadcast the recovery transaction.

That evidence is internally consistent, but it does not establish global
absence. A stale, partitioned, selectively omitting, or malicious RPC can
supply the required tuple while the exact payment is already propagating or
visible through another network view. We can therefore turn one observer's
negative snapshot into an avoidable double-spend race between the authorized
Merchant payment and Sompi's recovery sweep.

The affected source reviewed here is Sompi `0.8.0` at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`. No fixed revision was available at
the time of review. I reviewed that revision directly and ran the bundled
local PoC against a clean build of it. The PoC reached `safe_to_submit` and one
intercepted recovery submission while an independent simulated view already
observed the exact payment. I did not run a live two-node partition or
broadcast either transaction to Testnet-10.

The issue is rated **Low (P3)** under the project's current testnet threat
model and maps most closely to **CWE-345, Insufficient Verification of Data
Authenticity**. Impact is bounded: the recovery bytes and return address are
immutable, readiness is short-lived and single-use, and Kaspa consensus can
accept only one spend of the staging outpoint. The primitive permits
cancellation, fee and resource cost, and Purchase/accounting ambiguity rather
than redirection, duplicate accepted principal, or key theft.

## Background

Sompi's Purchase module stages value before constructing the exact Kaspa-x402
payment. Once the exact transaction has been prepared, two immutable
transactions may compete for the same staging outpoint:

- the **exact payment**, whose pinned Merchant output pays the authorized
  amount; and
- the **recovery transaction**, whose pinned output returns the remaining
  staged principal to Sompi's configured wallet.

Recovery planning occurs only after the workflow is otherwise eligible for
abandoned-staging recovery. This vulnerability does not let an RPC approve a
Purchase, choose a payee, create arbitrary transaction bytes, or decide when
recovery policy becomes eligible. The security-sensitive question is narrower:
once recovery is eligible, what evidence is strong enough to authorize the
competing recovery broadcast?

`AbandonedStagingRecovery` separates observation from submission. Its public
contract says submission requires fresh evidence that both candidates are
absent and the staging outpoint remains unspent:

```ts
// src/adapters/kaspa-x402/abandoned-staging-recovery.ts
export interface StagingRecoveryRaceEvidence {
  readonly staging: StagingRecoveryOutpointObservation;
  readonly exactPayment: StagingRecoveryCandidateObservation | null;
  readonly recovery: StagingRecoveryCandidateObservation;
}

export interface StagingRecoveryRaceSource {
  observeRace(
    request: Readonly<StagingRecoveryRaceRequest>
  ): Promise<Readonly<StagingRecoveryRaceEvidence>>;
}
```

Several nearby controls are well designed. The prepared envelope binds the
Purchase, staging outpoint, exact candidate, recovery candidate, amounts,
scripts, transaction IDs, fee, and fixed recovery destination. Observation
details are hashed into the readiness token. Submission validates that token
against the same prepared digest, expires it after at most 30 seconds, and
rejects reuse.

Those controls answer *which* transactions and staging output we are talking
about. They do not answer whether the selected RPC's negative claim is true
beyond that node's current view. This distinction matters because the
repository's own threat model treats RPC nodes and network timing as
untrusted.

Production constructs exactly one RPC observation source and one RPC
submitter over the wallet's provider:

```ts
// src/runtime/purchase-runtime.ts
const stagingRecovery = new KaspaStagingRecoveryModule({
  recovery: new AbandonedStagingRecovery({
    keyStore,
    recoveryAddress: wallet.address,
    observer: new RpcStagingRecoveryRaceSource({ rpc: wallet, now }),
    submitter: new RpcStagingRecoveryTransactionSubmitter({ rpc: wallet, now }),
    now,
  }),
  metadata: canonicalStaging,
  observedStaging,
});
```

There is no independent observer, quorum, propagation delay, or authenticated
absence proof in this composition.

## Vulnerability Details

### One peer supplies every decisive fact

When `RpcStagingRecoveryRaceSource.observeRace()` runs, it obtains one client,
checks that client's self-reported health, and fetches one UTXO-index view. It
then asks the same client about both immutable candidates:

```ts
// src/adapters/kaspa-x402/staging-recovery-rpc.ts
const rpc = await raceSignal(this.rpcProvider.client(), request.signal);
const info = await raceSignal(rpc.getServerInfo(), request.signal);
if (
  !info.isSynced ||
  !info.hasUtxoIndex ||
  ![SDK_NETWORK, NETWORK].includes(info.networkId as typeof SDK_NETWORK | typeof NETWORK)
) {
  throw new Error("Kaspa RPC node is unsynced, lacks the UTXO index, or is not testnet-10");
}
const response = await raceSignal(rpc.getUtxosByAddresses(addresses), request.signal);
const entries = response.entries as unknown[];

const [exactPayment, recovery] = await Promise.all([
  request.exactPayment === null
    ? Promise.resolve(null)
    : this.observeCandidate(rpc, entries, request.exactPayment, virtualDaaScore, request.signal),
  this.observeCandidate(rpc, entries, request.recovery, virtualDaaScore, request.signal),
]);
const staging = this.observeStaging(
  entries,
  request,
  observedTransactionId(exactPayment),
  observedTransactionId(recovery)
);
return Object.freeze({ staging, exactPayment, recovery });
```

For a candidate missing from that node's UTXO index, the source asks its
mempool. A transaction-not-found response becomes `status: "absent"`. Separately,
the presence of the exact expected staging entry becomes `status: "unspent"`.
Each result can be perfectly accurate about this particular peer while still
lagging or disagreeing with the wider network.

This issue does not depend on treating an unrelated RPC error as not-found.
Even if not-found recognition uses a perfect structured error code, the result
only proves that one node cannot currently see the transaction. The bundled
PoC deliberately uses an ordinary `transaction not found in mempool` response
so we isolate the single-oracle root cause.

### A self-consistent snapshot becomes submission authority

The classifier validates positive observations against the immutable
transaction ID, input, output, amount, and script. For negative observations,
however, a valid detail digest is enough to retain `absent`. The decisive
branch then requires only the three values supplied by that one source:

```ts
// src/adapters/kaspa-x402/abandoned-staging-recovery.ts
if (staging.status === "unspent") {
  // The accepted UTXO set can still contain the source while one candidate
  // is only in mempool. That is a provisional explicit winner, not a
  // contradiction. Accepted/confirmed output evidence with an unspent
  // source is contradictory.
  if (exact.status === "observed" && exact.finality === "mempool") {
    return conflict(
      "exact_payment_won",
      evidenceDigest,
      envelope.exactPayment!.transactionId,
      exact.finality
    );
  }
  if (recovery.status === "observed" && recovery.finality === "mempool") {
    return recoveryWon(envelope, recovery.finality, evidenceDigest);
  }
  if (exact.status === "observed" || recovery.status === "observed") {
    return conflict("candidate_observed_while_staging_unspent", evidenceDigest);
  }
  if (exact.status === "absent" && recovery.status === "absent") {
    const observedAtMs = readClock(this.now);
    const proofBase = {
      version: 1 as const,
      profile: ABANDONED_STAGING_RECOVERY_PROFILE,
      preparedDigest,
      recoveryTransactionId: envelope.recovery.transactionId,
      exactPaymentTransactionId: envelope.exactPayment?.transactionId ?? null,
      raceEvidenceDigest: evidenceDigest,
      observedAtMs,
      expiresAtMs: checkedDeadline(observedAtMs, this.readinessTtlMs),
    };
    const readiness = Object.freeze({
      ...proofBase,
      proofDigest: digestCanonical(proofBase),
    });
    return Object.freeze({ status: "safe_to_submit" as const, readiness, evidenceDigest });
  }
}
```

The evidence digest prevents later mutation of what the peer reported. It
does not add provenance, independence, or consensus truth. Likewise, the TTL
limits how long Sompi will trust the snapshot; it does not establish that the
snapshot covered a sufficient propagation interval.

We can express the exploitable disagreement as a small state table:

| View | Exact candidate | Recovery candidate | Staging source |
|---|---|---|---|
| Independent network view | observed | absent | spent by exact |
| Selected Sompi RPC | absent | absent | unspent |

Both rows can be internally coherent. Only the second row is consulted by the
production recovery instance, so it produces `safe_to_submit` even though the
first row identifies the exact payment as the winner.

### Readiness reaches the irreversible sink

`submit()` verifies freshness, prepared identity, and non-replay, then calls
the submit-only adapter with the already prepared recovery bytes:

```ts
// src/adapters/kaspa-x402/abandoned-staging-recovery.ts
const { envelope, preparedDigest } = this.requirePrepared(preparedBytes);
const now = readClock(this.now);
validateReadiness(readiness, envelope, preparedDigest, now);
if (this.consumedReadiness.has(readiness.proofDigest)) {
  throw adapterError(
    "readiness_replay",
    "staging recovery readiness proof was already consumed; observe the race again"
  );
}
this.consumedReadiness.add(readiness.proofDigest);

const submitted = await boundedCall(
  this.submitter.submitRecovery({
    network: NETWORK,
    transactionId: envelope.recovery.transactionId,
    transaction: envelope.recovery.transaction,
    transactionEncoding: envelope.recovery.transactionEncoding,
    deadlineAtMs,
    signal,
  }),
  deadlineAtMs,
  this.now,
  signal
);
```

The Purchase coordinator durably records the observation, but immediately
submits when its status is `safe_to_submit`:

```ts
// src/purchase/coordinator.ts
const observed = await this.stagingRecovery.observe({
  preparedBytes,
  signal: abortController.signal,
});
const outcome = this.recordStagingRecoveryObservation(
  recovery.effect.id,
  lease,
  observed
);
if (observed.status !== "safe_to_submit") return outcome;

const submitted = await this.stagingRecovery.submit({
  preparedBytes,
  readiness: observed.readiness,
  signal: abortController.signal,
});
```

Durability and fencing ensure that this is a controlled, attributable effect.
They do not correct the unsafe premise that authorized it. From here, the
exact and recovery transactions compete for the same staging outpoint.

## Exploitability Analysis

The strongest route places the attacker at the configured or
resolver-selected RPC peer. We first need a Purchase whose recovery policy is
already eligible and whose immutable exact payment exists. The attacker does
not create either candidate; those constraints are important. The attacker
instead controls what Sompi can observe during the readiness window.

A practical malicious-peer sequence is:

1. The exact Merchant transaction is submitted or propagates through another
   network path.
2. The selected peer omits both candidate transaction IDs from its current
   UTXO and mempool answers while continuing to return the exact staging UTXO.
3. The peer reports itself synced, UTXO-indexed, and on Testnet-10.
4. Sompi hashes the absent/absent/unspent tuple and emits readiness.
5. The credential-bearing Sompi process submits the immutable recovery
   transaction through the peer.
6. The peer forwards the recovery so it races the exact payment for the same
   input.

A Byzantine peer can make this sequence reliable at the application layer
because it controls all three branches and the timing of its responses. A
merely stale or partitioned peer creates the same primitive without deliberate
lying, but the timing window is narrower: it must still expose the staging
entry while missing an exact candidate visible elsewhere, and recovery must be
eligible during that disagreement.

The winner determines the bounded impact:

- If recovery wins, the authorized Merchant payment is cancelled at consensus.
  Sompi pays the pinned recovery fee and the Purchase may require
  reconciliation with Merchant-side expectations.
- If the exact payment wins, the recovery submission conflicts or is rejected.
  Sompi has still made an unnecessary irreversible attempt and may enter an
  ambiguous recovery/reconciliation path depending on response timing.
- Network timing can leave the operator with conflicting local and Merchant
  observations even though consensus ultimately selects one transaction.

Several stronger attacks are blocked. We cannot use this primitive to alter
the recovery destination or amount because the canonical envelope and
transaction ID are revalidated. We cannot extract a staging key or ask Sompi
to sign arbitrary bytes. Replaying the same readiness fails because it is
single-use, and waiting past its TTL fails validation. Most importantly, we
cannot make both transactions settle: Kaspa's one-spend rule permits only one
accepted winner.

There are also useful fail-closed branches. If the selected RPC reports either
candidate positively while the staging source remains visible, the classifier
does not issue readiness. If staging evidence is unknown or partial, readiness
is also withheld. The attacker therefore needs the precise internally
consistent absent/absent/unspent tuple, not just an arbitrary malformed reply.

These constraints explain the Low rating. The boundary crossing is real—an
external evidence source causes a treasury-capable process to broadcast a
competing transaction—but the available primitive is cancellation, cost, and
lifecycle ambiguity, not theft. Services that continue using the same
malicious peer could repeat the primitive for each separately eligible
Purchase.

## Proof of Concept

The `poc/` directory contains a deterministic local harness. It imports the
real compiled implementation and verifies the vulnerable source hashes before
running. It creates a valid staging key, exact payment candidate, and immutable
recovery transaction using Sompi's own builders.

We then create two fake Kaspa RPC views:

- the alternate view contains the exact Merchant output and therefore reports
  the exact candidate observed and the staging input spent; and
- the selected view contains only the original staging UTXO and returns a true
  transaction-not-found result for both candidates.

Only the selected view is wired into `AbandonedStagingRecovery`, mirroring the
production single-source composition. The harness first records both views,
then calls the public `observe()` and `submit()` methods. Submission travels
through `RpcStagingRecoveryTransactionSubmitter`, but the fake RPC intercepts
`submitTransaction`, so there is no network or blockchain side effect.

From the report bundle, after building a sibling checkout of the vulnerable
revision, run:

```sh
cd poc
node reproduce.mjs --target ../../sompi
```

Representative output from my run was:

```text
[+] vulnerable revision: 4ebb82d4f82bac46ae3addd112c4752f29630a8a
[+] alternate view: exact=observed/confirmed staging=spent
[+] selected RPC: exact=absent recovery=absent staging=unspent
[+] classifier result: safe_to_submit
[+] recovery submission calls: 1
[+] reproduced: one selected RPC authorized the competing recovery submission
```

The PoC proves the production source-to-submission decision path and isolates
the single-oracle problem from error-message classification. It does not
measure how often real Testnet-10 peers disagree, simulate network propagation
latency, or demonstrate which transaction wins a live race. Those questions
require a disposable two-node integration environment and are operational
likelihood work, not prerequisites for the unsafe authorization transition.

## Remediation

The invariant to restore is:

> A negative observation must not authorize a transaction that conflicts with
> an already prepared payment unless absence is independently corroborated
> across a meaningful propagation interval.

The narrowest robust change is inside the Kaspa-x402 recovery adapter. Compose
multiple explicitly configured, independently administered RPC observers there
rather than expanding Sompi's stable Purchase model or creating a generic
payment-rail plugin system. Source identity must come from trusted operator
configuration; an RPC must not be allowed to label two replies as independent.

At minimum, require two independent views to agree on both candidate absences
and the exact staging facts, repeat that agreement after a configured safety
interval, and fail closed on disagreement, timeout, unsupported history, or a
changed network head. A simplified shape is:

```ts
interface CorroboratedRaceEvidence {
  readonly observations: readonly SourceObservation[];
  readonly firstAgreementAtMs: number;
}

function mayIssueReadiness(
  evidence: CorroboratedRaceEvidence,
  now: number,
  propagationSafetyMs: number
): boolean {
  const views = distinctConfiguredSources(evidence.observations);
  if (views.length < 2) return false;
  if (!views.every(({ race }) =>
    race.exactPayment?.status === "absent" &&
    race.recovery.status === "absent" &&
    race.staging.status === "unspent"
  )) return false;
  return now - evidence.firstAgreementAtMs >= propagationSafetyMs;
}
```

The production implementation should bind the configured source set,
observation times, relevant head/DAA context, and both rounds into the readiness
digest. Immediately before submission, it should either re-observe or consume
a second-round proof whose maximum age is tightly bounded. If stronger Kaspa
inclusion or accepted-transaction history proofs are available in the pinned
profile, prefer those over multiplying unauthenticated current-state oracles.

The existing immutable candidate checks, fixed return address, readiness TTL,
single-use token, and effect fencing should remain. They defend different
invariants and materially limit impact.

Regression coverage should include:

1. one view reports absent/absent/unspent while another observes the exact
   transaction: no readiness and no submission;
2. only one source is reachable: pending or explicit source failure, never
   readiness;
3. two sources agree in one instant but the propagation interval has not
   elapsed: no readiness;
4. independent agreement survives the second observation round: readiness may
   be issued for the same immutable candidates;
5. either view changes before submission: invalidate readiness and reconcile;
6. a semantically correct transaction-not-found response from one node remains
   insufficient by itself.

These tests should assert the external sink directly by proving
`submitRecovery()` is never called in the first, second, third, fifth, and
sixth cases.

## Summary

Sompi carefully binds recovery bytes, transaction identities, value, keys,
evidence digests, freshness, and replay state. The remaining gap is semantic:
one selected RPC's negative current-state snapshot is treated as proof that a
competing Merchant payment does not exist anywhere relevant.

We followed that snapshot from one outbound RPC connection through
absent/absent/unspent classification, readiness creation, durable Purchase
handling, and recovery submission. The local PoC showed the exact payment in
an independent view while the configured view still authorized one intercepted
recovery submission.

Independent corroboration over a propagation interval—or a stronger
consensus-backed absence/inclusion mechanism—would restore the missing
invariant. Future research should measure real peer disagreement windows and
evaluate accepted-transaction history support, but the immediate defensive
priority is to ensure that one negative oracle can never authorize this
conflicting side effect.
