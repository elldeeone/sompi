# Protocol conformance evidence

Run the reproducible gate with:

```sh
npm run test:conformance
```

The first run needs network access to fetch the exact AP2 commit, Python 3.12,
and locked public-PyPI wheels into the private external cache. After that cache
is warm, prove download-free replay with:

```sh
SOMPI_CONFORMANCE_OFFLINE=1 npm run test:conformance
```

The same command is included in the packed npm artifact with the minimal
runner, fixed fixtures, Python lock, and exact Kaspa-x402 vector it needs.
`git` and `uv` must be installed. The first run needs network access to fetch
the exact AP2 commit and locked Python wheels into a private external cache;
set `SOMPI_CONFORMANCE_OFFLINE=1` to require an already warmed cache.

The runner checks out AP2 at the exact recorded commit into an external cache
and validates the upstream `pyproject.toml` and `uv.lock` hashes. The upstream
lock records a private package registry, so it is provenance rather than an
installation input. A separate committed public-PyPI lock pins the same AP2
Python dependencies and all transitives exactly; the runner applies it with
`uv sync --frozen` and Python 3.12. It then runs both directions of the AP2
TypeScript/Python mandate test and verifies Sompi's two receipt roles plus their
issuer-JWT references in the pinned Python `ReceiptClient`.

For Kaspa-x402, the gate checks all published alpha.6 package versions and npm
lockfile SRI values, validates the one unmodified vendored exact HTTP vector,
and drives its requirements through Sompi's exact adapter preparation seam. A
Payment Identifier is added with the official alpha.6 extension API because
Sompi deliberately rejects the upstream vector's uncorrelated raw form.

Exact machine-readable provenance and claim boundaries are in
[`test/conformance/provenance.json`](../../test/conformance/provenance.json).
Passing this gate proves the recorded offline profiles only. It is not a live
testnet result, general AP2 interoperability, or standardized native-KAS AP2
support.
