# PoC: spent exact-payment evidence loss

This PoC runs Sompi's production `RpcChainObservationSource` against a local
fake RPC that represents an accepted exact payment after the Merchant has
spent its output. The transaction is present in the fake's historical accepted
set, while both current indexes are empty.

The script asserts that the affected observer returns `pending` and never
queries accepted history. It does not connect to a Merchant or Kaspa node,
broadcast a transaction, or change the target checkout.

## Requirements

- Node.js 22 or newer.
- A disposable checkout of Sompi revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`, built with its exact lockfile.
- This report directory and the checkout arranged as siblings:

```text
bundle/
├── sompi/
└── spent-payment-evidence-loss/
```

From `bundle/`, prepare the affected checkout:

```sh
git -C sompi checkout 4ebb82d4f82bac46ae3addd112c4752f29630a8a
npm --prefix sompi ci
npm --prefix sompi run build
```

Then run from the report directory:

```sh
cd spent-payment-evidence-loss/poc
make run SOMPI_ROOT=../../sompi
```

The expected output is recorded in `expected-output.txt`. The script verifies
the compiled `chain-verifier.js` SHA-256 before importing it, so it fails
closed if the checkout does not match the reviewed revision.

There is no cleanup beyond removing the disposable checkout: all chain state
is in memory and no files are written by the PoC.
