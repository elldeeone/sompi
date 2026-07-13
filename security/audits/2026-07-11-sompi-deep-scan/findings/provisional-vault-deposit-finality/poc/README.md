# Provisional vault-deposit finality PoC

This local-only harness runs Sompi's production `VaultManager`,
`VaultDepositTreasuryOperationAdapter`, `TreasuryOperationModule`, policy
engine, and SQLite journal. A deterministic in-process RPC returns the exact
locally signed vault output with `blockDaaScore=0`, then removes it while
restoring the intact wallet source input.

The harness verifies that the operation completes, the covenant and current
outpoint are saved, later reconciliation reports `not_submitted`, and both the
terminal operation and nonexistent outpoint survive restart.

## Safety

The RPC is an in-memory object. The harness does not open a network connection,
contact a Kaspa node, broadcast a transaction, or use real funds. It creates a
disposable Testnet-10 wallet, key, journal, and vault under the operating
system's temporary directory, then removes them in a `finally` block.

## Requirements

- Node.js 22 or newer
- Git and npm
- a source checkout of Sompi revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`

The script checks SHA-256 hashes of the three decisive source files before it
loads compiled code. This makes a run against a different revision fail
closed.

## Build and run

Starting in the directory containing this report and `poc/`, create the exact
affected checkout as `target/`:

```sh
git clone https://github.com/elldeeone/sompi.git target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
cd poc
node reproduce.mjs ../target
```

To use an existing checkout elsewhere, pass its relative path instead:

```sh
cd poc
node reproduce.mjs ../../sompi
```

An affected build exits zero and prints the JSON recorded in
`representative-output.txt`. A fixed build should keep the operation pending
until it has accepted-finality evidence independent of the submitter's current
UTXO view. It should therefore fail one of the completion or persistence
assertions.

## Interpretation and cleanup

The PoC uses the real signed transaction and exact output bindings, so it does
not demonstrate covenant, recipient, amount, or transaction substitution. Its
positive result isolates the missing finality gate. No manual cleanup is
needed; remove `target/` only if the checkout was created solely for this test.
