# Current state

Last updated: **2026-07-13**

## Plain-English status

**Phase 2D bounded operational lifecycles are complete and ready for review.**
The first human-present AP2 + Kaspa-x402 exact vertical remains testnet-only;
the post-scan hardening gates now pass through the bounded Authority,
Purchase/Journal, Evidence, and direct-Treasury lifecycles.

Phases 0 through 6 were implemented through `4ebb82d`, including the stable
Purchase module, clean Kaspa-x402 alpha.6 exact path, isolated interactive AP2
Authority, demo Merchant, crash recovery, local vertical proof, and live
Testnet-10 evidence. The completed deep security scan then found 21 medium/low
issues concentrated in chain evidence/finality, operator provisioning, and
unbounded operation lifecycles. Phases 2A through 2D are now committed and
verified; the branch is ready for review and Phase 3 has not started.

## Git orientation at codification

- Repository: `https://github.com/elldeeone/sompi`
- Normalized local `main`: `1bbfa0c` (`Document AP2 and Kaspa-x402 architecture`)
- Active implementation branch: `ap2-kaspa-purchase-core`
- Historical branch/HEAD before the Phase 2D execution:
  `ap2-kaspa-purchase-core` at the required
  `17cce287fb0006aee9dd5f36697b58d770054e2f`.
- Phase 2D implementation commit: `856131a` (`Bound Phase 2D operational
  lifecycles`). The delegated review worktree is intentionally detached at
  the final local closeout commit; no remote branch was changed.
- Latest implementation milestone: `4c6fc8f` (`Centralize trusted chain
  evidence`).
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
- Separate `sompi-mcp` and deterministic `sompi-authority` executables.
- AP2 adapter owns authorization and evidence.
- Kaspa-x402 adapter owns x402/Kaspa payment execution.
- Kaspa-x402 is used unchanged for initial AP2 integration.
- AP2 and x402 are initially linked by canonical Purchase/payment identifiers
  and evidence digests, not a proprietary wire extension.
- AP2 v0.2 human-present + Kaspa-x402 exact + testnet first.
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

Phase 2D is complete in local implementation milestones `856131a`, `5cc8785`,
and `fec8df4`, plus the closeout commit:

1. Trusted Authority pre-authentication sockets are admitted before parser
   state and bounded at the manifest's 32-socket budget; a non-renewable frame
   deadline, overload rejection, signal propagation, and exactly-once release
   cover handoff, malformed input, timeout, disconnect, and shutdown.
2. Authenticated human decisions are bounded at the manifest's four-prompt
   budget, retain one visible terminal ceremony, and cancel queued/active work
   on disconnect, expiry, heartbeat loss, shutdown, and late answers.
3. Purchase count and immutable Evidence bytes use Journal-owned SQLite
   Admission Lease history and atomic counters. Unique blobs consume bytes,
   identical blobs deduplicate, durable link/publication faults reconcile on
   restart, valid evidence is never deleted for quota, and secret-free MCP
   saturation status is exposed.
4. Direct Treasury validation runs before durable claim. Typed permanent
   pre-effect failures terminalize and release policy capacity, transient
   preparation failures use the durable manifest retry bound, and prepared,
   submitted, or ambiguous work remains fenced for Reconciliation. Wallet send,
   vault send, and vault deposit share the same policy-capacity protections.
5. The clean-cutover Journal schema is epoch 8; v1 through v7 are rejected
   untouched. No central scheduler, AP2/x402 wire change, Kaspa-x402 change,
   or sibling-repository change was introduced.
6. Verification completed with 370 unit tests (369 pass, 0 fail, 1 documented
   root-only skip), 13 offline smoke checks, 201 focused lifecycle/config/E2E
   tests (201 pass), deterministic local E2E receipted state, and a 172-entry
   packed artifact accepted by the package verifier.

The four lifecycle PoC dispositions are recorded in the Phase 2D fix report:
the fixed pre-auth PoC observed only 32 retained sockets, the fixed prompt PoC
was bounded at four admitted prompts, and the fixed storage PoC retained no
Purchase or evidence bytes for denied egress. The original direct-Treasury
PoC's pre-2B PolicyEngine constructor no longer crosses the clean-cutover API;
the exact 17cce baseline was reproduced separately (permanent preparation left
an `intent` row and 110 units of capacity, blocking the next operation), while
the fixed current seam has direct regression coverage for terminalization,
retry bounds, restart, cancellation, and slot reuse.

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

1. MCP exposes the stable Purchase interface and the Purchase module owns the
   lifecycle and recovery orchestration;
2. Kaspa-x402 alpha.6 exact executes through durable wallet/vault staging with
   the bespoke x402 v1 runtime removed;
3. a separate deterministic `sompi-authority` verifies and signs human-present
   AP2 evidence;
4. the demo Merchant joins Checkout, mandates, exact Settlement, Fulfilment,
   and AP2 receipts;
5. local crash/replay proofs and live Testnet-10 Purchase evidence passed.

The deep scan acceptance gates were reopened and are now satisfied through
Phase 2D. The full local vertical, offline smoke, focused suites, and package
verification were rerun after the bounded-lifecycle cutover.

No remote push, package publish, deployment, or sibling-repository change was
performed.

## Next action

Review the Phase 2D local commits. Do not start Phase 3 in this closeout.

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

No implementation blocker remains. A fresh funded Testnet-10 Treasury wallet
would be required for a future live funded rerun, but no such rerun was in
scope. The legacy direct-Treasury PoC harness is stale against the clean 2B
PolicyEngine API; the current-boundary regression and exact baseline
reproduction are the authoritative evidence. No sibling Kaspa-x402 change is
required.
