# Current state

Last updated: **2026-07-17**

## Plain-English status

**The alpha.8 clean-cutover goal is active; Phases A through H are complete.** The
landed Kaspa-x402 `0.1.0-alpha.8` release, published package integrities,
immutable specifications, schemas, vectors, public APIs, and funded TN10
evidence have been mapped into Sompi's ownership and acceptance boundaries in
[`docs/architecture/KASPA_X402_INTEGRATION.md`](docs/architecture/KASPA_X402_INTEGRATION.md).
Phase I is complete except for the funded additive-contention sub-gate. Phase J
has completed another formal full-branch security scan. Its two Low/P3 findings
are fixed locally and the mandatory immutable post-fix rescan is next. Batch
settlement is a separate capital-backed channel lifecycle and is not treated as
exact payment.

ADR-0015 and the aligned architecture require a clean replacement of alpha.6,
support both `kaspa-exact-v2` profiles (`standard-native` and `additive`), and treat
`batch-settlement` as a separate gated lifecycle. HTTP/OpenAPI is now the
canonical Purchase API and MCP is a thin untrusted compatibility adapter. No
alpha.8 payment conformance claim has been made yet.

Current verification: `npm test` passes all **461** tests (**460 pass**, one
documented privileged ownership skip) and the complete offline smoke. The
authenticated API now runs only over a pre-provisioned permissioned Unix
socket; the loopback TCP path is deleted. Socket owner/group/mode/path identity,
operator-installed agent credential, HTTP/MCP parity, request limits,
deadlines, and cancellation gates pass. Both `kaspa-exact-v2` profiles now run
through the alpha.8 SDK contract,
and Treasury owns policy capacity, vault staging, attempt-scoped funding,
external-effect fencing, abandoned-stage recovery, and cancellation semantics
behind one Purchase-facing deep module. Cancellation before an external effect
atomically releases capacity; cancellation after any possible effect remains
durably fenced for reconciliation. MCP production code imports no wallet,
Journal, Authority, AP2, Kaspa-x402, Treasury, or Purchase runtime capability.

The hermetic Phase F gate covers immutable channel capitalization, durable
channel and Movement state, separately authorized monotonic vouchers, a
claim-fee reserve, strict DAA refund, claim/refund races, ambiguity and
recovery, and rotation through independently funded channel epochs. The demo
Merchant consumes the public Kaspa-x402 alpha.8 server/store seams for exact
and batch: one batch request produces a durable commitment and AP2 receipt, an
accepted claim advances the continuation outpoint, and the original paid
response replays byte-for-byte after that epoch change. In-place top-up is
deliberately unsupported until the public client exposes a general builder;
Sompi rotates to a separately capitalized channel instead.

The funded Phase I batch proof now covers two 40,000,000-sompi deposits, two
separately authorized Purchases (one through the canonical HTTP API and one
through the MCP-over-API compatibility path), monotonic 10,000,000 and
16,000,000-sompi voucher ceilings, exact 6,000,000-sompi charges, a
12,000,000-sompi claim, a 28,000,000-sompi continuation, and a separate
38,000,000-sompi refund after the strict absolute DAA boundary. The accepted
claim transaction is
`79fbe8071c7942ed26895fa00ef1b606f774f466926178a7720b9f9be0e2e5ea`;
the refund is
`6772094be335e81a22276bc8f15916065721e58df91578b1819a27a7209f675d`;
the private report digest is
`8736ece032a8c2e517169319edf91c30a50f87de97f89ce47b22868be0fbb7f1`.
The proof intentionally uses an in-process auto-approved Authority fixture and
therefore does not claim human-present AP2 conformance.

Phase G revalidates the complete human-present AP2 and merchant join across
`standard-native`, corrected `additive`, and `batch-settlement`. The separate
Authority signs and renders the selected execution profile, maximum authorized
charge, channel epoch where applicable, fee ceiling, and effective finality
floor. The demo Merchant records both the authorized maximum and actual batch
charge, advances a reusable additive head by exactly the advertised payment,
persists original AP2 artifacts, and produces linked deterministic fulfilment
and receipt evidence through the public alpha.8 server interfaces. Replay,
substitution, expiry, issuer/profile mismatch, unavailable Authority, hostile
Merchant text, and tampered mandate paths fail closed.

