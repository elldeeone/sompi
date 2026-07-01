# Deploying the sompi demo service

A small VPS (1 vCPU / 1 GB) is plenty. The service keeps its escrow server key
and channel voucher state in the data dir, and talks wRPC to a Kaspa node; it
does not run a node itself.

## Prerequisites

- Node.js >= 20
- A reachable, synced **testnet-10** node with `--utxoindex` and wRPC (borsh).
  As of June 2026 the public resolver nodes are on a stale fork (the built-in
  chain guard rejects them), so point at a trusted node — e.g. a WireGuard/
  Tailscale tunnel back to your own node, or a node you run elsewhere.

## Install

```bash
sudo useradd -r -m -s /usr/sbin/nologin sompi
sudo mkdir -p /opt/sompi && sudo chown sompi:sompi /opt/sompi
sudo -u sompi git clone https://github.com/elldeeone/sompi /opt/sompi
cd /opt/sompi && sudo -u sompi npm ci && sudo -u sompi npm run build

sudo cp deploy/sompi-service.service /etc/systemd/system/
sudo nano /etc/systemd/system/sompi-service.service   # set SOMPI_NODE_URL
sudo systemctl daemon-reload
sudo systemctl enable --now sompi-service
curl -s localhost:8642/healthz
```

Put a TLS reverse proxy or named Cloudflare Tunnel in front for HTTPS.

## Stable public tunnel

For a Cloudflare Tunnel, create a named tunnel in the Zero Trust dashboard and
route your public hostname to `http://localhost:8642`. Then install
`cloudflared` on the host and run it under systemd:

```bash
sudo useradd -r -s /usr/sbin/nologin cloudflared
sudo mkdir -p /etc/sompi
sudo cp deploy/cloudflared.env.example /etc/sompi/cloudflared.env
sudo chmod 600 /etc/sompi/cloudflared.env
sudo nano /etc/sompi/cloudflared.env        # set CLOUDFLARED_TOKEN

sudo cp deploy/sompi-cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sompi-cloudflared
```

The service assumes `cloudflared` is installed at `/usr/local/bin/cloudflared`.
If your package manager installs it elsewhere, update
`deploy/sompi-cloudflared.service` before copying it.

Or run the installer from a built checkout:

```bash
sudo deploy/install-public-demo.sh \
  --node-url "$SOMPI_NODE_URL" \
  --tunnel-token "$CLOUDFLARED_TOKEN" \
  --public-url https://YOUR_HOST
```

Accountless `trycloudflare.com` quick tunnels are useful for one-off external
proofs, but they are not a stable public endpoint. The checker rejects those
hostnames unless you pass `--allow-temporary-tunnel`.

Run the deployment preflight on the host:

```bash
npm run check:public-demo-deploy -- --url https://YOUR_HOST
```

It checks the local demo service, systemd units, Cloudflare Tunnel token config,
and the public URL. Add `--paid` only when the agent host is configured with a
funded vault and you want the full paid proof.

## Operations

- Escrow channel state lives under the service data dir
  (`/home/sompi/.sompi/testnet-10/service`). Back it up if you care about open
  escrows; it contains the server key and latest claimable vouchers.
- Collect earned escrow funds:
  `SOMPI_NODE_URL=<node> node scripts/escrow-claim.js /home/sompi/.sompi/testnet-10/service <your address>`
- `journalctl -u sompi-service -f` for logs.

## Smoke test from anywhere

```bash
curl -i https://YOUR_HOST/api/joke          # expect HTTP 402 + kaspa-escrow offer JSON
curl -s https://YOUR_HOST/llms.txt          # agent-readable payment instructions
npm run check:public-demo -- https://YOUR_HOST
```

For an end-to-end paid request, use an MCP client with `@elldeeone/sompi` and
ask the agent:

```text
Fetch https://YOUR_HOST/api/joke and tell me what you spent.
```

The user should not need to say "with Sompi". If the endpoint requires payment,
the agent's payment rail is `paid_fetch`. A good user-facing receipt is:

```text
I paid 0.01 tKAS using the existing vault-funded escrow and got the result.
No new deposit was needed.
```

The HTTP wire offer still uses exact integer sompi fields for interoperability.

For a repeatable command-line proof from a configured agent host:

```bash
npm run build
npm run check:public-demo -- https://YOUR_HOST --paid
```

Default `check:public-demo` mode does not spend. The `--paid` mode makes one
real `paid_fetch` request to `/api/joke`; it should report `fundingSource:
vault`, and `depositSource: vault` when a new escrow deposit was needed.

Local or LAN checks are intentionally explicit:

```bash
npm run check:public-demo -- http://127.0.0.1:8642 --allow-private --allow-http
```

Temporary tunnel checks are also explicit:

```bash
cloudflared tunnel --url http://127.0.0.1:8642
npm run check:public-demo -- https://TEMP.trycloudflare.com --allow-temporary-tunnel
```
