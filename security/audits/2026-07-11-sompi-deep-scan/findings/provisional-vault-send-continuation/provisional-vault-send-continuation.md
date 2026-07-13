# Provisional Kaspa Evidence Can Advance Sompi's Durable Vault Continuation

## Executive Summary

Sompi's direct `vault_send` path advances its durable covenant-vault
configuration as soon as one selected Kaspa RPC returns the two expected
transaction outputs. The code records the outputs' `blockDaaScore`, but it
does not require the score to be nonzero, does not require an accepted or
confirmed finality level, and does not independently establish chain
inclusion before committing. A score of zero is treated elsewhere in the
same revision as mempool-only evidence.

This creates a state-desynchronization primitive. A selected malicious or
impersonated RPC can briefly return the exact outputs of the signed vault
transaction with `blockDaaScore=0`, or an honest RPC can expose equivalent
provisional state that later disappears. Sompi then replaces the vault's
current outpoint with the prepared continuation and marks the direct Treasury
operation complete. If the transaction was never accepted, restart preserves
an outpoint that does not exist while the original covenant output remains
live. Normal automated vault use is then unavailable until an operator
reconstructs the correct state or uses the offline owner-recovery path.

The affected code is present in Git revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a`. Repository history shows that the
vault observation primitive was introduced in `4ecccf48`, and the durable
direct-Treasury adapter reached it from `52080d12` onward. I did not identify a
fixed revision in the history available during this review.

I reviewed the exact affected revision and executed the included harness
against a clean build of that revision. The harness reproduced DAA-zero
acceptance, the durable continuation update, a later `not_submitted` verdict,
and the stale continuation surviving restart. I did not contact a live Kaspa
node or broadcast a transaction; all RPC behavior and keys were local and
disposable.

The practical severity is **Low (P3)**. The consequence is a persistent but
recoverable single-vault lockout, not arbitrary spending. The transaction,
payee output, continuation output, amounts, covenant identifier, and base
configuration remain exactly bound; policy limits and the covenant's rolling
cap still apply; and this revision supports direct execution only on Kaspa
Testnet-10. These controls materially constrain both reach and impact.

## Background

Sompi's vault is a covenant-bound singleton. Its durable `VaultConfig` records
the currently spendable covenant outpoint and rolling-window state. An Agent
send spends that outpoint into exactly two outputs: index 0 pays the requested
destination, and index 1 creates a new covenant continuation. The local
configuration must follow index 1 only after the new transaction has reached
the required chain finality; otherwise local state no longer describes the
live covenant.

The key types in `src/vault.ts:28-69` make that state transition explicit:

```typescript
export interface VaultConfig {
  // ... covenant and rolling-window fields ...
  address: string;
  covenantId?: string;
  currentOutpoint?: { txid: string; index: number };
}

export interface PreparedVaultSpend {
  transaction: string;
  transactionId: string;
  destinationOutpoint: { txid: string; index: 0 };
  continuationOutpoint: { txid: string; index: 1 };
  continuationAddress: string;
  covenantId: string;
  baseConfigDigest: string;
  configUpdate: {
    windowStartDaa: string;
    spentInWindowSompi: string;
    address: string;
    currentOutpoint: { txid: string; index: 1 };
  };
}

export interface ObservedVaultSpend {
  // ... exact transaction and output facts ...
  observedAtDaa?: bigint;
}
```

The local MCP tool is not itself a remote listener. At
`src/mcp/server.ts:385-415`, `vault_send` accepts a caller-stable operation key,
destination, and exact Testnet-10 amount, then delegates to the durable
Treasury operation module. The relevant remote boundary appears later: the
credential-bearing process submits the signed transaction to its selected
Kaspa RPC and trusts that same endpoint's UTXO response during observation.
The project threat model expressly treats RPC nodes and network timing as
untrusted and lists transaction outpoints, finality, vault state, and recovery
state as protected assets.

Finality is not merely a numeric decoration in this codebase. The sibling
recovery observer in `src/adapters/kaspa-x402/staging-recovery-rpc.ts:127-133`
classifies the same field as follows:

```typescript
const depth = virtualDaaScore >= blockDaaScore
  ? virtualDaaScore - blockDaaScore
  : 0n;
