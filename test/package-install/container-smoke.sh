#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "package install smoke failed: $*" >&2
  exit 1
}

[[ $(id -u) == 0 ]] || fail "container must start as root"
[[ -f /package.tgz ]] || fail "package archive is missing"

mkdir -p /opt/sompi
cd /opt/sompi
npm init -y >/dev/null
npm install --no-audit --no-fund /package.tgz >&2

package_root=/opt/sompi/node_modules/@elldeeone/sompi
[[ -x /opt/sompi/node_modules/.bin/sompi-mcp ]] || fail "MCP bin is missing"
[[ -x /opt/sompi/node_modules/.bin/sompi-authority ]] || fail "authority bin is missing"
[[ -x /opt/sompi/node_modules/.bin/sompi-vault-recover ]] || fail "vault recovery bin is missing"
[[ -x /opt/sompi/node_modules/.bin/sompi-verify-authority-isolation ]] \
  || fail "authority verifier bin is missing"
[[ ! -e $package_root/dist/e2e/live-testnet-main.js ]] || fail "live proof was packaged"
if find "$package_root/dist" -type f -name '*.test.js' -print -quit | grep -q .; then
  fail "compiled unit tests were packaged"
fi

# npm correctly respects the restrictive install umask. Production deployment
# must then make root-owned immutable code readable, but not writable, by both
# service identities.
chown -R root:root /opt/sompi
chmod 0755 /opt /opt/sompi
chmod -R go-w,a+rX /opt/sompi

groupadd --gid 32001 sompi-authority
groupadd --gid 32002 sompi-mcp
useradd --uid 32001 --gid 32001 --home-dir /var/lib/sompi-authority \
  --create-home --shell /usr/sbin/nologin sompi-authority
useradd --uid 32002 --gid 32002 --home-dir /var/lib/sompi-mcp \
  --create-home --shell /usr/sbin/nologin sompi-mcp

runuser -u sompi-authority -- /opt/sompi/node_modules/.bin/sompi-authority --help \
  >/tmp/authority-help
runuser -u sompi-mcp -- /opt/sompi/node_modules/.bin/sompi-mcp --help \
  >/tmp/mcp-help
runuser -u sompi-authority -- /opt/sompi/node_modules/.bin/sompi-vault-recover --help \
  >/tmp/recovery-help 2>&1
runuser -u sompi-mcp -- env SOMPI_SMOKE_OFFLINE=1 \
  node "$package_root/dist/smoke.js" >/tmp/smoke.out 2>/tmp/smoke.err

grep -q '^usage: sompi-authority' /tmp/authority-help || fail "authority help failed"
grep -q '^usage: sompi-mcp' /tmp/mcp-help || fail "MCP help failed"
grep -q '^usage: vault-recover.js' /tmp/recovery-help || fail "recovery help failed"
grep -q 'ALL CHECKS PASSED' /tmp/smoke.out || fail "cross-user smoke failed"

before=$(sha256sum "$package_root/dist/index.js" | awk '{print $1}')
if npm --prefix "$package_root" run build >/tmp/installed-build.out 2>&1; then
  fail "installed source-only build unexpectedly succeeded"
fi
after=$(sha256sum "$package_root/dist/index.js" | awk '{print $1}')
[[ $before == "$after" ]] || fail "installed build guard changed runtime bytes"
grep -q 'source-tree-only' /tmp/installed-build.out || fail "installed build guard was unclear"

printf '%s\n' '{"status":"pass","node":"22.22.0","restrictiveInstallUmask":"0077","serviceUsers":2,"runtimeReadable":true}'
