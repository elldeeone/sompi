import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  HOST_BOOTSTRAP_INSTALLER_SHA256,
  HOST_BOOTSTRAP_SCHEMA,
  HostBootstrapError,
  canonicalHostBootstrapBytes,
  hostBootstrapRequestDigest,
  loadHostBootstrapRequest,
  operatorSpecForHostBootstrap,
  parseHostBootstrapRequest,
  previewHostBootstrap,
  type HostBootstrapTopology,
} from "./host-bootstrap.js";

const REQUEST = {
  schema: HOST_BOOTSTRAP_SCHEMA,
  packageVersion: "0.11.4",
  agent: { kind: "hermes", user: "luke" },
  ownerRecoveryFile: "/root/sompi-owner-recovery.json",
  telegramBotTokenFile: "/root/sompi-telegram-token",
  initialVault: {
    minimumDepositSompi: "50000000",
    keepFloatSompi: "10000000",
  },
  operator: {
    revision: 1,
    maxOutflowSompi: "500000000",
    windowSizeDaa: "36000",
    treasury: {
      maxSompiPerTx: "100000000",
      maxSompiPerHour: "500000000",
      allowlist: [],
      additionalCostCeilingAtomic: "25000000",
      operationFeeCeilingAtomic: "25000000",
    },
    merchant: { allowRules: [{ hostname: "demo.kaspa-x402.org", ports: [443] }] },
    batch: { claimFeeReserveAtomic: "100000" },
    authority: {
      provider: "telegram",
      telegram: {
        profile: "telegram-inline-v1",
        botId: "123456789",
        userId: "123456789",
        chatId: "123456789",
        promptTimeoutMs: 300000,
      },
    },
    chainEvidence: {
      operatorNodeUrl: "ws://127.0.0.1:17210/",
      witnessBaseUrl: "https://api-tn10.kaspa.org/",
      depthConfirmationDaa: "10",
      finalityFloors: {
        settlement: "depth-confirmed",
        directTreasury: "accepted",
        vault: "accepted",
        staging: "accepted",
        recoveryRelease: "depth-confirmed",
      },
    },
    admission: {
      authorityPreauthSockets: 32,
      authorityPrompts: 4,
      prevalidationPurchases: 128,
      evidenceBytes: 67108864,
      directTreasuryRetries: 3,
    },
  },
} as const;

function assertTopologyAccessContract(
  actual: HostBootstrapTopology["access"],
): void {
  const canonical = (
    value: readonly {
      readonly principal: string;
      readonly checks: readonly {
        readonly kind: string;
        readonly path: string;
        readonly allowed: boolean;
      }[];
    }[],
  ) => value
    .map(({ principal, checks }) => ({
      principal,
      checks: [...checks].sort((left, right) =>
        `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`)
      ),
    }))
    .sort((left, right) => left.principal.localeCompare(right.principal));
  const readPaths = [
    "~/.sompi/agent-api.json",
    "/etc/sompi/agent-api.json",
    "/etc/sompi-recovery/recovery-api.json",
    "/var/lib/sompi-authority/private/telegram-bot-token",
    "/var/lib/sompi-api/runtime/wallet-key",
    "/root/sompi-telegram-token",
    "/root/sompi-owner-recovery.json",
  ] as const;
  const connectPaths = [
    "/run/sompi-authority/authority.sock",
    "/run/sompi-telegram-callback/telegram-callback.sock",
    "/run/sompi-api/sompi.sock",
    "/run/sompi-recovery/recovery.sock",
  ] as const;
  const contracts = [
    {
      principal: "agent",
      reads: [readPaths[0]],
      connects: [connectPaths[1], connectPaths[2]],
    },
    {
      principal: "sompi-api",
      reads: [readPaths[1], readPaths[2], readPaths[4]],
      connects: [connectPaths[0], connectPaths[2], connectPaths[3]],
    },
    {
      principal: "sompi-authority",
      reads: [readPaths[3]],
      connects: [connectPaths[0], connectPaths[1]],
    },
    {
      principal: "operator",
      reads: [...readPaths],
      connects: [...connectPaths],
    },
  ] as const;
  assert.deepEqual(
    canonical(actual),
    canonical(contracts.map(({ principal, reads, connects }) => {
      const allowedReads = new Set<string>(reads);
      const allowedConnects = new Set<string>(connects);
      return {
        principal,
        checks: [
          ...readPaths.map((checkedPath) => ({
            kind: "read",
            path: checkedPath,
            allowed: allowedReads.has(checkedPath),
          })),
          ...connectPaths.map((checkedPath) => ({
            kind: "connect",
            path: checkedPath,
            allowed: allowedConnects.has(checkedPath),
          })),
        ],
      };
    })),
  );
}