Phase H adds a generated Arazzo 1.1 workflow over the same canonical API. It
references only `createPurchase`, `getPurchase`, and `recoverPurchase`, validates
against the pinned official 2026-04-15 schema and the generated OpenAPI source,
and has an authenticated HTTP scenario that reaches a terminal receipt after a
recoverable interruption. It introduces no A2A, UCP, OAuth, MCP-only behavior,
or generic agent-protocol layer.

The first human-present AP2 + Kaspa-x402 vertical remains testnet-only; the
post-scan hardening gates pass through the bounded Authority, Purchase/Journal,
Evidence, MCP, and direct-Treasury lifecycles.

The formal diff scan of `fd7ba42...8e1214b` reviewed all 146 changed
source-like files through 30 full-file receipts. It reported two findings: an
empty current UTXO view could terminally retire a live batch channel, and
cooperative-only API deadlines could retain every request permit. Both are now
fixed. Empty UTXO views and protocol-store retirement requests fail closed
without changing durable channel state; only corroborated Chain Evidence may
advance or terminalize a channel. The API now has independent Purchase and
control lanes, hard response deadlines, bounded overdue work, and abortable
body reads. The same remediation also binds accepted-history transaction IDs
to full transaction bodies, keeps broadcast claim attempts permanently fenced,
and requires mechanism-specific durable evidence for every accepted batch
Treasury Movement. The complete test, conformance, OpenAPI, Arazzo, local-proof,
and 199-entry package-verification gates pass. A fresh post-fix scan is still
required before the formal security gate is closed.

The subsequent sealed scan of `fd7ba42...015107a` reviewed all 148 changed
source-like files and reported two Low/P3 findings. First, a different local
principal could win the predictable loopback port, capture MCP's
least-authority bearer, and replay it after the real API started. Sompi now has
no Purchase API TCP listener: the trusted API runtime and untrusted MCP use a
pre-provisioned `0710` Unix-socket directory and a `0660` socket, with distinct
API/MCP UIDs and identity verification before every authenticated request.
Second, cancelling or expiring a prepared batch Purchase left its never-
submitted voucher Movement `planned`, fencing the funded channel epoch. The
same SQLite transaction now moves only a `planned` Purchase-bound voucher to
`failed_terminal`, preserves the monotonic signed ceiling, and refuses any
Movement that might have reached the Merchant. Focused exploit regressions and
the complete test/OpenAPI/Arazzo gates pass; the post-fix rescan remains open.

Phases 0 through 6 were implemented through `4ebb82d`, including the stable
Purchase module, clean Kaspa-x402 alpha.6 exact path, isolated interactive AP2
Authority, demo Merchant, crash recovery, local vertical proof, and live
Testnet-10 evidence. The completed deep security scan then found 21 medium/low
issues concentrated in chain evidence/finality, operator provisioning, and
unbounded operation lifecycles. The independent review of the initial Phase
2D target `082def29636fe0a6802240ee358f867c34667b4c` reopened the lifecycle
work. The remediation commits through `eb96534` passed an exact independent
security diff review with zero reportable findings. Commit `1151938` then
removed the remaining speculative non-execution release and is verified
locally. That alpha.6 vertical is now the pre-hardening implementation being
replaced by the alpha.8 clean cutover; it is historical evidence, not the
target contract.

## Git orientation at codification

- Repository: `https://github.com/elldeeone/sompi`
- Normalized local `main`: `fd7ba42` (`Complete AP2 + Kaspa-x402 purchase core
  and Phase 2D hardening (#4)`)
- Active implementation branch/worktree: `phase-3-purchase-module` at
  `/home/luke/.codex/worktrees/dd12/sompi`.
- Historical branch/HEAD before the Phase 2D execution:
  `ap2-kaspa-purchase-core` at the required
  `17cce287fb0006aee9dd5f36697b58d770054e2f`.
- Required reviewed target: `082def29636fe0a6802240ee358f867c34667b4c`.
- Phase 2D remediation commits through the independent-review repair round:
  `9420aff`, `fdedcad`, `3664e76`, `7e2fa5a`, `801df30`, `2088348`,
  `1df2f9c`, `91f85cd`, `a3e5a20`, `081f619`, `eb96534`, and the post-review
  hardening commit `1151938`. The worktree is named and no remote branch was
  changed.
- Security-reviewed alpha.8 milestones: `8e1214b` and `015107a`. The current
  uncommitted remediation closes the two Low/P3 findings from the latest
  complete branch scan; its immutable post-fix rescan is the next gate.
- Untouched post-scan baseline: `npm test` passed with 339 tests, one privileged
  ownership test skipped, and complete offline smoke.
