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
