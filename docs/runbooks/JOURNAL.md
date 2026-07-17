# Purchase Journal backup and restore

Scope: the API-owned Testnet-10 runtime directory installed by
`sompi-operator`.

The directory is one recovery unit. It contains:

- `purchase.sqlite` and SQLite WAL/SHM files;
- immutable evidence and prepared-effect stores;
- wallet and vault configuration and signing material;
- staging keys;
- Authority-client replay state.

Do not copy only the SQLite file. Do not combine this backup with Authority
private state.

## Backup

1. Stop new Agent and MCP requests.
2. Stop `sompi-mcp`.
3. Stop `sompi-api` normally and wait for it to close.
4. Confirm no process holds the API data directory or Journal open.
5. Archive the complete data directory without following links.
6. Hash the archive and store it encrypted and offline.

Use the absolute `dataDirectory` from the installed Operator Manifest. Run the
archive command as the API service user with umask `077`. Reject any symlink,
device, socket, FIFO, or unexpected owner before archiving.

Record alongside the backup:

- Sompi version and Git commit;
- Operator Manifest revision and digest;
- network and UTC time;
- archive digest;
- Authority issuer and public key IDs.

The archive contains payment keys. Treat it as secret.

## Restore drill

Restore first into a new empty directory owned by `sompi-api`, never over the
only existing state tree.

1. Verify the archive digest.
2. Extract as the API user without restoring archive ownership or modes.
3. Set directories to `0700` and files to `0600`.
4. Reject links, special files, multiple hard links, and wrong ownership.
5. Install or select an Operator Manifest whose `dataDirectory` is exactly the
   restored path and whose static vault facts match the backup.
6. Start the exact recorded Sompi version with the Authority available.

Startup is the integrity check. It validates the current clean-cutover Journal
epoch, SQLite integrity, immutable history, cross-table invariants, manifest
identity, and content-addressed artifacts.

During the drill, use only the operator status/recovery API. Do not create a
Purchase or allow agent traffic. After validation, stop the API before moving
the candidate into its final path.

## Corruption

If Sompi reports database, history, evidence, prepared-byte, or key-store
corruption:

1. Stop MCP and API.
2. Preserve the complete state tree, logs, package identity, manifest, and
   filesystem metadata.
3. Do not run SQLite repair, delete WAL files, edit rows, or replace one
   artifact.
4. Restore the newest verified backup to a separate path.
5. Reconcile every Purchase created after that backup against its exact
   Merchant and chain identities before releasing capacity.

If no clean backup exists, preserve the state and stop. A fresh reset is not a
recovery procedure for ambiguous money movement.

## Retention

Keep backups and old public verification keys while any retained Purchase,
Settlement, fulfilment, receipt, channel, or recovery record depends on them.
Delete a retired state tree only through a separate reviewed operator action.
