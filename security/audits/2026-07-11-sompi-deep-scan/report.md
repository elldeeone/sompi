# Security Review: sompi

## Scope

Deep repository-wide review of the immutable Sompi revision, including runtime code, adapters, authority IPC, Treasury and vault operations, durable state, tests, scripts, configuration, dependency metadata, and architecture controls.

- Scan mode: deep_repository
- Target kind: git_revision
- Target ID: target_sha256_f51b34e6f0c1b137358a36dd9b5b41e564f506fe049cad6a1df24eb7561a49c1
- Revision: 4ebb82d4f82bac46ae3addd112c4752f29630a8a
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Runtime or test status: No production deployment was assessed. A scan-local git archive passed npm ci, TypeScript build, 339 unit tests with one expected root-only skip, and 13 offline smoke checks.
- Artifacts reviewed: CONTEXT.md, docs/architecture/SOMPI_ARCHITECTURE.md, docs/adr/, docs/IMPLEMENTATION_PLAN.md, CURRENT_STATE.md, all authoritative tracked source, test, script, configuration, and documentation paths
- Scan context: The repository threat model was synthesized during the threat-model phase from checked-in architecture and all independent discovery models; it was not supplied as an external assessment.

Limitations and exclusions:
- The supported release is human-present AP2 v0.2 plus Kaspa-x402 exact on Testnet-10; no mainnet safety or conformance claim is made.
- Safe local harnesses replaced live malicious Merchant, RPC, blockchain, and resource-exhaustion experiments where external side effects were unnecessary.
- Deployment-specific operator practices, filesystem ownership, node selection, and external quotas were not observable from the repository.
- Excluded .git/\*\*: Git internals are not part of the immutable revision's authoritative source tree.
- Excluded node_modules/\*\* and generated dist/\*\*: Generated dependencies and build output were not authoritative inputs; validation rebuilt them with npm ci and npm run build from the pinned revision.

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable DSS findings | 21 |
| Report instances | 21 |
| Report severity mix | medium: 8, low: 13 |
| Report confidence mix | high: 21 |
| Coverage | complete |
| Validation mode | Five independent deep-discovery rounds followed by centralized exact-revision validation, executable local PoCs, counterevidence review, and per-candidate attack-path calibration. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Sompi must let a fully untrusted Agent initiate and observe a human-authorized Purchase without allowing Agent, Merchant, RPC, network, local lower-privilege process, crash, or configuration input to alter canonical Purchase facts, authority decisions, Treasury movement, Settlement evidence, recovery accounting, or operator-owned control state.

### Assets

- wallet and covenant-vault signing authority
- Trusted Authority credentials and human approval decisions
- policy limits, reservations, capacity releases, and spend history
- canonical Purchase state and immutable protocol evidence
- prepared transactions, outpoints, finality and recovery-winner evidence
- operator configuration, trust roots, policy provenance and recovery state
- availability of Authority, MCP, journal and evidence storage

### Trust Boundaries

- fully untrusted Agent and MCP arguments into deterministic Sompi MCP
- separately credentialed Trusted Authority over authenticated local IPC
- untrusted but configured Merchant and AP2/x402 protocol artifacts
- untrusted Kaspa RPC, DNS, HTTP and network timing into chain-evidence adapters
- operator-owned local configuration and secure state versus lower-privilege local processes
- durable journal state before irreversible Merchant or blockchain effects

### Attacker Capabilities

- choose MCP tools, structured arguments, identifiers, timing, retries and bodies
- control or collude with a configured Merchant while possessing its legitimate signing identity
- control the selected Kaspa RPC's UTXO, mempool, DAA, finality, error and submission claims
- act on-path where cleartext Merchant HTTP is explicitly enabled
- consume sockets, prompt slots, operation slots and durable storage from intended lower-trust entry points
- replace writable or symlinked local configuration without root
- spend legitimately received outputs and exploit delayed observation or process restart

### Security Objectives

- authorization, policy reservation, stable identity and recovery state precede irreversible effects
- one untrusted observer cannot manufacture settlement, finality, absence or winner evidence
- Agent input cannot become operator authority or policy
- ambiguous effects are reconciled before retry and current UTXO views are not treated as historical proof
- resource admission remains bounded before and after authentication
- unknown protocol profiles and unsafe configuration provenance fail closed

### Assumptions

