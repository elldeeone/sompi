# Current state

Last updated: **2026-07-13**

## Plain-English status

**The first human-present AP2 + Kaspa-x402 exact vertical exists and passed live
Testnet-10 proof, but the post-scan hardening cutover is now the active gate.**

Phases 0 through 6 were implemented through `4ebb82d`, including the stable
Purchase module, clean Kaspa-x402 alpha.6 exact path, isolated interactive AP2
Authority, demo Merchant, crash recovery, local vertical proof, and live
Testnet-10 evidence. The completed deep security scan then found 21 medium/low
issues concentrated in chain evidence/finality, operator provisioning, and
unbounded operation lifecycles. Phase 2A is committed and Phase 2B Operator
Provisioning is now implemented and verified locally; the other two deep
Modules must land before the original phase gates can be considered final.

## Git orientation at codification

- Repository: `https://github.com/elldeeone/sompi`
- Normalized local `main`: `1bbfa0c` (`Document AP2 and Kaspa-x402 architecture`)
- Active implementation branch: `ap2-kaspa-purchase-core`
- Current branch/HEAD/upstream: `ap2-kaspa-purchase-core` at
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`, exactly synced.
- Latest implementation milestone: `4ebb82d` (`Add interactive human-present
  authority proof`).
- Untouched post-scan baseline: `npm test` passed with 339 tests, one privileged
  ownership test skipped, and complete offline smoke.
- Sealed deep scan: 21 findings, 8 medium and 13 low, no high/critical.
- Canonical scan results and selected hardening proposals are preserved under
  `security/audits/2026-07-11-sompi-deep-scan/`.

Do not assume these facts remain current. Re-run Git orientation before Phase
0, preserve unrelated changes, and update this section with the verified base.

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

Phase 2B is complete in the working milestone awaiting its intentional commit:

1. `sompi-operator` owns preview, sealed candidate provisioning, digest-approved
   installation, offline owner-key generation, and installed status;
2. the canonical manifest binds vault keys/template/address/configuration,
   immutable policy, HTTPS Merchant egress, receipt issuers, Chain Evidence
   sources/floors, and Admission Lease budgets;
3. production requires distinct operator/runtime principals, safe ownership,
   fixed modes, one link, safe ancestors, and descriptor-stable reads;
4. the Purchase Journal is a clean v5 epoch bound to one immutable manifest
   identity before durable work; schemas v1-v4 are rejected untouched;
5. MCP vault creation, MCP owner-key generation, policy file/hot reload,
   cleartext Merchant configuration, and manifest-fact environment fallbacks
   are deleted;
6. all four provisioning PoCs fail closed, 347 unit tests pass with one
   privileged ownership skip, offline smoke passes, and the packed artifact
   verifier passes with the new operator executable.

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

The deep scan reopened their security acceptance gates. They are not considered
final until Phases 2A through 2D remove the validated weaknesses and the full
vertical is rerun.

No remote push, package publish, deployment, or sibling-repository change was
performed.

## Next action

Commit the completed **Phase 2B** Operator Provisioning milestone, then execute
**Phase 2C: Chain Evidence and finality**. It centralizes transaction identity,
retained history, two-witness acceptance, continuation semantics, negative
evidence, and operation-specific Finality Floors.

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

## Current blockers

None for the documentation or implementation milestones. Live funded reruns
will require a fresh Testnet-10 Treasury wallet only after all offline and
read-only gates pass. No sibling Kaspa-x402 change is required.
