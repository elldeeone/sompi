import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseHostBootstrapRequest,
  previewHostBootstrap,
} from "../../dist/operator/host-bootstrap.js";

const PACKAGE_ROOT = requiredEnvironment("SOMPI_PROOF_PACKAGE_ROOT");
const REPORT_FILE = requiredEnvironment("SOMPI_PROOF_PRIVILEGED_REPORT");
const RELEASE_ROOT = "/opt/sompi/releases";
const SOMPI_ROOT = "/opt/sompi";
const fixture = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "host-bootstrap.example.json"), "utf8"),
);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-release-transaction-"));
const bin = path.join(work, "bin");
const marker = path.join(work, "inner-ran");

fs.mkdirSync(bin);
writeExecutable("sudo", "#!/bin/sh\nexec \"$@\"\n");
writeExecutable("curl", `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    output=$1
  fi
  shift
done
[ -n "$output" ]
printf '%s\\n' 'proof installer bytes' >"$output"
`);
writeExecutable("sha256sum", "#!/bin/sh\ncat >/dev/null\nexit 0\n");
writeExecutable("node", `#!/bin/sh
prefix=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    shift
    prefix=$1
  fi
  shift
done
[ -n "$prefix" ]
mkdir -p "$prefix/node_modules/.bin"
cat >"$prefix/node_modules/.bin/sompi-operator" <<'PROOF_OPERATOR'
#!/bin/sh
if [ "$1" = bootstrap-commit-status ]; then
  receipt=$2
  expected_package=$3
  expected_digest=$4
  if [ "$receipt" = /var/lib/sompi-bootstrap/receipt.json ] &&
    [ -f "$receipt" ] &&
    [ ! -L "$receipt" ] &&
    [ "$(stat -c '%u:%g:%a:%h' "$receipt")" = "0:0:600:1" ] &&
    grep -Fqx "  \\"package\\": \\"$expected_package\\"," "$receipt" &&
    grep -Fqx "  \\"requestDigest\\": \\"$expected_digest\\"," "$receipt" &&
    grep -Fqx '  "next": "fund the displayed Testnet-10 funding address, then run activateCommand"' "$receipt" &&
    [ "$(tail -n 1 "$receipt")" = "}" ]; then
    exit 0
  fi
  exit 1
fi
: >"$SOMPI_TEST_INNER_MARKER"
if [ "\${SOMPI_TEST_RECEIPT_MODE:-none}" != none ]; then
  install -d -o root -g root -m 0700 /var/lib/sompi-bootstrap
  if [ "$SOMPI_TEST_RECEIPT_MODE" = full ]; then
    cat >/var/lib/sompi-bootstrap/receipt.json <<EOF
{
  "status": "ready",
  "package": "$SOMPI_TEST_EXPECTED_PACKAGE",
  "requestDigest": "$3",
  "manifestDigest": "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "vaultAddress": "kaspatest:qqqqqqqqqqqqqqqq",
  "fundingAddress": "kaspatest:rrrrrrrrrrrrrrrr",
  "minimumFundingSompi": "1",
  "ownerRecoveryFile": "/root/sompi-owner-recovery.json",
  "agent": {
    "kind": "hermes",
    "user": "proof"
  },
  "services": [
    "sompi-authority",
    "sompi-api",
    "hermes-gateway"
  ],
  "activateCommand": "sudo sompi-operator bootstrap-activate /root/request.json $3",
  "next": "fund the displayed Testnet-10 funding address, then run activateCommand"
}
EOF
  else
    printf '{"status":"ready","package":"%s","requestDigest":"%s"}\\n' \
      "$SOMPI_TEST_EXPECTED_PACKAGE" "$3" \
      >/var/lib/sompi-bootstrap/receipt.json
  fi
  chmod 0600 /var/lib/sompi-bootstrap/receipt.json
fi
if [ "\${SOMPI_TEST_SIGNAL_AFTER_RECEIPT:-0}" = 1 ]; then
  kill -HUP "$PPID"
fi
exit "\${SOMPI_TEST_INNER_STATUS:-0}"
PROOF_OPERATOR
chmod 0755 "$prefix/node_modules/.bin/sompi-operator"
`);

