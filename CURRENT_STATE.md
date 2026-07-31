# Current state

Last updated: **2026-07-31**

## Hermes balance routing repair

The live Hermes balance path is repaired.

- The canonical Sompi skill is the only active skill that owns Sompi wallet
  balance questions.
- The Hermes command uses the stable checkout venv. It does not use a removed
  Sompi compatibility path.
- The Sompi gateway drop-in puts the stable Hermes venv first in `PATH`.
  A later Sompi version change cannot write a version-specific Hermes launcher.
- A live question returned `0.8333003 tKAS` from the active epoch-20 identity.
  A follow-up question correctly identified older funds as retired epoch-19
  funds that can need owner recovery.

The epoch-19 archive passed its checksum set. Public chain evidence still
shows `9,992.2138806 tKAS` in its retired vault and `0.1 tKAS` at its retired
receive address. These funds are not part of the active available balance.
No owner key was read. No recovery transaction was created or broadcast.

The public repair evidence is in
`evidence/hermes-balance-routing-20260731/`.

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

Architecture Phase 5 is complete. It started from
`a258727aca0e735fe5ca97253c20abe9eb6a742f`.

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

P5.C2 replaces the separate normal and recovery state-routing loops with one
private Purchase progression implementation. Normal entry keeps admission,
lease, and cancellation work. Recovery keeps reconciliation and the
post-progression staging-recovery sweep. The existing 16-step normal bound and
8-step recovery bound are unchanged.

The deletion test proves that each Purchase state and lifecycle action has one
progression decision site. `PurchaseModule` still exposes only `purchase`,
`status`, and `recover`. There is no public progression seam or workflow
engine. The Journal schema, runtime composition, AP2 and Kaspa-x402 adapters,
protocol pins, release, deployment, live host, and sibling repositories did
not change.

P5.C3 characterizes the three production runtime roles without changing
production source. The API uses Purchase, Transfer, Wallet View, Policy Change,
Vault Migration proposal, Funding Intake, and cleanup capabilities. The
offline-owner role uses Vault Migration execution with the exact vault, wallet,
and Chain Evidence dependencies. Bootstrap activation uses the funding address
and balance, active vault address, Treasury operation lifecycle, and cleanup.

The role tests reject access to the complete runtime object. They map method
use at the existing narrow seams and prove the existing cleanup locations. A
construction failure after both SQLite stores open closes both stores. Runtime
cleanup returns one Promise and attempts each owned resource once.

The complete offline command ran 628 tests. Of these tests, 627 passed and one
privileged ownership test was skipped as expected. Offline smoke passed. C3
does not change the public interface, physical Journal schema, runtime
behavior, AP2 or Kaspa-x402 adapters, protocol pins, release, deployment, live
host, or sibling repositories.

P5.C4 replaces the broad runtime with three role interfaces. The API,
offline-owner, and bootstrap entrypoints receive only their required modules
and methods. One private composition function still constructs the Journal,
wallet, Treasury, protocol adapters, and operation modules.

The broad `SompiPurchaseRuntime` interface and its factory do not exist. Each
role has one frozen projection and the same memoized cleanup contract.
Construction failure closes both durable stores. API shutdown attempts all
owned cleanup steps once, even if one step fails.

The batch capitalization and refund modules remain private composition
members. They use the same Treasury instance as every other Treasury caller.
The complete offline command ran 630 tests. Of these tests, 629 passed and one
privileged ownership test was skipped as expected. Offline smoke passed. C4
changes cleanup behavior only. It does not change Purchase operation behavior,
the public interface, physical Journal schema, AP2 or Kaspa-x402 adapters,
protocol pins, release, deployment, live host, or sibling repositories.

P5.C5 completed the stop gates. Independent specification and standards
reviews found no actionable issue. The complete release verifier passed unit,
Hermes, Kaspa-x402 conformance, stored-evidence, local E2E, OpenAPI, Arazzo,
package, clean-install, licence, and source-tree checks.

A separately authorized Testnet-10 run stopped the first process with one
submitted staging Effect. The second process recovered the same Purchase,
Effect, and staging transaction. It created one payment Effect and one
Merchant exact transaction. The Purchase reached `receipted`. The public
evidence is in `evidence/phase5-c5/`. Private recovery state remains outside
the repository.

