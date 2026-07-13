# Provisional wallet-send finality reproduction

This harness exercises Sompi's production `KaspaWallet`, wallet Treasury
adapter, Treasury operation module, policy engine, and SQLite journal. It
substitutes a deterministic local RPC object for the network connection. The
RPC exposes no recipient UTXO and no accepted-chain history; its sole positive
fact is one non-orphan mempool response. The harness then removes that response,
reopens the journal, and asks the operation module to recover.

The reproduction is local and safe. It does not contact a Kaspa node, spend
real funds, or retain the generated test key and journal. Temporary state is
removed even when an assertion fails.

## Requirements

- Node.js 22 or newer.
- A checkout of Sompi revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`.
- Dependencies installed from that revision's lockfile and a compiled `dist/`
  tree.

One reproducible layout is:

```text
workspace/
  sompi/
  provisional-wallet-send-finality/
```

Prepare the target, then run the PoC with relative paths:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
cd ../provisional-wallet-send-finality/poc
node reproduce.mjs ../../sompi
```

On the vulnerable revision, the command exits zero and prints the JSON in
`representative-output.txt`. In particular, `acceptedChainQueries` remains
zero, while both pre-eviction and post-restart state are `completed`.

The fixed behavior should keep a mempool-only result nonterminal. A regression
run should therefore fail the first `completed` assertion until the harness is
updated to expect `pending` or another explicitly recoverable state.

## Cleanup

The harness deletes its temporary directory automatically. Reverting the
checkout is the only optional cleanup step if the target repository was on a
different revision before the run.
