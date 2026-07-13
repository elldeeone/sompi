# Proof of concept

This local-only harness exercises the affected Sompi production classes. It
builds disposable test fixtures, supplies a fake synchronized Testnet-10 RPC,
and makes both mempool lookups throw `Error("Method not found")`. It then checks
that the production observer reports both competing transactions as absent,
that the recovery module creates `safe_to_submit` readiness, and that the fixed
recovery transaction reaches the external-effect submission seam.

The submission seam is an in-process recorder. The harness does not open a
network connection, contact a Kaspa node, or broadcast a transaction. The
embedded private keys are public disposable test values and must never hold
funds.

## Requirements

- Node.js 24 or a compatible supported Node.js release
- npm
- Git

## Build and run

From the directory containing the report and `poc/`, create the exact affected
checkout as `target/`:

```sh
git clone https://github.com/elldeeone/sompi target
git -C target checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix target ci
npm --prefix target run build
cd poc
node reproduce.mjs
```

`reproduce.mjs` loads `../target` by default. To use another relative checkout
or build location, set `SOMPI_TARGET`, for example:

```sh
SOMPI_TARGET=../../sompi node reproduce.mjs
```

The affected revision prints `recovery decision: safe_to_submit` and records
one external-effect seam call. It also shows that replaying the same readiness
is rejected; the finding does not bypass that one-use control.

A fixed implementation should treat `Method not found` as a capability or
unknown observation failure. The script should then stop before
`safe_to_submit`, either because observation throws or because the result is
not ready.

## Cleanup

The harness removes its temporary key directory in a `finally` block. If the
checkout was created only for this reproduction, return to the report
directory and remove it:

```sh
cd ..
rm -rf target
```
