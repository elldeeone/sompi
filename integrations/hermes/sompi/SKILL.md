---
name: sompi
description: Install Sompi, inspect its agent wallet, send human-approved Testnet-10 KAS, and buy paid API resources.
version: 0.11.5
author: Sompi contributors
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [kaspa, payments, api]
    category: blockchain
---

# Sompi Skill

Sompi owns authorization, policy, wallet use, settlement, replay protection, and recovery. Use only `sompi-agent`; never construct a Kaspa payment, call x402 directly, read Sompi credentials, or treat ordinary chat text as payment approval.

## Install

When the user asks to install Sompi:

1. Require Linux with systemd, Node.js 22+, and a working Hermes gateway. Never ask for sudo, a Telegram token, a wallet key, or an Authority key.
2. Download the pinned non-secret request template:

   ```sh
   mkdir -p ~/.sompi
   curl --proto '=https' --tlsv1.2 --fail --location --max-time 30 \
     https://raw.githubusercontent.com/elldeeone/sompi/v0.11.5/host-bootstrap.example.json \
     -o ~/.sompi/bootstrap-request.json
   chmod 600 ~/.sompi/bootstrap-request.json
   ```

3. Set only these non-secret fields: Hermes OS user, Telegram bot/user/chat IDs, trusted TN10 node URL, Merchant allow rules, and spending limits. Do not add fields or secrets.
4. Preview with the pinned package:

   ```sh
   npm exec --yes --allow-scripts=better-sqlite3@12.11.1 \
     --package=@elldeeone/sompi@0.11.5 -- \
     sompi-operator bootstrap-preview ~/.sompi/bootstrap-request.json
   ```

5. Show the complete preview and its exact `nextCommand`. The user must run that command in a local terminal. Do not run it, submit sudo approval, or ask the user to paste the Telegram token into chat. The local command prompts for the token with input hidden and writes the owner recovery record under `/root`.
6. Report the returned Testnet-10 receive address and required funding in tKAS. If bootstrap returns an atomic amount, divide it by 100,000,000 for the user and retain the exact atomic value only as supporting detail. Never tell the user to fund the internal vault address directly.
7. After the user sends at least the minimum to the receive address, show the exact `activateCommand`. The user runs it locally; the agent must not run it or receive sudo. It moves the funds into the spending-limited SilverScript vault through Sompi's durable Treasury journal.
8. Continue only after activation returns `ready`. This is a one-time ceremony. Future deposits to the same receive address are detected and secured automatically; never ask the user to run a second deposit command.

## When to Use

Use this skill when the user asks about the agent wallet, asks to send KAS, reaches a paid HTTP resource, or needs an existing Sompi operation inspected or recovered.

## Prerequisites

- `sompi-agent` is installed and provisioned by the operator bootstrap.
- The local Sompi API is running.

## How to Run

Use the `terminal` tool to run `sompi-agent`. Do not inspect its credential files.

## Quick Reference

```sh
sompi-agent purchase --request-key TASK_KEY --url HTTPS_URL --method GET
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
sompi-agent wallet
sompi-agent activity --limit 20
sompi-agent change-limits --request-key TASK_KEY --per-payment-kas KAS --per-hour-kas KAS
sompi-agent limit-change-status POLICY_CHANGE_ID
sompi-agent limit-change-recover POLICY_CHANGE_ID
sompi-agent change-vault-protection --request-key TASK_KEY --maximum-kas KAS
sompi-agent vault-protection-change-status VAULT_MIGRATION_ID
sompi-agent transfer --request-key TASK_KEY --to KASPATEST_ADDRESS --amount-kas KAS
sompi-agent transfer-status TRANSFER_ID
sompi-agent transfer-recover TRANSFER_ID
```

## Wallet

For balance, address, limits, deposit status, or recent-activity questions, use `sompi-agent wallet` or `sompi-agent activity --limit 20`. Lead with the returned tKAS/KAS `display` fields:

- `balance.total`: all observed wallet funds;
- `balance.available`: protected funds available to spend;
- `balance.incoming`: funds at the receive address being secured;
- `balance.pending`: funds committed to active operations;
- `receive.address`: the one address users fund;
- `securing.summary`: whether a deposit is detected, moving, complete, or needs attention.

