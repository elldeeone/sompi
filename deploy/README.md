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

Put a TLS reverse proxy (caddy is one line: `reverse_proxy localhost:8642`)
or a Cloudflare Tunnel in front for HTTPS.

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
```

For an end-to-end paid request, use an MCP client with `@elldeeone/sompi` and
ask it to fetch `https://YOUR_HOST/api/joke`; `paid_fetch` handles the escrow
deposit and cumulative voucher flow automatically.
