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

In MCP mode, `paid_fetch` uses this same capped agent path to fund new
`kaspa-escrow` deposits. The ordinary wallet remains setup/top-up working float;
active paid API escrow channels must be vault-funded. `npm run proof:phase5`
exercises this end to end and writes a recovery file before spending.

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
SOMPI_NODE_URL=10.0.3.26 SOMPI_PHASE5_LIVE_FUNDER_PRIVATE_KEY=<funded-testnet-key> npm run proof:phase5
```

Use a synced node with UTXO index enabled. The Phase 5 proof writes a mode-0600
recovery file with disposable testnet keys before spending so interrupted runs
can be resumed or recovered.

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
| Genesis covenant-bound deposit | Accepted | `15815f4ddefe61e8f0e155632f762be72bae60f9528b794fc0ff5a87985c68fb` |
| Agent withdrawal inside active window | Accepted | `c67cf554ec7d84a8b631d2225a5fe6037a08bf22b753917fdc82cd7856bb7a9b` |
| Agent over-window withdrawal | Rejected by covenant script | attempted tx `8b2288eb80013c7b75ff284bb9e6bd6c8f0c231742400dc1203f7bb08767ecf2` |
| Historical locktime reset | Rejected by covenant script | attempted tx `98c2088aa5ce6ef6f3bf7339e1e22bc6a1d73d24614f97d625dd16cbe560a3b4` |
| Finalized future-locktime reset | Rejected by covenant script | attempted tx `b89beb589f3fb8802463e76a0e27747a5e16ea01d49e3c4f34e8b56b3b6726b3` |
| Singleton top-up | Accepted | `83f812db99d331d6ce6862c6df84d4619d21999fff533d30a8db52ba752e74c4` |
| Agent withdrawal after window reset | Accepted | `c5eac251b4297fef449c98ba1ab8f7fe67e206b862e736da7735da53a5387b67` |
| Owner recovery | Accepted | `7b1fa5ce830b2821b8a36cf80b87a66e8fd085788cf1eb998b45065f1fff261e` |

The reset target was DAA `503605037`; the proof waited until DAA `503605040`
so the node enforced both non-final input locktime and active-input-age gating
before the reset spend.