One fail-closed runner now generates either the Phase 4 or Phase 5 restart
profile. Live mode persists the real process boundary. Retained mode requires
that owner-only record to match the Journal. Two consecutive retained runs
produced the same Phase 5 proof and digest manifest without a new transaction.
One shared verifier checks both evidence sets with the same complete invariant
checks.

Phase 5 did not change the public interface, physical Journal schema, AP2 or
Kaspa-x402 adapter, protocol pin, release, deployment, live host, or sibling
repository. It did not start owner-change persistence, shared Agent
continuation, or another deferred candidate.

The architecture programme completed Phase 6. Phase 6 started from
`cde460cb80f9c5d6afa65f83431e6544e2e8f598`.

Phase 6 removes one production TypeScript dependency cycle between the
Purchase Journal, Treasury, and Transfer implementations. It moves existing
transaction and domain contracts to their correct owners. It does not create a
new persistence interface merely to wrap the concrete Journal.

Phase 6 is a clean cutover. Each checkpoint updates every caller and deletes
the old definition, import, alias, re-export, and replaced test. It keeps one
`PurchaseJournal` SQLite implementation and one transaction owner.
It does not change runtime behavior or the physical Journal schema.
It does not change the stable Purchase or Transfer interface.
It does not change AP2, Kaspa-x402, protocol pins, release, deployment, the
live host, or a sibling repository.

P6.C1 records the one current production import cycle as a six-file strongly
connected component with 12 internal edges. Tests now protect the shared
Journal lease and error identities, exact Transfer authorization evidence
across restart, and the existing Effect, durable-record, and atomic-transition
behavior.

The complete offline command ran 636 tests. Of these tests, 635 passed. The
command skipped one privileged ownership test as expected. Offline smoke
passed. C1 does not change production source or behavior.

P6.C2 moves the shared Journal errors, lease, Effects, evidence records, and
evidence input to one neutral Journal contract owner. Purchase durable records
and Purchase admission errors now have a separate Purchase contract owner.
The concrete Purchase Journal imports these contracts and does not re-export
them.

Treasury now uses the shared lease and named evidence contracts. The duplicate
Treasury staging lease and inline evidence input shapes do not exist. The
six-file implementation region now has nine directed edges. The three edges
from Treasury implementations to the concrete Purchase Journal do not exist.
`PolicyReservationError` remains for the Treasury ownership change in C3.

One `PurchaseJournal` remains the SQLite transaction owner. The physical
schema, runtime behavior, public interfaces, protocol adapter behavior, and
protocol pins did not change.

The focused C2 command passed all 150 tests. The complete offline command ran
637 tests. Of these tests, 636 passed. The command skipped one privileged
ownership test as expected. Offline smoke passed.

P6.C3 moves `PolicyReservationError` and `TreasuryOperationView` to the
Treasury operation Journal contract owner. The concrete Purchase Journal
imports these contracts and does not define or re-export them.

Production Treasury and Transfer source does not import the concrete Purchase
Journal. Transfer durable contracts remain under Transfer. The six-file
implementation region now has eight directed edges. The Purchase Journal and
Transfer Journal depend on the Treasury contract owner instead of the Treasury
implementation.

One `PurchaseJournal` remains the SQLite transaction owner. The physical
schema, runtime behavior, public interfaces, protocol adapter behavior, and
protocol pins did not change.

The focused C3 command passed all 133 tests. The complete offline command ran
639 tests. Of these tests, 638 passed. The command skipped one privileged
ownership test as expected. Offline smoke passed.

P6.C4 completes the internal clean cutover. `PaymentAttemptState` has one
Purchase contract owner. The temporary alias in the concrete Purchase Journal
does not exist. The intermediate regional edge snapshots do not exist.

The final graph test checks all 156 production TypeScript files and 722 unique
static local dependency edges. The graph has no cyclic component. The final
deletion tests prove that each moved contract has one owner and no forwarding
export. Production Treasury and Transfer source does not import the concrete
Purchase Journal.

