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
