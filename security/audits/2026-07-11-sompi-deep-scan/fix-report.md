# Security remediation report

Status: **verified — Phase 2D review remediation ready for independent re-review**

Target baseline: `4ebb82d4f82bac46ae3addd112c4752f29630a8a`

Independent review target reopened by this closeout: `082def29636fe0a6802240ee358f867c34667b4c`.

## Patch contract

The validated findings share three broken security controls:

1. Agent/runtime-controlled configuration can select recovery authority or
   loosen policy/transport trust.
2. Raw, provisional, missing, or single-source chain observations can become
   terminal Purchase/Treasury facts without one authenticated evidence and
   finality policy.
3. Authority, Purchase/evidence, and Treasury work can retain scarce resources
   without bounded admission and a safe cancellation/terminalization path.

The clean-cutover fix preserves the stable Purchase model, the isolated
human-present AP2 approval ceremony, Kaspa-x402 alpha.6 exact transaction
mechanics, valid SompiVault and KIP-10 covenant transitions, durable
idempotency/recovery, and the Testnet-10-only scope. It intentionally removes
development-only configuration/state compatibility.

## Selected strategy

- Operator Provisioning module with an immutable manifest and distinct OS
  installer/runtime capabilities.
- Chain Evidence module with two-witness Testnet-10 acceptance, retained
  history, mechanism-specific continuation evidence, and explicit finality
  floors.
- Per-owning-module Admission Leases with cancellation entering Reconciliation
  after any possible external effect.

## Milestones and verification

Results, exact commands, changed files, regression tests, original-PoC closure,
preserved legitimate behavior, and residual risk will be appended after each
milestone. No finding is marked fixed until all ordered verification gates pass.

### Milestone 1: Operator Provisioning

Status: **verified**

Implemented one canonical `sompi-operator-manifest-v1`, descriptor-stable
runtime loading, distinct production OS-principal checks, a clean Journal v5
manifest binding, and the short-lived `sompi-operator` preview/provision/install/
status ceremony. Candidate installation binds the generated Agent x-only key,
operator recovery x-only key, covenant template, zero-state address, vault cap/
window, and static configuration digest before activation. Policy, HTTPS
Merchant egress, receipt issuers, Chain Evidence sources/floors, and admission
budgets are immutable manifest projections.

Removed MCP `vault_create`, MCP owner-key generation, policy-file loading/hot
reload, production HTTP enablement, and all environment overrides for manifest
facts. Runtime refuses same-principal production manifests, old Journal schemas,
a different manifest identity, and any static vault drift before wallet/RPC use.

Findings closed by this milestone:

- `vault-recovery-authority-hijack`
- `invalid-vault-recovery-key`
- `policy-file-provenance-bypass`
- `cleartext-merchant-authorization`

Ordered verification:

1. Regression tests first reproduced the missing MCP tool, real curve-point
   validation, immutable policy, HTTPS-only egress, filesystem substitution,
   candidate digest, and vault-static binding boundaries.
2. Focused operator/config/Journal/runtime suites passed.
3. Each original PoC was rerun: recovery assignment reported
   `vulnerable:false`; invalid key exited 2 after rejection before state; policy
   replacement reported `reproduced:false`; HTTP authorization failed with
   `protocol_denied`.
4. `npm test` passed 347/347 runnable tests with one root-only ownership test
   skipped, plus the complete offline smoke.
5. `npm pack --json` and `node scripts/verify-packed-artifact.mjs` passed for a
   165-entry artifact including `sompi-operator`.

Preserved behavior: stable Purchase/MCP UX, AP2 Authority isolation, alpha.6
exact mechanics, valid vault creation/deposit/send/recovery paths, durable
Treasury operations, and testnet-10-only scope all remain covered by the full
suite. Residual chain-evidence and lifecycle findings remain open for the next
two milestones.

### Milestone 2: Chain Evidence and finality

Status: **verified**

Implemented one Sompi-owned Chain Evidence module with typed provisional,
accepted, depth-confirmed, historical, absent, unknown, and unavailable states.
The Testnet-10 accepted profile requires exact transaction/input/output and
accepting-block agreement between the Operator Manifest wRPC node and the
independent HTTPS accepted-history witness. Evidence is immutable,
content-bound, and tied to the installed manifest in Journal v6 before a caller
can perform its privileged state transition. Merchant protocol finality and the
stronger effective operator floor remain separate; the effective floor is
included in the Authority display, authenticated request, and signed AP2
evidence.

