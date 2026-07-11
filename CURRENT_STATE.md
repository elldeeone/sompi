# Current state

Last updated: **2026-07-11**

## Plain-English status

**Architecture codified; ready to begin Phase 0 of the end-to-end build.**

The target design and decisions are complete. The implementation has not begun:
the current source still contains Sompi's existing x402 v1 escrow path and
pre-cutover JSON state. Architecture documents describe the accepted target,
while README/proof documents continue to describe current behaviour until the
clean cutover updates them.

## Git orientation at codification

- Repository: `https://github.com/elldeeone/sompi`
- Active branch: `ux-agent-native-payments`
- Active commit: `4811942` (`Add public demo service installer`)
- Relationship to local `main`: `0 behind / 18 ahead`
- Worktree before documentation edits: clean
- Documentation changes from this codification: uncommitted

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

## Next action

Execute **Phase 0: Normalize the Git base** from
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md):

1. recheck branch/worktree/remote state;
2. fast-forward local `main` to the verified latest branch;
3. build and run offline smoke on normalized `main`;
4. create the implementation branch;
5. begin Phase 1 characterization and threat modelling.

No branch switch, merge, commit, push, package publish, sibling-repository
change, or implementation was performed during architecture codification.

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
