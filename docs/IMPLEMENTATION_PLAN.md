# Sompi AP2 + Kaspa-x402 implementation plan

Status: **Phases 0-17 verified**

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
  untouched; verify fresh initialization and restart behavior.
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
- [x] Remove the speculative caller-selected `proven_not_executed` release;
  reject the removed outcome at runtime and keep every current absence
  observation fenced until a future structured proof design is accepted.

Gate:

- Socket flood, prompt queue, Purchase/evidence exhaustion, retry saturation,
  restart, and cancellation-race tests pass.
- Capacity is neither leaked nor reused while an effect may still exist.
- Removed or unknown submission outcomes cannot release an effect capability,
  reservation, or exclusive slot, including after restart.
- No central scheduler or cross-module lifecycle semantics are introduced.
- The exact remediation review completed with zero reportable findings, the
  post-review cleanup gates pass, and no Phase 3 implementation has started.

## Phase 3: Canonical Purchase API and transport parity

Purpose: audit the implemented pre-hardening Purchase vertical, make normal
authenticated HTTP the canonical interface, and retain MCP only as a stateless
compatibility adapter.

- [x] Map the complete landed Kaspa-x402 alpha.8 contract, package provenance,
  ownership, evidence, tests, and alpha.6 deletions.
- [x] Accept ADR-0015 and align `CONTEXT.md`, target architecture, this plan,
  and `CURRENT_STATE.md`.
- [x] Audit the existing `purchase`, `status`, and `recover` implementation
  against the accepted Phase 3 criteria; fix demonstrated gaps without
  splitting the deep Purchase module merely because it is large.
- [x] Define one canonical schema source for Purchase input, public view, and
  structured errors.
- [x] Expose `POST /purchases`, `GET /purchases/{purchaseId}`, and
  `POST /purchases/{purchaseId}/recover` from `sompi-api`.
- [x] Add OpenAPI 3.2 generated or verified from the same canonical schemas.
- [x] Add operator-installed least-authority agent authentication over a
  pre-provisioned permissioned Unix socket; remove the loopback TCP path and
  verify the socket identity before sending the bearer.
- [x] Enforce idempotency, body/evidence limits, concurrency admission,
  deadlines, cancellation, and secret-free errors at the HTTP seam.
- [x] Reduce `sompi-mcp` to `purchase`, `purchase_status`, and
  `purchase_recover` calls to the local API; give it no wallet, Journal,
  Authority, AP2, or x402 capability.
- [x] Prove HTTP and MCP parity through the same Purchase interface and
  canonical projections.
- [x] Retain egress scheme/host rules, redirect denial, private/link-local/
  metadata denial, DNS-rebinding controls, response limits, and request
  fingerprinting inside the Purchase implementation.

Gate:

- Purchase lifecycle tests remain protocol-neutral.
- HTTP and MCP produce the same domain behavior and structured errors.
- Direct and redirected unsafe egress fails closed.
- Removing MCP would not change Purchase, recovery, Treasury, or protocol code.

## Phase 4: Kaspa-x402 alpha.8 exact clean cutover

Purpose: replace the pre-hardening alpha.6 path with the complete landed
`kaspa-exact-v2` contract and no compatibility state.

- [x] Pin the four public Kaspa-x402 packages at `0.1.0-alpha.8`, their npm
  integrities, tarball source Git revision, immutable release tag, schemas, and
  vectors.
- [x] Start a new Purchase Journal epoch and reject every prior development
  epoch unchanged.
- [x] Delete alpha.6 package/profile pins, `kaspa-exact-v1` wire assumptions,
  borrow reservations, exclusive inventory, threshold top-up accounting,
  dual-benefit transaction construction, payment-output-index assumptions,
  server stores, readers, fixtures, tests, commands, exports, and current docs.
- [x] Implement the public alpha.8 `FundingProvider` and `AddressCodec` seams
  with attempt-scoped Treasury capabilities and no duplicate protocol parser.
- [x] Implement `standard-native` as the default version-0 exact profile.
- [x] Enforce exact Merchant gain and amount-plus-bounded-fee payer cost.
- [x] Implement `additive` with reusable heads, exact successor delta as the
  only Merchant payment, no exclusive unpaid reservation, and no second
  Merchant output.
- [x] Handle additive challenge expiry, one-winner conflicts, bounded head
  selection, independent shards, trusted lineage, unknown-lineage disablement,
  and standard-native fallback.
