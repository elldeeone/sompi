# Current state

Last updated: **2026-07-21**

## Status

Sompi `0.12.0` is the completed Kaspa-x402 `0.1.0-alpha.9` clean cutover
defined by ADR-0023. It is tagged, published as npm `latest`, independently
byte-verified from a fresh registry fetch, and deployed on Terah with a fresh
epoch-19 identity.

All four Kaspa-x402 packages are pinned exactly to `0.1.0-alpha.9`, including
npm integrity, source commit `49977139b8200336968f38e83a8e6700a1e3a36c`,
and annotated release tag object
`0387f7a27d55400274237cee3e2cc2ea73c82dc8`. The unmodified upstream HTTP,
consensus, exact-interoperability, and batch-interoperability vectors pass
against the installed packages and a clean build of that source commit.

Journal epoch 19 is the only supported runtime epoch. It deliberately keeps
the prior physical table shape while changing the semantic protocol and
recovery boundary. Epochs 1-18 are rejected without mutation, migration,
compatibility reader, or fallback. Active pre-alpha.9 packages, fixtures,
commands, and runtime paths are removed; older ADRs and evidence remain only as
explicitly historical records.

The full release verifier passes from a clean committed tree:

- 553 unit tests run, with 552 passing and one expected root-only ownership
  check skipped;
- offline smoke, three Hermes callback-plugin tests, deterministic local E2E,
  OpenAPI/Arazzo generation and validation, and all five alpha.9 conformance
  checks pass;
- a packed `0.12.0` artifact passes scriptless clean installation, the reviewed
  `better-sqlite3` native rebuild, package boundary checks, production audit,
  and consumer smoke;
- GitHub's Node 22 runner passes the same complete verifier. Its audit exposed
  and closed an unreferenced one-shot deadline-timer edge before publication.

## Alpha.9 protocol boundary

- Human-present AP2-derived authorization remains internal, independently
  signed evidence. Sompi makes no AP2 interoperability claim.
- Payment execution supports Kaspa-x402 exact on `kaspa:testnet-10` through the
  pinned `standard-native`, `additive`, and `batch-settlement` profiles.
- Exact authorization expires no later than its canonical alpha.9 offer or
  additive challenge. Normal work fails closed after expiry, while recovery
  may only observe or replay the already-durable immutable attempt.
- Batch requirements and commitment identifiers reproduce the language-neutral
  alpha.9 vector. Each voucher increment requires separate authorization, and
  claim/refund effects are durably committed before submission.
- Mainnet, autonomous authorization, UCP, passkeys, and a general payment-rail
  abstraction remain outside this release and require their recorded gates.

## Fresh Terah epoch-19 runtime

The former epoch-18 deployment was stopped cleanly and archived, including its
Journal, evidence, wallet and vault identity, owner recovery record, authority
state, manifest, credentials, units, binaries, and Hermes integration. The
archive is operator-private, immutable, and hash-recorded. Nothing from that
runtime was imported into epoch 19.

Terah now runs a fresh `0.12.0` identity with a new Journal, wallet, vault,
owner key, agent key, Authority state, API credential, and Operator Manifest.
The old vault was recovered exactly once with the archived offline owner record
into the new funding wallet; the temporary extracted owner key was shredded.
The new vault was then activated through the normal bootstrap lifecycle.

The authenticated Wallet View reports the new receive identity and observed
TN10 state. Every active Sompi command targets the `0.12.0` release tree;
`sompi-api`, `sompi-authority`, and the Hermes gateway are active with zero
post-start restarts.

## Fresh funded evidence

[`evidence/alpha9-clean-cutover/`](evidence/alpha9-clean-cutover/README.md)
contains the public, secret-free evidence:

- a separate-process, Telegram-approved standard-native Purchase on the fresh
  Terah epoch-19 runtime paid the public demo Merchant exactly once and reached
  `receipted`;
- explicit recovery and exact same-key replay returned that same Purchase,
  payment identifier, transaction, sole payment attempt, fulfilment, and
  receipt;
- a separate funded batch identity completed two independently authorized
  charges, one accepted claim with a correctly valued continuation and
  independent depth-confirmed evidence, and a second channel refund only after
  the strict absolute DAA boundary;
- rerunning the batch proof after its refund had durably completed resumed the
  existing Treasury operation instead of planning or submitting another
  refund. That discovered recovery boundary has a focused regression.

## Stable Sompi model and trust boundaries

- `Purchase` remains Sompi's protocol-neutral lifecycle record. Raw AP2 and
  Kaspa-x402 artifacts are content-addressed evidence attachments.
- The Purchase module owns orchestration, idempotency, policy reservations,
  durable effect fencing, recovery, fulfilment, and receipt.
- The AP2 adapter is an authorization/evidence seam. The Kaspa-x402 adapter is
  the separate payment-execution seam. Neither imports the other.
- The agentic MCP process is a thin client of the authenticated local API. It
  never holds authority credentials and is not an approval surface.
- The deterministic Trusted Authority remains a separate human-present process
  and commits signed approval evidence before any irreversible effect.
- Durable intent, exact prepared bytes, policy capacity, and effect fencing are
  committed before blockchain or Merchant side effects.

## Operator surfaces

- `sompi-api` is the canonical local application interface.
- `sompi-agent` is the agent-facing CLI and performs bounded continuation of
  the same Purchase or Transfer without authorizing replacement effects.
- `sompi-mcp` is an optional stateless compatibility wrapper over the API.
- `sompi-authority` is the isolated human-present approval service.
- `sompi-operator` provisions immutable policy, chain evidence, vault state,
  credentials, and offline-owner operations.
- `wallet` exposes one stable receive address, KAS-first balances, protection
  limits, automatic inward securing, chain status, and bounded activity.
- Direct Transfers, Policy Changes, and Vault Migrations use distinct signed
  facts and the same durable Journal and effect-fencing rules.

## Release identity

- Source commit: `09b6887dc62ea5e0f42164d90531e553660261b0`.
- Annotated tag: `v0.12.0`, tag object
  `89f5170305cd5d96733400a3bd79e1bcaf4f172b`.
- npm package: `@elldeeone/sompi@0.12.0`, dist-tag `latest`.
- Registry tarball SHA-1:
  `f0052f4f8dcbb12f8a8753479e1b29dbbf427504`.
- Registry integrity:
  `sha512-LLBC/witTt1iE5LH+TYqmXqQgz4dFSnzAY1SeLsos+E5mDCVJlRnTIS/fn+4jw6juuKC0r9AR6ypXcG12bmWZA==`.
- The fresh-cache registry tarball is byte-identical to the locally verified
  release artifact: 225 entries, 5,143,717 packed bytes, and 15,033,365
  unpacked file bytes.
- The public artifact independently passes package verification, scriptless
  clean install, the exact reviewed native rebuild, and offline smoke.
- Terah runs those exact release bytes without replacing its proven epoch-19
  state; authenticated Wallet and Purchase recovery remain healthy.