A semantic TypeScript test proves that `PurchaseJournal` is the only concrete
implementation of both domain Journal interfaces. The scoped SQLite test
allows the in-memory schema fingerprint helper and the one filename-backed
Purchase Journal only. The existing runtime test proves one production
construction site.

The work did not split an implementation. The physical Journal schema, runtime
behavior, stable interfaces, process authority, protocol adapters, and protocol
pins did not change.

The focused C4 command passed all 8 tests. The complete offline command ran 639
tests. Of these tests, 638 passed. The command skipped one privileged ownership
test as expected. Offline smoke passed.

P6.C5 completes the final proof and stop gates. Independent specification and
architecture reviews found no actionable issue. C5 corrected five ASD-STE100
documentation findings from the first standards review. The final standards
review found no actionable issue.

The Phase 6 gate command ran 145 tests. All 145 tests passed. The full
release verifier ran 639 tests. Of these tests, 638 passed. The verifier skipped
one privileged ownership test as expected.

Offline smoke, three Hermes tests, and all five Kaspa-x402 conformance checks
passed. Stored-evidence, local E2E, OpenAPI, Arazzo, package, clean-install,
license, onboarding-preview, dependency-audit, and source-tree checks passed.

The Journal schema source is byte-identical to the Phase 6 base. Journal epoch
20, its checksum, fingerprint, and SQL tables did not change. Phase 6 did not
start owner-change persistence or shared Agent continuation. C5 did not run a
funded transaction because Phase 6 does not require fresh funded evidence.

## Current release

Sompi `0.13.4` completes architecture programme phases 1 through 6.
The release gives Purchase progression, Treasury, runtime roles, and shared
Journal contracts explicit module boundaries. It moves internal authorization
evidence to Journal epoch 20 as defined in ADR-0024.

The stable Purchase model remains independent from the AP2 and Kaspa-x402
adapters. The release removes replaced code and does not add compatibility
fallbacks.

Version `0.13.3` corrected the first vault activation path. The bootstrap
worker now handles the public Treasury operation not-found error before it
creates the first durable vault deposit intent. The regression test uses the
same public error that the production Treasury module returns.

Version `0.13.4` corrects the staged-payment readiness check found by the first
live epoch-20 Purchase. Treasury now asks the Kaspa-x402 staging adapter for a
read-only capacity quote before approval. The adapter plans the exact covenant
withdrawal shape and its fee. It does not sign, create a staging key, write the
Journal, or submit a transaction.

An insufficient vault or fee ceiling now blocks the Purchase before approval.
If capacity changes after the quote, staging returns the stable
`treasury_capacity_changed` failure. It creates no effect fence and removes
the unused staging key.

The exact live underfunded shape is a regression fixture. It uses a
`57028640`-sompi covenant UTXO, a `20000000`-sompi Merchant price, and the
`15000000`-sompi additional-cost ceiling. The quote fails closed and creates
no staging key or submission.

The complete `0.13.4` source-candidate verifier ran 643 tests. Of these tests,
642 passed. One privileged ownership test was skipped as expected. Offline
smoke, three Hermes tests, all five Kaspa-x402 conformance checks, retained
evidence, local E2E, OpenAPI, Arazzo, package, clean-install, licence,
onboarding-preview, dependency-audit, and source-tree checks passed.

The correction does not change the Journal schema, public API, AP2 behavior,
Kaspa-x402 pin or wire behavior, mainnet boundary, or a sibling repository.
It strengthens the existing Treasury staging seam and does not change an
accepted design decision. A new ADR is not necessary.

The clean-host Hermes onboarding controls from `0.12.2` remain in force.
The skill, request template, scriptless installer, preview, and privileged
command use the same version. The installer disables package lifecycle scripts
and runs only the required native dependency install script.
The installer uses `umask 022` for public runtime code.
This keeps runtime directories traversable and runtime files readable when
Host Bootstrap uses `umask 077` for private state.

A live deployment requires a controlled clean cutover to a fresh Journal
epoch-20 runtime identity. The existing epoch-19 state must remain an immutable
recovery unit.

## Release cutover

