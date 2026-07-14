# Security Hardening Proposal: Proof-backed chain evidence and finality

## Decision

Adopt one Sompi-owned Chain Evidence Gateway that is the only component allowed
to turn Kaspa observations into proof levels consumed by Settlement, staging
recovery, direct Treasury operations, or durable vault state. For the current
Testnet-10 cutover, choose Option 2 and fail closed whenever its backend cannot
produce the required proof or independent witness. Treat Option 3 as the
preferred evidence backend before any public or mainnet claim.

This is not a new payment-rail abstraction. Kaspa-x402 continues to own x402
wire and exact-payment mechanics, while Sompi owns the evidence needed to
advance its Purchase, policy, recovery, wallet, and vault state.

## Executive Recommendation

We have three serious choices. **Option 1, Local observer guards**, patches the
current call sites and is the fastest way to remove known provisional-finality,
identity, and error-classification failures. **Option 2, Typed Chain Evidence
Gateway**, consolidates transaction identity, proof level, history, negative
evidence, and finality policy behind one internal boundary. **Option 3,
Trusted local evidence plane**, gives that gateway a locally controlled node
and accepted-transaction history service rather than depending on a selected
remote RPC for consensus truth.

I recommend Option 2 under the current testnet and clean-cutover constraints,
with Option 1's guards retained as migration protections. Its strongest value
is not code reuse; it makes it impossible for a caller to confuse a mempool
observation, current UTXO, historical inclusion, negative snapshot, or
authenticated finality without crossing one explicit type and policy boundary.
Option 3 should win if the project cannot obtain a verifiable proof through the
gateway, if public availability becomes important, or before mainnet economics
make a selected remote RPC an unacceptable trust root.

## Evidence

I inspected the exact verifier, staging-race observer, wallet and vault
observers, Purchase coordinator, and journal transitions at the affected
revision. The following evidence most influenced the diagnosis. Each ID is
defined here so later coverage tables remain readable.

| Evidence | Finding | What it establishes |
| --- | --- | --- |
| `CAN-003` | Single-RPC false Settlement | One RPC supplies UTXO membership and both DAA values used to create verified Settlement at `src/adapters/kaspa-x402/chain-verifier.ts:562-642`. |
| `CAN-004` | Forged recovery finality | One RPC can fabricate a recovery winner whose claimed finality releases policy capacity through `src/purchase/journal.ts:5082-5186`. |
| `CAN-006` | RPC error treated as absence | Broad error-message matching at `src/adapters/kaspa-x402/staging-recovery-rpc.ts:482-484` turns capability failure into affirmative absence. |
| `CAN-016` | Mempool transaction-ID spoof | RPC `verboseData.transactionId` bypasses local transaction hydration and hashing at `src/adapters/kaspa-x402/chain-verifier.ts:1369-1383`. |
| `CAN-017` | Spent Merchant output loses evidence | Current UTXO and mempool views cannot prove a paid transaction after the Merchant spends its output. |
| `CAN-018` | Single-snapshot recovery race | Two negative observations and one unspent source from one view authorize a competing recovery broadcast. |
| `CAN-020` | Mempool exact winner terminalizes recovery | The exact-winner branch omits the required-finality comparison and makes a provisional observation terminal at `src/purchase/journal.ts:2782-2801`. |
| `CAN-023` | Provisional direct wallet completion | A non-orphan mempool entry can terminally complete a direct wallet send at `src/wallet.ts:308-348`. |
| `CAN-024` | Provisional vault continuation | Matching current outputs advance the durable vault continuation without an accepted-finality floor at `src/vault.ts:652-700`. |
| `CAN-025` | Provisional vault deposit | A matching deposit UTXO commits vault state without an accepted-finality floor at `src/vault.ts:450-473`. |
| `CAN-026` | Provisional Purchase staging | The shared vault observation commits staging and continuation state before accepted finality. |
| `CAN-030` | Merchant-selected mempool capacity release | Merchant requirements can select `mempool`; the human approval facts omit finality, and recovery capacity follows that lower threshold. |
| `CAN-033` | Spent staging winner loses attribution | Once winner outputs are spent, current views cannot attribute the staging outpoint and recovery becomes terminally ambiguous. |

