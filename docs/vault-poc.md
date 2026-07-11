# SompiVault rolling-window treasury

Status: retained consensus component in the v0.8 Purchase architecture

SompiVault is a stateful KIP-16 covenant on Kaspa testnet-10. The operator owns
an unrestricted recovery key. The Agent-facing key may withdraw only within a
rolling DAA-window cap enforced by Kaspa consensus. The cap includes the
withdrawal and network fee; remaining value must continue into the same
singleton covenant with the next state.

This on-chain cap is independent of Sompi's stricter software policy. A stolen
Agent/vault key cannot bypass the covenant, while a compromised MCP process
also cannot raise the operator-owned software limits.

## Contract

Source: [`contracts/vault.sil`](../contracts/vault.sil)

Static parameters:

- `agent`: x-only key for the capped path;
- `owner`: x-only key for unrestricted operator recovery;
- `maxOutflow`: maximum withdrawal plus fee per rolling window;
- `windowSize`: window length in DAA units.

Mutable state:

- `windowStart`: DAA score at which the active window began;
- `spentInWindow`: cumulative outflow in that window.

Entrypoints:

- `withdraw` requires the Agent signature, one covenant input, a non-final
  sequence, one valid continuation output, and cumulative outflow no greater
  than the cap. Active-input age and locktime rules prevent historical or
  finalized-future reset tricks.
- `topup` merges ordinary-wallet inputs into the singleton. It preserves active
  state, or begins a fresh zero-spent window only when the saved window and
  active UTXO are already reset-eligible.
- `recover` lets the operator drain the current vault state without Agent
  cooperation.

The runtime has no SilverScript compiler dependency. TypeScript template bytes
are pinned against compiler fixtures, then parameterized only by public keys,
cap, window, and current state.

## Durable runtime semantics

`vault_deposit` and `vault_send` are direct Treasury Movements in the same
SQLite journal used by Purchases:

- a stable `operationKey` binds immutable intent;
- source inputs, fee ceiling, prepared bytes, and transaction ID are durable
  before signing/submission;
- genesis deposit and top-up aggregate fragmented wallet UTXOs;
- recovery observes the exact saved inputs/transaction before any proof-backed
  resubmission;
- a crash after chain acceptance cannot silently lose policy or vault state.

A deposit transfers principal from Sompi's hot wallet into Sompi's protected
vault, so policy capacity counts its network fee rather than treating its
principal as a third-party spend. The principal remains separately recorded
and audited. A withdrawal to a third party counts principal plus actual fee.
Both paths reserve a conservative fee ceiling before signing.

Purchase execution uses the vault as Treasury. A separately authorized staging
transaction creates a one-use P2PK output for the immutable Kaspa-x402 exact
payment. The ordinary hot wallet is only setup/top-up float; it is not a hidden
fallback payment rail.

## Operator ceremony

Generate the owner key on a trusted operator machine:

```bash
sompi-mcp gen-owner-key
```

Retain the private value offline. Supply only the public key and desired cap to
`vault_create`, fund Sompi's receive address with testnet KAS, then call
`vault_deposit` with a stable operation key. `vault_status` exposes the public
configuration and current on-chain state.

Owner recovery is deliberately not an MCP tool. Run the packaged recovery
utility on the trusted machine using a mode-`0600` owner-key file; never pass
the private key through the Agent or shell history. See the utility's `--help`
and [`docs/runbooks/RECONCILIATION.md`](runbooks/RECONCILIATION.md).

## Verification

```bash
npm run fixtures:vault:check
npm test
```

The fixed suite covers compiler identity, genesis/top-up transaction shape,
fragmented inputs, rolling-window transitions, fee convergence, historical and
future locktime attacks, owner recovery, pre-sign fee denial, durable
ambiguity, restart reconciliation, and shared Purchase/direct-operation policy
capacity.

Live consensus evidence for the integrated Purchase/Treasury path is produced
by the release testnet E2E rather than a second non-journaled vault harness.
Transaction IDs for the release being assessed belong in
[`CURRENT_STATE.md`](../CURRENT_STATE.md) or its generated evidence report.
Historical txids prove only the exact earlier run, not the current package or
mainnet readiness.

## Limitations

- software key files are suitable only for testnet experimentation;
- the consensus cap limits the Agent path but cannot protect against loss of
  the unrestricted owner key;
- direct funds sent to a vault address without the expected covenant binding
  are not treated as spendable vault state;
- backup/restore must preserve the journal, wallet/vault state, and keys as one
  consistent MCP security context;
- this release cannot use mainnet.
