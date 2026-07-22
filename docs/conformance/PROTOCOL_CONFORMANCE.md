# Protocol conformance

Run the conformance gate:

```bash
npm run test:conformance
```

The gate checks:

- AP2 v0.2 source, schema, and dependency provenance
- Sompi internal authorization compatibility
- all four Kaspa-x402 `0.1.0-alpha.9` packages
- Kaspa-x402 source and release identity
- exact HTTP and consensus vectors
- authorization-expiry and batch vectors
- Sompi Purchase and Payment Identifier binding

The first run needs Git, Python 3.12, `uv`, and network access.
It fills a private cache from pinned sources.

Replay the cache without downloads:

```bash
SOMPI_CONFORMANCE_OFFLINE=1 npm run test:conformance
```

See [the provenance record](../../test/conformance/provenance.json) for machine-readable pins.

A pass proves only the pinned inputs and internal adapter behavior.
It does not prove AP2 interoperability, mainnet readiness, or third-party deployment compatibility.
This gate is offline after the cache is complete.
Funded Testnet-10 behavior needs separate recorded evidence.
