# Current state

Last updated: **2026-07-28**

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

Architecture Phase 4 is complete. It started from
`aab94d95df42e7ffdf1ca3ff1c00bdd3e2e71fae`.

One `TreasuryModule` interface now owns quote, reservation, shared capacity,
staging preparation, staging execution, staging inspection, ambiguity,
reconciliation, and abandoned-staging recovery. One
`TreasuryOperationModule` implements the interface for Purchase and all direct
Movements.

Purchase does not define Treasury lifecycle types or call Treasury Journal
commands. Kaspa-x402 still owns its wire rules, transaction construction,
submission mechanisms, and chain observation mechanisms. The physical Journal
schema, public API, protocol pins, release, deployment, live host, and sibling
repositories did not change.

Architecture Phase 5 is scoped against
`a258727aca0e735fe5ca97253c20abe9eb6a742f`. P5.C1 is complete. P5.C2 has not
started.

Phase 5 has two objectives:

- Purchase uses one internal progression implementation for normal execution
  and recovery after each entrypoint completes its specific work.
- The API, offline-owner, and bootstrap roles receive narrow runtime
  interfaces instead of the broad `SompiPurchaseRuntime` interface.

The scope review defers owner-change persistence locality because a new
interface would mirror high-level Journal commands. It also defers shared Agent
continuation because the original trigger has not fired.

P5.C1 characterizes progression only through `PurchaseModule`. Tests now cover
normal-only entry states, submitted recovery, repeated unchanged recovery,
Treasury staging ambiguity, and both entrypoints after restart from durable
payment preparation with fresh adapter objects. They prove one durable staging
Effect and one payment Effect without changing runtime behavior or a public
interface.

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

The Architecture Phase 4 C7 candidate produced these results:

- The complete release verifier passed 619 tests: 618 passed and one
  privileged ownership test was skipped as expected.
- Offline smoke, Hermes, all five Kaspa-x402 conformance checks, stored
  evidence, local E2E, OpenAPI, Arazzo, dependency audit, package,
  clean-install, licence, and onboarding-preview checks passed.
- The funded Testnet-10 run completed three direct Treasury Movements, Purchase
  staging, and one exact payment.
- Staging and payment ambiguity both recovered to accepted evidence.
- The proof runner stopped the first process with a submitted staging Effect
  and a `failed_recoverable` Purchase. A second process observed the same Effect
  and staging transaction. It did not create a duplicate effect.
- The completed Journal contains three Treasury operations, two Effects, one
  Payment Attempt, one Settlement, and one Merchant exact transaction.
- The evidence verifier derives the restart comparison from public
  before-and-after Journal facts and exact artifact digests.
- The public Phase 4 report is in `evidence/phase4-c7/`.

The Phase 4 review remediation produced these results:

- The C7 proof runner now writes the durable process-boundary schema that the
  evidence verifier requires. A non-funded test reconstructs the committed
  restart artifact exactly.
- A cross-handle interface test now runs a Purchase reservation and a direct
  Movement at the same time. It proves shared capacity, policy replacement,
  cancellation, recovery, and expiry.
- One internal Treasury lease lifecycle now owns heartbeat, renewal, loss,
  abort, and release behavior for staging work. The public interface did not
  change.
- The full test command ran 620 tests: 619 passed and one privileged ownership
  test was skipped as expected. Offline smoke and stored-evidence verification
  passed.

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

Architecture Phase 5 C1 is complete. C2 is next.

1. P5.C1 characterized Purchase progression through the existing interface.
2. P5.C2 will consolidate normal and recovery state routing behind one private
   progression implementation.
3. P5.C3 characterizes the exact runtime needs of the API, offline-owner, and
   bootstrap roles.
4. P5.C4 replaces the broad runtime interface with narrow role interfaces.
5. P5.C5 runs the complete proof, review, deletion, and stop gates.

Phase 5 does not change the stable Purchase interface, physical Journal schema,
process authority, AP2 or Kaspa-x402 adapters, protocol pins, release,
deployment, live host, or sibling repositories. It does not include
owner-change persistence or shared Agent continuation work.
