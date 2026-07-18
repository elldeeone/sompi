# Mainnet is not supported

Status: explicit v0.8 release boundary

Sompi supports only Kaspa Testnet-10. Configuration rejects every other
network before opening the Purchase Journal or creating signing material.
There is no mainnet override.

Do not patch around this check or point a testnet-configured runtime at a
mainnet node. Authorization is software-key based, Kaspa-x402 remains alpha
software, and all release evidence is testnet evidence.

## Preconditions for a future mainnet decision

Mainnet would require a separate ADR and release profile covering at least:

- independent review of Purchase, authority, x402, wallet, vault, staging
  recovery, and shared policy-accounting paths;
- live Testnet-10 evidence across every ambiguous crash edge over an extended
  soak period;
- reproducible Kaspa-x402 conformance and an explicitly reviewed AP2 profile;
- production Merchant-origin/payee policy, revocation, and evidence retention;
- hardware-backed or otherwise production-grade authority-key custody,
  rotation, backup, and lost-access recovery;
- audited operator deployment with separate OS users and monitoring;
- fee/additional-cost limits calibrated to real network economics;
- tested journal backup, corruption recovery, and disaster restoration;
- explicit limits, incident response, and a staged-value launch plan.

Until a later profile satisfies those gates, the correct response to any
mainnet request is: “This Sompi release cannot use real KAS; use testnet-10.”
