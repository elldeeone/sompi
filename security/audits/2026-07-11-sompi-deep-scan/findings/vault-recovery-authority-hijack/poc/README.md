# Vault recovery-authority hijack PoC

This PoC demonstrates the vulnerable trust-boundary transition without funding
a vault or connecting to Kaspa. It loads a built Sompi source tree, registers
the real MCP tools, invokes the real `vault_create` handler with a
demonstration key controlled by the caller, and reopens the temporary durable
configuration to confirm that the caller became `ownerPublic`.

## Requirements

- Node.js 22 or later
- GNU Make (optional)
- a checkout of the affected Sompi source at revision
  `4ebb82d4f82bac46ae3addd112c4752f29630a8a`
- that checkout's dependencies and compiled `dist/` tree

## Build and run

From this `poc/` directory, set a relative path to the Sompi checkout:

```sh
export SOURCE_ROOT=../../../sompi
npm --prefix "$SOURCE_ROOT" ci
npm --prefix "$SOURCE_ROOT" run build
node ./vault-recovery-authority-hijack.mjs --source-root "$SOURCE_ROOT"
```

Or use the convenience target after building the source:

```sh
make SOURCE_ROOT=../../../sompi
```

The program exits nonzero only for setup/import/runtime failures. A fixed build
can return a successful diagnostic with `"vulnerable": false` when
`vault_create` is absent or rejects the assignment.

## Safety and cleanup

The PoC uses a deterministic, public demonstration private key. Never send
funds to any address derived during this test. It does not instantiate an RPC
client, contact a node, construct a recovery transaction, or broadcast. It
creates a temporary local vault directory under the operating system's normal
temporary directory and removes it in a `finally` block.

## Expected result

On the affected revision, the output matches
`representative-output.txt`: the real handler accepts the attacker-selected
public key and the persisted configuration contains that exact key. On a fixed
revision, `vault_create` should preferably be absent from the MCP tool set.
