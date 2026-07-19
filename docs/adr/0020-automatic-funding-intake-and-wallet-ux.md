# ADR-0020: Automatic funding intake and KAS-first wallet UX

- Status: Accepted
- Date: 2026-07-19
- Amends: ADR-0018 and ADR-0019

## Context

Sompi exposes a stable Testnet-10 receive address and keeps spendable funds in
an operator-bound SilverScript vault. After initial activation, new funds sent
to the receive address remain outside the vault until an operator runs another
deposit. Wallet View also observes only the vault address, so those funds appear
missing even though they are safely held by Sompi's funding key.

That flow is technically recoverable but poor wallet UX. A user should fund one
stable address and see one useful balance. Sompi should secure incoming funds
without asking the user to authorize an inward movement that cannot pay a third
party or increase agent authority.

Current projections also lead with raw sompi integers and implementation terms
such as funding, unbound, and vault balance. Humans normally reason in KAS or
tKAS. Atomic integers remain necessary for exact accounting, but they should be
supporting evidence rather than the default conversational unit.

## Decision

Add one deep `Funding Intake module`. It owns:

- bounded observation of UTXOs at the stable receive address;
- deterministic idempotency from the exact observed outpoint set, active vault,
  policy, and fee ceiling;
- automatic maximum deposits into the current operator-bound vault;
- use of the existing `vault_deposit` Treasury Movement, driver lease, prepared
  artifact, effect fence, Chain Evidence, commit, and recovery lifecycle;
- one serialized background reconciliation loop with a bounded interval;
- a read-only status projection for detected, securing, secured, attention, and
  unavailable states.

Funding Intake may only move funds from Sompi's installed receive key to the
exact current vault in the immutable Operator Manifest. It cannot choose a
recipient, create a Transfer or Purchase, loosen policy, use owner recovery, or
send funds outside Sompi. It therefore requires no human spend authorization.
The existing operator fee ceiling remains authoritative. Amounts too small to
cover the bounded deposit fee remain visible as incoming until more funds arrive
or an operator changes the installed policy.

`GET /wallet` becomes one KAS-first projection:

- stable receive address, QR payload, network label, and testnet warning;
- total, available, incoming/securing, protected, and pending amounts;
- automatic-securing status and exact next action when attention is required;
- policy limits in tKAS with exact atomic values retained alongside them;
- technical vault identity nested as security detail rather than presented as
  the address a user should fund.

Wallet activity includes current incoming UTXOs, automatic securing Treasury
Movements, direct Transfers, and Purchases. It remains a bounded Sompi
projection, not a claim to be a complete Kaspa chain index.

All user-facing projections use `tKAS` on Testnet-10 and `KAS` on a future
mainnet profile. Canonical internal state continues to use unsigned decimal
sompi strings. Public amount objects carry both the decimal KAS value and exact
atomic value, while summaries, Telegram prompts, CLI guidance, errors, receipts,
and agent instructions lead with KAS/tKAS. Sompi mentions sompi conversationally
only when the user asks for atomic units or exact technical evidence.

Outgoing Purchases and Transfers retain their current exact human-present
authorization, policy, vault, Journal, and recovery rules. Named recipient
grants and autonomous sends remain separately gated.

## Consequences

- A user funds one stable address once or repeatedly; Sompi secures eligible
  deposits automatically.
- Funds are visible immediately as incoming even before the vault deposit is
  complete.
- A Funding Intake crash or ambiguous broadcast cannot create a replacement
  deposit or hide the original operation.
- Wallet callers receive useful terms without reconstructing vault internals.
- The API schema changes cleanly; no backwards-compatible wallet projection is
  retained because Sompi remains development-only.

## Rejected alternatives

- Require a second user command after every deposit: unnecessary friction for
  a strictly inward authority-narrowing movement.
- Treat incoming funds as spendable before vault commitment: bypasses the
  SilverScript and policy model.
- Trigger deposits from `GET /wallet`: makes a read operation mutate chain
  state and couples UX reads to execution.
- Let the agent choose when or where to secure funds: widens agent authority.
- Hide atomic values completely: weakens exact evidence and reconciliation.
- Add recipient grants in this cutover: changes authorization rather than
  wallet presentation and remains governed by ADR-0019's later gate.
