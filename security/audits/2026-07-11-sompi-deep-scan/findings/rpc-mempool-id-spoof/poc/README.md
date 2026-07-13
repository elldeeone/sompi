# Reproducing the mempool identity bypass

This PoC exercises the production `RpcChainObservationSource` with a local mock
RPC. It does not connect to Kaspa, contact a Merchant, load a wallet, submit a
transaction, or modify application state.

## Requirements

- Node.js 22 or newer
- Git and npm
- a source checkout of Sompi revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`

## Run

Starting in the report directory, build the affected revision in a disposable
subdirectory and pass that checkout to the PoC using a relative path:

```sh
git clone https://github.com/elldeeone/sompi.git lab/sompi
git -C lab/sompi checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix lab/sompi ci
npm --prefix lab/sompi run build
cd poc
node reproduce.mjs ../lab/sompi
```

The first observation supplies a deliberately incomplete transaction with the
expected ID in `verboseData`. The affected adapter accepts it as
`observed/mempool`. The negative control removes only `verboseData`; local
hydration/finalization then rejects the same incomplete object. The script
exits non-zero if either assertion no longer holds.

Expected output is recorded in `expected-output.txt`.

## Cleanup

The PoC itself creates no files and changes no state. To remove the optional
checkout, return to the report directory and run:

```sh
rm -rf lab
```
