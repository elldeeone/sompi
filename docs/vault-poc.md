# SompiVault proof-of-concept: consensus-enforced agent spending limits

**Date:** 2026-06-11 · **Network:** Kaspa testnet-10 (Toccata active) · **Status:** all proofs passed

## What was proven

A KIP-16 covenant vault whose spending limit is enforced by Kaspa consensus
rather than wallet software. The agent key can withdraw at most 1 KAS per
transaction (withdrawal + fee), with the remainder forced back into the
vault; the owner key is unrestricted.

Contract: [`vault-driver/vault.sil`](https://github.com/elldeeone/silverscript/tree/toccata-docs/vault-driver)
(SilverScript, ~30 lines), compiled to a 117-byte P2SH script.

Vault address: `kaspatest:pq0cxnn290flgkuu42ku28taaa9wc3w6luq3pjh7z295qn4mg8newq2f7tupk`

## The three on-chain proofs

| # | Action | Result | Evidence |
|---|---|---|---|
| 1 | Agent withdraws 0.5 KAS (outflow 0.52 ≤ 1 KAS cap) | **Accepted** | txid `659202ec34e432ebd3e349dddcd141b0476cae828a8780b027c824315e56cc1c` |
| 2 | Agent attempts 2 KAS withdrawal (outflow 2.02 > cap) | **Rejected by the node**: `failed to verify the signature script: script ran, but verification failed` | tx `5b6e7dff…` never entered the mempool |
| 3 | Owner recovers full remaining balance | **Accepted** | txid `caebd325964e58e96b2f7e986de1b448351b04537ec168d25cd38ecafd4295cc` |

Proof 2 is the point: the signature was valid, the transaction well-formed —
only the covenant said no. A fully compromised agent key faces the same
limit the agent does, enforced by every node on the network.

Local consensus-VM selftests additionally covered: redirected-change drain
attempt (rejected) and agent attempting the owner recovery path (rejected).
Run them with `vault-driver selftest 100000000`.

## How it works

```
contract SompiVault(pubkey agent, pubkey owner, int maxOutflow) {
    entrypoint function withdraw(sig agentSig) {
        require(checkSig(agentSig, agent));
        require(tx.outputs.length == 2);
        byte[] vaultScriptPubKey = tx.inputs[this.activeInputIndex].scriptPubKey;
        require(tx.outputs[1].scriptPubKey == vaultScriptPubKey);   // change returns to vault
        int inputValue = tx.inputs[this.activeInputIndex].value;
        require(tx.outputs[1].value >= inputValue - maxOutflow);    // outflow capped
    }
    entrypoint function recover(sig ownerSig) {
        require(checkSig(ownerSig, owner));
    }
}
```

Tooling split:

- **Rust** (`vault-driver` in the [silverscript fork](https://github.com/elldeeone/silverscript)):
  compiles the contract, derives the P2SH address, builds the entrypoint
  signature script via the compiler's own `build_sig_script` (which handles
  entrypoint selection and argument encoding), computes the Schnorr sighash,
  and emits the signed transaction as JSON.
- **JS** (`scripts/submit-tx.js` here): converts the JSON and submits via wRPC.

Notes for reproducing:

- v0 transactions with `sigOpCount: 1` per input — post-Toccata sigops are
  runtime-counted, and each vault path executes exactly one `OpCheckSig`.
- The engine runs covenant/introspection opcodes for P2SH spends without any
  v1-transaction requirement.
- The change output returning to the vault is itself a P2SH output — standard,
  relayable, no special handling.
- Mainnet gets these consensus rules at DAA 474,165,565 (~2026-06-30); the
  same artifacts work there unchanged (test first; tooling is experimental).

## What's next (Phase 3 proper)

- Rolling spend windows via covenant state (the `#[covenant]` declaration
  layer) instead of a flat per-transaction cap.
- Integrate vault spends into the sompi MCP server (`send_payment` from a
  vault-backed wallet).
- Sweep/top-up lifecycle management.
