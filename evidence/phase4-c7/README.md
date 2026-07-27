# Phase 4 C7 evidence

This directory records the funded Phase 4 Treasury verification from
2026-07-27.

The run used a synced, UTXO-indexed Kaspa Testnet-10 node. It did not use
mainnet. The public report contains no key, node URL, or private state path.

The evidence proves these facts:

- Three direct Treasury Movements completed.
- The first process stopped with the Purchase in `failed_recoverable`.
- Before restart, the staging Effect was `submitted`.
- The second process moved the same staging Effect and transaction through
  `ambiguous` to `observed`.
- The exact payment moved from `executing` to `ambiguous` and then `observed`.
- The Purchase reached `receipted`.
- The restart kept the same Purchase, staging Effect, and staging transaction.
- The completed Journal has three Treasury operations, two Effects, one
  Payment Attempt, one Settlement, and one exact Merchant transaction.

`standard-native.json` is the public live-run report.
`restart-proof.json` contains the public before-and-after Journal facts.
`verification.json` binds both artifacts by SHA-256.

The SHA-256 of `standard-native.json` is
`1bcce8f51cca40e52afb335fe3679b0fe2e0254ad83a29c9c5adb981c23ce4fb`.

The SHA-256 of `restart-proof.json` is
`554c52aca3400355e8d4b3604e9dcb54845ef5e74e9777b0fc044cab0cfba3d2`.

The retained private run directory is outside this repository. It holds the
recovery journals and disposable Testnet keys. Do not publish it.