test("host bootstrap request is canonical, previewable, and creates the existing operator spec", () => {
  const request = parseHostBootstrapRequest(REQUEST);
  const digest = hostBootstrapRequestDigest(request);
  assert.match(digest, /^sha256:[A-Za-z0-9_-]{43}$/);
  const preview = previewHostBootstrap(request, "0.11.4", "/tmp/request.json");
  assert.equal(preview.requestDigest, digest);
  assert.equal(preview.package, "@elldeeone/sompi@0.11.4");
  assert.equal(preview.minimumFundingSompi, "85000000");
  assert.deepEqual(preview.merchants, ["demo.kaspa-x402.org:443"]);
  assert.equal(preview.topology.schema, "sompi-host-bootstrap-topology-v1");
  assert.deepEqual(preview.topology.principals, {
    operator: "root",
    api: "sompi-api",
    authority: "sompi-authority",
    agent: "luke",
  });
  assert.deepEqual(preview.topology.groups, {
    api: "sompi-api",
    authority: "sompi-authority",
    authorityIpc: "sompi-authority-ipc",
    recovery: "sompi-recovery",
    agentSockets: "selected-agent-primary-group",
  });
  assert.deepEqual(preview.topology.memberships, {
    api: {
      primary: "sompi-api",
      supplementary: ["sompi-authority-ipc", "sompi-recovery"],
    },
    authority: {
      primary: "sompi-authority",
      supplementary: ["sompi-authority-ipc"],
    },
    agent: {
      supplementary: [],
      forbidden: [
        "root",
        "sompi-api",
        "sompi-authority",
        "sompi-authority-ipc",
        "sompi-recovery",
      ],
    },
  });
  assert.deepEqual(preview.topology.sockets, [
    {
      role: "authority",
      path: "/run/sompi-authority/authority.sock",
      owner: "sompi-authority",
      group: "sompi-authority-ipc",
      directoryMode: "0710",
      mode: "0660",
    },
    {
      role: "telegram-callback",
      path: "/run/sompi-telegram-callback/telegram-callback.sock",
      owner: "sompi-authority",
      group: "selected-agent-primary-group",
      directoryMode: "2710",
      mode: "0660",
    },
    {
      role: "agent-api",
      path: "/run/sompi-api/sompi.sock",
      owner: "sompi-api",
      group: "selected-agent-primary-group",
      directoryMode: "2710",
      mode: "0660",
    },
    {
      role: "operator-recovery",
      path: "/run/sompi-recovery/recovery.sock",
      owner: "sompi-api",
      group: "sompi-recovery",
      directoryMode: "0710",
      mode: "0660",
    },
  ]);
  assert.deepEqual(preview.topology.startupOrder, [
    "sompi-authority",
    "sompi-api",
    "hermes-gateway",
  ]);
  assert.deepEqual(preview.topology.hermes, {
    skill: "~/.hermes/skills/sompi",
    plugin: "~/.hermes/plugins/sompi-approval",
    callback: "/run/sompi-telegram-callback/telegram-callback.sock",
    compatibility: "native-hook-or-independent-git-checkout",
  });
  assert.deepEqual(preview.topology.secrets, {
    ownerRecovery: "/root/sompi-owner-recovery.json",
    telegramInput: "/root/sompi-telegram-token",
    authorityPrivate: "/var/lib/sompi-authority/private",
    apiRuntime: "/var/lib/sompi-api/runtime",
    apiCredential: "/etc/sompi/agent-api.json",
    agentCredential: "~/.sompi/agent-api.json",
    recoveryCredential: "/etc/sompi-recovery/recovery-api.json",
  });
  assertTopologyAccessContract(preview.topology.access);
  assert.deepEqual(preview.topology.rollback, {
    scope: "invocation-created-resources-only",
    reverses: [
      "service activation",
      "Hermes configuration",
      "files and directories",
      "supplementary memberships",
      "service principals and groups",
    ],
  });
  assert.match(preview.nextCommand, /^sudo sh -eu -c /);
  assert.ok(preview.nextCommand.includes(
    "https://raw.githubusercontent.com/elldeeone/sompi/v0.11.4/scripts/install-runtime-package.mjs",
  ));
  assert.ok(preview.nextCommand.includes(HOST_BOOTSTRAP_INSTALLER_SHA256));
  assert.ok(preview.nextCommand.includes("'/opt/sompi/releases/0.11.4'"));
  assert.ok(preview.nextCommand.includes("'@elldeeone/sompi@0.11.4'"));
  assert.ok(preview.nextCommand.includes("'/tmp/request.json'"));
  assert.ok(preview.nextCommand.includes(`'${digest}'`));
  assert.doesNotMatch(preview.nextCommand, /npm exec|allow-scripts/);
  assert.doesNotMatch(preview.nextCommand, /^sudo sompi-operator/);
  const spec = operatorSpecForHostBootstrap(request, "c6047f9441ed7d6d3045406e95c07cd85a64464a7416f88167e739c72b27e7dd");
  assert.equal(spec.dataDirectory, "/var/lib/sompi-api/runtime");
  assert.equal(spec.ownerPublic, "c6047f9441ed7d6d3045406e95c07cd85a64464a7416f88167e739c72b27e7dd");
  assert.equal(spec.authority.provider, "telegram");
});

