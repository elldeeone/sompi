# sompi

**The agent payment kit for Kaspa.** An MCP server that gives AI agents a policy-enforced Kaspa wallet: receive, send, and verify KAS payments with confirmation times fast enough for synchronous machine-to-machine commerce.

Named after the sompi — Kaspa's smallest unit (1 KAS = 100,000,000 sompi) — because machine-to-machine micropayments are what the sompi is for.

- **Toccata-native**: built against the v2.0.0 WASM SDK with v1 transactions, `storageMass` semantics, and node-derived fees (the post-Toccata 100 sompi/gram floor is handled automatically).
- **Policy-enforced**: spending limits live in a config file *outside* the agent's tool surface. A prompt-injected agent cannot raise its own limits.
- **Zero infrastructure**: connects to the public node network via the resolver by default; point it at your own node with one env var.

## Quickstart

From npm ([`@elldeeone/sompi`](https://www.npmjs.com/package/@elldeeone/sompi) — npm's similarity rules reserve the bare name):

```bash
claude mcp add sompi -- npx -y @elldeeone/sompi
```

Or from source:

```bash
git clone https://github.com/elldeeone/sompi
cd sompi
npm install
npm run build
claude mcp add sompi -- node /path/to/sompi/dist/index.js
```

Or to any MCP client config:

```json
{
  "mcpServers": {
    "sompi": {
      "command": "node",
      "args": ["/path/to/sompi/dist/index.js"],
      "env": { "SOMPI_NETWORK": "testnet-10" }
    }
  }
}
```

On first run the server generates a wallet key at `~/.sompi/<network>/wallet-key` (mode 0600). Ask your agent for its address (`get_address`) and fund it from the [testnet faucet](https://faucet.kaspanet.io/).

## Tools

| Tool | What it does |
|---|---|
| `get_address` | The agent's receive address |
| `get_balance` | Balance of own or any address |
| `send_payment` | Send KAS — gated by the spending policy |
| `await_payment` | Block until an incoming payment of at least N sompi arrives (UTXO subscription, not polling) |
| `verify_payment` | Confirm a txid paid an address |
| `paid_fetch` | Fetch a URL, auto-resolving HTTP 402 payment via a KAS tab |
| `estimate_fee` | Live feerate buckets from the node |
| `network_status` | Node sync state, DAA score, version |
| `get_policy` | Read-only view of the active spending policy |
| `vault_create` / `vault_status` / `vault_send` | Covenant vault: spending caps enforced by consensus (see below) |

Connections to public resolver nodes are verified against the explorer's
chain tip (a **canonical-chain guard**): nodes that are unsynced, missing a
UTXO index, or sitting on a stale fork are rejected with a clear error
instead of silently reporting zero balances.

## Spending policy

Every `send_payment` passes through a policy gate enforced below the LLM:

```json
{
  "maxSompiPerTx": "100000000",
  "maxSompiPerHour": "500000000",
  "allowlist": ["kaspatest:qq..."],
  "requireApprovalAboveSompi": "0"
}
```

- `maxSompiPerTx` — hard cap per transaction (default 1 KAS)
- `maxSompiPerHour` — rolling one-hour spend cap, persisted across restarts (default 5 KAS)
- `allowlist` — if non-empty, only these destinations may receive funds
- `requireApprovalAboveSompi` — sends above this are rejected with instructions to ask the human operator (0 = disabled)

Point at a policy file with `SOMPI_POLICY=/path/to/policy.json`. Without one, conservative defaults apply. See `policy.example.json`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SOMPI_NETWORK` | `testnet-10` | `mainnet`, `testnet-10`, ... |
| `SOMPI_NODE_URL` | (public resolver) | Your own node's wRPC (borsh) URL |
| `SOMPI_PRIVATE_KEY` | (generated keyfile) | Hex private key override |
| `SOMPI_DATA_DIR` | `~/.sompi/<network>` | Keyfile + spend-log location |
| `SOMPI_POLICY` | (built-in defaults) | Path to policy JSON |

## Micropayment economics (KIP-9)

Kaspa's storage mass (KIP-9) charges roughly `C/amount` grams (C = 10¹²) for creating small outputs — an anti-dust mechanism. Measured on testnet-10 post-Toccata (100 sompi/gram): a 0.5 KAS send costs ~0.02 KAS in fees (4%), a 0.1 KAS send costs ~0.1 KAS (100%). Rule of thumb: **sends below ~1 KAS pay >1% in storage-mass fees**. Agent protocols that need sub-KAS granularity should aggregate (run a tab and settle periodically) rather than pay per-event — this is a design constraint for the Phase 2 x402 middleware.

## Security notes

- The default key storage is a plaintext file with 0600 permissions — fine for testnet experimentation, **not for meaningful mainnet funds**. Treat the wallet as a hot spending wallet holding only what the policy could spend.
- The policy file and env vars are deliberately not writable through any MCP tool.
- Fees are always derived from the node's fee estimator; nothing is hardcoded.

## x402: agents paying for APIs

The `paid_fetch` MCP tool resolves HTTP 402 responses automatically. Servers using the bundled `TabServer` middleware answer unpaid requests with a `kaspa-tab` offer; the client opens a tab with a single on-chain deposit (policy-gated), then requests are charged against the tab off-chain.

Measured on testnet-10: **first request — including the on-chain deposit confirming — completes in ~1 second**; subsequent requests are 1–2ms with zero on-chain cost. Tab deposits are ≥1 KAS by design so KIP-9 fee overhead stays ~1%.

Server side (any Node `http`-compatible framework):

```ts
import { TabServer } from "sompi/dist/x402/server";

const tabs = new TabServer({ networkId, rpc, minDepositSompi: 100_000_000n, pricePerRequestSompi: 1_000n, dataDir });
http.createServer(async (req, res) => {
  if (await tabs.gate(req, res)) return; // replied 402
  // ... serve the paid content
});
```

Run the full live demo (seller + buyer, real testnet KAS): `npm run demo:x402`.

Sellers collect revenue with `node scripts/sweep-tabs.js <sellerDataDir> <destination>`
(sweeps exhausted tabs; `--all` also takes unspent client credit, for decommissioning).

## Covenant vaults (testnet PoC)

The policy engine is software; a stolen key bypasses it. Covenant vaults move the
spending limit into Kaspa consensus (KIP-16, live on testnet-10): the vault's agent
path can withdraw at most `maxOutflowSompi` per transaction — withdrawal plus fee —
with the remainder forced back into the vault by script. **Every node on the network
enforces this; a fully compromised agent key cannot exceed it.** The owner key
(kept offline) recovers everything.

Proven on-chain — see [docs/vault-poc.md](docs/vault-poc.md) for the three proof
transactions, including the node rejecting an over-limit spend.

**Zero extra tooling.** The covenant ships inside this package as a byte-pinned
template (`src/vault/template.ts`), verified byte-for-byte against the
[SilverScript compiler](https://github.com/elldeeone/silverscript) in CI. Agents
can only instantiate this audited rule-shape with their operator's parameters —
they cannot author covenant logic.

**Setup is a two-party ceremony by design:**

1. Operator, on their own machine: `npx -y @elldeeone/sompi gen-owner-key` —
   keep the private line, give the agent the public line plus the chosen cap.
2. Agent: `vault_create` with those two values. It generates only its own key;
   the unrestricted owner key never exists on the agent's host.
3. Operator funds the returned vault address.

Owner recovery is likewise *not* an MCP tool — recover from your machine:
`node scripts/vault-recover.js <ownerPriv> <agentPublic> <maxOutflowSompi> <destination>`
(it re-derives the vault address from public parameters; no agent cooperation needed).

## Roadmap

1. **Phase 1 (done)** — MCP server with policy-enforced wallet tools.
2. **Phase 2 (done)** — x402 tab-based HTTP payment middleware + `paid_fetch`: agents paying for API calls with KAS inside the request/retry window.
3. **Phase 3 (PoC shipped)** — Covenant-based policy vaults (KIP-16): spending limits enforced by consensus, not software. Next: rolling spend windows via covenant state; mainnet after Toccata activation (June 30, 2026).

## Development

```bash
npm run build   # compile
npm run smoke   # offline policy checks + live testnet-10 checks
```

The Kaspa WASM SDK (v2.0.0, Toccata) is vendored under `vendor/kaspa-wasm` because the npm `kaspa` package is unmaintained (2023). Sourced from the official [rusty-kaspa v2.0.0 release](https://github.com/kaspanet/rusty-kaspa/releases/tag/v2.0.0).

## License

MIT
