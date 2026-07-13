# Provisional Purchase staging finality PoC

This bounded harness demonstrates the decisive production sink: a
`VaultTreasuryStaging` observation with `observedAtDaa = 0` invokes the vault
commit and emits canonical staging evidence.

## Requirements

- Node.js 22 or newer
- GNU Make (optional; the Node.js command can be run directly)
- a built Sompi checkout at affected revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`

Build the target checkout with its pinned dependencies:

```sh
cd sompi
git checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm ci
npm run build
```

With the target checkout and this report directory beside one another, run:

```sh
cd provisional-purchase-staging-finality/poc
make SOMPI_TARGET=../../sompi
```

Or invoke the script directly with any relative path to the built checkout:

```sh
node reproduce.mjs ../../sompi
```

## What it proves

The harness imports the target's compiled production class. A commit spy
confirms that the common staging sink commits once, and the returned verified
artifact is decoded to confirm that its `observedAtDaa` is the string `"0"`.

The harness intentionally does not recreate a complete Purchase or connect to
Kaspa. Public reachability follows the affected class's `submit` and `observe`
methods, which send every non-undefined shared-vault observation to this sink.
No funds, keys, files, or network services are touched, so no cleanup is
required.

On a corrected target, a provisional observation should stay pending or fail
before the vault commit is called.