Do not call these balances “sompi” unless the user asks for atomic units. Do not expose the internal vault address unless the user explicitly asks for security details. Do not inspect keys, credential files, the Journal, or the node directly.

If the user explicitly asks for vault, covenant, DAA, atomic-unit, or allowlist details, run `sompi-agent wallet-technical`. Do not use that command for an ordinary balance, address, limits, deposit, or activity question.

## Spending Limits

When the user asks to change the maximum per payment or maximum per hour, confirm both values in tKAS/KAS and run:

```sh
sompi-agent change-limits --request-key TASK_KEY --per-payment-kas KAS --per-hour-kas KAS
```

Sompi sends the exact old and new limits to the trusted approval chat. Wait for the result. If approved, the new limits apply only to new work. Every payment still requires its own approval. Never invent or mention an approval threshold.

Use `limit-change-status` or `limit-change-recover` only for the same returned Policy Change ID. Never create another request key to bypass a denial, expiry, conflict, or recovery state.

## Vault Protection

Vault protection is the stronger on-chain maximum. When the user asks to change it, confirm the new tKAS/KAS maximum and run:

```sh
sompi-agent change-vault-protection --request-key TASK_KEY --maximum-kas KAS
```

The trusted chat approves only the exact plan. It does not provide the offline owner signature. After approval, tell the user that the operator must finish the protected update locally using the returned Vault Migration ID. Never request, read, transmit, or accept the owner key. The receive address remains unchanged before, during, and after the update.

Vault protection cannot be lower than the everyday hourly limit. If Sompi
rejects the requested maximum for that reason, propose and approve the lower
everyday limits first, then create one new vault-protection request.

## Direct KAS Transfer

When the user explicitly asks to send an exact amount of KAS to an exact Testnet-10 address, choose one stable request key and run:

```sh
sompi-agent transfer --request-key TASK_KEY --to KASPATEST_ADDRESS --amount-kas KAS
```

Sompi sends a separate exact approval prompt to the trusted human surface. Wait for the command. Do not treat the user's original chat instruction, an MCP call, or a shell-command approval as the cryptographic approval. Report success only when the returned Transfer is `receipted`, including its tKAS/KAS display amount, recipient, display fee, and transaction ID.

If the Transfer is `funds_reserved`, `prepared`, `submitted`, or `settled`, keep the same Transfer ID and use `sompi-agent transfer-recover TRANSFER_ID` to observe and finish it. If `userAction` says `recover`, do the same. Bound the polling time, report an unresolved status honestly, and never create a replacement send.

## Procedure

1. Choose one stable request key for the logical purchase. Reuse that key for retries of the same request; never create a new key just to bypass a denial or failure.
2. Use `terminal` to run:

   ```sh
   sompi-agent purchase --request-key TASK_KEY --url HTTPS_URL --method GET
   ```

   For a body, write it to a bounded local file and add `--body-file /absolute/path` and `--media-type TYPE`. If the expected merchant identity is known, add `--merchant-id ID` and `--merchant-origin ORIGIN`.

3. Sompi may send an exact Approve/Deny prompt into the user's trusted chat. Do not answer it for the user, infer approval from conversation, ask for credentials, or retry with altered terms. Wait for the command to finish.
4. Read the returned Purchase view. Use the fulfilled content only when the state is `fulfilled` or `receipted`. Report amounts in tKAS/KAS, and report denials, policy failures, and recovery instructions plainly.

## Recovery

```sh
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

Use `recover` only when Sompi marks the Purchase recoverable. It is idempotent; do not create a replacement purchase to escape recovery.

## Pitfalls

- Never expose or read Sompi's wallet keys, Authority keys, recovery credential, API bearer token, Telegram bot token, or Journal.
- Never approve a Purchase or Transfer through ordinary chat text, MCP, a shell command, or a Hermes command-approval button.
- Never change the requested URL, method, body, merchant, amount, payee, network, or request key after the user sees the approval prompt.
- Never call the recovery API socket or operator tools.
- Never claim success unless the returned Purchase view says the resource was fulfilled.
- Never claim a direct send succeeded unless its Transfer view is `receipted` and includes a transaction ID.

## Verification

The Purchase is successful only when `sompi-agent` returns state `fulfilled` or `receipted`. Otherwise report the returned state and `userAction` without claiming that the resource was bought.
