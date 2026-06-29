# SompiVault: stateful rolling-window agent vault

**Date:** 2026-06-29 · **Network:** Kaspa testnet-10 (Toccata active) · **Status:** live proof passed

## What this proves

SompiVault is a KIP-16 covenant vault for agent funds. The operator keeps an
unrestricted owner recovery key. The agent gets its own key, but that key can
only withdraw up to `maxOutflowSompi` per `windowSizeDaa` rolling DAA window.
The cap counts withdrawal amount plus fee, and the remaining balance must
continue back into the same singleton covenant with updated state.

This is consensus enforcement, not an MCP policy promise. If the agent key is
stolen, the attacker still has to satisfy the vault script on-chain.

## Current contract

Source: [`contracts/vault.sil`](../contracts/vault.sil)

The static parameters are:

- `agent`: x-only public key allowed to spend through the capped path
- `owner`: x-only public key allowed to recover everything
- `maxOutflow`: maximum amount plus fee per rolling window
- `windowSize`: DAA window size

The mutable state is:

- `windowStart`: DAA score where the active window began
- `spentInWindow`: cumulative outflow in the active window

Entrypoints:

- `withdraw(sig agentSig)` requires the agent signature, one covenant input,
  sequence `0`, one covenant continuation output, a valid next state, and
  `spentInWindow + outflow <= maxOutflow`. The sequence check keeps the spend
  non-final, so a compromised agent key cannot use a finalized future-locktime
  transaction to reset the window early. A reset also requires the active vault
  UTXO's own DAA score to have aged at least one full window, so historical
  locktimes cannot be chained through fresh continuation outputs.
- `topup(sig agentSig)` merges regular wallet funds into the current singleton
  vault UTXO. It preserves active state, but if the saved window and active
  vault UTXO are already reset-eligible it starts a fresh zero-spent window
  instead of carrying exhausted state into the new top-up output.
- `recover(sig ownerSig)` lets the owner drain the current vault address without
  agent cooperation.

## Runtime shape

The package has no runtime SilverScript dependency. The TypeScript template in
[`src/vault/template.ts`](../src/vault/template.ts) is derived from compiler
output and parameterized by the operator's keys, cap, window, and state.

The first `vault_deposit` creates a genesis covenant-bound UTXO. Later
`vault_deposit` calls top up that same singleton. Both paths aggregate regular
wallet UTXOs when the wallet balance is fragmented. `vault_send` spends the
current vault UTXO, advances the state, derives the next vault address, and saves
the new outpoint. Owner recovery reconstructs the current vault address from
public parameters plus state.

## Checks

Compiler-derived fixture check:

```bash
SILVERC=/path/to/silverc npm run fixtures:vault:check
```

Offline package smoke:

```bash
npm run build
SOMPI_SMOKE_OFFLINE=1 npm run smoke
```

Live consensus proof:

```bash
npm run build
SOMPI_NODE_URL=10.0.3.26 npm run proof:vault
```

The live proof exercises:

1. genesis covenant-bound deposit accepted on-chain
2. agent withdrawal inside the active window accepted on-chain
3. deliberately over-window withdrawal rejected by consensus
4. historical locktime reset attempt rejected by the covenant
5. finalized future-locktime reset attempt rejected by the covenant
6. singleton top-up accepted on-chain
7. second withdrawal accepted after the DAA window resets
8. owner recovery accepted on-chain

The recovery file printed by `proof:vault` contains temporary testnet keys and
the latest vault config so funds can be recovered if the harness exits early.

## Latest live evidence

Run:

```bash
SOMPI_NODE_URL=10.0.3.26 npm run proof:vault
```

Parameters:

- `maxOutflowSompi`: `100000000`
- `windowSizeDaa`: `300`
- first withdrawal: `40000000` sompi
- top-up: `50000000` sompi
- second withdrawal after reset: `40000000` sompi

Results:

| Step | Result | Evidence |
|---|---|---|
| Genesis covenant-bound deposit | Accepted | `642e828a7cbcc6118d13c741f1f1e5c1141eff1406e157b0e588cfc2fc3b5fdb` |
| Agent withdrawal inside active window | Accepted | `88c006bdffb5798c738e5880d6af92ce762f0181a29f55ae93ab9819a2c57382` |
| Agent over-window withdrawal | Rejected by node consensus | attempted tx `d73c38beb99ab4220b5dac6e537199e62da50a4885e4b7eac5b1d70557b1213c` |
| Historical locktime reset | Rejected by covenant | attempted tx `5e5d0fcfead8dfe3075cad170b3a99cfa3fa8c915c0b63de3168afbbb8f0100d` |
| Finalized future-locktime reset | Rejected by covenant | attempted tx `02d18eda06bf5a1f2eb388315a6c4a96ae5f0f0be80f9885ed8a1a37fdf2da5f` |
| Singleton top-up | Accepted | `e2906c9416589e7cb275502b5c5deba3e4a83f5cb4e7f3e691602cde54469dda` |
| Agent withdrawal after window reset | Accepted | `1ff5d74e2585334bc8840b10732b1d4514c78bfca0e47ce3009247eeb589d356` |
| Owner recovery | Accepted | `1f95baff89d8c43fa42ec0d8317b2b1c406cee92bda3c81ea4d6317b9d780980` |

The reset target was DAA `503581392`; the proof waited until DAA `503581397`
so the node enforced both non-final input locktime and active-input-age gating
before the reset spend.
