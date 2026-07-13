# Security remediation report

Status: **in progress**

Target baseline: `4ebb82d4f82bac46ae3addd112c4752f29630a8a`

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
eight findings are not marked fixed by this milestone.
