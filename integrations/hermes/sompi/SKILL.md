---
name: sompi
description: Buy paid API resources through local Sompi.
version: 0.8.1
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

## When to Use

Use this skill when a task reaches a paid HTTP resource, the user asks to buy API access with KAS, or an existing Sompi Purchase needs inspection or recovery.

## Prerequisites

- `sompi-agent` is installed and provisioned by the operator.
- The local Sompi API is running.

## How to Run

Use the `terminal` tool to run `sompi-agent`. Do not inspect its credential files.

## Quick Reference

```sh
sompi-agent purchase --request-key TASK_KEY --url HTTPS_URL --method GET
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

## Procedure

1. Choose one stable request key for the logical purchase. Reuse that key for retries of the same request; never create a new key just to bypass a denial or failure.
2. Use `terminal` to run:

   ```sh
   sompi-agent purchase --request-key TASK_KEY --url HTTPS_URL --method GET
   ```

   For a body, write it to a bounded local file and add `--body-file /absolute/path` and `--media-type TYPE`. If the expected merchant identity is known, add `--merchant-id ID` and `--merchant-origin ORIGIN`.

3. Sompi may send an exact Approve/Deny prompt into the user's trusted chat. Do not answer it for the user, infer approval from conversation, ask for credentials, or retry with altered terms. Wait for the command to finish.
4. Read the returned Purchase view. Use the fulfilled content only when the state is `fulfilled` or `receipted`. Report denials and policy failures plainly.

## Recovery

```sh
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

Use `recover` only when Sompi marks the Purchase recoverable. It is idempotent; do not create a replacement purchase to escape recovery.

## Pitfalls

- Never expose or read Sompi's wallet keys, Authority keys, recovery credential, API bearer token, Telegram bot token, or Journal.
- Never approve a Purchase through chat text, MCP, a shell command, or a Hermes command-approval button.
- Never change the requested URL, method, body, merchant, amount, payee, network, or request key after the user sees the approval prompt.
- Never call the recovery API socket or operator tools.
- Never claim success unless the returned Purchase view says the resource was fulfilled.

## Verification

The Purchase is successful only when `sompi-agent` returns state `fulfilled` or `receipted`. Otherwise report the returned state and `userAction` without claiming that the resource was bought.