- [x] Persist selected profile, request/requirements/payload/authorization
  digests, prepared artifact identity, transaction identity, protocol finality,
  effective Finality Floor, settlement stages, and independent Chain Evidence.
- [x] Reject paid redirects, request/payee/profile substitution, replay,
  automatic corrective re-signing, excessive fees, malformed inputs,
  finality downgrade, and ambiguous outcome reuse.
- [x] Update the demo Merchant through public Kaspa-x402 server/store seams.
- [x] Pass exact consensus/HTTP vectors and package conformance for both
  profiles without modifying the sibling repository.

Gate:

- Both exact profiles pay and reconcile on Testnet-10 through Kaspa-x402.
- Merchant gain equals the advertised amount for both profiles.
- Thousands of unanswered additive offers consume no head and concurrent
  conflicts produce one winner plus a safe explicit retry.
- No active alpha.6 code, state, schema, fixture, command, or documentation
  remains.
- Interrupted submission reaches the correct state without double payment or
  fulfilment.

## Phase 5: Deepen Treasury Movement

Purpose: put capacity, attempt funding, effect fencing, and recovery behind one
deep Treasury interface shared by exact and batch execution.

- [x] Concentrate Reservation creation/finalization/release, vault-to-P2PK
  staging, attempt-bound signing capability, fee ceilings, and external effect
  fencing in Treasury.
- [x] Reserve exact Merchant amount plus explicitly bounded staging, network,
  and recovery fees only; never reserve an extra KIP-10 Merchant top-up.
- [x] Give the Kaspa-x402 adapter only the selected attempt capability and
  staged outpoint, never owner/recovery keys or unrestricted wallet authority.
- [x] Persist prepared staging, exact, sweep, deposit, claim, and refund plans
  before submission.
- [x] Reconcile ambiguous staging/payment competition without rebuilding or
  blind retry.
- [x] Implement abandoned-stage sweep and capacity release as explicit
  immutable Treasury Movements.
- [x] Preserve Admission Leases and fencing generations across restart and
  executor takeover.
- [x] Prove cancellation before signing releases safely and cancellation after
  possible effect enters Reconciliation.

Gate:

- Crash/takeover tests prove no lost or double capacity and no duplicate
  submission.
- No private key, Authority credential, or unrestricted wallet capability
  crosses the Treasury seam.
- Every exact funding/recovery action is bounded by the original authorized
  Reservation.

## Phase 6: Kaspa-x402 alpha.8 batch settlement

Purpose: add batch as a separate capital-backed channel lifecycle after both
exact profiles and Treasury recovery pass.

- [x] Implement immutable channel identity and initial escrow deposit through
  the public Kaspa-x402 channel interfaces.
- [x] Add a durable `ChannelStore` transactionally coordinated with the
  Purchase Journal.
- [x] Keep deposit, top-up, voucher, claim, continuation, and refund as distinct
  Treasury Movements and Evidence Attachments.
- [x] Require a separate human-present Purchase Authorization and capacity
  reservation for every voucher increment.
- [x] Persist maximum authorized request charge separately from actual accepted
  charge and cumulative signed voucher ceiling.
- [x] Serialize concurrent channel updates and enforce monotonic cumulative
  vouchers bound to the full active outpoint and script epoch.
- [x] Preserve an explicit claim-fee reserve and require full-epoch claim with
  continuation value equal to active funding minus authorized charge.
- [x] Enforce the strict absolute DAA refund boundary and client authorization.
- [x] Reconcile deposit/top-up, claim/refund races, ambiguous broadcasts,
  continuation rotation, old-voucher replay, exhaustion, and cleanup.
- [x] Stop signing and fail closed on overclaim, stale or cross-channel voucher,
  unverified corrective state, or server inconsistency.

Gate:

- A funded channel never authorizes a Purchase.
- Stale, rollback, overclaim, cross-channel, and cross-resource vouchers fail.
- Claim/continuation/refund value equations and strict DAA boundaries pass
  consensus-backed tests.
- Funded TN10 evidence covers deposit, multiple individually authorized
  purchases, full-epoch claim, continuation rotation, and refund.

## Phase 7: Revalidate AP2, Authority, and Merchant

Historical gate completed before the Phase 12 clean cutover. Its bilateral
Merchant AP2 artifacts were subsequently removed and are not part of the
current runtime.

