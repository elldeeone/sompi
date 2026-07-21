# Protocol conformance

Run:

```bash
npm run test:conformance
```

The gate verifies:

- AP2 v0.2 source, schema, and Python dependency provenance;
- TypeScript/Python compatibility for Sompi's pinned internal authorization
  evidence;
- all four Kaspa-x402 `0.1.0-alpha.9` packages and npm integrity values;
- Kaspa-x402 source/release identity;
- unmodified exact HTTP and full-consensus standard-native/additive vectors;
- language-independent exact authorization-expiry and batch
  requirements/commitment vectors;
- Sompi Payment Identifier and Purchase binding.

The first run requires Git, Python 3.12, `uv`, and network access. It fills a
private external cache from the exact recorded sources and public PyPI lock.
After that, require download-free replay with:

```bash
SOMPI_CONFORMANCE_OFFLINE=1 npm run test:conformance
```

Machine-readable provenance and claim boundaries are in
[`test/conformance/provenance.json`](../../test/conformance/provenance.json).

Passing this gate proves only the pinned offline inputs and internal adapter.
Funded network evidence is separate. It does not prove AP2 interoperability,
mainnet readiness, or third-party deployment compatibility.