- Host administrator, root and kernel compromise are out of scope
- The supported runtime is Testnet-10 and human-present; autonomous, batch, UCP, passkey and mainnet paths remain gated
- Pinned implementation code is trusted only within its verified contracts; all external protocol and RPC values remain untrusted data
- The target repository and validation build exactly match the recorded revision

## Findings

| Findings | Reports | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- | --- |
| A single selected Kaspa RPC can fabricate exact-payment inclusion and finality | [DSS-CAN-003](#finding-1) | medium | high | [Open DSS-CAN-003](findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md) |
| Spending a staging-race winner erases the evidence needed to close recovery accounting | [DSS-CAN-033](#finding-2) | medium | high | [Open DSS-CAN-033](findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md) |
| Merchant-Controlled Mempool Finality Prematurely Releases Recovery Capacity | [DSS-CAN-030](#finding-3) | medium | high | [Open DSS-CAN-030](findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md) |
| Direct Treasury preparation failure permanently locks all direct movements | [DSS-CAN-031](#finding-4) | medium | high | [Open DSS-CAN-031](findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md) |
| Provisional exact-payment evidence permanently closes staging recovery | [DSS-CAN-020](#finding-5) | medium | high | [Open DSS-CAN-020](findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md) |
| Unchecked policy-file provenance lets a local Agent process replace operator authority | [DSS-CAN-032](#finding-6) | medium | high | [Open DSS-CAN-032](findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md) |
| Untrusted RPC Can Forge Recovery Finality and Release Policy Capacity | [DSS-CAN-004](#finding-7) | medium | high | [Open DSS-CAN-004](findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md) |
| MCP vault provisioning lets an untrusted Agent seize owner recovery authority | [DSS-CAN-001](#finding-8) | medium | high | [Open DSS-CAN-001](findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md) |
| Spent Merchant Outputs Become Invisible to Exact-Payment Recovery | [DSS-CAN-017](#finding-9) | low | high | [Open DSS-CAN-017](findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md) |
| Untrusted RPC metadata can spoof mempool transaction identity | [DSS-CAN-016](#finding-10) | low | high | [Open DSS-CAN-016](findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md) |
| Cleartext Merchant authorization permits forged acceptance and signed-payment capture | [DSS-CAN-007](#finding-11) | low | high | [Open DSS-CAN-007](findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md) |
| Provisional Purchase staging is committed before accepted finality | [DSS-CAN-026](#finding-12) | low | high | [Open DSS-CAN-026](findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md) |
| Mempool-Only RPC Evidence Can Permanently Complete a Direct Wallet Send | [DSS-CAN-023](#finding-13) | low | high | [Open DSS-CAN-023](findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md) |
| Generic Kaspa RPC errors become recovery absence evidence | [DSS-CAN-006](#finding-14) | low | high | [Open DSS-CAN-006](findings/rpc-error-as-absence/rpc-error-as-absence.md) |
| Single-RPC Absence Evidence Can Authorize a Competing Staging-Recovery Transaction | [DSS-CAN-018](#finding-15) | low | high | [Open DSS-CAN-018](findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md) |
| Pre-validation Purchase bodies can exhaust Sompi's durable storage | [DSS-CAN-027](#finding-16) | low | high | [Open DSS-CAN-027](findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md) |
| Provisional Kaspa Evidence Can Advance Sompi's Durable Vault Continuation | [DSS-CAN-024](#finding-17) | low | high | [Open DSS-CAN-024](findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md) |
| Invalid x-only key validation can permanently disable vault-owner recovery | [DSS-CAN-008](#finding-18) | low | high | [Open DSS-CAN-008](findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md) |
| Authenticated authority requests can indefinitely block the human approval queue | [DSS-CAN-013](#finding-19) | low | high | [Open DSS-CAN-013](findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md) |
| Unbounded pre-authentication authority sockets allow local approval-service exhaustion | [DSS-CAN-009](#finding-20) | low | high | [Open DSS-CAN-009](findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md) |
| Provisional single-RPC evidence can persist a nonexistent vault deposit | [DSS-CAN-025](#finding-21) | low | high | [Open DSS-CAN-025](findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md) |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] A single selected Kaspa RPC can fabricate exact-payment inclusion and finality

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Production-interface fake-RPC reproduction plus static trace into durable Settlement and observed-spend state against a git-archived, independently installed and compiled artifact-local copy of the immutable target. Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Insufficient verification of chain-data authenticity |
| CWE | CWE-345 |
| Affected lines | src/adapters/kaspa-x402/chain-verifier.ts:338-390, src/adapters/kaspa-x402/chain-verifier.ts:562-642, src/adapters/kaspa-x402/chain-verifier.ts:383-417, src/runtime/purchase-runtime.ts:188-199 |

#### Summary

See the [detailed technical write-up](findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md).

#### Validation

See the [detailed technical write-up](findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md).

#### Dataflow

See the [detailed technical write-up](findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md).

#### Reachability

See the [detailed technical write-up](findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md).

#### Severity

See the [detailed technical write-up](findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md).

#### Remediation

See the [detailed technical write-up](findings/untrusted-rpc-false-settlement/untrusted-rpc-false-settlement.md).

<a id="finding-2"></a>

### [2] Spending a staging-race winner erases the evidence needed to close recovery accounting

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | shared scan-local immutable Git-archive/npm-ci build, relative-import production-observer harness, exact captured classifier/coordinator tests, and static state trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Insufficient verification of historical chain evidence |
| CWE | CWE-345 |
| Affected lines | src/adapters/kaspa-x402/staging-recovery-rpc.ts:103-181, src/adapters/kaspa-x402/staging-recovery-rpc.ts:185-260, src/adapters/kaspa-x402/abandoned-staging-recovery.ts:764-854, src/adapters/kaspa-x402/staging-recovery-module.ts:132-179 |

#### Summary

See the [detailed technical write-up](findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md).

#### Validation

See the [detailed technical write-up](findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md).

#### Dataflow

See the [detailed technical write-up](findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md).

#### Reachability

See the [detailed technical write-up](findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md).

#### Severity

See the [detailed technical write-up](findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md).

#### Remediation

See the [detailed technical write-up](findings/spent-staging-winner-evidence-loss/spent-staging-winner-evidence-loss.md).

<a id="finding-3"></a>

### [3] Merchant-Controlled Mempool Finality Prematurely Releases Recovery Capacity

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | shared scan-local immutable Git-archive/npm-ci build, exact captured focused tests, and static cross-boundary source-control-sink trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Authorization-policy omission and finality downgrade |
| CWE | CWE-863 |
| Affected lines | src/adapters/kaspa-x402/payment-requirements-verifier.ts:63-86, src/authority/protocol.ts:43-70, src/adapters/ap2/human-authority.ts:179-204, src/adapters/kaspa-x402/staging-recovery-module.ts:228-251, src/adapters/kaspa-x402/abandoned-staging-recovery.ts:785-820, src/purchase/journal.ts:2802-2812, src/purchase/journal.ts:5142-5185 |

#### Summary

See the [detailed technical write-up](findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md).

#### Validation

See the [detailed technical write-up](findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md).

#### Dataflow

See the [detailed technical write-up](findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md).

#### Reachability

See the [detailed technical write-up](findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md).

#### Severity

See the [detailed technical write-up](findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md).

#### Remediation

See the [detailed technical write-up](findings/merchant-mempool-finality-capacity-release/merchant-mempool-finality-capacity-release.md).

<a id="finding-4"></a>

### [4] Direct Treasury preparation failure permanently locks all direct movements

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Scan-local git archive of exact revision; npm ci from archived lockfile; scan-local npm build; pinned SDK and production wallet adapter/module/journal reproduction; pre-claim negative control; restart/recovery check; immutable targeted tests; SHA-256 provenance Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Uncontrolled resource retention |
| CWE | CWE-400 |
| Affected lines | src/mcp/server.ts:160-180, src/treasury/operations.ts:94-105, src/treasury/operations.ts:133-152, src/treasury/operations.ts:261-281, src/purchase/journal.ts:1283-1349, src/purchase/journal-schema.ts:554-556 |

#### Summary

See the [detailed technical write-up](findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md).

#### Validation

See the [detailed technical write-up](findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md).

#### Dataflow

See the [detailed technical write-up](findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md).

#### Reachability

See the [detailed technical write-up](findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md).

#### Severity

See the [detailed technical write-up](findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md).

#### Remediation

See the [detailed technical write-up](findings/direct-treasury-preparation-lockout/direct-treasury-preparation-lockout.md).

<a id="finding-5"></a>

### [5] Provisional exact-payment evidence permanently closes staging recovery

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | shared scan-local immutable Git-archive/npm-ci build, exact captured focused adapter/coordinator tests, and deterministic static state-transition trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Improper use of provisional chain evidence |
| CWE | CWE-345 |
| Affected lines | src/adapters/kaspa-x402/abandoned-staging-recovery.ts:785-820, src/purchase/journal.ts:2782-2801, src/purchase/journal.ts:2802-2831, src/purchase/journal.ts:7375-7388, src/purchase/coordinator.ts:1866-1871 |

#### Summary

See the [detailed technical write-up](findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md).

#### Validation

See the [detailed technical write-up](findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md).

#### Dataflow

See the [detailed technical write-up](findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md).

#### Reachability

See the [detailed technical write-up](findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md).

#### Severity

See the [detailed technical write-up](findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md).

#### Remediation

See the [detailed technical write-up](findings/mempool-exact-terminal-recovery/mempool-exact-terminal-recovery.md).

<a id="finding-6"></a>

### [6] Unchecked policy-file provenance lets a local Agent process replace operator authority

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Realistic PolicyEngine symlink/hot-reload reproduction against a scan-local git-archive/npm-ci build plus MCP-to-wallet-send static trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | External control of security policy configuration |
| CWE | CWE-15 |
| Affected lines | src/policy.ts:43-74, src/policy.ts:145-156, src/policy.ts:82-115, src/runtime/config.ts:522-539, src/treasury/operations.ts:94-105, src/treasury/operations.ts:244-251, src/mcp/server.ts:160-180 |

#### Summary

See the [detailed technical write-up](findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md).

#### Validation

See the [detailed technical write-up](findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md).

#### Dataflow

See the [detailed technical write-up](findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md).

#### Reachability

See the [detailed technical write-up](findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md).

#### Severity

See the [detailed technical write-up](findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md).

#### Remediation

See the [detailed technical write-up](findings/policy-file-provenance-bypass/policy-file-provenance-bypass.md).

<a id="finding-7"></a>

### [7] Untrusted RPC Can Forge Recovery Finality and Release Policy Capacity

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | shared scan-local immutable Git-archive/npm-ci build, relative-import production-observer harness, exact captured target tests, and static source-control-sink trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Insufficient verification of recovery finality |
| CWE | CWE-345 |
| Affected lines | src/wallet.ts:95-163, src/adapters/kaspa-x402/staging-recovery-rpc.ts:56-143, src/adapters/kaspa-x402/staging-recovery-rpc.ts:280-318, src/adapters/kaspa-x402/abandoned-staging-recovery.ts:764-854, src/purchase/journal.ts:5082-5186, src/purchase/coordinator.ts:1866-1871 |

#### Summary

See the [detailed technical write-up](findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md).

#### Validation

See the [detailed technical write-up](findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md).

#### Dataflow

See the [detailed technical write-up](findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md).

#### Reachability

See the [detailed technical write-up](findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md).

#### Severity

See the [detailed technical write-up](findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md).

#### Remediation

See the [detailed technical write-up](findings/untrusted-rpc-forged-recovery-finality/untrusted-rpc-forged-recovery-finality.md).

<a id="finding-8"></a>

### [8] MCP vault provisioning lets an untrusted Agent seize owner recovery authority

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Realistic MCP-interface reproduction against the scan-local npm-ci build of the immutable target, plus static trace through durable owner binding and shipped unrestricted recovery. Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Missing authorization for recovery-authority assignment |
| CWE | CWE-862 |
| Affected lines | src/mcp/server.ts:276-312, src/vault.ts:238-277, src/vault.ts:895-938, src/vault.ts:1079-1104, scripts/vault-recover.js:37-71 |

#### Summary

See the [detailed technical write-up](findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md).

#### Validation

See the [detailed technical write-up](findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md).

#### Dataflow

See the [detailed technical write-up](findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md).

#### Reachability

See the [detailed technical write-up](findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md).

#### Severity

See the [detailed technical write-up](findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md).

#### Remediation

See the [detailed technical write-up](findings/vault-recovery-authority-hijack/vault-recovery-authority-hijack.md).

<a id="finding-9"></a>

### [9] Spent Merchant Outputs Become Invisible to Exact-Payment Recovery

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Production-interface post-spend state reproduction plus static recovery trace and direct-wallet accepted-history negative control against a git-archived, independently installed and compiled artifact-local copy of the immutable target. Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Insufficient verification of historical settlement evidence |
| CWE | CWE-345 |
| Affected lines | src/adapters/kaspa-x402/chain-verifier.ts:591-669, src/adapters/kaspa-x402/chain-verifier.ts:383-390, src/adapters/kaspa-x402/chain-verifier.ts:455-475, src/adapters/kaspa-x402/exact-payment-module.ts:494-523, src/wallet.ts:353-378 |

#### Summary

See the [detailed technical write-up](findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md).

#### Validation

See the [detailed technical write-up](findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md).

#### Dataflow

See the [detailed technical write-up](findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md).

#### Reachability

See the [detailed technical write-up](findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md).

#### Severity

See the [detailed technical write-up](findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md).

#### Remediation

See the [detailed technical write-up](findings/spent-payment-evidence-loss/spent-payment-evidence-loss.md).

<a id="finding-10"></a>

### [10] Untrusted RPC metadata can spoof mempool transaction identity

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Differential production-interface PoC with a non-hydratable mempool transaction, targeted existing tests, and recovery/settlement trace against a git-archived, independently installed and compiled artifact-local copy of the immutable target. Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Insufficient verification of transaction identity |
| CWE | CWE-345 |
| Affected lines | src/adapters/kaspa-x402/chain-verifier.ts:645-674, src/adapters/kaspa-x402/chain-verifier.ts:1369-1383, src/adapters/kaspa-x402/chain-verifier.ts:675-701, src/adapters/kaspa-x402/chain-verifier.ts:420-475 |

#### Summary

See the [detailed technical write-up](findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md).

#### Validation

See the [detailed technical write-up](findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md).

#### Dataflow

See the [detailed technical write-up](findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md).

#### Reachability

See the [detailed technical write-up](findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md).

#### Severity

See the [detailed technical write-up](findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md).

#### Remediation

See the [detailed technical write-up](findings/rpc-mempool-id-spoof/rpc-mempool-id-spoof.md).

<a id="finding-11"></a>

### [11] Cleartext Merchant authorization permits forged acceptance and signed-payment capture

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Focused real-code reproduction from the scan-local immutable npm-ci build plus exact static source/control/sink trace and targeted tests from that same build. Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Cleartext transmission of sensitive protocol data |
| CWE | CWE-319 |
| Affected lines | src/runtime/config.ts:421-447, src/adapters/ap2/commerce-authorization-module.ts:228-249, src/adapters/ap2/commerce-authorization-module.ts:380-420, src/purchase/coordinator.ts:952-982, src/purchase/coordinator.ts:1011-1076, src/adapters/kaspa-x402/exact-payment-module.ts:397-415, src/adapters/kaspa-x402/exact-payment-module.ts:733-809, src/http/node-pinned-transport.ts:30-84 |

#### Summary

See the [detailed technical write-up](findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md).

#### Validation

See the [detailed technical write-up](findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md).

#### Dataflow

See the [detailed technical write-up](findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md).

#### Reachability

See the [detailed technical write-up](findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md).

#### Severity

See the [detailed technical write-up](findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md).

#### Remediation

See the [detailed technical write-up](findings/cleartext-merchant-authorization/cleartext-merchant-authorization.md).

<a id="finding-12"></a>

### [12] Provisional Purchase staging is committed before accepted finality

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Scan-local git archive of exact revision; npm ci from archived lockfile; scan-local npm build; representative production vault DAA-zero proof; immutable production staging commit/evidence execution; public-wrapper trace; immutable targeted tests; SHA-256 provenance Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Improper use of provisional staging finality |
| CWE | CWE-345 |
| Affected lines | src/adapters/kaspa-x402/vault-treasury-staging.ts:270-324, src/vault.ts:652-700, src/adapters/kaspa-x402/vault-treasury-staging.ts:382-395, src/vault.ts:800-823, src/purchase/coordinator.ts:1633-1656 |

#### Summary

See the [detailed technical write-up](findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md).

#### Validation

See the [detailed technical write-up](findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md).

#### Dataflow

See the [detailed technical write-up](findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md).

#### Reachability

See the [detailed technical write-up](findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md).

#### Severity

See the [detailed technical write-up](findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md).

#### Remediation

See the [detailed technical write-up](findings/provisional-purchase-staging-finality/provisional-purchase-staging-finality.md).

<a id="finding-13"></a>

### [13] Mempool-Only RPC Evidence Can Permanently Complete a Direct Wallet Send

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Scan-local git archive of exact revision; npm ci from archived lockfile; scan-local npm build; production wallet adapter/module/journal reproduction; eviction/restart check; immutable targeted tests; SHA-256 provenance Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Improper use of provisional wallet finality |
| CWE | CWE-345 |
| Affected lines | src/wallet.ts:308-348, src/treasury/operation-adapters.ts:176-207, src/treasury/operations.ts:163-171, src/purchase/journal.ts:1564-1638, src/wallet.ts:308-394, src/treasury/operation-adapters.ts:176-208, src/treasury/operation-adapters.ts:258-305 |

#### Summary

See the [detailed technical write-up](findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md).

#### Validation

See the [detailed technical write-up](findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md).

#### Dataflow

See the [detailed technical write-up](findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md).

#### Reachability

See the [detailed technical write-up](findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md).

#### Severity

See the [detailed technical write-up](findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md).

#### Remediation

See the [detailed technical write-up](findings/provisional-wallet-send-finality/provisional-wallet-send-finality.md).

<a id="finding-14"></a>

### [14] Generic Kaspa RPC errors become recovery absence evidence

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | shared scan-local immutable Git-archive/npm-ci build, relative-import production-observer harness, exact captured target tests, and static source-control-sink trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Fail-open exceptional-condition handling |
| CWE | CWE-754 |
| Affected lines | src/adapters/kaspa-x402/staging-recovery-rpc.ts:146-181, src/adapters/kaspa-x402/staging-recovery-rpc.ts:482-484, src/adapters/kaspa-x402/abandoned-staging-recovery.ts:785-820, src/purchase/coordinator.ts:1893-1921 |

#### Summary

See the [detailed technical write-up](findings/rpc-error-as-absence/rpc-error-as-absence.md).

#### Validation

See the [detailed technical write-up](findings/rpc-error-as-absence/rpc-error-as-absence.md).

#### Dataflow

See the [detailed technical write-up](findings/rpc-error-as-absence/rpc-error-as-absence.md).

#### Reachability

See the [detailed technical write-up](findings/rpc-error-as-absence/rpc-error-as-absence.md).

#### Severity

See the [detailed technical write-up](findings/rpc-error-as-absence/rpc-error-as-absence.md).

#### Remediation

See the [detailed technical write-up](findings/rpc-error-as-absence/rpc-error-as-absence.md).

<a id="finding-15"></a>

### [15] Single-RPC Absence Evidence Can Authorize a Competing Staging-Recovery Transaction

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | shared scan-local immutable Git-archive/npm-ci build, exact captured realistic adapter/coordinator tests, and static production-composition source-control-sink trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Insufficient verification of negative chain evidence |
| CWE | CWE-345 |
| Affected lines | src/adapters/kaspa-x402/abandoned-staging-recovery.ts:401-438, src/adapters/kaspa-x402/abandoned-staging-recovery.ts:769-820, src/adapters/kaspa-x402/staging-recovery-rpc.ts:56-260, src/adapters/kaspa-x402/abandoned-staging-recovery.ts:441-477, src/runtime/purchase-runtime.ts:231-238 |

#### Summary

See the [detailed technical write-up](findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md).

#### Validation

See the [detailed technical write-up](findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md).

#### Dataflow

See the [detailed technical write-up](findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md).

#### Reachability

See the [detailed technical write-up](findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md).

#### Severity

See the [detailed technical write-up](findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md).

#### Remediation

See the [detailed technical write-up](findings/single-rpc-absence-recovery-race/single-rpc-absence-recovery-race.md).

<a id="finding-16"></a>

### [16] Pre-validation Purchase bodies can exhaust Sompi's durable storage

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Realistic reproduction through MCP input, PurchaseCoordinator, EgressPolicy, PurchaseJournal, and EvidenceStore from the scan-local npm-ci build, plus static quota/retention review. Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Uncontrolled durable storage consumption |
| CWE | CWE-400 |
| Affected lines | src/mcp/server.ts:452-469, src/mcp/purchase-tools.ts:34-65, src/purchase/coordinator.ts:566-591, src/purchase/coordinator.ts:2341-2349, src/purchase/evidence-store.ts:54-113, src/purchase/journal.ts:1099-1155 |

#### Summary

See the [detailed technical write-up](findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md).

#### Validation

See the [detailed technical write-up](findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md).

#### Dataflow

See the [detailed technical write-up](findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md).

#### Reachability

See the [detailed technical write-up](findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md).

#### Severity

See the [detailed technical write-up](findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md).

#### Remediation

See the [detailed technical write-up](findings/prevalidation-purchase-storage-exhaustion/prevalidation-purchase-storage-exhaustion.md).

<a id="finding-17"></a>

### [17] Provisional Kaspa Evidence Can Advance Sompi's Durable Vault Continuation

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Scan-local git archive of exact revision; npm ci from archived lockfile; scan-local npm build; production VaultManager/KaspaWallet DAA-zero reproduction; disappearance/restart check; immutable targeted tests; SHA-256 provenance Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Improper use of provisional vault-spend finality |
| CWE | CWE-345 |
| Affected lines | src/vault.ts:652-700, src/treasury/operation-adapters.ts:258-304, src/vault.ts:800-823, src/treasury/operations.ts:154-171 |

#### Summary

See the [detailed technical write-up](findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md).

#### Validation

See the [detailed technical write-up](findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md).

#### Dataflow

See the [detailed technical write-up](findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md).

#### Reachability

See the [detailed technical write-up](findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md).

#### Severity

See the [detailed technical write-up](findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md).

#### Remediation

See the [detailed technical write-up](findings/provisional-vault-send-continuation/provisional-vault-send-continuation.md).

<a id="finding-18"></a>

### [18] Invalid x-only key validation can permanently disable vault-owner recovery

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Executable differential test between the pinned SDK key parser and VaultManager from the scan-local npm-ci build, plus static covenant/recovery-gate trace. Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Improper validation of recovery-key input |
| CWE | CWE-20 |
| Affected lines | src/mcp/server.ts:277-312, src/vault.ts:238-251, src/vault.ts:253-276, src/vault.ts:1084-1104 |

#### Summary

See the [detailed technical write-up](findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md).

#### Validation

See the [detailed technical write-up](findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md).

#### Dataflow

See the [detailed technical write-up](findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md).

#### Reachability

See the [detailed technical write-up](findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md).

#### Severity

See the [detailed technical write-up](findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md).

#### Remediation

See the [detailed technical write-up](findings/invalid-vault-recovery-key/invalid-vault-recovery-key.md).

<a id="finding-19"></a>

### [19] Authenticated authority requests can indefinitely block the human approval queue

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | production TerminalAuthorityApprovalPrompt queue reproduction and targeted test against the scan-local immutable npm-ci build plus immutable transport/service/runtime source-control-sink trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Uncontrolled authenticated resource consumption |
| CWE | CWE-400 |
| Affected lines | src/authority/protocol.ts:434-472, src/authority/service.ts:136-177, src/authority/service.ts:203-243, src/authority/transport.ts:206-213, src/adapters/ap2/human-authority.ts:136-150, src/authority/transport.ts:192-214, src/authority/service.ts:203-244, src/adapters/ap2/human-authority.ts:72-114, src/adapters/ap2/human-authority.ts:144-170, src/authority/runtime.ts:251-269 |

#### Summary

See the [detailed technical write-up](findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md).

#### Validation

See the [detailed technical write-up](findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md).

#### Dataflow

See the [detailed technical write-up](findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md).

#### Reachability

See the [detailed technical write-up](findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md).

#### Severity

See the [detailed technical write-up](findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md).

#### Remediation

See the [detailed technical write-up](findings/authority-prompt-queue-dos/authority-prompt-queue-dos.md).

<a id="finding-20"></a>

### [20] Unbounded pre-authentication authority sockets allow local approval-service exhaustion

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | realistic Unix-socket and drip-feed reproductions plus targeted tests against the scan-local immutable npm-ci build, with immutable source/control/sink trace Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Uncontrolled pre-authentication resource consumption |
| CWE | CWE-400 |
| Affected lines | src/authority/transport.ts:60-75, src/authority/transport.ts:150-190, src/authority/runtime.ts:255-268, src/adapters/ap2/human-authority.ts:132-150 |

#### Summary

See the [detailed technical write-up](findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md).

#### Validation

See the [detailed technical write-up](findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md).

#### Dataflow

See the [detailed technical write-up](findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md).

#### Reachability

See the [detailed technical write-up](findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md).

#### Severity

See the [detailed technical write-up](findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md).

#### Remediation

See the [detailed technical write-up](findings/authority-preauth-socket-exhaustion/authority-preauth-socket-exhaustion.md).

<a id="finding-21"></a>

### [21] Provisional single-RPC evidence can persist a nonexistent vault deposit

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Scan-local git archive of exact revision; npm ci from archived lockfile; scan-local npm build; production VaultManager/KaspaWallet deposit DAA-zero reproduction; disappearance/restart check; immutable targeted tests; SHA-256 provenance Direct observations and exact-revision source tracing support the path; remaining uncertainty is limited to the constraints recorded below. |
| Category | Improper use of provisional vault-deposit finality |
| CWE | CWE-345 |
| Affected lines | src/vault.ts:450-473, src/treasury/operation-adapters.ts:361-406, src/vault.ts:534-556, src/treasury/operations.ts:154-171, src/vault.ts:450-531, src/treasury/operation-adapters.ts:258-305 |

#### Summary

See the [detailed technical write-up](findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md).

#### Validation

See the [detailed technical write-up](findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md).

#### Dataflow

See the [detailed technical write-up](findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md).

#### Reachability

See the [detailed technical write-up](findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md).

#### Severity

See the [detailed technical write-up](findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md).

#### Remediation

See the [detailed technical write-up](findings/provisional-vault-deposit-finality/provisional-vault-deposit-finality.md).

## Structural Hardening

The scan also produced derived, unsealed design guidance based on the complete finding collection. These proposals describe options and tradeoffs; they do not indicate that any finding has been remediated.

[Open the structural hardening portfolio](hardening/hardening.md)

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Untrusted Agent and vault bootstrap | Agent trust, vault owner authority, validation-time storage | Reported | Reported CAN-001, CAN-008, and CAN-027. CAN-010 was rejected during validation. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Trusted Authority IPC and prompt lifetime | Unix-socket admission, replay, prompt queues, service availability | Reported | Reported CAN-009 and CAN-013. CAN-011 and CAN-012 were rejected during validation. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Merchant egress | URL policy, DNS, pinned transport, cleartext opt-in, response lifecycle | Reported | Reported CAN-007. CAN-014, CAN-015, CAN-028, and CAN-029 were rejected after attack-path analysis. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| AP2 authorization and evidence | Signed-fact binding, Merchant authorization state, authority evidence | Reported | CAN-007 crosses this surface. CAN-002 was rejected after attack-path analysis; CAN-011 and CAN-012 were rejected during validation. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Kaspa-x402 exact settlement | Preparation, single-RPC observation, Settlement, accepted-payment recovery | Reported | Reported CAN-003, CAN-016, and CAN-017. CAN-005 was rejected after attack-path analysis. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Treasury staging and recovery | Exact-versus-recovery race, absence proof, finality, winner evidence, capacity release | Reported | Reported CAN-004, CAN-006, CAN-018, CAN-020, CAN-026, CAN-030, and CAN-033. CAN-019 and CAN-022 were rejected after attack-path analysis. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Direct wallet and vault operations | Direct movement, observation finality, durable continuation, exclusivity | Reported | Reported CAN-001, CAN-008, CAN-023, CAN-024, CAN-025, and CAN-031. CAN-010 was rejected during validation. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Purchase journal and policy accounting | Durable effects, reservations, terminal transitions, storage and capacity release | Reported | Reported CAN-020, CAN-027, CAN-030, and CAN-031. CAN-019, CAN-021, and CAN-022 were rejected after attack-path analysis. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Local state provenance | Secure state, runtime configuration, operator-owned paths and keys | Reported | Reported CAN-008 and CAN-032. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |
| Supply chain, scripts, fixtures, tests, architecture and documentation | Dependency pins, lifecycle scripts, proof artifacts and non-runtime surfaces | No issue found | All authoritative files received five rounds of independent review; no unique reportable finding survived on this surface. Evidence: artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/validation_summary.md, artifacts/05_findings/attack_path_analysis_report.md |

## Open Questions And Follow Up

- Which proof-backed or independently operated Kaspa observer design should become the common chain-evidence control for exact settlement, direct Treasury operations, and staging recovery?
  - Follow-up prompt: At revision 4ebb82d4f82bac46ae3addd112c4752f29630a8a, design and test one fail-closed chain-evidence seam across src/adapters/kaspa-x402/chain-verifier.ts, staging-recovery-rpc.ts, and direct Treasury observation.
- Which operator-authenticated ceremony should own vault recovery-key and policy-file provenance before broader deployment?
  - Follow-up prompt: At revision 4ebb82d4f82bac46ae3addd112c4752f29630a8a, design an operator-only vault bootstrap and provenance-checked policy-loading path that keeps all authority credentials outside MCP.
