---
name: sompi
description: Install Sompi, inspect its wallet, send approved Testnet-10 KAS, and buy paid HTTP resources.
version: 0.12.0
author: Sompi contributors
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [kaspa, payments, api]
    category: blockchain
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

1. Require Linux, systemd, Node.js 22 or later, and a working Hermes gateway.
2. Copy the non-secret request template from the same pinned Sompi checkout.

```sh
install -d -m 700 ~/.sompi
install -m 600 \
  /absolute/path/to/pinned-sompi/host-bootstrap.example.json \
  ~/.sompi/bootstrap-request.json
```

3. Set `packageVersion` to `0.12.0`.
4. Set only the Hermes user, Telegram IDs, Testnet-10 node, Merchant rules, and limits.
5. Preview the request.

```sh
npm exec --yes --allow-scripts=better-sqlite3@12.11.1 \
  --package=@elldeeone/sompi@0.12.0 -- \
  sompi-operator bootstrap-preview ~/.sompi/bootstrap-request.json
```

6. Show the complete preview and exact `nextCommand`.
7. Tell the user to run that command in a local terminal.

Do not run the privileged command.
Do not request sudo, the Telegram token, wallet keys, or Authority keys.

The local command writes the owner recovery record under `/root`.
It returns one Testnet-10 receive address and one `activateCommand`.

Divide `minimumFundingSompi` by `100,000,000` before you report tKAS or KAS.
Keep the exact atomic value as supporting evidence.
Never tell the user to fund the internal vault address.

After funding, show the exact `activateCommand`.
The user must run it locally one time.
Continue only after activation returns `ready`.

Future deposits use the same receive address and are secured automatically.

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
