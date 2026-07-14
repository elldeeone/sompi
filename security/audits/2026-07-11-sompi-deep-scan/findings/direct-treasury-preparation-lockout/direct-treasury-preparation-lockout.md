# Direct Treasury preparation failure permanently locks all direct movements

## Executive Summary

Sompi's Agent-facing direct Treasury path records an operation as durable
`intent` before the production wallet adapter fully validates and prepares the
transaction. If preparation then fails deterministically, the exception leaves
that intent unresolved. A partial unique index permits only one unresolved
direct Treasury operation, and the state machine offers no supported way to
terminalize an intent that can never prepare. One untrusted Agent request can
therefore deny every later wallet send, vault send, and vault deposit on that
Sompi service across process restarts. The failed request also retains its
amount and fee ceiling in shared policy-capacity accounting.

The reachable surface is the normal local stdio MCP session, not a network
listener; the network attack vector is therefore **none** and the access scope
is internal-only. The attacker needs the intended Agent role, a fresh operation
key, and an amount permitted by operator policy; no filesystem, wallet-key,
authority-key, or administrative access is required. The demonstrated request
uses `kaspatest:a`, which satisfies the registered lexical field schema but is
rejected by the pinned Kaspa SDK. The failure occurs before transaction
submission, so the demonstrated impact is persistent availability and
accounting denial rather than theft or unauthorized payment.

This report rates the issue **Medium (P2)**. Package version `0.8.0` at revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` is affected. I reviewed that exact
revision, executed the supplied local PoC against an immutable build of it, and
reran the nine focused direct-Treasury tests. The PoC reproduced the lock across
a journal restart with zero submission calls; it used a deterministic mocked
RPC and did not contact Testnet-10. I did not identify or test a fixed revision.

## Background

Sompi separates the fully untrusted Agent from the credential-bearing MCP
process. The Agent may select registered tools and supply their structured
arguments, while the process owns the wallet, policy engine, and durable
journal. Production startup connects that tool server to a stdio transport:

```ts
// src/index.ts
const treasuryOperations = new TreasuryOperationModule({
  journal: runtime.journal,
  policy: runtime.policy,
  adapters: [
    new WalletTreasuryOperationAdapter(runtime.wallet),
    new VaultSendTreasuryOperationAdapter(runtime.vault, runtime.wallet),
    new VaultDepositTreasuryOperationAdapter(runtime.vault, runtime.wallet),
  ],
  feeCeilingAtomic: config.treasuryOperationFeeCeilingAtomic,
});
const server = createSompiMcpServer(runtime, packageVersion(), treasuryOperations);
const transport = new StdioServerTransport();
await server.connect(transport);
```

There is consequently no TCP or HTTP vector here. The important boundary is
still real: the untrusted Agent can ask a more privileged local process to
perform direct Treasury movements. `send_payment` deliberately exposes that
capability after applying a Zod field schema and operator policy:

```ts
// src/mcp/server.ts
const ADDRESS = z
  .string()
  .min(11)
  .max(256)
  .regex(/^kaspatest:[a-z0-9]+$/, "must be a testnet-10 Kaspa address");

register(
  "send_payment",
  {
    description: "Durably send testnet KAS from Sompi's wallet under the operator policy. Reuse operationKey for every retry.",
    inputSchema: {
      operationKey: TREASURY_OPERATION_KEY.describe("Caller-stable idempotency key"),
      to: ADDRESS.describe("Destination testnet-10 Kaspa address"),
      amountSompi: POSITIVE_ATOMIC.optional(),
      amountKas: POSITIVE_KAS.optional(),
    },
  },
  "WALLET_SEND_FAILED",
  async ({ operationKey, to, amountSompi, amountKas }) => {
    const amount = exactAmount(amountSompi, amountKas);
    const result = await requireTreasuryOperations(treasuryOperations).execute({
      operationKey,
      kind: "wallet_send",
      destination: to,
      amountAtomic: amount.toString(),
    });
    return publicTreasuryOperation(result);
  }
);
```

Direct operations use a deliberately durable workflow. Sompi must record
intent and reserve policy capacity before signing, submission, or another
irreversible effect. The normal state progression is:

```text
intent -> prepared -> submission_planned -> submitted -> observed -> completed
```

Serialization is also intentional. A partial unique index allows one operation
outside `completed` or `failed_terminal`, preventing concurrent direct
movements from racing the wallet or vault. Those protections are sound only if
every pre-submission intent can either make progress or reach a safe terminal
state.

## Vulnerability Details

We first reach a validation mismatch at the MCP boundary. `kaspatest:a` is 11
characters long, has the required prefix, and contains only allowed characters,
so `ADDRESS` accepts it. The direct module repeats the same lexical test in
`normalizeRequest`; neither layer asks the pinned Kaspa SDK whether the address
payload and checksum are valid.

The module then claims durable intent before invoking its adapter:

```ts
// src/treasury/operations.ts
async execute(request: Readonly<TreasuryOperationRequest>) {
  const normalized = normalizeRequest(request);
  const policy = this.installCurrentPolicy();
  const record = this.journal.claimTreasuryOperationIntent({
    ...normalized,
    requestDigest: requestDigest(normalized),
    requestedAmountAtomic: normalized.amountAtomic,
    feeCeilingAtomic: this.feeCeilingAtomic,
    policyDigest: policy.digest,
  });
  return this.drive(record.operationKey);
}