Sompi `0.13.1` added the installer correction.
It was tagged and published but was not deployed.
Host Bootstrap failed closed before funding because it checked the obsolete
Hermes `plugins.entries.sompi-approval.enabled` setting.
Version `0.13.2` verifies the active user plugin through the current Hermes
plugin list.

Version `0.13.2` was tagged, published, and installed on Terah. Host Bootstrap
committed a fresh epoch-20 identity. The separate Testnet-10 funder sent the
required `85000000` sompi to its funding address. The first vault activation
failed before it created a Treasury operation or submitted a transaction
because it handled the wrong not-found error type.

Version `0.13.3` was tagged, published, installed, and activated on Terah.
The original `0.13.2` bootstrap receipt remains the immutable provenance for
the epoch-20 identity. The Authority, API, and Hermes services now use
`0.13.3`. The first live Purchase failed closed before a staging effect because
the vault could not fund the exact staging transaction and its covenant fee.

Version `0.13.4` was tagged, published, installed, and activated on Terah.
The original `0.13.2` bootstrap receipt remains the immutable provenance for
the epoch-20 identity. The release retained the same state and authority
identity. It did not run Host Bootstrap or create a replacement Journal.

The separate Testnet-10 funder sent `50000000` sompi to the stable receive
address. Funding Intake secured the available receive-address funds in the
vault. A Telegram-approved `20000000`-sompi Purchase then reached `receipted`.
The exact payment reached accepted finality and the paid resource response
passed fulfilment verification.

## Last verified deployment

Sompi `0.13.4` is active on Terah with Journal epoch 20.
The Authority, API, Hermes Gateway, runtime commands, and package installation
use the same exact release. The epoch-20 vault activation reached accepted
Testnet-10 Chain Evidence. The `0.13.4` paid canary also reached accepted
Testnet-10 Chain Evidence.

| Item | Value |
|---|---|
| Source commit | `cf7b45d15ec51ddabde3d1c5f5d3020eec4fba24` |
| Tag | `v0.13.4` |
| Tag object | `391461c934bbb4ea31da24b7e8a7ba7d95ff1c47` |
| npm package | `@elldeeone/sompi@0.13.4` |
| Registry SHA-1 | `c7c27f24556630d38d82ff4e7a284a1de4c4df07` |
| GitHub CI | `30592481061` passed |
| Journal epoch | `20` |
| Network | `kaspa:testnet-10` |

The final live canary has these public identities:

| Item | Value |
|---|---|
| Funding transaction | `377d9e146b8426684504a07e45427279ecb29dde8eed855489298aab7a7ac27d` |
| Funding Intake transaction | `cc6548d26f4a941c04ebc3b0ed6069871d621b0a84bda65331f8cc54750012f0` |
| Purchase | `pur_SCVoKgqKifvFDCis-1qnwA` |
| Payment transaction | `a01c024e123bb7c105f65077e7ff4ae460430d245690f7812c4c26ee043b7035` |
| Payment finality | `accepted` |
| Purchase state | `receipted` |

The
[public `0.13.4` release evidence](https://github.com/elldeeone/sompi/blob/c2a1db5c59d962c960bb1403fa3f1c54e22a9f85/evidence/release-0.13.4/README.md)
records the deployment and paid canary.

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

## Retired epoch-19 runtime

The Journal epoch-19 runtime is in an immutable, private, hash-recorded
operator archive. Its release package remains available for controlled
recovery.

The `0.13.0` and `0.13.1` attempts stopped before funding and activation.
Their incomplete privileged state and Hermes projections were removed.
The active `0.13.4` runtime uses the epoch-20 identity.
The Hermes Gateway is active.
The primary Hermes checkout remains at
`2d404942471633d5338a8ff514ea7da24549274f`.

## Historical verification

The results below record earlier phase and release gates.
The current release and deployment section records the final `0.13.4` result.

The Architecture Phase 1 verifier passed on its release commit and GitHub
Node 22 runner.
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

The `@elldeeone/sompi@0.12.0` registry package is byte-identical to its
verified local artifact.

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

The architecture programme completed Phase 6.

No later architecture phase is in scope.
Deferred work remains stopped.
A new phase requires one bounded objective and the recorded start steps.
