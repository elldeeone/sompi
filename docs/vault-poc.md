# SompiVault

Status: retained Testnet-10 treasury component.

SompiVault is a stateful KIP-16 covenant. The API runtime uses the capped Agent
path for Purchase funding. An offline operator key can recover the vault.

The vault limit and Sompi software policy are independent controls. A stolen
Agent payment key cannot bypass the on-chain rolling-window cap, and the API
cannot loosen the operator-owned manifest policy.

## Contract

Source: [`contracts/vault.sil`](../contracts/vault.sil)

Static parameters:

- Agent x-only public key;
- owner recovery x-only public key;
- maximum outflow per window;
- DAA window length.

Mutable state:

- window start DAA;
- amount spent in the active window.

Entrypoints:

- `withdraw`: capped Agent spend with one valid continuation;
- `topup`: add ordinary inputs while preserving valid state;
- `recover`: unrestricted owner-key recovery.

The runtime does not compile SilverScript. It uses compiler-pinned template
bytes and parameterizes only the declared keys, cap, window, and state.

## Runtime ownership

The vault is internal Treasury state owned by `sompi-api`. MCP cannot read its
keys or invoke wallet/vault operations directly.

Before any vault transaction, Sompi durably records the movement, capacity
reservation, fee ceiling, inputs, prepared bytes, transaction identity, and
recovery fence. Purchase execution creates an attempt-bound staging output for
Kaspa-x402; it does not expose an unrestricted signing capability to the
protocol adapter.

The hot wallet is setup and top-up float, not an automatic fallback payment
rail.

## Operator setup

Generate the owner key in a trusted operator context:

```bash
sompi-operator owner-key
```

Keep the private value offline. Put only the public key and desired cap/window
in the provisioning spec, then run the reviewed `preview`, `provision`,
`install`, and `status` ceremony.

Funding and owner recovery are operator actions, not API or MCP agent tools.
Use `sompi-vault-recover` with a mode-`0600` owner-key file for recovery. Never
put the owner key in shell history, chat, MCP arguments, or API state.

## Verification

```bash
npm run fixtures:vault:check
npm test
```

The suite covers compiler identity, genesis/top-up shape, fragmented inputs,
rolling-window transitions, fee convergence, locktime attacks, owner recovery,
durable ambiguity, restart reconciliation, and Purchase policy integration.

## Limits

- software keys are for testnet development;
- loss of the owner key is outside the Agent-path covenant protection;
- direct funds sent without the expected covenant binding are not adopted as
  vault state;
- backup and restore must preserve the complete API runtime state;
- mainnet is disabled.
