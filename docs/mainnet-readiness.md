# Mainnet readiness

Sompi defaults to testnet. Mainnet is disabled unless the operator explicitly
sets:

```bash
SOMPI_ENABLE_MAINNET=1
SOMPI_NETWORK=mainnet
```

Do not enable this casually. Mainnet means real KAS.

## Operator checklist

Before enabling mainnet:

- confirm the agent is running the intended Sompi version
- use a trusted synced node with UTXO index enabled
- set a conservative `SOMPI_POLICY`
- create a vault with an owner key generated on the operator's machine
- store the owner private key offline
- choose a vault cap in KAS that matches the real risk tolerance
- fund only a small regular-wallet float
- move operating funds into the vault with `vault_deposit`
- verify `payment_status` reports ready
- test with a tiny paid request first
- save receipts and txids for audit

## Recommended defaults

For first mainnet trials:

- keep `maxSompiPerTx` low
- keep `maxSompiPerHour` low
- set `requireApprovalAboveSompi` for anything meaningful
- use an allowlist if the agent only pays known endpoints
- keep the vault cap close to the policy cap

The policy is editable. The vault cap is enforced by consensus and cannot be
changed for an existing vault; create a new vault if the hard cap is wrong.

## Recovery

The owner key can recover the vault without agent cooperation.

Use the owner-side script from a trusted machine:

```bash
node scripts/vault-recover.js \
  <ownerPrivateKey> \
  <agentPublic> \
  <maxOutflowSompi> \
  <windowSizeDaa> \
  <windowStartDaa> \
  <spentInWindowSompi> \
  <destination>
```

The values are shown by `vault_status`. The owner private key should never be
sent to the agent.

## User-facing wording

If a user asks to use mainnet before opt-in:

```text
Mainnet is disabled by default because it uses real KAS. I need explicit
operator confirmation before enabling it. If you intend to use real funds, set
SOMPI_ENABLE_MAINNET=1 and configure a conservative policy and vault cap first.
```
