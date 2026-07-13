# Merchant mempool-finality capacity-release PoC

This PoC exercises Sompi's compiled verifier, staging-recovery adapter,
recovery classifier, and Purchase Journal. It uses only local synthetic data
and a temporary SQLite journal; it does not contact a Merchant or Kaspa RPC.

## Requirements

- Node.js 22 or newer.
- A checkout of the reviewed Sompi revision with dependencies installed and
  `npm run build` completed.
- The checkout must retain `src/`, because the PoC verifies source hashes before
  importing the compiled modules.

## Run

From this directory, pass the Sompi checkout as a relative path:

```sh
node reproduce.mjs ../../../sompi
```

The included Makefile provides the same operation:

```sh
make check TARGET=../../../sompi
```

The expected successful transcript is in `expected-output.txt`.

## What the PoC proves

The script demonstrates that a valid exact PAYMENT-REQUIRED artifact carrying
`finality=mempool` is accepted, that the decoded finality is absent from the
authority facts and display, that recovery preparation copies the threshold,
and that a mempool-only recovery observation releases durable policy capacity
while the staging source is still reported unspent.

The diagnostic classifier call uses the implementation's own compiled private
method so the decisive branch can be exercised without creating or broadcasting
a real recovery transaction. The rest of the state transition uses public
Purchase Journal methods and is verified again after reopening SQLite.

This is not a double-spend PoC. Kaspa's one-spend consensus rule prevents the
recovery and exact transactions from both being accepted. The PoC also does not
simulate mempool eviction, a later exact winner, or reuse of the released
capacity; those are the additional conditions needed for the full accounting
impact.

## Cleanup

The temporary journal is removed automatically. No network or persistent
target state is changed.
