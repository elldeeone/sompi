# Agent interaction

The agent uses `sompi-agent`; Sompi handles everything else.

## New purchase

```sh
sompi-agent purchase \
  --request-key TASK_KEY \
  --url HTTPS_URL \
  --method GET
```

Optional request bodies use `--body-file` and `--media-type`. Known Merchant
identity can be pinned with `--merchant-id` and `--merchant-origin`.

The request key must be stable for the logical task. Retries reuse it.

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
- receive fulfilled content;
- report policy denial or operator action.

The agent may not:

- read wallet, vault, Authority, bot, API, or recovery secrets;
- approve purchases or change limits;
- call x402 or Kaspa directly;
- select a payment profile to bypass policy;
- create a new request key to escape denial/recovery;
- access operator recovery.

The packaged instructions are in
[`../integrations/hermes/sompi/SKILL.md`](../integrations/hermes/sompi/SKILL.md).
