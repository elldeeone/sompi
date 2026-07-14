# Security Hardening Proposal: Bounded, cancellable operation lifecycles

## Decision

Adopt explicit admission leases for retained work, implemented independently
inside each existing trust boundary. Choose Option 2: the Authority owns
in-memory connection and prompt leases with cancellation; the MCP/Purchase
side owns transactional Purchase/evidence capacity; and the direct-Treasury
module owns durable preparation and terminal-release semantics. Do not create a
shared broker or let the MCP process control Authority availability policy.

## Executive Recommendation

We have two proportionate choices. **Option 1, Local limits and
terminalization**, adds the concrete socket cap, absolute deadline, prompt
queue bound, cancellation signal, evidence quota, prevalidation ordering, and
Treasury terminal failure that each finding needs. **Option 2, Per-boundary
admission leases**, keeps those fixes but gives every retained resource one
common lifecycle: admission before allocation, explicit owner and budget,
absolute expiry or cancellation, one terminal outcome, and release on every
exit.

I recommend Option 2. The findings span two processes and several resource
types, so a shared service would weaken isolation and add failure coupling.
What we need is shared semantics with separate enforcement: Authority permits
never leave the Authority process, while durable disk and Treasury permits are
transactional records in the Purchase Journal. Option 1 is valuable immediate
work, but without the lifecycle contract a future resource can again be bounded
per item while remaining unbounded in aggregate or uncancellable after handoff.

## Evidence

I inspected the Unix transport, authority service and terminal prompt,
Purchase intake and evidence store, direct-Treasury module, journal schema, and
capacity queries. Four findings share one retention failure.

| Evidence | Finding | What it establishes |
| --- | --- | --- |
| `CAN-009` | Pre-authentication socket exhaustion | `src/authority/transport.ts:60-75,150-190` retains every incomplete socket in an unbounded set under a resettable inactivity timeout before authentication. |
| `CAN-013` | Uncancellable authority prompt queue | Concurrent authenticated handlers reach an unbounded `promptTail`; socket close, request expiry, replay-lease loss, and shutdown cannot abort queued or active terminal input. |
| `CAN-027` | Pre-validation durable storage exhaustion | `PurchaseCoordinator.purchase` creates a Purchase and stores up to 1 MiB of immutable body evidence before reversible egress validation, with no aggregate byte/count quota. |
| `CAN-031` | Direct-Treasury preparation lockout | The module claims the single unresolved operation slot and policy capacity before SDK preparation; a deterministic pre-submission error has no `intent -> failed_terminal` release path. |

**Observed:** each subsystem has useful local controls—a frame-size limit,
inactivity timeout, replay lease, per-call body cap, content-addressing,
SQLite intent, and single-operation serialization. None of those controls owns
the whole lifetime from admission through cancellation or terminal release.

**Inferred:** the architecture correctly insists on durable intent before an
irreversible effect, but some code treats “durable before effect” as “retain
before reversible validation” or “never release after a pre-effect failure.”
The missing abstraction is not a generic job queue; it is a falsifiable
lifetime contract for every scarce resource acquired on behalf of untrusted
work.

## Current Design And Failure Mode

At the Authority socket, allocation begins before identity exists. `accept`
adds a socket, listeners, timer, and partial-frame buffer to process state. The
only timeout is inactivity-based, so a drip feed renews it. The 150-second
human-decision timeout is therefore also serving unauthenticated framing, and
there is no aggregate connection permit to reserve space for legitimate work.

After authentication, the opposite problem appears. The transport starts
handlers concurrently, the service starts a replay-lease heartbeat, and the
terminal provider serializes prompts through a Promise tail. The code checks
expiry and heartbeat failure after the human decision, which protects signing
integrity, but it cannot make the pending prompt return. The client connection
and service know that work is dead; the UI queue does not.

Purchase intake retains a different resource permanently. A unique body is
written, fsynced, linked to a new Purchase, and made immutable before egress
policy can reject the destination. Per-call size and deduplication bound one
contribution but not aggregate unique bytes, links, or Purchase rows. There is
no capacity reservation that makes concurrent writers compete for a finite
budget.

