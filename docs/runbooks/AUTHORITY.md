# Trusted Authority operations

Status: initial testnet-10 operator runbook

Sompi's human-present AP2 mode requires two distinct, non-root OS users. The
`sompi-authority` user owns the approval signer and displays the approval
ceremony in a trusted terminal. The `sompi-mcp` user owns the Agent-facing MCP
process and cannot read that signer. A dedicated group grants access only to
the authenticated Unix socket.

This separation is a security invariant, not an optional hardening step. The
production composition root refuses to start as root or when the authority
socket owner UID equals the MCP UID.

## Filesystem topology

The following layout keeps all three security contexts disjoint:

| Context | Example path | Owner and mode |
|---|---|---|
| Authority private state | `/var/lib/sompi-authority/private` | `sompi-authority:sompi-authority`, `0700`; files `0600` |
| MCP client credentials | `/var/lib/sompi-mcp-authority-client` | `sompi-mcp:sompi-mcp`, `0700`; files `0600` |
| Shared socket runtime | `/run/sompi-authority` | `sompi-authority:sompi-ipc`, `0710` |
| Authority socket | `/run/sompi-authority/authority.sock` | `sompi-authority:sompi-ipc`, `0660` |
| MCP Purchase state | `/var/lib/sompi-mcp/testnet-10` | `sompi-mcp:sompi-mcp`, `0700` |

The client directory contains only a separate IPC MAC-key copy and public
trust store. It never contains, links to, or shares a parent with
`authority-private.jwk.json`. The IPC group has traverse permission on the
runtime directory, not write permission: it can connect to the `0660` socket
but cannot unlink or replace it.

## One-time installation

Run these account and directory commands as root. Adapt the installed package
path in later commands, but keep the ownership and separation unchanged.

```bash
groupadd --system sompi-ipc
useradd --system --home-dir /var/lib/sompi-authority --create-home \
  --shell /usr/sbin/nologin sompi-authority
useradd --system --home-dir /var/lib/sompi-mcp --create-home \
  --shell /usr/sbin/nologin sompi-mcp
usermod --append --groups sompi-ipc sompi-authority
usermod --append --groups sompi-ipc sompi-mcp

install -d -o sompi-authority -g sompi-authority -m 0700 \
  /var/lib/sompi-authority/private
install -d -o sompi-authority -g sompi-authority -m 0700 \
  /var/lib/sompi-mcp-authority-client
install -d -o sompi-authority -g sompi-authority -m 0700 \
  /run/sompi-authority
install -d -o sompi-mcp -g sompi-mcp -m 0700 \
  /var/lib/sompi-mcp/testnet-10
```

`/run` is normally ephemeral. On a systemd host, persist the runtime-directory
rule `d /run/sompi-authority 0710 sompi-authority sompi-ipc -` in
`/etc/tmpfiles.d/sompi-authority.conf` and apply it with
`systemd-tmpfiles --create /etc/tmpfiles.d/sompi-authority.conf`. Otherwise the
operator must recreate the directory with the exact owner and mode above after
every reboot, before starting the authority.

Initialise once as the authority user. `sompi-authority init` deliberately
refuses to overwrite any credential.

```bash
sudo -u sompi-authority env \
  HOME=/var/lib/sompi-authority \
  SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-mcp-authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:local \
  SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1 \
  /opt/sompi/node_modules/.bin/sompi-authority init
```

The command prints the new public authority trust entry, never the private
key. Store that public entry with the Merchant's checkout key and its two
distinct receipt keys. Install the resulting JSON array atomically as both:

- `/var/lib/sompi-authority/private/trust.json`, owned by
  `sompi-authority:sompi-authority`, mode `0600`; and
- `/var/lib/sompi-mcp-authority-client/trust.json`, owned by
  `sompi-mcp:sompi-mcp`, mode `0600`.

Each entry has the strict shape `{role, issuer, kid, publicJwk}`. The initial
profile permits roles `authority`, `merchant-checkout`, `merchant-receipt`, and
`payment-receipt`. Trust only keys obtained through an authenticated operator
channel. Never accept a key URL or key embedded in Merchant content.

After installing the final trust files, remove the redundant one-entry
bootstrap file and transfer only the separate client MAC copy and `trust.json`
to the MCP user. Initialization resets all three bootstrap directories to
`0700`, so this explicit finalization step is required:

```bash
rm /var/lib/sompi-mcp-authority-client/authority-public-trust-entry.json
chown -R sompi-mcp:sompi-mcp /var/lib/sompi-mcp-authority-client
chmod 0700 /var/lib/sompi-mcp-authority-client
chmod 0600 \
  /var/lib/sompi-mcp-authority-client/ipc-mac.key \
  /var/lib/sompi-mcp-authority-client/trust.json

chown sompi-authority:sompi-ipc /run/sompi-authority
chmod 0710 /run/sompi-authority
```

Do not copy with hard links. The authority and MCP MAC/trust files must be
different filesystem entries even though each pair initially has matching
content.

## Start and verify

Start the authority first in a dedicated trusted terminal. It is intentionally
a foreground human-approval process: each approval shows the exact canonical
Purchase facts and succeeds only when the operator types the exact Purchase
ID. Do not redirect its input from the Agent, the MCP process, or Merchant
content.

```bash
AUTHORITY_UID=$(id -u sompi-authority)
IPC_GID=$(getent group sompi-ipc | cut -d: -f3)

sudo -u sompi-authority env \
  HOME=/var/lib/sompi-authority \
  SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-mcp-authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_SOCKET_GID="$IPC_GID" \
  SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:local \
  SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1 \
  SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1 \
  SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury \
  /opt/sompi/node_modules/.bin/sompi-authority
```

