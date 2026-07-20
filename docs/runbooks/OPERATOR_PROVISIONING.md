# Operator provisioning

`sompi-operator` is the short-lived administrative boundary for the initial
testnet-10 release. Never run it from an Agent or MCP session. Production uses
separate operator/root, trusted `sompi-api`, and untrusted `sompi-mcp` OS users.
The Agent-facing socket uses the selected Agent principal's group; the protected recovery socket
uses a different operator-only group.

## Host bootstrap

Use `host-bootstrap.example.json` for a new Hermes host. It contains no
secrets. Set the OS user, Telegram IDs, trusted TN10 node, Merchant allow rules,
and spending limits, then preview it:

```bash
npm exec --yes --allow-scripts=better-sqlite3@12.11.1 \
  --package=@elldeeone/sompi@0.11.4 -- \
  sompi-operator bootstrap-preview REQUEST.json
```

Review the complete output. Run its exact `nextCommand` in a local terminal.
The privileged command asks for the Telegram token with input hidden, installs
the pinned package and host boundaries, starts the services, and writes the
owner recovery record below `/root`. The Agent must not run this command or
read either secret.

The `ready` receipt returns the stable Testnet-10 receive address, minimum
funding amount, and exact `activateCommand`. Send funds only to that address,
then run `activateCommand` locally once. It stops the API, journals and reconciles
one covenant deposit as the API principal, restarts the API, and returns the
active vault covenant/outpoint. Future deposits to the receive address are
secured automatically. Never send ordinary funds directly to the P2SH
vault address: that does not create its covenant binding.

The remaining sections document the lower-level primitives used by the
bootstrap and are for recovery or manual inspection.

## Manual prepare and review

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
mode-`0700`/`0600` and API-owned. The manifest becomes operator-owned,
group-readable by the API runtime, and not writable by API or MCP.

Check the installed boundary before starting the API:

```bash
sompi-operator status /etc/sompi/operator-manifest.json OPERATOR_UID RUNTIME_UID RUNTIME_GID
```

Provision both local Sompi API transports separately. Each directory is
owned by the trusted API/operator principal and grants only its declared group
traversal; the API creates one `0660` socket inside each. Neither `sompi-api`
nor `sompi-mcp` repairs unsafe directory permissions at startup.

```bash
install -d -o SOMPI_OPERATOR_USER -g SOMPI_RUNTIME_GROUP -m 0750 /etc/sompi
install -d -o SOMPI_API_USER -g SOMPI_RUNTIME_GROUP -m 0710 /run/sompi-api
install -d -o SOMPI_API_USER -g SOMPI_RECOVERY_GROUP -m 0710 /run/sompi-recovery
sompi-operator agent-credential \
  /etc/sompi/agent-api.json OPERATOR_UID RUNTIME_GID
sompi-operator recovery-credential \
  /etc/sompi/recovery-api.json OPERATOR_UID RECOVERY_GID
```

Configure `sompi-api` with
`SOMPI_API_SOCKET=/run/sompi-api/sompi.sock`,
`SOMPI_AGENT_API_CREDENTIAL=/etc/sompi/agent-api.json`,
`SOMPI_RECOVERY_API_SOCKET=/run/sompi-recovery/recovery.sock`,
`SOMPI_RECOVERY_API_CREDENTIAL=/etc/sompi/recovery-api.json`,
`SOMPI_OPERATOR_UID`, `SOMPI_API_UID`, `SOMPI_RUNTIME_GID`, and
`SOMPI_RECOVERY_GID`. The process refuses payment-capable startup unless both
listeners bind securely. The recovery listener accepts only status and recover,
and its pool is independent of Agent admission.

`sompi-mcp` receives only the Agent socket variables and runs as a different
non-root UID in the shared runtime group. It never receives the recovery socket,
group, or credential. Both credentials remain operator-owned and readable only
by their intended group. `SOMPI_API_HOST` and `SOMPI_API_PORT` are rejected and
TCP is disabled.

The MCP environment contains only the Agent Sompi API socket and least-authority
credential locators, `SOMPI_OPERATOR_UID`, and `SOMPI_RUNTIME_GID`. It does not
receive `SOMPI_OPERATOR_MANIFEST`, Authority, wallet, policy, Merchant, node,
receipt, or finality configuration. The trusted API runtime receives the
operator manifest and distinct Authority deployment locators separately.

## Change vault protection

Ordinary spending limits change through the trusted approval chat. Vault
protection is stronger: it is enforced by the funded SilverScript vault and
therefore requires an owner-signed replacement.

1. The user asks the Agent for the new protection maximum.
2. The Agent runs `sompi-agent change-vault-protection` and the trusted chat
   approves or denies the exact old and new limits.
   Vault protection cannot be lower than the active everyday hourly limit;
   lower everyday limits first when necessary.
3. After approval, copy only the returned Vault Migration ID to a local
   operator terminal. Never put the owner key in chat or an Agent session.
4. Run the owner step locally with the normal Sompi runtime environment:

   ```bash
   sompi-operator vault-migrate execute VAULT_MIGRATION_ID /root/sompi-owner-key
   ```

   The short-lived command reads the owner key and validates the operator
   manifest as root, then permanently drops to the pinned API UID/GID before it
   opens runtime state. The API service and Agent never receive the owner key.

5. If the command reports an uncertain chain outcome, do not start a second
   migration. Reconcile the same ID:

   ```bash
   sompi-operator vault-migrate recover VAULT_MIGRATION_ID /root/sompi-owner-key
   ```

Sompi pauses outward vault work during replacement, carries the current rolling
spend forward, and resumes only after the Journal and chain evidence agree. The
user keeps the same receive address. Internal old/new vault addresses are
technical evidence, not new deposit addresses.

## Static drift and recovery

The Journal binds the exact manifest revision/digest before work. Runtime also
re-derives the vault identity and verifies every applied migration in order at
each start. Use the guided flow above for protection-limit changes. Never edit
vault files, policy snapshots, or the Operator Manifest by hand, and never
replace a funded vault's owner key, Agent key, window, template, or receive
identity in place.

`sompi-operator status` verifies the initial installed manifest boundary. Read
an in-progress or completed protection change with
`sompi-agent vault-protection-change-status VAULT_MIGRATION_ID`.
