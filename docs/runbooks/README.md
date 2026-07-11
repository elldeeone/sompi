# Operator runbooks

These runbooks apply only to Sompi's initial human-present AP2 + Kaspa-x402
exact profile on Kaspa testnet-10.

- [`AUTHORITY.md`](AUTHORITY.md): separate OS users, credential ownership,
  startup, verification, backup, and key rotation.
- [`JOURNAL.md`](JOURNAL.md): consistent backup, restore validation, and
  corruption response for all MCP-side durable state.
- [`RECONCILIATION.md`](RECONCILIATION.md): safe recovery of interrupted
  Purchases and direct Treasury Movements.

Additional recovery and testnet-reset instructions are added alongside the
corresponding release gate. None of these procedures enables mainnet.
