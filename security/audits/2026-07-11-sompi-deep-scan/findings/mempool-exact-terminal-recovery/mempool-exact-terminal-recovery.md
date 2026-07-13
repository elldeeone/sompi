# Provisional exact-payment evidence permanently closes staging recovery

## Executive Summary

Sompi can permanently close an abandoned-staging recovery after seeing the
Purchase's immutable exact-payment transaction only in a selected Kaspa RPC's
mempool. The recovery plan may require `accepted` or `confirmed` finality, but
the `exact_payment_won` journal branch does not compare the observed
`winningFinality` with that requirement. It writes the recovery Effect as
`observed`, which is terminal. On restart, the coordinator returns the stored
exact winner before asking the recovery observer whether that transaction is
still present.

An attacker controlling the selected RPC can therefore report the already-known
exact transaction as a mempool candidate and later stop reporting it. The same
condition can occur naturally if an honest mempool candidate is evicted or
rejected before acceptance. If the transaction never reaches the required
finality, Sompi cannot automatically settle the Purchase or resume recovery of
the staged output. The in-flight Reservation and staged principal remain tied
up until operator repair. A shared malicious RPC can repeat the primitive over
multiple eligible Purchases and consume usable policy capacity.

This is a **medium-severity, P2** availability and durable-state issue. It does
not record a false Settlement, release policy capacity, disclose a key, or
permit an arbitrary transaction. The attacker must control the selected RPC's
view of a real immutable exact candidate, and the candidate must then fail to
reach the required finality.

