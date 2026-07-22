# Operator runbooks

These runbooks apply to the Testnet-10 alpha.9 runtime.
They do not enable mainnet.

## Start and operate

1. [Provision the runtime](OPERATOR_PROVISIONING.md).
2. [Start the Trusted Authority](AUTHORITY.md).
3. [Connect Hermes](HERMES.md).
4. [Back up the Journal](JOURNAL.md).

## Recover

| Condition | Runbook |
|---|---|
| Interrupted Purchase | [Reconciliation](RECONCILIATION.md) |
| Exact-payment staging output | [Staging recovery](STAGING_RECOVERY.md) |
| Additive head or batch channel | [Channel recovery](CHANNEL_RECOVERY.md) |
| New isolated testnet runtime | [Testnet reset](TESTNET_RESET.md) |

MCP is not an operator interface.
Use the separate operator recovery socket for privileged recovery.