const finality: "mempool" | "accepted" | "confirmed" =
  blockDaaScore === 0n
    ? "mempool"
    : depth >= this.confirmedDaaDepth
      ? "confirmed"
      : "accepted";
```

That distinction is important. Seeing exact transaction outputs is useful
identity evidence, but a DAA-zero UTXO is not accepted-chain evidence. The
vault-send path correctly separates preparation, durable journaling,
submission, observation, and commit; the defect is that its observation state
collapses provisional visibility and accepted finality into the same
`observed` result.

## Vulnerability Details

We first reach `VaultManager.prepareSend` in `src/vault.ts:565-627`. It builds
and signs an immutable two-output transaction, verifies the destination amount,
derives the expected continuation, and binds the result to a digest of the
current vault configuration. These are strong controls: they ensure that a
later observation cannot quietly change the intended transaction.

After submission, `observePreparedSend` asks one RPC for UTXOs at the
destination and continuation addresses. It rehydrates the signed transaction
and then performs exact matching on transaction ID, output index, amount,
script, and covenant identifier. The decisive portion is
`src/vault.ts:652-700`:

```typescript
async observePreparedSend(
  wallet: KaspaWallet,
  prepared: PreparedVaultSpend
): Promise<ObservedVaultSpend | undefined> {
  assertPreparedVaultSpend(prepared);
  const transaction = requireBoundPreparedTransaction(prepared, this.networkId);
  transaction.free();
  const rpc = await wallet.client();
  const { entries } = await rpc.getUtxosByAddresses([
    prepared.destination,
    prepared.continuationAddress,
  ]);
  const normalized = normalizeEntries(entries);
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
  if (destination.length === 0 && continuation.length === 0) return undefined;
  if (destination.length !== 1 || continuation.length !== 1) {
    throw new Error(
      "prepared vault send has a partial, duplicate, or conflicting on-chain observation"
    );
  }
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
}
```

We can now see the missed invariant. Both output scores may be zero, yet the
function returns a fully formed `ObservedVaultSpend`. It also aggregates the
two values with `maxBigInt`; a zero score on only one output could therefore be
hidden by a positive value on the other rather than rejected as inconsistent.
There is no comparison with virtual DAA score, configured finality, accepted
transaction history, an independent observer, or a proof of inclusion.

`reconcilePreparedSend` immediately promotes any such result. At
`src/vault.ts:708-716`, the first branch runs before mempool or accepted-history
queries:

```typescript
const observed = await this.observePreparedSend(wallet, prepared);
if (observed) {
  return Object.freeze({
    status: "observed" as const,
    observation: observed,
  });
}
```

From here we carry both the status and the DAA score into
`VaultSendTreasuryOperationAdapter.observe`. The adapter serializes
`observedAtDaa` into the journal detail at
`src/treasury/operation-adapters.ts:258-284`, but it imposes no threshold. On
commit it parses the value back into a `bigint` and passes it onward:

```typescript
this.vault.commitObservedSend(prepared, {
  transactionId: prepared.transactionId,
  destinationOutpoint: prepared.destinationOutpoint,
  continuationOutpoint: prepared.continuationOutpoint,
  amountSompi: prepared.amountSompi,
  continuationAmountSompi: prepared.continuationAmountSompi,
  ...(typeof observedDetail.observedAtDaa === "string"
    ? { observedAtDaa: BigInt(observedDetail.observedAtDaa) }
    : {}),
});
```

The durable sink in `src/vault.ts:800-823` verifies the exact prepared facts
and rejects a stale base configuration. It never reads `observedAtDaa`:

```typescript
commitObservedSend(
  prepared: PreparedVaultSpend,
  observed: ObservedVaultSpend
): VaultConfig {
  assertPreparedVaultSpend(prepared);
  if (
    observed.transactionId !== prepared.transactionId ||
    observed.destinationOutpoint.txid !== prepared.destinationOutpoint.txid ||
    observed.destinationOutpoint.index !== 0 ||
    observed.continuationOutpoint.txid !== prepared.continuationOutpoint.txid ||
    observed.continuationOutpoint.index !== 1 ||
    observed.amountSompi !== prepared.amountSompi ||
    observed.continuationAmountSompi !== prepared.continuationAmountSompi
  ) {
    throw new Error(
      "vault observation does not match the exact prepared staging transaction"
    );
  }
  const current = this.config();
  const updated: VaultConfig = { ...current, ...prepared.configUpdate };
  if (vaultConfigMatchesUpdate(current, prepared.configUpdate)) return current;
  if (vaultConfigDigest(current) !== prepared.baseConfigDigest) {
    throw new Error("vault state advanced after this staging transaction was prepared");
  }
  this.saveConfig(updated);
  return updated;
}
```

Finally, the Treasury driver at `src/treasury/operations.ts:154-171` commits
every record whose state is `observed` and then calls
`completeTreasuryOperation`. No later observation can naturally retract that
terminal state.

The failure is easiest to follow as a state transition:

| Stage | Chain or RPC fact | Durable local fact |
|---|---|---|
| Before send | Original covenant outpoint is live | `currentOutpoint = original` |
| Provisional response | Both exact outputs are reported with DAA 0 | Operation becomes `observed` |
| Commit | No accepted-finality check runs | `currentOutpoint = txid:1`; operation is complete |
| Response disappears | Original input is still unspent; outputs are absent | Reconciliation can say `not_submitted` |
| Restart | No continuation exists on chain | Persisted `currentOutpoint = txid:1` is reloaded |

The checks are therefore internally consistent but answer the wrong security
question. They prove that the RPC described the locally signed transaction;
they do not prove that consensus accepted it before protected state advanced.

## Exploitability Analysis

The strongest route starts with a selected malicious Kaspa RPC. A legitimate
or policy-admissible Agent invokes `vault_send`, Sompi prepares the exact signed
transaction, and the RPC receives that transaction through
`submitTransaction`. The node therefore learns every value it needs to satisfy
the observer: transaction ID, both output scripts, both amounts, indexes, and
the continuation covenant identifier. It does not need to forge a signature or
guess a private value.

The RPC can acknowledge submission without relaying the transaction and return
the two expected UTXO records with score zero. Once Sompi commits, the RPC can
remove those records and again show the original source outpoint. This is a
reliable response-level primitive for a node that has been selected or
successfully impersonated because all required response values came from the
transaction Sompi just supplied. The node may otherwise appear synchronized;
transaction-specific fabrication does not require an obviously stale chain
head.

An honest-node route is narrower but still illustrates why the finality gate
belongs here. If the UTXO API exposes both outputs while the transaction is
only in the mempool, their score is zero. A conflicting spend, eviction, or
other failure to reach accepted chain state can then remove them. I did not
measure the frequency of this behavior on a live Testnet-10 node, so this route
should be understood as a protocol-state possibility rather than a quantified
operational rate. The controlled RPC route does not depend on that uncertainty.

Several tempting escalation paths fail, and those failures correctly bound the
finding:

- We cannot substitute a different payee, amount, or transaction. The observer
  compares the returned output against the locally prepared transaction and
  recomputes the address script.
- We cannot choose an arbitrary continuation. Its transaction ID, fixed index,
  amount, address script, and covenant ID are bound before submission.
- Returning only one output is not useful. The observer throws on partial,
  duplicate, or conflicting output sets instead of committing.
- We cannot replay a prepared transition after another valid vault transition.
  `baseConfigDigest` makes that stale commit fail closed.
- We cannot bypass the configured policy or consensus rolling cap through this
  primitive. A real signed send must first be prepared within those limits.
- We do not gain the wallet key, vault Agent key, or offline owner key, and no
  arbitrary signed bytes are produced.

The resulting capability is consequently availability and durable-integrity
damage, not theft. The service believes the nonexistent continuation is the
current vault. Subsequent automated operations cannot spend the real original
covenant through the normal path, and human recovery is required. The owner
path and operator reconstruction bound permanence, but they do not make the
state transition harmless: the remote observation crossed into a protected
local configuration and survived process restart.

Reach is also constrained. The attacker must control or impersonate the RPC
actually selected by this Sompi process, or rely on a genuine provisional
disappearance. A random Internet host cannot call an inbound node endpoint;
the Agent interface is local stdio. The vault must already be funded, and the
requested exact send must pass policy and covenant checks. The affected
revision is explicitly Testnet-10-only, so this report makes no mainnet impact
claim. These constraints support the Low/P3 rating even though the reproduced
bad state is durable.

Finally, simply rejecting zero is necessary but not a complete trust-boundary
answer. A malicious single RPC can self-report a positive DAA score as easily
as zero. Robust remediation should therefore combine a provisional-state
guard with an accepted-finality verdict whose provenance is stronger than the
same endpoint's uncorroborated UTXO record.

## Proof of Concept

The `poc` directory contains a standalone harness and preparation scripts. It
imports the production `VaultManager`, `KaspaWallet`, transaction bindings, and
covenant template from the affected revision. The synthetic RPC accepts the
real prepared transaction, returns both exact outputs at `blockDaaScore=0`, and
then makes them disappear while preserving the original source outpoint.

The harness calls the same production observe and commit methods used by the
Treasury adapter. It deliberately isolates the vulnerable control and durable
sink rather than constructing an MCP session or contacting a network. The
adapter and terminal driver continuation described above was verified from the
exact source, not dynamically traversed by this harness.

From the report directory, prepare and run the target with relative commands:

```sh
cd poc
sh prepare-target.sh
sh run.sh
```

Preparation clones the public source, checks out the exact affected revision,
installs from the lockfile, and builds it under `poc/target`. The reproduction
itself creates a disposable temporary runtime, generated test keys, and no real
funds. It does not broadcast a transaction. The successful run I performed
produced:

```text
[+] both exact outputs accepted at blockDaaScore=0
[+] committed continuation: a980b664afb844bc0574f5d9a251830792ed4de141cb3bf0172f31a7ddb56b89:1
[+] evidence after outputs disappeared: not_submitted
[+] restart retained vanished continuation: a980b664afb844bc0574f5d9a251830792ed4de141cb3bf0172f31a7ddb56b89:1
[+] exact transaction and covenant bindings remained intact
[+] vulnerability reproduced
```

Transaction IDs vary because each run creates fresh disposable vault keys. The
assertions require all of the following before the success line is printed:

1. both exact prepared outputs are accepted with observed DAA score zero;
2. commit replaces the original outpoint with prepared index 1;
3. after the outputs disappear, reconciliation returns `not_submitted`;
4. a fresh `VaultManager` still reads the vanished continuation; and
5. transaction, output, amount, and covenant bindings remain exact.

The temporary runtime is removed automatically. Setting
`KEEP_POC_RUNTIME=1` retains it for inspection; it contains disposable private
keys and should be deleted afterward. Removing `poc/target` cleans up the cloned
source and installed dependencies. `poc/README.md` contains the same procedure
and a way to point the harness at an existing clean build.

## Remediation

The invariant to restore is straightforward: **durable vault configuration
must advance only when both exact outputs have reached the explicitly required
chain finality**. Provisional visibility may move an operation into a pending
observation state, but it must not produce `ObservedVaultSpend`, call
`commitObservedSend`, or complete the Treasury operation.

As an immediate fail-closed patch, reject zero and inconsistent output scores
before creating the observation, and repeat the check at the durable sink. A
minimal defensive shape in `observePreparedSend` is:

```typescript
const destinationDaa = destination[0].blockDaaScore;
const continuationDaa = continuation[0].blockDaaScore;
if (
  destinationDaa === 0n ||
  continuationDaa === 0n ||
  destinationDaa !== continuationDaa
) {
  return undefined; // remain pending; do not create a committable observation
}

