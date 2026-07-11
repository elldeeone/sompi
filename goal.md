# Phase 6: Agent-Native Payment UX

> **Historical plan:** this file describes the completed/pre-cutover Phase 6
> direction. It is not the plan for the accepted AP2 + Kaspa-x402 architecture.
> Future implementation work starts from `CONTEXT.md`,
> `docs/architecture/SOMPI_ARCHITECTURE.md`, the accepted records in
> `docs/adr/`, `docs/IMPLEMENTATION_PLAN.md`, and `CURRENT_STATE.md`.

## Objective

Make Sompi feel like ambient payment infrastructure for agents.

Users should express intent in normal language:

- "fetch this paid endpoint"
- "buy that data"
- "check if you can pay"
- "show me what you spent"
- "recover anything that is refundable"

The agent should handle the Kaspa/Sompi mechanics quietly unless the user asks
for technical detail. Users should not need to know what a sompi, DAA score,
covenant outpoint, escrow voucher, or x402 payment header is in order to use it.

Release target: **v0.8: Agent-Native Payment UX**.

## Core Principles

1. **Intent first**
   Users should not have to say "with Sompi". If the agent needs to pay, Sompi
   is its payment rail.

2. **KAS first**
   Human-facing responses should show KAS or tKAS by default. Raw sompi values
   stay available for exact accounting, protocol fields, audits, and technical
   mode.

3. **Progressive disclosure**
   Default responses should be short, plain-English, and action-oriented.
   Technical detail should remain available, but it should not be the first
   thing normal users see.

4. **Explain every human request**
   Any time the agent needs input, funding, approval, or a decision from the
   user, it must explain:

   - what it needs
   - why it needs it
   - whether it is safe to share or do
   - what happens next

5. **Safety remains explicit**
   The UX should hide unnecessary mechanics, not hide risk. Policy limits, vault
   caps, approvals, recovery authority, and irreversible spending actions must
   stay clear.

6. **Protocol remains exact**
   Wire formats and internal accounting should continue to use integer sompi
   fields where exactness matters.

## Workstream 1: Human-First Interaction Audit

Review every human <> agent interaction surface and rewrite it around normal
user intent.

Surfaces to audit:

- initial setup
- vault setup
- funding the regular wallet
- vault deposit/top-up
- payment readiness checks
- paid fetch/payment attempts
- spending policy blocks
- vault cap blocks
- payment approvals
- receipts
- escrow reuse
- escrow rotation
- retired escrows
- refunds
- seller claims
- recovery
- errors and partial failures
- technical detail requests

For each surface, define:

- what a normal user would ask
- what the agent should say by default
- what the agent should ask the user for, if anything
- why the request is needed
- whether the requested value/action is safe
- what the agent will do next
- what should be hidden unless the user asks for technical details

Acceptance criteria:

- No default response leads with raw fields like `ownerPublicKey`,
  `maxOutflowSompi`, `windowSizeDaa`, DAA score, tx outpoints, or voucher data.
- Every request for user input includes the four-part explanation:
  what, why, safety, next step.
- Every blocked action explains the block and the user's practical options.
- Every successful spending action produces a human-readable receipt.

Example user-facing request:

```text
I need your vault owner public key and a spending cap.

The public key lets you recover the vault later, but it cannot spend funds by
itself. The cap limits how much I can spend per window even if my agent key is
compromised.

Safe to share: yes, public key only. Do not send the private key.

After you send those, I will create the vault config and tell you where to fund
it.
```

## Workstream 2: KAS-First MCP Responses

Update MCP tool responses so agents can answer users in KAS/tKAS without doing
manual conversion or exposing raw protocol units.

Rules:

- human amount fields should be named `amountKas`, `feeKas`, `balanceKas`,
  `spentInWindowKas`, `maxOutflowKas`, `authorizedKas`, etc.
- exact integer fields should remain as `amountSompi`, `feeSompi`,
  `balanceSompi`, `authorizedSompi`, etc.
- summaries should lead with KAS/tKAS.
- errors should include both forms when useful:
  `0.9 tKAS (90000000 sompi)`.
