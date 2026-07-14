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
readonly PROOF_DIR="$MCP_HOME/human-present-proof"
readonly LOCAL_REPORT="$PROOF_DIR/local-proof.json"
readonly WORK_DIR="/work/sompi"
readonly OUTPUT_REPORT="/proof-output/report.json"

authority_process=""

fail() {
  echo "human-present authority proof failed: $*" >&2
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
[[ -t 0 && -t 2 && -c /dev/tty ]] \
  || fail "a real interactive terminal is required for authority approval"
[[ -d /source/src && -f /source/package-lock.json ]] \
  || fail "repository mount is incomplete"
[[ -d /proof-output && ! -e "$OUTPUT_REPORT" ]] \
  || fail "proof output mount is invalid"

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
    src vendor test/human-present-authority \
    scripts/package.json scripts/verify-authority-isolation.js \
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

# Model an installed package: service identities can execute runtime code but
# cannot change the installed tree.
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

install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 "$PRIVATE_DIR"
install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 "$CLIENT_DIR"
install -d -o "$AUTHORITY_USER" -g "$AUTHORITY_GROUP" -m 0700 "$RUNTIME_DIR"
install -d -o "$MCP_USER" -g "$MCP_GROUP" -m 0700 "$PROOF_DIR"

authority_environment=(
  "HOME=$AUTHORITY_HOME"
  "SOMPI_AUTHORITY_PRIVATE_DIR=$PRIVATE_DIR"
  "SOMPI_AUTHORITY_CLIENT_DIR=$CLIENT_DIR"
  "SOMPI_AUTHORITY_RUNTIME_DIR=$RUNTIME_DIR"
  "SOMPI_AUTHORITY_SOCKET=$SOCKET"
  "SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:human-present-proof"
  "SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-human-present-proof"
  "SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-human-present-proof"
  "SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury"
)

runuser -u "$AUTHORITY_USER" -- env "${authority_environment[@]}" \
  node "$WORK_DIR/dist/authority-main.js" init \
  >/tmp/authority-init-public.json 2>/tmp/authority-init.stderr

runuser -u "$AUTHORITY_USER" -- \
  node "$WORK_DIR/dist/e2e/human-present-authority-proof-main.js" public-trust \
  >/tmp/merchant-public-trust.json
chmod 0644 /tmp/merchant-public-trust.json

# Replace the init-only authority trust arrays with exact public role sets.
# The authority gets the Merchant checkout key; the MCP verifier additionally
# gets both receipt keys. Neither file contains a private JWK member.
SOMPI_PROOF_PRIVATE_DIR="$PRIVATE_DIR" \
SOMPI_PROOF_CLIENT_DIR="$CLIENT_DIR" \
node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const privateDirectory = process.env.SOMPI_PROOF_PRIVATE_DIR;
const clientDirectory = process.env.SOMPI_PROOF_CLIENT_DIR;
const authority = JSON.parse(
  fs.readFileSync(path.join(clientDirectory, "authority-public-trust-entry.json"), "utf8")
);
const merchant = JSON.parse(fs.readFileSync("/tmp/merchant-public-trust.json", "utf8"));
if (
  authority.role !== "authority" ||
  !Array.isArray(merchant) ||
  merchant.length !== 3 ||
  merchant.some((entry) => entry.role === "authority") ||
  containsPrivateMember(authority) ||
  containsPrivateMember(merchant)
) {
  throw new Error("public proof trust material is invalid");
}
const checkout = merchant.filter((entry) => entry.role === "merchant-checkout");
if (checkout.length !== 1) throw new Error("Merchant checkout trust is invalid");
writeExisting(path.join(privateDirectory, "trust.json"), [authority, ...checkout]);
writeExisting(path.join(clientDirectory, "trust.json"), [authority, ...merchant]);

function containsPrivateMember(value) {
  if (Array.isArray(value)) return value.some(containsPrivateMember);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => key === "d" || containsPrivateMember(nested));
}

function writeExisting(filename, value) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_WRONLY | fs.constants.O_TRUNC | noFollow
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
NODE

rm "$CLIENT_DIR/authority-public-trust-entry.json" /tmp/merchant-public-trust.json
chown -R "$MCP_USER:$MCP_GROUP" "$CLIENT_DIR"
chmod 0700 "$CLIENT_DIR"
chmod 0600 "$CLIENT_DIR/ipc-mac.key" "$CLIENT_DIR/trust.json"
chown "$AUTHORITY_USER:$IPC_GROUP" "$RUNTIME_DIR"
chmod 0710 "$RUNTIME_DIR"

