# Agent interaction

The agent uses `sompi-agent`; Sompi handles everything else.

## Wallet questions

```sh
sompi-agent wallet
sompi-agent activity --limit 20
```

The wallet view reports one Testnet-10 receive address and four useful balances:

- total;
- available to spend;
- incoming and being secured;
- pending in active operations.

Amounts lead with tKAS. Exact atomic values remain in structured fields for
machines and evidence. The internal vault address is a security detail, not the
normal receive experience.

After the one-time activation ceremony, users always send to the same receive
address. Sompi detects eligible UTXOs and moves them through its existing
journal-first vault-deposit lifecycle automatically. This inward move grants no
new spending authority and needs no user approval. If interrupted, Sompi
recovers the same operation instead of creating a blind replacement.

Activity includes incoming deposits, automatic securing, transfers, purchases,
fees, transaction IDs, and status. It is bounded Sompi history, not a complete
chain index. The agent never receives a private key or mutation credential.

## Send KAS

```sh
sompi-agent transfer \
  --request-key TASK_KEY \
  --to KASPATEST_ADDRESS \
  --amount-kas 0.2
```

The request key must be stable for that logical send. Sompi shows the user the
exact recipient, tKAS amount, maximum fee, maximum total cost, finality, and
expiry. The user approves or denies through the configured trusted Authority
surface. Approval sends securely from the protected wallet; denial or expiry
spends nothing.

```sh
sompi-agent transfer-status TRANSFER_ID
sompi-agent transfer-recover TRANSFER_ID
```

Recovery observes and resumes the original transaction. It never asks for new
authority and never creates a replacement spend. A direct transfer is not an
x402 Purchase and is not represented as an AP2 Payment Mandate.

## Change limits

For everyday limits, the agent proposes the exact new maximum per payment and
maximum per hour. The trusted chat approves or denies the change. Approval
affects new work only; existing work keeps its original policy snapshot. Every
outgoing payment still needs its own approval.

Vault protection is the stronger on-chain maximum. Chat approval authorizes
only the exact replacement plan. The operator must then complete it locally
with the offline owner key. Sompi pauses outward work during replacement and
keeps the user's receive address unchanged.

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
- give users the receive address and explain automatic deposit securing;
- propose, inspect, and recover exact human-approved Transfers;
- propose and inspect owner-approved everyday-limit changes;
- propose and inspect vault-protection changes;
- receive fulfilled content;
- report policy denial or operator action.

The agent may not:

- read wallet, vault, Authority, bot, API, or recovery secrets;
- approve purchases, transfers, or limit changes;
- execute a vault replacement or access its offline owner key;
- call x402 or Kaspa directly;
- select a payment profile to bypass policy;
- create a new request key to escape denial/recovery;
- access operator recovery.

The packaged instructions are in
[`../integrations/hermes/sompi/SKILL.md`](../integrations/hermes/sompi/SKILL.md).
