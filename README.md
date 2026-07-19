# Sompi

Sompi lets a local agent buy paid HTTP resources with KAS without giving the
agent a wallet key or approval credential.

The agent calls one local command. Sompi discovers the Merchant's x402 offer,
checks operator policy, asks the user to approve the exact purchase, pays from
an operator-controlled vault, verifies settlement, and returns the resource.

## What is supported

- Kaspa Testnet-10 only.
- Kaspa-x402 `0.1.0-alpha.8` and `kaspa-exact-v2`.
- Exact `standard-native` and `additive` payments.
- Kaspa-x402 batch settlement with per-charge approval.
- Human-present approval in a separate Trusted Authority process.
- Direct local API and `sompi-agent` CLI.
- MCP as an optional compatibility wrapper.

AP2 v0.2 is watched as an upstream source and informs Sompi's internal
authorization evidence. Sompi does not claim AP2 interoperability and does not
send AP2 artifacts to ordinary x402 Merchants.

## Agent flow

Install the CLI on the agent host:

```sh
npm install -g @elldeeone/sompi@0.8.1
```

Install the packaged skill for the agent, then the agent uses:

```sh
sompi-agent purchase \
  --request-key task-123/weather \
  --url https://merchant.example/weather \
  --method GET
```

Sompi returns the final Purchase view. Existing work is inspected or recovered
with:

```sh
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

The request key identifies the logical purchase. Reusing it is safe and
idempotent. Creating a new key does not bypass a denial or policy limit.

The portable agent instructions are in
[`integrations/hermes/sompi/SKILL.md`](integrations/hermes/sompi/SKILL.md).
Hermes-specific installation is covered by
[`docs/runbooks/HERMES.md`](docs/runbooks/HERMES.md).

## Approval flow

1. The agent requests a paid URL.
2. Sompi verifies the x402 `PAYMENT-REQUIRED` offer.
3. Policy reserves the full allowed cost.
4. The Trusted Authority shows the user the Merchant, resource, amount or batch
   ceiling, fees, profile, finality, and expiry.
5. Approve continues the same Purchase. Deny signs a denial and spends nothing.
6. Sompi pays, verifies settlement and fulfilment, and records one receipt.

Telegram can carry the Approve/Deny controls. The agent process only relays the
callback; it cannot approve, change policy, read keys, or access operator
recovery.

## Interfaces

The canonical API is local and authenticated:

- `POST /purchases`
- `GET /purchases/{purchaseId}`
- `POST /purchases/{purchaseId}/recover`

`sompi-mcp` exposes only `purchase`, `purchase_status`, and
`purchase_recover`, delegating all work to the same API. Removing MCP does not
change purchasing, authorization, payment, or recovery.

API schemas are in [`docs/openapi/sompi.openapi.json`](docs/openapi/sompi.openapi.json)
and the workflow is in [`docs/openapi/sompi.arazzo.json`](docs/openapi/sompi.arazzo.json).

## Architecture

Sompi is a modular monolith centred on one stable `Purchase` record:

```text
Agent or MCP
    -> local Purchase API
    -> Purchase module
       -> generic x402 offer and fulfilment
       -> Trusted Authority
       -> policy and Treasury
       -> Kaspa-x402 execution
       -> chain evidence
       -> one receipt
```

The Journal commits intent, authorization, policy reservation, prepared
material, idempotency identity, and recovery state before any blockchain or
Merchant side effect. Journal epoch 15 is the only active schema.

See:

- [`CONTEXT.md`](CONTEXT.md)
- [`docs/architecture/SOMPI_ARCHITECTURE.md`](docs/architecture/SOMPI_ARCHITECTURE.md)
- [`docs/architecture/AP2_PROFILE.md`](docs/architecture/AP2_PROFILE.md)
- [`docs/architecture/KASPA_X402_INTEGRATION.md`](docs/architecture/KASPA_X402_INTEGRATION.md)
- [`docs/architecture/THREAT_MODEL.md`](docs/architecture/THREAT_MODEL.md)

## Build and verify

Requirements: Linux, Node.js 22 or newer, and build tools for native Node
dependencies.

```sh
npm ci
npm test
npm run test:conformance
node scripts/verify-release.mjs
```

The release verifier builds, tests, validates protocol provenance and funded
evidence, runs the local end-to-end proof, checks OpenAPI/Arazzo, audits
production dependencies, inspects the tarball, and installs it in a clean
consumer project.

Fresh generic-Merchant TN10 evidence is in
[`evidence/generic-x402-cutover/`](evidence/generic-x402-cutover/README.md).

## Boundaries

Sompi is still a testnet alpha. It is not a hosted wallet service, does not
enable mainnet, and does not support autonomous/open authorization, passkeys,
UCP, or general AP2/x402 interoperability.

Operator provisioning starts with
[`docs/runbooks/OPERATOR_PROVISIONING.md`](docs/runbooks/OPERATOR_PROVISIONING.md).
Mainnet gates are in [`docs/mainnet-readiness.md`](docs/mainnet-readiness.md).

## License

MIT. See [`LICENSE`](LICENSE).