Purpose: carry the existing human-present authorization and fulfilment proof
across both alpha.8 exact profiles and every batch voucher increment.

- [x] Preserve `sompi-authority` as deterministic and non-agentic, with its
  credential inaccessible to both API and MCP processes.
- [x] Bind Merchant, resource/request, amount or maximum charge, actual charge,
  asset, network, expiry, Purchase identity, selected profile/channel epoch,
  fee bounds, and effective Finality Floor.
- [x] Verify Merchant-signed Checkout Terms and construct/verify the pinned
  human-present AP2 closed mandates.
- [x] Store original AP2 artifacts as immutable Evidence Attachments and compare
  extracted canonical facts rather than trusting adapter output.
- [x] Extend the demo Merchant through public Kaspa-x402 server interfaces for
  standard-native, additive, and batch.
- [x] Deliver deterministic resources and produce linked Merchant/AP2 receipts.
- [x] Fail closed on replay, substitution, expiry, issuer/profile mismatch,
  unavailable Authority, prompt injection, tampered mandate, and unavailable
  payment execution.

Gate:

- The Agent cannot approve its own Purchase or access Authority credentials.
- Every exact payment and batch voucher is bound to all payment-relevant facts.
- AP2 and Kaspa-x402 adapters remain separate and removable from the stable
  Purchase model.
- No local AP2/x402 correlation is presented as an official wire extension.

## Phase 8: OpenAPI workflow description

Purpose: describe the stable Purchase lifecycle for direct automation without
adding another agent protocol.

- [x] Freeze the OpenAPI operation identifiers and terminal/recoverable states
  after Phases 3–7 pass.
- [x] Add an Arazzo workflow for create -> status -> recover -> terminal
  receipt.
- [x] Validate the Arazzo document against the canonical OpenAPI source.
- [x] Add one end-to-end workflow scenario covering a recoverable interruption.

Gate:

- The workflow uses only the canonical Purchase API.
- No A2A, UCP, public OAuth infrastructure, or generic agent-protocol module is
  introduced.

## Phase 9: Complete crash and funded Testnet-10 proof

Purpose: prove the full trust and recovery chain rather than isolated module
behavior.

- [x] Run API and MCP -> Purchase -> human-present Authority -> Treasury ->
  Kaspa-x402 -> Merchant -> Receipt.
- [x] Inject crashes before and after every irreversible staging, exact,
  voucher, deposit, claim, refund, Merchant, and fulfilment effect.
- [x] Prove standard-native and additive exact settlement, additive conflict/
  retry and trusted reconciliation, and batch deposit/multiple vouchers/claim/
  refund on funded TN10.
- [x] Test duplicate calls, mismatched Merchant/resource/amount/network/payee/
  profile, expired terms, replay, DNS/redirect attacks, and Authority failure.
- [x] Record exact package/source/node/DAA/transaction/fee/mass/finality and
  evidence provenance without secret material.

Evidence (2026-07-17): the five reports under `evidence/live-testnet10/`
cover both exact profiles, additive contention/retry, the complete batch
lifecycle, and a separate-process human-present standard-native Purchase. The
human-present run reached `receipted` as Purchase
`pur_QW-rngf254gaI8xOl2Na9g` with exact transaction
`95705c2a4e06415454d691a38f4f41adbf9cebedf958178d206c5f442371efcb`.
The complete crash/fault, replay, substitution, egress, Authority, and
transport-parity suite passes.

Gate:

- The success definition in `CONTEXT.md` passes through both transports.
- Every ambiguous crash point reconciles without duplicate payment or
  fulfilment.
- Build, offline, conformance, and funded TN10 suites pass.

## Phase 10: Security and release-readiness closure

Purpose: make the clean-cutover architecture the only documented and shipped
testnet product.

- [x] Exercise request/Merchant substitution, paid redirects, automatic
  corrective payment prevention, forged/duplicate inputs, cross-resource or
  cross-server replay, ambiguous broadcast, finality downgrade, concurrent
  head claims, voucher rollback/overclaim, claim/refund races, API/MCP abuse
  limits, secret leakage, and every crash boundary.
- [x] Run a formal security diff scan over the complete branch, independently
  validate candidates, fix every reportable issue and mandatory hardening
  defect, rerun the complete matrix, and rescan until clean.
- [x] Audit package contents, exports, commands, examples, generated files,
  dependency integrity, licences, secrets, and current-only documentation.
