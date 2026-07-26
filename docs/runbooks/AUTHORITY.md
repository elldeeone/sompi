# Trusted Authority

Scope: human-present authorization on Kaspa Testnet-10.

`sompi-authority` is a separate deterministic process.
It displays exact decision facts and signs one human decision.

Telegram is the normal decision surface.
A protected local terminal can be an operator-controlled alternative.
Ordinary chat text and agent actions are never approval.

## Access boundary

| Principal | Owns | Cannot access |
|---|---|---|
| Operator | manifest and credentials | live agent session |
| `sompi-authority` | signer, decision store, replay store | wallet and Journal |
| `sompi-api` | Journal, Treasury, adapters | Authority signer |
| Agent or MCP | Agent API credential | Authority, wallet, recovery |

Use separate non-root service accounts.
Use one group for Authority IPC and one group for operator recovery.
The bootstrap uses the selected agent's primary group for both the Agent API
and Telegram callback sockets.

## Required paths

| Path | Owner and mode |
|---|---|
| `/var/lib/sompi-authority/private` | Authority, directory `0700`, files `0600` |
| `/var/lib/sompi-authority-client` | Authority during initialization; API after handoff; directory `0700`, files `0600` |
| `/run/sompi-authority/authority.sock` | Authority and IPC group, `0660` |
| `/run/sompi-telegram-callback` | Authority and selected Hermes primary group, directory `2710` |
| `/run/sompi-telegram-callback/telegram-callback.sock` | Authority and selected Hermes primary group, `0660` |
| `/run/sompi-api/sompi.sock` | API and selected Hermes primary group, `0660` |
| `/run/sompi-recovery/recovery.sock` | API and recovery group, `0660` |

Use disjoint canonical paths.
Do not use links.

## Initialize

Create the private, client, and runtime directories before initialization:

```bash
sudo install -d -o sompi-authority -g sompi-authority -m 0700 \
  /var/lib/sompi-authority \
  /var/lib/sompi-authority/private
sudo install -d -o sompi-authority -g sompi-authority -m 0700 \
  /var/lib/sompi-authority-client
sudo install -d -o sompi-authority -g AUTHORITY_IPC_GROUP -m 0710 \
  /run/sompi-authority
sudo install -d -o sompi-authority -g HERMES_PRIMARY_GROUP -m 2710 \
  /run/sompi-telegram-callback
```

The set-group-ID directory gives the callback socket the selected Hermes
primary group. Do not add the Authority account to that group.

Then, run initialization once as the Authority account:

```bash
sudo -u sompi-authority env \
  SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_CALLBACK_RUNTIME_DIR=/run/sompi-telegram-callback \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:local \
  SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1 \
  sompi-authority init
```

Initialization does not overwrite credentials.
It prints public trust material only.

After initialization, transfer the client directory and its files to the API
account. Keep directory mode `0700` and file mode `0600`.
The directory contains `ipc-mac.key`, `trust.json`, and
`authority-public-trust-entry.json`.
Never give the API or agent access to the private Authority directory.

## Start

Start services in this order:

1. `sompi-authority`
2. `sompi-api`
3. Hermes or `sompi-mcp`

The generated systemd unit is the primary start configuration.
For a manual start, provide the complete installed environment:

```bash
sudo -u sompi-authority env \
  SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_CALLBACK_RUNTIME_DIR=/run/sompi-telegram-callback \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_SOCKET_GID=AUTHORITY_IPC_GID \
  SOMPI_AUTHORITY_CALLBACK_SOCKET_GID=CALLBACK_GID \
  SOMPI_AUTHORITY_ISSUER=INSTALLED_AUTHORITY_ISSUER \
  SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1 \
  SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1 \
  SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury \
  SOMPI_OPERATOR_MANIFEST=/etc/sompi-authority/operator-manifest.json \
  SOMPI_OPERATOR_UID=0 \
  SOMPI_RUNTIME_GID=AUTHORITY_IPC_GID \
  sompi-authority
```

Keep its terminal and Telegram token outside agent access.

Give MCP only the Agent socket and Agent credential.
Hermes uses its primary group for the Agent and callback sockets.
Neither process receives Authority IPC, recovery, wallet, or operator access.

## Decide

Before approval, check the Merchant or recipient, action, amount, maximum cost, network, and expiry.
Open advanced details when you must verify fees, identifiers, profiles, or finality.

Select Approve or Deny only on the exact bound Telegram decision card.
For local terminal mode, enter only the exact displayed identifier.

A denial spends nothing.
No response expires safely.
A second callback is rejected as replay.

## Backup and compromise

Stop the Authority before backup.
Back up its complete private directory as one encrypted, offline set.
Back up API state separately.

If a boundary is compromised, stop the affected services and preserve evidence.
Rotate that boundary with a coordinated stop:

1. Stop Hermes or MCP, API, and Authority.
2. Back up Authority and API state separately.
3. Initialize a new Authority path and key ID.
4. Keep old public keys while retained evidence needs them.
5. Transfer only the new client MAC copy and trust store to the API.
6. Restart Authority, API, and Hermes.

Reconcile every possible external effect.
Do not delete state or submit a payment manually.

This design does not protect against host-root compromise.