While it is listening, run the packaged boundary verifier as root:

```bash
node /opt/sompi/scripts/verify-authority-isolation.js \
  --authority-user sompi-authority \
  --mcp-user sompi-mcp \
  --ipc-group sompi-ipc \
  --private-dir /var/lib/sompi-authority/private \
  --client-dir /var/lib/sompi-mcp-authority-client \
  --runtime-dir /run/sompi-authority \
  --socket /run/sompi-authority/authority.sock
```

Do not start the MCP service unless this reports `status: pass` and
`signingKeyReadableByMcp: false`. The verifier also opens a zero-frame socket
connection as the MCP user to prove effective group access; this cannot request
or approve a Purchase. It requires the client directory to contain exactly
`ipc-mac.key` and `trust.json` and confirms the MCP user has no write access to
the runtime directory.

The MCP process needs the matching public identifiers and numeric socket
ownership, plus its normal policy, Merchant, egress, wallet, and RPC settings:

```bash
sudo -u sompi-mcp env \
  HOME=/var/lib/sompi-mcp \
  SOMPI_NETWORK=testnet-10 \
  SOMPI_OPERATOR_MANIFEST=/etc/sompi/operator-manifest.json \
  SOMPI_OPERATOR_UID=0 \
  SOMPI_RUNTIME_GID="$IPC_GID" \
  SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-mcp-authority-client \
  SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority \
  SOMPI_AUTHORITY_SOCKET=/run/sompi-authority/authority.sock \
  SOMPI_AUTHORITY_SOCKET_UID="$AUTHORITY_UID" \
  SOMPI_AUTHORITY_SOCKET_GID="$IPC_GID" \
  SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:local \
  SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1 \
  SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury \
  /opt/sompi/node_modules/.bin/sompi-mcp
```

The manifest's two receipt issuers must be distinct and must match separate
trusted keys. The first release fails closed on every network except testnet-10.

## Hermetic release proof

The source/CI proof uses a digest-pinned Node 22 container, installs the locked
dependencies, builds the current source snapshot, and provisions two real
non-root users plus one IPC group. It starts both production executables and
emits one secret-free JSON report on stdout:

```bash
(umask 077; ./test/authority-isolation/run-container-proof.sh \
  > /tmp/sompi-authority-isolation-proof.json)
```

The proof fails unless all of these facts are observed in the disposable
container:

- authority initialization and the listening socket run under the authority
  UID;
- only the MAC and public trust copies are transferred to the MCP UID;
- the release root verifier passes and the MCP UID can connect;
- the MCP UID cannot read the private JWK, create a runtime entry, or unlink
  the authority socket;
- the real `sompi-mcp` production composition reaches its ready state as the
  distinct MCP UID; and
- `sompi-mcp` startup as root or with the authority UID fails closed.

This Docker proof is a source/CI asset rather than an installed operator
command. The root verifier is included in the packed release and remains the
required check on the real host. The report records the image digest, source
snapshot and built-tree digests, entrypoint/verifier/runbook digests, numeric
identities, checks, and limitations; it never contains credential bytes,
generated wallet keys, or authority/MCP stderr.

## Normal approval and recovery

1. Leave the authority terminal visible to the human operator.
2. Read every displayed Merchant, URL, request fingerprint, atomic KAS amount,
   payee, expiry, and additional-cost ceiling.
3. Type the exact Purchase ID only when all fields are intended. Any other
   input denies.
4. A request marked `recoveryRetry: true` is the same durable request being
   reacquired after interruption; compare its fields again before approval.
5. Use `purchase_status` or `purchase_recover` from MCP after a restart. Never
   delete the Purchase Journal or submit a payment manually to make progress.

Authority IPC requests are authenticated, freshness-bound, replay-protected,
and deterministic. A retry uses the same durable request identity; it does not
give the MCP process a new approval surface.

## Backup

Stop the authority before backing up its private directory. Copy it to an
encrypted, offline destination while preserving ownership and mode. It
contains the signing key, server MAC copy, trust store, replay database, and
decision database. Back up the MCP Purchase state separately using the journal
procedure in [`JOURNAL.md`](JOURNAL.md).

Never back up a live SQLite database by copying only its main file while WAL is
active. Never place authority private state in the same archive or access
policy as the MCP client directory.

## Rotation

Rotation is a coordinated stop operation:

1. stop MCP and authority;
2. back up both durable stores;
3. initialise a new, empty authority path with a new signing `kid` and IPC key;
4. retain the old public authority key in both trust stores so historical
   evidence remains verifiable, and add the new public key;
5. transfer only the new client MAC copy and public trust store to the MCP
   owner;
6. switch both processes to the new paths and identifiers;
7. rerun the isolation verifier before resuming Purchases.

Do not overwrite key files in place or mix a new server MAC copy with an old
client copy. Remove an old public verification key only after the retention
period for every Purchase it signed has ended.

## Suspected compromise

- Stop both processes and preserve the Purchase Journal, authority databases,
  logs, trust files, and filesystem metadata as evidence.
- If only the MCP user is compromised, assume its wallet/vault execution key
  and client MAC copy are exposed. The separate authority signer is not
  automatically compromised; verify that with the root boundary checker.
- If the authority private directory may be exposed, treat all decisions from
  that key as suspect, rotate to a new issuer/key, and require explicit
  operator reconciliation before continuing.
- Do not erase, recreate, or blindly resubmit ambiguous effects. Follow
  [`RECONCILIATION.md`](RECONCILIATION.md).

This runbook proves local process and credential separation. It does not claim
hardware-backed signing, passkey security, mainnet readiness, or protection
against a host root compromise.
