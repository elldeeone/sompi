import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  HOST_BOOTSTRAP_SCHEMA,
  HostBootstrapError,
  canonicalHostBootstrapBytes,
  hostBootstrapRequestDigest,
  loadHostBootstrapRequest,
  operatorSpecForHostBootstrap,
  parseHostBootstrapRequest,
  previewHostBootstrap,
} from "./host-bootstrap.js";
import { renderApiUnit, renderAuthorityUnit, renderTmpfiles, renderVaultActivationUnit } from "./host-install.js";

const REQUEST = {
  schema: HOST_BOOTSTRAP_SCHEMA,
  packageVersion: "0.11.3",
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

test("host bootstrap request is canonical, previewable, and creates the existing operator spec", () => {
  const request = parseHostBootstrapRequest(REQUEST);
  const digest = hostBootstrapRequestDigest(request);
  assert.match(digest, /^sha256:[A-Za-z0-9_-]{43}$/);
  const preview = previewHostBootstrap(request, "0.11.3", "/tmp/request.json");
  assert.equal(preview.requestDigest, digest);
  assert.equal(preview.package, "@elldeeone/sompi@0.11.3");
  assert.equal(preview.minimumFundingSompi, "85000000");
  assert.deepEqual(preview.merchants, ["demo.kaspa-x402.org:443"]);
  assert.match(preview.nextCommand, /^sudo sompi-operator bootstrap/);
  const spec = operatorSpecForHostBootstrap(request, "c6047f9441ed7d6d3045406e95c07cd85a64464a7416f88167e739c72b27e7dd");
  assert.equal(spec.dataDirectory, "/var/lib/sompi-api/runtime");
  assert.equal(spec.ownerPublic, "c6047f9441ed7d6d3045406e95c07cd85a64464a7416f88167e739c72b27e7dd");
  assert.equal(spec.authority.provider, "telegram");
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
});

test("host bootstrap renders least-authority systemd and socket assets without secrets", () => {
  const request = parseHostBootstrapRequest(REQUEST);
  const ids = {
    apiUid: 996,
    apiGid: 984,
    authorityUid: 995,
    authorityGid: 983,
    authorityIpcGid: 988,
    agentApiGid: 1000,
    recoveryGid: 986,
    callbackGid: 1000,
    agentUid: 1000,
    agentGid: 1000,
    agentGroupName: "luke",
    agentHome: "/home/luke",
  };
  const authority = renderAuthorityUnit(request, ids);
  const api = renderApiUnit(request, ids);
  const activation = renderVaultActivationUnit(request, ids);
  const tmpfiles = renderTmpfiles(ids.agentGroupName);
  assert.match(authority, /User=sompi-authority/);
  assert.match(authority, /NoNewPrivileges=yes/);
  assert.match(authority, /SOMPI_AUTHORITY_CALLBACK_SOCKET_GID=1000/);
  assert.match(api, /User=sompi-api/);
  assert.match(api, /SOMPI_RUNTIME_GID=1000/);
  assert.match(api, /SOMPI_RECOVERY_API_SOCKET=\/run\/sompi-recovery\/recovery.sock/);
  assert.match(activation, /User=sompi-api/);
  assert.match(activation, /SOMPI_BOOTSTRAP_MINIMUM_FUNDING_SOMPI=85000000/);
  assert.match(activation, /ExecStart=\/usr\/local\/bin\/sompi-operator bootstrap-activate-worker/);
  assert.match(activation, /Conflicts=sompi-api.service/);
  assert.match(tmpfiles, /sompi-api luke/);
  assert.doesNotMatch(`${authority}${api}${activation}${tmpfiles}`, /telegram-bot-token|ownerPrivate|987654321/);
});
