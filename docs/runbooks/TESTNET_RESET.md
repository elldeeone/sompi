# Non-destructive Testnet-10 reset

A reset starts a new isolated API runtime and keeps the old state intact. It is
not a repair for corruption or ambiguous payment state.

Mainnet is unsupported.

## Do not reset when

- a Purchase is prepared, submitted, recoverable, or otherwise unresolved;
- staged value has no proven exact-payment or recovery winner;
- an additive head or batch claim/refund is ambiguous;
- an external effect or policy reservation may still be live;
- the Journal, evidence, prepared bytes, or key store is corrupt;
- the operator has not accounted for retained wallet or vault funds.

Run Purchase reconciliation first. If the state is corrupt, follow the Journal
runbook instead.

## Record the old runtime

Capture:

- Sompi version and Git commit;
- Operator Manifest revision, digest, and data directory;
- wallet address and known balance;
- vault address, active outpoint, balance, cap, window, and owner public key;
- every retained Purchase ID and terminal transaction/outpoint;
- evidence digests and funds intentionally left behind.

Read each known Purchase through the operator status API. Every possible
external effect must be terminal or deliberately preserved before proceeding.

## Preserve it

1. Stop Agent traffic and MCP.
2. Stop `sompi-api` normally.
3. Stop Authority for the backup window.
4. Back up API state using [`JOURNAL.md`](JOURNAL.md).
5. Back up Authority state separately using [`AUTHORITY.md`](AUTHORITY.md).
6. Leave the old API data directory unchanged and operationally read-only.

Do not delete WAL files, move individual keys, or copy selected state into the
new runtime.

## Create the new runtime

1. Choose a new absolute data directory owned by `sompi-api`, mode `0700`.
2. Generate a new offline owner key if the vault identity is changing.
3. Create a fresh provisioning spec from `operator.example.json`.
4. Run `sompi-operator preview`, `provision`, `install`, and `status`.
5. Install fresh Agent and operator-recovery API credentials.
6. Start Authority, then API, then MCP.
7. Verify Testnet-10 node/witness identity and the new manifest-bound wallet and
   vault facts before funding.

The new runtime must not reuse the old Journal, wallet key, vault Agent key,
staging keys, evidence store, prepared store, or Authority-client replay state.

## Funding

Use fresh testnet funding or a reviewed operator transfer. There is no agent or
MCP wallet-send surface in the clean-cutover API.

Vault funds in the old runtime require one explicit choice:

- retain the old runtime and owner key for later recovery; or
- use `sompi-vault-recover` from a trusted operator context.

Do not copy private keys into the new runtime or treat a mempool transaction as
final.

## Cut over

1. Stop old and new services.
2. Confirm the launcher references only the new Operator Manifest and API data
   directory.
3. Start Authority, API, and MCP for the new runtime.
4. Confirm API status and exact identity before reconnecting the agent.
5. Retain the old directory, backup digest, version, manifest, and public trust
   keys.

Rollback means stopping the new runtime and restarting the exact old version,
manifest, and state tree. Never merge the two runtimes.

## Delete only after

- all old Purchases and protocol effects are terminal;
- every old wallet/vault balance is recovered or explicitly abandoned;
- all retained evidence remains verifiable; and
- the operator retention policy permits deletion.

Deletion is a separate reviewed action. A successful new test cycle is not
proof that old state is safe to destroy.