return Object.freeze({
  transactionId: prepared.transactionId,
  destinationOutpoint: prepared.destinationOutpoint,
  continuationOutpoint: prepared.continuationOutpoint,
  amountSompi: prepared.amountSompi,
  continuationAmountSompi: prepared.continuationAmountSompi,
  observedAtDaa: destinationDaa,
});
```

The sink should independently reject missing or provisional evidence so a
future caller cannot bypass the observer:

```typescript
if (observed.observedAtDaa === undefined || observed.observedAtDaa <= 0n) {
  throw new Error("vault continuation requires accepted-chain evidence");
}
```

That closes the demonstrated DAA-zero path, but we should not stop there. A
positive score supplied by the same RPC is still self-attestation. The stronger
design is to model observation states explicitly—`mempool`, `accepted`, and
`confirmed`—and bind an immutable required finality into the prepared Treasury
operation. Before returning `observed`, a finality component should verify the
transaction's accepted history or required DAA depth using independently
trustworthy evidence, such as a configured corroborating observer or a
verifiable chain proof. The direct adapter must compare the verdict with the
prepared requirement, persist the evidence and its source, and leave the
operation `submitted` or `pending` until the requirement is met.

We should also make terminal completion conditional on that typed verdict,
rather than treating the generic string `observed` as sufficient for every
adapter. This keeps the security decision in the Purchase/Treasury orchestration
layer while allowing the Kaspa-specific observer to provide protocol evidence.
It also prevents a later adapter refactor from carrying a DAA field through the
journal without enforcing it, as happens in the affected revision.

Regression coverage should include at least:

- two exact outputs at DAA zero remain pending and do not change vault config;
- one zero and one positive score is rejected as an inconsistent observation;
- positive but insufficient depth remains pending;
- disappearing provisional outputs followed by restart preserve the original
  current outpoint and an unresolved operation;
- accepted evidence at the configured minimum commits exactly once;
- a fabricated positive score from only the selected RPC cannot satisfy an
  independent-finality policy; and
- the existing exact-output, stale-base, policy, covenant-cap, retry, and crash
  tests continue to pass.

These tests should traverse the full `vault_send` adapter and Treasury driver,
not only `VaultManager`, so the durable state and terminal-operation assertions
remain coupled to the finality invariant.

## Summary

Sompi revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a` carefully binds a direct vault
send to immutable transaction, output, covenant, policy, and base-state facts,
but it does not bind the resulting durable transition to accepted finality.
The selected RPC can return both exact outputs with DAA score zero; the observer
calls that state `observed`, the adapter carries the unused score forward, and
the commit path persists the continuation and completes the operation.

We reproduced the full vulnerable vault primitive locally: exact DAA-zero
outputs were accepted, the continuation replaced the original outpoint, later
evidence said the transaction had not been submitted, and restart still loaded
the vanished continuation. Exact binding prevented substitution, and no key or
fund theft was demonstrated. The practical outcome is a recoverable
single-vault lockout within the current Testnet-10 profile, which is why the
finding is Low/P3 rather than a higher-severity spend primitive.

The immediate correction is to make provisional observations non-committable.
The durable correction is to give direct Treasury operations an explicit,
typed finality requirement and satisfy it with evidence stronger than one
endpoint's self-report before changing protected vault state. Variant review
should focus on every transition that promotes current node visibility into a
durable outpoint, terminal workflow state, or released capacity.