- [x] Write operator backup, corruption, reconciliation, Authority recovery,
  channel recovery, and testnet reset runbooks.
- [x] Add Arazzo/OpenAPI and packed-artifact validation to the release gate.
- [x] Run clean install/build/test/package verification from the produced
  tarball and review every accepted ADR against the final implementation.
- [x] Keep mainnet fail-closed and record remaining non-alpha readiness limits.

Evidence (2026-07-17): the final sealed full-branch scan closed all 156 review
receipts and reported three Low/P3 availability findings. The branch isolates
operator recovery behind a separate credential/socket/group/pool, bounds both
RPC collection paths before Kaspa-WASM work, rejects duplicate work, and checks
cancellation during traversal. The exploit regressions and complete suite
pass. After reviewing that scan and its verified remediation, the project owner
explicitly closed further security-scan iteration; this plan does not represent
that decision as a later zero-finding scan.

The final clean release verifier passes 480 tests (479 pass and one documented
privileged ownership skip), offline smoke, protocol conformance, all five
funded evidence reports, OpenAPI/Arazzo checks, production dependency audit,
the 201-entry packed artifact, and clean-install/import verification.

Gate:

- A fresh operator can run and recover the complete testnet system.
- The packed artifact contains only intended runtime, docs, and assets.
- The formal scan is complete, every reportable finding is fixed and verified,
  and the project owner has explicitly closed further scan iteration.
- `CURRENT_STATE.md` has no unowned blocker for the supported testnet scope.

## Phase 11: Hermes and Telegram deployment

Purpose: make the completed Purchase runtime usable from Terah without moving
authorization, policy, or keys into the agent process.

- [x] Freeze and back up the live Hermes baseline; build against a clean pinned
  current-upstream checkout without interrupting the running gateway.
- [x] Add the request-bound Telegram Authority provider and durable one-time
  callback state described by ADR-0016.
- [x] Add the least-authority Hermes callback plugin and concise Sompi agent
  skill; direct API remains canonical and MCP remains compatibility only.
- [x] Provision distinct operator, API, Authority, and agent principals, groups,
  sockets, credentials, data directories, and system services on the Hermes
  host.
- [x] Install an immutable Testnet-10 Operator Manifest with the demo Merchant,
  trusted node/witness, Telegram user/chat, conservative fee limits, per-
  Purchase limit, hourly limit, and vault cap.
- [x] Fund a fresh isolated agent vault from the existing Testnet-10 bootstrap
  wallet without reusing historical proof state.
- [x] Prove the Terah flow in explicit joined layers: live request -> exact
  facts -> Telegram decision -> fulfilment -> receipt, plus separately funded
  standard-native and batch settlement on the same host.
- [x] Prove limit denial, unauthorized callback, replay, expiry, duplicate tap,
  service restart, ambiguous settlement, status, and recovery.
- [x] Preserve public evidence without secrets, update current documentation,
  and pass the complete release verifier from packed artifacts.
- [x] Deploy the verified `0.8.1` package to Terah without replacing Journal
  epoch 15, then publish the same release after npm authentication is restored.

Gate:

- Terah can request and observe Purchases but cannot approve, loosen policy, or
  access any payment/Authority credential.
- Only the exact operator-installed Telegram user/chat callback can consume the
  exact one-time Authority capability.
- The canonical API, MCP compatibility adapter, skill, and Telegram projection
  all converge on one Purchase lifecycle.
- Exact and batch paid canaries reconcile after restart without duplicate
  payment or fulfilment.
- The live Hermes gateway has a tested rollback and no unpreserved local state.

Fresh closure evidence (2026-07-19): human approval in the Terah Telegram flow
created Purchase `pur_O7vKtVeIrWEJHErXjAPXdQ`. Standard-native transaction
`e90e3dc0579340dcdbe9c79aec356852dda2f375ff8d358b1cda543027cffd25`
was accepted once. Recovery proved the exact-payment winner at confirmed
finality and replayed the same signed payment after Checkout expiry, producing
the paid report and canonical receipt without another transaction.

## Phase 12: Generic x402 Merchant and AP2 readiness cutover

Purpose: make ordinary Kaspa-x402 Merchants usable without Sompi-specific AP2
wire behavior while preserving exact human authorization and a clean future
upgrade path to official AP2/x402 interoperability.