Exact Settlement, direct wallet operations, vault deposit/send/continuation,
Purchase staging, recovery-winner selection, and policy release use the central
module. Mempool/current single-node presence is provisional only. HTTPS
redirects, generic RPC errors, pruning, partial current output views, and
contradiction fail closed. Absence requires two independent source observations
and a second corroboration after the propagation interval. Accepted evidence
is retained and checked against the exact output/mechanism digest before reuse.

The obsolete `RpcChainObservationSource`, `RpcStagingRecoveryRaceSource`, raw
wallet observation, and raw vault observe/reconcile paths were deleted. Vault
state commits now require accepted Chain Evidence metadata. Kaspa-x402 alpha.6,
AP2 wire objects, the sibling Kaspa-x402 repository, and valid SompiVault/KIP-10
transaction mechanics were not modified.

Findings closed by this milestone:

- `untrusted-rpc-false-settlement`
- `untrusted-rpc-forged-recovery-finality`
- `rpc-mempool-id-spoof`
- `rpc-error-as-absence`
- `single-rpc-absence-recovery-race`
- `spent-payment-evidence-loss`
- `spent-staging-winner-evidence-loss`
- `mempool-exact-terminal-recovery`
- `merchant-mempool-finality-capacity-release`
- `provisional-wallet-send-finality`
- `provisional-vault-deposit-finality`
- `provisional-vault-send-continuation`
- `provisional-purchase-staging-finality`

Ordered verification:

1. Focused regression tests cover two-source anchor agreement, local
   transaction-ID derivation, live-UTXO protection against a lagging witness,
   the two-observation absence interval, finality floors, retained-history fact
   binding, spent staging winners, accepted-only vault commits, and Journal v6
   restart retention.
2. Every original PoC was rerun against the built tree. All thirteen exited
   non-zero: obsolete observer/low-level APIs are absent, the staging adapter
   requires Chain Evidence, or the PoC's exact vulnerable-revision hash guard
   rejected the changed target. The corresponding behavior is directly covered
   by the regression tests above rather than relying on hash-guard failure.
3. `npm test` passed 353 runnable tests with one root-only ownership test
   skipped, followed by the complete offline smoke.
4. `npm pack --json`, then `node scripts/verify-packed-artifact.mjs
   elldeeone-sompi-0.8.0.tgz`, passed for a 171-entry package.
5. A read-only live invocation of the built Chain Evidence module against
   `ws://10.0.3.26:17210/` and `https://api-tn10.kaspa.org/` corroborated
   transaction `e0ed1117bb95df5db090b4a304280fbf8b4176719a9eb55cfc4b71c92c812b16`
   as depth-confirmed with exact containing and accepting-block anchors. No
   signing, submission, wallet funding, or blockchain mutation occurred. The
   durable result is in `evidence/phase2c-live-readonly.json`.

Preserved behavior: the local AP2 + alpha.6 exact vertical, MCP vertical,
crash/restart paths, staging/vault KIP-10 mechanics, AP2 receipts, and offline
smoke all pass. An older transaction outside the operator node's retained
acceptance window was also checked: fresh corroboration returned unavailable,
not accepted or absent. This is the intended fail-closed boundary; evidence
retained when first accepted remains available after pruning.

Residual risk is now the separate bounded-lifecycle workstream. The remaining
four validated findings are not marked fixed by this milestone.

### Milestone 3: bounded operational lifecycles — initial implementation

Status: **superseded and reopened by the independent review of `082def2`**

The initial implementation applied ADR-0013 narrowly with one shared Admission Lease vocabulary and
separate enforcement at each owning boundary. Trusted Authority pre-auth
sockets are admitted before parser state and bounded at the manifest's
`authorityPreauthSockets: 32` budget with a non-renewable frame deadline.
Authenticated human decisions are bounded at
`authorityPrompts: 4`, keep one visible terminal ceremony, and carry one
abort lifetime through transport, service, decision provider, prompt queue,
and active readline work. The Authority never exposes credentials or
availability policy to `sompi-mcp`.

Purchase and Evidence admission is Journal-owned and transactional. The
manifest's `prevalidationPurchases: 128` and `evidenceBytes: 67108864`
projections are persisted in Journal schema epoch 8. Unique content-addressed
blobs consume byte capacity, identical blobs deduplicate, publication/link
faults reconcile deterministically on restart, valid evidence is immutable, and
MCP exposes only bounded secret-free saturation status. Known-denied egress is
rejected before durable Purchase or evidence state.

