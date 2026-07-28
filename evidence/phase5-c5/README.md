# Phase 5 C5 evidence

This directory records the funded Phase 5 restart verification from
2026-07-28.

The run used a synced, UTXO-indexed Kaspa Testnet-10 node. It did not use
mainnet. The public artifacts contain no key, node URL, or private state path.

The evidence proves these facts:

- The first process stopped with the Purchase in `failed_recoverable`.
- The staging Effect was `submitted` before the process restart.
- The second process recovered the same Purchase, staging Effect, and staging
  transaction.
- The completed Purchase has one staging Effect and one payment Effect.
- The Merchant has one exact payment transaction.
- The Purchase reached `receipted`.

`standard-native.json` is the public live-run report.
`restart-proof.json` contains the public before-and-after Journal facts.
`verification.json` binds both artifacts by SHA-256.

The SHA-256 of `standard-native.json` is
`f9ac0bc9413ed94b09c29c23de724378e19df5a81181859693154544261a40b0`.

The SHA-256 of `restart-proof.json` is
`8ac215de641aa69085765a3588f48fc69e65121069e41d335d1d55bab45611d6`.

The checked-in runner can reconstruct the two derived artifacts from the
retained Journal state and its owner-only process-boundary record. It does not
submit a transaction in retained mode. Repeated runs produce the same bytes.

```sh
node scripts/run-restart-proof.mjs \
  --mode retained \
  --evidence-set phase5-c5 \
  --directory /absolute/private/retained-run \
  --report "$PWD/evidence/phase5-c5/standard-native.json" \
  --restart-evidence "$PWD/evidence/phase5-c5/restart-proof.json" \
  --verification "$PWD/evidence/phase5-c5/verification.json" \
  --replace-existing true
```

The retained private run directory is outside this repository. It holds the
recovery journals, the real process boundary, and disposable Testnet keys. Do
not publish it.
