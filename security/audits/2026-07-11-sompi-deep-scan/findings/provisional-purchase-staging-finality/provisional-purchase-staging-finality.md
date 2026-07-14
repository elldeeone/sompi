# Provisional Purchase staging is committed before accepted finality

## Executive Summary

Sompi 0.8.0 at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` can durably mark an authorized
Purchase's Treasury staging as complete when its selected Kaspa RPC merely
returns the two expected transaction outputs. The observation may still be
provisional (`blockDaaScore` zero), and a malicious selected RPC can fabricate
the same self-consistent response. The adapter does not require an accepted
transaction proof before it rotates the shared vault to the new continuation
outpoint and emits staging evidence for the Purchase journal.

If those outputs subsequently disappear, the local vault points to a
continuation that does not exist and the Purchase retains evidence for staging
that never became accepted. This is a persistent availability and workflow
integrity failure that requires owner/operator recovery. It does not let the
RPC change the approved payee, amount, signed transaction, staging key, or
covenant, and a nonexistent staging output cannot fund the later x402
settlement. We therefore assess the issue as **Low severity / P3**.

I reviewed revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
directly and ran the included PoC against a clean build of that revision with
Node.js 24.15.0. It reproduced a production vault commit and canonical staging
evidence from an observation whose DAA score was zero. I did not submit a
transaction to Testnet-10 or test a live RPC adversary. The vulnerable staging
implementation first appeared in commit
`52080d1278e8514dbfe453b352d71396d64fee50`; no fixed revision was available
when this report was prepared.

## Background

The initial Sompi profile combines human-present AP2 authorization with
Kaspa-x402 `exact` payment on Kaspa Testnet-10. A local, deterministic Trusted
Authority approves the Purchase facts. The agent-facing MCP process can then
execute the approved flow, but it does not hold the authority credential. A
Kaspa RPC supplies chain observations and is a lower-trust component: its
response should establish facts about the prepared transaction, not grant
permission or finality by itself.

Before the Merchant payment, Sompi prepares a signed vault transaction with
exactly two outputs. Output zero funds the Purchase-specific staging key.
Output one is the shared vault's covenant-bound continuation. The prepared
bytes, transaction ID, Purchase binding, amount, fee, and expected outpoints
are durable before submission. Once the transaction is accepted, the vault may
safely replace its current outpoint with output one and the Purchase may record
output zero as its funding source.

`VaultManager.observePreparedSend` performs strong equality checks for both
outputs. In `src/vault.ts`, it requires the exact transaction ID, indices,
amounts, scripts, and continuation covenant:

```typescript
const destination = normalized.filter(
  (entry) =>
    entry.txid === prepared.destinationOutpoint.txid &&
    entry.index === prepared.destinationOutpoint.index &&
    entry.amount === prepared.amountSompi &&
    !entry.covenantId &&
    scriptPublicKeyMatchesAddress(
      entry.scriptPublicKey,
      prepared.destination,
      this.networkId
    )
);
const continuation = normalized.filter(
  (entry) =>
    entry.txid === prepared.continuationOutpoint.txid &&
    entry.index === prepared.continuationOutpoint.index &&
    entry.amount === prepared.continuationAmountSompi &&
    entry.covenantId === prepared.covenantId &&
    scriptPublicKeyMatchesAddress(
      entry.scriptPublicKey,
      prepared.continuationAddress,
      this.networkId
    )
);
```

Those checks prevent substitution. The missing invariant is temporal: we also
need trustworthy evidence that this exact transaction reached the configured
accepted finality before either durable consumer advances.

## Vulnerability Details

We first reach the issue through any of the normal staging observation paths.
Both branches of `VaultTreasuryStaging.submit`, as well as restart recovery in
`observe`, treat every non-`undefined` vault observation as final enough to
commit:

```typescript
const existing = await this.vault.observePreparedSend(this.wallet, prepared);
if (existing) {
  return {
    status: "staged",
    submissionDigest: submissionDigest(prepared.transactionId),
    staging: this.commitAndEvidence(decoded, prepared, existing),
  };
}

// ... submit the exact prepared transaction ...