test("privileged bootstrap rejects a changed installer before Node executes it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-bootstrap-command-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const nodeMarker = path.join(directory, "node-ran");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "sudo"), "#!/bin/sh\nexec \"$@\"\n", { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    output=$1
  fi
  shift
done
printf '%s\\n' tampered-installer > "$output"
`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh
: > "$SOMPI_TEST_NODE_MARKER"
exit 0
`, { mode: 0o700 });

  const preview = previewHostBootstrap(
    parseHostBootstrapRequest(REQUEST),
    "0.11.4",
    "/tmp/request.json",
  );
  const result = spawnSync("sh", ["-c", preview.nextCommand], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SOMPI_TEST_NODE_MARKER: nodeMarker,
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(nodeMarker), false);
  assert.match(`${result.stdout}\n${result.stderr}`, /FAILED|did NOT match/);
});

test("host bootstrap stable-loads a regular request and rejects links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sompi-host-bootstrap-"));
  try {
    const requestFile = path.join(root, "request.json");
    const bytes = canonicalHostBootstrapBytes(REQUEST);
    fs.writeFileSync(requestFile, bytes, { mode: 0o600 });
    bytes.fill(0);
    assert.deepEqual(loadHostBootstrapRequest(requestFile), parseHostBootstrapRequest(REQUEST));
    const link = path.join(root, "request-link.json");
    fs.symlinkSync(requestFile, link);
    assert.throws(() => loadHostBootstrapRequest(link), HostBootstrapError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("host bootstrap rejects secrets, unknown fields, terminal authority, and version drift", () => {
  assert.throws(() => parseHostBootstrapRequest({ ...REQUEST, secret: "bad" }), /unknown or missing/);
  assert.throws(() => parseHostBootstrapRequest({ ...REQUEST, ownerRecoveryFile: "/tmp/key" }), /below \/root/);
  assert.throws(() => parseHostBootstrapRequest({
    ...REQUEST,
    operator: { ...REQUEST.operator, authority: { provider: "terminal", telegram: null } },
  }), /Telegram human Authority/);
  assert.throws(() => previewHostBootstrap(parseHostBootstrapRequest(REQUEST), "0.8.1"), /running package version/);
  assert.throws(() => parseHostBootstrapRequest({
    ...REQUEST,
    agent: { kind: "hermes", user: "sompi-authority" },
  }), /protected principal/);
});
