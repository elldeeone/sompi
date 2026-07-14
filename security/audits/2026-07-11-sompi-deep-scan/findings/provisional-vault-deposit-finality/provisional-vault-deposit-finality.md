# Provisional single-RPC evidence can persist a nonexistent vault deposit

## Executive Summary

Sompi package version 0.8.0 at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` can treat a provisional vault
deposit reported by one Kaspa RPC as a completed Treasury Movement. The vault
observer performs strong equality checks on the locally signed transaction,
output index, amount, covenant identity, and script. It nevertheless accepts
the matching output at `blockDaaScore=0` and carries that value into an
`observedAtDaa` field that no later component enforces.

The direct-Treasury adapter then writes the prepared covenant and current
outpoint into `vault/config.json`, and the Treasury operation becomes
terminal. If the reported output subsequently disappears—or never existed in
canonical history—the process continues to load the nonexistent outpoint after
restart. Automated use of the configured vault is then unavailable until the
operator reconstructs or repairs its state.

I reviewed the affected revision directly and ran the included local harness
against its compiled production modules. It accepted a DAA-zero output,
completed the Treasury operation, later classified the same prepared deposit
as `not_submitted`, and retained both the terminal operation and nonexistent
outpoint across restart. I did not contact a live Kaspa node, broadcast a
transaction, or test with real Testnet-10 funds. No fixed revision was
available for comparison.

The finding is low severity, priority P3. A selected malicious or impersonated
RPC can corrupt one configured vault's durable continuation state, but it
cannot replace the signed transaction, redirect the deposit, choose another
covenant, or make a later spend of an output that does not exist. Human and
operator policy, owner recovery, the local stdio MCP boundary, and the current
Testnet-10-only profile further constrain the impact.

## Background

Sompi separates Purchase Authorization from direct Treasury Movement. The
`vault_deposit` MCP tool is a local stdio operation that covenant-funds or tops
up the configured consensus vault. An untrusted Agent can request this normal
workflow, but it does not receive the wallet or vault keys and it cannot choose
arbitrary persisted vault state.

The tool binds its destination to the current vault address before handing the
request to the deep Treasury module:

```ts
// src/mcp/server.ts:363-369
const result = await requireTreasuryOperations(treasuryOperations).execute({
  operationKey,
  kind: "vault_deposit",
  destination: vault.config().address,
  amountAtomic: amount,
  ...(keepFloat === undefined ? {} : { keepFloatAtomic: keepFloat }),
});
```

The Treasury module durably records intent and prepared bytes before asking
the vault adapter to submit the exact signed transaction. This ordering is
useful: a crash cannot silently discard the identity of an ambiguous external
effect. After submission, the adapter reconciles the prepared transaction and
the journal records either `pending`, `not_submitted`, or `observed`.

The final local transition is security-sensitive. A successful initial deposit
adds `covenantId` and `currentOutpoint` to the vault configuration. A top-up can
also rotate the continuation address and rolling-window state. Those values
are the source of truth for later vault sends, so the normal invariant should
be: Sompi advances them only after the exact prepared deposit has reached the
configured accepted finality.

Kaspa RPC responses do not satisfy that invariant by themselves. The selected
node controls UTXO presence, reported DAA scores, mempool answers, and accepted
history. In the default deployment shape this may be a public-resolver node;
an operator can also configure a private node. In both cases, an RPC fact must
remain untrusted data until Sompi has enough evidence to promote it into
durable vault state.

## Vulnerability Details

We first reach `VaultManager.observePreparedDeposit`. It deserializes and
revalidates the locally prepared transaction, then asks the selected RPC for
current outputs at the prepared vault address. The equality controls are
substantial, but the only treatment of the node's DAA value is to copy it:

```ts
// src/vault.ts:450-473
const { entries } = await rpc.getUtxosByAddresses([prepared.vaultAddress]);
const matches = normalizeEntries(entries).filter((entry) =>
  entry.txid === prepared.transactionId &&
  entry.index === 0 &&
  entry.amount === prepared.vaultAmountSompi &&
  entry.covenantId === prepared.covenantId &&
  scriptPublicKeyMatchesAddress(entry.scriptPublicKey, prepared.vaultAddress, this.networkId)
);
if (matches.length > 1) throw new Error("prepared vault deposit has duplicate on-chain output");
if (matches.length === 0) return undefined;
return Object.freeze({
  transactionId: prepared.transactionId,
  vaultOutpoint: prepared.vaultOutpoint,
  vaultAmountSompi: prepared.vaultAmountSompi,
  covenantId: prepared.covenantId,
  observedAtDaa: matches[0].blockDaaScore,
});
```

There is no lower bound, depth calculation, accepted-history requirement, or
independent observation in this branch. A matching record at DAA zero is
therefore `observed`. This branch runs before the historical-acceptance and
intact-source checks in `reconcilePreparedDeposit`, so current UTXO presence
short-circuits the stronger reconciliation questions.

The adapter faithfully stores `observedAtDaa` in the observed detail. When it
later commits, however, it reconstructs the observation and forwards the DAA
as optional metadata rather than a condition:

```ts
// src/treasury/operation-adapters.ts:390-406
async commit(
  intent: TreasuryOperationRecord,
  preparedBytes: Uint8Array,
  observedDetail: Readonly<Record<string, unknown>>
): Promise<void> {
  const envelope = decodeVaultDeposit(preparedBytes, intent);
  requireObservedDetail(observedDetail, intent, envelope.prepared.transactionId);
  const prepared = vaultPreparedDeposit(envelope);
  this.vault.commitObservedDeposit(prepared, {
    transactionId: prepared.transactionId,
    vaultOutpoint: prepared.vaultOutpoint,
    vaultAmountSompi: prepared.vaultAmountSompi,
    covenantId: prepared.covenantId,
    ...(typeof observedDetail.observedAtDaa === "string"
      ? { observedAtDaa: BigInt(observedDetail.observedAtDaa) }
      : {}),
  });
}
```

We can now carry the DAA-zero observation into the durable sink. The vault
again checks every immutable deposit field and the prepared base-config digest,
but never reads `observed.observedAtDaa`. It atomically saves the prepared
configuration update:

```ts
// src/vault.ts:534-556
commitObservedDeposit(prepared: PreparedVaultDeposit, observed: ObservedVaultDeposit): VaultConfig {
  const transaction = requireBoundPreparedDeposit(prepared, this.networkId);
  transaction.free();
  if (
    observed.transactionId !== prepared.transactionId ||
    observed.vaultOutpoint.txid !== prepared.transactionId ||
    observed.vaultOutpoint.index !== 0 ||
    observed.vaultAmountSompi !== prepared.vaultAmountSompi ||
    observed.covenantId !== prepared.covenantId
  ) {
    throw new Error("vault deposit observation does not match exact prepared transaction");
  }
  const current = this.config();
  const updated: VaultConfig = { ...current, ...prepared.configUpdate };
  if (vaultConfigMatchesDepositUpdate(current, prepared.configUpdate)) return current;
  if (vaultConfigDigest(current) !== prepared.baseConfigDigest) {
    throw new Error("vault state advanced after this deposit was prepared");
  }
  this.saveConfig(updated);
  return updated;
}
```

Finally, the Treasury module marks the operation complete immediately after
that local commit:

```ts
// src/treasury/operations.ts:203-210
if (record.state === "observed") {
  await adapter.commit(
    record,
    bytes,
    this.journal.readObservedTreasuryOperationDetail(operationKey)
  );
  record = this.journal.completeTreasuryOperation(operationKey);
}
```

This ordering creates an asymmetric state. If the output disappears, a direct
call to the same production adapter can use empty UTXO and accepted-history
views plus the intact source input to return `not_submitted`. The already
completed operation does not take that path during recovery: terminal records
return immediately, while `VaultManager.config()` continues to load the saved
covenant and current outpoint from disk.

The exact checks are important counterevidence, not a fix for the finality
error. The node must report the output of Sompi's own signed transaction with
the exact amount, covenant, address script, and index. It cannot substitute an
attacker-selected transaction or rewrite a configuration prepared against a
different base digest. What it controls is whether that exact output appears
to exist and how mature it appears when Sompi crosses the durable commit edge.

## Exploitability Analysis

The strongest practical route is a malicious selected RPC during a legitimate
deposit. We need an already configured vault, spendable wallet funds, and a
policy-admissible deposit request. Sompi prepares and signs the exact
transaction and sends it to the selected node, so that node naturally learns
all values needed to construct a matching UTXO response. It may decline to
broadcast the transaction while returning its output with DAA zero. Because
the response matches the signed bytes, we pass every immutable binding and
reach the vulnerable finality transition without knowing a private key.

From there we can make the effect persistent in five steps:

1. Return the exact covenant output from `getUtxosByAddresses` once.
2. Let the adapter record `observedAtDaa: "0"` and commit the prepared config.
3. Let the Treasury module mark the operation `completed`.
4. Remove the output and report no accepted history or mempool entry while
   exposing the original source outpoint as intact.
5. Restart Sompi; the completed journal record and nonexistent vault outpoint
   are both still authoritative locally.

A transient network event supplies a second route without a deliberately
malicious node. If a provisional output becomes visible and later disappears,
the same unchecked transition commits it too. The practical frequency of that
condition depends on node and network behavior, but the implementation has no
depth threshold that would narrow the window.

Merely requiring a positive `blockDaaScore` would remove the demonstrated
zero-value case but would not close the trust boundary. The same RPC controls
both the output record and its score. Even comparing that score with the
node's self-reported virtual DAA leaves one actor asserting every fact. A
strong fix needs accepted-history evidence tied to the exact transaction and a
trust model that does not let the submitting RPC unilaterally manufacture the
commit predicate.

Several stronger outcomes are blocked:

- The Agent-facing MCP transport is local stdio, not an unauthenticated remote
  listener. An arbitrary internet client cannot invoke `vault_deposit`
  directly.
- Human/operator provisioning determines the vault owner and cap, and normal
  policy and capacity checks still apply before signing.
- The node cannot change the transaction, covenant, output script, amount,
  index, or base vault configuration. Arbitrary recipient substitution and key
  extraction are not available through this primitive.
- A later transaction that spends the nonexistent current outpoint cannot be
  accepted by Kaspa consensus. The bad state therefore creates lockout and
  recovery work rather than a fabricated spend.
- The offline owner recovery path and operator reconstruction can restore a
  usable vault. The duration and operational cost depend on retained evidence
  and key availability, but the demonstrated corruption is recoverable.
- The supported profile is Kaspa Testnet-10. I found no evidence supporting a
  mainnet impact claim.

These constraints keep the result at low/P3. The meaningful security effect is
still cross-boundary: an external node response becomes protected local vault
state in the key-bearing process and survives restart.

## Proof of Concept

The `poc/` directory contains a polished local harness:

- `reproduce.mjs` verifies hashes of the decisive source files, imports the
  compiled production modules, and drives a real direct Treasury deposit;
- `README.md` gives exact build, run, safety, and cleanup instructions; and
- `representative-output.txt` records a successful run.

Starting from the report directory, place a built checkout at `target/` and
run:

```sh
git clone https://github.com/elldeeone/sompi.git target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
cd poc
node reproduce.mjs ../target
```

The fake RPC returns the signed transaction's actual covenant output with DAA
zero. After the production operation completes, the harness removes that
output, invokes the production adapter again to obtain `not_submitted`, reopens
SQLite, reconstructs `VaultManager`, and calls Treasury recovery. The assertions
require the operation to remain complete and the same nonexistent outpoint to
remain configured.

I ran the harness successfully against the compiled affected revision. Its
representative output was:

```text
{"affectedRevisionMatched":true,"acceptedProvisionalDaa":"0","operationStateBeforeEviction":"completed","chainEvidenceAfterEviction":"not_submitted","operationStateAfterRestart":"completed","persistedNonexistentOutpoint":true,"vaultOutputQueries":2,"mempoolQueries":1,"acceptedChainQueries":1,"independentAcceptedChainEvidence":false}
```

The program uses a disposable Testnet-10 wallet and local signing code, but its
RPC is an in-process object. It opens no network connection and broadcasts no
transaction. Temporary keys, the vault config, and SQLite journal are removed
even if an assertion fails. The PoC proves the finality and durable-state
transition; it does not demonstrate theft, a live-node compromise, or a
mainnet attack.

## Remediation

The invariant to restore is straightforward: a current UTXO returned by the
submitting RPC is provisional evidence, never authority to advance vault
configuration. `commitObservedDeposit` should accept only a durable finality
record bound to the exact prepared transaction, outpoint, amount, covenant,
network, and configured minimum. The journal should preserve that record
before the config mutation, and restart recovery should revalidate any
nonterminal observation rather than promoting it automatically.

A useful source shape is to make accepted finality mandatory in the type and
to enforce it again at the sink:

```ts
interface AcceptedVaultDepositEvidence {
  readonly transactionId: string;
  readonly vaultOutpoint: { readonly txid: string; readonly index: 0 };
  readonly finality: "accepted" | "confirmed";
  readonly acceptingBlockHash: string;
  readonly acceptingBlockDaaScore: bigint;
  readonly observerSetDigest: string;
}