const observed = await this.vault.observePreparedSend(this.wallet, prepared);
if (!observed) {
  return { status: "submitted", submissionDigest: submissionDigest(prepared.transactionId) };
}
return {
  status: "staged",
  submissionDigest: submissionDigest(prepared.transactionId),
  staging: this.commitAndEvidence(decoded, prepared, observed),
};
```

The restart path at `src/adapters/kaspa-x402/vault-treasury-staging.ts:298`
has the same transition. We can therefore carry a provisional observation into
the common sink without racing a single narrow branch.

The observer reads `blockDaaScore` from the RPC response. Missing scores are
normalized to zero, and the result uses the maximum score from the two exact
outputs. It never checks that either score is positive, queries an accepted-ID
history, or obtains an independent finality decision:

```typescript
const observedAtDaa = maxBigInt(
  destination[0].blockDaaScore,
  continuation[0].blockDaaScore
);
return Object.freeze({
  transactionId: prepared.transactionId,
  destinationOutpoint: prepared.destinationOutpoint,
  continuationOutpoint: prepared.continuationOutpoint,
  amountSompi: prepared.amountSompi,
  continuationAmountSompi: prepared.continuationAmountSompi,
  observedAtDaa,
});
```

From here, `commitAndEvidence` performs the irreversible local transition
first. `commitObservedSend` writes `prepared.configUpdate`, including the new
continuation outpoint, to the vault configuration. Only afterward does the
adapter construct the Purchase evidence:

```typescript
private commitAndEvidence(
  envelope: VaultTreasuryStagingEnvelope,
  prepared: PreparedVaultSpend,
  observed: ObservedVaultSpend
): TreasuryStagingResult {
  this.vault.commitObservedSend(prepared, observed);
  const evidence = stagingObservationEvidence(envelope, prepared, observed);
  return Object.freeze({
    evidence,
    transactionId: prepared.transactionId,
    outpoint: `${prepared.transactionId}:0`,
    stagingAmountAtomic: prepared.amountSompi.toString(),
    fundingSource: "vault-treasury",
  });
}
```

The evidence validator checks only the unsigned 64-bit range. Zero satisfies
that check and is serialized into the verified artifact:

```typescript
if (
  observed.observedAtDaa === undefined ||
  observed.observedAtDaa < 0n ||
  observed.observedAtDaa > UINT64_MAX
) {
  throw new VaultTreasuryStagingError(
    "observed vault staging outputs have no valid DAA score"
  );
}
```

The Purchase coordinator then validates the transaction, outpoint, amount, and
funding source against the immutable staging plan and calls
`recordObservedTreasuryStaging`. It does not independently validate finality.
The resulting state transition is:

| Stage | Expected invariant | Vulnerable behavior |
|---|---|---|
| RPC observation | Exact outputs have accepted finality | Exact output records are enough, including DAA zero |
| Vault update | Accepted continuation becomes current | Provisional continuation is persisted |
| Purchase journal | Accepted staging evidence is recorded | Range-valid DAA evidence is recorded |
| Later x402 funding | Staging outpoint exists | Payment cannot proceed if the output disappears |

This distinction matters. All economic facts can be correct while the claimed
chain state is false.

## Exploitability Analysis

The strongest route is a selected malicious or impersonated Kaspa RPC. A real,
human-authorized Purchase must already have passed policy and produced an exact
signed staging transaction. The node learns the transaction ID and output
details when Sompi submits it, so it does not need to guess any bound value. It
returns two UTXO records matching output zero and output one, assigns a DAA
score of zero (or fabricates a positive score), and lets the normal observer
carry those records to `commitAndEvidence`.

We do not need to defeat the authority signature, change the Merchant, or
forge a transaction. Once the exact records match, all three entry paths reach
the same sink. The local vault is rotated to `txid:1`, and the Purchase journal
accepts `txid:0` as staged. The RPC can then stop returning the records. If the
transaction never became accepted, the original vault input may still exist on
chain, but Sompi's local configuration no longer references it. Automatic
payment construction cannot spend `txid:0`, and normal operation remains
blocked until the owner/operator reconstructs the correct vault state.

An honest node that exposes a mempool or otherwise provisional output with DAA
zero provides a second route. That route depends on node/index behavior and
transaction disappearance, so it is less controllable than a malicious node,
but the code explicitly accepts the state. Requiring only `observedAtDaa > 0`
would close that narrow route while leaving the malicious-node route intact: a
single self-consistent RPC can also invent a positive score. Robust repair must
authenticate or corroborate the acceptance/finality evidence, not merely
change the numeric lower bound.

The practical impact remains bounded. Human approval and policy reservation
are prerequisites. Exact Purchase, envelope, transaction, fee, output, key,
and covenant checks prevent value or payee substitution. A nonexistent staging
output cannot fund the later Kaspa-x402 exact payment, so we did not obtain
false Merchant settlement or theft. Public-node health checks can reduce the
chance of selecting a bad node, the MCP entry point is local, the shipped
profile is Testnet-10, and the owner recovery path can repair the vault. The
attacker's useful primitive is therefore a persistent, single-service
Treasury/Purchase availability failure rather than arbitrary spend.

## Proof of Concept

The `poc/reproduce.mjs` harness imports the production
`VaultTreasuryStaging` class from a built target. It supplies the exact prepared
transaction metadata and an `ObservedVaultSpend` whose `observedAtDaa` is
zero, then calls the production common sink with a vault commit spy. The script
asserts that the commit occurs once and that the returned canonical evidence
contains `"observedAtDaa":"0"`.

This is a bounded sink demonstration: it does not emulate a full Purchase,
open a network connection, or move funds. The public reachability is the
`submit`/`observe` call chain shown above. Run it against a disposable checkout
of the affected revision built with Node.js 22 or newer. With the report bundle
and target checkout in sibling directories:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
cd ../provisional-purchase-staging-finality/poc
make SOMPI_TARGET=../../sompi
```