- [x] Accept ADR-0017 and align `CONTEXT.md`, the target architecture, this
  plan, and current documentation.
- [x] Make verified Kaspa-x402 `PAYMENT-REQUIRED` evidence sufficient to derive
  canonical Checkout Terms for an operator-allowed HTTPS Merchant origin.
- [x] Bind Merchant origin, payee, request, requirements digest, amount or
  batch ceiling, actual charge, profile/channel, fees, finality, expiry, and
  Purchase identity in the signed Purchase Authorization.
- [x] Retain AP2-derived authorization only as internal Evidence Attachments;
  do not fabricate Merchant-issued AP2 evidence or claim interoperability.
- [x] Remove `SOMPI-CHECKOUT`, both Sompi AP2 Receipt headers, and the
  proprietary mandate-presentation endpoints from the active runtime.
- [x] Delete the commerce-authorization effect, store, recovery state,
  Merchant issuer configuration, obsolete fixtures, tests, examples, and
  commands.
- [x] Verify generic Fulfilment from the authorized request, bounded paid
  response, x402 Settlement, and any precommitted resource digest; create one
  canonical Sompi Receipt.
- [x] Start the next clean Journal epoch and reject every prior development
  epoch unchanged.
- [x] Apply the same authorization contract to standard-native, additive, and
  every batch voucher increment without changing Kaspa-x402.
- [x] Keep exact official AP2 and x402 source/profile pins plus a non-runtime
  conformance watch so an official integration can replace the adapters after
  explicit review.
- [x] Prove direct API, skill, MCP compatibility, Telegram Authority, policy
  denial, both exact profiles, batch, restart, replay, substitution, and
  ambiguous recovery against generic x402 Merchant behavior.
- [x] Run the complete build/test/offline/conformance/package verifier and
  record fresh funded Testnet-10 and Terah evidence without secrets.

Gate:

- A generic supported Kaspa-x402 Merchant needs no Sompi or AP2 integration.
- Treasury execution remains impossible without the exact signed human-present
  Purchase Authorization.
- Standard-native, additive, and batch retain their existing settlement and
  recovery invariants.
- No active proprietary Merchant AP2 header, endpoint, state, configuration,
  fixture, command, or current documentation remains.
- Official AP2/x402 support can replace adapter behavior without changing the
  Purchase model, Journal lifecycle, Treasury, Authority, Telegram, or agent
  interfaces.

## Phase 13: Near-automatic Hermes onboarding

Purpose: let a user give Hermes one pinned Sompi instruction while preserving
the operator, Authority, wallet, and recovery trust boundaries.

- [x] Accept ADR-0018 and define the agent, local operator, funding, and vault
  activation responsibilities.
- [x] Add a strict secret-free host request, canonical digest, and
  side-effect-free preview command.
- [x] Add one transactional root bootstrap that installs the pinned package,
  isolated principals, manifests, credentials, sockets, hardened services,
  Hermes skill, and callback plugin, with rollback for incomplete unfunded
  state.
- [x] Keep the Telegram token prompt, owner recovery key, wallet key, API
  credentials, Authority keys, and sudo outside agent context and command-line
  arguments.
- [x] Detect a native Hermes callback hook and otherwise install the exact
  compatibility patch in an isolated overlay without editing the Hermes
  checkout.
- [x] Generate a normal TN10 funding address, publish the minimum funding
  amount, and activate the SilverScript vault through one digest-bound,
  journaled, idempotent local command.
- [x] Reproduce and fix low-balance KIP-9 vault fee convergence with the real
  DAA/window/amount shape.
- [x] Remove the previous Terah installation, prove plain Hermes health, then
  perform a clean install from the packed `0.8.2` artifact.
- [x] Fund and activate a fresh TN10 vault, complete a human-approved purchase
  from `demo.kaspa-x402.org`, reconcile the accepted staging effect, and prove
  one receipt without duplicate payment.
- [x] Update the concise agent skill, README, operator/Hermes runbooks, package
  policy, and current-state evidence.

Gate:

- The agent can prepare onboarding from one pinned instruction but cannot run
  privileged setup, receive secrets, fund the wallet, or activate the vault.
- The user performs one reviewed local install command, funds one displayed
  address, and runs one returned local activation command.
- A clean host reaches healthy Authority, API, and Hermes services, and a paid
  Purchase completes through the same local API used after onboarding.
