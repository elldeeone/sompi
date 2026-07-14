# Local observer PoC

This harness demonstrates that one fake Kaspa RPC can make Sompi's production
staging-recovery observer emit `accepted` recovery evidence for an invented
UTXO. It performs no network requests, creates no transactions, and writes no
Sompi state.

## Requirements

- Node.js 22 or newer.
- A Sompi source checkout at the affected revision, with dependencies
  installed and `dist/` built.

## Run

From a directory containing both `sompi/` and this report directory, build the
target source:

```sh
(cd sompi && npm ci && npm run build)
```

Then run the PoC from this directory:

```sh
cd untrusted-rpc-forged-recovery-finality/poc
node poc.mjs --source-root ../../sompi
```

The source root may also be supplied as the only positional argument:

```sh
node poc.mjs ../../sompi
```

An affected build exits with status zero and prints the contents represented
in `sample-output.txt`. The runner asserts that the exact candidate is absent,
the invented recovery candidate is `observed` with `accepted` finality, and
the staging outpoint is attributed to that recovery transaction.

A fixed build should not satisfy those assertions from one RPC view. An
assertion failure, partial/pending observation, or explicit independent-proof
error is the expected security behavior. A missing-module error only means the
target has not been built.

## Safety and cleanup

The PoC is a local adapter harness. It does not use a wallet, a real RPC, or a
live Kaspa network. No cleanup is required beyond optionally deleting target
build products.