proof_environment=(
  "HOME=$MCP_HOME"
  "SOMPI_HUMAN_PROOF_DIRECTORY=$PROOF_DIR"
  "SOMPI_HUMAN_PROOF_REPORT=$LOCAL_REPORT"
  "SOMPI_AUTHORITY_CLIENT_DIR=$CLIENT_DIR"
  "SOMPI_AUTHORITY_RUNTIME_DIR=$RUNTIME_DIR"
  "SOMPI_AUTHORITY_SOCKET=$SOCKET"
  "SOMPI_AUTHORITY_SOCKET_UID=$AUTHORITY_UID"
  "SOMPI_AUTHORITY_SOCKET_GID=$IPC_GID"
  "SOMPI_AUTHORITY_ISSUER=urn:sompi:authority:human-present-proof"
  "SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-human-present-proof"
  "SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury"
)

drive_purchase() {
  local status=0
  local ready=false
  for _ in $(seq 1 200); do
    if [[ -S "$SOCKET" ]]; then
      ready=true
      break
    fi
    sleep 0.1
  done
  if [[ "$ready" != true ]]; then
    echo "authority socket did not become ready" >/tmp/proof-driver-error
    status=1
  fi
  if [[ $status -eq 0 ]] && ! node "$WORK_DIR/scripts/verify-authority-isolation.js" \
    --authority-user "$AUTHORITY_USER" \
    --mcp-user "$MCP_USER" \
    --ipc-group "$IPC_GROUP" \
    --private-dir "$PRIVATE_DIR" \
    --client-dir "$CLIENT_DIR" \
    --runtime-dir "$RUNTIME_DIR" \
    --socket "$SOCKET" \
    >/tmp/authority-boundary.json; then
    echo "authority isolation verification failed" >/tmp/proof-driver-error
    status=1
  fi
  if [[ $status -eq 0 ]] && ! runuser -u "$MCP_USER" -- env \
    "${proof_environment[@]}" \
    node "$WORK_DIR/dist/e2e/human-present-authority-proof-main.js" run \
    </dev/null >/tmp/mcp-proof.stdout 2>/tmp/mcp-proof.stderr; then
    echo "MCP-side Purchase proof failed" >/tmp/proof-driver-error
    status=1
  fi
  printf '%s\n' "$status" >/tmp/proof-driver-status
  return 0
}

runuser -u "$AUTHORITY_USER" -- env \
  "${authority_environment[@]}" \
  "SOMPI_AUTHORITY_SOCKET_GID=$IPC_GID" \
  node "$WORK_DIR/dist/authority-main.js" \
  </dev/tty >/tmp/authority.stdout 2>/dev/tty &
authority_process=$!
drive_purchase
if kill -0 "$authority_process" 2>/dev/null; then
  kill -TERM "$authority_process"
fi
set +e
wait "$authority_process"
authority_status=$?
set -e
authority_process=""

[[ -f /tmp/proof-driver-status ]] || fail "proof driver did not finish"
[[ $(< /tmp/proof-driver-status) == 0 ]] \
  || fail "$(< /tmp/proof-driver-error)"
[[ $authority_status -eq 0 ]] || fail "authority did not stop cleanly"
[[ ! -s /tmp/authority.stdout ]] || fail "authority wrote unexpected stdout"
[[ ! -s /tmp/mcp-proof.stdout ]] || fail "MCP proof wrote unexpected stdout"
grep -Fxq 'human-present Purchase reached receipted state' /tmp/mcp-proof.stderr \
  || fail "MCP proof did not report a completed Purchase"
[[ -f "$LOCAL_REPORT" && -f /tmp/authority-boundary.json ]] \
  || fail "proof evidence is incomplete"

