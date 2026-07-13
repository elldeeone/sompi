# Untrusted RPC Can Forge Recovery Finality and Release Policy Capacity

## Executive Summary

Sompi delegates abandoned staging-transaction recovery observation to one
Kaspa RPC. That RPC supplies the UTXO set, the candidate block DAA score, and
the virtual DAA score used to decide finality. A malicious selected RPC can
therefore return a self-consistent, invented recovery output and cause Sompi
to classify the immutable recovery transaction as the race winner.

The classification is not merely informational. When the claimed finality
meets the Purchase plan's requirement, the journal records the staging
principal as returned, releases the in-flight policy reservation, and makes
the Purchase terminal. If the competing exact payment wins on the real
network and the released capacity is then reused, Merchant outflow is no
longer represented by the policy accounting that was supposed to bound it.

The affected source basis is Sompi `0.8.0` at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`. No fixed revision was available
when I completed this review. I inspected that revision directly and ran the
included local fake-RPC harness against its compiled adapter; it produced an
`accepted` recovery observation from a future, invented block DAA score. I did
not connect to a live Kaspa network or execute the full divergent-node,
capacity-reuse sequence.

I assess this as **medium severity / P2**. The accounting impact can be high,
but exploitation requires control of the selected RPC, an abandoned staged
Purchase with a competing exact candidate, a different real network outcome,
and subsequent reuse of the falsely released capacity. The currently declared
profile is Kaspa testnet-10, not mainnet.

## Background

Sompi stages treasury funds before executing an exact Kaspa-x402 payment. An
exact payment and a recovery transaction can then compete to spend the same
staging outpoint. Only one can win under Kaspa consensus. Sompi's recovery
module observes that race and persists one of four useful outcomes: wait,
submit recovery, exact payment won, or recovery won.

The production runtime composes both recovery observation and recovery
submission over the same wallet RPC (`src/runtime/purchase-runtime.ts`,
`createPurchaseRuntime`):

```ts
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

This matters because the submitter sends the complete, signed, immutable
recovery transaction to the selected node. The node consequently learns the
recovery transaction ID, output outpoint, returned amount, and destination
script that later exact-match checks expect. Even when another peer performs
submission, normal transaction propagation can reveal the same facts.

Sompi may use an explicitly configured RPC or one returned by the public
resolver. The configured-node path logs a chain-guard warning but returns the
node anyway. The resolver path compares only the node's reported tip DAA score
with a best-effort explorer value (`src/wallet.ts`, `KaspaWallet.client` and
`chainGuardVerdict`):

```ts
if (this.config.nodeUrl) {
  this.rpc = new RpcClient({ url: this.config.nodeUrl, networkId: this.networkId });
  await this.rpc.connect({ timeoutDuration: 15_000, retries: 2 } as any);
  const verdict = await this.chainGuardVerdict(this.rpc);
  if (verdict) console.error(`sompi warning: configured node ${this.config.nodeUrl} ${verdict}`);
  return this.rpc;
}

const reference = await this.referenceDaaScore();
if (reference === null) return null;
```

The guard can help reject a stale honest node. It does not authenticate an
individual UTXO or bind it to canonical consensus. A malicious RPC can report
a plausible tip while inventing a candidate output, and an explorer failure
removes even the tip comparison.

The important security invariant should therefore be: **no observation made
solely by the RPC that knows the recovery transaction may release durable
policy capacity**. The vulnerable revision instead treats self-consistency
within that one RPC view as finality.

## Vulnerability Details

### One peer controls every decisive observation

We first reach `RpcStagingRecoveryRaceSource.observeRace` in
`src/adapters/kaspa-x402/staging-recovery-rpc.ts`. The method obtains server
information and address UTXOs from one `RpcClient`:

```ts
const rpc = await raceSignal(this.rpcProvider.client(), request.signal);
const info = await raceSignal(rpc.getServerInfo(), request.signal);
if (
  !info.isSynced ||
  !info.hasUtxoIndex ||
  ![SDK_NETWORK, NETWORK].includes(info.networkId as typeof SDK_NETWORK | typeof NETWORK)
) {
  throw new Error("Kaspa RPC node is unsynced, lacks the UTXO index, or is not testnet-10");
}
const virtualDaaScore = BigInt(info.virtualDaaScore);
const response = await raceSignal(rpc.getUtxosByAddresses(addresses), request.signal);
const entries = response.entries as unknown[];
```