- tool descriptions should prefer KAS for user-facing inputs where safe.

Priority targets:

- `paid_fetch`
- `get_policy`
- `vault_status`
- `vault_create`
- `vault_deposit`
- `vault_send`
- `send_payment`
- `await_payment`
- `verify_payment`
- policy errors
- vault errors
- x402/escrow errors

Acceptance criteria:

- `paid_fetch` returns `authorizedKas`.
- `paid_fetch.deposit` returns `amountKas` and `feeKas`.
- policy status returns KAS equivalents for per-tx, per-hour, approval, and
  spent-last-hour values.
- vault status returns KAS equivalents for cap, spent window, spendable balance,
  and unbound balance.
- normal agent summaries can avoid saying "sompi" unless asked for exact detail.

## Workstream 3: Plain-English Summaries and Next Steps

Every MCP response that may be shown to a user should include a concise summary
and, where relevant, an action-oriented next step.

Recommended response shape:

```json
{
  "summary": "I paid 0.01 tKAS using an existing vault-funded escrow.",
  "status": "success",
  "userAction": "none",
  "details": {
    "funding": "vault",
    "escrow": "reused existing escrow",
    "technical": {
      "authorizedSompi": "2000000"
    }
  }
}
```

Common summary examples:

- "Vault is ready. I can pay for APIs from the vault."
- "I need the regular wallet funded before I can create the vault deposit."
- "I paid 0.01 tKAS from the existing escrow. No new vault spend was needed."
- "I opened a new vault-funded escrow for 0.9 tKAS."
- "This payment is blocked by the day-to-day policy limit."
- "Refund is not available yet. It becomes available after the timeout."
- "Refund is available for one retired escrow."

Acceptance criteria:

- Payment tools include a `summary`.
- Status tools include a `summary`.
- Setup tools include a `nextStep`.
- Error responses are concise and actionable.

## Workstream 4: Payment Readiness and Status

Add first-class MCP visibility so the agent can answer payment questions without
piecing together low-level wallet, vault, policy, and escrow state.

Candidate tools:

- `payment_status`
- `commerce_status`
- `escrow_status`

Questions these tools should answer:

- Can I pay for paid APIs right now?
- Is the vault configured?
- Is the vault covenant-funded?
- How much spendable vault balance is available?
- How much regular wallet float is available?
- What are the day-to-day policy limits?
- What is already spent in the current policy window?
- What is the hard vault cap?
- Are there active escrows?
- Are there retired escrows?
- Will the next request likely reuse an escrow or open a new one?
- Are any escrows refundable now?
- Are any escrows near refund timeout?
- Are any server-side claims available?

Acceptance criteria:

- The agent can answer "can you pay for things?" with one tool call.
- The response is KAS-first and plain-English.
- The response distinguishes hard blockers from warnings.
- The response includes user actions only when user action is actually needed.

## Workstream 5: Hermes/Terah Operational Hardening

Make the live agent operationally easy to inspect and support.

MCP-visible state should include:

- active paid-fetch escrows
- retired escrows
- escrow funding source
- escrow deposit amount
- authorized amount
- refundable amount estimate
- refund availability
- last deposit txid
- last payment status
- whether the next request will deposit or reuse
- vault balance
- vault current outpoint
- regular wallet float
- policy cap and recent spend

Acceptance criteria:

- Terah can explain payment state without manual file inspection.
- Terah can distinguish "ready", "needs funding", "needs vault setup",
  "blocked by policy", "blocked by vault cap", and "node unavailable".
- Terah can produce a receipt for a paid request that a non-technical user can
  understand.

## Workstream 6: Escrow Lifecycle Automation

Add safe workflows for escrow claim/refund lifecycle tasks.

Client-side lifecycle:

- list active escrows
- list retired escrows
- show refundable amounts
- show refund availability
- refund retired escrows after timeout
- summarize refund receipts

Seller-side lifecycle:

- list claimable channels
- estimate claimable totals
- claim earned funds
- prune spent/stale channel state
- summarize claim receipts