async function observeForCommit(
  prepared: PreparedVaultDeposit
): Promise<AcceptedVaultDepositEvidence | undefined> {
  const candidate = await vault.observePreparedDeposit(wallet, prepared);
  if (!candidate) return undefined;
  return finalitySource.requireExactAcceptedDeposit(prepared, candidate);
}

function commitObservedDeposit(
  prepared: PreparedVaultDeposit,
  evidence: AcceptedVaultDepositEvidence
): VaultConfig {
  requireExactDepositEvidence(prepared, evidence);
  if (evidence.finality !== "accepted" && evidence.finality !== "confirmed") {
    throw new Error("vault deposit has not reached accepted finality");
  }
  return saveExactPreparedConfigUpdate(prepared);
}
```

`finalitySource` should not be another name for the same selected node's
current UTXO response. Depending on the deployment model, it can require an
authenticated operator-trusted node, independently configured observers with
agreement, or verifiable accepted-chain evidence anchored to a durable start
point. A depth check against a single node is useful defense in depth for
transient outputs but is insufficient against that node lying consistently.

We should also preserve the existing exact transaction, script, amount,
covenant, and base-config checks. They are the reason this issue is a bounded
state-integrity problem instead of arbitrary vault replacement. The finality
record should be included in the observed-detail digest, and the commit method
should reject missing, unknown, downgraded, or differently bound evidence even
if a caller reaches it outside the normal adapter path.

Regression coverage should exercise both initial deposits and top-ups:

- expose the exact output at DAA zero and require the operation to stay
  nonterminal;
- remove the provisional output, restore all source inputs, restart, and
  require the old vault configuration to remain intact;
- have one observer lie about both UTXO presence and DAA while an independent
  observer reports no accepted transaction;
- accept the exact transaction through the configured finality source and
  verify one idempotent config commit;
- reject mismatched transaction, outpoint, amount, covenant, script, network,
  accepting block, and evidence digest; and
- verify that a completed record cannot coexist with a later
  `not_submitted` result for the same prepared deposit.

## Summary

Sompi correctly binds a vault deposit to locally signed bytes and records the
operation before its blockchain side effect. The remaining gap is the
promotion rule: one selected RPC can present that exact output at provisional
DAA, and `observedAtDaa` passes through the adapter without controlling the
commit. The vault configuration is saved and the Treasury operation becomes
terminal even though later reconciliation can prove the transaction was not
submitted.

The included PoC exercised the production VaultManager, adapter, journal,
policy engine, and Treasury module and reproduced the split state across
restart. Exact bindings, consensus rejection of nonexistent inputs, owner
recovery, local stdio, human/operator controls, and Testnet-10 scope prevent a
stronger theft claim. We should retain those controls and add independently
trustworthy, durably bound accepted-finality evidence before any deposit or
top-up advances the vault's covenant and current outpoint.
