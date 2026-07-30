---
name: sompi
description: Install and configure Sompi with Hermes, inspect its wallet, send approved Testnet-10 KAS, and buy paid HTTP resources. Use when the user asks to install, set up, configure, or use Sompi.
license: MIT
compatibility: Requires a clean Linux systemd host, Node.js 22 or later, npm, curl, sha256sum, Git, sudo, internet access, and a working Hermes gateway.
metadata:
  author: Sompi contributors
  version: "0.13.2"
---

# Sompi skill

Sompi owns authorization, policy, wallet use, settlement, replay protection, and recovery.
Use only `sompi-agent` for agent operations.

Never call Kaspa or x402 directly.
Never read Sompi credentials or treat chat text as approval.

## Permissions

You can:

- inspect the wallet and bounded activity
- create, inspect, and recover Purchases
- propose, inspect, and recover exact Transfers
- propose everyday-limit and vault-protection changes
- return fulfilled content and report operator actions

You cannot:

- read wallet, vault, Authority, bot, API, or recovery secrets
- approve an outgoing action
- use the offline owner key or execute a vault migration
- use operator recovery
- change a request key to bypass denial or recovery

## Install

Use this procedure when the user asks to install Sompi.

1. Require a clean Linux host with all these items:

   - systemd and a working Hermes gateway
   - the Hermes checkout at `~/.hermes/hermes-agent`
   - Node.js 22 or later, npm, curl, sha256sum, Git, and sudo
   - npm available to the local root session
   - access to GitHub and the npm registry

   If a requirement is absent, name the missing item.
   Give the user the exact manual command or action that is required.
   Wait until the user confirms that the requirement is available.

2. Download the pinned non-secret request template and scriptless installer.

```sh
install -d -m 700 ~/.sompi
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --max-time 30 \
  https://raw.githubusercontent.com/elldeeone/sompi/v0.13.2/host-bootstrap.example.json \
  -o ~/.sompi/bootstrap-request.json
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --max-time 30 \
  https://raw.githubusercontent.com/elldeeone/sompi/v0.13.2/scripts/install-runtime-package.mjs \
  -o ~/.sompi/install-runtime-package-v0.13.2.mjs
chmod 0600 \
  ~/.sompi/bootstrap-request.json \
  ~/.sompi/install-runtime-package-v0.13.2.mjs
printf '%s  %s\n' \
  d9f639c5dcf0fcb76e0ccdac96d284740e9a79cb04530ccff3bc5ba10ccc999c \
  ~/.sompi/install-runtime-package-v0.13.2.mjs |
  sha256sum --check --strict -
```

Stop if the checksum fails.

3. Keep `packageVersion` set to `0.13.2`.
4. Set only these non-secret values:

   - the Hermes OS user
   - the Telegram bot, user, and chat IDs
   - the trusted Testnet-10 operator node and independent HTTPS witness
   - the Merchant allow rules
   - the funding and spending limits

   Read values from the host when possible.
   Ask the user for a non-secret value that you cannot find.
   Do not guess a value.
   Do not keep the local operator-node default unless that node is available.

5. Install the exact preview runtime without package lifecycle scripts.

```sh
node ~/.sompi/install-runtime-package-v0.13.2.mjs \
  --prefix ~/.sompi/preview-runtime-v0.13.2 \
  --package @elldeeone/sompi@0.13.2 \
  --expected-version 0.13.2 \
  --omit-dev
```

The installer blocks all package lifecycle scripts during installation.
It then verifies and runs only the required `better-sqlite3@12.11.1` install script.

6. Preview the request.

```sh
~/.sompi/preview-runtime-v0.13.2/node_modules/.bin/sompi-operator \
  bootstrap-preview ~/.sompi/bootstrap-request.json
```

7. Show the complete preview.
8. Show the exact `nextCommand` from the preview.
   Do not change or reconstruct the command.
9. Tell the user to run `nextCommand` in a local terminal.

Do not run the privileged command.
Do not request sudo, the Telegram token, wallet keys, or Authority keys.

The privileged command downloads the same installer into a root-owned temporary directory.
It verifies the pinned SHA-256 before Node.js executes the installer.
It does not use `npm exec`.