**Observed:** proof semantics are implemented separately in the exact verifier,
staging-recovery RPC adapter, wallet, vault, Treasury adapters, and journal.
The same source can be called `observed`, `accepted`, or a winner under
different thresholds. Current UTXO and mempool views are frequently treated as
the evidence object itself.

**Inferred:** Sompi lacks one owner for the question, “What evidence is strong
enough for this durable transition?” The recurring failures are therefore not
only thirteen local defects. They are control drift caused by passing
unbranded RPC tuples and finality strings across privileged state boundaries.

## Current Design And Failure Mode

The normal runtime composes one `RpcChainObservationSource` from the wallet's
selected RPC. `KaspaExactChainVerifier` correctly binds transaction ID,
outpoint, amount, payee script, network, Merchant response, and requested
finality. The missing property is authenticity: the same peer supplies the
claimed UTXO, its block DAA score, and the virtual DAA score. Exact comparison
therefore establishes self-consistency, not canonical inclusion.

Staging recovery repeats that pattern with more dangerous negative semantics.
It asks the same peer for exact, recovery, and source-outpoint observations;
classifies absence or a winner; then persists a readiness digest or final
accounting result. The digest records what the peer said, but does not make the
statement globally true. Generic RPC failures can also enter the same classifier
as absence.

Direct wallet and vault operations bypass the exact-settlement verifier and
apply their own rules. Several accept a matching mempool or zero-DAA output and
then terminally complete an operation or advance the vault continuation. The
journal is internally consistent after those writes, which makes later repair
harder: a false premise has already become a durable invariant.

History is the other half of the problem. When a Merchant output or staging
winner is spent, current UTXO and mempool views lose the evidence needed to
close accounting. The system then has no durable accepted-transaction witness
to distinguish paid, recovered, and unknown outcomes. We can see why adding
one more equality check at each caller will not make this boundary coherent.

## Desired Invariants

- Every durable Settlement, returned-principal accounting entry, capacity
  release, direct-Treasury completion, vault continuation, and staging commit
  consumes a proof whose level meets a Sompi-owned operator minimum.
- `mempool` is always provisional. It may drive observation and retry
  suppression, but never a terminal state or capacity release.
- Transaction identity is derived from canonical transaction bytes or a
  verified proof, never from untrusted verbose metadata alone.
- A single negative RPC snapshot is `unknown`, not proof of global absence and
  never sufficient by itself to authorize a competing irreversible broadcast.
- Accepted transaction and winner evidence remains available after outputs are
  spent, after restart, and through the retention horizon required by policy
  accounting and recovery.
- Capability failure, not-found, timeout, disagreement, and pruning are
  distinct outcomes with fail-closed semantics.
- The proof profile, verifier identity, transaction facts, finality, and
  evidence digest are durable before a proof-dependent state transition.
- The Purchase model stores stable canonical facts and evidence references;
  it does not persist RPC SDK objects or absorb x402 wire semantics.

## Constraints And Non-Goals

The design must preserve the AP2 authorization seam and the Kaspa-x402
execution seam. AP2 may display an operator-owned finality requirement, but it
does not become the chain verifier. Kaspa-x402 continues to implement x402
payment mechanics; Sompi does not fork it or ask it to understand Purchase or
AP2 state.

We are not proposing a generic blockchain or payment-rail plugin system. This
boundary exists because one real Kaspa execution path already feeds several
Sompi-owned state machines. Mainnet, batch settlement, autonomous approval,
and multi-rail variation remain out of scope. No measured latency, throughput,
node-storage, or memory budget is available, so resource effects below are
source-derived or hypothetical and require measurement.

## Before Architecture

The current structure lets each consumer interpret the same selected RPC and
Merchant claims independently:

[Before: dispersed chain-evidence ownership](../diagrams/proof-backed-chain-evidence-before.mmd)

The decision-relevant edge is from the selected RPC directly into three
different proof owners. The Purchase Journal records their conclusions, but it
cannot recover authenticity or history that the upstream observer never
established.

