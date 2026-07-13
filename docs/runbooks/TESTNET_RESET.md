# Non-destructive testnet reset

Status: initial testnet-10 operator runbook

A reset creates a new, isolated testnet-10 runtime while retaining the old
runtime unchanged for audit, rollback, and fund recovery. It is suitable for a
deliberate fresh test cycle. It is not a way to repair corruption, erase policy
history, abandon an ambiguous transaction, or make an unresolved Purchase
disappear.

Mainnet is unsupported. Do not adapt this procedure to mainnet.

## Hard stop conditions

Do not reset while any old-runtime fact is unresolved, including:

- a Purchase in `execution_prepared`, `submitted`, `failed_recoverable`, or any
  state requiring Merchant, exact-payment, fulfilment, receipt, or staging
  reconciliation;
- an observed staging output without a final exact or recovery winner;
- a direct Treasury Movement in `prepared`, `submission_planned`, `submitted`,
  `observed`, or uncertain terminal state;
- an in-flight Reservation, live effect claim, pending recovery sweep, or
  uncertain vault continuation;
- database, evidence, prepared-byte, key-store, or history corruption;
- an unknown balance or vault outpoint that the operator intends to retain.

Use [`RECONCILIATION.md`](RECONCILIATION.md),
[`STAGING_RECOVERY.md`](STAGING_RECOVERY.md), or the corruption procedure in
[`JOURNAL.md`](JOURNAL.md) first. If the operator cannot prove that every known
Purchase and `operationKey` is terminal, do not reset. The initial MCP surface
does not provide a bulk history-list command, so the operator's identity log is
part of this check.

## Reset scope

`SOMPI_DATA_DIR` contains one MCP security context:

- the Purchase Journal and its evidence/prepared stores;
- wallet and consensus-vault configuration/signing material;
- staging keys;
- authority-client replay state.

A clean reset creates all of those together in a new empty directory. Do not
copy selected wallet, vault, SQLite, WAL, staging-key, evidence, or replay files
between the old and new trees. Partial reuse breaks durable bindings.

The separate Trusted Authority private directory is not reset merely because
MCP state is reset. It may retain its signer, decision history, replay history,
MAC server copy, and public trust roots. Rotate it only through
[`AUTHORITY.md`](AUTHORITY.md); retain old public keys needed to verify old
Purchase evidence.

## Pre-reset record

Before stopping the old runtime, record:

- Sompi package version and Git commit;
- exact old `SOMPI_DATA_DIR`, network, node endpoint identity, and policy digest;
- wallet receive address and observed balance;
- `vault_status`, active vault outpoint, balance, cap/window state, and owner
  public key;
- every retained Purchase ID/request key and direct Treasury `operationKey`;
- terminal transaction IDs/outpoints, finality, evidence digests, and any funds
  intentionally left in the old wallet or vault.

Read each known Purchase with `purchase_status` and each direct operation with
`treasury_operation_status`. Resolve anything non-terminal before continuing.
Treat `not found` in an operator notebook or explorer as missing evidence, not
as proof that an operation never happened.

## Preserve the old runtime

1. Stop accepting Agent calls.
2. Terminate `sompi-mcp` normally and confirm no process holds the old journal.
3. Stop the authority for the backup window so the recovery point is clearly
   recorded, even when its private state is not being rotated.
4. Make and verify a complete MCP backup using [`JOURNAL.md`](JOURNAL.md).
   Back up authority private state separately using [`AUTHORITY.md`](AUTHORITY.md).
5. Leave the old data directory in place, owned by `sompi-mcp`, mode `0700`, and
   read-only operationally. Do not rename files inside it, delete WAL/SHM files,
   or run SQLite repair tools.

The safest reset uses a new absolute path rather than renaming or deleting the
old path. For example, as root:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NEW_DATA_DIR=/var/lib/sompi-mcp/testnet-10-reset-$STAMP
install -d -o sompi-mcp -g sompi-mcp -m 0700 "$NEW_DATA_DIR"
printf '%s\n' "$NEW_DATA_DIR"
```

Record the printed path in the reset log. Do not use a symlink. Create and
install a fresh Operator Manifest whose `dataDirectory` is this exact new path.

## Initialize and validate the new runtime

1. Provision the same reviewed Sompi release with a fresh Operator Manifest,
   a synced UTXO-indexed testnet-10 node, and the independent HTTPS witness.
2. Start the existing Trusted Authority through its normal isolated-user
   ceremony and rerun the isolation verifier before Agent access.
3. Run `payment_status`, `network_status`, and `get_address`. Confirm the new
   wallet address, empty/new journal, intended policy limits, authority identity,
   and testnet-10 network.
4. Generate a fresh offline owner key with `sompi-operator owner-key`; retain
   the private half offline. The `provision`/`install` ceremony creates the
   Agent key and vault configuration before MCP starts. Fund it only through a
   durable `vault_deposit` with a new stable `operationKey`.
5. Fund only with testnet KAS and verify every deposit/send to completion before
   beginning a Purchase.
6. Use a new reset-cycle namespace for request and operation keys so operator
   records cannot confuse old and new identities.

Do not copy the old hot-wallet key, vault-agent key, vault configuration,
staging keys, or journal into the new tree. If the purpose is only to restore a
known-good runtime with the same identities, follow the restore procedure in
`JOURNAL.md` instead; that is not a reset.

## Moving testnet funds

Prefer fresh faucet or operator-controlled testnet funding for the new wallet.
If old hot-wallet funds must be transferred, temporarily run the old runtime
against its unchanged data directory and use its journaled `send_payment` with
a stable `operationKey` to the already-recorded new address. Wait for the old
operation to reach `completed`, stop the old runtime again, and record both
transaction identities before switching back.

Vault funds require a separate deliberate decision:

- keep the old runtime and offline owner key available for later owner recovery;
- use the old runtime's journaled Agent path only while its policy/covenant
  limits and state permit; or
- use the packaged owner-recovery utility in a trusted operator context as
  documented in [`../vault-poc.md`](../vault-poc.md).

Never transfer funds by copying private keys into the new runtime or by deleting
the old state after observing only a mempool transaction.

## Cutover and rollback

After the new runtime's readiness, wallet, vault, and funding checks pass:

1. stop both old and new MCP processes;
2. confirm the launcher contains only the new absolute `SOMPI_DATA_DIR`;
3. start one new MCP process and confirm its status before reconnecting the
   Agent;
4. retain the old directory, backup checksum, version, identity log, and
   authority public verification keys.

To roll back, stop the new runtime and point the launcher back to the exact old
directory using its exact recorded Sompi version. Let startup validation and
reconciliation run before any state-changing tool. Never merge the two
journals, wallets, vaults, evidence stores, or staging-key directories.

## Retention and cleanup

There is no automatic deletion step. Keep the old tree and backup until:

- every old Purchase, Receipt, direct Treasury Movement, staging output, and
  vault outpoint is terminal and independently accounted for;
- every required evidence artifact remains verifiable with retained trust keys;
- every intentionally retained testnet balance is recovered or explicitly
  abandoned by the operator; and
- the operator's retention policy permits deletion.

When eventual deletion is authorized, perform it as a separate reviewed
operator action. A successful new test cycle alone is not evidence that the old
state is safe to destroy.
