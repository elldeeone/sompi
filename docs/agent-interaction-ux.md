# Agent interaction

The agent uses `sompi-agent`; Sompi handles everything else.

## Wallet questions

```sh
sompi-agent wallet
sompi-agent activity --limit 20
```

The wallet view reports the Testnet-10 funding address, vault address, observed
vault balance, reserved and available amounts, limits, and chain status. Activity
is bounded Sompi history, not a complete chain index. The agent never receives a
private key or mutation credential.

## Send KAS

```sh
sompi-agent transfer \
  --request-key TASK_KEY \
  --to KASPATEST_ADDRESS \
  --amount-kas 0.2
```

The request key must be stable for that logical send. Sompi shows the user the
exact recipient, amount, maximum fee, maximum total cost, source vault,
finality, and expiry. The user approves or denies through the configured trusted
Authority surface. Approval submits one SilverScript-vault transaction; denial
or expiry spends nothing.

```sh
sompi-agent transfer-status TRANSFER_ID
sompi-agent transfer-recover TRANSFER_ID
```

Recovery observes and resumes the original transaction. It never asks for new
authority and never creates a replacement spend. A direct transfer is not an
x402 Purchase and is not represented as an AP2 Payment Mandate.

## New purchase

```sh
sompi-agent purchase \
  --request-key TASK_KEY \
  --url HTTPS_URL \
  --method GET
```

Optional request bodies use `--body-file` and `--media-type`. Known Merchant
identity can be pinned with `--merchant-id` and `--merchant-origin`.

The request key must be stable for the logical purchase. Retries reuse it.

## User decision

Sompi shows the user the exact Merchant, resource, amount/ceiling, fees,
profile/channel, finality, and expiry.

- Approve continues that Purchase.
- Deny spends nothing.
- No response expires safely.
- A second callback is rejected as replay.

Ordinary chat text is not approval. The agent must not click or answer for the
user.

## Result

The CLI returns the canonical Purchase view. Use fulfilled content only when
the state is `fulfilled` or `receipted`.

```sh
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

Use recovery only when `userAction` says it is recoverable. Recovery is
idempotent and never authorizes a replacement payment.

## Agent permissions

The agent may:

- create, inspect, and recover its Purchases;
- inspect its read-only wallet view and bounded Sompi activity;
- propose, inspect, and recover exact human-approved Transfers;
- receive fulfilled content;
- report policy denial or operator action.

The agent may not:

- read wallet, vault, Authority, bot, API, or recovery secrets;
- approve purchases/transfers or change limits;
- call x402 or Kaspa directly;
- select a payment profile to bypass policy;
- create a new request key to escape denial/recovery;
- access operator recovery.

The packaged instructions are in
[`../integrations/hermes/sompi/SKILL.md`](../integrations/hermes/sompi/SKILL.md).
