# Operator provisioning

`sompi-operator` is the short-lived administrative boundary for the initial
testnet-10 release. Never run it from an Agent or MCP session. Production uses
separate operator/root, trusted `sompi-api`, and untrusted `sompi-mcp` OS users
with one read-only shared IPC group.

## Prepare and review

1. Generate the recovery key offline with `sompi-operator owner-key`. Store the
   private line offline and place only the public line in a copy of
   `operator.example.json`.
2. Set the final absolute runtime data path, HTTPS Merchant allowlist, Treasury
   limits, operator wRPC URL, independent HTTPS witness, Finality Floors, and
   admission budgets.
3. Run `sompi-operator preview SPEC.json`. This validates without generating a
   key or writing runtime state.
4. Run `sompi-operator provision SPEC.json CANDIDATE_DIR`. Record the returned
   digest and vault address. The candidate is not a runtime configuration.
5. Review the canonical `manifest.candidate.json`, receipt, and printed digest.
   Do not fund the address yet.

## Install

As root or the declared operator user, activate exactly the reviewed digest:

```bash
sompi-operator install CANDIDATE_DIR /etc/sompi/operator-manifest.json \
  sha256:REVIEWED_DIGEST OPERATOR_UID API_UID RUNTIME_GID
```

Installation refuses existing runtime or manifest targets. It verifies the
generated Agent key, template, zero-state address, owner key, and static vault
configuration digest before moving runtime state. Runtime state becomes
mode-`0700`/`0600` and MCP-owned. The manifest directory/file become
operator-owned, group-readable, and not writable by MCP.

Check the installed boundary before starting MCP:

```bash
sompi-operator status /etc/sompi/operator-manifest.json OPERATOR_UID RUNTIME_GID
```

Provision the local Purchase API transport separately. The directory is owned
by the trusted API/operator principal and grants the shared runtime group only
traversal; the API creates a `0660` socket inside it. Neither `sompi-api` nor
`sompi-mcp` repairs unsafe directory permissions at startup.

```bash
install -d -o SOMPI_OPERATOR_USER -g SOMPI_RUNTIME_GROUP -m 0750 /etc/sompi
install -d -o SOMPI_OPERATOR_USER -g SOMPI_RUNTIME_GROUP -m 0710 /run/sompi-api
sompi-operator agent-credential \
  /etc/sompi/agent-api.json OPERATOR_UID RUNTIME_GID
```

Configure both processes with `SOMPI_API_SOCKET=/run/sompi-api/purchase.sock`,
`SOMPI_AGENT_API_CREDENTIAL=/etc/sompi/agent-api.json`,
`SOMPI_OPERATOR_UID`, `SOMPI_API_UID`, and `SOMPI_RUNTIME_GID`. `sompi-api`
runs as the declared API UID that owns the installed runtime state;
`sompi-mcp` runs as a different non-root UID in the shared group. The
credential remains operator-owned and group-readable. `SOMPI_API_HOST` and
`SOMPI_API_PORT` are rejected and there is no TCP compatibility path.

The MCP environment contains only the Purchase API socket and least-authority
credential locators, `SOMPI_OPERATOR_UID`, and `SOMPI_RUNTIME_GID`. It does not
receive `SOMPI_OPERATOR_MANIFEST`, Authority, wallet, policy, Merchant, node,
receipt, or finality configuration. The trusted API runtime receives the
operator manifest and distinct Authority deployment locators separately.

## Static drift and recovery

The Journal binds the exact manifest revision/digest before work. Runtime also
re-derives the vault address and static configuration digest at every start.
Never replace a funded vault's owner key, Agent key, cap, window, template, or
initial address. If any static fact must change, use the offline owner recovery
path, create a fresh runtime/manifest target, and fund it only after the full
provisioning and status ceremony passes.