- Sealed deep scan: 21 findings, 8 medium and 13 low, no high/critical.
- Canonical scan results and selected hardening proposals are preserved under
  `security/audits/2026-07-11-sompi-deep-scan/`.

The original checkout at `/home/luke/projects/sompi` remained clean at the
required starting ref. The delegated worktree was the only implementation
surface.

## Authoritative reading order

1. [`CONTEXT.md`](CONTEXT.md)
2. [`docs/architecture/SOMPI_ARCHITECTURE.md`](docs/architecture/SOMPI_ARCHITECTURE.md)
3. [`docs/adr/`](docs/adr/README.md)
4. [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
5. this file

`goal.md` is the historical Phase 6 plan and is not the new architecture plan.

## Accepted architecture

- One repository and initially one npm package.
- Deep, stable Purchase module at the centre.
- SQLite Purchase Journal before replacement payments.
- Canonical authenticated `sompi-api`, thin untrusted `sompi-mcp`
  compatibility adapter, and deterministic `sompi-authority` executable.
- AP2 adapter owns authorization and evidence.
- Kaspa-x402 adapter owns x402/Kaspa payment execution.
- Kaspa-x402 is used unchanged for initial AP2 integration.
- AP2 and x402 are initially linked by canonical Purchase/payment identifiers
  and evidence digests, not a proprietary wire extension.
- AP2 v0.2 human-present + both Kaspa-x402 `kaspa-exact-v2` profiles +
  testnet first, followed by separately gated batch settlement.
- OpenAPI 3.2 describes the canonical Purchase API; Arazzo follows only after
  the lifecycle stabilizes.
- The alpha.8 cutover uses Journal epoch 14 and rejects epochs 1–13 without
  migration or compatibility readers.
- Complete deletion of Sompi x402 v1 at cutover; no compatibility layer.

## Completed milestones

Phase 2A is complete in `ca8e152`: the canonical scan is preserved, the
post-scan architecture and threat model are authoritative, and ADR-0011 through
ADR-0013 record the selected module boundaries.

Phase 2B is complete in `1292cb4`:

1. `sompi-operator` owns preview, sealed candidate provisioning, digest-approved
   installation, offline owner-key generation, and installed status;
2. the canonical manifest binds vault keys/template/address/configuration,
   immutable policy, HTTPS Merchant egress, receipt issuers, Chain Evidence
   sources/floors, and Admission Lease budgets;
3. production requires distinct operator/runtime principals, safe ownership,
   fixed modes, one link, safe ancestors, and descriptor-stable reads;
4. the Purchase Journal introduced a clean v5 epoch bound to one immutable
   manifest identity before durable work; schemas v1-v4 are rejected untouched;
5. MCP vault creation, MCP owner-key generation, policy file/hot reload,
   cleartext Merchant configuration, and manifest-fact environment fallbacks
   are deleted;
6. all four provisioning PoCs fail closed, 347 runnable tests pass with one
   privileged ownership skip, offline smoke passes, and the packed artifact
   verifier passes with the new operator executable.

Phase 2C is complete in `4c6fc8f`:

1. one typed Chain Evidence module owns provisional, accepted,
   depth-confirmed, historical, absent, unknown, and unavailable Testnet-10
   evidence, with consensus-final reserved as a distinct non-local level;
2. Journal v6 stores immutable, Operator-Manifest-bound evidence and retains
   accepted anchors after outputs are spent or the node prunes history;
3. exact Settlement, direct wallet operations, vault deposit/send and
   continuation, Purchase staging, staging-race recovery, and capacity release
   now consume the central evidence seam; obsolete single-RPC observers and
   low-level provisional vault/wallet observation APIs are deleted;
4. Merchant protocol finality and the stronger effective Operator Manifest
   floor are separate durable facts, and the effective floor is displayed and
   signed by the AP2 Authority evidence path;
5. accepted evidence requires exact transaction/input/output agreement between
   the operator wRPC node and the independent HTTPS accepted-history witness;
   generic errors, pruning, redirects, source disagreement, and partial views
   fail closed, while absence needs two corroborated observations separated by
   the propagation interval;
6. all thirteen original chain/finality PoCs fail against the cutover; `npm
   test` passes 353 runnable tests with one privileged ownership skip and the
   complete offline smoke; the 171-entry packed artifact verifies; and a
   read-only live check produced depth-confirmed evidence from
   `ws://10.0.3.26:17210/` plus `https://api-tn10.kaspa.org/`.

The initial Phase 2D implementation was reviewed independently against
`082def29636fe0a6802240ee358f867c34667b4c` and reopened. The first remediation
round (`9420aff`, `fdedcad`, `3664e76`, `7e2fa5a`) was itself re-reviewed and
the prior completion claim was withdrawn. The current repair round is recorded
in local commits `801df30`, `2088348`, `1df2f9c`, `91f85cd`, and `a3e5a20`:

1. Treasury now has a Journal-owned reducer/command boundary, durable driver
   owner and generation, bounded takeover, effect capabilities, typed
   terminal/transient/unknown preparation outcomes, exact retry accounting,
   cancellation/fence CAS, and proof-backed release after exact
   non-submission.
2. MCP registered handlers preserve the SDK AbortSignal through wallet send,
   vault send, vault deposit, and recovery. Authority's production Unix wrapper
   forwards transport cancellation, prompt admission precedes replay growth,
   replay rows/tokens/result storage are bounded, and late decisions/signatures
   cannot become approvals.
3. Purchase plus mandatory request evidence is one Journal-owned compound
   admission. Digest publication cleanup is ownership-scoped, unexpired
   foreign leases survive startup, unique committed evidence bytes rebuild
   idempotently, and denied egress leaves no Purchase or evidence state.
4. The three additional engineering blockers are covered: production Authority
   uses the manifest socket cap, Journal startup is owner/deadline aware, and
   shared-digest reconstruction counts unique artifacts once.
5. The clean-cutover Journal schema is epoch 10; epochs 1 through 9 are rejected
   untouched. No central scheduler, AP2/x402 wire change, Kaspa-x402 change,
   sibling-repository change, deployment, or remote branch change was made.
6. Focused lifecycle/admission/Vault/Treasury tests passed 36/36. The complete
   suite passed 383 tests: 382 pass, 0 fail, 1 documented root-only skip.
   Offline smoke passed all 13 checks. The final 173-entry package verifier
   passed and the generated archive was removed.

The ten first-round review PoCs stopped at their repaired invariants, and the
three follow-up finding PoCs plus Treasury takeover safety PoC now stop at the
current repaired boundaries. The compound and Vault legacy assertions exit
nonzero because they still expect the vulnerable outcome; their fixed output
and direct current-boundary regressions are authoritative. The four validated
lifecycle findings, not eight, are now fixed and all 21 scan findings are
accounted for.

Live Testnet-10 proof used the pinned `ws://10.0.3.26:17210/` node and the
existing funded wallet. The report is
`/tmp/sompi-phase2d-remediation-live-evidence/report.json` with digest
`9413e3960dcdb483ff8c71d8055a892bac27a1c7c8ac3fdad0675e217d4349d2`; it
reached `receipted` for Purchase `pur_ET773zjA5c6gi7kcE3Fblg` with exact
transaction `4f5338ce357e68ab1878a1a163e5d7b8551c1860166b20afb1e6e93354c9a985`
and Merchant outpoint `:1`. This run used the repository's in-process
auto-approved Authority fixture, so it does not claim human-present terminal
or separate-UID Authority conformance; those seams have hermetic
production-wrapper and abort regression coverage.

Phase 0 is complete:

1. the accepted specification was committed as `1bbfa0c`;
2. local `main` was fast-forwarded without rewriting history;
3. the build and complete offline smoke suite passed on normalized `main`;
4. `ap2-kaspa-purchase-core` was created from that exact commit.

Phase 1 is complete:

1. current wallet, vault, policy, MCP UX, and old x402 behaviour was classified
   as retained intent or temporary cutover evidence;
2. irreversible effects and recovery requirements were mapped in the threat
   model;
3. the stable Purchase interface, canonical identifiers, request fingerprint,
   and evidence digest were implemented and tested;
4. AP2 v0.2, Kaspa-x402 alpha.6, SD-JWT/JWS, schema, and SQLite implementations
   were pinned in one supported-profile declaration;
5. the native-KAS AP2 semantic gap was isolated and recorded in ADR-0010;
6. fixed wallet/address/signing and Purchase identity vectors pass alongside
   all existing offline smoke checks.

Phase 2 is complete:

1. SQLite is configured with WAL, full synchronous durability, foreign keys,
   application/schema identity, secure file modes, and fail-closed startup
   validation;
2. Purchase, Payment Attempt, and Effect states replay from immutable histories,
   with semantic corruption rejected at startup;
3. policy snapshots, atomic Treasury Reservations, in-flight capacity, and
   separate immutable spend facts prevent capacity loss or double consumption;
4. evidence and prepared effect bytes are content-addressed, mode-restricted,
   rehashed at use, and excluded from SQLite plaintext;
5. effect-specific and recovery leases use monotonic fencing generations, and
   recovery cannot pre-empt a live executor or blindly retry ambiguity;
6. abrupt process kills, external-success/local-record gaps, stale workers,
   tampering, corruption, lifecycle restarts, and real multi-process races are
   covered by the Phase 2 suite.

Phases 3 through 6 have an implemented pre-hardening vertical:

1. MCP exposes the stable Purchase operations and the Purchase module owns the
   lifecycle and recovery orchestration; Phase 3 will move MCP behind the
   canonical authenticated API;
2. Kaspa-x402 alpha.6 exact executes through durable wallet/vault staging with
   the bespoke x402 v1 runtime removed;
3. a separate deterministic `sompi-authority` verifies and signs human-present
   AP2 evidence;
4. the demo Merchant joins Checkout, mandates, exact Settlement, Fulfilment,
   and AP2 receipts;
5. local crash/replay proofs and live Testnet-10 Purchase evidence passed.

The deep scan acceptance gates were reopened and are now satisfied through the
third Phase 2D remediation round. The full local vertical, offline smoke,
focused suites, package verification, all four latest PoCs, and the pinned live
proof were rerun after the latest implementation commit.

No remote push, package publish, deployment, or sibling-repository change was
performed.

## Phase 2D remediation round 2 verification (historical)

The sealed re-review of `6619813135f78bfcfb5a9aceffca5a8959c337a0` identified
three reportable defects and one Treasury safety blocker. The corrected
boundaries now prove that a stale predecessor cannot be replaced by an
automatic second submit, every retained compound Purchase consumes one count
allocation across restart, deterministic Vault failures terminalize as typed
no-effect outcomes, and waiter takeover drives the exact acquired lease.

- Journal schema epoch: **10**. Epochs **1–9** are rejected without
  compatibility readers or mutation.
- Focused lifecycle/admission/Vault/Treasury suite: **36 pass, 0 fail, 0
  skipped**. Complete `npm test`: **383 tests, 382 pass, 0 fail, 1 skip**;
  the only skip is the root-only file-ownership test. Offline smoke: **13/13
  checks pass**.
- Fixed-tree PoCs: compound output is `used=1`, saturated, and cap+1 is
  rejected after restart; Vault output is `failed_terminal` on attempt one
  with retry count 0 and capacity 0; waiter takeover settles both same-key
  callers with one prepare/submit/observe/commit; stale takeover performs one
  submit, successor submit count 0, and retains capacity until observation.
- Package verification passed for the final archive; the generated archive was
  removed. The live Testnet-10 harness against the pinned
  `ws://10.0.3.26:17210/` node reached `receipted` for Purchase
  `pur_ET773zjA5c6gi7kcE3Fblg` with transaction
  `4f5338ce357e68ab1878a1a163e5d7b8551c1860166b20afb1e6e93354c9a985` and
  report digest
  `9413e3960dcdb483ff8c71d8055a892bac27a1c7c8ac3fdad0675e217d4349d2`.
  This live harness uses an in-process auto-approved Authority fixture and
  does not claim separate-UID human-present Authority conformance.

That round was subsequently reopened by the sealed re-review of `7656013`.

## Phase 2D remediation round 3 verification

The sealed re-review of `7656013c6d782ac32babb84507c252df9f902dea`
validated four additional lifecycle findings. Commit `081f619` repairs them
without changing the Journal schema, AP2/x402 wire objects, Kaspa covenant
rules, or any sibling repository:

1. Exact adapter submission success is recorded outside the adapter-error
   catch and remains authoritative after post-capability cancellation.
2. `in_flight`, `ambiguous`, and `accepted` outcomes all retain capacity on
   temporary corroborated absence; exact acceptance cannot later be
   overwritten by an absence claim.
3. Vault send, initial deposit, and funded top-up wrap every enumerated
   read-only pre-sign client, UTXO, fee-estimate, and server-info RPC await as
   `rpc_unavailable`. The existing manifest retry budget handles those proven
   no-effect failures; signing, serialization, submission, and unknown errors
   remain fail-closed.
4. Regression coverage spans wallet send, vault send, and vault deposit;
   cancellation/acceptance timing, lagging absence, restart, successor
   admission, Journal acceptance failure, and zero-signature Vault RPC faults.

Verification for this round:

- Focused Treasury/Vault/schema/fault-boundary suite: **35 pass, 0 fail, 0
  skipped**.
- Complete `npm test`: **385 tests, 384 pass, 0 fail, 1 documented root-only
  skip**. Offline smoke: **13/13 pass**.
- Package verification: **173 entries**, **5,036,713 packed bytes**, and
  **14,358,917 unpacked file bytes**; the generated archive was removed.
- The cancellation PoC reached durable `submitted`, retained 110 units of
  policy capacity, and remained unresolved after lagging absence. The Vault
  send, initial-deposit, and top-up PoCs all stopped when their former plain
  RPC errors became typed `transient_unavailable` preparation outcomes.
- A fresh funded Testnet-10 run against `ws://10.0.3.26:17210/` reached
  `receipted` for Purchase `pur_w9AgZJqW8U4IsOyVPxjraA`, exact transaction
  `2a54ad1b9683629f60e4bb8c25492205a353f81b5c2651c0d27f91f1ac243a55`,
  Merchant outpoint `:1`, and canonical report digest
  `82a4e67848d6967c387b6279515ae04a541241c689cad97120a76b1329d5d0e3`.
  The mode-`0600` report is
  `/tmp/sompi-phase2d-final-live-reports/report.json`. The run uses the
  in-process auto-approved Authority fixture and does not claim separate-UID
  human-present Authority conformance.

The four latest findings are fixed at their current boundaries and the
original 21 deep-scan findings remain accounted for. The exact review of
`7656013..eb96534` completed with zero reportable findings.

## Phase 2D post-review hardening

Commit `1151938` removes the unused caller-selected
`proven_not_executed` outcome. Before the change, the focused regression
demonstrated that the string alone could move an effect-capable operation back
to `prepared` without any structured proof. The Journal now rejects the
removed value, and every supported `not_submitted` observation retains the
effect capability, reservation, and exclusive slot across restart.

Verification after the clean cutover:

- Focused Journal/Treasury lifecycle suite: **26 pass, 0 fail, 0 skipped**.
- Complete `npm test`: **386 tests, 385 pass, 0 fail, 1 documented root-only
  skip**. Offline smoke: **13/13 pass**.
- Package verification: **173 entries**, **5,038,543 packed bytes**, and
  **14,363,292 unpacked file bytes**; the generated archive was removed.
- `git diff --check` passed. No Journal schema, AP2/x402 wire object,
  Kaspa-x402 mechanism, covenant rule, sibling repository, deployment, or
  remote branch changed.

The fresh funded Testnet-10 proof already recorded above remains the current
live vertical evidence; this Journal-only deletion does not alter network or
protocol behavior and did not spend additional testnet funds.

## Next action

Commit the verified security remediation, run a fresh immutable diff scan over
the complete branch, and fix/rescan any surviving issue until clean. Then run
the remaining funded additive-contention Testnet-10 proof, replace the stale
alpha.6 public evidence with the final alpha.8 evidence set, and complete the
Phase K documentation, clean-package, accepted-ADR, and branch-publication
audit.

## Known external uncertainties

These are contained by the design and do not block the hardening cutover:

- AP2 and x402 remain evolving standards.
- The official AP2-compatible x402 integration may change or arrive later.
- AP2 v0.2 has no standardized native-KAS amount mapping; ADR-0010 makes the
  first profile explicitly experimental and testnet-only.
- Kaspa-x402's eventual upstream package shape may change independently.
- Passkey deployment/recovery and autonomous authorization are intentionally
  deferred.
- Real third-party AP2 interoperability will require another implementation;
  the initial proof uses Sompi's demo Merchant fixture.
- The private Testnet-10 Chain Evidence profile uses the operator node at
  `10.0.3.26` plus an independent HTTPS accepted-chain witness. This is suitable
  for the initial proof, not a public/mainnet cryptographic inclusion claim.
- A transaction older than the operator node's retained acceptance window
  cannot be newly corroborated from that node. This fails closed; transactions
  first observed while corroboration is available remain recoverable from the
  immutable Journal evidence.

## Current blockers

No implementation or funding blocker remains. The latest live proof used the
funded source wallet at `/home/luke/.sompi/testnet-10` and left isolated
evidence under `/tmp`; the report intentionally does not claim human-present
or separate-UID Authority conformance. The pre-crash temporary security-fix
report mirror no longer exists, so only the durable repository report was
updated. No sibling Kaspa-x402 change is required.
