# Current state

Last updated: **2026-07-27**

## Architecture programme

Architecture Phase 1 is complete. It started from
`89b0f1f404ce8e5f2ded88a5b1a99d8ca1743bba`.

The completed corrections now have these properties:

- Retained Chain Evidence must match the transaction, outputs, expected inputs,
  mechanism, and effective Finality Floor.
- A matching retained record works after restart without a live source call.
- A completed Treasury operation resolves its durable observation to the exact
  accepted Chain Evidence used by the live batch proof.
- The Hermes compatibility checkout has no Git alternates, even when its source
  borrows objects, and remains valid after both source stores are removed.

The phase does not change the Journal schema, AP2 or Kaspa-x402 adapters,
release artifacts, deployment, or the live Terah host.

Architecture Phase 2 is complete. It started from
`64177e16497b7279de7eca39cb144282f4e7d0f8`.

The completed changes now have these properties:

- One closed contract owns the current 14 local operations and drives the
  server, client, OpenAPI, and Arazzo projections.
- Stable operation failures are separate from HTTP status. Internal storage
  faults remain private.
- Trusted Authority owns approval display facts, subject rules, terminal
  confirmation, Telegram presentation, and owner projections.
- The AP2 adapter owns only AP2-derived verification and evidence work.
- AP2-derived bytes and the Kaspa-x402 pin, source, fixtures, and conformance
  provenance are unchanged.

No accepted decision changes in this phase. No new ADR is required.

Architecture Phase 3 is complete. It started from
`484ad800cb1f74261ca5c7ae746fbb3cb0563e1a`.

The completed changes now have these properties:

- Chain Evidence owns Finality Floor selection and terminal evidence meaning
  for all five operation policies.
- Merchant assurance, operator policy, effective floor, and DAA depth are
  separate facts.
- Retained raw DAA evidence is exact and can change between accepted and
  depth-confirmed in both directions.
- Host Bootstrap owns and verifies the exact principal, group, socket, startup,
  Hermes, rollback, and secret-isolation topology.
- The internal authorization identities, Authority IPC, and Journal epoch use
  the clean semantic cutover in ADR-0024.

The current source uses the internal authorization profiles and Authority IPC
version in ADR-0024. It accepts only Journal epoch 20. Epoch 20 has the same
physical SQLite shape as epoch 19. There is no migration, fallback, or dual
reader.

The phase does not change the public API, Kaspa-x402 source, wire behavior or
pins, the AP2 upstream pin, release artifacts, deployment, the live Terah host,
or a sibling repository. It does not include Phase 4 Treasury work.

This phase implements accepted ADR-0012, ADR-0018, and ADR-0024.

## Current release

Sompi `0.12.2` repairs the clean-host Hermes onboarding trust boundary.
The README points to one versioned remote skill.
The skill, request template, scriptless installer, preview, and privileged command use the same version.

The installer disables all package lifecycle scripts during installation.
It verifies and runs only the required native dependency install script.
The privileged command downloads the installer into a root-owned temporary directory and verifies its pinned SHA-256 before execution.

Do not use `0.12.1` for clean-host onboarding.
That release can run unreviewed package lifecycle scripts before privileged bootstrap.

The Git tag, npm package, and source contain the same release tree.
This release does not change the deployed Terah runtime.

## Deployed release

Sompi `0.12.0` is the completed Kaspa-x402 `0.1.0-alpha.9` clean cutover.
ADR-0023 defines this release.

The npm `latest` package, Git tag, source, and deployed Terah bytes match.
The Terah runtime uses a fresh Journal epoch-19 identity.

| Item | Value |
|---|---|
| Source commit | `09b6887dc62ea5e0f42164d90531e553660261b0` |
| Tag | `v0.12.0` |
| Tag object | `89f5170305cd5d96733400a3bd79e1bcaf4f172b` |
| npm package | `@elldeeone/sompi@0.12.0` |
| Registry SHA-1 | `f0052f4f8dcbb12f8a8753479e1b29dbbf427504` |
| Journal epoch | `19` |
| Network | `kaspa:testnet-10` |

## Protocol boundary

Sompi pins all four Kaspa-x402 packages to `0.1.0-alpha.9`.
The pin includes npm integrity, source commit, and annotated release tag data.

The supported payment profiles are:

- `standard-native`
- `additive`
- `batch-settlement`

Human-present AP2-derived authorization is an internal Sompi profile.
Sompi does not claim AP2 interoperability.

The release does not support mainnet, autonomous authorization, passkeys, or UCP.
It does not provide a general payment-rail interface.

## Runtime

The active Terah runtime uses new Journal, wallet, vault, Authority, and API identities.
No epoch-18 runtime state was imported.

