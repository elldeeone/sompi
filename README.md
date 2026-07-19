# Sompi

Sompi is a local Testnet-10 wallet for agents. It lets an agent:

- check its KAS balance, addresses, limits, and recent activity;
- send KAS to a Kaspa address;
- buy x402-protected HTTP resources.

The agent never receives a wallet key or approval credential. Sompi keeps funds
in an operator-controlled SilverScript vault, applies fixed spending limits,
asks the user to approve exact actions, and records every effect before it can
reach the chain or a merchant.

## Status

- Kaspa Testnet-10 only.
- Human-present approval only.
- Kaspa-x402 `0.1.0-alpha.8`.
- Exact `standard-native` and `additive` purchases.
- Kaspa-x402 batch settlement with approval for every charge increase.
- Local authenticated API and CLI.
- Optional MCP compatibility wrapper.

Sompi uses AP2-derived internal authorization evidence. It does not claim AP2
interoperability or send AP2 artifacts to ordinary x402 merchants.

## Install with Hermes

Tell Hermes:

> Install the Sompi skill from
> https://raw.githubusercontent.com/elldeeone/sompi/v0.9.0/integrations/hermes/sompi/SKILL.md
> and set up Sompi for this host.

Hermes gathers non-secret setup facts and gives you one command to run locally.
That command asks for the Telegram bot token with hidden input, installs the
isolated services, and returns a Testnet-10 funding address.

Fund the displayed address, then run the returned `activateCommand` locally.
After activation reports `ready`, the agent can use Sompi. Hermes never receives
sudo, wallet keys, API credentials, the recovery key, or the Telegram token.

See [the Hermes skill](integrations/hermes/sompi/SKILL.md) and
[operator runbook](docs/runbooks/OPERATOR_PROVISIONING.md).

## Use

An agent can answer normal wallet questions through:

```sh
sompi-agent wallet
sompi-agent activity --limit 20
```

Send native KAS:

```sh
sompi-agent transfer \
  --request-key task-123/send-1 \
  --to kaspatest:... \
  --amount-kas 0.1
```

Buy an x402 resource:

```sh
sompi-agent purchase \
  --request-key task-123/report \
  --url https://merchant.example/report \
  --method GET
```

Inspect or recover existing work with its ID:

```sh
sompi-agent transfer-status TRANSFER_ID
sompi-agent transfer-recover TRANSFER_ID
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

Request keys identify logical actions. Reusing the same key and intent is
idempotent. A new key does not bypass a denial or spending limit.

## Approval

Ordinary chat proposes an action; it does not authorize one. Sompi sends the
exact recipient or merchant, amount, fee ceiling, total ceiling, finality, and
expiry to the separate Trusted Authority. The user approves or denies there.

The approval is bound to one exact Transfer or Purchase. It cannot change the
recipient, amount, policy, source vault, or transaction. A denial spends
nothing. A crash or ambiguous broadcast stays attached to the original signed
effect and must be recovered rather than replaced.

For direct Transfers, the per-transfer limit applies to the amount received.
The network fee has its own ceiling, and the rolling spend limit counts both.

## Interfaces

The canonical interface is the authenticated local API:

- `GET /wallet`
- `GET /wallet/activity`
- `POST /transfers`
- `GET /transfers/{transferId}`
- `POST /transfers/{transferId}/recover`
- `POST /purchases`
- `GET /purchases/{purchaseId}`
- `POST /purchases/{purchaseId}/recover`

`sompi-agent` and `sompi-mcp` are thin clients of the same API. Removing MCP
does not change wallet, authorization, payment, transfer, or recovery logic.

Schemas: [OpenAPI](docs/openapi/sompi.openapi.json) and
[Arazzo](docs/openapi/sompi.arazzo.json).

## Architecture

```text
Agent / CLI / optional MCP
          |
    authenticated local API
          |
   +------+-------+
   |              |
Transfer       Purchase
   |              |
   +---- Trusted Authority
   +---- operator policy
   +---- SilverScript vault / Treasury
   +---- chain evidence and recovery
```

`Transfer` handles native sends. `Purchase` handles x402 commerce. AP2
authorization and Kaspa-x402 payment execution remain separate adapters.
Journal epoch 16 is the only supported state schema.

Architecture sources:

- [Context](CONTEXT.md)
- [Architecture](docs/architecture/SOMPI_ARCHITECTURE.md)
- [Accepted decisions](docs/adr/README.md)
- [Threat model](docs/architecture/THREAT_MODEL.md)

## Verify

Requires Linux, Node.js 22 or newer, and native build tools.

```sh
npm ci
npm test
npm run test:conformance
node scripts/verify-release.mjs
```

The release verifier tests the runtime, protocol pins, funded evidence, local
end-to-end flow, schemas, dependency audit, tarball, and clean consumer install.

## Boundaries

Sompi is a testnet alpha. It is not a hosted wallet, does not enable mainnet,
and does not yet support autonomous authorization, recipient grants, passkeys,
UCP, or general AP2/x402 interoperability.

Mainnet gates are in [mainnet-readiness.md](docs/mainnet-readiness.md).

## License

MIT. See [LICENSE](LICENSE).