I reviewed `@elldeeone/sompi` version `0.8.0` at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` and ran the included PoC against an
immutable build of that revision. It reproduced a durable `observed` recovery
Effect from `mempool` evidence despite an `accepted` requirement, then showed
zero observer calls after reopening the journal. I did not connect the PoC to a
live Kaspa RPC, broadcast a transaction, or exercise a real wallet. No fixed
revision was available during this review, and I did not determine the
historical introduction point.

## Background

Sompi's Purchase module keeps payment orchestration and crash recovery in a
SQLite journal. When vault funds have already been moved into a per-Purchase
staging output but the normal exact-payment path cannot finish, the module
prepares an abandoned-staging recovery transaction. Recovery observes a race
between two immutable candidates:

- the exact Merchant payment; and
- the transaction that returns the staged value to Sompi's recovery address.

The selected Kaspa RPC supplies the live UTXO and mempool observations used to
classify that race. The RPC is an untrusted evidence source. Sompi's current
profile ranks finality as `mempool < accepted < confirmed`, and each recovery
plan stores the minimum finality required before an outcome may become durable.

The adapter deliberately treats a mempool candidate as a *provisional* winner
even while the accepted staging UTXO remains unspent. In
`src/adapters/kaspa-x402/abandoned-staging-recovery.ts`, we first reach the exact
candidate branch:

```typescript
if (staging.status === "unspent") {
  // The accepted UTXO set can still contain the source while one candidate
  // is only in mempool. That is a provisional explicit winner, not a
  // contradiction.
  if (exact.status === "observed" && exact.finality === "mempool") {
    return conflict(
      "exact_payment_won",
      evidenceDigest,
      envelope.exactPayment!.transactionId,
      exact.finality
    );
  }
```

The adapter calls this result a conflict because the exact payment won the race
against recovery. The Purchase-facing seam in
`src/adapters/kaspa-x402/staging-recovery-module.ts` converts it into an
`exact_payment_won` observation and carries the provisional finality forward:

```typescript
if (result.reason === "exact_payment_won") {
  if (!result.winningTransactionId || !result.winningFinality) {
    throw new Error("exact staging-race winner is incomplete");
  }
  return Object.freeze({
    status: "exact_payment_won" as const,
    transactionId: result.winningTransactionId,
    finality: result.winningFinality,
    evidenceDigest: result.evidenceDigest,
  });
}
```

This classification is useful: while a candidate is in the mempool, Sompi must
not submit the competing recovery transaction and create a double-spend race.
The security invariant is that provisional evidence pauses recovery and remains
re-observable. Only evidence meeting the recovery plan's required finality may
close that recovery path permanently.

## Vulnerability Details

The invariant is lost when the observation crosses into durable journal state.
`PurchaseJournal.recordTreasuryStagingRecoveryObservation()` validates the
winning transaction ID, but its exact-payment branch never requires or compares
`winningFinality`:

```typescript
} else if (input.status === "exact_payment_won") {
  if (!plan.exactTransactionId || input.winningTransactionId !== plan.exactTransactionId) {
    throw new JournalInvariantError("staging recovery observed a different exact winner");
  }
  this.insertEffectObservation(
    effect.id,
    "observed",
    input.evidenceDigest,
    input.evidenceDigest,
    lease,
    now
  );
  this.updateEffectState(
    effect,
    "observed",
    "exact_payment_won_staging_race",
    input.evidenceDigest,
    now,
    { resultDigest: input.evidenceDigest }
  );
```

We can compare that with the immediately adjacent `recovery_won` branch. That
branch checks the same plan's requirement and preserves an insufficiently-final
winner as pending or ambiguous:

```typescript
} else if (input.status === "recovery_won") {
  // Immutable identity and amount checks omitted here for brevity.
  if (paymentFinalityMeets(input.winningFinality, plan.requiredFinality)) {
    this.finalizeTreasuryStagingRecoveryInternal(plan, effect, lease, input, now);
  } else if (["executing", "submitted", "ambiguous"].includes(effect.state)) {
    this.insertEffectObservation(
      effect.id,
      "pending",
      undefined,
      input.evidenceDigest,
      lease,
      now
    );
    if (effect.state !== "ambiguous") {
      this.updateEffectState(
        effect,
        "ambiguous",
        "staging_recovery_waiting_for_finality",
        input.evidenceDigest,
        now
      );
    }
  }
```

With `requiredFinality = accepted` and `winningFinality = mempool`, the helper in
`src/purchase/finality.ts` would return `false` because the ranks are zero and
one respectively. The vulnerable exact-payment branch simply never calls it.
The resulting state is not a label that can be revised on the next polling
cycle. `assertEffectTransition()` gives an `observed` Effect no outgoing
transition:

```typescript
const allowed: Record<EffectState, readonly EffectState[]> = {
  planned: ["executing", "abandoned"],
  executing: ["submitted", "ambiguous", "retryable", "observed", "failed_terminal"],
  submitted: ["ambiguous", "retryable", "observed", "failed_terminal"],
  ambiguous: ["retryable", "observed", "failed_terminal"],
  retryable: ["executing", "failed_terminal", "abandoned"],
  observed: [],
  failed_terminal: [],
  abandoned: [],
};
```

After a process restart, `PurchaseCoordinator.driveStagingRecovery()` consults
the terminal state before it reaches either observation path:

```typescript
private async driveStagingRecovery(
  recovery: TreasuryStagingRecoveryJournalContext
): Promise<"pending" | "exact_payment_won" | "recovery_won" | "conflict"> {
  if (recovery.accounting) return "recovery_won";
  if (recovery.effect.state === "observed") return "exact_payment_won";
  if (recovery.effect.state === "failed_terminal") return "conflict";
```

We can now follow the complete bad transition with concrete state:

| Step | Durable or observed state |
|---|---|
| Recovery plan | exact transaction `E`; required finality `accepted`; Reservation `in_flight` |
| RPC response | `E` appears only in mempool while the accepted staging UTXO remains unspent |
| Adapter result | `exact_payment_won`, transaction `E`, finality `mempool` |
| Journal result | recovery Effect becomes terminal `observed` |
| Later RPC view | `E` is absent; staging output remains available for recovery |
| Restart result | coordinator returns the stored exact winner without querying the observer |

The exact transaction ID and candidate outputs remain protected by immutable
preparation checks, so the RPC cannot substitute an arbitrary payment. Normal
payment Settlement also retains its own finality checks. The bad state is
therefore a liveness and accounting lockout: no spend is recorded, no recovery
accounting is written, the Reservation remains `in_flight`, and the recovery
Effect can no longer be claimed.

## Exploitability Analysis

The strongest deliberate route is a malicious selected RPC. An eligible
Purchase already contains the immutable exact candidate, and the RPC normally
learns its transaction through an earlier submission attempt or normal network
propagation. The attacker does not need to invent a matching transaction. We
only need the RPC to answer the recovery queries as though that exact candidate
is in its mempool, with the staging UTXO still unspent. This produces the
provisional winner the adapter was designed to represent.

Once Sompi journals that answer, the attacker can withdraw the claim. A later
honest view could show the exact transaction absent and the staging output safe
to recover, but the coordinator does not ask for it. If payment-effect
reconciliation also cannot prove that the original exact transaction reached
the configured finality, neither side of the race can close automatically. The
RPC-controlled value has crossed from provisional network evidence into an
irreversible local state transition.

This route is reliable after the following preconditions are met:

- the Purchase has an observed staging output and an immutable exact-payment
  candidate;
- it has entered abandoned-staging recovery with an `accepted` or `confirmed`
  requirement;
- the attacker is selected as the RPC used by that recovery observation; and
- the exact transaction never subsequently reaches the required finality.

A transient honest failure is an alternative trigger. An exact transaction can
briefly enter a node's mempool and later be evicted, rejected, or lost during a
restart before acceptance. That route requires a narrower timing window and is
less deterministic than a malicious RPC, but it shows why the defect is not
only an integrity concern: a provisional state must remain revisitable even
when every participant is honest.

There are several important limits. First, exact identity validation prevents
the RPC from choosing an arbitrary transaction or redirecting funds. Second,
the path does not itself mark the Purchase settled; if the exact transaction
later reaches the required finality, ordinary payment reconciliation may still
complete the Purchase. Third, the first supported profile is Kaspa testnet-10,
so immediate economic exposure is bounded by that deployment posture. Finally,
one trigger affects one Purchase and Reservation. Fleet-wide capacity denial
requires repeated eligible recoveries through a shared malicious RPC.

Those limits rule out an unauthorized-spend or false-Settlement impact, but
they do not restore availability. Each successful trigger can leave staged
principal and policy capacity persistently unavailable. Operator repair may be
possible, but no automatic outgoing transition exists in this state and the
safe repair procedure was not quantified during this review.

## Proof of Concept

The included PoC builds a legitimate journal fixture through Sompi's public
`PurchaseJournal` APIs. It records an authorised Purchase, Reservation, staged
output, payment preparation, and recovery plan. The decisive inputs are:

```text
recovery plan required finality = accepted
exact winner observed finality  = mempool
```

The script then invokes the vulnerable journal method, closes SQLite, opens it
again, and passes the reloaded context to the real compiled coordinator method.
Its replacement observer would report that the exact candidate is absent and
recovery is safe, but a call counter proves that the coordinator never invokes
it. The script also verifies that no spend or recovery accounting exists and
that a fresh recovery claim is unavailable.

Build the vulnerable revision, then run the PoC with a relative path to that
checkout:

```sh
cd sompi
npm ci
npm run build

cd ../mempool-exact-terminal-recovery/poc
./run.sh ../../sompi
```

The exact relative path depends on where the report bundle and checkout are
unpacked. `poc/README.md` documents the alternative `SOMPI_ROOT` form. The
script verifies the package version and SHA-256 hashes of the decisive source
and compiled files, so it refuses to run against a different revision or stale
build output.

Representative output from my run against the immutable vulnerable build was:

```text
[+] source and compiled hashes match revision 4ebb82d4f82bac46ae3addd112c4752f29630a8a
[+] required finality: accepted
[+] recorded winner finality: mempool
[+] durable effect after restart: observed
[+] reservation after restart: in_flight
[+] settlement spend recorded: false
[+] recovery accounting recorded: false
[+] coordinator result: exact_payment_won
[+] observer calls after restart: 0
[+] new recovery claim possible: false
[+] reproduced terminal recovery state from provisional mempool evidence
```

The PoC is local and non-destructive. It creates a temporary mode-`0700`
directory, uses synthetic evidence and transaction IDs, performs no network
requests, and removes the directory on exit. `KEEP_POC=1` retains the journal
for inspection. It does not need a wallet key or Kaspa node.

## Remediation

The invariant to restore is straightforward: `exact_payment_won` may prevent a
competing submission while provisional, but it must not enter terminal
`observed` state until its finality meets the recovery plan's immutable
requirement. A below-threshold winner should remain `ambiguous` (or another
explicitly re-observable provisional state), just as a below-threshold recovery
winner does.

A minimal patch in `recordTreasuryStagingRecoveryObservation()` could require
the exact winner's finality and mirror the sibling branch:

```typescript
} else if (input.status === "exact_payment_won") {
  if (
    !plan.exactTransactionId ||
    input.winningTransactionId !== plan.exactTransactionId ||
    !input.winningFinality
  ) {
    throw new JournalInvariantError("staging recovery exact winner is incomplete");
  }

  if (paymentFinalityMeets(input.winningFinality, plan.requiredFinality)) {
    this.insertEffectObservation(
      effect.id,
      "observed",
      input.evidenceDigest,
      input.evidenceDigest,
      lease,
      now
    );
    this.updateEffectState(
      effect,
      "observed",
      "exact_payment_won_staging_race",
      input.evidenceDigest,
      now,
      { resultDigest: input.evidenceDigest }
    );
  } else if (["executing", "submitted", "ambiguous"].includes(effect.state)) {
    this.insertEffectObservation(
      effect.id,
      "pending",
      undefined,
      input.evidenceDigest,
      lease,
      now
    );
    if (effect.state !== "ambiguous") {
      this.updateEffectState(
        effect,
        "ambiguous",
        "exact_payment_waiting_for_finality",
        input.evidenceDigest,
        now
      );
    }
  }
```

We should also make the distinction structural rather than relying on every
branch author to remember it. The journal API could accept a typed provisional
winner separately from a terminal winner, and the terminal transition helper
could require a proof object containing both `actualFinality` and
`requiredFinality`. This keeps provisional RPC evidence out of terminal states
even if another adapter adds a new result variant later.

Regression coverage should exercise the real restart boundary:

1. With `requiredFinality: accepted`, record a mempool exact winner and assert
   that the recovery Effect remains re-observable rather than `observed`.
2. Close and reopen the journal, return exact-absent/recovery-absent/staging-
   unspent evidence, and assert that the observer is called and recovery can
   proceed.
3. Upgrade the same exact candidate to `accepted` and assert that only then does
   the Effect become terminal.
4. Repeat with `requiredFinality: confirmed`, including an `accepted` candidate
   as the provisional negative case.
5. Preserve the exact transaction-ID mismatch test so the finality fix cannot
   weaken immutable candidate binding.

Using more than one independent RPC for high-value observations can reduce the
ability of a single endpoint to fabricate a mempool view, but quorum is defense
in depth rather than the primary fix. Even unanimous mempool evidence is still
provisional and must remain re-observable until it reaches the configured
finality.

## Summary

Sompi correctly recognizes that an exact transaction in the mempool should
pause an abandoned-staging recovery, but the journal promotes that provisional
result into a terminal Effect without enforcing the recovery plan's finality
requirement. We followed the value from the untrusted RPC classification,
through the adapter seam, into the missing journal comparison and the
coordinator's no-reobservation fast path.

The PoC demonstrated the practical result on revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`: `mempool` evidence satisfied an
`accepted` plan, the state survived restart as `observed`, the Reservation
remained `in_flight`, and the observer was never called again. No false
Settlement was written, but the Purchase could no longer automatically choose
settlement or recovery if the exact transaction disappeared.

We should gate every terminal race winner by the plan's required finality and
retain insufficient evidence in a re-observable state. Variant analysis should
focus on other paths where RPC-derived mempool or current-UTXO observations are
converted into terminal journal state, especially across restart boundaries.