- Failed or repeated activation is safe and idempotent; irreversible effects
  remain journal-first and recoverable.
- The packed artifact and complete release verifier pass before publication.

Fresh evidence (2026-07-19): bootstrap request
`sha256:6tLNPCEGZEh_YGzPvCFKeMPu8YdwWPy_aexaFXPzoww` installed the `0.8.2`
release candidate on the clean Terah baseline. Vault activation transaction
`e8dc10f8aeaa267a75f2a106bf2ce3a64db6a21441a5f5faf74376402a170f69`
created the covenant head. Human-approved Purchase
`pur_bR9Get_H0IHPmLoEfGItpQ` advanced it through staging transaction
`ff0f448336879f2ce2dfb03e689ab125577c661508abff8f9c3c71a7e815e788`
and paid the generic demo Merchant once in transaction
`522e8ded26d9378406d85b610660be189f82c74f3152fe2a2f98f591f372e17a`.

## Phase 14: Wallet visibility and direct native-KAS transfers

Purpose: make Sompi usable as an agent wallet without weakening the existing
Authority, policy, vault, Journal, or Chain Evidence model.

- [x] Accept ADR-0019 and map balance, address, activity, transfer, denial,
  insufficient-funds, ambiguous-submission, and recovery user flows.
- [x] Add a protocol-neutral durable `Transfer` lifecycle and clean Journal
  epoch with exact idempotency, authorization, reservation, effect, settlement,
  receipt, and recovery records.
- [x] Add internal `sompi.transfer.1` Authority evidence and exact terminal and
  Telegram displays for recipient, amount, network, fee, total, expiry,
  manifest, finality, and Transfer identity.
- [x] Execute only through the existing vault-backed Treasury Movement and
  Chain Evidence modules; do not use x402 or invent Merchant semantics.
- [x] Add one read-only Wallet View for public identities, observed balance,
  reserved and available capacity, hard limits, chain status, and bounded
  Sompi-recorded activity.
- [x] Add canonical local interface, CLI, MCP compatibility, OpenAPI, Arazzo,
  and agent-skill support for wallet and Transfer operations.
- [x] Prove substitution, malformed address, fee spike, insufficient funds,
  policy denial, replay, duplicate approval, crash, restart, ambiguous
  broadcast, finality, and secret-isolation behavior.
- [x] Enforce the per-transfer ceiling on the exact recipient amount, reserve
  the separate fee ceiling against rolling capacity, and repeat both checks at
  durable Treasury intent.
- [x] Preflight immutable policy and current capacity before requesting human
  approval, without creating a Transfer or Treasury intent.
- [x] Run a funded Testnet-10 Terah canary, cut the next release, publish it,
  deploy it, and verify natural wallet and Transfer interactions end to end.

Gate:

- One Telegram approval authorizes exactly one arbitrary-recipient Transfer.
- The destination receives exactly the approved amount and the payer cost is
  bounded by the approved amount plus fee ceiling.
- A crash or retry cannot sign or broadcast a replacement transfer.
- The Agent can query useful wallet facts without gaining signing, Authority,
  policy, operator, or recovery capabilities.
- x402 purchases continue to pass unchanged.

Fresh evidence (2026-07-19): `@elldeeone/sompi@0.9.1` was published and
deployed to Terah without replacing epoch-16 state. Human-approved Transfer
`trf_2ip8z9sGA8usB9bQQ0m8AA` sent exactly the `100,000,000`-sompi
per-transfer maximum in transaction
`35be8e0493513ec977e8bfd54337f36e09584c57c49d0f0525431ebe028f0f65`.
Its `6,153,180`-sompi fee remained below the separate ceiling, accepted-chain
evidence matched both outputs, and the superseded failed Transfer was not
retried.

## Phase 15: Automatic funding intake and wallet UX

Purpose: make the protected wallet feel like one wallet without weakening the
SilverScript or Authority boundaries.

- [x] Accept ADR-0020 and use one stable Testnet-10 receive address.
- [x] Detect bounded canonical receive-address UTXOs through the trusted node.
- [x] Move eligible incoming funds automatically through the existing durable
  `vault_deposit` Treasury operation, with deterministic idempotency and
  recovery.
- [x] Never require approval for inward securing; retain exact human approval
  for every outgoing Transfer and Purchase.
- [x] Project total, available, incoming, protected, and pending balances with
  tKAS-first display values and exact atomic evidence.
