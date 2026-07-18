#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly AUTHORITY_USER="sompi-authority"
readonly AUTHORITY_UID="31001"
readonly AUTHORITY_GROUP="sompi-authority"
readonly AUTHORITY_GID="31001"
readonly MCP_USER="sompi-mcp"
readonly MCP_UID="31002"
readonly MCP_GROUP="sompi-mcp"
readonly MCP_GID="31002"
readonly IPC_GROUP="sompi-ipc"
readonly IPC_GID="31000"
readonly AUTHORITY_HOME="/var/lib/sompi-authority"
readonly MCP_HOME="/var/lib/sompi-mcp"
readonly PRIVATE_DIR="$AUTHORITY_HOME/private"
readonly CLIENT_DIR="/var/lib/sompi-mcp-authority-client"
readonly RUNTIME_DIR="/run/sompi-authority"
readonly SOCKET="$RUNTIME_DIR/authority.sock"
readonly MCP_DATA_DIR="$MCP_HOME/testnet-10"
readonly WORK_DIR="/work/sompi"

authority_process=""
mcp_process=""

fail() {
  echo "authority isolation proof failed: $*" >&2
  exit 1
}

cleanup() {
  exec 8>&- 2>/dev/null || true
  exec 7>&- 2>/dev/null || true
  for process_id in "$mcp_process" "$authority_process"; do
    if [[ -n "$process_id" ]] && kill -0 "$process_id" 2>/dev/null; then
      kill -TERM "$process_id" 2>/dev/null || true
      wait "$process_id" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

[[ $(id -u) == 0 ]] || fail "container proof must start as root"
[[ -d /source/src && -f /source/package-lock.json ]] || fail "repository mount is incomplete"

mkdir -p "$WORK_DIR"
tar -C /source \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.sompi' \
  --exclude='*.log' \
  -cf - . | tar -C "$WORK_DIR" -xf -

source_snapshot_sha256=$(
  cd "$WORK_DIR"
  find \
    src vendor test/authority-isolation \
    scripts/package.json scripts/verify-authority-isolation.js \
    docs/runbooks/AUTHORITY.md \
    package.json package-lock.json tsconfig.json \
    -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | awk '{print $1}'
)

(
  cd "$WORK_DIR"
  npm ci --no-audit --no-fund >&2
  npm run build >&2
)

# The source checkout intentionally uses restrictive developer modes. Model an
# installed package by exposing only public runtime code/assets to service users.
chmod 0755 /work "$WORK_DIR"
chmod -R a+rX "$WORK_DIR/dist" "$WORK_DIR/vendor" "$WORK_DIR/node_modules"
chmod a+r "$WORK_DIR/package.json"

groupadd --gid "$IPC_GID" "$IPC_GROUP"
groupadd --gid "$AUTHORITY_GID" "$AUTHORITY_GROUP"
groupadd --gid "$MCP_GID" "$MCP_GROUP"
useradd --uid "$AUTHORITY_UID" --gid "$AUTHORITY_GID" --groups "$IPC_GROUP" \
  --home-dir "$AUTHORITY_HOME" --create-home --shell /usr/sbin/nologin "$AUTHORITY_USER"
useradd --uid "$MCP_UID" --gid "$MCP_GID" --groups "$IPC_GROUP" \
  --home-dir "$MCP_HOME" --create-home --shell /usr/sbin/nologin "$MCP_USER"
chmod 0700 "$AUTHORITY_HOME" "$MCP_HOME"

# Initialization is authority-owned. The client directory is a temporary
# bootstrap destination until the two permitted public/client copies are moved
# under the MCP identity.
install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 "$PRIVATE_DIR"
install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 "$CLIENT_DIR"
install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 "$RUNTIME_DIR"
install -d -o "$MCP_USER" -g "$MCP_GROUP" -m 0700 "$MCP_DATA_DIR"

authority_environment=(
  "HOME=$AUTHORITY_HOME"
  "SOMPI_AUTHORITY_PRIVATE_DIR=$PRIVATE_DIR"
  "SOMPI_AUTHORITY_CLIENT_DIR=$CLIENT_DIR"
  "SOMPI_AUTHORITY_RUNTIME_DIR=$RUNTIME_DIR"
  "SOMPI_AUTHORITY_SOCKET=$SOCKET"
  "SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:container-proof"
  "SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-container-proof"
  "SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-container-proof"
  "SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury"
)

runuser -u "$AUTHORITY_USER" -- env "${authority_environment[@]}" \
  node "$WORK_DIR/dist/authority-main.js" init \
  >/tmp/authority-init-public.json 2>/tmp/authority-init.stderr

[[ -f "$PRIVATE_DIR/authority-private.jwk.json" ]] || fail "authority signer was not initialized"
[[ -f "$CLIENT_DIR/ipc-mac.key" && -f "$CLIENT_DIR/trust.json" ]] \
  || fail "authority client copies were not initialized"

# The one-purpose public-entry bootstrap file is represented in trust.json and
# is not part of the MCP runtime credential directory.
rm "$CLIENT_DIR/authority-public-trust-entry.json"
chown -R "$MCP_USER:$MCP_GROUP" "$CLIENT_DIR"
chmod 0700 "$CLIENT_DIR"
chmod 0600 "$CLIENT_DIR/ipc-mac.key" "$CLIENT_DIR/trust.json"

# `sompi-authority init` deliberately starts every directory at 0700. Restore
# the final IPC ownership after initialization; the MCP group gets traverse,
# never directory write.
chown "$AUTHORITY_USER:$IPC_GROUP" "$RUNTIME_DIR"
chmod 0710 "$RUNTIME_DIR"

mkfifo /tmp/authority-stdin
exec 7<>/tmp/authority-stdin
runuser -u "$AUTHORITY_USER" -- env \
  "${authority_environment[@]}" \
  "SOMPI_AUTHORITY_SOCKET_GID=$IPC_GID" \
  node "$WORK_DIR/dist/authority-main.js" \
  </tmp/authority-stdin >/tmp/authority.stdout 2>/tmp/authority.stderr &
authority_process=$!

for _ in $(seq 1 100); do
  [[ -S "$SOCKET" ]] && break
  kill -0 "$authority_process" 2>/dev/null || fail "authority exited before listening"
  sleep 0.1
done
[[ -S "$SOCKET" ]] || fail "authority socket did not become ready"

node "$WORK_DIR/scripts/verify-authority-isolation.js" \
  --authority-user "$AUTHORITY_USER" \
  --mcp-user "$MCP_USER" \
  --ipc-group "$IPC_GROUP" \
  --private-dir "$PRIVATE_DIR" \
  --client-dir "$CLIENT_DIR" \
  --runtime-dir "$RUNTIME_DIR" \
  --socket "$SOCKET" \
  >/tmp/authority-boundary.json

# Exercise the directory-mutation denial with the real MCP identity. The
# production verifier remains non-destructive; this disposable container can
# additionally prove that both create and unlink syscalls fail.
if runuser -u "$MCP_USER" -- touch "$RUNTIME_DIR/mcp-create-probe" 2>/dev/null; then
  rm -f "$RUNTIME_DIR/mcp-create-probe"
  fail "MCP created an entry in the authority runtime directory"
fi
if runuser -u "$MCP_USER" -- rm "$SOCKET" 2>/dev/null; then
  fail "MCP unlinked the authority socket"
fi
[[ -S "$SOCKET" ]] || fail "authority socket changed during mutation probes"

common_mcp_environment=(
  "SOMPI_NETWORK=testnet-10"
  "SOMPI_AUTHORITY_CLIENT_DIR=$CLIENT_DIR"
  "SOMPI_AUTHORITY_RUNTIME_DIR=$RUNTIME_DIR"
  "SOMPI_AUTHORITY_SOCKET=$SOCKET"
  "SOMPI_AUTHORITY_SOCKET_UID=$AUTHORITY_UID"
  "SOMPI_AUTHORITY_SOCKET_GID=$IPC_GID"
  "SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:container-proof"
  "SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-container-proof"
  "SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury"
  'SOMPI_EGRESS_ALLOW=[{"hostname":"merchant.example","ports":[443]}]'
)

mkfifo /tmp/mcp-stdin
exec 8<>/tmp/mcp-stdin
runuser -u "$MCP_USER" -- env \
  "HOME=$MCP_HOME" \
  "SOMPI_DATA_DIR=$MCP_DATA_DIR" \
  "${common_mcp_environment[@]}" \
  node "$WORK_DIR/dist/index.js" \
  </tmp/mcp-stdin >/tmp/mcp.stdout 2>/tmp/mcp.stderr &
mcp_process=$!

for _ in $(seq 1 100); do
  if grep -q '^sompi MCP server ready: network=testnet-10 address=' /tmp/mcp.stderr; then
    break
  fi
  kill -0 "$mcp_process" 2>/dev/null || fail "sompi-mcp exited before reporting ready"
  sleep 0.1
done
grep -q '^sompi MCP server ready: network=testnet-10 address=' /tmp/mcp.stderr \
  || fail "sompi-mcp did not report ready"
[[ ! -s /tmp/mcp.stdout ]] || fail "sompi-mcp wrote non-protocol startup output to stdout"
[[ $(stat -c '%u' "$MCP_DATA_DIR/wallet-key") == "$MCP_UID" ]] \
  || fail "sompi-mcp did not create wallet state as the MCP user"
[[ $(stat -c '%a' "$MCP_DATA_DIR/wallet-key") == "600" ]] \
  || fail "sompi-mcp wallet state mode is unsafe"

install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 \
  "$AUTHORITY_HOME/mcp-negative"
install -d -o root -g root -m 0700 /var/lib/sompi-root-negative

expect_startup_rejection() {
  local label=$1
  local run_as=$2
  local home=$3
  local data_directory=$4
  local stdout_file="/tmp/${label}.stdout"
  local stderr_file="/tmp/${label}.stderr"
  local status
  local runner
  if [[ "$run_as" == root ]]; then
    runner=(env)
  else
    runner=(runuser -u "$run_as" -- env)
  fi
  set +e
  timeout --signal=TERM 10s \
    "${runner[@]}" \
    "HOME=$home" \
    "SOMPI_DATA_DIR=$data_directory" \
    "${common_mcp_environment[@]}" \
    node "$WORK_DIR/dist/index.js" \
    </dev/null >"$stdout_file" 2>"$stderr_file"
  status=$?
  set -e
  [[ $status -ne 0 && $status -ne 124 ]] || fail "$label startup was not rejected"
  [[ ! -s "$stdout_file" ]] || fail "$label startup emitted protocol output"
  grep -Fxq \
    'fatal: Sompi MCP could not start. Inspect the local configuration and service files.' \
    "$stderr_file" || fail "$label startup did not fail through the fixed production boundary"
}

expect_startup_rejection \
  same-uid-authority "$AUTHORITY_USER" "$AUTHORITY_HOME" "$AUTHORITY_HOME/mcp-negative"
expect_startup_rejection \
  root root /root /var/lib/sompi-root-negative

authority_binary_sha256=$(sha256sum "$WORK_DIR/dist/authority-main.js" | awk '{print $1}')
mcp_binary_sha256=$(sha256sum "$WORK_DIR/dist/index.js" | awk '{print $1}')
verifier_sha256=$(sha256sum "$WORK_DIR/scripts/verify-authority-isolation.js" | awk '{print $1}')
runbook_sha256=$(sha256sum "$WORK_DIR/docs/runbooks/AUTHORITY.md" | awk '{print $1}')
dist_tree_sha256=$(
  cd "$WORK_DIR"
  find dist -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | awk '{print $1}'
)

SOMPI_PROOF_SOURCE_SNAPSHOT="$source_snapshot_sha256" \
SOMPI_PROOF_AUTHORITY_BINARY="$authority_binary_sha256" \
SOMPI_PROOF_MCP_BINARY="$mcp_binary_sha256" \
SOMPI_PROOF_VERIFIER="$verifier_sha256" \
SOMPI_PROOF_RUNBOOK="$runbook_sha256" \
SOMPI_PROOF_DIST_TREE="$dist_tree_sha256" \
SOMPI_PROOF_AUTHORITY_UID="$AUTHORITY_UID" \
SOMPI_PROOF_MCP_UID="$MCP_UID" \
SOMPI_PROOF_IPC_GID="$IPC_GID" \
node - <<'NODE'
const fs = require("node:fs");

const boundary = JSON.parse(fs.readFileSync("/tmp/authority-boundary.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("/work/sompi/package.json", "utf8"));
const report = {
  schema: "sompi.authority-isolation-proof.v1",
  status: "pass",
  generatedAt: new Date().toISOString(),
  source: {
    commit: process.env.SOMPI_PROOF_SOURCE_COMMIT,
    dirty: process.env.SOMPI_PROOF_SOURCE_DIRTY === "true",
    snapshotSha256: process.env.SOMPI_PROOF_SOURCE_SNAPSHOT,
    packageVersion: pkg.version,
  },
  environment: {
    image: process.env.SOMPI_PROOF_IMAGE,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  artifacts: {
    authorityMainSha256: process.env.SOMPI_PROOF_AUTHORITY_BINARY,
    mcpMainSha256: process.env.SOMPI_PROOF_MCP_BINARY,
    distTreeSha256: process.env.SOMPI_PROOF_DIST_TREE,
    isolationVerifierSha256: process.env.SOMPI_PROOF_VERIFIER,
    authorityRunbookSha256: process.env.SOMPI_PROOF_RUNBOOK,
  },
  identities: {
    authorityUid: Number(process.env.SOMPI_PROOF_AUTHORITY_UID),
    mcpUid: Number(process.env.SOMPI_PROOF_MCP_UID),
    ipcGid: Number(process.env.SOMPI_PROOF_IPC_GID),
    distinctNonRootUsers: true,
  },
  boundary,
  checks: {
    builtCurrentSnapshotInPinnedNode22Image: true,
    initializedAsAuthorityUser: true,
    clientDirectoryContainsOnlyMacAndTrustCopies: true,
    authoritySocketOwnedByAuthority: true,
    mcpCanConnectThroughIpcGroup: true,
    mcpCannotReadPrivateJwk: true,
    mcpCannotCreateRuntimeEntry: true,
    mcpCannotUnlinkAuthoritySocket: true,
    productionMcpCompositionReadyAsDistinctUser: true,
    sameAuthorityUidStartupRejected: true,
    rootStartupRejected: true,
    reportContainsNoCredentialBytes: true,
  },
  limitations: [
    "The proof exercises local Unix ownership, mode, process identity, startup, and socket reachability; it does not authorize a Purchase.",
    "Container root remains trusted and can read both security contexts.",
    "The proof is testnet-only and is not a mainnet-readiness claim.",
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
NODE
