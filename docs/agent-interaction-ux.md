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
recipient, tKAS amount, maximum total cost, and network in a short prompt. Every
signed fact stays available in collapsed advanced details. Normal approvals fit
in one message; an unusually large valid request may put request-bound detail
pages immediately above the decision card. Only that final card has Approve and
Deny. Approval sends securely from the protected wallet; denial or expiry
spends nothing.

The command automatically continues that same Transfer through bounded
settlement and receipt recovery. The Agent should wait for it instead of
inserting sleeps or manual status calls.

```sh
sompi-agent transfer-status TRANSFER_ID
sompi-agent transfer-recover TRANSFER_ID
```

Explicit recovery is only for a command that reaches its bound while the view
still requires recovery. It observes and resumes the original transaction,
never asks for new authority, and never creates a replacement spend. A direct
transfer is not an x402 Purchase and is not represented as an AP2 Payment
Mandate.

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

Use one request key for one user instruction. Retries and recovery reuse it.
After Sompi returns `expired`, a new user instruction may use a fresh key to
obtain new Merchant terms. A denial or recoverable payment must not be bypassed
with a new key.

The command waits for the approval result and automatically continues the same
durable Purchase through routine settlement and fulfilment recovery. This is a
bounded local convenience over the canonical API: it never creates a second
Purchase, request key, authorization, or payment attempt. The agent should wait
for the command rather than inserting sleeps or manual recovery calls.

## User decision

Sompi shows the user the Merchant or recipient, action, amount, maximum total,
and network first. The same Telegram message contains the exact fees, IDs,
profiles, finality, expiry, digests, and execution facts in a native collapsed
advanced-details section.

- Approve continues that Purchase.
- Deny spends nothing.
- No response expires safely.
- A second callback is rejected as replay.

Ordinary chat text is not approval. The agent must not click or answer for the
user.

## Reply style

Default replies are one or two plain sentences:

- say whether the purchase or transfer completed;
- use tKAS/KAS rather than atomic units;
- return purchased content when available;
- say explicitly when nothing was paid or sent.

Technical evidence such as fees, ceilings, transaction IDs, durable IDs,
profiles, digests, finality, and raw lifecycle states is available on request or
when needed for operator recovery. It is not part of the ordinary success
message.

## Result

The CLI returns the canonical Purchase view. Use fulfilled content only when
the state is `fulfilled` or `receipted`.

```sh
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

Use explicit recovery only when the completed purchase command reaches its
bounded deadline and `userAction` still says it is recoverable. The recovery
command also performs bounded continuation of that same Purchase. Recovery is
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
