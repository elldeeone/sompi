# Covenant contracts

SilverScript source and compiler-derived fixtures for the covenants shipped by
this package:

- `vault.sil` -> `src/vault/template.ts` (fixtures: `scripts/vault-fixtures.json`)
- `escrow.sil` -> `src/x402/escrow-template.ts` (fixtures: `scripts/escrow-fixtures.json`)

The npm package has no runtime dependency on SilverScript. `src/vault/template.ts`
and `src/x402/escrow-template.ts` keep small parameterized segment templates so
JS callers can instantiate arbitrary operator parameters. Those segments and
fixtures are checked against upstream `silverc` output.

`sompi-escrow-1` is the first public escrow template.
`sompi-vault-1` is the current clean-cutover vault template: a covenant-bound
singleton with rolling-window state.

## Checks

1. **Compiler fixture checks.** Regenerate or verify fixtures with:

   ```bash
   SILVERC=/path/to/silverc npm run fixtures:vault:check
   SILVERC=/path/to/silverc npm run fixtures:escrow:check
   ```

   Or, from a SilverScript checkout:

   ```bash
   SILVERSCRIPT_DIR=/path/to/silverscript npm run fixtures:vault:check
   SILVERSCRIPT_DIR=/path/to/silverscript npm run fixtures:escrow:check
   ```

2. **Offline package smoke.** `npm run build && SOMPI_SMOKE_OFFLINE=1 npm run
   smoke` asserts the JS template produces the committed compiler-derived
   fixtures, vault deposit/top-up aggregate fragmented wallet UTXOs, and
   top-up resets an expired exhausted window instead of extending it.

3. **Live consensus proof.** Re-run the live proof script for the changed
   contract against a Toccata node. For escrow, `scripts/escrow-live.js` proves
   honest claim/refund paths and rejects replay/over-claim attempts. For vault,
   `npm run proof:vault` proves allowed withdrawal, over-window rejection,
   historical-locktime reset rejection, finalized future-locktime reset rejection,
   window reset, top-up, and owner recovery.

## When a contract changes

1. Update the relevant `.sil` file under `contracts/`.
2. Compile with current upstream SilverScript and update the segment constants
   in the matching TypeScript template.
3. Run `npm run fixtures:vault` or `npm run fixtures:escrow` to refresh the
   compiler-derived fixtures.
4. Run the offline and live checks above, then update `docs/escrow-poc.md` with
   live escrow evidence or `docs/vault-poc.md` with live vault evidence.
