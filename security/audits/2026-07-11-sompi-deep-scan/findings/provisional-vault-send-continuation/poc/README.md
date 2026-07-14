# Provisional vault-send continuation PoC

This PoC exercises the production `VaultManager` implementation from Sompi
revision `4ebb82d4f82bac46ae3addd112c4752f29630a8a`. A synthetic Kaspa RPC first
returns the two exact outputs of a signed vault send with
`blockDaaScore=0`. Sompi accepts and durably commits the continuation. The RPC
then removes those outputs and exposes the still-unspent original source.
Reconciliation reports `not_submitted`, while a restarted `VaultManager`
continues to load the vanished continuation outpoint.

The harness does not contact a Kaspa node, broadcast a transaction, or use
real funds. `prepare-target.sh` needs network access only to clone the source
and install its pinned dependencies.

## Requirements

- Git
- Node.js 22 or newer
- npm

## Run

From this `poc` directory:

```sh
sh prepare-target.sh
sh run.sh
```

`prepare-target.sh` clones the public repository into `target`, checks out the
exact revision, installs from its lockfile, and builds it. `run.sh` creates a
temporary local runtime and removes it after the assertions pass.

For an existing clean build of the exact revision, skip preparation and set
`SOMPI_TARGET` to that build's repository root:

```sh
SOMPI_TARGET=relative/path/to/sompi sh run.sh
```

Set `KEEP_POC_RUNTIME=1` to retain the generated temporary runtime for manual
inspection. It contains disposable private keys and should be deleted after
inspection. Delete `target` to remove the prepared source and dependencies.

## Expected result

The final line is:

```text
[+] vulnerability reproduced
```

See `representative-output.txt` for a complete successful run. Transaction
identifiers vary because the harness generates fresh disposable vault keys.
