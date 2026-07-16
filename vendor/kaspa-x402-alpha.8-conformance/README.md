# Kaspa-x402 alpha.8 conformance vectors

These files are unmodified public vectors from the landed Kaspa-x402
`0.1.0-alpha.8` release source. Sompi pins their byte lengths and SHA-256
digests in `test/conformance/provenance.json`.

- `exact-transaction.json` exercises the corrected additive HTTP binding.
- `consensus-profiles.json` contains full-consensus standard-native v0 and
  additive v1 transactions plus mutation outcomes.

The package tarballs are independently pinned by npm integrity and package
`gitHead`. These vectors are offline evidence; funded Sompi Testnet-10 proof
is a separate acceptance gate.