private async drive(operationKey: string) {
  let record = this.journal.requireTreasuryOperation(operationKey);
  const adapter = this.requireAdapter(record.kind);

  if (record.state === "intent") {
    const prepared = await adapter.prepare(record, (destination, amount) => {
      this.authorize(operationKey, destination, amount);
    });
    record = this.journal.recordPreparedTreasuryOperation(operationKey, {
      ...prepared,
      policyDigest: record.policyDigest,
    });
  }
  // ...submission and recovery continue only after state=prepared...
}
```

`claimTreasuryOperationIntent` inserts the row as `intent` within an immediate
SQLite transaction. The call first checks the current policy capacity, then
persists the immutable destination, requested amount, fee ceiling, and policy
snapshot:

```ts
// src/purchase/journal.ts
this.assertDirectTreasuryCapacity(
  policy,
  input.kind,
  input.destination,
  resolved ?? "0",
  input.feeCeilingAtomic,
  now
);
this.db.prepare(
  `INSERT INTO treasury_operations (
     operation_key, request_digest, kind, destination,
     requested_amount_atomic, keep_float_atomic, fee_ceiling_atomic,
     resolved_amount_atomic, policy_digest,
     state, retry_count, created_at_ms, updated_at_ms
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', 0, ?, ?)`
).run(/* immutable request fields */);
```

We can now carry that durable row into the wallet adapter. The adapter checks
policy again, obtains a chain-start observation, and calls the real wallet
preparer. `KaspaWallet.prepareSend` eventually supplies the destination to the
pinned SDK's `createTransactions` function:

```ts
// src/treasury/operation-adapters.ts
const amount = BigInt(intent.requestedAmountAtomic);
authorize(intent.destination, amount);
const observationStartHash = await chainStartHash(this.wallet);
const prepared = await this.wallet.prepareSend(
  intent.destination,
  amount,
  BigInt(intent.feeCeilingAtomic)
);

// src/wallet.ts
const { transactions, summary } = await createTransactions({
  entries,
  outputs: [{ address: destination, amount: amountSompi }],
  changeAddress: this.address,
  feeRate: feerate,
  priorityFee: 0n,
  networkId: this.networkId,
});
```

For `kaspatest:a`, the SDK throws `The address payload is invalid`. That
exception escapes `adapter.prepare` and `drive`; there is no catch that records
a safe terminal failure. The transaction is never prepared or submitted, but
the earlier SQLite transaction has already committed.

Two journal rules turn this orphaned row into a persistent global lock. First,
all three direct operation kinds share a single unresolved slot:

```sql
-- src/purchase/journal-schema.ts
CREATE UNIQUE INDEX one_unresolved_treasury_operation
  ON treasury_operations ((1))
  WHERE state NOT IN ('completed', 'failed_terminal');
```

Second, policy-capacity accounting includes `intent` rows and charges the
requested amount plus the full fee ceiling. In our reproduction, a request for
100 units with a fee ceiling of 10 retains 110 units after the error and after
restart.

Although `failed_terminal` appears in the database enum, the public journal
interface has no direct-operation failure method. The integrity state machine
also allows `intent` to move only to `prepared`:

```ts
// src/purchase/journal.ts
function directTreasuryTransitionAllowed(from, to): boolean {
  return (
    (from === "intent" && to === "prepared") ||
    (from === "prepared" && to === "submission_planned") ||
    (from === "submission_planned" &&
      (to === "prepared" || to === "submitted" || to === "observed")) ||
    (from === "submitted" && (to === "prepared" || to === "observed")) ||
    (from === "observed" && to === "completed")
  );
}
```

We therefore have a complete path from Agent-controlled MCP fields to the bad
state:

```text
stdio Agent request
  -> lexical destination schema accepts kaspatest:a
  -> claimTreasuryOperationIntent commits state=intent and capacity=110
  -> WalletTreasuryOperationAdapter.prepare
  -> pinned SDK rejects immutable destination
  -> exception returns a generic MCP error
  -> unresolved unique index and capacity survive restart
