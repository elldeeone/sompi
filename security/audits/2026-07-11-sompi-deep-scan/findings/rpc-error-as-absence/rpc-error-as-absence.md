# Generic Kaspa RPC errors become recovery absence evidence

## Executive Summary

Sompi's abandoned-staging recovery observer treats broad English error phrases
from a selected Kaspa RPC as affirmative proof that a transaction is absent.
In particular, the classifier matches `not found` anywhere in an exception
message, so the capability error `Method not found` is indistinguishable from
a successful transaction-missing result. When the RPC emits this error for
both immutable transactions competing for a still-unspent staging output,
Sompi creates `safe_to_submit` readiness and can broadcast its prepared
recovery transaction.

The affected implementation was introduced in commit
`52080d1278e8514dbfe453b352d71396d64fee50` and is present in revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`. No fixed revision was available
when this report was prepared. I reviewed that exact revision and executed the
included local-only proof of concept against its compiled production modules;
I did not connect to a live RPC, broadcast a transaction, or run a competing
transaction race on Testnet-10.

This is a low-severity, P3 issue. Exploitation requires an already-authorized
abandoned-staging recovery, a selected malicious or incompatible RPC, and an
exact payment that is present or propagating outside that RPC's view. Kaspa
consensus still permits only one spend of the staging output, and Sompi binds
readiness to a fixed recovery transaction for one use. The practical harm is
therefore a forced race or cancellation of the Merchant payment, transaction
fees and operational cost, and ambiguous Purchase accounting or manual
recovery—not theft, arbitrary signing, or duplicate principal.

## Background

Sompi stages value before executing a Kaspa-x402 exact payment. If the Purchase
is abandoned after staging, the Purchase module may recover the same output
back to Sompi's configured wallet. The exact payment and the recovery
transaction necessarily conflict because both spend one immutable staging
outpoint.

Recovery is intentionally split into observation and submission. The observer
has no signing or submission method, while the recovery module holds prepared
bytes and requires a fresh proof about the race. The important interface in
`src/adapters/kaspa-x402/abandoned-staging-recovery.ts` makes that separation
explicit:

```typescript
/** Read-only race observer. It deliberately has no submission method. */
export interface StagingRecoveryRaceSource {
  observeRace(
    request: Readonly<StagingRecoveryRaceRequest>
  ): Promise<Readonly<StagingRecoveryRaceEvidence>>;
}

export interface StagingRecoveryReadiness {
  readonly preparedDigest: Sha256Digest;
  readonly recoveryTransactionId: string;
  readonly exactPaymentTransactionId: string | null;
  readonly raceEvidenceDigest: Sha256Digest;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly proofDigest: Sha256Digest;
}
```

Under the intended invariant, `absent` is a safety fact: it means the expected
transaction was positively determined not to exist in either the UTXO index or
the mempool. An unavailable RPC method, timeout, malformed reply, or transport
error is only an unknown observation. Promoting any of those failures to
`absent` turns the RPC from an evidence source into an unintended authority
over whether treasury recovery may proceed.

The attacker does not call an inbound Sompi endpoint. Instead, Sompi initiates
an outbound connection to a configured or resolver-selected RPC. A malicious
node in that position controls the exception it returns, while an ordinary
incompatible node can trigger the same condition accidentally.

## Vulnerability Details

We first reach `RpcStagingRecoveryRaceSource.observeCandidate()` in
`src/adapters/kaspa-x402/staging-recovery-rpc.ts`. If the expected output is not
in the returned UTXO set, the observer queries the mempool. Returned
transactions receive exact identity and output checks, but the exception path
bypasses those checks:

```typescript
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
  return observedCandidate(expected, "mempool", /* ... */);
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

The decisive control is a message regular expression rather than a typed RPC
status:

```typescript
function isMempoolNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|missing|unknown transaction|mempool.*exist/i.test(message);
}
```

If we carry `Error("Method not found")` through this branch, `not found`
matches and the function returns an `absent` observation. The RPC can repeat
the same response for the exact-payment transaction ID and the prepared
recovery transaction ID. At the same time it returns the real staging output
from `getUtxosByAddresses()`, so the combined tuple is
`absent / absent / unspent`.

The recovery classifier in
`src/adapters/kaspa-x402/abandoned-staging-recovery.ts` treats exactly that
tuple as submission permission:

```typescript
if (staging.status === "unspent") {
  // Explicit observed candidates are handled above.
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

Finally, the Purchase coordinator durably records the observation and invokes
submission when that status is present. In `src/purchase/coordinator.ts`, we
reach the effect boundary without another independent absence check:

```typescript
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

The durable-effect fence is valuable, but it preserves the false proof rather
than correcting it. The transaction submitter rehydrates and rechecks the
immutable recovery bytes, so the RPC cannot substitute an arbitrary payment.
That control narrows the result to the prepared conflicting recovery
transaction.

## Exploitability Analysis

The strongest route starts while an authorized exact payment is propagating or
sitting in a mempool that the selected RPC does not reveal. We let the recovery
workflow begin normally; this matters because the RPC cannot create the
Purchase or bypass human-present authorization by itself. When Sompi asks for
both candidate transaction IDs, the selected node returns `Method not found`
twice and reports the staging UTXO as unspent. The exact payment can coexist in
another node's mempool while the accepted UTXO set still contains its input,
so this response is temporally plausible.

