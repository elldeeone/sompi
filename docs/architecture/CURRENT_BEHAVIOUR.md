# Current behaviour characterization

Status: Phase 1 baseline

Captured from: `1bbfa0c`

Captured on: 2026-07-11

This document identifies behaviour to retain through the clean cutover. It does
not preserve the current x402 v1 protocol, JSON state, or module shape.

## Verification baseline

On normalized local `main` at `1bbfa0c`:

- `npm run build` passes;
- `SOMPI_SMOKE_OFFLINE=1 npm run smoke` passes every check;
- vault templates match all 12 pinned compiler fixtures;
- escrow templates match all 10 pinned compiler fixtures;
- policy, vault funding, fee convergence, voucher binding, channel reload, and
  stale-state cases pass.

The escrow-specific checks are comparison oracles until Phase 4 and are deleted
with the old implementation. Vault/wallet/policy checks remain permanent.

## Behaviour that must survive

### Agent and operator experience

- MCP responses are JSON text with stable structured fields, a concise
  `summary`, and actionable next steps for blocked setup or recovery.
- Amounts expose exact sompi and human-readable KAS/tKAS projections.
- Tool failures are returned as structured MCP errors without private keys or
  raw secret material.
- Operator policy denials are described as deliberate limits the Agent must not
  bypass.
- Payment readiness distinguishes missing setup, insufficient funds, node
  health, policy capacity, vault state, and recoverable funds.
- Status calls do not silently spend or submit transactions.

### Network and wallet

- Mainnet is denied unless explicitly enabled, and the first end-to-end release
  remains testnet-only even if the environment flag is set.
- A configured node is checked for sync and UTXO-index readiness.
- Public resolver nodes are rejected when materially off the canonical DAA
  reference.
- Wallet keys are loaded from operator configuration or mode-0600 local files;
  they are never returned by MCP tools.
- Exact integer sompi values are used for signing and policy.
- Transaction fee estimates cover final signed mass.

### Spending policy

- Non-positive payments are rejected.
- Per-payment and rolling-hour caps are enforced.
- Optional payee allowlists and approval thresholds fail closed.
- Policy files hot-reload and malformed/unreadable policy fails closed.
- The Agent cannot edit policy through MCP.

The implementation changes from authorize-then-record JSON accounting to
transactional reservation/finalization in the Purchase Journal. The effective
limits and operator control remain.

### Consensus vault

- Owner recovery and agent spending keys remain distinct.
- The rolling-window outflow cap remains consensus enforced.
- Genesis deposit, top-up, continuation, capped withdrawal, and owner recovery
  preserve their pinned compiler/transaction invariants.
- Direct funds sent to a vault address remain distinguishable from covenant-
  bound spendable funds.
- Fee convergence uses the final signed transaction shape.
- Vault configuration and current outpoint must reconcile with chain truth
  after an interrupted transaction.

### Purchase UX retained in new terms

The useful `paid_fetch` behaviour survives as a mapping onto the Purchase
module:

- request one URL/method/body;
- discover whether payment is required;
- state exact price and payment source;
- enforce vault funding and policy;
- return HTTP status and bounded response content;
- explain whether payment occurred and link evidence;
- expose status and recovery separately.

The terms `escrow`, `authorizedSompi`, channel reuse, v1 headers, and v1 state
are not stable output contracts. They are replaced with Purchase, Payment
Attempt, Settlement, Fulfilment, and Receipt fields.

## Behaviour deliberately removed

- `x402Version: 1`, `X-Payment`, and Sompi's `kaspa-escrow` wire profile;
- origin-keyed JSON escrow state and retired-channel readers;
- bespoke voucher/client/server orchestration in `src/x402/`;
- old escrow MCP status/refund semantics after equivalent Purchase recovery is
  available;
- old escrow contracts, fixtures, live scripts, demo text, and deployment
  examples;
- policy treatment of one escrow deposit as authorization for later requests;
- fallback or version negotiation with the old protocol.

## Existing verification map

| Invariant | Existing evidence | Phase 1 action |
|---|---|---|
| Policy limits and fail-closed reload | `src/smoke.ts`, `src/policy.ts` | Retain; replace JSON spend log in Phase 2 |
| Wallet/node guard | `src/wallet.ts`, live portions of `src/smoke.ts` | Retain; keep live checks separate from offline suite |
| Vault compiler identity | `scripts/vault-fixtures.json`, `src/smoke.ts` | Permanent golden vectors |
| Vault fee and state transitions | `src/smoke.ts`, `docs/vault-poc.md` | Permanent characterization and later crash tests |
| Agent-readable UX | `docs/agent-interaction-ux.md`, MCP handlers | Preserve intent; re-express in Purchase terms |
| x402 v1 safety | escrow fixtures/smoke | Temporary oracle only; delete in Phase 4 |
| Mainnet gating | wallet/index guards, `docs/mainnet-readiness.md` | Strengthen to release-profile denial |

## Known current crash windows

| Current action | Persisted before effect | External effect | Persisted after effect | Failure risk |
|---|---|---|---|---|
| Regular send | policy checked only | Kaspa submission | spend JSON record | Submitted payment can be absent from policy history |
| Vault send | policy checked only | Kaspa submission | vault config/outpoint and spend JSON | Chain can advance while local vault/policy state remains old |
| Vault deposit/top-up | old config | Kaspa submission | covenant/outpoint config | Deposit can exist without the local continuation pointer |
| v1 escrow open | old channel state | vault/Kaspa deposit | channel JSON | Funded escrow can be unknown locally |
| v1 voucher request | candidate amount in memory | Merchant accepts voucher and serves | channel JSON | Merchant may accept value while client state remains old |
| v1 Merchant settlement | state checked in memory | fulfilment/claim work | channel JSON/cache | retry can repeat non-idempotent work |

Phase 2 must eliminate these workflow assumptions before Phase 4 enables the
replacement payment path.

## Characterization gate

The retained baseline is considered frozen when:

- wallet and vault golden vectors still pass;
- policy semantics have explicit reservation equivalents;
- MCP response intent is mapped to the Purchase interface;
- every current irreversible effect appears in the threat model and recovery
  matrix;
- all old x402-specific behaviour is explicitly classified as temporary or
  deleted.