- [x] Include incoming, securing, Transfer, Purchase, fee, transaction, and
  status events in one bounded activity view.
- [x] Make the receive address, network warning, QR payload, securing state, and
  user action explicit through API, CLI, skill, MCP compatibility, and docs.
- [x] Lead with tKAS/KAS in Telegram, policy, Purchase, Transfer, receipt, and
  error summaries. Show raw sompi only as structured evidence or on request.
- [x] Prove node failure, small deposits, duplicate reconciliation, concurrent
  Treasury work, restart recovery, display schemas, and unchanged outgoing
  authorization behavior.

Gate:

- A user funds the same receive address and Sompi makes eligible funds available
  from the protected vault without another command or approval.
- Wallet questions have useful answers without exposing funding/vault/unbound
  implementation language.
- No automatic path can create an outward payment or weaken policy.
- Transfers and x402 Purchases continue to pass unchanged.

Acceptance evidence (2026-07-19): 486 tests run, with 485 passing and one
privileged ownership test skipped. The offline smoke proof, Kaspa-x402 alpha.8
conformance, OpenAPI and Arazzo checks, Hermes compatibility tests,
SilverScript compiler fixture reproduction, and production dependency audit
all pass. Published `0.10.0` was deployed without replacing epoch 16. Terah
automatically secured the existing receive-address deposit through transaction
`6076b807a4dd9edd7bc9e37a8a5d82c115cccf3ec0aea168c6b923b1c51c29d0`,
required no approval, and reported `10000.9490244 tKAS` available with nothing
incoming or pending.

## Phase 16: Owner-managed limits and one-wallet UX

Purpose: let users manage everyday limits and vault protection without exposing
operator, covenant, or protocol internals.

- [x] Accept ADR-0021 and add Policy Change, Vault Migration, and Wallet
  Experience to the domain model.
- [x] Add durable owner-approved Policy Change proposal, decision, activation,
  status, and recovery.
- [x] Apply immutable policy revisions only to new work; preserve existing
  operation snapshots and reject stale concurrent changes.
- [x] Remove approval-threshold behavior and presentation from the clean-cutover
  runtime.
- [x] Add guided Vault Migration proposal, approval, owner-signing handoff,
  execution fence, window preservation, Chain Evidence, activation, and receipt.
- [x] Preserve the stable receive identity across vault replacement and keep
  vault addresses technical-only.
- [x] Replace normal Wallet View with the one-wallet Wallet Experience
  projection and KAS-first plain-language receipts/errors.
- [x] Add API, CLI, skill, MCP, OpenAPI, Arazzo, onboarding, and Telegram parity.
- [x] Add full onboarding, limit-change, vault-migration, wallet, transfer,
  Purchase, denial, restart, replay, ambiguity, and recovery journeys.
- [x] Pass the complete clean-cutover release verifier and record current
  acceptance evidence in `CURRENT_STATE.md`.

Gate:

- The Agent may propose but cannot approve or activate a policy or vault change.
- Everyday limits change through one exact human-present Telegram decision.
- Vault protection changes only after separate offline-owner execution.
- A migration cannot reset rolling spend, duplicate an effect, or change the
  stable receive address.
- Ordinary users see one wallet/address/balance and no vault, DAA, sompi, or
  protocol jargon unless they request technical details.

Acceptance evidence (2026-07-20): 502 tests run, with 501 passing and one
privileged ownership test skipped. Offline smoke, protocol conformance,
OpenAPI/Arazzo validation, Hermes compatibility, deterministic local E2E,
package/clean-consumer verification, production dependency audit, retained
TN10 evidence, and all 12 vault fixtures against upstream SilverScript
`26e3b9f94821b6fe47a2492755252ec4f995abb1` pass. The complete release
verifier passes from a clean isolated copy of this exact working tree.

## Phase 17: Security review remediation

Purpose: close every validated finding from the owner-policy and vault-migration
change set without preserving vulnerable compatibility paths.

- [x] Make runtime installation scriptless and grant only one exact,
  manifest-verified native rebuild capability with a behaviour probe.
- [x] Replace mutable Telegram decision callbacks with separate opaque approval
  and denial capabilities that are invalidated together.
- [x] Apply one shared Authority prompt-admission budget to Purchase, Transfer,
  Policy Change, and Vault Migration requests.
