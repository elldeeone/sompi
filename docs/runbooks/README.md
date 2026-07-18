# Operator runbooks

These procedures apply to the Testnet-10 alpha.8 runtime. They do not enable
mainnet.

Start with:

1. [`OPERATOR_PROVISIONING.md`](OPERATOR_PROVISIONING.md) — install the
   manifest, API credentials, runtime identity, and vault configuration.
2. [`AUTHORITY.md`](AUTHORITY.md) — isolate and operate the human-present
   signer.
3. [`HERMES.md`](HERMES.md) — connect the API-first agent skill and Telegram
   callback plugin.
4. [`JOURNAL.md`](JOURNAL.md) — back up and restore API-owned state.
5. [`RECONCILIATION.md`](RECONCILIATION.md) — recover one interrupted Purchase.

Mechanism-specific procedures:

- [`STAGING_RECOVERY.md`](STAGING_RECOVERY.md) — recover an already-created
  exact-payment staging output.
- [`CHANNEL_RECOVERY.md`](CHANNEL_RECOVERY.md) — recover additive-head and batch
  channel state.
- [`TESTNET_RESET.md`](TESTNET_RESET.md) — start a new isolated testnet runtime
  without mutating the old one.

MCP is not an operator surface. It has only the Agent API credential and the
three Purchase tools. Use the separate operator recovery socket for privileged
status and recovery work.
