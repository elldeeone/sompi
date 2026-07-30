```text
                                                                                iiii
                                                                               i::::i
                                                                                iiii

    ssssssssss      ooooooooooo      mmmmmmm    mmmmmmm   ppppp   ppppppppp   iiiiiii
  ss::::::::::s   oo:::::::::::oo  mm:::::::m  m:::::::mm p::::ppp:::::::::p  i:::::i
ss:::::::::::::s o:::::::::::::::om::::::::::mm::::::::::mp:::::::::::::::::p  i::::i
s::::::ssss:::::so:::::ooooo:::::om::::::::::::::::::::::mpp::::::ppppp::::::p i::::i
 s:::::s  ssssss o::::o     o::::om:::::mmm::::::mmm:::::m p:::::p     p:::::p i::::i
   s::::::s      o::::o     o::::om::::m   m::::m   m::::m p:::::p     p:::::p i::::i
      s::::::s   o::::o     o::::om::::m   m::::m   m::::m p:::::p     p:::::p i::::i
ssssss   s:::::s o::::o     o::::om::::m   m::::m   m::::m p:::::p    p::::::p i::::i
s:::::ssss::::::so:::::ooooo:::::om::::m   m::::m   m::::m p:::::ppppp:::::::pi::::::i
s::::::::::::::s o:::::::::::::::om::::m   m::::m   m::::m p::::::::::::::::p i::::::i
 s:::::::::::ss   oo:::::::::::oo m::::m   m::::m   m::::m p::::::::::::::pp  i::::::i
  sssssssssss       ooooooooooo   mmmmmm   mmmmmm   mmmmmm p::::::pppppppp    iiiiiiii
                                                           p:::::p
                                                           p:::::p
                                                          p:::::::p
                                                          p:::::::p
                                                          p:::::::p
                                                          ppppppppp
```

<h1 align="center">Sompi</h1>

<p align="center"><strong>A local KAS wallet for agents.</strong></p>

<p align="center">
  <code>Testnet-10</code> ·
  <code>Human-present approval</code> ·
  <code>Kaspa-x402 alpha.9</code>
</p>

---

Sompi is a local Testnet-10 wallet for agents. An agent can do these tasks:

- Read its KAS balance, receive address, limits, and recent activity.
- Send KAS to a Kaspa address.
- Buy an HTTP resource that uses x402.

The agent does not receive a wallet key or an approval credential. Sompi keeps
funds in an operator-controlled SilverScript vault. Sompi applies fixed limits
and records each effect before an external action occurs.

## Status

- Network: Kaspa Testnet-10 only.
- Authorization: Human-present approval for each outgoing action.
- Payment: Kaspa-x402 `0.1.0-alpha.9`.
- Exact profiles: `standard-native` and `additive`.
- Batch: Kaspa-x402 batch settlement with approval for each charge increase.
- Interface: Authenticated local API and `sompi-agent`.
- Compatibility: Optional `sompi-mcp` wrapper.

Sompi uses internal authorization evidence that comes from AP2 concepts. Sompi
does not claim AP2 interoperability. Sompi does not send AP2 artifacts to an
ordinary x402 Merchant.

## Install with Hermes

Copy this prompt to your agent:

```text
Install and set up Sompi. Read and follow every instruction at:
https://raw.githubusercontent.com/elldeeone/sompi/v0.13.3/integrations/hermes/sompi/SKILL.md
```

The linked skill contains the complete installation procedure and all manual
handoffs.

## Wallet

Use these commands to read the wallet:

```sh
sompi-agent wallet
sompi-agent activity --limit 20
```

The wallet view shows `total`, `available`, `incoming`, and `pending` amounts
in tKAS. It also shows the receive address, limits, deposit status, and recent
activity. Use the technical wallet command only when you need technical data.

## Transfer

Use this command to send native KAS:

```sh
sompi-agent transfer \
  --request-key task-123/send-1 \
  --to kaspatest:... \
  --amount-kas 0.1
```

Sompi requests approval for the exact recipient, amount, and network. The
command continues the same durable Transfer through settlement and receipt
recovery. It does not create a replacement Transfer.

Use these commands only for existing work:

```sh
sompi-agent transfer-status TRANSFER_ID
sompi-agent transfer-recover TRANSFER_ID
```

## Purchase

Use this command to buy an x402 resource:

```sh
sompi-agent purchase \
  --request-key task-123/report \
  --url https://merchant.example/report \
  --method GET
```