`isSynced`, `hasUtxoIndex`, `virtualDaaScore`, and every UTXO entry are claims
made by the same untrusted peer. The checks establish a well-formed,
self-consistent response, not its truth.

Next, `observeCandidate` finds an entry whose outpoint matches the expected
recovery output. Amount and script equality are useful controls because they
prevent a node from substituting some unrelated output. They are not an
independent proof because the node already knows those immutable values:

```ts
const outputMatches = entries.filter(
  (entry) => rpcOutpoint(entry) === expected.outputOutpoint
);
if (outputMatches.length === 1) {
  const entry = requireRecord(outputMatches[0], "Kaspa candidate UTXO");
  const amount = entryBigInt(entry, "amount", "Kaspa candidate UTXO amount");
  const script = entryScript(entry);
  const blockDaaScore = entryBigInt(entry, "blockDaaScore", "Kaspa candidate UTXO DAA score");
  if (amount.toString() !== expected.outputAmountAtomic ||
      script !== expected.outputScriptPublicKey) {
    return partialCandidate(expected, "output-facts-mismatch");
  }
```

### A future block becomes accepted finality

We now carry the RPC-controlled `blockDaaScore` and `virtualDaaScore` into the
finality calculation. At lines 127–133, a block score greater than the
reported virtual score is converted to depth zero. Any nonzero block score is
then at least `accepted`:

```ts
const depth = virtualDaaScore >= blockDaaScore
  ? virtualDaaScore - blockDaaScore
  : 0n;
const finality =
  blockDaaScore === 0n
    ? "mempool"
    : depth >= this.confirmedDaaDepth
      ? "confirmed"
      : "accepted";
return observedCandidate(expected, finality, digest({
  blockDaaScore: blockDaaScore.toString(),
  virtualDaaScore: virtualDaaScore.toString(),
  finality,
}));
```

For the included PoC, the RPC reports virtual DAA `1000` and an invented
recovery output at block DAA `2000`. We get `depth = 0`, but because the block
score is nonzero, Sompi returns `finality = "accepted"`. The future-score case
is a particularly clear trigger, although merely rejecting future values is
not a complete fix: a Byzantine RPC can instead claim block DAA `990` and
virtual DAA `1000` to fabricate the default ten-DAA `confirmed` depth.

The same response omits the staging output and the exact-payment output. When
only the expected recovery output is present, `observeStaging` infers that the
staging outpoint was spent by the recovery transaction:

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
  detailDigest: digest({ status: "staging-outpoint-absent" }),
});
```

Thus the peer does not have to forge arbitrary transaction bytes. It only has
to echo the known recovery facts, omit two outputs, and choose DAA values.

### The observation crosses into durable accounting

`AbandonedStagingRecovery.classifyObservation` checks that the inferred
spender agrees with the immutable recovery transaction. Since all the forged
facts were chosen to match, we reach `recoveryWon`:

```ts
if (recovery.status === "observed") {
  if (staging.spendingTransactionId !== undefined &&
      staging.spendingTransactionId !== envelope.recovery.transactionId) {
    return conflict("spending_transaction_mismatch", evidenceDigest);
  }
  return recoveryWon(envelope, recovery.finality, evidenceDigest);
}
```

The adapter passes the status, transaction identity, amount, and claimed
finality through to the Purchase coordinator. The journal correctly compares
them with the immutable plan, but it has no independent chain evidence to
compare. If the claimed finality ranks at least as high as the planned
requirement, `recordTreasuryStagingRecoveryObservation` calls the finalizer
(`src/purchase/journal.ts`, lines 2802–2812):

```ts
if (input.winningTransactionId !== plan.recoveryTransactionId ||
    input.recoveryOutpoint !== plan.recoveryOutpoint ||
    input.recoveryAmountAtomic !== plan.recoveryAmountAtomic ||
    !input.winningFinality) {
  throw new JournalInvariantError("staging recovery winner differs from its immutable plan");
}
if (paymentFinalityMeets(input.winningFinality, plan.requiredFinality)) {
  this.finalizeTreasuryStagingRecoveryInternal(plan, effect, lease, input, now);
}
```

Inside `finalizeTreasuryStagingRecoveryInternal`, we reach the security sink.
The journal first inserts a `treasury_staging_recovery_accounting` row using
the planned returned amount and claimed finality. It then marks the reservation
`released` and terminalizes the recoverable Purchase:

```ts
const released = this.db.prepare(
  `UPDATE treasury_reservations
      SET state = 'released', release_evidence_digest = ?, updated_at_ms = ?
    WHERE id = ? AND state = 'in_flight'`
).run(input.evidenceDigest, now, reservation.id);
if (released.changes !== 1) {
  throw new JournalInvariantError("concurrent staging recovery Reservation release");
}

