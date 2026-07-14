# Sompi AP2 + Kaspa-x402 implementation plan

Status: **Phase 2D remediation round 2 verified — ready for independent re-review; Phase 3 not started**

Architecture: [`docs/architecture/SOMPI_ARCHITECTURE.md`](architecture/SOMPI_ARCHITECTURE.md)

Decisions: [`docs/adr/`](adr/README.md)

## Working rule

Each phase must leave the repository buildable and its completed invariants
verified. Update `CURRENT_STATE.md` at the end of each phase. Do not check an
item merely because code exists; check it only after the corresponding test or
recorded evidence passes.

The clean cutover does not preserve old x402 runtime behaviour. Temporary
characterization scaffolding may exist while extracting the Purchase module,
but all replaced code is deleted at the Phase 4 cutover gate.

## Phase 0: Normalize the Git base

Purpose: establish one unambiguous base before architectural work.

- [x] Reconfirm the worktree is clean and `ux-agent-native-payments` is the
  intended latest branch.
- [x] Fast-forward local `main` to `ux-agent-native-payments` without squashing
  or rewriting its proven history.
- [x] Verify the resulting `main` build and offline smoke tests.
- [x] Create a neutral implementation branch from the normalized `main`.
- [x] Record exact base commit and implementation branch in `CURRENT_STATE.md`.

Gate:

- `main` and the implementation base identify the same verified commit.
- No unrelated or untracked user work is lost.
- No remote branch is pushed or deleted without explicit user instruction.

## Phase 1: Characterize, model threats, and freeze interfaces

Purpose: retain proven product behaviour without retaining obsolete protocol
architecture.

- [x] Characterize MCP tool inputs, structured results, human summaries, and
  recovery guidance that must survive the refactor.
- [x] Add golden vectors for wallet derivation/signing and consensus-vault
  creation, spend cap, continuation, and owner recovery.
- [x] Characterize current policy behaviour and identify every authorize,
  reserve, record, and release point.
- [x] Map existing irreversible effects and crash windows in wallet, vault,
  x402 client/server, and Merchant demo paths.
- [x] Write the implementation threat model covering Agent/MCP, authority IPC,
  Merchant evidence, egress/SSRF, SQLite, secrets, Kaspa RPC, replay, and
  ambiguous network outcomes.
- [x] Define the narrow Purchase module interface and canonical identifiers in
  Sompi terms.
- [x] Define one central supported-protocol-profile declaration.
- [x] Select and pin an exact AP2 v0.2 upstream commit/schema profile and exact
  Kaspa-x402 version/commit for the first implementation; record provenance.

Gate:

- Tests fail if existing vault/wallet invariants regress.
- The threat model identifies trust, data flow, external effects, and recovery
  for every Purchase transition.
- No AP2 or x402 SDK type appears in the Purchase interface.

## Phase 2: Build the Purchase Journal and recovery foundation

Purpose: make workflow durability part of correctness before introducing the
new payment path.

- [x] Add SQLite with explicit transaction and crash-safety configuration.
- [x] Implement schema/version management for the new architecture only.
- [x] Implement Purchase, state transition, transition history, and evidence
  metadata tables.
- [x] Implement unique Purchase and payment identifiers.
- [x] Implement atomic policy reservations, finalization, release, and expiry.
- [x] Implement planned-effect/outbox records and submission observations.
- [x] Persist prepared payment material or secure references before submission.
- [x] Implement startup reconciliation and single-writer/recovery coordination.
- [x] Ensure authority/wallet private keys and sensitive secrets are not stored
  in journal plaintext or logs.
- [x] Add fault injection around every transaction/effect edge.

Gate:

- Restart tests distinguish not-attempted, prepared, submitted-unobserved,
  settled, fulfilled, and receipted states.
- Duplicate Purchase/payment identifiers and replayed effects are rejected.
- Policy capacity cannot be lost or double-consumed across a crash.
- Recovery does not blindly resubmit a possibly executed payment.

## Phase 2A: Codify the validated security architecture

Purpose: make the completed deep-scan evidence and cross-repository covenant,
AP2, and x402 validation authoritative before implementation changes.

- [x] Preserve the canonical scan report, manifest, findings, coverage, and
  selected hardening proposals outside temporary storage.
- [x] Add Operator Provisioning, Operator Manifest, Chain Evidence, Finality
  Floor, and Admission Lease to `CONTEXT.md`.
- [x] Accept ADRs for Operator Provisioning, Chain Evidence/finality, and
  bounded operation lifecycles; explicitly amend ADR-0008.
- [x] Record native covenant-ID versus KIP-10 script-template continuation
  evidence and valid owner termination.
