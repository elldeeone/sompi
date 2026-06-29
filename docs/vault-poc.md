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
| Genesis covenant-bound deposit | Accepted | `df35d67db329aee339ad0eb86db6e986ed818622b1390c8a8098e56d320e3fe3` |
| Agent withdrawal inside active window | Accepted | `cecb02f777929a02d2eb459be683887da4f6c7c7e44cb7efc6b32aa78818d5c9` |
| Agent over-window withdrawal | Rejected by node consensus | attempted tx `019cd8e520426cb63c74433169a7053f5fa6153d7f2d6d25b81488abd1392075` |
| Finalized future-locktime reset | Rejected by covenant | attempted tx `b82d525d82db46db01c2c9e26bc662cf41140c2af267e45e1955b4af65fc75c2` |
| Singleton top-up | Accepted | `f56ed0fd04556b475417f28604244e64c3f7d36cf94d32e9f87b5677c3bc4f3e` |
| Agent withdrawal after window reset | Accepted | `f55c00d427c486ed1a6eec30355a065f12fd15439bb6c85f7db8247e92a356cb` |
| Owner recovery | Accepted | `ae5e198e425e482d0c23c0d15b00c5ba1c379d5413fd898be00f33f9523812b5` |

The reset target was DAA `503368664`; the proof waited until DAA `503368665`
so the node enforced the non-final input locktime before the reset spend.