Direct Treasury validation runs before durable claim. Typed permanent
pre-effect failures enter `failed_terminal` and release policy capacity;
typed transient preparation failures use the manifest's exact
`directTreasuryRetries: 3` bound with durable retry accounting. Once prepared
bytes, submission, or an external effect may exist, cancellation and errors
remain fenced for Reconciliation. Wallet send, vault send, and vault deposit
share the same policy-capacity accounting.

Findings provisionally addressed by this milestone; final dispositions are recorded in Milestone 4:

- `authority-preauth-socket-exhaustion`
- `authority-prompt-queue-dos`
- `prevalidation-purchase-storage-exhaustion`
- `direct-treasury-preparation-lockout`

Ordered verification:

1. Focused Authority, Purchase/Journal/Evidence, Treasury, Operator
   Manifest/config, crash/fault-boundary, local E2E, and MCP transport tests
   passed: 201 passed, 0 failed, 0 skipped.
2. The complete suite passed: 370 tests, 369 passed, 0 failed, and one
   documented root-only ownership test skipped. Offline smoke passed all 13
   checks. The deterministic local E2E finished in `receipted` state without
   claiming live-network conformance.
3. Baseline reproduction before edits recorded 128 retained partial Authority
   sockets, a renewable drip-fed socket, 128 queued prompt promises with no
   settlement after 50 ms, and three denied requests retaining one, two, and
   three MiB of Purchase/evidence state. The exact 17cce direct-Treasury seam
   reproduction left a permanent preparation failure in `intent`, retained
   110 units of policy capacity, and blocked the next operation.
4. Against the fixed build, the pre-auth PoC stopped at its vulnerable
   assertion with 32 retained sockets rather than 128; the prompt PoC stopped
   with 124 over-cap promises settled by bounded rejection rather than an
   unbounded queue; and the storage PoC observed `purchase=absent files=0
   bytes=0` for each of three denied requests. Each behavior also has direct
   regression coverage. The original direct-Treasury PoC was run against a
   built fixed archive and stops at its stale pre-2B `PolicyEngine` constructor;
   the current-boundary regression and exact-baseline reproduction above are
   the authoritative closure evidence rather than a hash/API guard.
5. `npm pack --json` followed by
   `node scripts/verify-packed-artifact.mjs elldeeone-sompi-0.8.0.tgz` passed
   for 172 entries, and the generated archive was removed afterward.
6. Final security-oriented review covered lease release and double-release
   paths, cancellation/signing races, quota drift and orphan cleanup, unsafe
   Treasury terminalization, secret-free projections, dead compatibility paths,
   and AP2/x402 ownership boundaries. Journal schemas v1 through v7 are
   rejected untouched; schema 8 is the only current epoch.
7. The durable repository report and the temporary mirror were both updated:
   `/tmp/codex-security-scans-u5YlLn/sompi/4ebb82d4f82bac46ae3addd112c4752f29630a8a_20260711T145619Z_75jg_ull/artifacts/fix_report.md`.

### Milestone 4: Phase 2D independent-review remediation

Status: **verified — ready for independent re-review**

The independent review of the initial Phase 2D commits found ten reportable
findings, three additional engineering blockers, and the deferred post-sign
Authority abort defect. This milestone is committed locally as:

- `9420aff063fbeae9a13e9fa88bab651f9e387e86` — enforce bounded Phase 2D
  lifecycle ownership;
- `fdedcad39b05f1e8db9722fbeaf2055a590ca11c` — close review lifecycle race
  boundaries;
- `3664e768b165be8c1d4f7efdc43b2026a9432fb2` — preserve wallet chain
  observation bindings.
- `7e2fa5ad4594a24085b1f8121d35cef3f6b495cf` — remove in-memory Treasury lifecycle authority; cancellation now
  relies only on the Journal-owned driver/state.

The ten reportable findings are fixed at their current production boundaries:

1. MCP cancellation now carries the SDK signal into Treasury and leaves a
   durable cancellation/reconciliation view after any possible effect.
2. Production wallet, vault, deposit, and RPC preparation failures use an
   exhaustive typed terminal/transient/unknown contract.
3. A Journal-owned durable driver serializes same-key execution across handles
   and restart; stale generations cannot submit.
4. Prompt admission occurs before replay acquisition and replay rows/tokens/
   result storage have bounded high-water marks with eager expiry cleanup.
5. Plan, preparation, submission, observation, and completion transitions use
   cancellation/fence/current-generation CAS checks.
6. Digest-scoped evidence cleanup cannot unlink a live writer's blob.
7. Successful preparation cannot bypass the durable preparation fence or
   effect capability.
