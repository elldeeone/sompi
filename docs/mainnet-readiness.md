# Mainnet is not supported

Status: explicit v0.8 release boundary

Sompi's initial AP2 + Kaspa-x402 Purchase runtime supports only Kaspa
testnet-10. Configuration rejects every other network before opening the
Purchase Journal or creating signing material. There is no supported
`SOMPI_ENABLE_MAINNET` escape hatch.

Do not patch around this check or point a testnet-configured runtime at a
mainnet node. The current native-KAS AP2 profile is experimental, authority
operations are software-key based, and release evidence is testnet evidence.

## Preconditions for a future mainnet decision

Mainnet would require a separate ADR and release profile covering at least:

- independent review of Purchase, authority, x402, wallet, vault, staging
  recovery, and shared policy-accounting paths;
- live Testnet-10 evidence across every ambiguous crash edge over an extended
  soak period;
- reproducible third-party AP2 and Kaspa-x402 conformance;
- production Merchant trust onboarding, revocation, and receipt retention;
- hardware-backed or otherwise production-grade authority-key custody,
  rotation, backup, and lost-access recovery;
- audited operator deployment with separate OS users and monitoring;
- fee/additional-cost limits calibrated to real network economics;
- tested journal backup, corruption recovery, and disaster restoration;
- explicit limits, incident response, and a staged-value launch plan.

Until a later profile satisfies those gates, the correct response to any
mainnet request is: “This Sompi release cannot use real KAS; use testnet-10.”