authority_binary_sha256=$(sha256sum "$WORK_DIR/dist/authority-main.js" | awk '{print $1}')
proof_binary_sha256=$(
  sha256sum "$WORK_DIR/dist/e2e/human-present-authority-proof-main.js" | awk '{print $1}'
)
verifier_sha256=$(sha256sum "$WORK_DIR/scripts/verify-authority-isolation.js" | awk '{print $1}')
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
SOMPI_PROOF_CLIENT_BINARY="$proof_binary_sha256" \
SOMPI_PROOF_VERIFIER="$verifier_sha256" \
SOMPI_PROOF_DIST_TREE="$dist_tree_sha256" \
SOMPI_PROOF_AUTHORITY_UID="$AUTHORITY_UID" \
SOMPI_PROOF_MCP_UID="$MCP_UID" \
SOMPI_PROOF_IPC_GID="$IPC_GID" \
SOMPI_PROOF_LOCAL_REPORT="$LOCAL_REPORT" \
SOMPI_PROOF_BOUNDARY_REPORT="/tmp/authority-boundary.json" \
SOMPI_PROOF_DECISION_DATABASE="$PRIVATE_DIR/decisions.sqlite" \
SOMPI_PROOF_OUTPUT_REPORT="$OUTPUT_REPORT" \
node --input-type=module <<'NODE'
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("/work/sompi/node_modules/better-sqlite3");
const local = JSON.parse(fs.readFileSync(process.env.SOMPI_PROOF_LOCAL_REPORT, "utf8"));
const boundary = JSON.parse(fs.readFileSync(process.env.SOMPI_PROOF_BOUNDARY_REPORT, "utf8"));
const database = new Database(process.env.SOMPI_PROOF_DECISION_DATABASE, {
  readonly: true,
  fileMustExist: true,
});
let decisions;
try {
  decisions = database.prepare(
    `SELECT purchase_id, checkout_digest, decision, authority_id, evidence_digest
       FROM authority_decisions ORDER BY created_at_ms`
  ).all();
  const integrity = database.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error("authority decision database integrity failed");
  }
} finally {
  database.close();
}
if (
  local.authorityMode !== "separate-process-human-present" ||
  local.initiationMode !== "mcp-sdk-in-memory-transport" ||
  local.purchase?.state !== "receipted" ||
  decisions.length !== 1 ||
  decisions[0].decision !== "approved" ||
  decisions[0].purchase_id !== local.purchase.id ||
  decisions[0].checkout_digest !== local.purchase.checkoutDigest ||
  decisions[0].evidence_digest !== local.purchase.authorizationEvidenceDigest ||
  decisions[0].authority_id !== "urn:sompi:authority:human-present-proof" ||
  boundary.status !== "pass" ||
  boundary.signingKeyReadableByMcp !== false ||
  boundary.socketConnectableByMcp !== true
) {
  throw new Error("human-present proof joins are inconsistent");
}
const pkg = JSON.parse(fs.readFileSync("/work/sompi/package.json", "utf8"));
const report = {
  schema: "sompi.human-present-authority-proof.v1",
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
    humanPresentProofMainSha256: process.env.SOMPI_PROOF_CLIENT_BINARY,
    isolationVerifierSha256: process.env.SOMPI_PROOF_VERIFIER,
    distTreeSha256: process.env.SOMPI_PROOF_DIST_TREE,
  },
  identities: {
    authorityUid: Number(process.env.SOMPI_PROOF_AUTHORITY_UID),
    mcpUid: Number(process.env.SOMPI_PROOF_MCP_UID),
    ipcGid: Number(process.env.SOMPI_PROOF_IPC_GID),
    distinctNonRootUsers: true,
  },
  boundary,
  authorityDecision: {
    mode: "separate-process-human-present",
    terminalPrompt: "TerminalAuthorityApprovalPrompt",
    issuer: decisions[0].authority_id,
    purchaseId: decisions[0].purchase_id,
    checkoutDigest: decisions[0].checkout_digest,
    evidenceDigest: decisions[0].evidence_digest,
    decision: decisions[0].decision,
    persistedDecisionCount: decisions.length,
  },
  purchaseProof: local,
  checks: {
    realInteractiveTerminalRequired: true,
    harnessContainsNoApprovalInputAutomation: true,
    exactPurchaseIdEnteredAtTrustedTerminal: true,
    oneApprovedDecisionPersisted: true,
    authorityDecisionVerifiedByMcp: true,
    purchaseInitiatedThroughMcpSdkTransport: true,
    purchaseReachedReceipted: true,
    authorityAndMcpAreDistinctNonRootUsers: true,
    mcpCannotReadAuthoritySigningKey: true,
    reportContainsNoKeyOrSignedEvidenceBytes: true,
  },
  limitations: [
    "The Kaspa boundary is deterministic in-memory Testnet-10; live Testnet-10 settlement is evidenced separately.",
    "The demo Merchant signing identities are development fixtures held by the MCP-side proof process.",
    "Container root remains trusted and can inspect both OS security contexts.",
    "This is a testnet-only human-present proof and is not a mainnet-readiness claim.",
  ],
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
for (const forbidden of [
  '"privateJwk"',
  '"signedEvidence"',
  '"decisionEvidence"',
  '"artifact"',
  '"d":',
]) {
  if (serialized.includes(forbidden)) throw new Error("proof report contains forbidden material");
}
const descriptor = fs.openSync(
  process.env.SOMPI_PROOF_OUTPUT_REPORT,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  0o600
);
try {
  const outputUserId = numericId(process.env.SOMPI_PROOF_OUTPUT_UID, "output user ID");
  const outputGroupId = numericId(process.env.SOMPI_PROOF_OUTPUT_GID, "output group ID");
  fs.fchownSync(descriptor, outputUserId, outputGroupId);
  fs.fchmodSync(descriptor, 0o600);
  fs.writeFileSync(descriptor, serialized);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}

function numericId(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0x7fffffff) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}
NODE

[[ -s "$OUTPUT_REPORT" ]] || fail "secret-free proof report was not written"
