# Architecture decision records

Accepted records are authoritative for the clean cutover. A later decision
must supersede an earlier record explicitly; silently contradicting one in code
or documentation is not allowed.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-clean-cutover.md) | Clean cutover without backwards compatibility | Accepted |
| [0002](0002-modular-monolith-and-purchase-module.md) | Modular monolith centred on a deep Purchase module | Accepted |
| [0003](0003-protocol-ownership.md) | Sompi/AP2/x402/Kaspa-x402 ownership split | Accepted |
| [0004](0004-transactional-journal-first.md) | Transactional Purchase Journal before payment cutover | Accepted |
| [0005](0005-isolated-trusted-authority.md) | Separate deterministic Trusted Authority | Accepted |
| [0006](0006-versioned-protocol-adapters.md) | Pinned, replaceable protocol adapters and evidence | Accepted |
| [0007](0007-initial-delivery-scope.md) | Human-present, exact, testnet-first delivery | Accepted |
| [0008](0008-repository-and-runtime-topology.md) | One repository/package, two long-running executables initially | Accepted |
| [0009](0009-kaspa-x402-integration.md) | Use Kaspa-x402 unchanged for initial AP2 integration | Accepted |
| [0010](0010-native-kas-ap2-profile.md) | Experimental native-KAS AP2 payment instrument profile | Accepted |
| [0011](0011-trusted-operator-provisioning.md) | Immutable Operator Manifest installed outside MCP | Accepted |
| [0012](0012-chain-evidence-and-finality.md) | Sompi-owned typed Chain Evidence and explicit finality floors | Accepted |
| [0013](0013-bounded-operation-lifecycles.md) | Per-module bounded Admission Leases and cancellation semantics | Accepted |
| [0014](0014-phase-2d-review-remediation.md) | Phase 2D review remediation lifecycles | Accepted |
| [0015](0015-api-first-alpha8-clean-cutover.md) | API-first alpha.8 clean cutover with MCP compatibility | Accepted |
| [0016](0016-telegram-human-authority.md) | Request-bound Telegram approval through the isolated Authority | Accepted |