- [x] Record that local depth confirmation is not Kaspa consensus finality.
- [x] Update this plan, the target architecture, threat model, and
  `CURRENT_STATE.md` to one consistent source of truth.

Gate:

- Documentation links and accepted ADR index are complete.
- No decision requires changes to AP2/x402 wire objects or Kaspa-x402.
- The repository baseline suite still passes.

## Phase 2B: Install trusted operator configuration

Purpose: remove recovery authority, policy, transport, and evidence trust from
the Agent-facing data path before those facts drive more runtime work.

- [x] Implement a strict, canonical, versioned Operator Manifest with digest
  and monotonic revision.
- [x] Implement secure operator-owned installation and descriptor-stable
  runtime reads with exact ownership/mode/link/ancestor checks.
- [x] Add short-lived `sompi-operator` preview/install/provision/status flows.
- [x] Validate owner and generated Agent values as real secp256k1 x-only public
  keys; bind Agent public key, template, derived address, and exact vault-config
  digest before runtime ownership transfer or funding.
- [x] Project immutable Treasury policy, vault bootstrap, HTTPS Merchant egress,
  Chain Evidence sources/floors, and Admission Lease budgets.
- [x] Bind manifest identity into vault configuration, policy snapshots,
  Purchases, Treasury operations, and Chain Evidence.
- [x] Remove MCP `vault_create`, MCP owner-key generation, `SOMPI_POLICY`,
  policy hot reload, production HTTP opt-in, and all runtime fallbacks.
- [x] Reject funded-vault static-parameter drift and require explicit owner
  recovery/recreation.

Gate:

- The MCP process has no manifest installer or vault recovery-authority setter.
- Symlink, hardlink, owner, mode, ancestor, rename, byte, revision, x-only-key,
  and manifest-drift tests fail closed.
- Hermetic fixtures may inject HTTP only without real Treasury credentials.
- Focused provisioning PoCs, full suite, and packed-artifact smoke pass.

## Phase 2C: Centralize Chain Evidence and finality

Purpose: make one deep module own transaction identity, evidence levels,
history, negative evidence, continuation semantics, and Finality Floors.

- [x] Define typed provisional, accepted, depth-confirmed, consensus-final,
  historical, absent, unknown, and unavailable evidence.
- [x] Keep protocol finality, operator depth policy, and Kaspa consensus
  finality as separate durable fields.
- [x] Persist Merchant protocol finality and Sompi's effective operator floor
  separately; display/sign the effective floor in Authority/AP2 evidence.
- [x] Implement distinct native covenant-binding and KIP-10 script-template
  continuation evidence variants plus valid vault owner termination.
- [x] Persist accepted transaction/spend/continuation evidence before terminal
  Purchase, wallet, vault, staging, recovery, or capacity-release transitions.
- [x] Treat RPC errors, pruning, missing current UTXOs, and contradictory
  sources as unknown/unavailable rather than absence.
- [x] Enforce operation-specific operator floors; Merchant requirements may
  strengthen but never lower them; mempool never terminalizes state.
- [x] Route exact Settlement, wallet send, vault deposit/send/continuation,
  staging, recovery-winner selection, and policy release through the module.
- [x] Implement the private Testnet-10 two-witness adapter (operator wRPC plus
  independent HTTPS accepted-chain evidence) and durable history profile
  without changing Kaspa-x402.

Gate:

- All thirteen chain evidence/finality PoCs fail against the fixed behavior.
- Spent/pruned-output restart tests reconcile from retained accepted evidence.
- A lying or unavailable single RPC cannot mint stronger evidence than its
  configured profile permits.
- Full suite and live read-only Testnet-10 evidence checks pass.

## Phase 2D: Bound operational lifecycles

Purpose: prevent retained sockets, prompts, evidence, Purchases, or Treasury
preparations from exhausting the system or surviving without a safe terminal
path.

- [x] Add pre-authentication socket and authenticated-prompt Admission Leases
  inside the Trusted Authority.
- [x] Add pre-validation Purchase-count and Evidence Attachment byte Admission
  Leases inside the Purchase module/Journal.
- [x] Add bounded direct-Treasury preparation retries and exclusive-slot lease
  recovery inside the Treasury module.
- [x] Install conservative budgets through the Operator Manifest and expose
  stable secret-free saturation status.
- [x] Define cancellation, timeout, restart expiry, operator recovery, and
  observability at each owning module.
- [x] Preserve leases/reservations and enter Reconciliation after any possible
  external effect.