From here, we obtain a bounded double-spend race. If the recovery transaction
wins, the authorized Merchant payment is cancelled and funds return to Sompi,
but the Merchant and Purchase state may already reflect an in-flight payment.
If the exact payment wins, the recovery submission fails or becomes ambiguous,
still consuming fees, RPC work, and operator attention. Repeating the trigger
against other abandoned staging outpoints can cause recurring availability and
accounting disruption, but each attempt remains tied to one Purchase and one
prepared output.

An incompatible RPC produces a useful non-adversarial route: a node that
simply lacks `getMempoolEntry` emits the same capability error. That makes the
failure likely to appear as an operational recovery incident even without a
malicious peer. A malicious selected RPC can improve timing by withholding the
exact candidate and returning a self-consistent current UTXO view, but it
cannot alter the transaction IDs, recovery destination, amount, or prepared
bytes that the module validates.

Several constraints prevent a stronger exploit. Recovery must already be
authorized, readiness expires after a short interval, and the same proof
digest is consumed after one submission attempt. The PoC verifies that replay
guard. Most importantly, Kaspa consensus will accept at most one spend of the
staging outpoint. We therefore cannot turn this primitive into duplicate
principal, arbitrary signing, key disclosure, or a payment to an attacker-
selected address. These controls are why the issue is low severity even though
untrusted network text reaches a treasury effect.

The no-exact-candidate recovery mode offers a related but weaker path: one
false absence for the recovery candidate can mint readiness because no exact
payment was prepared. That route does not cancel a Merchant transaction and is
mainly an availability or evidence-integrity concern. The exact-candidate race
remains the meaningful exploitation case.

## Proof of Concept

The included `poc/reproduce.mjs` uses the affected production
`RpcStagingRecoveryRaceSource`, `AbandonedStagingRecovery`, staging key store,
and exact-transaction builder. It creates disposable deterministic test keys
and an immutable exact/recovery pair. Its fake synchronized Testnet-10 RPC
returns the exact staging UTXO but throws `Error("Method not found")` for both
mempool lookups. The production recovery module then classifies the tuple,
creates readiness, and calls a local recorder at the real external-effect
submission seam.

No network connection or blockchain submission occurs. From the report
directory, after placing and building the affected checkout at `target/`, run:

```sh
cd poc
node reproduce.mjs
```

Representative output is:

```text
[+] affected revision: 4ebb82d4f82bac46ae3addd112c4752f29630a8a
[+] injected RPC error: Method not found
[+] mempool lookups classified: 2
[+] exact payment observation: absent
[+] recovery observation: absent
[+] staging observation: unspent
[+] recovery decision: safe_to_submit
[+] external-effect seam calls: 1
[+] readiness replay rejected: true
[+] no network connection or blockchain submission was performed
```

The two `absent` lines prove the message-classification error, while
`safe_to_submit` and the single seam call prove that the false negative
evidence reaches recovery submission. The replay line preserves the important
limit: the PoC does not bypass readiness consumption. On a fixed build,
`Method not found` should remain an observation failure, so execution should
stop before `safe_to_submit` or produce a non-ready result. Setup and cleanup
instructions are in `poc/README.md`.

## Remediation

The invariant to restore is simple: only a positively identified,
transaction-specific missing result may become `absent`. Capability failures,
timeouts, disconnections, malformed responses, rate limits, and unknown
exceptions must fail closed as unknown observation failures. The RPC adapter
must never infer a security fact from English message fragments.

As an immediate safe patch, remove the message classifier and propagate every
exception. The existing recovery wrapper converts this to `source_failure`,
and the coordinator remains pending rather than submitting:

```typescript
} catch (cause) {
  if (signal.aborted) throw abortError(signal);
  // Fail closed until the pinned client exposes a verified transaction-
  // specific missing result. Never classify exception prose as absence.
  throw cause;
}
```

To restore normal negative lookups, we should add a small adapter around the
pinned RPC client that returns a discriminated result such as `found`,
`transaction_missing`, or `observation_failed`. Only the exact documented
transaction-missing code and response shape should produce
`transaction_missing`; `Method not found` must map to `observation_failed`.
Keeping this distinction in the RPC adapter prevents protocol error semantics
from leaking into the stable recovery state machine.

Regression tests should exercise the production observer and the recovery
module together. They should prove that the exact pinned transaction-missing
response yields `absent`, while `Method not found`, unknown method, timeout,
connection reset, rate limit, malformed object, thrown string, and unexpected
error code never yield `safe_to_submit`. A final coordinator test should
assert that each failure leaves the planned effect pending with zero calls to
the recovery submitter. Where operationally feasible, corroborating negative
evidence across independently selected RPCs would further reduce the risk of a
single selectively dishonest node.

## Summary

Sompi intended abandoned-staging submission to require explicit evidence that
both competing transactions were absent. A broad regular expression collapses
an untrusted RPC capability error into that evidence, allowing
`Error("Method not found")` to help mint one-use `safe_to_submit` readiness.
We traced the value from the outbound RPC exception through the absence
classifier and recovery state machine to the coordinator's submission call,
and the local PoC reproduced the same transition using production modules.

The resulting primitive can race or cancel an authorized Merchant payment and
create fees or ambiguous recovery state, but immutable transaction checks,
short-lived one-use readiness, and one-spend consensus prevent arbitrary or
duplicate spending. Replacing message matching with typed, fail-closed RPC
results—and testing negative evidence end to end—restores the intended trust
boundary without changing Sompi's Purchase model or Kaspa-x402 execution
separation.