Sompi requests approval and continues the same durable Purchase. The command
does routine settlement, fulfillment, and receipt recovery. Do not add a sleep
loop or a second payment command.

Use these commands only for existing work:

```sh
sompi-agent status PURCHASE_ID
sompi-agent recover PURCHASE_ID
```

A request key identifies one logical action. Use the same key for a retry of
the same action. A new key does not bypass a denial, limit, or unresolved
payment.

After `expired`, only a new user instruction can start a new Purchase with a
fresh key. Do not change the URL, method, body, Merchant, amount, network, or
request key after the approval prompt appears.

## Limits

Sompi shows these limits:

- Maximum amount for one payment.
- Maximum total amount for one rolling hour.
- Maximum on-chain outflow from the SilverScript vault.

Each outgoing payment also requires approval.

For a Transfer, the per-payment limit applies to the recipient amount.
The fee has a separate ceiling. The rolling-hour limit counts both values.

Use this command to change the first two limits:

```sh
sompi-agent change-limits \
  --request-key limits-1 \
  --per-payment-kas 1 \
  --per-hour-kas 5
```

Use this command to change vault protection:

```sh
sompi-agent change-vault-protection \
  --request-key vault-limit-1 \
  --maximum-kas 10
```

After approval, the operator must complete the vault change locally. This
action requires the offline owner key. The receive address does not change.

## Approval

Ordinary chat can propose an action. It cannot authorize an action.

The Trusted Authority shows a short summary in Telegram. The user can expand
the message to read each signed fact. Only the final decision card has the
Approve and Deny controls.

The approval applies to one exact Transfer, Purchase, or change. It cannot
change the recipient, amount, policy, source vault, or transaction.

A denial does not spend funds. An uncertain submission stays attached to the
original effect and enters recovery.

## Interfaces

The authenticated local API is the canonical interface:

- `GET /wallet`
- `GET /wallet/activity`
- `GET /wallet/technical`
- `POST /transfers`
- `GET /transfers/{transferId}`
- `POST /transfers/{transferId}/recover`
- `POST /purchases`
- `GET /purchases/{purchaseId}`
- `POST /purchases/{purchaseId}/recover`
- `POST /policy-changes`
- `GET /policy-changes/{policyChangeId}`
- `POST /policy-changes/{policyChangeId}/recover`
- `POST /vault-migrations`
- `GET /vault-migrations/{vaultMigrationId}`

`sompi-agent` and `sompi-mcp` are clients of the same API. They do not own
wallet, authorization, payment, Transfer, Purchase, or recovery logic.

The API schemas are [OpenAPI](docs/openapi/sompi.openapi.json) and
[Arazzo](docs/openapi/sompi.arazzo.json).

## Architecture

```text
Agent / CLI / optional MCP -> authenticated local API
  |
  +-> Purchase / Transfer -> Trusted Authority -> Journal -> Treasury / SompiVault
  +-> Policy Change -> Trusted Authority -> Journal policy revision
  +-> Vault Migration -> Trusted Authority -> Journal migration
  |                                            |
  |                                            +-> offline owner step
  |                                                     |
  |                                                     +-> replacement vault
  +-> Funding Intake -> Journal -> Treasury / SompiVault

Treasury / SompiVault -> Chain Evidence and recovery
```

`Transfer` controls native sends. `Purchase` controls x402 commerce. The AP2
adapter and the Kaspa-x402 adapter are separate. Sompi `0.13.3` accepts only
Journal epoch 20. It has the same physical SQLite shape as epoch 19 and new
authorization evidence semantics. A deployment must use a controlled clean
cutover from an earlier Journal epoch.

Read these current sources:

- [Context](CONTEXT.md)
- [Architecture](docs/architecture/SOMPI_ARCHITECTURE.md)
- [Accepted decisions](docs/adr/README.md)
- [Threat model](docs/architecture/THREAT_MODEL.md)

## Verify

Use Linux, Node.js 22 or a later version, and native build tools.

```sh
npm ci
npm test
npm run test:conformance
node scripts/verify-release.mjs
```

The release verifier checks the runtime, schemas, protocol pins, package, and
clean consumer installation. It also checks local and funded test evidence.

## Boundaries

Sompi is a testnet alpha. It does not support mainnet, autonomous
authorization, recipient grants, passkeys, UCP, or general AP2 interoperability.

Read [mainnet-readiness.md](docs/mainnet-readiness.md) for the mainnet gates.

## License

MIT. Read [LICENSE](LICENSE).