- [x] Reopen and remediate the independent review of the initial Phase 2D
  implementation: durable Treasury reducer/driver generations, MCP signal
  propagation, exhaustive production preparation outcomes, cancellation/fence
  CAS, Authority abort propagation, prompt-before-replay admission, compound
  Purchase/evidence admission, digest-scoped publication ownership, and the
  three additional engineering blockers.
- [x] Correct the follow-up review defects: stale Treasury predecessors cannot
  outlive takeover, compound Purchases remain counted, Vault preparation
  outcomes are exhaustive, and waiter takeover drives the lease it acquired.
- [x] Bump the clean-cutover Journal schema to epoch 10 and reject epochs 1–9
  untouched; verify migration and restart behavior.
- [x] Rerun the three canonical follow-up PoCs, the Treasury takeover safety
  PoC, focused lifecycle suites, the complete npm test, all 13 offline smoke
  checks, package verification, and the pinned live Testnet-10 proof.
- [x] Remediate the sealed re-review of `7656013`: cancellation cannot erase
  exact submission acceptance, temporary absence cannot release an accepted or
  ambiguous effect, and every enumerated pre-sign Vault RPC await is typed as
  bounded `rpc_unavailable` without widening post-sign handling.
- [x] Rerun the four re-review PoCs, cross-adapter cancellation/restart tests,
  Vault RPC fault matrix, complete suite, offline smoke, packed artifact, and
  a fresh funded Testnet-10 vertical.

Gate:

- Socket flood, prompt queue, Purchase/evidence exhaustion, retry saturation,
  restart, and cancellation-race tests pass.
- Capacity is neither leaked nor reused while an effect may still exist.
- No central scheduler or cross-module lifecycle semantics are introduced.
- The independent review remediation branch is ready for independent review;
  no Phase 3 implementation has started.

## Phase 3: Deepen the Purchase module behind existing MCP UX

Purpose: move orchestration and recovery out of the agent-facing entrypoint.

- [ ] Implement canonical Purchase Intent and Checkout Terms binding.
- [ ] Implement stable amount, asset, network, Merchant, resource, request,
  expiry, and evidence digest invariants.
- [ ] Implement separate Purchase Authorization and Treasury Movement checks.
- [ ] Route payment preparation/execution/reconciliation through internal seams.
- [ ] Replace the useful `paid_fetch` intent with the clean-cutover Purchase
  interface; retain no compatibility tool or old payment path.
- [ ] Add `purchase`, `purchase_status`, and `purchase_recover` interfaces or
  settle the final minimal MCP surface using characterization evidence.
- [ ] Project deterministic, secret-free summaries from canonical Purchase
  state.
- [ ] Add egress policy: scheme/host rules, redirect re-validation,
  private/link-local/metadata denial, DNS-rebinding controls, response limits,
  and request fingerprinting.

Gate:

- MCP handlers are thin callers of the Purchase module.
- Purchase lifecycle tests do not import protocol adapters.
- Egress negative tests cover direct and redirected unsafe targets.
- Existing human-facing clarity and treasury recovery tools remain available.

## Phase 4: Integrate Kaspa-x402 exact and perform the clean cutover

Purpose: replace Sompi's bespoke x402 v1 implementation with the current Kaspa
x402 payment mechanism.

- [ ] Integrate the pinned Kaspa-x402 client without modifying the sibling
  repository.
- [ ] Implement Sompi wallet/vault-backed `FundingProvider`.
- [ ] Implement the required `ChannelSigner` and `AddressCodec` adapters without
  duplicating Kaspa-x402 transaction logic.
- [ ] Implement durable `ChannelStore` behaviour using the journal or a
  transactionally coordinated store.
- [ ] Support `exact` on the selected Kaspa testnet only.
- [ ] Persist payment identifier, requirements/payload digests, prepared
  material, transaction identity, finality, and settlement evidence.
- [ ] Verify Settlement against Purchase Authorization and Checkout Terms.
- [ ] Add cross-repository adapter contract and pinned conformance fixtures.
- [ ] Pass crash/replay/duplicate/tampered-settlement tests.
- [ ] Delete all replaced Sompi x402 v1 source, contracts, fixtures, scripts,
  state readers, examples, docs, package exports, commands, and fallbacks.
- [ ] Update README/tool/config documentation to describe only the new runtime.

Gate:

- A testnet exact Purchase pays and reconciles through Kaspa-x402.
- No runtime Sompi x402 v1 implementation or compatibility path remains.
- Sompi does not define duplicate x402 wire types or Kaspa payment mechanics.
- An interrupted submission reaches the correct state without double payment.

## Phase 5: Add the Trusted Authority and human-present AP2

Purpose: make exact User authorization deterministic, isolated, and linked to
the Purchase.

