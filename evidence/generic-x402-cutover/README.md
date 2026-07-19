# Generic x402 cutover evidence

Fresh TN10 proofs from the generic-Merchant cutover on 2026-07-18:

- [`standard-native.json`](standard-native.json): canonical HTTP API to a generic
  x402 exact Merchant; one 20,000,000-sompi payment and one canonical receipt.
- [`additive.json`](additive.json): MCP compatibility ingress over the same API;
  the 20,000,000-sompi KIP-10 successor delta is the entire Merchant gain.
- [`batch.json`](batch.json): two independently authorized charges, accepted
  claim/continuation, and a refund after the strict absolute DAA boundary.
- [`terah-standard-native-recovery.json`](terah-standard-native-recovery.json):
  a human-approved Terah purchase from the public demo Merchant. The payment
  was accepted once, its first HTTP result was ambiguous, and recovery replayed
  the same signed payment after Checkout expiry to record fulfilment and a
  receipt without another payment.

The exact proofs used the isolated auto-approval test fixture. They prove the
payment and Purchase integration, not a new human-present ceremony. The
unchanged separate Authority and Telegram ceremony remains covered by its
isolation tests and the Phase 11 evidence.

The public `demo.kaspa-x402.org` gateway was also used for the Terah canary. It
accepted the alpha.8 standard-native payment and returned the paid report on
the idempotent recovery replay.

No key, token, private transaction artifact, wallet path, Journal, or raw
Authority evidence is included here.
