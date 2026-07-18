# Generic x402 cutover evidence

Fresh TN10 proofs from the generic-Merchant cutover on 2026-07-18:

- [`standard-native.json`](standard-native.json): canonical HTTP API to a generic
  x402 exact Merchant; one 20,000,000-sompi payment and one canonical receipt.
- [`additive.json`](additive.json): MCP compatibility ingress over the same API;
  the 20,000,000-sompi KIP-10 successor delta is the entire Merchant gain.
- [`batch.json`](batch.json): two independently authorized charges, accepted
  claim/continuation, and a refund after the strict absolute DAA boundary.

The exact proofs used the isolated auto-approval test fixture. They prove the
payment and Purchase integration, not a new human-present ceremony. The
unchanged separate Authority and Telegram ceremony remains covered by its
isolation tests and the Phase 11 evidence.

The public `demo.kaspa-x402.org` gateway was also checked read-only. It was
healthy, enabled, on TN10, and advertised x402 v2 standard-native exact and
batch settlement. The funded proofs use the repository's independently
verified generic Merchant fixture so they remain reproducible and do not
depend on a hosted service.

No key, token, private transaction artifact, wallet path, Journal, or raw
Authority evidence is included here.
