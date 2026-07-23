# Operator provisioning

Run `sompi-operator` only from a trusted local operator session.
Do not run it from an agent or MCP session.

Use separate operator, API, Authority, Agent, and recovery access boundaries.

## Host bootstrap

Edit the non-secret `host-bootstrap.example.json` template.
Set `packageVersion` to `0.12.1`.
Set the Hermes user, Telegram IDs, Testnet-10 node, Merchant rules, and limits.

Preview the request:

```bash
npm exec --yes --allow-scripts=better-sqlite3@12.11.1 \
  --package=@elldeeone/sompi@0.12.1 -- \
  sompi-operator bootstrap-preview REQUEST.json
```

Review all output.
The `nextCommand` must start with the pinned `sudo npm exec` invocation.
Do not use a bare `sudo sompi-operator` command on a clean host.
Run the exact returned `nextCommand` in a local terminal.

The command reads the Telegram token with hidden input.
It installs Sompi and writes the owner recovery record under `/root`.
Do not give either secret to the agent.

The `ready` receipt gives one receive address, `minimumFundingSompi`, and one `activateCommand`.
Divide the minimum by `100,000,000` before you report tKAS.
Fund only the receive address.
Run `activateCommand` locally one time.

Future deposits to that receive address are secured automatically.
Do not send ordinary funds directly to the internal vault address.
An ordinary direct transfer has no covenant binding and is not active vault state.

## Manual provisioning

1. Run `sompi-operator owner-key` in a trusted context.
2. Keep the private owner key offline.
3. Put only its public key in `operator.example.json`.
4. Set runtime paths, Merchant rules, limits, node, witness, and finality floors.
5. Run `sompi-operator preview SPEC.json`.
6. Run `sompi-operator provision SPEC.json CANDIDATE_DIR`.
7. Review the candidate manifest, receipt, digest, and vault address.

Do not fund the candidate before installation.

Install the exact reviewed digest:

```bash
sompi-operator install CANDIDATE_DIR /etc/sompi/operator-manifest.json \
  sha256:REVIEWED_DIGEST OPERATOR_UID API_UID RUNTIME_GID
```

Verify the installed boundary:

```bash
sompi-operator status /etc/sompi/operator-manifest.json \
  OPERATOR_UID RUNTIME_UID RUNTIME_GID
```

## API transports

Create separate Agent and recovery transports.

```bash
install -d -o SOMPI_OPERATOR_USER -g SOMPI_RUNTIME_GROUP -m 0750 /etc/sompi
install -d -o SOMPI_API_USER -g SOMPI_RUNTIME_GROUP -m 0710 /run/sompi-api
install -d -o SOMPI_API_USER -g SOMPI_RECOVERY_GROUP -m 0710 /run/sompi-recovery
sompi-operator agent-credential \
  /etc/sompi/agent-api.json OPERATOR_UID RUNTIME_GID
sompi-operator recovery-credential \
  /etc/sompi/recovery-api.json OPERATOR_UID RECOVERY_GID
```

Give the Agent only its socket and credential.
Give operator recovery its separate socket, group, credential, and request pool.
TCP transport is disabled.

Use the bootstrap-generated `sompi-api.service` as the source of runtime configuration.
It must provide the manifest, network, UIDs, GIDs, both API transports, and Authority client settings.
Do not start the API from the short socket configuration alone.

## Prepare the owner key

The bootstrap recovery record is JSON. Owner commands require a temporary
file that contains only the 64-hex `ownerPrivate` value.

Create that file in a root terminal on the memory-backed `/run` filesystem:

```bash
set -e
umask 077
sompi_owner_key_file=$(mktemp /run/sompi-owner-key.XXXXXX)
trap 'rm -f -- "$sompi_owner_key_file"' EXIT HUP INT TERM
node --input-type=module -e '
  import fs from "node:fs";
  const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const key = record.ownerPrivate;
  if (typeof key !== "string" || !/^[0-9A-Fa-f]{64}$/.test(key)) {
    throw new Error("owner recovery record is invalid");
  }
  process.stdout.write(`${key}\n`);
' /root/sompi-owner-recovery.json > "$sompi_owner_key_file"
chmod 0600 "$sompi_owner_key_file"
```

Use `$sompi_owner_key_file` only in the same root terminal.
The trap removes it when that terminal exits.

## Change vault protection

The chat decision authorizes only the exact migration plan.
The offline owner key must complete it locally.
Vault protection cannot be lower than the active hourly limit.
Approve lower everyday limits before you create the migration request.

1. Approve the exact change through the Authority.
2. Copy only the Vault Migration ID to the operator terminal.
3. Stop Agent traffic and the Hermes gateway.
4. Stop `sompi-api` and preserve its complete service environment.
5. Back up the complete API state.
6. Prepare the temporary owner-key file as shown above.
7. Execute that ID with the temporary key file.

```bash
sudo env \
  SOMPI_NETWORK=testnet-10 \
  SOMPI_OPERATOR_MANIFEST=/etc/sompi/operator-manifest.json \
  SOMPI_OPERATOR_UID=0 \
  SOMPI_API_UID=API_UID \
  SOMPI_RUNTIME_GID=AGENT_API_GID \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_SOCKET_UID=AUTHORITY_UID \
  SOMPI_AUTHORITY_SOCKET_GID=AUTHORITY_IPC_GID \
  SOMPI_AUTHORITY_ISSUER=INSTALLED_AUTHORITY_ISSUER \
  SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1 \
  SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury \
  sompi-operator vault-migrate execute \
    VAULT_MIGRATION_ID "$sompi_owner_key_file"
```

For an uncertain result, recover the same ID:

Use the same installed environment and replace `execute` with `recover`.

Do not start a second migration.
Sompi pauses outward work and preserves the rolling spend value.
The user's receive address does not change.

Keep the API and Hermes stopped while the migration needs reconciliation.
After the same migration is applied or safely recovered, remove the temporary
key file. Start `sompi-api`, verify its status, and then start Hermes.

```bash
rm -f -- "$sompi_owner_key_file"
```

## Owner recovery

Use `sompi-vault-recover` only in a trusted operator context.
Before recovery:

1. Stop Agent traffic and Hermes.
2. Use operator recovery to reconcile every possible external effect.
3. Stop `sompi-api` after all effects are terminal.
4. Back up the complete API and Authority state separately.
5. Prepare the temporary owner-key file as shown above.

```bash
SOMPI_NETWORK=testnet-10 \
SOMPI_NODE_URL=wss://TRUSTED_TESTNET_NODE/ \
sompi-vault-recover \
  --owner-key-file "$sompi_owner_key_file" \
  --vault-config /secure/vault-config.json \
  --destination KASPATEST_ADDRESS \
  --fee-sompi REVIEWED_FEE
```

This command uses the unrestricted owner path and broadcasts directly.
It does not use the Journal or the Agent rolling-window limit.
Record its transaction ID and verify finality with the operator node and independent witness.
After an uncertain submission, observe that transaction before any new action.

Remove the temporary owner-key file after the command.
Do not restart the old API until the recovery transaction is final and the
operator has retired or reprovisioned the spent vault state.

```bash
rm -f -- "$sompi_owner_key_file"
```

Never put the owner key in shell history, chat, MCP arguments, API state, or a backup report.

Do not edit the manifest, vault files, policy snapshots, or funded vault parameters by hand.