if (purchase.state === "failed_recoverable") {
  this.transitionPurchase(
    purchase.id,
    "failed_recoverable",
    "failed_terminal",
    "staging_recovered_without_payment",
    input.evidenceDigest
  );
}
```

This transaction is crash-safe and internally consistent; that does not make
its external premise true. On later recovery calls, the coordinator sees the
existing accounting row and immediately returns `recovery_won` without
re-observing the network (`src/purchase/coordinator.ts`, lines 1866–1871).
The false statement is therefore durable.

## Exploitability Analysis

The strongest practical route is to become the RPC selected for a Purchase
that has entered abandoned-staging recovery. This could be an explicitly
configured but compromised service, or a malicious peer reached through the
public resolver. We do not need the Trusted Authority credential, wallet key,
or inbound MCP access. We answer ordinary outbound RPC requests.

Once Sompi submits the prepared recovery transaction through our peer, we know
the exact output facts needed to survive the adapter's identity checks. During
a later observation we return:

1. synced, indexed, testnet-10 server metadata with a plausible virtual DAA;
2. no staging UTXO;
3. no exact-payment UTXO or mempool entry; and
4. one recovery UTXO with the expected outpoint, amount, script, and a chosen
   nonzero block DAA.

For an `accepted` requirement, any nonzero score suffices in this code path;
the PoC uses an obviously impossible future score to isolate the bug. For a
`confirmed` requirement, we claim a score at least `confirmedDaaDepth` behind
our claimed virtual score. Repeating a fabricated response can target each
recovery attempt served by the same malicious node.

The accounting consequence needs a second network view. While our RPC tells
Sompi that recovery won, the real network must accept the competing exact
transaction. Sompi then releases the original policy reservation as though the
principal returned to its wallet. If the treasury still has funds and policy
capacity is reused, a later reservation can authorize additional outflow even
though the first Merchant payment was real. The primitive is false release of
software-policy capacity, not a consensus double spend.

Several controls constrain this route:

- Changing the recovery transaction ID, amount, output index, or script causes
  partial evidence or a conflict. We cannot redirect the recovery output.
- Showing both candidates causes a conflict, and showing an accepted recovery
  while the staging UTXO remains is rejected as contradictory.
- Kaspa consensus allows only one spend of the staging outpoint. We cannot make
  both the recovery and exact transactions win on the canonical network.
- A random internet host cannot directly invoke the journal sink; it must
  control the selected RPC path.
- The highest impact requires the exact transaction to win elsewhere and the
  newly released capacity to be used before the discrepancy is corrected.

These are meaningful limits, but none authenticates the fact that controls
reservation release. Signature verification is also a dead end as a defence:
the transaction is genuinely Sompi-signed and immutable. The lie concerns
whether it won, not who created it. Likewise, comparing only virtual DAA tips
cannot establish inclusion of a particular output. A second query to the same
endpoint is not independent corroboration.

The current testnet-only profile reduces immediate economic exposure and is
part of the medium likelihood assessment. Before a mainnet gate could be
considered, the finality source would need a proof-backed or independently
corroborated design and a divergent-observer end-to-end test.

## Proof of Concept

The `poc/` directory contains a safe local harness. It performs no network
requests and writes no Sompi state. Instead, it loads the compiled
`RpcStagingRecoveryRaceSource` from a caller-supplied Sompi source root and
provides a fake RPC with the same methods used by production.

From a directory containing both a `sompi/` checkout and this report directory,
build the affected source and run:

```sh
(cd sompi && npm ci && npm run build)
cd untrusted-rpc-forged-recovery-finality/poc
node poc.mjs --source-root ../../sompi
```

The runner exits zero only after asserting all parts of the forged observer
result: exact payment absent, recovery observed as `accepted`, staging marked
spent, and the inferred spender equal to the recovery transaction. On the
affected revision, representative output is:

```text
[+] loaded target adapter from <source-root>/dist
[+] RPC virtual DAA score: 1000
[+] invented recovery block DAA score: 2000
[+] exact candidate status: absent
[+] recovery candidate status: observed
[+] recovery candidate finality: accepted
[+] staging status: spent
[+] inferred spender: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
[+] vulnerable behavior reproduced: one RPC forged accepted recovery evidence
```

A fixed build should refuse to produce an accepted recovery winner from this
single view. Depending on the chosen remediation, the runner should fail an
assertion, receive partial/pending evidence, or receive an explicit
independent-verification error. See `poc/README.md` for requirements and
interpretation. There is no cleanup beyond removing any target build products
created for the test.

This harness deliberately stops at the protocol adapter boundary. It proves
the attacker-controlled finality primitive using production code, while the
subsequent classifier, journal gate, release query, and terminal fast path are
proven above from the same revision. I did not simulate two divergent Kaspa
views or spend real testnet funds.

## Remediation

The invariant to restore is straightforward: **a single RPC's claims may be
treated as provisional evidence, but must never be sufficient to record
returned principal or release a policy reservation**. Matching immutable
transaction facts establishes identity, not inclusion or finality.

As an immediate fail-closed hardening, reject a block DAA score greater than
the claimed virtual score. That closes the exact PoC but is insufficient on
its own because the same RPC controls both values. The complete fix should
require either a locally verified inclusion/finality proof or a pinned quorum
of genuinely independent observers. The verifier result and its profile must
be persisted alongside the observation before the journal can release
capacity.

One possible adapter shape is:

```ts
interface IndependentRecoveryFinalityVerifier {
  verify(input: {
    network: "kaspa:testnet-10";
    transactionId: string;
    outputOutpoint: string;
    outputAmountAtomic: string;
    outputScriptPublicKey: string;
    rpcClaim: { blockDaaScore: string; virtualDaaScore: string };
    signal: AbortSignal;
  }): Promise<null | {
    finality: "mempool" | "accepted" | "confirmed";
    profile: string;
    proofDigest: Sha256Digest;
  }>;
}

