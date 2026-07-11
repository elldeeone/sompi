# Current state

Last updated: **2026-07-11**

## Plain-English status

**Phase 0 complete; Phase 1 characterization and threat modelling is next.**

The target design and decisions are complete, local `main` has been normalized
to the latest verified history, and the implementation branch has been created.
The current source still contains Sompi's existing x402 v1 escrow path and
pre-cutover JSON state; those remain only until the Phase 4 clean cutover.

## Git orientation at codification

- Repository: `https://github.com/elldeeone/sompi`
- Normalized local `main`: `1bbfa0c` (`Document AP2 and Kaspa-x402 architecture`)
- Active implementation branch: `ap2-kaspa-purchase-core`
- Active commit: `1bbfa0c`
- Relationship to local `main`: `0 behind / 0 ahead`
- Baseline verification: `npm run build` passed
- Baseline verification: `SOMPI_SMOKE_OFFLINE=1 npm run smoke` passed
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

## Completed milestone

Phase 0 is complete:

1. the accepted specification was committed as `1bbfa0c`;
2. local `main` was fast-forwarded without rewriting history;
3. the build and complete offline smoke suite passed on normalized `main`;
4. `ap2-kaspa-purchase-core` was created from that exact commit.

No remote push, package publish, deployment, or sibling-repository change was
performed.

## Next action

Execute **Phase 1: Characterize, model threats, and freeze interfaces** from
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md), then commit the
verified characterization/threat-model milestone before building the journal.

## Known external uncertainties

These are contained by the design and do not block Phase 0:

- AP2 and x402 remain evolving standards.
- The official AP2-compatible x402 integration may change or arrive later.
- Exact AP2 dependency/profile provenance must be selected and pinned in Phase
  1 against then-current official sources.
- Kaspa-x402's eventual upstream package shape may change independently.
- Passkey deployment/recovery and autonomous authorization are intentionally
  deferred.
- Real third-party AP2 interoperability will require another implementation;
  the initial proof uses Sompi's demo Merchant fixture.

## Current blockers

None for beginning the end-to-end build.
