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

### Onboard an agent — you hold the keys

The right way to give an agent money is **not** to hand it a private key. Instead,
the agent's main funds live in a **covenant vault that you control**: your key can
recover everything at any time, while the agent's own key can only spend up to a
rolling-window cap enforced by Kaspa consensus. A stolen or prompt-injected agent
cannot exceed that on-chain window. The agent asks *you* for your public recovery
key during setup — you never give it the private key.

**1. Connect the agent** (no key yet — it just needs the tools):
```json
{ "mcpServers": { "sompi": {
    "command": "npx", "args": ["-y", "@elldeeone/sompi"],
    "env": { "SOMPI_NETWORK": "testnet-10" } } } }
```

**2. Generate *your* control key** (once, on your own machine; keep the private line safe):
```bash
npx -y @elldeeone/sompi gen-owner-key
# prints:  public: <hex>   private: <hex>
```

**3. Tell the agent to set up its vault.** Plain English: *"set up your vault."*
Its `vault_create` tool will ask you for two things — give it your **public** key
from step 2 and a rolling-window cap (e.g. `100000000` = 1 KAS). It generates its
own agent key and saves the vault config. Your private key never touches the
agent's host.

**4. Fund the agent's regular wallet**, from the
[faucet](https://faucet-tn10.kaspanet.io/) or your wallet, then ask it to run
`vault_deposit`. The first deposit creates the covenant-bound vault UTXO; later
deposits top up the same singleton vault and reset an already-expired window
instead of extending exhausted state. Verify with `vault_status`.

Now the agent can spend (`vault_send`, capped by consensus) and pay for services
(`paid_fetch`), and **you** can drain or recover the vault any time with your key
(`scripts/vault-recover.js`). Add a `SOMPI_POLICY` file for softer day-to-day
limits on top of the hard consensus cap.

> A plain hot wallet (auto-created, or `gen-wallet-key` + `SOMPI_PRIVATE_KEY`) also
> exists for small working float — but the agent's real balance belongs in the
> operator-controlled vault above.

## Tools

| Tool | What it does |
|---|---|
| `get_address` | The agent's receive address |
| `get_balance` | Balance of own or any address |
| `send_payment` | Send KAS — gated by the spending policy |
| `await_payment` | Block until an incoming payment of at least N sompi arrives (UTXO subscription, not polling) |
| `verify_payment` | Confirm a txid paid an address |
| `paid_fetch` | Fetch a URL, auto-resolving HTTP 402 payment with trust-minimized escrow |
| `estimate_fee` | Live feerate buckets from the node |
| `network_status` | Node sync state, DAA score, version |
| `get_policy` | Read-only view of the active spending policy |
| `vault_create` / `vault_status` / `vault_send` / `vault_deposit` | Covenant vault: rolling-window spending cap enforced by consensus (see below) |

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

Kaspa's storage mass (KIP-9) charges roughly `C/amount` grams (C = 10¹²) for creating small outputs — an anti-dust mechanism. Measured on testnet-10 post-Toccata (100 sompi/gram): a 0.5 KAS send costs ~0.02 KAS in fees (4%), a 0.1 KAS send costs ~0.1 KAS (100%). Rule of thumb: **sends below ~1 KAS pay >1% in storage-mass fees**. Agent protocols that need sub-KAS granularity should aggregate behind an escrow rather than pay on-chain per event — this is a design constraint for the x402 middleware.

## Security notes

- The default key storage is a plaintext file with 0600 permissions — fine for testnet experimentation, **not for meaningful mainnet funds**. Treat the wallet as a hot spending wallet holding only what the policy could spend.
- The policy file and env vars are deliberately not writable through any MCP tool.
- Fees are always derived from the node's fee estimator; nothing is hardcoded.

## x402: agents paying for APIs

The `paid_fetch` MCP tool resolves HTTP 402 responses automatically with
**`kaspa-escrow`**: the client funds a covenant escrow once, then pays each
request with a cumulative off-chain voucher. On testnet-10 the first paid
request includes the on-chain deposit/indexing step; later requests reuse the
escrow and only send signed vouchers.

Server side (any Node `http`-compatible framework):

```ts
import { EscrowServer } from "@elldeeone/sompi/dist/x402/escrow-server";

const escrow = new EscrowServer({
  networkId,
  rpc: () => sellerWallet.client(),
  wallet: () => sellerWallet,
  serverPrivateHex: serverKey.privateKey,
  serverPublicHex: serverKey.publicKey,
  refundTimeout,
  minDepositSompi: 90_000_000n,
  pricePerRequestSompi: 1_000_000n,
  dataDir,
});

http.createServer(async (req, res) => {
  if (await escrow.gate(req, res)) return; // replied 402
  // ... serve the paid content
});
```

Run the full live demo (seller + buyer, real testnet KAS): `npm run demo:escrow`.

The escrow deposit is never handed to the server. The client issues cumulative
off-chain vouchers (BIP340 signatures) authorizing a running total, and:

- the **server** can claim **at most** what the client signed for, with the
  remainder staying in escrow;
- the **client** can reclaim the unspent balance after a refund timeout if the
  server vanishes.

The voucher's replay protection is **on-chain, not a server promise**. Each
voucher signs a domain-separated digest over `network`, the active escrow
`scriptPubKey`, the full funding outpoint (`txid:vout`), and the authorized
amount. The covenant rebuilds that exact message from transaction introspection
and verifies it with `OpCheckSigFromStack`. In SilverScript source this is the
`checkSigFromStack(...)` builtin, which lowers to the Toccata opcode. Because
the claim's change returns to escrow under a *new* outpoint, a voucher is
single-use: a server cannot replay one voucher against the change to drain the
deposit. (See [docs/escrow-poc.md](docs/escrow-poc.md) for the live proof
harness.)

`paid_fetch` uses `kaspa-escrow` offers. The covenant template is derived from
[`contracts/escrow.sil`](contracts/escrow.sil) with SilverScript compiler
fixtures; the channel — and its replay rejection — is exercised by
`scripts/escrow-live.js`.

Sellers collect escrow revenue with
`node scripts/escrow-claim.js <serviceDataDir> <destination>`. Clients can refund
unspent balances after the timeout with `scripts/escrow-refund.js`.

## Covenant vaults — the agent wallet

This is how an agent should hold money (see onboarding above). A software policy is
just a suggestion a stolen key ignores; the vault moves the spending limit into
Kaspa consensus (KIP-16, live on testnet-10). The vault's agent path can withdraw at
most `maxOutflowSompi` per `windowSizeDaa` rolling DAA window, counting the
withdrawal amount plus fee, with the remainder forced back into the vault under
the next state. **Every node on the network enforces this; a fully compromised
agent key cannot exceed the active window.** The owner key (yours, kept offline)
recovers everything.

See [docs/vault-poc.md](docs/vault-poc.md) for the current stateful vault design,
fixture checks, and live proof coverage.

**Zero extra tooling.** The covenant ships inside this package as a
compiler-verified template (`src/vault/template.ts`), checked byte-for-byte against the
[SilverScript compiler](https://github.com/elldeeone/silverscript) in CI. Agents
can only instantiate this audited rule-shape with their operator's parameters —
they cannot author covenant logic.

**Setup is a two-party ceremony by design:**

1. Operator, on their own machine: `npx -y @elldeeone/sompi gen-owner-key` —
   keep the private line, give the agent the public line plus the chosen cap.
2. Agent: `vault_create` with those two values. It generates only its own key;
   the unrestricted owner key never exists on the agent's host.
3. Operator funds the agent's regular wallet, then the agent runs `vault_deposit`
   to create the covenant-bound singleton vault UTXO.

Owner recovery is likewise *not* an MCP tool — recover from your machine:
`node scripts/vault-recover.js <ownerPriv> <agentPublic> <maxOutflowSompi> <windowSizeDaa> <windowStartDaa> <spentInWindowSompi> <destination>`
(it re-derives the current vault address from public parameters and state; no
agent cooperation needed).

## Roadmap

1. **Phase 1 (done)** — MCP server with policy-enforced wallet tools.
2. **Phase 2 (done)** — x402 HTTP payment middleware + `paid_fetch`, with trust-minimized `kaspa-escrow`.
3. **Phase 3 (done)** — Covenant vaults (KIP-16): the agent wallet, with rolling-window spending limits enforced by consensus rather than software.

## Development

```bash
npm run build   # compile
npm run smoke   # offline policy checks + live testnet-10 checks
```

The Kaspa WASM SDK (v2.0.0, Toccata) is vendored under `vendor/kaspa-wasm` because the npm `kaspa` package is unmaintained (2023). Sourced from the official [rusty-kaspa v2.0.0 release](https://github.com/kaspanet/rusty-kaspa/releases/tag/v2.0.0).

## License

MIT