Warnings:

- refund timeout near
- refund timeout passed
- claim amount too small to cover fee
- stale server key or recovery mismatch
- escrow outpoint no longer found

Acceptance criteria:

- A user can ask "is anything refundable?" and get a clear answer.
- A user can ask "claim what I earned" and get a safe claim flow.
- Claim/refund actions produce KAS-first receipts with txids in details.
- Dangerous or irreversible actions clearly state what will happen before they
  run when approval is required by the host agent.

## Workstream 7: Public Paid API Demo

Turn the local demo service into a stable public paid endpoint.

Goals:

- a public URL that returns an x402 `kaspa-escrow` offer
- clear instructions for agents and humans
- a cheap testnet price
- predictable response body
- status page or health endpoint
- public docs showing what a successful agent interaction looks like

Acceptance criteria:

- A user can ask their agent to fetch/access the public endpoint.
- The agent pays through vault-backed `paid_fetch`.
- The user receives a simple receipt.
- The docs do not require users to understand x402 internals.
- The hosted endpoint can be checked with `npm run check:public-demo -- <url>`.
- A configured agent host can run the explicit paid proof with
  `npm run check:public-demo -- <url> --paid`.

## Workstream 8: Interop and Wire Spec

Write the `kaspa-escrow` x402 wire spec so other clients and servers can
implement it without reading Sompi internals.

Spec should cover:

- HTTP 402 offer JSON
- `X-Payment` header shape
- base64 payload structure
- voucher digest construction
- domain tag
- network binding
- scriptPubKey binding
- funding outpoint binding
- amount semantics
- cumulative authorization
- escrow deposit requirements
- server claim behavior
- client refund behavior
- replay protection model
- expected error cases

Acceptance criteria:

- The spec is sufficient for an independent implementation.
- The spec distinguishes protocol fields from Sompi MCP UX fields.
- Examples use KAS-first prose and exact sompi wire values where needed.

## Workstream 9: Mainnet-Readiness Track

This is not "turn on mainnet by default". It is the work needed before mainnet
use can be considered safe.

Areas:

- explicit network gating
- disabled-by-default mainnet guard if appropriate
- stronger warnings for real funds
- safer default policy limits
- clearer vault cap guidance
- stronger recovery documentation
- operator preflight checklist
- receipt and audit-log expectations
- hosted-demo separation from mainnet behavior

Acceptance criteria:

- Mainnet cannot be enabled accidentally.
- Mainnet setup requires explicit operator intent.
- The agent clearly distinguishes testnet funds from real funds.
- Recovery documentation is good enough for a non-developer operator to follow.

## First Implementation Order

1. Add KAS formatting helpers for nested MCP response objects.
2. Update `paid_fetch` to return `summary`, `authorizedKas`, and KAS fields
   inside `deposit`.
3. Update `get_policy` to return KAS equivalents and a plain-English summary.
4. Add `escrow_status` or `payment_status`.
5. Update vault setup/status/deposit/send responses with clearer summaries and
   next steps.
6. Rewrite policy and vault errors to include KAS-first amounts and actionable
   fixes.
7. Add lifecycle status for refundable/claimable escrows.
8. Add safe refund/claim MCP workflows or scripts.
9. Update README roadmap with Phase 6 / v0.8.
10. Write the public `kaspa-escrow` wire spec.
11. Turn the local paid demo into a stable hosted test endpoint.
12. Add mainnet-readiness guards and operator docs.

## Definition of Done

Phase 6 is complete when:

- a non-technical user can ask an agent to prepare for payments, check payment
  readiness, fetch a paid endpoint, understand the receipt, and recover/refund
  available funds without knowing Sompi internals;
- all normal user-facing amounts are KAS/tKAS-first;
- all exact sompi/protocol fields remain available for technical detail;
- the agent can explain every request for user input concisely;
- active, retired, refundable, and claimable escrow state is visible through
  MCP or safe scripts;
- the public paid demo proves the UX externally;
- the interop spec is clear enough for another implementation;
- mainnet use remains explicit, guarded, and documented.
