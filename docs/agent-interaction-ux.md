# Agent interaction UX audit

Status: working contract for v0.8 agent-native payment UX.

Default agent responses should be short, KAS-first, and action-oriented. Raw
sompi, DAA scores, outpoints, scripts, and voucher details are technical detail;
show them when useful, or when the user asks.

## Required explanation pattern

Whenever the agent needs something from the user, it must explain:

1. what it needs
2. why it needs it
3. whether it is safe to share or do
4. what happens next

## Interaction surfaces

| Surface | Normal user intent | Default agent response | User input needed | Hidden unless asked |
|---|---|---|---|---|
| Initial readiness | "Can you pay for things?" | "I am ready/not ready to pay. Vault balance is X. Next action is Y." | None unless blocked | raw policy JSON, DAA, outpoints |
| Vault setup | "Prepare yourself to pay" | "I need your owner public key and a spending cap." Explain what/why/safety/next. | owner public key, cap in KAS | `ownerPublicKey`, `maxOutflowSompi`, `windowSizeDaa` names |
| Regular wallet funding | "What do I fund?" | "Send testnet KAS to this address. I will move it into the vault after it arrives." | user sends funds | private key path, UTXO details |
| Vault deposit | "Move funds into the vault" | "Moved X tKAS into the vault. Fee was Y. Vault is ready/not ready." | amount only if not depositing max-safe amount | covenant id, current outpoint |
| Payment request | "Fetch/buy/access this" | "I paid X tKAS and got the result." Mention new deposit only if one happened. | none unless blocked by policy/funds | voucher, header, tx input details |
| Escrow reuse | "Fetch again" | "I reused the existing vault-funded escrow. No new deposit was needed." | none | authorized total unless requested |
| Escrow rotation | "Fetch after channel is low" | "I opened a new vault-funded escrow because the previous channel was used up." | none unless blocked | retired channel internals |
| Spending policy block | "Why can't you pay?" | "This exceeds the day-to-day policy. Ask the operator to approve or change the policy." | operator decision | spend-log file path |
| Vault cap block | "Why can't you pay?" | "This exceeds the vault's hard on-chain cap. Wait for the window to reset or use owner recovery." | operator decision | covenant state bytes |
| Receipt | "What did you spend?" | "Spent X tKAS; fee/deposit Y if applicable; funding source was vault." | none | raw sompi, txids unless useful |
| Refund check | "Is anything refundable?" | "N retired escrows are refundable for about X tKAS." | none | client private key, script details |
| Refund action | "Recover refundable funds" | Preview first. On execute: "Submitted N refund txs to address." | destination if not own wallet | refund args, locktime mechanics |
| Seller claim check | "Can I claim earnings?" | "N channels are claimable for X KAS total." | service data dir | server private key |
| Seller claim action | "Claim what I earned" | Preview first. On execute: "Claimed X KAS to destination." | destination address | voucher hex, outpoints |
| Recovery | "Recover the vault" | "Run this owner-side command with your private key on your machine." | owner private key never sent to agent | raw covenant derivation unless asked |
| Mainnet | "Use real KAS" | "Mainnet is disabled by default. Confirm intent and set explicit opt-in." | explicit operator opt-in | none |

## Response shape

Tools should prefer:

```json
{
  "summary": "I paid 0.01 tKAS using the existing vault-funded escrow.",
  "status": "success",
  "userAction": "none",
  "details": {
    "amountKas": "0.01",
    "amountSompi": "1000000"
  }
}
```

The `summary` field is written for the agent to repeat directly. Exact fields
remain present for audit and protocol use.

## Good examples

Setup request:

```text
I need your vault owner public key and a spending cap.

The public key lets you recover the vault later, but it cannot spend funds by
itself. The cap limits how much I can spend per window even if my agent key is
compromised.

Safe to share: yes, public key only. Do not send the private key.

After you send those, I will create the vault config and tell you where to fund
it.
```

Payment receipt:

```text
I paid 0.01 tKAS using the existing vault-funded escrow and got the result. No
new deposit was needed.
```

Policy block:

```text
I cannot make that payment because it exceeds the day-to-day policy limit. The
limit was set by the operator, so I will not bypass it. You can approve the
payment manually or change the policy.
```
