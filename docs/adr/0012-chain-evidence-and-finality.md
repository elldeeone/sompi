# ADR-0012: Centralize Chain Evidence and explicit finality floors

- Status: Accepted
- Date: 2026-07-13

## Context

Settlement, vault continuation, wallet completion, staging recovery, and policy
release currently interpret current UTXOs, mempool entries, DAA depth, and RPC
errors independently. A spent output disappears from the UTXO index, retained
accepted history is bounded by pruning, and one RPC assertion is not a
cryptographic proof of its own truth. The word `confirmed` also currently
conflates a local ten-DAA policy with Kaspa's separate consensus finality.

Kaspa covenant mechanisms are not uniform. SompiVault uses native covenant-ID
bindings. KIP-10 exact uses P2SH transaction introspection and enforces a
same-index script/value continuation without a native covenant ID.

## Decision

Create one deep Sompi-owned Chain Evidence module. It is the only module allowed
to turn node/index observations into evidence that terminalizes Purchase,
Treasury, vault, staging, or recovery state.

Its vocabulary distinguishes:

- provisional mempool observation;
- accepted-chain observation;
- operator-defined depth confirmation;
- Kaspa consensus-final evidence;
- historical accepted evidence;
- corroborated absence;
- unknown or unavailable evidence.

Every evidence record binds the network, transaction, relevant input/outpoint,
amount, script/template, continuation kind and facts, source/verifier profile,
manifest identity, observation time, finality level, and digest. Native
covenant-binding and KIP-10 script-template continuations are separate variants.
Operation-specific Finality Floors are operator-owned. Merchant requirements
may raise but never lower them. Mempool observations never terminalize an
irreversible transition or release capacity.

The Merchant's protocol finality requirement and Sompi's effective operator
floor are stored as separate durable facts. The effective floor and its meaning
are included in canonical Purchase Authorization facts, displayed by the
Trusted Authority, and bound into the experimental AP2 payment-instrument
evidence. An AP2 final Success receipt is not issued while the effective floor
is unmet; uncertainty remains Sompi Reconciliation rather than AP2 Error.

For the private Testnet-10 release, accepted facts require agreement between
the operator-controlled wRPC node and an independently operated HTTPS accepted-
chain witness, after which Sompi durably retains the evidence required for
recovery. The unauthenticated LAN route to `ws://10.0.3.26` is never sufficient
by itself. Missing, pruned, contradictory, or unavailable history fails closed.
Public or mainnet claims require an independently verified evidence plane or
equivalent locally verified inclusion/finality proof.

Kaspa-x402 remains unchanged. Its artifacts are payment-protocol evidence; the
Chain Evidence module independently applies Sompi's state-transition policy.

## Consequences

- Finality and negative-evidence semantics have one interface and test surface.
- RPC/backend upgrades remain local to Chain Evidence adapters.
- Recovery remains possible after expected outputs are spent or node history is
  pruned, within Sompi's retained evidence contract.
- Interactive testnet Settlement does not pretend to wait for twelve-hour Kaspa
  consensus finality.

## Rejected alternatives

- Per-caller guards: finality and absence interpretations would continue to
  drift.
- Treat ten DAA as consensus finality: factually wrong.
- Require `covenantId` for KIP-10: rejects valid script-template continuations.
- Modify Kaspa-x402 for Sompi state policy: violates protocol ownership.
