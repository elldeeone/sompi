# Hermes integration

Hermes calls the local Sompi API through `sompi-agent`. MCP is not required.
Purchase approval stays in the separate `sompi-authority` process.

## Install

For a clean host, use the pinned Sompi skill and host bootstrap described in
the README. It installs these files and settings together and verifies the
gateway after restart. The steps below are the manual recovery path.

Complete operator and Authority provisioning first. Then, as the Hermes OS
user:

1. Copy `integrations/hermes/sompi/` to `~/.hermes/skills/sompi/`.
2. Copy `integrations/hermes/plugin/` to
   `~/.hermes/plugins/sompi-approval/`.
3. Add this plugin entry to Hermes configuration:

   ```yaml
   plugins:
     entries:
       sompi-approval:
         allow_tool_override: false
         callback_socket: /run/sompi-telegram-callback/telegram-callback.sock
         timeout_ms: 2000
   ```

4. Give the Hermes service only:

   ```text
   SOMPI_API_SOCKET=/run/sompi-api/sompi.sock
   SOMPI_AGENT_API_CREDENTIAL=/etc/sompi/agent-api.json
   SOMPI_OPERATOR_UID=<operator uid>
   SOMPI_API_UID=<sompi-api uid>
   SOMPI_RUNTIME_GID=<agent API group gid>
   ```

5. Add the Hermes OS user to the agent-API and Telegram-callback groups. Do
   not add it to the Authority IPC, recovery, wallet, or operator groups.
6. Restart the Hermes user manager so the gateway receives its new groups.

The Hermes checkout also needs the generic authorized callback hook. Keep the
Sompi behavior in the packaged plugin; do not add Sompi wallet or protocol code
to Hermes.

## Verify

```bash
sompi-agent status pur_AAAAAAAAAAAAAAAAAAAAAA
```

A structured `PURCHASE_NOT_FOUND` response proves the authenticated API hop.
Then ask the agent to purchase an allowed test resource. Verify that:

- the exact facts arrive as an inline Telegram prompt;
- Approve completes the original Purchase;
- Deny produces no payment;
- a second tap is rejected as replay;
- the agent cannot read the Authority key, bot token, wallet, or recovery
  credential.

## Roll back

Stop the gateway, remove the plugin and skill entries, restore the prior Hermes
checkout, and restart its user service. This does not change Sompi Purchase or
wallet state. Never remove unresolved Sompi state; use `sompi-agent status` or
operator recovery first.