8. Purchase count and mandatory request evidence are one compound admission;
   denied egress and evidence failure leave no Purchase or attachment.
9. The production Authority Unix wrapper forwards the connection AbortSignal.
10. Exact authoritative `not_submitted` evidence plus cancellation terminalizes
    and releases capacity; weaker evidence remains in Reconciliation.

The three additional engineering blockers are fixed: `SOMPI-DIFF-AUTH-003`
uses the manifest socket projection through the production wrapper;
`SOMPI-DIFF-JOURNAL-002` preserves unexpired foreign live leases; and
`SOMPI-DIFF-JOURNAL-004` rebuilds committed evidence bytes from unique artifact
digests. Deferred `SOMPI-DIFF-AUTH-002` is fixed by signal checks after human
and AP2 signing awaits and decision-store discard of late persisted results.

Architecture remains separate by owner: there is no universal scheduler,
broker, cross-process lease service, workflow engine, or payment-rail plugin
system. AP2/x402 wire objects and Kaspa-x402 mechanics are unchanged, and the
sibling repository is untouched. The clean-cutover Journal is epoch 9;
schemas 1 through 8 are rejected untouched.

Ordered verification:

1. Current-boundary regressions passed for Treasury reducer/driver takeover,
   MCP signal forwarding, Authority production cap and abort, prompt/replay
   saturation and late answers, compound Purchase/evidence admission,
   digest ownership, foreign lease recovery, unique-byte restart accounting,
   crash/fault boundaries, and exact non-submission release.
2. Focused remediation/config/lifecycle suites passed 81/81. `npm test`
   passed 377 tests: 376 passed, 0 failed, 1 documented root-only skip.
   Offline smoke passed all 13 checks.
3. The ten review PoCs all exited nonzero at repaired assertions: signal was
   forwarded; replay rows stayed bounded; rejected evidence retained no
   Purchase; MCP cancellation produced zero submit/observe/commit calls;
   shared evidence survived rollback; cancel/plan produced zero submit calls;
   exact absence produced `failed_terminal`; same-key duplication timed out at
   its obsolete second-prepare expectation; typed preparation no longer fenced
   permanently; and stale prepared material could not submit.
4. The four original Phase 2D PoCs all stopped at fixed behavior: pre-auth
   retained 32 rather than 128 sockets; prompt over-cap work was rejected at
   the four-prompt boundary; denied egress retained `purchase=absent files=0
   bytes=0`; and the old direct-Treasury harness stopped at its stale
   pre-2B reviewed-revision hash guard. Direct current-boundary regressions,
   not hash/API guards, establish the fourth disposition.
5. `npm pack --json` and `node scripts/verify-packed-artifact.mjs
   elldeeone-sompi-0.8.0.tgz` passed with 173 entries, 5,034,044 packed bytes,
   and 14,347,715 unpacked file bytes. The archive was removed.
6. The pinned live Testnet-10 proof against `ws://10.0.3.26:17210/` plus the
   independent HTTPS witness resumed after a bootstrap recovery boundary and
   reached `receipted`. The public-facts report digest is
   `c7e94f421414f30ec1c800951315319e76ba33ac74b6f82d4599b67fa0709257`, for
   Purchase `pur_sT4BfCHohfrU3mOMJ_GYsg`, exact transaction
   `c98749c8871f2c9e7d8aa38d7369149eef7c63d31a707ddb87acbbdae2ddf451`, and
   Merchant outpoint `:1`. The run used the in-process auto-approved Authority
   fixture and therefore does not claim human-present or separate-UID live
   Authority conformance; those paths have production-wrapper hermetic tests.
7. The final security diff review covered lease leaks/double release,
   cancellation/signing races, stale driver effects, quota drift, unsafe
   terminalization, evidence unlink races, secret leakage, dead compatibility
   paths, and AP2/x402 boundary violations.

All 21 scan findings are now accounted for: 4 Operator Provisioning, 13 Chain
Evidence/finality, and 4 bounded lifecycle findings — four, not eight. The
durable report and its existing temporary mirror are byte-identical at:

`/tmp/codex-security-scans-u5YlLn/sompi/4ebb82d4f82bac46ae3addd112c4752f29630a8a_20260711T145619Z_75jg_ull/artifacts/fix_report.md`

Residual risk is limited to the intentionally testnet-only profile, evolving
external AP2/x402 standards, the in-process Authority mode used by the live
proof, and the stale legacy direct-Treasury PoC harness. The branch is ready
for independent re-review; this report does not claim independent acceptance.
