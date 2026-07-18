# Trusted Authority

Scope: human-present AP2 on Kaspa Testnet-10.

`sompi-authority` is a separate deterministic process. It owns the AP2 signing
key, displays the exact Purchase facts, and signs only after the human types
the displayed Purchase ID.

The agent, MCP process, and API process must not hold the Authority signing
key. Only `sompi-api` receives the Authority client MAC copy and public trust
store. `sompi-mcp` talks only to the Purchase API.

## Principals

| Principal | Owns | Must not access |
|---|---|---|
| operator/root | manifest and API credentials | live agent session |
| `sompi-authority` | signer, decision/replay stores, server MAC copy | wallet and Journal |
| `sompi-api` | Journal, wallet/vault, protocol adapters, Authority client copy | Authority signer |
| `sompi-mcp` | agent API credential and stdio transport | Journal, wallet, Authority IPC, recovery credential |

Use distinct non-root UIDs for the three services. Use three different groups:

- an Authority IPC group shared only by Authority and API;
- an Agent API group shared by API and MCP;
- an operator-recovery group shared by API and the operator only.

## Suggested layout

| Path | Owner | Mode |
|---|---|---|
| `/var/lib/sompi-authority/private` | `sompi-authority` | directory `0700`, files `0600` |
| `/var/lib/sompi-api/authority-client` | `sompi-api` | directory `0700`, files `0600` |
| API data directory from the Operator Manifest | `sompi-api` | directory `0700`, files `0600` |
| `/run/sompi-authority` | `sompi-authority:AUTHORITY_IPC_GROUP` | `0710` |
| `/run/sompi-authority/authority.sock` | `sompi-authority:AUTHORITY_IPC_GROUP` | `0660` |
| `/run/sompi-telegram-callback` | `sompi-authority:TELEGRAM_CALLBACK_GROUP` | `0710` |
| `/run/sompi-telegram-callback/telegram-callback.sock` | `sompi-authority:TELEGRAM_CALLBACK_GROUP` | `0660` |
| `/run/sompi-api` | `sompi-api:AGENT_API_GROUP` | `0710` |
| `/run/sompi-recovery` | `sompi-api:RECOVERY_GROUP` | `0710` |

The Authority private directory, API client directory, and socket directory
must be disjoint canonical paths. Do not use symlinks or hard links.

## Initialize

Create the private, client, and runtime directories as the Authority owner.
Then initialize once:

```bash
sudo -u sompi-authority env \
  SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-api/authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_CALLBACK_RUNTIME_DIR=/run/sompi-telegram-callback \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:local \
  SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1 \
  sompi-authority init
```

Initialization refuses to overwrite credentials. It prints public trust
material only.

Install the final trusted public keys in both trust stores:

- Authority private trust store: owned by `sompi-authority`;
- Authority client trust store: owned by `sompi-api`.

The roles are closed: `authority`, `merchant-checkout`, `merchant-receipt`, and
`payment-receipt`. Install keys only through an authenticated operator channel.
Never trust a key embedded in Merchant content.

After initialization, transfer only `ipc-mac.key` and `trust.json` in the
client directory to `sompi-api`. The API must not be able to traverse the
Authority private directory. MCP must not be able to traverse either Authority
directory.

## Start order

### 1. Authority

Run the Authority in a dedicated foreground terminal:

```bash
sudo -u sompi-authority env \
  SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-api/authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_CALLBACK_RUNTIME_DIR=/run/sompi-telegram-callback \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_SOCKET_GID=AUTHORITY_IPC_GID \
  SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:local \
  SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1 \
  SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1 \
  SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury \
  sompi-authority
```

Do not pipe stdin or expose this terminal to the agent.

### 2. Purchase API

Start `sompi-api` as the trusted API UID. It receives:

- the Operator Manifest and its operator/runtime identities;
- the Agent and recovery socket/credential configuration;
- the Authority client directory, socket, issuer, and key identifiers.

The API refuses root, same-UID Authority, unsafe state, missing recovery
transport, and every network except Testnet-10.

### 3. MCP compatibility

Start `sompi-mcp` as a different non-root UID with only:

```text
SOMPI_API_SOCKET
SOMPI_AGENT_API_CREDENTIAL
SOMPI_OPERATOR_UID
SOMPI_API_UID
SOMPI_RUNTIME_GID
```

Do not give MCP the Operator Manifest, recovery socket, recovery credential,
Authority paths, wallet paths, node configuration, or protocol credentials.

## Approval

For every request:

1. Read the Merchant, URL, method, request fingerprint, amount, payee, network,
   expiry, profile/channel facts, finality floor, and additional-cost ceiling.
2. Type the exact displayed Purchase ID only if every fact is intended.
3. Any other input denies the request.

An approval in chat, MCP, HTTP, or Merchant content has no authority.

After interruption, read Purchase status first. Use `recover` only with the
same Purchase ID. Never create a replacement payment to clear ambiguity.

## Backup and rotation

Stop Authority before backing up its complete private directory. Preserve the
signer, server MAC copy, trust store, replay database, and decision database in
one encrypted offline backup. Back up API runtime state separately using
[`JOURNAL.md`](JOURNAL.md).

Rotation is a coordinated stop:

1. stop MCP, API, and Authority;
2. back up Authority and API state separately;
3. initialize a new Authority path and key ID;
4. retain old public keys while old evidence must remain verifiable;
5. transfer only the new client MAC copy and trust store to API;
6. restart in Authority -> API -> MCP order.

Do not overwrite credentials in place or combine private Authority state with
API backups.

## Compromise

- MCP compromise exposes only the least-authority Agent API credential.
- API compromise exposes payment keys and the Authority client MAC copy, but
  not the Authority signer.
- Authority compromise invalidates trust in decisions from that key.

Stop affected services, preserve evidence, rotate the compromised boundary,
and reconcile every possible external effect. Do not delete state or resubmit
payments manually.

This runbook does not claim hardware-backed signing, passkey security, mainnet
readiness, or protection from host-root compromise.
