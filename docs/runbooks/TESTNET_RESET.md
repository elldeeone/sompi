# Non-destructive Testnet-10 reset

A reset creates a new isolated runtime and keeps the old runtime unchanged.
It does not repair corruption or ambiguous payments.

## Do not reset when

- a Purchase or external effect is unresolved
- staged value has no proven winner
- an additive or batch effect is ambiguous
- policy capacity can still be active
- runtime state is corrupt
- retained funds are not accounted for

Run reconciliation first.
Use the Journal runbook for corruption.

## Preserve the old runtime

1. Record the version, commit, manifest revision, digest, and data directory.
2. Record the wallet address, known balance, and incoming UTXOs.
3. Record the vault address, active outpoint, balance, cap, window, and owner public key.
4. Record every retained Purchase, Transfer, policy, migration, Treasury, transaction, and outpoint ID.
5. Record evidence digests and funds that the operator intentionally abandons.
6. Stop Agent traffic, Hermes or MCP, API, and Authority.
7. Back up API state.
8. Back up Authority state separately.
9. Keep the old data directory unchanged and read-only.

Do not copy selected files into the new runtime.

## Create the new runtime

1. Choose a new empty API data directory.
2. Generate a new offline owner key when the vault identity changes.
3. Create and review a new provisioning specification.
4. Run `preview`, `provision`, `install`, and `status`.
5. Install new Agent and recovery credentials.
6. Start Authority, API, and Hermes or MCP.
7. Verify Testnet-10 identity before funding.

Do not reuse the old Journal, wallet key, Agent key, staging keys, evidence, or replay state.

## Funding

Use fresh testnet funding or a reviewed operator recovery.
The Agent API also supports exact, human-approved Transfers.
Do not use that Agent surface to administer an old vault.

For old vault funds, keep the old runtime or use `sompi-vault-recover` locally.
Do not copy private keys into the new runtime.

## Cut over

1. Stop both runtimes.
2. Point the launcher only at the new manifest and data directory.
3. Start the new Authority, API, and agent integration.
4. Verify exact runtime identity.
5. Retain the old state, digest, version, manifest, and public trust keys.

Rollback starts the exact old version with its original manifest and state.
Never merge the runtimes.

Delete old state only after every external effect is terminal.
Every old wallet and vault fund must be recovered or explicitly abandoned.
Retained evidence must stay verifiable, and the retention policy must permit deletion.
Deletion is a separate reviewed action.
