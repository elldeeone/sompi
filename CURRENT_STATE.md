# Current state

Last updated: **2026-07-18**

## Plain-English status

The Sompi alpha.8 Purchase implementation is merged into `main`. The active
product is an API-first modular monolith centred on the stable Purchase module:

- `sompi-api` is the canonical authenticated Purchase API;
- `sompi-mcp` is a thin, untrusted compatibility wrapper over that API;
- `sompi-authority` is the separate deterministic human-present authority;
- `sompi-operator` installs the immutable Operator Manifest;
- the demo Merchant is a test/conformance fixture.

There is no supported alpha.6 runtime, state reader, wire profile, command,
fixture, or fallback path. Journal epoch 14 is the only current epoch and old
development epochs fail closed without migration.

## Implemented protocol surface

The pinned payment contract is Kaspa-x402 `0.1.0-alpha.8`.

Exact payment supports both `kaspa-exact-v2` profiles:

- `standard-native`: the default version-0 transaction;
- `additive`: the optional version-1 KIP-10-based profile whose successor
  delta is the entire Merchant payment.

The additive profile has no separate Merchant output and no exclusive unpaid
reservation. Reusable heads are request-bound, conflict-safe, and recovered
only from trusted lineage evidence.

Batch settlement remains a separate capital-backed lifecycle. A channel
deposit never authorizes a Purchase. Each voucher increase requires its own
human-present authorization, preserves a claim-fee reserve, and is recovered
through the accepted claim/continuation or strict-boundary refund path.

AP2 v0.2 remains an experimental native-KAS, human-present, testnet-only
authorization/evidence profile. Raw AP2 and x402 artifacts are immutable
Evidence Attachments; they are not canonical Purchase state.

## Durable and trust boundaries

The Purchase module owns orchestration and recovery. Before any irreversible
effect it durably records canonical intent, authorization, policy reservation,
prepared material, idempotency identity, and effect fencing.

The Trusted Authority runs as a distinct non-agentic process. The API and MCP
processes do not hold its signing credential. The Operator Manifest owns
Merchant allow rules, Treasury policy, chain-evidence sources/floors,
admission budgets, and recovery authority.

The API exposes only the canonical `purchase`, `status`, and `recover`
operations over pre-provisioned permissioned Unix sockets. Agent/MCP and
operator recovery use separate credentials, groups, connection pools, and work
budgets. MCP has no wallet, Journal, Authority, AP2, Kaspa-x402, or Treasury
capability.

The Chain Evidence module is the only component allowed to promote raw node
observations into privileged state transitions. Testnet-10 accepted evidence
requires the pinned operator wRPC source and independent HTTPS witness;
temporary absence, pruning, contradiction, or unavailable history fails
closed.

## Terah agent deployment

Terah now runs the API-first integration described by ADR-0016:

- distinct `sompi-api` and `sompi-authority` system services;
- separate API, Authority-decision, Telegram-callback, and recovery Unix
  sockets and OS groups;
- a Hermes skill that calls only `sompi-agent`;
- a least-authority Hermes plugin that relays only authenticated Telegram
  callback data;
- no Sompi MCP server in the Hermes runtime;
- an immutable Testnet-10 Operator Manifest with per-Purchase, hourly, fee,
  Merchant-egress, and vault limits;
- an isolated vault funded with 3 TN10 KAS from the existing Forge bootstrap
  wallet without moving its private key.

The actual inline Telegram approval completed the production Purchase path as
`receipted`. The Hermes process can reach the agent API and callback socket but
cannot read Authority, wallet, operator-recovery, or bot credentials. All three
services restart cleanly with the same durable state.

## Funded Testnet-10 evidence

The active evidence set is under
[`evidence/live-testnet10/`](evidence/live-testnet10/README.md). It contains:

- standard-native exact over the canonical HTTP API;
- additive exact over MCP-over-API compatibility;
- additive head contention with one accepted winner, a no-cost loser, trusted
  absence, and a separately authorized retry;
- batch deposit, two independently authorized vouchers, claim, continuation,
  and strict-boundary refund;
- a complete human-present standard-native Purchase through the isolated
  Authority.

The funded human-present run reached `receipted` for Purchase
`pur_QW-rngf254gaI8xOl2Na9g`. Its exact transaction is
`95705c2a4e06415454d691a38f4f41adbf9cebedf958178d206c5f442371efcb`
and its canonical public-report digest is
`d550766dbe1a161566b310500192a81adfe0213bc3e6f561c652600fcf3558bd`.

That run proves:

`HTTP API -> Purchase -> separate human-present Authority -> Treasury staging
-> Kaspa-x402 standard-native -> Merchant fulfilment -> linked AP2 receipts`.

The Authority decision was recorded by its owner-only SQLite store and joined
to the same Purchase, issuer, and public report before the report was retained.
The report contains public facts only; wallet keys, Authority credentials,
private protocol payloads, and Journal databases remain outside Git.

Other canonical accepted transaction identifiers are recorded in the evidence
README. No mainnet transaction was broadcast and no mainnet claim is made.

Fresh Phase 11 evidence is under
[`evidence/phase11-terah/`](evidence/phase11-terah/README.md). On Terah it adds:

- a funded standard-native HTTP-API Purchase ending `receipted` at transaction
  `331137376e0115aabda2a323402aa7ac3889c39fa2ede391a055cbdba37c4223`;
- two funded batch Purchases, one accepted claim, its continuation, and a
  strict-boundary refund;
- restart recovery from a claim broadcast followed by temporary independent
  witness lag, without rebuilding or rebroadcasting the transaction.

## Verification and security

The Phase 11 candidate passes 491 tests: 490 pass and one documented
privileged ownership test is skipped when the host cannot change file
ownership. Its 209-file packed artifact passes the explicit archive verifier;
the final clean-tree release verifier remains the last local closeout gate.

The sealed full-branch security review covered every changed source-like file
and reported three Low/P3 availability issues. The branch bounds Chain Evidence
collections before Kaspa-WASM construction, rejects duplicate buckets, checks
cancellation during traversal, and isolates operator recovery from the
lower-trust Agent listener. The corresponding exploit regressions and complete
test suite pass.

The project owner explicitly closed additional security-scan iteration on
2026-07-17 after reviewing the completed scan and verified remediation. This is
not represented as a later zero-finding scan.

Historical deep-scan evidence and fix reports remain under
[`security/audits/2026-07-11-sompi-deep-scan/`](security/audits/2026-07-11-sompi-deep-scan/).
Older alpha.6 and Phase 2D material is historical evidence only and does not
describe the active runtime.

## Release/readiness boundary

This release is a testnet alpha implementation. It has one private,
operator-controlled Terah deployment. It does not:

- publish an npm package;
- deploy a public Sompi service;
- modify Kaspa-x402;
- enable mainnet;
- claim third-party AP2 interoperability;
- enable autonomous/open mandates, passkeys, UCP, or a generic payment-rail
  plugin system.

Mainnet remains fail-closed until the gates in
[`docs/mainnet-readiness.md`](docs/mainnet-readiness.md) are independently
satisfied.

## Current closeout

Every Phase 0–10 acceptance item has direct test or recorded evidence. Phase 11
is implemented and live-proven; its final clean-tree release verification and
local commits are the remaining closeout work. npm publishing remains blocked
by design until registry authentication is explicitly restored.
