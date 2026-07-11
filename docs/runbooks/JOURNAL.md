# Purchase Journal backup and restore

Status: initial testnet-10 operator runbook

The Purchase Journal is the source of truth for Purchases, policy capacity,
direct Treasury Movements, prepared transaction bytes, protocol evidence, and
effect recovery. A backup is incomplete unless it includes the entire
MCP-owned `SOMPI_DATA_DIR`, not only `purchase.sqlite`.

## What must be preserved

The default data directory includes:

- `purchase.sqlite` and any SQLite WAL/SHM companions;
- `purchase.sqlite.evidence/` immutable evidence bytes;
- `purchase.sqlite.prepared/` immutable prepared-effect bytes;
- wallet and covenant-vault configuration and signing material;
- staging keys and authority-client replay state.

The authority private directory is a different security context and has its
own backup procedure in [`AUTHORITY.md`](AUTHORITY.md). Never merge the two
trees into one access policy.

## Consistent backup

1. Stop accepting MCP calls.
2. Terminate `sompi-mcp` normally and wait for it to exit. Do not use `SIGKILL`
   for a planned backup.
3. Confirm no process has the state directory open. On Linux, for example:

   ```bash
   fuser -v /var/lib/sompi-mcp/testnet-10/purchase.sqlite
   ```

   The command must report no holder.
4. Create the backup as the MCP service user with a restrictive umask. Copy the
   whole directory without following links:

   ```bash
   BACKUP=/secure/offline/sompi-testnet-10-$(date -u +%Y%m%dT%H%M%SZ).tar
   sudo -u sompi-mcp sh -c 'umask 077; cd /var/lib/sompi-mcp || exit 1; \
     find testnet-10 -xdev -type l -print -quit | grep -q . && exit 1; \
     tar --create --file "$1" --no-recursion testnet-10; \
     find testnet-10 -xdev -mindepth 1 -print0 | sort -z | \
     tar --append --null --files-from=- --file "$1"' sh "$BACKUP"
   sha256sum "$BACKUP" >"$BACKUP.sha256"
   chmod 0600 "$BACKUP" "$BACKUP.sha256"
   ```

   If the host `tar` does not support this exact safe invocation, use an
   operator-approved filesystem snapshot while the process remains stopped.
   Do not substitute `cp purchase.sqlite`.
5. Store the archive and checksum encrypted and offline. Record the Sompi
   package version, Git commit when built from source, network (`testnet-10`),
   UTC time, and policy-file digest next to the backup.

The archive contains hot-wallet and vault-agent signing material. Treat it as
a secret even though authority signing material is stored separately.

## Restore drill

Always restore first to a new, empty directory. Never extract an untrusted
archive as root and never overwrite the only existing state tree.

```bash
sha256sum --check /secure/offline/sompi-testnet-10-TIMESTAMP.tar.sha256
install -d -o sompi-mcp -g sompi-mcp -m 0700 \
  /var/lib/sompi-mcp/restore-candidate
sudo -u sompi-mcp tar --extract --file \
  /secure/offline/sompi-testnet-10-TIMESTAMP.tar \
  --directory /var/lib/sompi-mcp/restore-candidate \
  --no-same-owner --no-same-permissions
chown -R sompi-mcp:sompi-mcp /var/lib/sompi-mcp/restore-candidate
find /var/lib/sompi-mcp/restore-candidate -type d -exec chmod 0700 {} +
find /var/lib/sompi-mcp/restore-candidate -type f -exec chmod 0600 {} +
```

Before startup, reject the candidate if it contains a symlink, socket, device,
FIFO, hard link escaping the tree, group/other permission, or unexpected
owner. Point `SOMPI_DATA_DIR` at the restored `testnet-10` directory and start
the exact recorded Sompi version with the authority available.

Opening the runtime performs all supported validation: SQLite integrity and
foreign keys, application/schema identity and migration checksum, immutable
history replay, cross-table invariants, and rehashing every evidence/prepared
artifact. A successful open is the restore validation. Do not call `purchase`,
`purchase_recover`, `treasury_operation_recover`, or any send tool during the
readback check.

After a successful isolated check, stop the process, atomically rename the
candidate into the selected production path, and retain the previous tree
read-only until reconciliation is complete.

## Corruption response

If Sompi reports database, schema, evidence, preparation, or history
corruption:

1. Stop MCP immediately. Leave the authority stopped unless it is needed to
   inspect already-signed public evidence.
2. Preserve the complete data directory, package version, policy file, trust
   files, logs, and filesystem metadata. Hash the preservation copy.
3. Do not run SQLite `.recover`, delete WAL files, edit rows, replace one
   content-addressed artifact, or let a newer binary migrate the only copy.
4. Restore the newest clean backup into a new directory and validate it as
   above.
5. Reconcile every Purchase and direct Treasury Movement created after the
   backup against exact transaction IDs, outpoints, Merchant status, and the
   chain before releasing capacity or attempting anything again.

If no clean backup exists, preserve the state and stop. Destructive reset is
not a recovery strategy for ambiguous money movement.

## Retention

Keep a backup long enough to verify every retained AP2 mandate/receipt and
Kaspa Settlement that depends on its trust keys. Deleting completed Purchase
evidence, prepared transactions, spend history, or old authority public keys
independently can make otherwise valid history unverifiable.