## Options

### Option 1: Local observer guards

This option keeps the current component boundaries and patches every known
caller. We would recompute mempool transaction IDs, classify RPC errors by
typed capability/error codes, reject future or incoherent DAA relations,
enforce an operator-owned accepted/confirmed minimum for all terminal effects,
keep provisional winners recoverable, and query/persist accepted transaction
history before output evidence disappears. Merchant `mempool` may remain a
request, but it cannot lower the operator minimum or bypass the trusted display
when that threshold affects capacity.

The attractive part is delivery speed. Most changes are small and the critical
path gains little beyond existing validation and, where history is queried, one
additional RPC call. The principal concern is recurrence. A malicious selected
RPC still controls every positive chain fact, and future call sites can again
invent their own finality semantics. History remains only as trustworthy and
available as the same backend.

We can roll this option out as ordinary focused changes, retain the current API,
and reverse each patch independently. Rollback is operationally simple, but it
also restores the vulnerable semantics; there is no safe long-lived mixed
mode for a journal transition already made under a weaker threshold.

[Option 1 after: local guards at each observer](../diagrams/proof-backed-chain-evidence-local-observer-guards-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Proof threshold | Call-site-specific strings | Explicit accepted/confirmed checks in each caller | Closes known provisional terminal states | Repeated enforcement can drift |
| Transaction identity | RPC verbose metadata may win | Canonical bytes are hashed locally | Removes the observed mempool spoof path | Small CPU/allocation cost |
| Negative evidence | Errors and one snapshot may mean absent | Typed failure and unknown remain non-authorizing | Prevents known unsafe recovery broadcast | More recoveries remain pending |
| Historical evidence | Mostly current UTXO/mempool | Callers query and persist accepted history | Reduces post-spend ambiguity | Extra RPC/storage and pruning dependence |

### Option 2: Typed Chain Evidence Gateway

This option introduces one internal Sompi boundary with proof-bearing result
types such as `ProvisionalObservation`, `AcceptedChainProof`,
`HistoricalTransactionProof`, `NegativeObservationSet`, and `Unknown`. The
types are illustrative; the important property is that privileged consumers
cannot construct or promote them. The gateway owns canonical transaction-ID
derivation, proof/profile verification, operator finality floors, source
identity, disagreement, history retention, and the rule that one negative view
never authorizes a conflicting effect.

The Kaspa-x402 adapter would ask the gateway for an accepted proof of the exact
Merchant output after it validates x402 and Merchant evidence. Staging recovery
would ask for a winner proof or a bounded negative observation set. Wallet and
vault adapters would ask for accepted proof before committing direct state.
The Purchase module and journal would receive stable canonical proof metadata
and an immutable evidence digest, not RPC objects. This keeps protocol
ownership intact while making the security decision shared.

What gives me pause is backend truth. A clean API around one lying RPC is still
one lying RPC. The gateway must therefore refuse to mint an accepted proof
unless its backend supplies a locally verified inclusion/finality proof or an
explicitly accepted independent-witness policy. Under a temporary two-witness
testnet profile, the configuration must reject duplicate or operationally
dependent endpoints and bind witness identities into the evidence. That is
risk reduction, not equivalent to consensus verification.

The performance mechanism is clear: proof or witness collection adds network
hops and makes latency the maximum of required sources. Parallel queries and a
bounded cache keyed by transaction/proof identity can contain the cost, but we
have no measurement yet. Memory should remain small for in-flight proofs;
durable history increases storage in proportion to accepted transactions, so
retention and compaction must be specified. Reliability becomes deliberately
fail-closed: observer disagreement or proof unavailability keeps work pending
instead of advancing false state. That may reduce availability, but it makes
the failure explicit and recoverable.

Migration can be reversible until the journal begins consuming the new proof
profile. We can run the gateway in shadow mode, compare its result with current
observers, and write no state. After cutover, the old direct RPC-to-terminal
paths must be removed in the same clean change. Rollback then requires a Git
rollback plus a journal compatibility decision for any new evidence metadata;
we should avoid a permanent dual runtime.

[Option 2 after: one typed proof boundary](../diagrams/proof-backed-chain-evidence-typed-chain-evidence-gateway-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Control owner | Exact, recovery, wallet, vault, and journal interpret evidence | Gateway alone mints proof levels | Prevents semantic drift across consumers | New high-assurance internal module |
| Backend result | Raw RPC tuples and strings | Branded proof, provisional, negative-set, or unknown | Invalid promotions become unrepresentable | Adapter integration work |
| Finality policy | Merchant and callers can choose thresholds | Operator floor enforced once, Merchant request can only strengthen | Prevents mempool capacity release and provisional commits | Some current flows remain pending longer |
| History | Reconstructed from current views | Accepted proof retained by transaction and outpoint | Preserves post-spend attribution | Retention, index, and migration work |
| Journal contract | Opaque evidence digest and local labels | Proof profile, verifier/source identity, facts, finality, digest | Makes restart decisions auditable | Schema and integrity-check changes |

### Option 3: Trusted local evidence plane

This option keeps the Option 2 gateway contract but supplies it from an
operator-controlled Kaspa node and an accepted-transaction history index on an
authenticated local channel. Public or configured RPCs can still contribute
telemetry, submission, and comparison, but cannot alone mint proof consumed by
durable state. The history index retains transaction and winner attribution
for the recovery horizon even after current outputs are spent.

The strongest case is authenticity and post-spend availability. Sompi no longer
asks a remote selected peer to attest its own honesty, and operationally we can
define exactly which node state, pruning policy, and retention window support
Settlement and recovery. This also creates a clean incident boundary: when the
local evidence plane is unhealthy or behind, the gateway reports unavailable
rather than silently accepting a public-node claim.

The costs are substantial and arise from real mechanisms, not abstract
complexity. A Kaspa node and history index require disk, memory, synchronization
time, monitoring, backup/rebuild procedures, version pinning, and availability
planning. Local query latency may improve after sync, but initial sync and
index maintenance add operational delay. The evidence plane becomes a trusted
component whose corruption or stale state can deny service; independent
cross-checks remain valuable. Process isolation limits blast radius, but it
does not remove the need for gateway validation and journal invariants.

We could introduce this after Option 2 because consumers would not change
again—only the proof backend and its accepted profile would. Rollback to a
witness backend is possible if its profile is still permitted, but the runtime
must fail closed rather than silently downgrade. I would choose this option
immediately only if the team is ready to operate the node or if the gateway's
proof API cannot otherwise authenticate inclusion.

[Option 3 after: local node and retained accepted history](../diagrams/proof-backed-chain-evidence-trusted-local-evidence-plane-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Trust root | Selected remote RPC self-attests | Operator-controlled consensus node feeds gateway | Removes ordinary single-remote-oracle dependence | Node operations and local trust hardening |
| History | Current UTXO and mempool | Retained accepted-transaction index | Closes spent-output attribution gaps within retention | Persistent disk and rebuild time |
| Failure containment | Remote ambiguity enters each consumer | Evidence plane health gates all proof | Coherent fail-closed behavior | Shared dependency can reduce availability |
| Backend changes | Consumers depend on RPC shapes | Consumers depend on stable gateway types | Future backend changes stay local | Gateway plus service compatibility testing |

## Comparison

The table summarizes expected direction; none of the performance or resource
effects has been measured.

| Dimension | Option 1: local guards | Option 2: typed gateway | Option 3: local evidence plane |
| --- | --- | --- | --- |
| Security | Improves known call sites; single-RPC authenticity and future drift remain | Strong structural improvement; authenticity depends on admitted proof backend | Strongest authenticity and history under an operator-controlled node; local plane becomes trusted |
| Performance | Mostly neutral; history checks add calls | Regresses unless proof queries are parallel/cached; bounded extra serialization | Local steady-state queries may improve, but sync/index work is significant |
| Memory | Neutral to small temporary values | Small in-flight proof/cache growth | Regresses through node and index memory |
| Reliability | Fixes terminal-state bugs but retains backend ambiguity | Improves coherence; proof unavailability deliberately reduces availability | Improves evidence availability after sync, but adds a critical local service |
| Operability | Lowest change, dispersed alerts | New proof metrics, source identity, disagreement and retention telemetry | Highest burden: node lifecycle, disk, sync, index, alerting and recovery |
| Migration | Focused patches, easiest rollback | Medium schema and adapter cutover; shadow mode available | Foundational deployment after gateway; backend rollback must not downgrade silently |
| Developer ergonomics | Familiar but easy to drift | Proof-level types make correct use easier and unsafe promotion difficult | Consumer ergonomics match Option 2; backend development is specialized |

Option 1 is proportionate for urgent stabilization, but it leaves the exact
condition that produced the cluster. Option 2 gives us the best security-to-
delivery ratio now. Option 3 is not “more architecture” for its own sake; it is
the answer when the accepted threat model truly includes a malicious selected
RPC and durable proof must remain available after spend or pruning.

## Recommendation

I recommend Option 2 for the current cutover, preceded by the tactical controls
from Option 1 and with no permanent dual runtime. The gateway should initially
support only one explicit proof profile. If that profile relies on independent
witnesses rather than local consensus verification, name the limitation in the
evidence and keep mainnet disabled.

Option 1 should win only if delivery time prevents a gateway change and the
team accepts recurrence risk for a short testnet period. Option 3 should win
before the current recommendation if a verified proof cannot be obtained
without a local node, or when public/mainnet availability and economic impact
justify its operational cost.

## Evidence Coverage And Residual Risk

Every structural option still requires the direct tactical correction while
migration is in progress. “Addresses” below means the option contains a design
control for the finding; it does not mean the current source is fixed.

| Evidence | Option 1 | Option 2 | Option 3 | Tactical fix still required |
| --- | --- | --- | --- | --- |
| `CAN-003` — Single-RPC false Settlement | Mitigates; authenticity remains | Addresses when gateway requires proof/witness | Addresses with local consensus-backed proof | Yes |
| `CAN-004` — Forged recovery finality | Mitigates; same RPC still supplies facts | Addresses | Addresses | Yes |
| `CAN-006` — RPC error treated as absence | Addresses with typed error handling | Addresses by construction | Addresses by construction | Yes |
| `CAN-016` — Mempool ID spoof | Addresses with local hashing | Addresses by canonical identity | Addresses by canonical identity | Yes |
| `CAN-017` — Spent payment evidence loss | Mitigates if current backend retains history | Addresses with durable historical proof | Addresses with retained local history | Yes |
| `CAN-018` — Single-snapshot recovery race | Mitigates by keeping negative evidence non-authorizing | Addresses with negative observation sets | Addresses with local proof/history | Yes |
| `CAN-020` — Mempool exact terminalization | Addresses with finality/state fix | Addresses through proof-level state machine | Addresses through proof-level state machine | Yes |
| `CAN-023` — Provisional wallet completion | Addresses with accepted floor | Addresses | Addresses | Yes |
| `CAN-024` — Provisional vault continuation | Addresses with accepted floor | Addresses | Addresses | Yes |
| `CAN-025` — Provisional vault deposit | Addresses with accepted floor | Addresses | Addresses | Yes |
| `CAN-026` — Provisional Purchase staging | Addresses with accepted floor | Addresses | Addresses | Yes |
| `CAN-030` — Merchant mempool capacity release | Addresses with operator floor and display | Addresses with central policy | Addresses with central policy | Yes |
| `CAN-033` — Spent winner evidence loss | Mitigates if history is available | Addresses with retained winner proof | Addresses with local accepted history | Yes |

Residual risk remains under every option: consensus reorg semantics and the
chosen finality definition must be specified; a locally controlled node can be
stale or compromised; witness independence can be overstated; retained proof
storage can be corrupted; and manual recovery must remain available when no
safe proof exists. Merchant evidence continues to authenticate Merchant
statements, not chain truth.

## Migration And Rollout

- **Tactical stabilization:** land strict RPC error classification, canonical
  mempool hashing, coherent DAA checks, accepted-finality floors, nonterminal
  provisional states, operator minimum finality, and targeted history queries.
  Re-run the thirteen finding PoCs before proceeding.
- **Gateway shadowing:** implement the proof vocabulary and backend, invoke it
  read-only beside the old observers, and record comparison metrics without
  changing journal state. Define an explicit decision threshold for mismatch
  and proof unavailability.
- **Journal preparation:** add versioned proof profile, verifier/source
  identity, canonical facts, finality, and evidence digest to the durable
  observation contract. Verify crash and migration behavior on disposable
  copies.
- **Consumer cutover:** move exact Settlement, staging recovery, direct wallet,
  vault deposit/send, and Purchase staging to the gateway. Remove their direct
  terminal use of RPC tuples in the same cutover once conformance passes.
- **Evidence-plane gate:** if Option 3 is selected, deploy and synchronize the
  local node/history index, exercise rebuild and stale-node behavior, then
  change only the gateway's permitted proof profile. Keep mainnet disabled
  until this gate and independent review pass.
- **Rollback:** before journal cutover, disable shadow calls. After cutover,
  rollback only to a release that understands the new proof metadata and does
  not silently reinterpret it; never downgrade an existing proof profile to a
  weaker source.

## Validation Plan

- Run every original PoC and require that no false Settlement, capacity
  release, terminal recovery, direct-operation completion, vault commit, or
  staging evidence is created from the reproduced provisional or fabricated
  source.
- Unit-test that only the gateway can create proof-level values and that JSON,
  RPC, or adapter data cannot be cast or deserialized directly into them.
- Exercise malicious primary, unavailable witness, colluding witnesses,
  duplicate endpoints, DAA disagreement, future DAA, reorg, pruning, history
  loss, mempool eviction, spent outputs, and restart after every state/effect
  boundary.
- Benchmark the current observer against Option 2 using representative exact
  Settlement and staging-recovery workloads. Measure p50/p95/p99 proof latency,
  calls per proof, timeout rate, retained proof bytes per Purchase, cache size,
  and process RSS. Set thresholds before rollout rather than inventing them in
  this proposal.
- For Option 3, measure node sync/rebuild time, disk growth, query latency,
  index lag, and behavior under node restart, corruption, and stale-tip
  conditions. Prove the gateway fails closed while the evidence plane is
  unhealthy.
- Verify that AP2 artifacts and authority credentials remain outside the
  gateway, and that Kaspa-x402 wire/SDK objects do not enter canonical Purchase
  state.

## Implementation Work Packages

- Define the chain-evidence vocabulary, proof profiles, finality policy, and
  backend contract in Sompi domain/infrastructure terms.
- Implement canonical transaction identity, typed errors, source identity,
  witness/proof verification, and history retention in the gateway.
- Add journal schema, integrity, migration, and recovery support for durable
  proof metadata and evidence attachments.
- Integrate the Kaspa-x402 exact adapter without moving x402 mechanics into the
  gateway or AP2 adapter.
- Integrate staging recovery, direct wallet, vault deposit/send, and Purchase
  staging, then delete replaced direct terminal-observation paths.
- Add metrics for proof source, disagreement, unknown/pending duration,
  history misses, finality, and proof-profile downgrade attempts without
  logging sensitive payment material.
- Build the full fault-injection, PoC regression, performance, and rollout
  evidence package before enabling a stronger deployment profile.

## Open Questions

- Which concrete Kaspa proof or accepted-transaction interface can the current
  pinned stack verify locally, and what does it prove under DAG finality and
  reorg semantics?
- Is an independently operated witness profile acceptable for Testnet-10, and
  what configuration establishes meaningful independence?
- What accepted/confirmed depth is required for each state transition, and may
  any direct or recovery operation remain merely observed without consuming
  capacity?
- How long must accepted transaction and winner evidence be retained relative
  to rolling policy windows, operator recovery, and dispute evidence?
- What availability target justifies Option 3's node and index cost, and who
  owns its on-call, backup, upgrade, and rebuild procedures?
