# ADR-0015: API-first alpha.8 clean cutover

- Status: Accepted
- Date: 2026-07-16
- Amended by: ADR-0017 (generic x402 Merchant path and internal AP2-derived
  authorization evidence)

## Context

The first Sompi vertical proved the deep Purchase module through an MCP-only
agent interface and Kaspa-x402 alpha.6 exact settlement. Kaspa-x402 alpha.8 has
now landed with a materially different contract: `kaspa-exact-v2` has both
`standard-native` and `additive` profiles, the additive successor delta is the
entire Merchant payment, additive heads are reusable rather than exclusively
reserved, exact request authorization is payer-signed, and batch settlement has
a complete separate channel lifecycle.

Sompi is still in development. It has no external users or production state
requiring compatibility. Retaining alpha.6 readers, states, or fallbacks would
increase the interface callers must understand and create ambiguity at every
recovery seam.

MCP remains useful for existing agent clients, but it is not the product's
authority or lifecycle interface. A normal authenticated HTTP interface with an
OpenAPI description is the more general automation surface. The two transports
should exercise the same Purchase interface rather than create parallel
orchestration.

## Decision

### Canonical Purchase interface

The deep Purchase module retains exactly these domain operations:

- `purchase`;
- `status`;
- `recover`.

The canonical interface is authenticated HTTP carried over a permissioned
Unix-domain socket:

- `POST /purchases`;
- `GET /purchases/{purchaseId}`;
- `POST /purchases/{purchaseId}/recover`.

OpenAPI 3.2 describes that interface from the same canonical request, result,
and error schemas used by runtime validation. The runtime does not expose a
loopback TCP listener: the server and client verify the pre-provisioned Unix
socket directory, socket owner, shared runtime group, mode, and path identity
before the least-authority bearer is sent. This clean cutover prevents a
different local principal from winning a predictable loopback port and
capturing the bearer. Public OAuth, UCP, A2A, and a generic agent protocol are
not introduced.

The trusted API process hosts two transport-isolated Unix listeners over that
one canonical Purchase application. The Agent listener carries all three
operations for direct API and MCP clients. A second operator-only recovery
listener carries only `status` and `recover`, has a different filesystem group,
credential, pre-authentication connection pool, and control-work budget, and is
required for payment-capable startup. Saturating the lower-trust Agent listener
therefore cannot consume the operator's recovery admission. This is transport
isolation, not a second Purchase or recovery implementation.

`sompi-mcp` remains a stateless compatibility adapter over the same Purchase
interface. It exposes only `purchase`, `purchase_status`, and
`purchase_recover`. It owns no Purchase state, recovery behavior, authority
credential, wallet capability, AP2 decision, or Kaspa-x402 mechanism. In the
production topology it calls the local Purchase API using an
operator-installed least-authority agent credential. Deleting MCP later must
not change Purchase behavior.

The process principals are distinct. `sompi-api` runs as the installed runtime
UID and owns the Journal, wallet, Treasury, protocol adapters, and Authority
client projection. `sompi-mcp` runs as a separate non-root UID that can only
traverse the shared IPC directory, connect to the API socket, and read the
least-authority credential. The operator remains a third administrative
principal and owns the immutable manifest plus separate Agent and recovery
credential files. The MCP principal cannot traverse the protected recovery
directory or read its credential.

This amends ADR-0002, ADR-0003, and ADR-0008 where they describe MCP as the
primary or only agent-facing interface. Their deep Purchase module, protocol
ownership, repository, and process-isolation decisions remain accepted.

### Kaspa-x402 alpha.8

Sompi consumes the four public Kaspa-x402 packages at exactly
`0.1.0-alpha.8`, verifies their npm integrity and source provenance, and
supports only x402 v2 on `kaspa:testnet-10` with asset `KAS`.

The exact payment lifecycle supports both `kaspa-exact-v2` profiles:

- `standard-native` is the default ordinary native-KAS transfer;
- `additive` is the optional KIP-10-based reusable-head profile.

Both profiles use the payer-signed request authorization, reject paid
redirects and automatic corrective re-signing, durably fence replay before
external effects, and require trusted settlement reconciliation. Additive uses
the exact successor delta as the sole Merchant payment and never creates a
second Merchant payment output.

`batch-settlement` is implemented as a separate lifecycle only after the exact
acceptance gates pass. A channel deposit is Treasury Movement, not Purchase
Authorization. Every voucher increase requires its own human-present Purchase
Authorization, capacity reservation, and durable commitment. Actual request
charge and signed voucher ceiling remain separate facts.

This amends ADR-0007 and ADR-0009. Exact-first remains the execution order, but
the accepted target now includes both alpha.8 exact profiles and the recorded
batch phase. Kaspa-x402 remains unchanged and AP2 remains outside it.

### Clean state cutover

The runtime starts a new Purchase Journal schema epoch. Every earlier
development epoch is rejected unchanged. There is no migration, dual reader,
legacy import, or compatibility command.

The same cutover removes all alpha.6 package pins, schemas, fixtures, wire
types, borrow reservations, inventory stores, threshold top-up accounting,
dual-benefit transaction construction, exact-only channel fakes, tests,
commands, examples, exports, and current documentation.

Temporary comparison tests may read immutable upstream alpha.8 vectors while
the replacement is being built. They are not runtime compatibility.

### Ownership remains unchanged

- Sompi owns Purchase, policy, Treasury, Journal, Chain Evidence, fulfilment,
  recovery, receipts, HTTP/MCP projections, and the effective Finality Floor.
- AP2 owns authorization artifacts and evidence through its adapter.
- Kaspa-x402 owns x402 wire objects and Kaspa payment execution through its
  adapter.
- Trusted Authority remains deterministic and separate from both transports.
- Raw protocol objects remain immutable Evidence Attachments, not canonical
  Purchase state.

No universal payment-rail interface is added. Kaspa-x402 remains the only real
execution adapter.

## Consequences

- HTTP and MCP become two real adapters at one Purchase seam, giving parity
  tests leverage without duplicating lifecycle implementation.
- Removing MCP later is a transport deletion, not a product rewrite.
- Alpha.8 protocol churn stays local to the Kaspa-x402 adapter and conformance
  tests.
- Treasury staging remains necessary for the current vault covenant, but its
  capacity covers the Merchant amount plus explicit bounded fees only; there is
  no extra additive Merchant top-up.
- Batch adds durable channel and Treasury Movement state but cannot bypass
  per-Purchase authorization.
- No prior local development database can be opened by the new runtime.
- Testnet evidence is not a mainnet readiness claim.

## Rejected alternatives

- Delete MCP now: removes useful compatibility without simplifying the
  Purchase module once MCP is already thin.
- Host the Purchase runtime inside MCP: gives the untrusted compatibility
  process unnecessary wallet, Journal, AP2, and payment-execution reachability.
- Keep MCP as the canonical product interface: ties Sompi's adoption surface to
  one agent transport.
- Support only `standard-native`: fails the agreed complete alpha.8 exact
  contract and loses the optional additive profile.
- Treat batch as another exact profile: conflates one-shot payment with channel
  deposit, cumulative voucher, claim, and refund state.
- Preserve alpha.6 readers: contradicts the clean-cutover decision and creates
  permanent dual recovery semantics.
- Generalize payment execution into a rail plugin system: one adapter does not
  justify the seam.