```

Retrying the same key repeats the SDK error because the destination is immutable.
A different key fails at the unique index before it can prepare. Recovery also
calls `drive` on the same `intent`, so it simply repeats the deterministic
failure.

## Exploitability Analysis

The strongest route is a single ordinary `send_payment` call from an Agent that
already has the stdio MCP session the product intends to grant it. We choose a
fresh operation key, an amount below the per-transaction and hourly policy
limits, and `kaspatest:a` as the destination. An empty operator allowlist permits
any lexical address; if an allowlist is configured, the value must also appear
there. A funded wallet lets execution reach SDK transaction construction, where
the immutable bad address is rejected.

This route is reliable because it does not depend on concurrency, timing, node
malice, or a crash. Once SQLite commits `intent`, the preparation result cannot
roll it back. Restarting only reopens the same row. The unique index is
repository-wide for direct operations rather than per kind, so the primitive
blocks `wallet_send`, `vault_send`, and `vault_deposit` together. It affects one
Sompi service; it does not establish public-network reach or a multi-host
denial.

The capacity effect is secondary but meaningful. The stale row participates in
the same rolling capacity calculation used by Purchase reservations and other
direct operations. The amount and fee ceiling remain charged even though no
transaction exists. Depending on the operator's configured limit and other
reservations, that stale charge can also reduce or exhaust capacity available
to Purchases. We should not overstate this as a guaranteed Purchase-wide lock:
the PoC retains 110 of a 1,000-unit limit, while the direct lane is completely
blocked by uniqueness regardless of remaining capacity.

Several apparent escape routes do not resolve the primitive:

- Reusing the original operation key preserves idempotency but also preserves
  the invalid destination, so preparation fails identically.
- Choosing a new key cannot replace the old intent because the partial unique
  index rejects the insert.
- Restarting the process is ineffective because both the row and policy
  reservation are durable.
- Policy and amount errors that occur before `claimTreasuryOperationIntent` are
  safe; they create no row. They do not help after this intent exists.
- Editing SQLite manually could remove or rewrite the row, but that is not a
  supported recovery path and bypasses the journal's transition and integrity
  model.

Other permanent preparation errors may reach the same missing state transition,
including immutable transaction-shape constraints. Those are useful targets
for variant testing, but I validated the SDK-invalid address route only. A
temporary node, UTXO, or fee-estimate error is an important counterexample: it
may become recoverable under the same key and should not automatically release
the serialized slot unless Sompi can classify the failure as terminal and prove
that submission did not occur.

No transaction bytes reach the submission stage in the demonstrated route.
There is no key disclosure, arbitrary payment, or fund loss, and the MCP layer
returns a generic bounded error rather than the raw SDK exception. These
constraints are why the issue is a persistent application-layer denial of
service, not a spend or confidentiality vulnerability.

## Proof of Concept

The `poc/reproduce.mjs` harness uses the affected revision's actual registered
MCP field schemas and handlers, `TreasuryOperationModule`, production wallet
adapter, `PurchaseJournal`, `PolicyEngine`, wallet transaction builder, and
pinned Kaspa SDK. It substitutes only the RPC client with a deterministic local
fixture. The fixture supplies one spendable Testnet-10 UTXO and a fee estimate,
while its submission method counts calls and fails if reached.

Prepare the exact target checkout as described in `poc/README.md`, then run from
this report directory:

```sh
cd poc
node reproduce.mjs ../target
```

Representative output from revision
`4ebb82d4f82bac46ae3addd112c4752f29630a8a` is:

```json
{"mcpTransport":"stdio","mcpSchemaAcceptedDestination":true,"firstResponseCode":"WALLET_SEND_FAILED","preparationError":"The address payload is invalid","stateAfterFailure":"intent","unresolvedAfterRestart":1,"reservedCapacityAfterRestart":"110","secondResponseCode":"WALLET_SEND_FAILED","secondOperationBlockReason":"another direct Treasury operation is unresolved; recover it before creating a new movement","recoveryResponseCode":"TREASURY_OPERATION_RECOVERY_FAILED","prepareCalls":2,"submitCalls":0,"irreversibleSideEffectReached":false}
```

We first invoke `send_payment` through the captured registered handler after
parsing each field with its registered Zod schema. The SDK error is converted to
the normal bounded MCP error, but the harness reads the journal and observes
`intent`, one unresolved operation, and 110 units of capacity. It then confirms
that a different operation is blocked, closes and reopens the SQLite journal,
and invokes the registered recovery handler. Recovery makes a second
preparation attempt and reaches the same immutable error. `submitCalls` remains
zero throughout.

The PoC creates its wallet key, policy, and SQLite database in a temporary
directory and removes them on exit. It does not modify the target checkout,
contact a live node, or require funds or credentials. The focused existing
direct-Treasury suite also passes nine tests on the affected revision; those
tests cover successful durability, ambiguous submission, shared capacity, and
some pre-claim rejection, but none asserts a terminal/release path for a
permanent preparation failure.

On a fixed build, the invalid destination should either be rejected before the
intent claim, leaving zero unresolved operations and zero retained capacity, or
be classified as a proven pre-submission terminal failure whose durable state
is `failed_terminal`. A later valid operation must then be able to claim the
direct slot.

## Remediation

The invariant to restore is precise: once a direct operation owns the durable
slot, every permanent failure proven to occur before submission must have an
auditable terminal transition that releases both uniqueness and policy
capacity. Transient or ambiguous failures must remain bound to the original
key and must not be terminalized merely to recover availability.

We should first validate immutable Kaspa destinations with the pinned SDK before
claiming intent. That closes the demonstrated schema mismatch without weakening
the durable-before-effect rule. A side-effect-free `validateRequest` operation
on the existing direct-Treasury adapter seam can run before
`claimTreasuryOperationIntent`, keeping the SDK-specific parser in the Kaspa
adapter while ensuring that the same parser used for transaction construction
defines acceptance. The MCP regex can remain a cheap shape/size guard.

We should also make the state machine complete rather than relying on every
future failure being caught pre-claim. A minimal structural patch would add a
typed, sanitized terminal preparation error and a journal transition usable
only while the operation is still `intent`:

```ts
// treasury/operation-journal.ts
failTreasuryOperationPreparation(
  operationKey: string,
  reasonCode: string
): TreasuryOperationRecord;