try {
  const failureVersion = "99.0.1-host-proof";
  const failurePrefix = releasePrefix(failureVersion);
  const failure = runCommand(failureVersion, 23);
  assert.notEqual(failure.status, 0);
  assert.equal(
    entryExists(failurePrefix),
    false,
    `${failure.stderr}\n${failure.stdout}`,
  );
  assert.equal(fs.existsSync(marker), true);
  fs.rmSync(marker, { force: true });

  const successVersion = "99.0.2-host-proof";
  const successPrefix = releasePrefix(successVersion);
  const success = runCommand(successVersion, 0);
  assert.equal(success.status, 0, success.stderr || success.stdout);
  assert.equal(fs.existsSync(successPrefix), true);
  assert.equal(fs.existsSync(marker), true);
  fs.rmSync(successPrefix, { recursive: true });
  fs.rmSync(marker, { force: true });

  const interruptedVersion = "99.0.6-host-proof";
  const interruptedPrefix = releasePrefix(interruptedVersion);
  const interrupted = runCommand(interruptedVersion, 0, {
    receiptMode: "full",
    signalAfterReceipt: true,
  });
  assert.notEqual(interrupted.status, 0);
  assert.equal(fs.existsSync(interruptedPrefix), true);
  assert.equal(
    fs.existsSync("/var/lib/sompi-bootstrap/receipt.json"),
    true,
  );
  fs.rmSync(interruptedPrefix, { recursive: true });
  fs.rmSync("/var/lib/sompi-bootstrap", { recursive: true });
  fs.rmSync(marker, { force: true });

  const staleVersion = "99.0.7-host-proof";
  const stalePrefix = releasePrefix(staleVersion);
  const stalePreview = previewForVersion(staleVersion);
  writeProofReceipt(stalePreview.package, stalePreview.requestDigest);
  const stale = runCommand(staleVersion, 23);
  assert.notEqual(stale.status, 0);
  assert.equal(entryExists(stalePrefix), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync("/var/lib/sompi-bootstrap/receipt.json", "utf8"),
    ).requestDigest,
    stalePreview.requestDigest,
  );
  fs.rmSync("/var/lib/sompi-bootstrap", { recursive: true });
  fs.rmSync(marker, { force: true });

  const partialVersion = "99.0.8-host-proof";
  const partialPrefix = releasePrefix(partialVersion);
  const partial = runCommand(partialVersion, 23, {
    receiptMode: "partial",
  });
  assert.notEqual(partial.status, 0);
  assert.equal(entryExists(partialPrefix), false);
  assert.equal(
    fs.existsSync("/var/lib/sompi-bootstrap/receipt.json"),
    true,
  );
  fs.rmSync("/var/lib/sompi-bootstrap", { recursive: true });
  fs.rmSync(marker, { force: true });

  const existingVersion = "99.0.3-host-proof";
  const existingPrefix = releasePrefix(existingVersion);
  const sentinel = path.join(existingPrefix, "sentinel");
  fs.mkdirSync(existingPrefix);
  fs.writeFileSync(sentinel, "pre-existing\n", { mode: 0o600 });
  const existing = runCommand(existingVersion, 0);
  assert.notEqual(existing.status, 0);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "pre-existing\n");
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(existingPrefix, { recursive: true });

  const original = `/opt/sompi-host-proof-original-${process.pid}`;
  assert.equal(entryExists(original), false);
  fs.renameSync(SOMPI_ROOT, original);
  try {
    const freshVersion = "99.0.4-host-proof";
    const freshPrefix = releasePrefix(freshVersion);
    const fresh = runCommand(freshVersion, 0);
    assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
    assert.equal(fs.existsSync(freshPrefix), true);
    assert.equal(fs.existsSync(marker), true);
    fs.rmSync(SOMPI_ROOT, { recursive: true });
    fs.rmSync(marker, { force: true });

    const redirected = path.join(work, "redirected-sompi");
    fs.mkdirSync(redirected);
    const redirectedSentinel = path.join(redirected, "sentinel");
    fs.writeFileSync(redirectedSentinel, "outside\n", { mode: 0o600 });
    fs.symlinkSync(redirected, SOMPI_ROOT, "dir");
    const symlink = runCommand("99.0.5-host-proof", 0);
    assert.notEqual(symlink.status, 0);
    assert.equal(fs.readFileSync(redirectedSentinel, "utf8"), "outside\n");
    assert.equal(fs.existsSync(marker), false);
    fs.unlinkSync(SOMPI_ROOT);
  } finally {
    if (entryExists(SOMPI_ROOT)) {
      const stat = fs.lstatSync(SOMPI_ROOT);
      if (stat.isSymbolicLink()) fs.unlinkSync(SOMPI_ROOT);
      else fs.rmSync(SOMPI_ROOT, { recursive: true });
    }
    fs.renameSync(original, SOMPI_ROOT);
  }

  fs.writeFileSync(REPORT_FILE, `${JSON.stringify({
    lateFailureRemovedExactRelease: true,
    successRetainedExactRelease: true,
    signalAfterCommitRetainedExactRelease: true,
    staleReceiptDidNotRetainRelease: true,
    partialReceiptDidNotRetainRelease: true,
    preExistingReleasePreserved: true,
    freshReleaseParentsCreated: true,
    symlinkedReleaseAncestorRejected: true,
  })}\n`, { mode: 0o600 });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

