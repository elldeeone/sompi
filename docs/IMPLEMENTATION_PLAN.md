# Sompi implementation plan

Status: **Architecture Phase 5 C2 complete**

Starting commit: `89b0f1f404ce8e5f2ded88a5b1a99d8ca1743bba`

Sompi `0.12.0` completed phases 0 through 21. The current source release is
`0.12.2`. The deployed runtime uses Kaspa-x402 `0.1.0-alpha.9` and Journal
epoch 19. Phase 3 source uses Journal epoch 20 after the internal authorization
evidence cutover in ADR-0024.

The completed plan is an archived historical record:
[`IMPLEMENTATION_PLAN_THROUGH_V0.12.0.md`](https://github.com/elldeeone/sompi/blob/c8fd02fa403b7e4f43dfa91653c0c232867d8ed8/docs/IMPLEMENTATION_PLAN.md).

Read [`CURRENT_STATE.md`](../CURRENT_STATE.md) for the current release status.

## Working rules

- Keep the repository buildable during each phase.
- Update `CURRENT_STATE.md` when a phase is complete.
- Mark a requirement complete only after its verification is complete.
- Add or change an ADR before you change an accepted design decision.
- Do not keep replaced runtime paths after a clean cutover.
- Do not change the sibling Kaspa-x402 repository without explicit scope.

## Architecture programme

This programme improves module depth, locality, and testability. Complete one
phase before work starts on the next phase.

Every phase must preserve protocol replacement:

- **PR.1:** AP2 and Kaspa-x402 wire and SDK types stay inside their adapters.
- **PR.2:** `Purchase`, Treasury, Journal, Authority, and agent interfaces use Sompi
  domain types.
- **PR.3:** A protocol upgrade replaces one exact pin, adapter, fixture set, and
  conformance record.
- **PR.4:** Temporary dual-version conformance is allowed. Permanent dual runtime paths
  are not allowed.
- **PR.5:** A protocol upgrade must not require a change to Sompi's stable domain
  model.

### Phase 1: Correct the foundation

Purpose: remove two proven correctness defects before deeper module changes.

- [x] **P1.1:** Select retained Chain Evidence by exact request facts before evidence
  strength can hide a valid matching record.
- [x] **P1.2:** Recover from matching retained evidence without calling live sources.
- [x] **P1.3:** Reject retained evidence with a different output, input, mechanism, or
  insufficient Finality Floor.
- [x] **P1.4:** Replace the Hermes compatibility `git clone --shared` operation with an
  independently durable Git checkout.
- [x] **P1.5:** Prove the compatibility checkout has no Git alternates and remains valid
  after the source checkout is removed.
- [x] **P1.6:** Preserve the selected branch, upstream remote, callback patch, and live
  virtual-environment link.

This phase implements ADR-0012 and ADR-0018. It does not change an accepted
decision, so it does not require a new ADR.

Review remediation:

- [x] **P1.R1:** Resolve a completed Treasury operation's durable observation
  to its exact accepted Chain Evidence before the live batch proof uses it.
- [x] **P1.R2:** Remove inherited Git alternates when the Hermes source checkout
  already borrows objects from another repository.

Verification gate:

- [x] **P1.G1:** Chain Evidence module tests pass through the existing interface.
- [x] **P1.G2:** Journal restart and retained-history tests pass.
- [x] **P1.G3:** Host Bootstrap tests prove `git status`,
  `git cat-file -e HEAD^{tree}`, and
  `git fsck --full` after the source checkout and its borrowed object store are
  removed.
- [x] **P1.G4:** The complete unit suite and release verifier pass.
- [x] **P1.G5:** No Journal schema, protocol adapter, release, deployment, or
  live-host change
  is included.

Completion evidence from 2026-07-23:

- The combined Phase 1 interface suite passed all 57 tests.
- The complete suite ran 559 tests: 558 passed and one privileged ownership
  test was skipped as expected.
- The complete release verifier passed the offline smoke, protocol conformance,
  package, clean-install, licence, and production audit gates.

### Phase 2: Concentrate interface and approval ownership

Do not start this phase until Phase 1 is complete.

Purpose: give the local operation and human approval boundaries one owner each,
without changing protocol bytes, runtime authority, or durable state.

- [x] **P2.1:** Make one owned operation contract drive the authenticated local server,
  client, OpenAPI, and Arazzo projections.
- [x] **P2.2:** Concentrate stable domain failures and remove transport knowledge of concrete
  Journal implementations.
- [x] **P2.3:** Make Trusted Authority own approval ceremony facts and subject rules.
- [x] **P2.4:** Keep AP2-derived evidence encoding, signed facts, profiles, and digests
  unchanged.

The operation contract is a closed catalog for the current 14 operations. It
preserves the current Agent and operator-recovery listener audiences. It is not
a runtime registry or a general transport framework.

The failure contract contains stable Sompi operation codes and safe public
meaning. HTTP status remains an HTTP projection. Expected module failures cross
the application seam through this contract. Internal Journal faults remain
internal failures.

The Trusted Authority owns the four approval display shapes, their exact
subject rules, and terminal ceremony. The AP2 adapter keeps only AP2-derived
evidence work. This phase implements ADR-0005, ADR-0006, ADR-0015, ADR-0016,
ADR-0017, ADR-0019, ADR-0021, and ADR-0022. It does not change an accepted
decision, so it does not require a new ADR.

Verification gate:

- [x] **P2.G1:** One table-driven test proves the exact 14 operation IDs,
  methods, paths, audiences, lanes, request schemas, and response schemas.
- [x] **P2.G2:** Server, client, OpenAPI, and Arazzo tests prove that all
  projections use the owned operation contract.
- [x] **P2.G3:** Stable failure tests cover not-found, conflict, invalid,
  denial, expiry, saturation, and internal-fault separation without transport
  imports from Journal.
- [x] **P2.G4:** Authority interface tests cover all four approval displays,
  exact subject IDs, terminal confirmation, Telegram presentation, and owner
  projections.
- [x] **P2.G5:** Golden Purchase Authority and AP2 evidence tests prove that
  signed facts, profiles, canonical encoding, and digests did not change.
- [x] **P2.G6:** The complete unit suite, protocol conformance suite, generated
  interface check, and release verifier pass.
- [x] **P2.G7:** No Journal schema, Kaspa-x402 source or pin, release,
  deployment, live-host, sibling-repository, or Phase 3 change is included.

Completion evidence from 2026-07-23:

- The exact operation matrix covers all 14 local operations.
- Stable failure tests keep expected failures public and internal faults private.
- Authority tests cover all four approval ceremonies and preserve AP2 evidence.
- The complete suite ran 590 tests: 589 passed and one privileged ownership
  test was skipped as expected.
- Offline smoke, all five alpha.9 conformance checks, OpenAPI, Arazzo, and the
  complete release verifier passed.
- The Kaspa-x402 pin, source, fixtures, and conformance provenance did not change.

### Phase 3: Concentrate finality and host trust verification

Do not start this phase until Phase 2 is complete.

- [x] **P3.1:** Make Chain Evidence own effective Finality Floor selection and terminal
  evidence interpretation.
- [x] **P3.2:** Keep Merchant protocol finality and Sompi operator policy as separate facts.
- [x] **P3.3:** Exercise the complete host principal, group, socket, startup, Hermes,
  rollback,
  and secret-isolation topology through the Host Bootstrap interface.

Chain Evidence receives one exact operator policy for Settlement, direct
Treasury, Vault, staging, and recovery-release operations. Callers do not
supply an operator floor or interpret raw evidence strength. Merchant
settlement assurance, operator policy, and the effective floor remain separate
facts.

The separate finality facts change immutable internal authorization bytes.
ADR-0024 replaces the Purchase Authorization, Trusted Authority, Authority IPC,
and AP2-derived evidence identities. It starts Journal epoch 20 with the same
physical SQLite shape as epoch 19. There is no migration, fallback, or dual
reader.

Host Bootstrap owns one exact trust topology. Its verification covers
principals, group memberships, socket access, startup readiness, Hermes
compatibility, rollback, and secret isolation. The phase does not install or
change a live host.

This phase implements ADR-0012, ADR-0018, and ADR-0024.

Verification gate:

- [x] **P3.G1:** Table tests prove all five operator-policy selections and both
  Merchant-strengthening directions.
- [x] **P3.G2:** Provisional, below-floor, conflicting, absent, and unavailable
  observations cannot become terminal accepted evidence.
- [x] **P3.G3:** Retained evidence stays exact and usable after restart. No
  production caller supplies a floor or imports evidence-rank logic.
- [x] **P3.G4:** Host Bootstrap interface tests prove the exact trust topology,
  readiness, Hermes compatibility, rollback, and positive and negative secret
  access.
- [x] **P3.G5:** The complete unit suite, protocol conformance suite, generated
  interface check, and release verifier pass.
- [x] **P3.G6:** The only Journal change is the documented semantic cutover to
  epoch 20. No physical schema migration, public API, Kaspa-x402 source, wire,
  package, pin, fixture, or conformance change, AP2 upstream pin change,
  release, deployment, live-host, sibling-repository, or Phase 4 change is
  included.

Completion evidence from 2026-07-24:

- Chain Evidence tests cover all five operations, both strengthening directions,
  exact retained candidates, source profiles, and DAA depth changes in both
  directions.
- The complete suite ran 604 tests: 603 passed and one privileged ownership
  test was skipped as expected. Offline smoke passed.
- The disposable root-container Host Bootstrap proof passed all 46 checks in
  the pinned Node 22.22.0 image.
- All five alpha.9 conformance checks, OpenAPI, Arazzo, and the complete release
  verifier passed on an isolated clean commit of the Phase 3 tree.
- Journal epoch 20 is one semantic cutover with the epoch-19 physical shape.
  Kaspa-x402 source, wire behavior, packages, pins, fixtures, and conformance
  provenance did not change. The AP2 upstream pin did not change.
- No release, deployment, live-host, sibling-repository, or Phase 4 change is
  included.

### Phase 4: Deepen Treasury

Phase 3 is complete. This phase is scoped against commit
`aab94d95df42e7ffdf1ca3ff1c00bdd3e2e71fae`.

Purpose: make one deep Treasury module own the complete Treasury sub-lifecycle.
Purchase continues to own the Purchase lifecycle. It uses Treasury through a
small Sompi domain interface.

The canonical implementation starts from the existing
`TreasuryOperationModule`. It absorbs the required behavior from
`VaultTreasuryModule` and Purchase. Do not create a third Treasury wrapper.

- [x] **P4.1:** Move the Treasury interface and its domain types from Purchase
  into Treasury. Purchase must not define Treasury policy, quote, staging, or
  recovery types.
- [x] **P4.2:** Make one Treasury implementation own readiness, quote, policy,
  reservation, and shared capacity for Purchase and direct Movements.
- [x] **P4.3:** Make that implementation own staging preparation, durable plan
  and prepared bytes, effect fencing, submission, observation, ambiguity, and
  reconciliation.
- [x] **P4.4:** Make that implementation own abandoned staging recovery,
  including lease takeover and the choice to observe, retry, or release.
- [x] **P4.5:** Use the same implementation for direct Movements from Transfer,
  Funding Intake, batch work, operator activation, and other current callers.
- [x] **P4.6:** Keep one `PurchaseJournal` SQLite implementation. Preserve one
  atomic transaction for policy, reservation, capacity, effect, and recovery
  state. Do not add a Treasury database or a second transaction owner.
- [x] **P4.7:** Keep Kaspa-x402 payment construction, wire handling, transaction
  submission mechanisms, chain observation mechanisms, and Merchant settlement
  inside injected Kaspa-x402 adapters. Treasury owns when these mechanisms run
  and the durable Sompi outcome. Stable Treasury and Purchase state must use
  Sompi domain types.
- [x] **P4.8:** Construct one Treasury implementation at runtime. Delete
  `VaultTreasuryModule`, replaced pass-through paths, duplicate wiring,
  Purchase-owned Treasury types, and shallow forwarding tests after equivalent
  Treasury interface tests pass.
- [x] **P4.9:** Stop after Phase 4. Repeat the deletion test and re-scope every
  remaining architecture candidate.

Implementation sequence:

1. [x] **P4.C1 — Characterize the interface.** Add Treasury interface tests for
   readiness, quote, reservation, staging, direct Movement, and recovery. Do
   not change behavior.
2. [x] **P4.C2 — Move policy and capacity ownership.** Define the Treasury-owned
   domain interface and move readiness, quote, policy, reservation, and shared
   capacity behind it. After equivalent interface tests pass, construct one
   production Treasury implementation and delete `VaultTreasuryModule`. This
   prevents policy and capacity from having two production owners.
3. [x] **P4.C3 — Move staging preparation.** Move prepared transaction planning,
   durable prepared bytes, and preparation fences behind Treasury.
4. [x] **P4.C4 — Move staging execution.** Move submission, observation, ambiguity,
   retry, and reconciliation behind Treasury.
5. [x] **P4.C5 — Move staging recovery.** Move abandoned staging recovery and lease
   takeover behind Treasury.
6. [x] **P4.C6 — Complete the clean cutover.** After C3, C4, and C5, delete the
   remaining Purchase-owned Treasury staging and recovery types, pass-through
   paths, and duplicate wiring. Verify that all current callers continue to
   use the same Treasury implementation.
7. [x] **P4.C7 — Verify and stop.** Run all offline gates, record separately
   authorized funded Testnet-10 evidence, update the state documents, and stop
   for a new architecture review.

Each sequence step must leave the repository buildable. Each move must add or
move interface tests before it deletes old implementation tests.

C1 completion evidence from 2026-07-26:

- The Purchase interface proves that fail-closed Treasury readiness prevents
  authorization, reservation, and staging.
- The same Purchase continues through an exact quote, one policy reservation,
  one staging effect, and one committed public Treasury outcome when readiness
  becomes true.
- Existing Purchase interface tests cover staging ambiguity, immutable
  prepared bytes, restart, and abandoned staging recovery.
- Existing direct Treasury interface tests cover shared Purchase and direct
  capacity, takeover, cancellation, ambiguity, preparation fences, and
  recovery without duplicate submission.
- No production source, Journal schema, protocol adapter, public interface, or
  runtime wiring changed. The full test command ran 605 tests: 604 passed and
  one privileged ownership test was skipped as expected. Offline smoke passed.

C2 completion evidence from 2026-07-26:

- Treasury now defines the Purchase-facing quote, policy, reservation, and
  capacity types.
- One `TreasuryOperationModule` instance owns startup policy synchronization,
  readiness, quote, reservation, and shared Purchase and direct Movement
  capacity.
- Purchase asks Treasury to quote and reserve capacity. Purchase no longer
  installs a policy or creates a policy reservation.
- Runtime and end-to-end composition use the same Treasury implementation for
  Purchase and direct Movements. `VaultTreasuryModule` and its shallow
  forwarding tests no longer exist.
- The implementation sequence now records this one-instance runtime cutover in
  C2. C6 retains the final staging and recovery type and path deletion after
  C3, C4, and C5.
- Purchase still owns staging preparation, execution, and recovery order.
  Treasury staging types and Journal commands remain until C3, C4, and C5.
- The physical Journal schema, protocol adapters, public API, protocol pins,
  and sibling repositories did not change.
- The focused C2 command ran 72 tests. All 72 passed. The full test command
  ran 606 tests: 605 passed and one privileged ownership test was skipped as
  expected. Offline smoke passed.

C3 completion evidence from 2026-07-26:

- Treasury defines the staging preparation input, prepared material, durable
  plan, adapter, and error types.
- Purchase asks Treasury to prepare one Purchase staging operation with only
  the Purchase ID and attempt number. Treasury returns only the durable payload
  digest. Purchase does not receive Treasury Journal or storage metadata.
- The Journal reconstructs the exact durable authorization, request,
  requirements, and Payment Attempt context. Treasury does not accept these
  facts from its caller.
- Treasury checks the Reservation and active policy. It acquires and renews an
  attempt-scoped preparation lease before it calls the Kaspa-x402 adapter.
  The Journal commits the prepared bytes and planned Effect under that lease.
- A repeated preparation request returns the existing durable plan. It does
  not call the adapter again.
- Treasury interface tests prove durable bytes, a planned Effect fence,
  idempotent replay, exclusive preparation across Treasury instances, and
  rejection of invalid prepared material.
- Staging submission, observation, ambiguity, and reconciliation remain in
  Purchase until C4. Abandoned staging recovery remains until C5.
- The physical Journal schema, Kaspa-x402 behavior and pin, public API, and
  sibling repositories did not change.
- The focused C3 command ran 114 tests. All 114 passed. The full test command
  ran 609 tests: 608 passed and one privileged ownership test was skipped as
  expected. Offline smoke passed.

C4 completion evidence from 2026-07-27:

- Purchase asks Treasury to execute one prepared staging attempt with only the
  Purchase ID and attempt number.
- Treasury owns the Effect claim, execution lease, adapter submission,
  submission acknowledgement, ambiguity fence, observation, reconciliation,
  and proof-backed retry.
- Treasury reconstructs the adapter context from the durable plan and prepared
  bytes. Purchase does not receive or submit those bytes.
- Treasury validates and records the verified staging output. Purchase receives
  only an observed, pending, or reconciliation-required result.
- The Purchase reconciler no longer observes or records Treasury staging
  Effects. It still owns payment-effect reconciliation.
- Treasury interface tests prove immediate acceptance, ambiguous submission,
  temporary pending evidence, proof-backed retry, immutable byte reuse, and
  idempotent replay.
- Abandoned staging recovery and lease takeover remain in Purchase until C5.
- The physical Journal schema, Kaspa-x402 behavior and pin, public API, and
  sibling repositories did not change.
- The focused C4 command ran 88 tests. All 88 passed. The full test command ran
  611 tests: 610 passed and one privileged ownership test was skipped as
  expected. Offline smoke passed.

C5 completion evidence from 2026-07-27:

- Purchase asks Treasury to recover abandoned staging with only the Purchase
  ID.
- Treasury owns recovery qualification, immutable sweep preparation, the
  durable recovery plan, preparation and execution leases, lease takeover,
  observation, submission, and winner recording.
- Treasury reconstructs the exact terms, payment requirements, staged output,
  reservation, and optional exact-payment candidate from the Journal.
- The Kaspa-x402 recovery adapter owns recovery transaction construction,
  submission, and chain observation mechanisms. It cannot choose or persist a
  recovery.
- Purchase no longer calls the recovery adapter or writes staging recovery
  plans and observations.
- Treasury interface tests prove one durable recovery, an expired execution
  lease takeover, one winning recovery Effect, and no duplicate submission.
  Existing Purchase tests prove restart recovery, the exact-payment winner,
  conflict, and the authorized additional-cost ceiling.
- The physical Journal schema, Kaspa-x402 behavior and pin, public API, and
  sibling repositories did not change.
- The focused C5 command ran 74 tests. All 74 passed. The full test command ran
  613 tests: 612 passed and one privileged ownership test was skipped as
  expected. Offline smoke passed.

C6 completion evidence from 2026-07-27:

- Treasury defines one `TreasuryModule` interface for quote, reservation,
  staging preparation, staging execution, staging inspection, and staging
  recovery.
- Purchase does not define or export Treasury lifecycle types. It does not
  call Treasury Journal commands.
- Treasury returns stable staged-output data to Purchase. Purchase uses a
  read-only Treasury query to reconstruct payment context after staging.
- Treasury owns expired staging abandonment. Staging preparation and recovery
  planning require the correct durable lease.
- Recovery records `execution_prepared` before it can start a planned staging
  effect. A normal Purchase retry reloads a durable staging observation after
  a recovery crash.
- A staging recovery plan accepts only its exact Purchase-scoped planning
  lease.
- Treasury owns policy, staging, and recovery Journal types. One
  `PurchaseJournal` SQLite implementation remains the transaction owner.
- Runtime constructs one `TreasuryOperationModule`. Purchase and all current
  direct Movement callers use that instance.
- Deletion tests prove that the old partial Treasury interfaces, the unfenced
  staging planner, `VaultTreasuryModule`, and duplicate runtime wiring do not
  exist. They also prove that Purchase does not call the global Treasury
  reservation-expiry command.
- The physical Journal schema, Kaspa-x402 behavior and pin, public API, and
  sibling repositories did not change.
- The focused C6 command ran 81 tests. All 81 passed. The full test command ran
  619 tests: 618 passed and one privileged ownership test was skipped as
  expected. Offline smoke passed.

C7 completion evidence from 2026-07-27:

- The complete release verifier passed 619 tests. Of these tests, 618 passed
  and one privileged ownership test was skipped as expected.
- Offline smoke, three Hermes tests, all five Kaspa-x402 conformance checks,
  the stored-evidence checks, local E2E, OpenAPI, Arazzo, dependency audit,
  package, clean-install, licence, and onboarding-preview checks passed.
- Funded Testnet-10 preflight proved a synced, UTXO-indexed node and enough
  source-wallet capacity before the approved command ran.
- The first live attempt exposed a Phase 4 regression before Purchase staging:
  the live-only policy did not include the final standard-native Merchant
  payee after Treasury took ownership of policy checks.
- The corrected live-only policy includes the exact disposable Merchant
  address. A focused 17-test live-proof suite passed.
- The funded restart proof completed three direct Treasury Movements, one
  staging transaction, and one exact payment.
- The proof runner stopped the first process after staging entered
  `failed_recoverable`. The durable pre-restart prefix contains the submitted
  staging Effect and its exact transaction ID.
- A second process recovered the same Purchase, Effect, and staging
  transaction. Staging moved through `ambiguous` to `observed`. The payment
  moved through `executing`, `ambiguous`, and `observed`.
- The completed Journal contains three Treasury operations, two Effects, one
  Payment Attempt, one Settlement, and one Merchant exact transaction.
- The evidence verifier derives these facts from the before-and-after Journal
  records and exact artifact digests. It does not trust asserted restart
  booleans.
- Public evidence is in `evidence/phase4-c7/`. Private recovery state and
  disposable Testnet keys remain outside the repository.

Verification gate:

- [x] **P4.G1:** Treasury interface tests cover readiness, quote, reservation,
  staging, direct Movement, and effect recovery.
- [x] **P4.G2:** Concurrent Purchase and direct Movement tests prove shared
  capacity, policy replacement, expiry, cancellation, and recovery use one
  atomic Journal transaction.
- [x] **P4.G3:** Staging tests cover cancellation, ambiguous submission,
  preparation fences, restart, reconciliation, recovery races, and one winning
  effect.
- [x] **P4.G4:** Direct Movement tests cover lease takeover, stale
  predecessors, cancellation, ambiguous submission, preparation fences,
  restart, and adapter failures.
- [x] **P4.G5:** Import and deletion checks prove that Purchase does not own
  Treasury lifecycle types or Treasury Journal commands. The old pass-through
  module, duplicate runtime wiring, and forwarding tests do not exist.
- [x] **P4.G6:** The complete unit suite, offline smoke, all five Kaspa-x402
  conformance checks, generated OpenAPI and Arazzo checks, and the release
  verifier pass.
- [x] **P4.G7:** Fresh funded Testnet-10 evidence proves staging execution,
  direct Movement execution, ambiguous-effect recovery, and restart recovery
  without a duplicate effect. This gate requires separate approval before any
  funded command runs.
- [x] **P4.G8:** No public API, physical Journal schema, Kaspa-x402 source,
  wire, package, pin, fixture, or conformance change, AP2 upstream pin change,
  release, deployment, live-host, sibling-repository, or deferred-work change
  is included.

Post-completion review remediation from 2026-07-27:

- The C7 proof runner produces the durable process-boundary schema that the
  evidence verifier requires. A non-funded test reconstructs the committed
  restart artifact exactly.
- P4.G2 now has one cross-handle interface test. It runs Purchase reservation
  and direct Movement preparation at the same time.
- One internal Treasury lease lifecycle owns the repeated staging heartbeat,
  renewal, loss, abort, and release behavior. `TreasuryModule` did not change.
- The full test command ran 620 tests: 619 passed and one privileged ownership
  test was skipped as expected. Offline smoke and stored-evidence verification
  passed.

Add or amend an ADR before implementation if the cutover needs a physical
Journal schema change or changes an accepted architecture decision. Do not add
a universal payment-rail interface. A second real execution adapter must prove
the need for that interface.

## Post-Phase-4 re-scope

Phase 4 repeated the deletion test for every recorded candidate. The Phase 5
scope review then applied the original report trigger and repeated the deletion
test for each retained candidate.

| Candidate | Decision | Evidence |
|---|---|---|
| Direct Chain Evidence provenance in stable records | Remove | Chain Evidence already owns provenance. Stable records carry evidence digests. Raw protocol evidence stays in Evidence Attachments. |
| Policy Change and Vault Migration locality | Defer | Both modules use high-level domain commands on the one concrete `PurchaseJournal`. A new persistence interface would mirror these commands and would not remove complexity. Reopen this candidate after a second persistence implementation or a repeated ownership defect. |
| Transfer persistence locality | Remove | Transfer already owns the narrow `TransferJournal` seam. The shared SQLite implementation preserves one transaction owner. |
| Funding Intake and Wallet View projection locality | Remove | Both modules are bounded and use narrow `Pick` dependencies. There is no second implementation or proven behavior split. |
| Purchase projection locality | Remove | The pure Purchase projector already owns stable summaries, evidence-digest projection, and fulfilment limits. |
| Purchase lifecycle progression | Activate in Phase 5 | Phase 4 changed Treasury effect ownership and recovery order. The coordinator still has separate normal and recovery state-routing loops. One internal progression implementation can remove this duplicated decision surface without changing the Purchase interface. |
| Runtime interface reduction | Activate in Phase 5 | The composition root exposes 14 concrete runtime properties. The API, offline-owner, and bootstrap entrypoints each use a smaller role-specific subset. |
| Shared Agent continuation mechanics | Defer | The original trigger has not fired. There is no third continuation policy or another shared correction. Purchase and Transfer keep separate valid lifecycle rules. |
| Host Bootstrap to Operator Provisioning translation | Remove | Phase 3 added one explicit `operatorSpecForHostBootstrap` translation and the complete host proof passed. |
| Host release binding and deeper Hermes compatibility ownership | Merge into the closed Host Bootstrap item | Phase 1 and Phase 3 fixed checkout durability, release binding, topology, rollback, and compatibility ownership. The release verifier passed. |

### Phase 5: Deepen Purchase progression and reduce runtime exposure

Phase 4 is complete. Phase 5 is scoped against commit
`a258727aca0e735fe5ca97253c20abe9eb6a742f`. P5.C1 and P5.C2 are complete.
P5.C3 has not started.

Purpose: remove two proven internal decision leaks. Keep the stable Purchase
interface, process authority, durable state, and protocol seams unchanged.

The phase has two implementation objectives:

- Purchase uses one internal progression implementation after each entrypoint
  completes its entry-specific work. Normal execution and recovery no longer
  contain separate state-to-action decision surfaces.
- Runtime composition presents the smallest interface needed by the API,
  offline-owner, and bootstrap roles. Private construction can be shared, but
  production roles do not receive unused capabilities.

Do not create a workflow engine, a runtime plug-in system, a second Journal, or
a public progression interface. Do not include owner-change persistence or
shared Agent continuation work.

Implementation sequence:

1. [x] **P5.C1 — Characterize Purchase progression.** Add tests through the
   existing Purchase interface for normal progression, recovery progression,
   restart, unchanged-state bounds, and no duplicate external effect. Do not
   change runtime behavior. Estimated effort: 0.5–1 day.
2. [x] **P5.C2 — Consolidate Purchase progression.** Use one private
   progression implementation after normal-entry and recovery-specific work.
   Keep action implementations inside Purchase. Delete the duplicate
   state-routing loop after equivalent interface tests pass. Estimated effort:
   4–7 days.
3. [ ] **P5.C3 — Characterize runtime roles.** Add interface tests that prove
   the exact capabilities and cleanup behavior needed by the API,
   offline-owner vault-migration, and bootstrap vault-activation entrypoints.
   Do not change runtime behavior. Estimated effort: 0.5–1 day.
4. [ ] **P5.C4 — Reduce runtime exposure.** Replace the broad exported runtime
   interface with the smallest role-specific interfaces proved by C3. Share
   private construction without creating duplicate composition roots,
   Journals, wallets, or cleanup paths. Delete the broad interface and replaced
   tests after the role interfaces pass. Estimated effort: 2–4 days.
5. [ ] **P5.C5 — Verify and stop.** Run every Phase 5 gate, complete an
   independent architecture review, update the state documents, and stop before
   any deferred candidate starts. Estimated effort: 1–2 days.

C1 completion evidence from 2026-07-28:

- The coordinator fixture exposes only `PurchaseModule`. The test does not use
  a new progression interface or a private coordinator action.
- Recovery leaves `terms_bound` and `awaiting_authority` unchanged. It does not
  request human approval or start a Treasury or payment effect. Normal
  `purchase` progression can resume both states.
- A submitted payment stays unchanged on normal replay. Repeated pending
  recovery observes it once per request and never submits it again. A later
  Settlement completes the same Purchase.
- Repeated pending Treasury staging recovery does not prepare an exact payment
  or submit staging again. After a Journal restart, both entrypoints use fresh
  adapter objects and reuse the durable payment preparation. Each result has
  one staging Effect and one payment Effect.
- The Purchase coordinator suite passed 39 tests. The complete offline command
  passed 622 tests: 621 passed and one privileged ownership test was skipped as
  expected. Offline smoke passed.

C2 completion evidence from 2026-07-28:

- One private `progressPurchase` implementation owns the bounded loop and the
  state-to-action decision for all 14 Purchase states.
- Normal entry keeps admission, the coordination lease, and cancellation
  cleanup. Recovery keeps payment reconciliation, Treasury staging
  reconciliation, and the post-progression staging-recovery sweep.
- Recovery leaves `created`, `terms_bound`, and `awaiting_authority` unchanged.
  Normal entry can resume each state.
- The deletion test proves one case for each Purchase state, one call site for
  each lifecycle action, and two calls to the private progression method.
  `PurchaseModule` still exposes only `purchase`, `status`, and `recover`.
- The change does not add a workflow engine or a public progression seam. It
  does not change protocol adapters, the Journal schema, runtime composition,
  protocol pins, or a sibling repository.
- The focused Purchase and boundary command passed 41 tests. The complete
  offline command passed 624 tests: 623 passed and one privileged ownership
  test was skipped as expected. Offline smoke passed.

Each checkpoint must leave the repository buildable. Add interface tests before
deleting the behavior or interface that they replace.

Verification gate:

- [ ] **P5.G1:** Purchase interface tests prove the same durable result for
  normal progression and recovery from every supported resumable state.
- [ ] **P5.G2:** Failure-injection and restart tests prove that consolidated
  progression does not repeat authorization, Treasury staging, payment,
  settlement, or fulfilment effects.
- [ ] **P5.G3:** Deletion checks prove that Purchase has one state-to-action
  progression decision surface. No public progression seam or generic workflow
  implementation exists.
- [ ] **P5.G4:** Runtime interface tests prove least-capability API,
  offline-owner, and bootstrap roles, including construction failure and
  idempotent cleanup.
- [ ] **P5.G5:** Deletion checks prove that the broad
  `SompiPurchaseRuntime` interface and production access to unused runtime
  properties do not exist. One Journal transaction owner remains.
- [ ] **P5.G6:** The complete unit suite, offline smoke, all five Kaspa-x402
  conformance checks, generated OpenAPI and Arazzo checks, stored-evidence
  checks, and the release verifier pass.
- [ ] **P5.G7:** Fresh, separately authorized Testnet-10 evidence proves
  restart recovery of one Purchase without a duplicate staging or payment
  effect.
- [ ] **P5.G8:** No public interface, physical Journal schema, AP2 or
  Kaspa-x402 adapter, protocol pin, release, deployment, live-host, or sibling
  repository change is included.

This phase deepens implementations accepted in ADR-0002, ADR-0008, ADR-0013,
ADR-0015, and ADR-0018. It does not change an accepted decision. Add or amend
an ADR before implementation if a checkpoint changes one of those decisions.

## Deferred work

### Autonomous authorization

Do not start this work until human-present authorization has sufficient
evidence. A new ADR must specify limits, revocation, escalation, and recovery.

This work includes recipient grants. Each grant must have these properties:

- The Trusted Authority signs the grant.
- The user can revoke the grant.
- The grant specifies one network and one recipient.
- The grant specifies amount and time limits.
- The grant cannot increase Operator Manifest limits.

### Passkeys

Do not start this work until the threat model specifies enrollment, recovery,
key rotation, device loss, RP ID, and origins.

### UCP

Do not start this work unless Sompi owns a commerce lifecycle. This lifecycle
can include catalogs, carts, tax, shipping, orders, or fulfillment.

### Kaspa-x402 upstream alignment

This work belongs to Kaspa-x402. Sompi can use a future upstream release after
separate review and conformance verification.

### Mainnet

Mainnet requires a new ADR and explicit user approval. It also requires all
gates in [`mainnet-readiness.md`](mainnet-readiness.md).

## Start a new phase

1. Define one bounded objective.
2. Add or change the applicable ADRs.
3. Add numbered requirements and verification gates to this file.
4. Record the starting commit in `CURRENT_STATE.md`.
5. Complete the phase without work from a later phase.