- [ ] Add the `sompi-authority` executable.
- [ ] Design authenticated local IPC, freshness, request/response binding, and
  denial/unavailable behaviour.
- [ ] Keep authority credentials inaccessible to `sompi-mcp`.
- [ ] Display exact Merchant, resource/request, amount, asset, network, expiry,
  Purchase identifier, and known additional-cost bounds.
- [ ] Implement the pinned human-present AP2 profile behind the AP2 adapter.
- [ ] Verify Merchant-signed Checkout Terms and construct/verify the required
  closed mandates.
- [ ] Store original AP2 artifacts as immutable Evidence Attachments.
- [ ] Extract and compare canonical facts rather than trusting adapter output.
- [ ] Fail closed on unknown profile, credential, issuer, key, expiry, or field
  mismatch.
- [ ] Add prompt-injection, replay, substitution, unavailable-authority, and
  tampered-mandate tests.

Gate:

- The Agent cannot approve its own Purchase or access authority credentials.
- Approval is bound to every canonical payment-relevant fact.
- AP2 adapter removal leaves the Purchase model and Kaspa-x402 adapter intact.
- No claim is made that the local AP2/x402 correlation is an official wire
  extension.

## Phase 6: Demo Merchant and complete end-to-end proof

Purpose: prove the complete trust and recovery chain rather than isolated
library behaviour.

- [ ] Build an AP2-aware demo Merchant fixture.
- [ ] Sign and serve exact Checkout Terms.
- [ ] Verify required Purchase/Payment authorization evidence at the correct
  Merchant stages.
- [ ] Serve Kaspa-x402 exact payment requirements and verify settlement.
- [ ] Deliver a deterministic resource with a verifiable digest.
- [ ] Produce linked Merchant/AP2 receipts.
- [ ] Verify Sompi's final canonical Receipt joins terms, authorization,
  payment, Settlement, Fulfilment, and evidence digests.
- [ ] Add one-command local testnet E2E setup and teardown.
- [ ] Inject crashes after preparation, submission, Merchant acceptance,
  Settlement, and Fulfilment.
- [ ] Test duplicate calls, mismatched Merchant/resource/amount/network/payee,
  expired terms, replay, prompt injection, DNS/redirect attacks, and authority
  failure.
- [ ] Write a reproducible evidence report with exact versions and transaction
  identifiers.

Gate:

- The success definition in `CONTEXT.md` passes end to end.
- Every ambiguous crash point reconciles deterministically.
- Negative tests fail closed without unauthorized spend or secret disclosure.
- Build, offline suite, conformance suite, and testnet E2E suite pass.

## Phase 7: Release-readiness cleanup

Purpose: make the new architecture the only documented and shipped product.

- [ ] Audit package contents, exports, commands, examples, and generated files.
- [ ] Remove stale Phase 6, old escrow/x402, and superseded architecture text.
- [ ] Confirm logs/MCP output contain no keys, signed secrets, unsafe raw errors,
  or unnecessary sensitive evidence.
- [ ] Write operator backup, corruption, reconciliation, authority recovery, and
  testnet reset runbooks.
- [ ] Record known limitations without describing testnet evidence as mainnet
  readiness.
- [ ] Run dependency, licence, security, and secret scans.
- [ ] Run a clean install/build/test/package smoke from the produced tarball.
- [ ] Review every accepted ADR against the final implementation.

Gate:

- A fresh operator can run and recover the testnet system from documented
  steps.
- The packed artifact contains only intended runtime/docs/assets.
- `CURRENT_STATE.md` has no unowned blocker for the first E2E milestone.

## Deferred tracks (not part of the initial E2E build)

### Batch settlement

Begin only after exact-mode crash/replay evidence passes. Each charged resource
still requires its own Purchase Authorization; a channel deposit is Treasury
Movement only.

### Autonomous AP2

Begin only after human-present mode proves verification, revocation,
escalation, policy, and recovery. Define bounded open-mandate semantics in a new
ADR before implementation.

### Passkeys

Begin only after the Trusted Authority threat model specifies RP ID, origins,
enrolment, recovery, key rotation, portability, and lost-device behaviour.

### UCP

Begin only if Sompi takes responsibility for catalog, cart, tax, shipping,
order, or fulfilment lifecycle. Paid access to a single HTTP/MCP resource is
not sufficient justification.

### Kaspa-x402 upstream alignment

Registration beneath official x402 core and upstream contribution remain
separate Kaspa-x402 work. Sompi may consume the result later but does not depend
on it for initial AP2 composition.

### Mainnet

Requires a new explicit approval after independent review, durable production
stores, recovery and incident runbooks, current live evidence, conservative
limits, and all Sompi/Kaspa-x402 mainnet checklists pass.
