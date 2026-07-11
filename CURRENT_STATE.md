# Current state

Last updated: **2026-07-11**

## Plain-English status

**Phases 0 through 2 complete; Phase 3 Purchase module deepening is next.**

The target design and decisions are complete, the implementation branch has a
crash-safe Purchase Journal and recovery foundation, and all Phase 2 gates pass.
The current source still contains Sompi's existing x402 v1 escrow path and
pre-cutover JSON state; those remain only until the Phase 4 clean cutover.

## Git orientation at codification

- Repository: `https://github.com/elldeeone/sompi`
- Normalized local `main`: `1bbfa0c` (`Document AP2 and Kaspa-x402 architecture`)
- Active implementation branch: `ap2-kaspa-purchase-core`
- Latest verified implementation milestone: `2b68a54` (`Add transactional Purchase Journal`)
- Phase 2 verification: `npm test` passed (36 focused tests plus complete offline smoke)
- Phase 2 adversarial review: two independent reviews found no remaining blocker
  or high-severity issue
- Remote state: unchanged; local `main` is ahead of `origin/main`

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

No remote push, package publish, deployment, or sibling-repository change was
performed.

## Next action

Execute **Phase 3: Deepen the Purchase module behind existing MCP UX** from
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). Implement canonical
Checkout Terms and authorization/treasury seams, route orchestration through the
stable Purchase interface, add deterministic status projection, and enforce the
outbound egress policy before protocol cutover.

## Known external uncertainties

These are contained by the design and do not block Phase 3:

- AP2 and x402 remain evolving standards.
- The official AP2-compatible x402 integration may change or arrive later.
- AP2 v0.2 has no standardized native-KAS amount mapping; ADR-0010 makes the
  first profile explicitly experimental and testnet-only.
- Kaspa-x402's eventual upstream package shape may change independently.
- Passkey deployment/recovery and autonomous authorization are intentionally
  deferred.
- Real third-party AP2 interoperability will require another implementation;
  the initial proof uses Sompi's demo Merchant fixture.

## Current blockers

None for Phase 3. Kaspa-x402 alpha.6 expects its `FundingProvider` to assemble
the exact transaction from public reservation terms; Sompi will implement and
vector-test that wallet adapter in Phase 4 without changing the sibling repo.
