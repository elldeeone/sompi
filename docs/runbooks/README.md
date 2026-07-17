# Operator runbooks

These runbooks apply only to Sompi's human-present AP2 + Kaspa-x402 alpha.8
runtime on Kaspa testnet-10. The normal Purchase path supports both exact
profiles. Batch settlement is a separately capitalized, explicitly authorized
channel lifecycle.

- [`AUTHORITY.md`](AUTHORITY.md): separate OS users, credential ownership,
  startup, verification, backup, and key rotation.
- [`OPERATOR_PROVISIONING.md`](OPERATOR_PROVISIONING.md): immutable manifest,
  vault bootstrap, OS ownership, digest approval, and static-drift recovery.
- [`JOURNAL.md`](JOURNAL.md): consistent backup, restore validation, and
  corruption response for all MCP-side durable state.
- [`RECONCILIATION.md`](RECONCILIATION.md): safe recovery of interrupted
  Purchases and direct Treasury Movements.
- [`STAGING_RECOVERY.md`](STAGING_RECOVERY.md): exact/no-exact candidate race,
  immutable return sweep, finality, fee accounting, and escalation for an
  already-observed staging output.
- [`CHANNEL_RECOVERY.md`](CHANNEL_RECOVERY.md): additive-head contention and
  batch claim/refund recovery without rebuilding, rebroadcasting, or silently
  rotating protocol state.
- [`TESTNET_RESET.md`](TESTNET_RESET.md): create a fresh isolated testnet runtime
  without deleting or partially reusing the old durable state.

Expiry blocks new Merchant authorization, Treasury staging, and exact-payment
preparation/signing/submission. It does not erase an existing staging UTXO; the
dedicated recovery runbook describes the narrowly authorized return sweep.
None of these procedures enables mainnet.
