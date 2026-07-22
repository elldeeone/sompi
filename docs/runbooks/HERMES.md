# Hermes integration

Hermes uses `sompi-agent` to call the local Sompi API.
It does not need MCP.

The separate Authority process owns Purchase, Transfer, and policy decisions.

## Install

Use the pinned host bootstrap in the [README](../../README.md) for a new host.
Use this manual procedure only for recovery or inspection.

1. Copy `integrations/hermes/sompi/` to `~/.hermes/skills/sompi/`.
2. Copy `integrations/hermes/plugin/` to `~/.hermes/plugins/sompi-approval/`.
3. Check the selected Hermes checkout for native authorized callback support.
4. If native support exists, use the selected checkout without a patch.
5. If native support is absent, create an isolated Git compatibility checkout.
6. Run `git apply --check` before you apply `callback-hook.patch` there.
7. Bind the selected or compatibility checkout to the primary Hermes runtime.
8. Add the plugin configuration below.
9. Give Hermes only the Agent API environment.
10. Add the Hermes user to the agent integration group.
11. Restart the Hermes user manager.

Native support requires `gateway_callback_query` in the Telegram adapter and
plugin manager. Do not apply the compatibility patch when both checks pass.

Do not copy a metadata-free Hermes tree.
The compatibility checkout must keep its upstream remote and selected branch.
If the exact patch does not apply, stop and use the host bootstrap recovery path.

```yaml
plugins:
  entries:
    sompi-approval:
      allow_tool_override: false
      callback_socket: /run/sompi-telegram-callback/telegram-callback.sock
      timeout_ms: 2000
```

```text
SOMPI_API_SOCKET=/run/sompi-api/sompi.sock
SOMPI_AGENT_API_CREDENTIAL=/etc/sompi/agent-api.json
SOMPI_OPERATOR_UID=<operator uid>
SOMPI_API_UID=<sompi-api uid>
SOMPI_RUNTIME_GID=<agent API group gid>
```

Do not add Hermes to Authority IPC, recovery, wallet, or operator groups.
Keep Sompi behavior in the packaged plugin and skill.

## Verify

```bash
sompi-agent status pur_AAAAAAAAAAAAAAAAAAAAAA
```

A `fatal: PURCHASE_NOT_FOUND: ...` message proves the authenticated API connection.

Then verify these cases:

- Approve completes the original Purchase.
- Deny makes no payment.
- A second callback fails as replay.
- A direct Transfer needs its own approval.
- A vault change stops at the offline-owner handoff.

For each prompt, verify the Merchant or recipient, action, amount, maximum cost, network, and expiry.
Confirm that advanced details contain the exact signed identifiers, profiles, fees, and finality facts.

Confirm that Hermes cannot read Authority, wallet, bot, or recovery secrets.

## Roll back

Stop the gateway and restore the prior skill, plugin, and Hermes checkout.
Then restart the user service.

This action does not change Sompi state.
Resolve incomplete Sompi work before you remove the integration.
