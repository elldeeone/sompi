# Operator provisioning

Run `sompi-operator` only from a trusted local operator session.
Do not run it from an agent or MCP session.

Use separate operator, API, Authority, Agent, and recovery access boundaries.

## Host bootstrap

Edit the non-secret `host-bootstrap.example.json` template.
Set `packageVersion` to `0.13.0`.
Set the Hermes user, Telegram IDs, Testnet-10 node, Merchant rules, and limits.

Download and verify the scriptless installer:

```bash
install -d -m 700 ~/.sompi
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --max-time 30 \
  https://raw.githubusercontent.com/elldeeone/sompi/v0.13.0/scripts/install-runtime-package.mjs \
  -o ~/.sompi/install-runtime-package-v0.13.0.mjs
chmod 0600 ~/.sompi/install-runtime-package-v0.13.0.mjs
printf '%s  %s\n' \
  5636810d34f3c253fef8d503b7829b8f4518eefa31b591184be515cca6840411 \
  ~/.sompi/install-runtime-package-v0.13.0.mjs |
  sha256sum --check --strict -
```

Stop if the checksum fails.
Install the preview runtime:

```bash
node ~/.sompi/install-runtime-package-v0.13.0.mjs \
  --prefix ~/.sompi/preview-runtime-v0.13.0 \
  --package @elldeeone/sompi@0.13.0 \
  --expected-version 0.13.0 \
  --omit-dev
```

Preview the request:

```bash
~/.sompi/preview-runtime-v0.13.0/node_modules/.bin/sompi-operator \
  bootstrap-preview REQUEST.json
```

Review all output.
The `nextCommand` must start with `sudo sh -eu -c`.
It must contain the pinned installer URL and SHA-256.
It must not contain `npm exec`.
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
The selected Hermes user's existing primary group owns the Agent API socket
directory.
The Hermes user does not get a Sompi supplementary group.

```bash
install -d -o root -g sompi-api -m 0750 /etc/sompi
install -d -o root -g SOMPI_RECOVERY_GROUP -m 0750 /etc/sompi-recovery
install -d -o SOMPI_AUTHORITY_USER -g HERMES_PRIMARY_GROUP -m 2710 \
  /run/sompi-telegram-callback
install -d -o SOMPI_API_USER -g HERMES_PRIMARY_GROUP -m 2710 /run/sompi-api
install -d -o SOMPI_API_USER -g SOMPI_RECOVERY_GROUP -m 0710 /run/sompi-recovery
sompi-operator recovery-credential \
  /etc/sompi-recovery/recovery-api.json 0 RECOVERY_GID
```

The host bootstrap creates one Agent bearer and installs these two files:

| Use | Path | Owner and mode |
|---|---|---|
| API server | `/etc/sompi/agent-api.json` | `root:sompi-api`, `0640` |
| Hermes client | `~/.sompi/agent-api.json` | selected Hermes user, `0600` |

The two files contain the same bearer.
The `sompi-operator agent-credential` command creates only one file with a new
bearer.
It does not create the required pair.
Do not run it once for each path.
If the pair is absent or invalid, stop Hermes and `sompi-api`.
There is no in-place credential-pair repair command.
Do not replace only one copy.
Keep the current host state for inspection.
Prepare a clean replacement host and run a reviewed Host Bootstrap request.

The recovery credential is
`/etc/sompi-recovery/recovery-api.json`.
It has owner `root`, group `SOMPI_RECOVERY_GROUP`, and mode `0640`.
The recovery socket directory has mode `0710`.
It does not use the Hermes primary group.

Set the API server environment as follows:

```text
SOMPI_AGENT_API_CREDENTIAL=/etc/sompi/agent-api.json
SOMPI_RUNTIME_GID=<sompi-api group gid>
SOMPI_API_SOCKET_GID=<selected Hermes primary group gid>
```

Set the Hermes environment as follows:

```text
PYTHONDONTWRITEBYTECODE=1
SOMPI_AGENT_API_CREDENTIAL=<Hermes home>/.sompi/agent-api.json
SOMPI_RUNTIME_GID=<selected Hermes primary group gid>
SOMPI_API_SOCKET_GID=<selected Hermes primary group gid>
```

Give Hermes only its socket and client credential.
Use `PYTHONDONTWRITEBYTECODE=1` for the Hermes configuration commands and
gateway service.
Do not add Hermes to `sompi-api`, Authority IPC, or recovery groups.
Give operator recovery its separate `0710` socket directory, group,
credential, and request pool.
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
  SOMPI_RUNTIME_GID=SOMPI_API_GID \
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
