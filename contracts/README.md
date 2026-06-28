# Covenant contracts

SilverScript source and compiler-derived fixtures for the covenants shipped by
this package:

- `vault.sil` -> `src/vault/template.ts` (fixtures: `scripts/vault-fixtures.json`)
- `escrow.sil` -> `src/x402/escrow-template.ts` (fixtures: `scripts/escrow-fixtures.json`)

The escrow template is now sourced from `escrow.sil`. The npm package still has
no runtime dependency on SilverScript; `src/x402/escrow-template.ts` keeps a
small parameterized segment template so JS callers can instantiate arbitrary
client/server/network/timeout values. Those segments and fixtures are checked
against upstream `silverc` output.

`sompi-escrow-1` is the first public escrow template.

## Checks

1. **Compiler fixture check.** Regenerate or verify escrow fixtures with:

   ```bash
   SILVERC=/path/to/silverc npm run fixtures:escrow:check
   ```

   Or, from a SilverScript checkout:

   ```bash
   SILVERSCRIPT_DIR=/path/to/silverscript npm run fixtures:escrow:check
   ```

2. **Offline package smoke.** `npm run build && SOMPI_SMOKE_OFFLINE=1 npm run
   smoke` asserts the JS template produces the committed compiler-derived
   fixtures.

3. **Live consensus proof.** Re-run `scripts/escrow-live.js` against a Toccata
   node after any escrow contract/template change. This is the proof that the
   node accepts the honest paths and rejects voucher replay/over-claim attempts.

## When escrow changes

1. Update `contracts/escrow.sil`.
2. Compile with current upstream SilverScript and update the segment constants
   in `src/x402/escrow-template.ts`.
3. Run `npm run fixtures:escrow` to refresh `scripts/escrow-fixtures.json`.
4. Run the offline and live checks above, then update `docs/escrow-poc.md` with
   the live proof evidence for the new `ESCROW_TEMPLATE_VERSION`.