const verified = await this.finalityVerifier.verify({
  network: NETWORK,
  transactionId: expected.transactionId,
  outputOutpoint: expected.outputOutpoint,
  outputAmountAtomic: expected.outputAmountAtomic,
  outputScriptPublicKey: expected.outputScriptPublicKey,
  rpcClaim: {
    blockDaaScore: blockDaaScore.toString(),
    virtualDaaScore: virtualDaaScore.toString(),
  },
  signal,
});
if (verified === null) {
  return partialCandidate(expected, "independent-finality-missing");
}
return observedCandidate(expected, verified.finality, digest({
  source: verified.profile,
  proofDigest: verified.proofDigest,
  transactionId: expected.transactionId,
  outputOutpoint: expected.outputOutpoint,
  finality: verified.finality,
}));
```

The same rule must cover mempool, accepted, and confirmed observations; a
Merchant profile that permits mempool finality must not accidentally re-enable
single-oracle reservation release. The journal should additionally require a
pinned `finalityVerificationProfile`, verifier identity, and evidence digest
before entering `finalizeTreasuryStagingRecoveryInternal`. This gives recovery
after restart enough durable evidence to re-check the decision instead of
trusting an opaque adapter label.

Recommended regression coverage is:

- a future candidate block DAA is rejected;
- one RPC cannot produce a releasable recovery winner even with every exact
  immutable output fact;
- an old fabricated block DAA cannot manufacture `confirmed` finality;
- repeated responses from one endpoint do not count as quorum;
- disagreement between independent observers remains pending or conflict;
- verified recovery inclusion releases the reservation exactly once;
- a canonical exact winner never permits recovery accounting or capacity
  release; and
- crash/restart preserves and re-verifies the proof-backed release decision.

Until that design and its end-to-end evidence exist, failing closed and
requiring manual recovery is safer than automating a capacity release from one
RPC view.

## Summary

Sompi's abandoned-staging recovery path carefully binds transaction identity,
amount, script, leases, and journal transitions. The missing binding is the
most important one: the observation is not bound to consensus truth outside
the RPC making the claim.

We demonstrated that one fake peer can use a future block DAA score to make
the production observer emit accepted recovery evidence. We then followed
that evidence through `recovery_won`, the finality rank check, returned-
principal accounting, reservation release, terminal Purchase state, and the
no-reobservation fast path. The attacker cannot redirect funds or violate
Kaspa's one-spend rule, but a later real exact winner plus reuse of released
capacity can violate Sompi's software policy boundary.

The durable fix is to separate candidate discovery from trusted finality and
to make proof-backed or independent corroboration a required journal
precondition. Useful follow-up research is a two-view integration fixture that
drives the false-recovery view, the canonical exact-payment view, and a second
reservation attempt through a crash/restart boundary.
