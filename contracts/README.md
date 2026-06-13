# Covenant contracts

The SilverScript sources describing the covenants whose compiled output is
byte-pinned into this package:

- `vault.sil` → `src/vault/template.ts` (fixtures: `scripts/vault-fixtures.json`)
- `escrow.sil` → `src/x402/escrow-template.ts` (fixtures: `scripts/escrow-fixtures.json`)

**These `.sil` files are reference descriptions of the intended semantics, not a
build input.** sompi has no build-time or runtime dependency on SilverScript —
the templates are hand-pinned opcode bytes (see the disassembly in each
`*-template.ts`).

## How correctness is established

There are two independent checks:

1. **On-chain proof (the real one).** The covenants are exercised against a live
   Toccata node — every rule that matters must be confirmed by the node
   *accepting* the legitimate spend and *rejecting* the illegitimate one:
   - vault: `vault-driver selftest` / [docs/vault-poc.md](../docs/vault-poc.md)
   - escrow: `scripts/escrow-live.js` / [docs/escrow-poc.md](../docs/escrow-poc.md)
     (honest claim accepted; **voucher replay/drain rejected**; over-claim
     rejected; refund accepted; rerun after any escrow byte-template change)
2. **Offline regression guard.** `npm run smoke` asserts the template modules
   still produce the exact pinned bytes in `scripts/*-fixtures.json`. This
   catches accidental drift; it does *not* by itself prove the bytes are
   correct — only a fresh on-chain proof for the current bytes does.

> Note on the escrow template: `escrow.sil` is reference semantics only. The
> deployed script signs/verifies a full context message:
> `domain ‖ network ‖ sha256(serializedInputScriptPubKey) ‖ outpointTxId ‖ outpointIndex_le32 ‖ amount_le64`.
> Current SilverScript work can lower `checkDataSig` to `OpCheckSigFromStack`
> and exposes the relevant input-introspection fields, but sompi does not yet use
> SilverScript compiler output as the escrow byte-template oracle. Until that
> source-level v3 artifact is wired and proven, the authoritative bytes are the
> hand-pinned `escrow-template.ts` bytes and must be validated with the live
> proof harness. The `0xd7` (`OpCheckSigFromStack`) and `0x7e` (`OpCat`) opcodes
> are the consensus opcodes this template relies on.

## When a contract changes

1. Update the segment constants (and the disassembly comment) in the relevant
   `*-template.ts`, and bump its `*_TEMPLATE_VERSION`.
2. Regenerate the fixtures from the template, e.g.:
   `node -e 'const fs=require("fs"),t=require("./dist/x402/escrow-template");…'`
   (the escrow fixtures carry `client`/`server`/`timeout` plus the dummy-arg
   encodings; recompute `redeemScript`/`claimArgsWithDummies`/`refundArgsWithDummySig`).
3. **Re-run `scripts/escrow-live.js` against a testnet node** and confirm all
   checks pass — this is the step that actually validates the new bytes.
