# Journal backup and restore

Scope: the complete API runtime directory from the Operator Manifest.

This directory is one recovery unit.
It contains the Journal, evidence, prepared effects, wallet data, vault data, and staging keys.

Do not copy only the SQLite file.
Do not combine this backup with private Authority state.

## Back up

1. Stop Agent traffic.
2. Stop Hermes or `sompi-mcp`.
3. Stop `sompi-api` normally.
4. Confirm that no process uses the data directory.
5. Archive the complete directory without link traversal.
6. Hash, encrypt, and store the archive offline.

Run the archive command as the API account with umask `077`.
Reject links, special files, and unexpected ownership.

Record the Sompi version, commit, manifest digest, network, UTC time, and archive digest.
Also record the Authority issuer and public key IDs.

## Restore drill

Restore into a new empty directory.
Do not overwrite the only state tree.

1. Verify the archive digest.
2. Extract as the API account without stored ownership.
3. Set directories to `0700` and files to `0600`.
4. Reject links, special files, hard links, and wrong ownership.
5. Select a manifest that exactly matches the restored state.
6. Block all IPv4 and IPv6 egress for the restored runtime.
7. Keep the Agent socket unavailable.
8. Start the recorded Sompi version with the Authority available.

Startup verifies Journal epoch, SQLite integrity, history, manifest identity, and content-addressed artifacts.
Network isolation prevents Funding Intake or recovery from submitting an effect.
Do not call a mutation or recovery operation during this drill.
Stop the validation runtime immediately after the checks pass.

## Corruption

Stop the API and preserve the complete state tree, logs, package identity, manifest, and file metadata.
Do not repair SQLite, delete WAL files, edit rows, or replace one artifact.

Restore the newest verified backup to a separate path.
Reconcile every later Purchase, Transfer, Treasury effect, Policy Change, and Vault Migration.
Use each exact Merchant, chain, policy, and transaction identity.

If no clean backup exists, preserve the state and stop.
A reset does not resolve ambiguous money movement.

## Retention

Keep backups and old public verification keys while a retained record depends on them.
Delete a retired state tree only through a separate reviewed operator action.
