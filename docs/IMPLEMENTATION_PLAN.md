# Sompi implementation plan

Status: **Architecture Phase 3 complete**

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

Do not start this phase until Phase 3 is complete.

- **P4.1:** Make one Treasury module own capacity, custody, staging, Movement, and effect
  recovery behind its existing interface.
- **P4.2:** Preserve one atomic SQLite Journal transaction for shared policy and
  capacity.
- **P4.3:** Keep Kaspa-x402 payment construction, wire handling, and Merchant settlement
  inside the Kaspa-x402 adapter.
- **P4.4:** Delete replaced Treasury pass-through paths and their implementation tests
  after equivalent Treasury interface tests pass.
- **P4.5:** Stop after Phase 4 and re-scope every remaining candidate.

## Post-Phase-4 re-scope candidates

These items are recorded, not active. Re-test each candidate after Treasury is
deepened. Remove any candidate that no longer provides proven leverage.

- Direct Chain Evidence provenance in stable records.
- Policy Change and Vault Migration locality.
- Transfer persistence locality.
- Funding Intake and Wallet View projection locality.
- Purchase projection locality.
- Purchase lifecycle progression.
- Runtime interface reduction.
- Shared Agent continuation mechanics.
- Host Bootstrap to Operator Provisioning translation.
- Host release binding and deeper Hermes compatibility ownership.

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
