# Packaged conformance fixtures

These files are deterministic, public test fixtures used by
`npm run test:conformance`.

`ap2-v0.2/fixture.json` intentionally contains a fixed private JWK marked
`testOnly: true` so TypeScript and the pinned AP2 Python implementation can
issue cross-language artifacts reproducibly. It has never protected funds,
identity, deployment, or production trust. Do not copy any fixture key into an
authority or Merchant trust store.

`provenance.json` pins upstream commits, file hashes, npm integrity values, and
the exact public-PyPI Python lock. The conformance result is an offline
protocol/adapter claim, not live-network or mainnet evidence.
