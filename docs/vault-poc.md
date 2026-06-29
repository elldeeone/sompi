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
  transaction to reset the window early.
- `topup(sig agentSig)` merges regular wallet funds into the current singleton
  vault UTXO without changing state.
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
4. finalized future-locktime reset attempt rejected by the covenant
5. singleton top-up accepted on-chain
6. second withdrawal accepted after the DAA window resets
7. owner recovery accepted on-chain

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
| Genesis covenant-bound deposit | Accepted | `f5f5a12ecef4bf39de39f32915d2de4788fab4c42392a9ab86e4499346196efb` |
| Agent withdrawal inside active window | Accepted | `402f81696a2e510649475cdbf94e5ff621697098d79ca8f5bfd629f93ece1d8d` |
| Agent over-window withdrawal | Rejected by node consensus | attempted tx `525785efe0dd3e7bf4f72431c3a39f50289854362ecc60c9a748f39a23afdde2` |
| Finalized future-locktime reset | Rejected by covenant | attempted tx `548f7fecdcf470e4b7958cbf6284d9a08ccd99abe8b68cdae89dcdb050349b0c` |
| Singleton top-up | Accepted | `ed203335155d79a8a6993ef6233b3f2cd8c759885296f1fd3df1b5b0c5118371` |
| Agent withdrawal after window reset | Accepted | `32ee77ad99a5172e6f330de7666d3ee9a345c594910a44481ebb5aefae2d6309` |
| Owner recovery | Accepted | `d3f8eb67911f124fe783caca1839171ed7018b246a10fa762e3de07f8e48d7d9` |

The reset target was DAA `503379797`; the proof waited until DAA `503379799`
so the node enforced the non-final input locktime before the reset spend.
