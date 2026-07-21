# Kaspa-x402 alpha.9 clean-cutover evidence

Fresh TN10 evidence for the `0.12.0` clean cutover on 2026-07-21:

- [`release.json`](release.json) records the final source/tag identity, public
  npm registry hashes, fresh-cache byte comparison, clean consumer proof,
  GitHub Node 22 verification, and deployed-runtime health.
- [`terah-epoch19-standard-native.json`](terah-epoch19-standard-native.json)
  records the recoverable epoch-18 archive, distinct fresh epoch-19 identities,
  one owner-authorized vault recovery into the new funding wallet, fresh vault
  activation, and a separately human-approved exact Purchase. Explicit
  recovery and same-request replay returned the same receipted Purchase,
  transaction, payment identifier, and sole payment attempt.
- [`funded-batch.json`](funded-batch.json) is the public report from a separate
  funded proof identity. It records two independently authorized alpha.9 batch
  charges, one accepted claim with independent depth-confirmed evidence and
  the exact continuation amount, plus a second channel refunded only after its
  strict absolute DAA timeout.

The Terah Purchase used the isolated Trusted Authority and its Telegram
human-present approval. The batch proof used the explicitly labelled
in-process auto-approved test fixture; it proves the funded protocol and
Purchase integration, not a human-present batch ceremony.

No private key, credential, raw signed transaction, wallet directory, Journal,
or raw Authority evidence is included. The archived epoch-18 runtime remains
operator-private and immutable; only its public hashes and recovery outcome are
recorded here.
