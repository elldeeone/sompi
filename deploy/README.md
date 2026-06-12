# Deploying the sompi demo service

A small VPS (1 vCPU / 1 GB) is plenty — the service holds tab ledgers and
talks wRPC to a Kaspa node; it does not run a node itself.

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

- Tab deposits accumulate in per-tab addresses under the service data dir
  (`/home/sompi/.sompi/testnet-10/service`). Collect earned funds:
  `node scripts/sweep-tabs.js /home/sompi/.sompi/testnet-10/service <your address>`
- `journalctl -u sompi-service -f` for logs.
- The service is stateless beyond the data dir; back it up if you care about
  open tabs (it holds the tab deposit keys).

## Smoke test from anywhere

```bash
curl -s https://YOUR_HOST/api/joke          # expect HTTP 402 + offer JSON
# pay the offer (or let an agent with @elldeeone/sompi paid_fetch do it), then
curl -s -H "X-Payment: $(echo -n '{"scheme":"kaspa-tab","tabId":"<id>"}' | base64)" https://YOUR_HOST/api/joke
```