function runCommand(version, innerStatus, options = {}) {
  const preview = previewForVersion(version);
  return spawnSync("sh", ["-c", preview.nextCommand], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      SOMPI_TEST_EXPECTED_PACKAGE: preview.package,
      SOMPI_TEST_INNER_MARKER: marker,
      SOMPI_TEST_INNER_STATUS: String(innerStatus),
      SOMPI_TEST_RECEIPT_MODE: options.receiptMode ?? "none",
      SOMPI_TEST_SIGNAL_AFTER_RECEIPT: options.signalAfterReceipt ? "1" : "0",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function previewForVersion(version) {
  const request = parseHostBootstrapRequest({
    ...fixture,
    packageVersion: version,
  });
  return previewHostBootstrap(
    request,
    version,
    "/root/sompi-host-bootstrap-proof-request.json",
  );
}

function writeProofReceipt(packageName, requestDigest) {
  fs.mkdirSync("/var/lib/sompi-bootstrap", {
    recursive: true,
    mode: 0o700,
  });
  fs.chownSync("/var/lib/sompi-bootstrap", 0, 0);
  fs.chmodSync("/var/lib/sompi-bootstrap", 0o700);
  fs.writeFileSync(
    "/var/lib/sompi-bootstrap/receipt.json",
    `${JSON.stringify({
      status: "ready",
      package: packageName,
      requestDigest,
      manifestDigest: `sha256:${"A".repeat(43)}`,
      vaultAddress: "kaspatest:qqqqqqqqqqqqqqqq",
      fundingAddress: "kaspatest:rrrrrrrrrrrrrrrr",
      minimumFundingSompi: "1",
      ownerRecoveryFile: "/root/sompi-owner-recovery.json",
      agent: { kind: "hermes", user: "proof" },
      services: ["sompi-authority", "sompi-api", "hermes-gateway"],
      activateCommand:
        `sudo sompi-operator bootstrap-activate /root/request.json ${requestDigest}`,
      next:
        "fund the displayed Testnet-10 funding address, then run activateCommand",
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chownSync("/var/lib/sompi-bootstrap/receipt.json", 0, 0);
  fs.chmodSync("/var/lib/sompi-bootstrap/receipt.json", 0o600);
}

function releasePrefix(version) {
  return path.join(RELEASE_ROOT, version);
}

function entryExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

function writeExecutable(name, text) {
  fs.writeFileSync(path.join(bin, name), text, { mode: 0o700 });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
