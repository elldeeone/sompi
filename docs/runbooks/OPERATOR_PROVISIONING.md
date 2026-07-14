# Operator provisioning

`sompi-operator` is the short-lived administrative boundary for the initial
testnet-10 release. Never run it from an Agent or MCP session. Production uses
separate operator/root and `sompi-mcp` OS users with one read-only shared group.

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
  sha256:REVIEWED_DIGEST OPERATOR_UID RUNTIME_UID RUNTIME_GID
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

The MCP environment contains only `SOMPI_OPERATOR_MANIFEST`,
`SOMPI_OPERATOR_UID`, `SOMPI_RUNTIME_GID`, and the distinct Authority deployment
locators. Policy, Merchant, node, receipt, and finality overrides are rejected.

## Static drift and recovery

The Journal binds the exact manifest revision/digest before work. Runtime also
re-derives the vault address and static configuration digest at every start.
Never replace a funded vault's owner key, Agent key, cap, window, template, or
initial address. If any static fact must change, use the offline owner recovery
path, create a fresh runtime/manifest target, and fund it only after the full
provisioning and status ceremony passes.