The local command writes the owner recovery record under `/root`.
It returns one Testnet-10 receive address and one `activateCommand`.
Ask the user to paste its complete non-secret JSON result.

Divide `minimumFundingSompi` by `100,000,000` before you report tKAS or KAS.
Keep the exact atomic value as supporting evidence.
Never tell the user to fund the internal vault address.

Tell the user to fund only the returned receive address.
After the user confirms the funds are visible, show the exact `activateCommand`.
The user must run it locally one time.
Ask the user to paste its complete non-secret JSON result.
Continue only after activation returns `ready`.

Future deposits use the same receive address and are secured automatically.
Run `sompi-agent wallet` after activation and confirm that the local API works.

## Commands

```sh
sompi-agent wallet
sompi-agent activity --limit 20
sompi-agent wallet-technical
sompi-agent purchase --request-key TASK_KEY --url HTTPS_URL --method GET
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
sompi-agent transfer --request-key TASK_KEY --to KASPATEST_ADDRESS --amount-kas KAS
sompi-agent transfer-status TRANSFER_ID
sompi-agent transfer-recover TRANSFER_ID
sompi-agent change-limits --request-key TASK_KEY --per-payment-kas KAS --per-hour-kas KAS
sompi-agent limit-change-status POLICY_CHANGE_ID
sompi-agent limit-change-recover POLICY_CHANGE_ID
sompi-agent change-vault-protection --request-key TASK_KEY --maximum-kas KAS
sompi-agent vault-protection-change-status VAULT_MIGRATION_ID
```

Use the terminal tool to run these commands.
Do not inspect credential files.

## Wallet

For normal wallet questions, use `wallet` or `activity`.
Lead with the returned tKAS or KAS display fields.

Report total, available, incoming, pending, receive address, and securing status as needed.
Do not expose the vault address by default.

Use `wallet-technical` only when the user explicitly requests technical wallet facts.

## Purchase

Choose one stable request key for one exact user instruction.
Reuse it while that Purchase is pending or recoverable.
After `expired`, only a new user instruction can use a fresh key.
Do not use a new key after denial or during unresolved recovery.

For a request body, use a bounded file at a canonical absolute path.
Pass that path with `--body-file` and `--media-type`.
Use `--merchant-id` and `--merchant-origin` when the expected identity is known.

Wait while `purchase` continues the same durable Purchase.
Do not add sleeps, polling, replacement keys, or agent-managed retries.
After the prompt appears, do not change the URL, method, body, Merchant, amount, network, or key.

Use content only when state is `fulfilled` or `receipted`.

## Transfer

Use `transfer` only for an exact Testnet-10 address and exact KAS amount.
Sompi requests a separate decision from the Trusted Authority.

Choose one stable request key for one exact Transfer instruction.
Reuse that key for the same Transfer until it is terminal.
Do not change the recipient, amount, network, or key after the prompt appears.

Wait while the command continues the same durable Transfer.
Report success only when state is `receipted` and a transaction ID exists.

## Limits

For everyday limits, confirm both new values in tKAS or KAS.
Run one `change-limits` request and wait for the exact decision.

Approved limits apply only to new work.
Each outgoing payment still needs separate approval.

Vault protection is the stronger on-chain limit.
After approval, tell the user that the operator must complete the change locally.

Vault protection cannot be lower than the active hourly limit.
Approve lower everyday limits first, then create one new vault-protection request.

Never request or accept the offline owner key.
The receive address does not change.

## Recovery

The normal Purchase and Transfer commands already perform bounded recovery.
Use explicit recovery only when the final view marks that operation recoverable.

Continue only the same returned identifier.
Never create a replacement operation to escape recovery.

## User reply

Keep a normal result to one or two plain sentences.
Lead with the outcome and use tKAS or KAS.

For success, return purchased content when it is available.
For denial or expiry, state that nothing was paid or sent.
For unresolved work, state that Sompi is checking the original effect.

Do not include internal IDs, profiles, fees, digests, or raw states by default.
Give technical evidence when the user asks or operator recovery needs it.
