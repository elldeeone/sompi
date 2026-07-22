# Covenant contracts

This directory contains the SilverScript source for SompiVault.

| Source | Runtime template | Fixtures |
|---|---|---|
| `vault.sil` | `src/vault/template.ts` | `scripts/vault-fixtures.json` |

The npm package has no runtime SilverScript dependency.
The TypeScript template uses compiler-derived segments and declared parameters.

## SompiVault

`sompi-vault-1` is a stateful KIP-16 covenant on Testnet-10.
It is a singleton with a rolling outflow window.

Static parameters are:

- Agent x-only public key
- owner recovery x-only public key
- maximum outflow in one window
- DAA window length

Mutable state is:

- window start DAA
- amount spent in the active window

The contract has three entrypoints:

- `withdraw` permits one capped Agent spend and one valid continuation.
- `topup` adds ordinary inputs and preserves valid state.
- `recover` permits unrestricted owner-key recovery.

The owner path bypasses the rolling Agent limit.
Keep the owner key offline and use this path only for explicit recovery.

The runtime does not compile SilverScript.
It changes only the declared keys, limit, window, and state.

## Runtime rules

The vault is internal Treasury state owned by `sompi-api`.
The agent and MCP cannot read keys or call vault functions.

Before an Agent or Treasury transaction, Sompi records the intent, reservation, fee limit, prepared bytes, identity, and recovery fence.
The payment adapter receives only an attempt-bound capability.

The emergency `sompi-vault-recover` command broadcasts directly and does not
use the Journal. Vault Migration uses the owner key but remains journaled.
An ordinary direct payment to the vault address has no covenant binding.
Sompi does not adopt that value as active vault state.

The hot wallet is setup and top-up float.
It is not an automatic fallback payment path.

## Checks

Check compiler fixtures:

```bash
SILVERC=/path/to/silverc npm run fixtures:vault:check
```

You can also use a SilverScript checkout:

```bash
SILVERSCRIPT_DIR=/path/to/silverscript npm run fixtures:vault:check
```

Run offline checks:

```bash
npm run build
SOMPI_SMOKE_OFFLINE=1 npm run smoke
npm test
```

The tests cover compiler-derived bytes, state transitions, fees, recovery, restart, and Purchase policy integration.

## Contract change

1. Change `contracts/vault.sil`.
2. Compile it with the reviewed SilverScript compiler.
3. Update `src/vault/template.ts`.
4. Run `npm run fixtures:vault` and verify the committed fixture identity.
5. Run offline and funded Testnet-10 verification.
6. Record verified evidence in `CURRENT_STATE.md`.

Mainnet is disabled.
Loss of the owner key is outside the Agent-path protection.