// treasury/operations.ts
if (record.state === "intent") {
  try {
    const prepared = await adapter.prepare(record, (destination, amount) => {
      this.authorize(operationKey, destination, amount);
    });
    record = this.journal.recordPreparedTreasuryOperation(operationKey, {
      ...prepared,
      policyDigest: requirePolicyDigest(record),
    });
  } catch (error) {
    if (!isTerminalPreparationError(error)) throw error;
    record = this.journal.failTreasuryOperationPreparation(
      operationKey,
      error.reasonCode
    );
    return view(record);
  }
}

// purchase/journal.ts, inside one immediate transaction
// Require current.state === "intent", update to failed_terminal, and append:
insertTreasuryOperationTransition(
  operationKey,
  "intent",
  "failed_terminal",
  reasonCode,
  now
);
```

`directTreasuryTransitionAllowed` must then explicitly permit
`intent -> failed_terminal`, and the integrity checker must require a canonical
bounded reason code rather than persisting a raw SDK exception. The existing
partial index and capacity query already exclude `failed_terminal`, so the
terminal transaction releases both resources atomically. The adapter contract
must guarantee that `prepare` cannot submit, and only explicit permanent
classifications such as an SDK-invalid immutable destination should use this
edge. Transport errors, node liveness, temporarily empty UTXO sets, and other
conditions that may recover should continue to leave the same intent retryable.

Regression coverage should include:

1. The registered `send_payment` path with `kaspatest:a`, proving that no stale
   intent or capacity remains after rejection.
2. A classified terminal failure after the claim, proving the journal records
   `intent -> failed_terminal`, survives restart, and accepts a new valid key.
3. A transient preparation failure, proving the original intent remains
   retryable and a different key remains serialized until recovery.
4. Fault injection around the terminal update and transition insert, proving
   state, history, unique-slot release, and capacity release are atomic.
5. Guards that reject terminalization from `prepared`,
   `submission_planned`, `submitted`, or `observed`, preserving ambiguity
   safety after transaction material may exist.

## Summary

Sompi correctly commits durable intent before Treasury effects, but the direct
operation state machine does not close the lifecycle for permanent preparation
failure. We demonstrated that an untrusted Agent on the intended stdio MCP
surface can submit one lexically valid, SDK-invalid address, leave a durable
`intent`, retain shared capacity, and block all three direct movement kinds
across restart. Recovery repeats the same failure, while submission is never
reached.

The fix is not to weaken durability or serialization. We should align address
validation with the pinned SDK before claiming the row, then add a narrowly
classified and auditable `intent -> failed_terminal` transition for future
pre-submission failures that are provably permanent. Variant research should
exercise every wallet and vault preparation rejection and verify that each is
either safely retryable under the same immutable key or safely terminalized
without releasing an ambiguous effect.