Representative output is also stored in `poc/expected-output.txt`:

```text
[+] loaded production VaultTreasuryStaging
[+] accepted provisional observation: observedAtDaa=0
[+] durable vault commit calls: 1
[+] emitted staging evidence before accepted-finality proof
{"acceptedDaaZero":true,"commitCalls":1,"emittedStagedEvidence":true,"observedAtDaaInEvidence":"0"}
```

The PoC changes only in-memory objects and requires no cleanup. On a corrected
target, the observation should remain pending or be rejected before the commit
spy is called.

## Remediation

The invariant to restore is: **a matching UTXO record is provisional evidence;
only a verified observation meeting the configured finality may rotate the
vault or become durable Purchase staging evidence**. The accepted observation
should be represented by a distinct type that cannot be constructed by the
range check alone.

A minimal structural change is to keep the current exact-output matching but
delegate finality to a concrete Kaspa verifier before calling the sink:

```typescript
const exact = await this.vault.observePreparedSend(this.wallet, prepared);
if (!exact || exact.observedAtDaa === undefined || exact.observedAtDaa <= 0n) {
  return { status: "pending", detailDigest: provisionalDigest(prepared) };
}

const accepted = await this.finality.verifyPreparedVaultSpend({
  transactionId: prepared.transactionId,
  destinationOutpoint: prepared.destinationOutpoint,
  continuationOutpoint: prepared.continuationOutpoint,
  minimumFinality: "accepted",
  observationStartHash: input.context.staging.observationStartHash,
});
if (accepted.status !== "accepted") {
  return { status: "pending", detailDigest: accepted.detailDigest };
}

return {
  status: "staged",
  staging: this.commitAndEvidence(decoded, prepared, {
    ...exact,
    acceptedAtDaa: accepted.acceptingBlockDaa,
    finalityProofDigest: accepted.evidence.declaredDigest,
  }),
};
```

The observation start hash and exact prepared identity must be durable before
submission so restart follows the same rule. Because one untrusted RPC can
fabricate both the UTXOs and its own accepted-history response, deployments
should either pin an operator-trusted node identity or corroborate the result
with an independently selected finality source. The evidence should bind the
finality level, accepting block/hash or equivalent proof, transaction and both
outpoints, verifier identity, and provenance policy. A branded
`AcceptedVaultSpend` value should be the only input accepted by
`commitAndEvidence` and `commitObservedSend`.

We should add regression tests for all stateful branches:

1. exact outputs at DAA zero remain pending and perform no vault commit;
2. positive DAA values without accepted-history evidence remain pending;
3. disagreement between the selected RPC and the independent finality source
   fails closed;
4. a verified accepted transaction commits exactly once across submit and
   restart observation; and
5. disappearance before acceptance leaves the old vault configuration and
   Purchase effect recoverably pending.

These tests should assert both protected sinks: the vault configuration is not
saved and `recordObservedTreasuryStaging` is not reached until finality passes.

## Summary

Sompi's Purchase staging adapter thoroughly binds authorization and economic
facts but collapses “matching outputs are visible” into “the transaction is
accepted.” We traced a selected RPC response through the shared vault observer,
the common staging sink, and the Purchase journal. The included PoC confirms
that DAA zero still triggers a production vault commit and verified staging
evidence.

The resulting primitive is a bounded but durable vault/Purchase lockout, not a
payment substitution or theft path. Restoring a distinct accepted-finality
gate before either durable sink—and testing it across submission, restart, and
RPC-disagreement cases—keeps the exact binding strengths while preventing
provisional or fabricated observations from becoming workflow truth.