Direct Treasury holds a logical resource rather than memory or disk. The
journal intentionally allows only one unresolved movement and reserves policy
capacity before any external effect. That is a sound ordering. The failure is
that SDK-specific permanent input validation occurs after the claim, while the
state machine allows `intent` to move only to `prepared`. An exception before
signing is safe to terminalize, yet the model cannot express that result.

Across all four paths, the acquired resource outlives the event that should
release it. Limits added at only one layer will help, but they will not ensure
the next handoff carries the same owner, deadline, cancellation, and release
obligation.

## Desired Invariants

- Every scarce resource acquired for untrusted work has an aggregate budget,
  an owner, an absolute lifetime, a terminal outcome, and an idempotent release
  path defined before allocation.
- Pre-authentication Authority connections consume a small fixed permit and
  face a short non-renewable frame deadline. The human-decision timeout begins
  only after a complete authenticated request is admitted.
- Every authenticated authority decision carries one `AbortSignal` across
  transport, service, AP2 provider, bounded prompt queue, and active terminal
  question. Disconnect, expiry, replay-lease loss, shutdown, and decision
  deadline remove the work and release its permit.
- Reversible local validation and capacity admission happen before immutable
  Purchase/evidence creation. Aggregate unique bytes, links, and Purchase count
  are reserved transactionally across concurrent processes.
- Once direct-Treasury intent is durable, a proven permanent failure before
  signing or submission has an auditable `failed_terminal` transition that
  atomically releases the global slot and policy capacity.
- Transient or ambiguous errors after prepared bytes may exist remain bound to
  the original identity and never release capacity merely for availability.
- Authority budgets remain inside the isolated Authority security context;
  MCP/Purchase budgets and Treasury lifecycle state remain in the Purchase
  Journal. No lower-trust process owns higher-trust admission.

## Constraints And Non-Goals

The Trusted Authority remains a separate process and security context. This
proposal does not introduce a cross-process scheduler, move authority
credentials, or let MCP cancel a decision except through a narrowly bound
request lifetime. It does not weaken durable-before-effect ordering, evidence
immutability for accepted Purchases, or single-writer Treasury coordination.

We are not defining per-user fairness because the inherited stdio surface has
no strong multi-user identity. Global service budgets are required even if
per-session throttles are added. We are also not promising uninterrupted
approval under a hostile local IPC group member; fixed budgets, overload
response, and supervision bound the damage, while strong fairness would need
a separate authenticated identity design. No target socket, prompt, disk,
latency, or operation-throughput budgets were supplied.

## Before Architecture

Today, different resources are retained through unrelated mechanisms and do
not share a complete release contract:

[Before: retained work without one lifecycle](../diagrams/bounded-operation-lifecycles-before.mmd)

The important path is from untrusted work to descriptors, timers, disk,
capacity, and the one-operation slot. Legitimate work encounters those retained
resources after the system has lost the ability—or the state transition—to
cancel and reclaim them.

## Options

### Option 1: Local limits and terminalization

This option implements each finding's direct remediation in place. The Unix
transport receives a global pre-authentication semaphore and short absolute
frame timer. Authenticated handler and prompt counts are capped, `AbortSignal`
flows into `readline.question`, and queued items are removed on disconnect,
expiry, lease loss, deadline, or shutdown. Purchase egress validation moves
before durable creation, and the journal/evidence store enforce aggregate byte
and count quotas. Direct Treasury validates SDK-specific immutable inputs before
claim and adds a typed `intent -> failed_terminal` transition for permanent
pre-submission preparation failures.

The strongest case is focus. These changes are understandable, independently
testable, and do not require a general framework. Performance costs are small:
permit counters and cancellation controllers on Authority work, a cheap egress
check before fsync, transactional quota accounting on evidence writes, and
side-effect-free SDK validation before a Treasury claim. Memory becomes
bounded rather than lower; the quota metadata adds modest durable rows.

Reliability improves because stale work releases resources, but limits create
new explicit overload responses. If configured too low, legitimate bursts will
see `busy` or quota errors. If cancellation is not propagated through every
handoff, a local counter can say capacity was released while a prompt or write
still runs. Operability therefore needs per-resource gauges, rejection counts,
oldest-item age, cancellation reasons, and repair guidance.

