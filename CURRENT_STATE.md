# Current state

Last updated: **2026-07-23**

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

Architecture Phase 2 is recorded but inactive.

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

Architecture Phase 2 is the next recorded phase, but it is inactive.
Do not start it without explicit user authorization.
