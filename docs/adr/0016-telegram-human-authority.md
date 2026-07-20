# ADR-0016: Request-bound Telegram approval through the isolated Authority

- Status: Accepted
- Date: 2026-07-18
- Amends: ADR-0005 and ADR-0007

## Context

Sompi's terminal ceremony proves the authorization boundary but is awkward for
an agent used through Telegram. Treating normal chat text, an LLM response, or
Hermes command approval as AP2 Purchase Authorization would let the agent
approve its own Purchase. Running another public relay or requiring a second
approval bot would add avoidable operator and user friction.

Hermes already renders Telegram inline buttons. Its current approval work is
being hardened to bind buttons to exact pending requests, but that mechanism
authorizes Hermes operations; it is not Sompi Purchase Authorization.

## Decision

Add one human-present Telegram prompt provider behind the existing Trusted
Authority decision seam. The selected provider is installed through the
Operator Manifest and remains testnet-only.

The isolated `sompi-authority` process:

- creates and durably records independent high-entropy, single-use Approve and
  Deny capabilities bound to the authenticated Authority request digest, exact
  displayed facts, expected Telegram user/chat, one fixed decision, and expiry;
- sends the complete deterministic approval display directly through the
  configured Telegram bot API;
- signs approval or denial only after consuming a matching callback capability;
- atomically invalidates both capabilities before returning the decision;
- fails closed on expiry, replay, mismatch, transport uncertainty, or restart
  state that cannot be reconciled.

The callback wire carries only the opaque decision capability. It contains no
relay-selected approval/denial field that can be rewritten. Purchase,
Transfer, Policy Change, and Vault Migration prompts also acquire one shared
Authority admission budget before any Telegram prompt is durably created or
sent.

A small external Hermes plugin handles only callback delivery. A generic
gateway interaction hook passes an authorized Telegram callback to the plugin.
The plugin forwards the bounded opaque callback data to a dedicated Authority
Unix socket and returns the deterministic result for the button UI. It has no
Authority signer, AP2 credential, wallet, Journal, policy, recovery credential,
or reusable approval capability.

The callback capability is never returned by the Purchase API, MCP, skill, or
agent tools. It appears only in the Authority-created Telegram button and the
Authority's private durable state. Possession of the Telegram bot token alone
cannot mint a valid Sompi decision.

Only an inline-button callback from the operator-installed Telegram user and
chat is accepted. Plain messages such as `yes`, agent prose, slash commands,
Hermes command approvals, and MCP calls have no authorization meaning. The
prompt displays the exact Merchant, resource, method, request fingerprint,
amount, asset, network, payee, expiry, selected execution profile or channel,
fee ceiling, finality floor, and Purchase ID.

The Hermes change remains generic and minimal: request-bound callback dispatch
for external plugins. Sompi-specific behavior lives in the Sompi plugin and
Authority. The current request-binding work from Hermes PR #6105 is retained
when the local integration branch needs it; no Sompi code reimplements Hermes'
general approval queue.

Terminal approval remains a separately selected provider for isolated operator
and conformance use. A runtime uses one provider; it does not race or combine
terminal and Telegram decisions.

This decision does not add autonomous AP2 mandates. Every payment, including
every batch voucher increase, still requires its own exact human-present
authorization.

## Consequences

- The User can approve or deny a Purchase in the same Telegram conversation
  used with the agent.
- The LLM and MCP remain unable to approve a Purchase.
- A compromised or unavailable Hermes interaction adapter can deny service or
  deliver the capability selected by the user, but cannot rewrite that
  capability into the opposite decision or manufacture a new one.
- Telegram account and bot operations become part of the initial testnet human-
  presence assumption; this is not hardware-backed or mainnet authorization.
- The Authority needs a private bot-token file and a separate callback socket,
  each installed with least authority and covered by backup/rotation runbooks.

## Rejected alternatives

- Treat chat text or Hermes exec approval as AP2 authorization: not bound to the
  independently verified Purchase facts and agent-reachable.
- Give the Hermes plugin the Authority IPC MAC or signing key: turns the agent
  host into the authority.
- Separate approval bot: safe but unnecessarily splits the first user flow.
- Public Mini App or hosted relay: unnecessary for a single self-hosted Hermes
  deployment and adds a public service before it is needed.
- Telegram polling in two processes: Telegram permits one update consumer and
  would create loss and ordering races.
