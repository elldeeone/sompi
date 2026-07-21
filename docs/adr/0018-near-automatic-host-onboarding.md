# ADR-0018: Near-automatic host onboarding through the trusted operator

- Status: Accepted
- Date: 2026-07-19
- Amended: 2026-07-21 (the compatibility tree is an independently updateable
  Git checkout rather than a metadata-free copy)
- Amends: ADR-0011 and ADR-0016

## Context

The published package contains the secure provisioning primitives, but a fresh
host still requires the operator to assemble users, groups, services, sockets,
Authority state, API credentials, and agent integration by hand. That is too
easy to get wrong and prevents an agent user from starting with one simple
instruction.

Giving the agent root access, an owner recovery key, an Authority key, or a
Telegram bot token would make installation easy by destroying the boundary the
installation is meant to create. A moving `curl | sh` installer has the same
problem: the operator cannot bind the privileged action to reviewed bytes and
an exact configuration.

## Decision

Extend `sompi-operator` with one Linux host-bootstrap workflow. It remains a
short-lived, deterministic administrative command; it is not a daemon and is
never exposed through the Purchase API, MCP, or an agent tool.

Onboarding has three parts:

1. An unprivileged agent may install the pinned Sompi skill, gather only
   non-secret host and policy facts, write a bounded bootstrap request, and run
   a side-effect-free preview.
2. The human runs one local privileged command containing the preview digest.
   The command re-reads the exact request, verifies the digest and package
   version, performs the installation, and returns only public status and the
   path of the root-only recovery record.
3. The user funds the returned normal wallet address, then runs the returned
   local activation command. Activation revalidates the same request digest,
   journals and reconciles one covenant deposit, and returns the active vault
   identity. Ordinary funds are never sent directly to the P2SH vault address.

The privileged bootstrap owns the complete transaction:

- install one exact package release under `/opt/sompi/releases/`;
- create distinct API, Authority, IPC, and recovery principals, using the
  selected agent's existing primary group only for its two local sockets;
- generate the vault owner and Agent keys, publishing the owner secret only to
  a root-owned recovery file;
- initialize the isolated Authority and consume a root-only Telegram bot-token
  file without printing it;
- install immutable manifests, API credentials, runtime directories, hardened
  systemd units, and socket directories;
- install the agent skill and least-authority callback plugin;
- enable only the required Hermes configuration and environment;
- start Authority before API, restart the agent gateway, and run fail-closed
  health checks;
- keep a durable bootstrap receipt and remove incomplete state on failure when
  no funded or externally effective state exists.

The request cannot contain secret key material. It pins Testnet-10, the exact
Sompi package version, the agent OS user, policy limits, Merchant allow rules,
Chain Evidence sources, Telegram identities, and the root-only bot-token and
recovery-file paths. Unknown fields and unsupported profiles fail closed.

Hermes Telegram approval additionally requires the generic authorized plugin
callback hook recorded by ADR-0016. Bootstrap detects the native hook. During
the alpha period it may install a bundled compatibility patch only when
`git apply --check` proves the exact required hook patch applies cleanly to an
isolated Git checkout. That checkout preserves the selected branch and real
upstream remote so Hermes updates the exact tree the gateway executes. It
never applies fuzz or edits the user's primary Hermes checkout. The
compatibility step is removed once supported Hermes releases provide the hook.

The agent-facing skill does not run the privileged command, answer its prompt,
read its receipt, fund the wallet, activate the vault, or claim installation
success. It reports the exact local commands and later uses only `sompi-agent`.

## Consequences

- A user can tell an agent to install Sompi, complete one local install
  ceremony, fund one address, and run one local activation command.
- Repeating the same request is inspectable and idempotent; changing it changes
  the approval digest.
- Secrets never pass through agent context, chat, shell arguments, logs, or
  package configuration.
- Unsupported hosts or Hermes revisions fail before partial activation.
- Funding remains explicit; the bootstrap exposes a normal funding address and
  the activation command creates the spending-limited vault head.

## Rejected alternatives

- Give the agent sudo or operator credentials: collapses the trust boundary.
- Put setup in MCP: makes the constrained principal its own administrator.
- `curl | sh` from a moving branch: does not pin reviewed code or intent.
- Ask users to keep following the manual runbooks: too much fragile host work.
- Run a second Telegram poller or public relay: conflicts with the selected
  same-chat Authority design and adds unnecessary infrastructure.
