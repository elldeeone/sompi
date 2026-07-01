#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: sudo deploy/install-public-demo.sh --node-url <wss://node-or-host> --tunnel-token <token> [options]

options:
  --repo-dir <path>          repository checkout, default current directory
  --node-bin <path>          node binary, default detected with command -v node
  --cloudflared-bin <path>   cloudflared binary, default /usr/local/bin/cloudflared
  --public-url <url>         run public deployment preflight against this URL
  --no-start                 install files but do not start services

This installs the Sompi demo service and named Cloudflare Tunnel units on a
host that already has Node.js, npm dependencies, a trusted testnet-10 node URL,
and a Cloudflare Tunnel token.
USAGE
  exit 2
}

REPO_DIR="$(pwd)"
NODE_URL=""
TUNNEL_TOKEN=""
NODE_BIN="$(command -v node || true)"
CLOUDFLARED_BIN="/usr/local/bin/cloudflared"
PUBLIC_URL=""
START_SERVICES=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      REPO_DIR="${2:-}"
      shift 2
      ;;
    --node-url)
      NODE_URL="${2:-}"
      shift 2
      ;;
    --tunnel-token)
      TUNNEL_TOKEN="${2:-}"
      shift 2
      ;;
    --node-bin)
      NODE_BIN="${2:-}"
      shift 2
      ;;
    --cloudflared-bin)
      CLOUDFLARED_BIN="${2:-}"
      shift 2
      ;;
    --public-url)
      PUBLIC_URL="${2:-}"
      shift 2
      ;;
    --no-start)
      START_SERVICES=0
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

if [[ "$(id -u)" != "0" ]]; then
  echo "install-public-demo.sh must be run with sudo/root." >&2
  exit 1
fi
if [[ -z "$NODE_URL" || -z "$TUNNEL_TOKEN" ]]; then
  usage
fi
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node binary not found or not executable; pass --node-bin." >&2
  exit 1
fi
if [[ ! -x "$CLOUDFLARED_BIN" ]]; then
  echo "cloudflared not found at $CLOUDFLARED_BIN; install it or pass --cloudflared-bin." >&2
  exit 1
fi
if [[ ! -f "$REPO_DIR/dist/service.js" ]]; then
  echo "$REPO_DIR/dist/service.js is missing; run npm run build first." >&2
  exit 1
fi
case "$REPO_DIR" in
  /home/*)
    echo "repo dir is under /home, but sompi-service.service uses ProtectHome=true." >&2
    echo "Deploy from /opt/sompi, or edit the service hardening deliberately." >&2
    exit 1
    ;;
esac

sed_escape() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

REPO_DIR_SED="$(sed_escape "$REPO_DIR")"
NODE_URL_SED="$(sed_escape "$NODE_URL")"
NODE_BIN_SED="$(sed_escape "$NODE_BIN")"
CLOUDFLARED_BIN_SED="$(sed_escape "$CLOUDFLARED_BIN")"

id -u sompi >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin sompi
id -u cloudflared >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin cloudflared

install -d -m 0755 /etc/sompi

cat >/etc/sompi/cloudflared.env <<EOF
CLOUDFLARED_TOKEN=$TUNNEL_TOKEN
EOF
chmod 0600 /etc/sompi/cloudflared.env
chown root:root /etc/sompi/cloudflared.env

sed \
  -e "s|WorkingDirectory=/opt/sompi|WorkingDirectory=$REPO_DIR_SED|" \
  -e "s|Environment=SOMPI_NODE_URL=REPLACE_ME|Environment=SOMPI_NODE_URL=$NODE_URL_SED|" \
  -e "s|ExecStart=/usr/bin/node /opt/sompi/dist/service.js|ExecStart=$NODE_BIN_SED $REPO_DIR_SED/dist/service.js|" \
  "$REPO_DIR/deploy/sompi-service.service" >/etc/systemd/system/sompi-service.service

sed \
  -e "s|ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token|ExecStart=$CLOUDFLARED_BIN_SED tunnel --no-autoupdate run --token|" \
  "$REPO_DIR/deploy/sompi-cloudflared.service" >/etc/systemd/system/sompi-cloudflared.service

systemctl daemon-reload
systemctl enable sompi-service sompi-cloudflared

if [[ "$START_SERVICES" == "1" ]]; then
  systemctl restart sompi-service
  systemctl restart sompi-cloudflared
fi

CHECK_ARGS=(--local-url http://127.0.0.1:8642)
if [[ -n "$PUBLIC_URL" ]]; then
  CHECK_ARGS+=(--url "$PUBLIC_URL")
fi
if [[ "$START_SERVICES" == "0" ]]; then
  echo "Installed units without starting services. Skipping runtime preflight."
  exit 0
fi

cd "$REPO_DIR"
npm run check:public-demo-deploy -- "${CHECK_ARGS[@]}"
