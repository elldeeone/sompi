# Covenant contracts

SilverScript source and compiler-derived fixtures for the covenants shipped by
this package:

- `vault.sil` -> `src/vault/template.ts` (fixtures: `scripts/vault-fixtures.json`)

The npm package has no runtime dependency on SilverScript.
`src/vault/template.ts` keeps small parameterized segment templates so JS
callers can instantiate arbitrary operator parameters. Those segments and
fixtures are checked against upstream `silverc` output.

`sompi-vault-1` is the first public vault template: a covenant-bound singleton
with rolling-window state.

## Checks

1. **Compiler fixture checks.** Regenerate or verify fixtures with:

   ```bash
   SILVERC=/path/to/silverc npm run fixtures:vault:check
   ```

   Or, from a SilverScript checkout:

   ```bash
   SILVERSCRIPT_DIR=/path/to/silverscript npm run fixtures:vault:check
   ```

2. **Offline package smoke.** `npm run build && SOMPI_SMOKE_OFFLINE=1 npm run
   smoke` asserts the JS template produces the committed compiler-derived
   fixtures, vault deposit/top-up aggregate fragmented wallet UTXOs, and
   top-up resets an expired exhausted window instead of extending it.

3. **Integrated testnet evidence.** The release E2E exercises durable
   genesis/top-up, capped withdrawal/staging, recovery, and exact payment
   through the same journaled Treasury path used by Purchase. There is no second
   non-journaled live-send harness.

## When a contract changes

1. Update `contracts/vault.sil`.
2. Compile with current upstream SilverScript and update the segment constants
   in `src/vault/template.ts`.
3. Run `npm run fixtures:vault` to refresh the compiler-derived fixtures.
4. Run the offline and integrated testnet checks above, then record live
   evidence in `CURRENT_STATE.md`.