Migration and rollback are straightforward for each subsystem. The Treasury
transition and evidence quota change the journal contract and need migration
tests. Reverting them after new terminal/quota rows exist is not safe unless the
older release understands those rows; rollback should target a compatible
schema, not discard state.

[Option 1 after: focused limits and terminal paths](../diagrams/bounded-operation-lifecycles-local-limits-and-terminalization-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Pre-auth sockets | Unbounded set, resettable inactivity timeout | Fixed permits and absolute frame deadline | Bounds descriptors and partial-frame state | Legitimate overload is rejected |
| Human decisions | Unbounded Promise tail without cancellation | Bounded queue and end-to-end abort | Dead work cannot block later prompts indefinitely | Cancellation wiring across layers |
| Purchase bodies | Immutable before egress, no aggregate quota | Reversible validation first and transactional bytes/count quota | Prevents deterministic prevalidation disk growth | Quota policy and storage accounting |
| Treasury intent | Permanent preparation error retains slot/capacity | Prevalidate or atomically terminalize before any effect | Releases safe pre-effect failures without blind retry | Typed failure classification and schema change |

### Option 2: Per-boundary admission leases

This option includes every local control above, then makes their lifecycle an
owned contract. A lease is not necessarily one shared class or store. It is a
small state model—offered, admitted, active, and one of completed, cancelled,
expired, or failed terminal—with a resource quantity, owner, absolute deadline,
cancellation source, and exactly-once release. Each trust boundary implements
that contract using the storage appropriate to its authority.

Inside `sompi-authority`, connection admission stays in memory and is controlled
only by the Authority process. A pre-auth lease owns one socket until a complete
frame or short deadline. Authentication exchanges it for an in-flight decision
lease; the same lifetime signal follows service verification, replay heartbeat,
prompt queue, and terminal question. The MCP process can cause its own bound
request to end by disconnecting, but cannot mint permits, cancel another
request, or influence Authority-wide limits.

Inside the Purchase module, admission is transactional. Before a unique body
is fsynced, the journal reserves body bytes, metadata allowance, and Purchase
count against a configured global budget. Successful evidence/link creation
commits the lease; a rejected destination or failed write releases it. Accepted
evidence remains immutable, while failed prevalidation work retains at most a
small audit record or a separately bounded retention tier. This preserves the
durability invariant without granting untrusted input unlimited durable state.

Direct Treasury uses the existing journal as a durable lease. The intent row
already records owner, idempotency identity, policy snapshot, and capacity. We
would complete the model by separating permanent pre-submission failure from
transient preparation failure and ambiguous post-preparation state. The adapter
may perform side-effect-free request validation before claim; after claim, only
a typed failure proven to occur before signing/submission may terminalize and
release. Every other error retains the original identity for recovery.

The advantage is reviewability and future safety. At each handoff we can ask
which lease owns the retained object and which event releases it. We can fault
inject each edge and assert aggregate usage returns to baseline. The main risk
is abstraction overreach: sockets, prompts, disk, and Treasury state are not
interchangeable jobs. We should share vocabulary, test helpers, and invariants,
not one global scheduler or storage table.

Performance adds constant-time counter/lease operations and, for durable
capacity, an SQLite transaction already close to the write path. Concurrent
evidence admission may serialize briefly on the budget row; the benchmark must
measure fsync-heavy workloads because that lock duration could affect p99
latency. Memory is bounded by configured Authority counts. Reliability improves
through deterministic reclamation, but a leaked or double-released lease could
either deny work or oversubscribe capacity, so exactly-once tests and integrity
checks are essential.

Rollout can proceed boundary by boundary while retaining the same lifecycle
tests. There is no runtime dependency between Authority permits and Purchase
Journal leases. Rollback follows each boundary's state: in-memory Authority
leases disappear on restart; durable quota and Treasury rows require a
schema-compatible release or an explicit migration back. The clean cutover
should remove ad hoc counters once the lease owner is active rather than keep
two sources of truth.

[Option 2 after: separate owners, one lifecycle contract](../diagrams/bounded-operation-lifecycles-per-boundary-admission-leases-after.mmd)

| Change | Before | After | Security consequence | Cost |
| --- | --- | --- | --- | --- |
| Ownership | Resource lifetime implicit in callbacks and states | Every retained object names one boundary-owned lease | Makes orphaned work detectable and testable | New lifecycle vocabulary and audits |
| Cancellation | Layer-local timeout or post-await check | One signal follows the request through all Authority handoffs | Releases queued/active dead work without signing | Careful signal composition and race handling |
| Aggregate capacity | Per-item limits and non-atomic directory state | Authority counters and transactional Journal reservations | Prevents concurrent oversubscription | Configuration and contention at budget rows |
| Terminal release | Some error paths throw outside state machine | Typed outcome atomically closes and releases | Preserves durable intent while recovering safe pre-effect resources | Failure taxonomy and integrity rules |
| Isolation | No shared control, but inconsistent semantics | Shared invariant, separate Authority and Purchase/Treasury enforcement | Preserves credential boundary and limits blast radius | Similar helpers may have separate implementations |

## Comparison

The local option can close every reproduced path. The structural option earns
its cost by making recurrence and aggregate audit easier, not by adding a new
service.

| Dimension | Option 1: local limits | Option 2: admission leases |
| --- | --- | --- |
| Security | Addresses the four known paths; future handoffs can omit a limit or release | Addresses known paths and makes ownership, budget, cancellation, and release explicit at every handoff |
| Performance | Mostly neutral; transactional quota is the main added contention | Similar constant-time cost; lifecycle bookkeeping and integrity checks add small overhead |
| Memory | Bounded by local caps | Bounded by lease budgets with auditable aggregate usage |
| Reliability | Improves reclamation; inconsistent counters can still drift | Stronger deterministic recovery; lease bugs become high-value failure points |
| Operability | Several unrelated limits and metrics | Common names for admitted, active, expired, cancelled, released, and oldest age; separate dashboards per process |
| Migration | Focused changes and simpler source review | Medium refactor at handoffs plus durable schema work; can roll out per boundary |
| Developer ergonomics | Familiar local code, but security reasoning repeats | Reviewers can require one lifecycle checklist; avoids a universal scheduler |

Option 1 is not a throwaway baseline. Its controls are the concrete mechanics
Option 2 needs. The decision is whether they remain scattered or are held to a
shared contract with boundary-specific storage.

## Recommendation

I recommend Option 2, implemented narrowly. Begin with the direct fixes, then
name and test the lease lifecycle at each boundary. Do not build a central
admission service, reuse Purchase Journal state inside the Authority, or create
a generic queue API for every operation. Those changes would trade local
resource bugs for an unnecessary cross-boundary dependency.

Option 1 should win if the team cannot afford the handoff refactor in the
current testnet cutover, provided every direct fix ships with aggregate and
release tests. I would revisit the structural choice as soon as another
retained-resource path is added or local counters begin duplicating lifecycle
logic.

## Evidence Coverage And Residual Risk

| Evidence | Option 1 | Option 2 | Tactical fix still required |
| --- | --- | --- | --- |
| `CAN-009` — Pre-auth socket exhaustion | Addresses with cap and absolute frame deadline | Addresses with Authority-owned pre-auth admission lease | Yes |
| `CAN-013` — Uncancellable prompt queue | Addresses with bounded queue and propagated abort | Addresses with authenticated decision lease through prompt completion | Yes |
| `CAN-027` — Pre-validation storage exhaustion | Addresses with ordering and transactional aggregate quota | Addresses with Purchase/evidence capacity lease and bounded failed retention | Yes |
| `CAN-031` — Treasury preparation lockout | Addresses with SDK prevalidation and terminal preparation failure | Addresses with durable Treasury lease outcome and atomic release | Yes |

Residual risk remains from a hostile client that continually wins available
permits, operator inattention at a valid prompt, incorrectly chosen quotas,
disk consumption by accepted legitimate Purchases, ENOSPC outside the reserved
volume, and misclassified Treasury errors. A permanent failure must never be
declared after transaction bytes may have been signed or submitted merely to
free capacity. Cancellation must never convert an expired or disconnected
request into an approval.

## Migration And Rollout

- **Direct containment:** add the pre-auth connection cap and absolute deadline,
  bounded prompt/in-flight limits, end-to-end abort, egress-before-durability,
  aggregate evidence quota, SDK request validation, and safe terminal
  preparation failure.
- **Lifecycle contract:** document the admitted/active/terminal states,
  resource quantities, owner, deadlines, cancellation events, and exactly-once
  release assertions for Authority, Purchase/evidence, and Treasury.
- **Authority cutover:** replace the unbounded socket set/prompt tail behavior
  with boundary-owned permits and cancellable serial scheduling. Keep signing
  and keys unchanged. Measure overload while a legitimate request is attempted.
- **Durable admission:** add quota reservation and release transactions to the
  journal/evidence write path, then define bounded failed-request audit
  retention. Test multiple processes and crash boundaries before enabling it.
- **Treasury completion:** add adapter prevalidation and the restricted
  `intent -> failed_terminal` transition, capacity release, integrity rules,
  status projection, and operator runbook.
- **Remove duplicate paths:** once each owner is active, delete superseded
  counters, mtime/directory-size approximations, or exception-only release
  behavior. Do not retain permanent dual lifecycle implementations.
- **Rollback:** Authority in-memory changes can roll back by restart to a safe
  capped release. Durable rollback must use a schema-compatible version that
  preserves quota reservations and terminal Treasury history.

## Validation Plan

- Re-run all four finding PoCs and require bounded sockets/prompts/storage and a
  released direct-Treasury slot without weakening authorization or
  durable-before-effect behavior.
- Open more incomplete sockets than the limit, drip bytes before the inactivity
  timeout, and prove the absolute deadline closes them while a legitimate
  authenticated request can still progress. Exercise close, error, malformed
  frame, timeout, and shutdown for permit leaks.
- Hold one terminal question, queue another, then trigger client disconnect,
  request expiry, replay-lease loss, service shutdown, and explicit decision
  deadline. The first request must not sign or persist; the next legitimate
  prompt must render; timers and permits must return to baseline.
- Run concurrent unique near-limit Purchase bodies across multiple processes.
  Verify atomic quota enforcement, correct deduplication accounting, no state
  for denied egress, bounded failed-request audit, restart consistency, and
  release after write/fsync/SQLite/ENOSPC faults.
- Exercise SDK-invalid addresses, deterministic insufficient-shape failures,
  transient node/UTXO failures, and ambiguous post-preparation submission. Only
  proven pre-submission permanent failures may release the direct-Treasury slot.
- Benchmark hostile and legitimate mixed workloads. Measure descriptor count,
  heap/RSS, prompt wait age, event-loop delay, Purchase admission latency,
  SQLite lock time, fsync throughput, quota utilization, and Treasury recovery
  time. Set caps and alert thresholds from the deployment budget.
- Add invariant tests that every admission increments exactly once, every
  terminal path releases exactly once, no active work lacks an owner, and no
  counter becomes negative or exceeds its configured capacity.

## Implementation Work Packages

- Define the boundary-neutral lifecycle vocabulary and a review checklist,
  without a shared runtime scheduler or store.
- Implement Authority pre-auth and authenticated permits, absolute deadlines,
  cancellation propagation, bounded serial prompt scheduling, overload errors,
  metrics, and shutdown behavior.
- Move reversible Purchase admission ahead of durable creation; implement
  transactional evidence/Purchase quotas, failed-request retention, accounting,
  and crash-safe release.
- Add side-effect-free Treasury adapter validation, typed permanent preparation
  errors, `intent -> failed_terminal`, atomic transition/capacity release, and
  recovery/status support.
- Build cross-boundary fault-injection helpers and exactly-once lease assertions
  for tests, while keeping production enforcement separate per process.
- Update configuration, metrics, alerts, operator recovery, schema migration,
  and rollback documentation before enabling limits in a real deployment.

## Open Questions

- What are the initial limits for pre-auth sockets, authenticated decisions,
  queued prompts, human-decision duration, Purchase count, evidence bytes, and
  failed-request retention?
- Must a legitimate Authority request make progress under continuous hostile
  IPC-group churn, and if so what authenticated identity or reserved-capacity
  rule establishes fairness?
- Should a denied prevalidation request retain only digest/length/reason, or is
  there a product requirement for full body evidence under a finite retention
  tier?
- Which SDK/preparation failures are permanently classifiable before signing,
  and how will adapters prove they caused no hidden side effect?
- Which volume and database metrics are available to enforce quotas safely
  across multiple processes and WAL growth?
