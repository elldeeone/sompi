# Current state

Last updated: **2026-07-23**

## Current release

Sompi `0.12.1` repairs the clean-host Hermes onboarding path.
The README points to one versioned remote skill.
The skill, request template, preview, and privileged command use the same version.

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
The current documentation tree produced these local results:

- 554 unit tests ran.
- 553 tests passed.
- One root-only ownership test was skipped as expected.
- Offline smoke passed.
- All five alpha.9 conformance checks passed.
- The npm package boundary check passed.

The release artifact also passed local E2E, Hermes, OpenAPI, Arazzo, clean-install, audit, and consumer checks.

The registry package is byte-identical to the verified local artifact.
It has 225 entries and 5,143,717 packed bytes.

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

There is no active implementation phase.
See [the active implementation plan](docs/IMPLEMENTATION_PLAN.md) before you start new work.