The old runtime is in an immutable, private, hash-recorded operator archive.
The old vault was recovered once with its offline owner record.
The temporary extracted owner key was then destroyed.

The new vault was activated through the normal bootstrap lifecycle.
The API, Authority, and Hermes gateway are active.

The Hermes compatibility checkout is a valid Git checkout.
It follows upstream `main` and keeps the exact Sompi callback patch.
Hermes reports that it is current at `d604141d097eec4a49493ad1eaceb9b2ca1e496d`.

## Verification

The complete release verifier passed on the release commit and GitHub Node 22 runner.
The Architecture Phase 1 tree produced these local results:

- 559 unit tests ran.
- 558 tests passed.
- One root-only ownership test was skipped as expected.
- Offline smoke passed.
- All five alpha.9 conformance checks passed.
- The npm package boundary check passed.

The complete release verifier also passed local E2E, Hermes, OpenAPI, Arazzo,
clean-install, licence, audit, and consumer checks.
The clean-host candidate test used the SHA-256-pinned scriptless installer and reached the privileged boundary.

The registry package is byte-identical to the verified local artifact.

The Architecture Phase 2 tree produced these local results:

- 590 unit tests ran.
- 589 tests passed.
- One root-only ownership test was skipped as expected.
- Offline smoke passed.
- All five alpha.9 conformance checks passed.
- OpenAPI and Arazzo generated-interface checks passed.
- The complete release verifier passed on an isolated clean copy of the exact
  Phase 2 tree.
- The Kaspa-x402 source, pin, fixtures, and conformance provenance did not change.

The Architecture Phase 3 tree produced these local results:

- 604 unit tests ran.
- 603 tests passed.
- One root-only ownership test was skipped as expected.
- Offline smoke passed.
- The disposable root-container Host Bootstrap proof passed all 46 checks in
  the pinned Node 22.22.0 image.
- All five alpha.9 conformance checks passed.
- OpenAPI and Arazzo generated-interface checks passed.
- The complete release verifier passed on an isolated clean commit of the exact
  Phase 3 tree.
- The Kaspa-x402 source, wire behavior, packages, pins, fixtures, and
  conformance provenance did not change. The AP2 upstream pin did not change.

## Funded evidence

The [alpha.9 clean-cutover evidence](https://github.com/elldeeone/sompi/blob/c8fd02fa403b7e4f43dfa91653c0c232867d8ed8/evidence/alpha9-clean-cutover/README.md) is public and contains no secrets.

It records these completed Testnet-10 cases:

- one Telegram-approved `standard-native` Purchase
- exact same-key replay and recovery without a second payment
- two separately authorized batch charges
- one accepted batch claim with correct continuation value
- one refund after the strict absolute DAA boundary
- restart recovery without a second refund submission

The standard-native case used a human Telegram decision.
The batch case used an in-process auto-approved fixture.
It does not prove a human-present batch ceremony.

## Stable boundaries

`Purchase` is the stable, protocol-neutral lifecycle record.
Raw AP2 and Kaspa-x402 data stays in immutable Evidence Attachments.

The Purchase module owns orchestration, recovery, fulfillment, and receipt.
The AP2 adapter owns authorization evidence.
The Kaspa-x402 adapter owns payment execution.

The agent process is an API client only.
It has no Authority, wallet, or operator credential.
The deterministic Trusted Authority records signed human approval before an irreversible effect.

## Next work

Architecture Phase 3 is complete.
Architecture Phase 4 is active. It started from
`aab94d95df42e7ffdf1ca3ff1c00bdd3e2e71fae`.

Phase 4 C4 is complete. Treasury now owns Purchase staging preparation and
execution. It owns prepared material validation, durable prepared bytes, the
planned Effect fence, submission, observation, ambiguity, reconciliation, and
proof-backed retry.

Purchase uses two small Treasury operations. It calls
`preparePurchaseStaging` and `executePurchaseStaging` with only the Purchase ID
and attempt number. It does not receive or submit staging bytes. The Purchase
reconciler no longer observes or records Treasury staging Effects.

The Kaspa-x402 adapter still owns protocol checks and transaction preparation.
It also owns staging submission and chain observation mechanisms. Treasury owns
when those mechanisms run and when their Sompi outcome becomes durable. It
reconstructs the exact adapter context from the Journal. An ambiguous effect
is observed before any proof-backed retry. A retry uses the same durable bytes.

Purchase still owns abandoned staging recovery and lease takeover until C5.
The physical Journal schema, Kaspa-x402 behavior and pin, public API, and
sibling repositories did not change.

The focused C4 command ran 88 tests. All 88 passed. The full test command ran
611 tests: 610 passed and one privileged ownership test was skipped as
expected. Offline smoke passed.

Phase 4 C5 is next. Do not start C5 until its staging recovery move is
explicitly started.
