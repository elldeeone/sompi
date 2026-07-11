# Sompi repository instructions

These instructions apply to the whole repository.

## Read before changing code

Read these files in order:

1. `CONTEXT.md`
2. `docs/architecture/SOMPI_ARCHITECTURE.md`
3. every accepted record in `docs/adr/`
4. `docs/IMPLEMENTATION_PLAN.md`
5. `CURRENT_STATE.md`

The architecture documents are the source of truth for the in-progress clean
cutover. The current README and older proof documents describe the software
that exists before the cutover; they do not override accepted architecture
records.

## Non-negotiable rules

- This project has no external users or production state requiring backwards
  compatibility. Remove replaced code, state readers, wire types, fixtures,
  commands, documentation, and fallback paths in the same cutover.
- Keep Sompi's stable Purchase model independent of AP2 and x402 wire or SDK
  types. Raw protocol artifacts are evidence attachments, not Sompi's domain
  state.
- AP2 belongs to the authorization and evidence adapter. Kaspa-x402 belongs to
  payment execution. Do not put AP2 semantics into Kaspa-x402 or reimplement
  x402 mechanisms in Sompi.
- Do not modify the sibling Kaspa-x402 repository merely to accommodate Sompi.
  Any Kaspa-x402 work must be separately justified as an upstream-alignment or
  general library change and explicitly included in the task scope.
- The agentic MCP process is not a trusted approval surface and must never hold
  authority credentials.
- Durable intent, idempotency, policy reservation, and recovery state must be
  committed before an irreversible blockchain or merchant side effect.
- Support only explicitly pinned protocol profiles and fail closed on unknown
  profiles. During an upgrade, replace the old runtime implementation after
  conformance passes; do not accumulate permanent dual-version paths.
- Start with human-present AP2 and Kaspa-x402 `exact` on testnet. Batch
  settlement, autonomous authorization, UCP, passkeys, and mainnet each require
  their recorded acceptance gates.

## Architecture vocabulary

Use the vocabulary in `CONTEXT.md` and the architecture document. In
particular:

- `Purchase` is Sompi's stable lifecycle record.
- `Purchase module` is the deep module owning orchestration and recovery.
- A `seam` is where an interface allows an adapter to vary.
- `AP2 adapter` and `Kaspa-x402 adapter` are protocol-specific implementations
  at separate seams.
- `Trusted Authority` is deterministic and non-agentic.

Do not introduce a universal payment-rail plugin system. There is one real
execution adapter today. Add a broader seam only after a second real adapter
demonstrates the shared interface.

## Working practice

- Preserve unrelated user changes in a dirty worktree.
- Update `CURRENT_STATE.md` after each completed implementation phase.
- Check off acceptance criteria in `docs/IMPLEMENTATION_PLAN.md` only when
  verified by tests or recorded evidence.
- Add or amend an ADR before knowingly changing an accepted design decision.
- Keep external protocol dependencies pinned exactly while they remain
  pre-1.0 or otherwise unstable.
- Do not claim AP2, x402, Kaspa-x402, or mainnet conformance without the
  corresponding conformance and end-to-end evidence.
- Do not commit, push, publish, deploy, or modify sibling repositories unless
  the user requests that action.