- [x] Add a monotonic policy activation generation and bind policy changes to
  the current vault protection digest.
- [x] Bind vault migrations to the exact policy digest and activation
  generation so separately approved changes cannot compose into an unsafe cap.
- [x] Include prepared Purchase payment effects in the migration fence and
  recheck the fence immediately before chain submission.
- [x] Recover admitted Treasury operations against their immutable policy
  snapshot instead of requiring that snapshot to remain globally active.
- [x] Require independently accepted recovery evidence before activating a
  replacement vault.
- [x] Re-run the original exploit harnesses, focused regressions, the complete
  test suite, protocol conformance, deterministic E2E, generated contract
  checks, dependency audit, SilverScript fixtures, and clean release verifier.
- [x] Terminalize expired and stale owner-approved Vault Migration plans before
  any owner-key or chain work so superseded plans cannot block replacement.
- [x] Validate offline-owner inputs as root, then permanently enter the pinned
  API UID/GID before opening API-owned runtime state.
- [x] Terminalize an expired `awaiting_authority` Vault Migration before
  admitting a replacement request, including after an Authority transport
  timeout.

Gate:

- Package installation cannot execute an unreviewed dependency lifecycle
  script.
- A denial callback cannot be converted into approval, and prompt limits cannot
  be bypassed through a different Authority request type.
- Replayed or separately approved protection changes cannot activate against a
  different policy generation or vault protection state.
- Migration cannot overtake a prepared or newly submitted payment effect.
- Crash recovery neither strands admitted work nor activates a replacement
  vault without accepted recovery evidence.

Acceptance evidence (2026-07-20): 518 tests run, with 517 passing and one
privileged ownership test skipped. The original exploit harnesses are closed;
offline smoke, Kaspa-x402 alpha.8 conformance, generated OpenAPI/Arazzo checks,
Hermes compatibility, deterministic local E2E, production dependency audit,
all 12 SilverScript vault fixtures, and the clean isolated release verifier
pass. Expired Authority requests also release the live Vault Migration slot
without owner-key access or a chain effect.

Funded closure evidence (2026-07-20): `@elldeeone/sompi@0.11.5` was published
and deployed to Terah from the verified 218-file tarball. Timed-out migration
requests terminalized without owner or chain work. Human-approved migration
`vmg_AEGRM3ZbaAsA-yVJaqIQmw` then lowered vault protection from 5 tKAS to
4 tKAS through accepted recovery transaction
`cf08ca5c9aed7a5f4fc89e1a0bfc0029335dd50284fde6bfba86173752bda4c7`
and accepted replacement transaction
`7c02e09cfa711f5f398524d3d25b5a2538cc44982cfe57db18b3168659df1310`.
The receive address remained unchanged. A clean temporary consumer fetched
the public tag and package and produced a valid digest-bound bootstrap preview.

Post-release incident closure (2026-07-20): a 60-second exact offer was approved
with only about 10 seconds remaining. Sompi staged funds, correctly refused the
expired Merchant payment, and later returned the staged value through accepted
recovery transaction
`64703a37cf9fbe8416798f25bd117eac71fa8609fda8ad6ef227179b03a9aa2d`.
The `0.11.6` cut reserves 30 seconds for single-transaction execution before
presenting authority as live, keeps uncorroborated recovery absence pending,
and projects a proven no-payment recovery as `expired`. The follow-up suite runs
524 tests, with 523 passing and one expected privileged ownership skip.
The `0.11.7` follow-up also projects an in-flight Authority timeout as `expired`
in the original API call, so a missed prompt cannot surface as a generic
internal error or require a second call to release the user-facing flow.
The `0.11.8` live-canary follow-up closes an already-planned staging-recovery
Effect when its exact payment wins, preventing stale recovery guidance on a
receipted Purchase.
The `0.11.9` follow-up performs the required two-read losing-candidate absence
corroboration inside one bounded recovery request, so an agent does not need to
issue two recovery commands inside the in-memory proof window.

## Deferred tracks (not part of the alpha.8 clean cutover)

### Autonomous AP2

Begin only after human-present mode proves verification, revocation,
escalation, policy, and recovery. Define bounded open-mandate semantics in a new
ADR before implementation.

This includes named/pre-approved recipient grants. Such grants must be
Authority-signed, revocable, address/network exact, amount/period bounded,
time-limited, and unable to loosen Operator Manifest ceilings.

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
