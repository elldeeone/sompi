# ADR-0022: Progressive approval display and bounded agent continuation

- Status: Accepted
- Date: 2026-07-21
- Amends: ADR-0016, ADR-0019, ADR-0021

## Context

Sompi's Telegram approval prompts currently lead with every bound protocol and
execution fact. This is auditable but makes the ordinary decision difficult to
scan. Direct Transfers also expose a lifecycle mismatch: the agent-facing
Purchase command continues the same durable operation through routine recovery,
while the Transfer command may return at `submitted` and require the Agent to
issue a second recovery command.

Neither issue requires weakening authorization or hiding evidence. Telegram
supports a collapsed-by-default expandable blockquote, and the local Agent CLI
can continue an existing Transfer without creating new authority or a new
transaction.

## Decision

Telegram approval messages use progressive disclosure:

- the visible summary contains the action, human-scale KAS amount, exact
  Merchant or recipient, maximum total exposure, network, and any consequence
  needed for a safe decision;
- every signed fact stays in the same approval ceremony inside Telegram's
  native expandable HTML blockquote;
- normal approvals use one message; if a complete valid fact set would exceed
  Telegram's parsed-text limit, Sompi sends request-bound collapsed detail pages
  first and sends the concise decision card last;
- only the final concise card carries Approve and Deny, so partial detail-page
  delivery can never create an approval capability;
- Approve and Deny remain the only callback capabilities and retain their exact
  request, Telegram identity, expiry, single-use, and replay bindings;
- expanding or collapsing details has no authorization meaning and creates no
  new capability;
- approval and denial acknowledgements are short, action-specific, and do not
  claim completion before the underlying module finishes.

The terminal provider continues to print the complete deterministic display
because it has no equivalent collapsed presentation and is an advanced trusted
surface.

The agent-facing `transfer` command also performs bounded continuation of the
same durable Transfer while its state requires observation or recovery. It:

- preserves the original Transfer ID and request key;
- calls only the canonical recovery endpoint;
- never creates another Transfer, authorization, or blockchain transaction;
- bounds total continuation time, recovery calls, each individual call, and
  unchanged-state backoff;
- returns the latest durable Transfer view honestly when the bound is reached.

Explicit `transfer-recover` uses the same bounded continuation. Manual recovery
remains available for operator diagnosis, but is no longer the normal agent UX.

## Consequences

- Users can decide ordinary Purchases, Transfers, limit changes, and vault
  protection changes from a short prompt and expand the exact signed facts
  before deciding. Unusually large valid requests may use multiple collapsed
  detail pages without making the decision card verbose.
- Progressive disclosure changes presentation only; the signed authorization
  facts and decision capabilities are unchanged.
- A normal direct send now behaves like a normal Purchase: one agent command
  waits through routine settlement and returns the most complete durable result
  available within a fixed bound.
- The Agent does less polling and has fewer opportunities to misreport a
  submitted transaction as failed or create an unsafe replacement.

## Rejected alternatives

- A separate Details callback: Hermes currently resolves external callbacks by
  replacing the approval message and removing its buttons, and another callback
  would add capability and lifecycle complexity.
- Hide advanced facts entirely: prevents exact review and weakens the trusted
  approval ceremony.
- Let the Agent manage Transfer polling: recreates the delay and ambiguity this
  decision removes.
- Wait indefinitely for settlement: violates bounded-operation requirements.
