#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly AUTHORITY_USER="sompi-authority"
readonly AUTHORITY_UID="31001"
readonly AUTHORITY_GID="31001"
readonly IPC_GROUP="sompi-ipc"
readonly IPC_GID="31000"
readonly AUTHORITY_HOME="/var/lib/sompi-authority"
readonly PRIVATE_DIR="$AUTHORITY_HOME/private"
readonly CLIENT_DIR="/var/lib/sompi-authority-client"
readonly RUNTIME_DIR="/run/sompi-authority"
readonly SOCKET="$RUNTIME_DIR/authority.sock"
readonly WORK_DIR="/work/sompi"
readonly OUTPUT_REPORT="/proof-output/report.json"
readonly AUTHORITY_ISSUER="urn:sompi:authority:human-present-funded-proof"
readonly AUTHORITY_SIGNING_KID="authority-signing-key-human-present-funded-proof"
readonly AUTHORITY_IPC_KID="authority-ipc-key-human-present-funded-proof"
readonly INSTRUMENT_ID="kaspa:testnet-10:vault-treasury"
readonly OPERATOR_MANIFEST="/etc/sompi/operator-manifest.json"

authority_process=""
fail() {
  echo "human-present funded proof failed: $*" >&2
  exit 1
}
cleanup() {
  if [[ -n "$authority_process" ]] && kill -0 "$authority_process" 2>/dev/null; then
    kill -TERM "$authority_process" 2>/dev/null || true
    wait "$authority_process" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

[[ $# -eq 0 ]] || fail "container proof takes no arguments"
[[ $(id -u) == 0 ]] || fail "container proof must start as root"
[[ -t 0 && -t 2 && -c /dev/tty ]] || fail "a real interactive terminal is required"
[[ -d /source/src && -d /source-wallet && -d /proof-state ]] \
  || fail "proof mounts are incomplete"
[[ ! -e "$OUTPUT_REPORT" ]] || fail "proof output already exists"
[[ "$SOMPI_PROOF_MCP_UID" =~ ^[1-9][0-9]*$ ]] || fail "MCP UID is invalid"
[[ "$SOMPI_PROOF_MCP_GID" =~ ^[1-9][0-9]*$ ]] || fail "MCP GID is invalid"
[[ "$SOMPI_PROOF_MCP_UID" != "$AUTHORITY_UID" ]] || fail "proof users are not distinct"

mcp_user=$(getent passwd "$SOMPI_PROOF_MCP_UID" | cut -d: -f1)
[[ -n "$mcp_user" ]] || fail "container has no user matching the host proof owner"

mkdir -p "$WORK_DIR"
tar -C /source \
  --exclude='./.git' --exclude='./node_modules' --exclude='./dist' \
  --exclude='./.sompi' --exclude='*.log' -cf - . | tar -C "$WORK_DIR" -xf -
(
  cd "$WORK_DIR"
  npm ci --no-audit --no-fund >&2
  npm run build >&2
)
chmod 0755 /work "$WORK_DIR"
chmod -R a+rX "$WORK_DIR/dist" "$WORK_DIR/vendor" "$WORK_DIR/node_modules"
chmod a+r "$WORK_DIR/package.json"

groupadd --gid "$IPC_GID" "$IPC_GROUP"
groupadd --gid "$AUTHORITY_GID" "$AUTHORITY_USER"
useradd --uid "$AUTHORITY_UID" --gid "$AUTHORITY_GID" --groups "$IPC_GROUP" \
  --home-dir "$AUTHORITY_HOME" --create-home --shell /usr/sbin/nologin "$AUTHORITY_USER"
usermod --append --groups "$IPC_GROUP" "$mcp_user"
chmod 0700 "$AUTHORITY_HOME"

install -d -o root -g "$IPC_GROUP" -m 0750 /etc/sompi
cat >/tmp/operator-spec.json <<'JSON'
{
  "schema": "sompi-operator-provisioning-v1",
  "revision": 1,
  "dataDirectory": "/var/lib/sompi-proof-runtime",
  "ownerPublic": "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "maxOutflowSompi": "500000000",
  "windowSizeDaa": "36000",
  "treasury": {
    "maxSompiPerTx": "100000000",
    "maxSompiPerHour": "500000000",
    "allowlist": [],
    "requireApprovalAboveSompi": "0",
    "additionalCostCeilingAtomic": "25000000",
    "operationFeeCeilingAtomic": "25000000"
  },
  "merchant": {
    "allowRules": [{ "hostname": "merchant.example", "ports": [443] }],
    "merchantReceiptIssuer": "receipt:merchant",
    "paymentReceiptIssuer": "receipt:payment"
  },
  "batch": { "claimFeeReserveAtomic": "100000" },
  "chainEvidence": {
    "operatorNodeUrl": "ws://10.0.3.26:17210/",
    "witnessBaseUrl": "https://api-tn10.kaspa.org/",
    "depthConfirmationDaa": "10",
    "finalityFloors": {
      "settlement": "depth-confirmed",
      "directTreasury": "accepted",
      "vault": "accepted",
      "staging": "accepted",
      "recoveryRelease": "depth-confirmed"
    }
  },
  "admission": {
    "authorityPreauthSockets": 32,
    "authorityPrompts": 4,
    "prevalidationPurchases": 128,
    "evidenceBytes": 67108864,
    "directTreasuryRetries": 3
  }
}
JSON
chmod 0600 /tmp/operator-spec.json
node "$WORK_DIR/dist/operator-main.js" provision \
  /tmp/operator-spec.json /tmp/operator-candidate >/tmp/operator-candidate.json
operator_digest=$(node -e \
  'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).digest)' \
  /tmp/operator-candidate.json)
node "$WORK_DIR/dist/operator-main.js" install \
  /tmp/operator-candidate "$OPERATOR_MANIFEST" "$operator_digest" \
  0 "$AUTHORITY_UID" "$IPC_GID" >/tmp/operator-install.json

install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_USER" -m 0700 "$PRIVATE_DIR"
install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_USER" -m 0700 "$CLIENT_DIR"
install -d -o "$AUTHORITY_USER" -g "$IPC_GROUP" -m 0710 "$RUNTIME_DIR"

authority_environment=(
  "HOME=$AUTHORITY_HOME"
  "SOMPI_AUTHORITY_PRIVATE_DIR=$PRIVATE_DIR"
  "SOMPI_AUTHORITY_CLIENT_DIR=$CLIENT_DIR"
  "SOMPI_AUTHORITY_RUNTIME_DIR=$RUNTIME_DIR"
  "SOMPI_AUTHORITY_SOCKET=$SOCKET"
  "SOMPI_AUTHORITY_ISSUER=$AUTHORITY_ISSUER"
  "SOMPI_AUTHORITY_SIGNING_KID=$AUTHORITY_SIGNING_KID"
  "SOMPI_AUTHORITY_IPC_KEY_ID=$AUTHORITY_IPC_KID"
  "SOMPI_AUTHORITY_INSTRUMENT_ID=$INSTRUMENT_ID"
)
runuser -u "$AUTHORITY_USER" -- env "${authority_environment[@]}" \
  node "$WORK_DIR/dist/authority-main.js" init \
  >/tmp/authority-init-public.json 2>/tmp/authority-init.stderr
node "$WORK_DIR/dist/e2e/human-present-authority-proof-main.js" public-trust \
  >/tmp/merchant-public-trust.json

SOMPI_PROOF_PRIVATE_DIR="$PRIVATE_DIR" \
SOMPI_PROOF_CLIENT_DIR="$CLIENT_DIR" \
node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
const privateDirectory = process.env.SOMPI_PROOF_PRIVATE_DIR;
const clientDirectory = process.env.SOMPI_PROOF_CLIENT_DIR;
const authority = JSON.parse(fs.readFileSync(
  path.join(clientDirectory, "authority-public-trust-entry.json"), "utf8"
));
const merchant = JSON.parse(fs.readFileSync("/tmp/merchant-public-trust.json", "utf8"));
if (authority.role !== "authority" || merchant.length !== 3) {
  throw new Error("public trust material is invalid");
}
const checkout = merchant.filter((entry) => entry.role === "merchant-checkout");
if (checkout.length !== 1) throw new Error("Merchant checkout trust is invalid");
for (const [filename, entries] of [
  [path.join(privateDirectory, "trust.json"), [authority, ...checkout]],
  [path.join(clientDirectory, "trust.json"), [authority, ...merchant]],
]) {
  const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(entries, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
NODE

rm "$CLIENT_DIR/authority-public-trust-entry.json" /tmp/merchant-public-trust.json
chown -R "$SOMPI_PROOF_MCP_UID:$SOMPI_PROOF_MCP_GID" "$CLIENT_DIR"
chmod 0700 "$CLIENT_DIR"
chmod 0600 "$CLIENT_DIR/ipc-mac.key" "$CLIENT_DIR/trust.json"

runuser -u "$AUTHORITY_USER" -- env \
  "${authority_environment[@]}" \
  "SOMPI_AUTHORITY_SOCKET_GID=$IPC_GID" \
  "SOMPI_OPERATOR_MANIFEST=$OPERATOR_MANIFEST" \
  "SOMPI_OPERATOR_UID=0" \
  "SOMPI_RUNTIME_GID=$IPC_GID" \
  node "$WORK_DIR/dist/authority-main.js" </dev/tty >/tmp/authority.stdout 2>/dev/tty &
authority_process=$!
for _ in $(seq 1 200); do
  [[ -S "$SOCKET" ]] && break
  sleep 0.1
done
[[ -S "$SOCKET" ]] || fail "authority socket did not become ready"

runuser -u "$mcp_user" -- env \
  "HOME=$(getent passwd "$SOMPI_PROOF_MCP_UID" | cut -d: -f6)" \
  "SOMPI_AUTHORITY_CLIENT_DIR=$CLIENT_DIR" \
  "SOMPI_AUTHORITY_SOCKET=$SOCKET" \
  "SOMPI_AUTHORITY_SOCKET_UID=$AUTHORITY_UID" \
  "SOMPI_AUTHORITY_SOCKET_GID=$IPC_GID" \
  "SOMPI_AUTHORITY_ISSUER=$AUTHORITY_ISSUER" \
  "SOMPI_AUTHORITY_IPC_KEY_ID=$AUTHORITY_IPC_KID" \
  "SOMPI_AUTHORITY_INSTRUMENT_ID=$INSTRUMENT_ID" \
  node "$WORK_DIR/dist/e2e/live-testnet-main.js" \
    --directory /proof-state \
    --source-wallet /source-wallet \
    --report "$OUTPUT_REPORT" \
    --profile standard-native \
    --ingress http-api \
    --human-present-authority

kill -TERM "$authority_process"
wait "$authority_process"
authority_process=""
[[ ! -s /tmp/authority.stdout ]] || fail "authority wrote unexpected stdout"

SOMPI_PROOF_REPORT="$OUTPUT_REPORT" \
SOMPI_PROOF_DECISIONS="$PRIVATE_DIR/decisions.sqlite" \
SOMPI_PROOF_EXPECTED_ISSUER="$AUTHORITY_ISSUER" \
node --input-type=module <<'NODE'
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("/work/sompi/node_modules/better-sqlite3");
const report = JSON.parse(fs.readFileSync(process.env.SOMPI_PROOF_REPORT, "utf8"));
const database = new Database(process.env.SOMPI_PROOF_DECISIONS, {
  readonly: true,
  fileMustExist: true,
});
let decisions;
try {
  decisions = database.prepare(
    "SELECT purchase_id, decision, authority_id FROM authority_decisions ORDER BY created_at_ms"
  ).all();
  const integrity = database.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error("authority decision database integrity failed");
  }
} finally {
  database.close();
}
if (
  report.purchase?.state !== "receipted" ||
  report.network !== "kaspa:testnet-10" ||
  report.exactProfile !== "standard-native" ||
  report.ap2HumanPresentConformanceClaimed !== true ||
  report.authorityMode !== "separate-process-human-present" ||
  report.authorityIsolationAppliedToThisRun !== true ||
  decisions.length !== 1 ||
  decisions[0].purchase_id !== report.purchase.id ||
  decisions[0].decision !== "approved" ||
  decisions[0].authority_id !== process.env.SOMPI_PROOF_EXPECTED_ISSUER
) {
  throw new Error("human-present funded proof joins are inconsistent");
}
NODE

chown "$SOMPI_PROOF_MCP_UID:$SOMPI_PROOF_MCP_GID" "$OUTPUT_REPORT"
chmod 0600 "$OUTPUT_REPORT"
