import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";

import {
  HOST_BOOTSTRAP_GROUPS,
  HOST_BOOTSTRAP_PATHS,
  HOST_BOOTSTRAP_PRINCIPALS,
  HOST_BOOTSTRAP_SCHEMA,
  hostBootstrapRequestDigest,
  hostBootstrapTopology,
  parseHostBootstrapRequest,
} from "../../dist/operator/host-bootstrap.js";
import {
  activateHostBootstrap,
  installHostBootstrap,
} from "../../dist/operator/host-install.js";

const PACKAGE_ROOT = requiredEnvironment("SOMPI_PROOF_PACKAGE_ROOT");
const PACKAGE_VERSION = requiredEnvironment("SOMPI_PROOF_PACKAGE_VERSION");
const AGENT_USER = requiredEnvironment("SOMPI_PROOF_AGENT_USER");
const AGENT_UID = Number(requiredEnvironment("SOMPI_PROOF_AGENT_UID"));
const AGENT_GID = Number(requiredEnvironment("SOMPI_PROOF_AGENT_GID"));
const AGENT_HOME = requiredEnvironment("SOMPI_PROOF_AGENT_HOME");
const PRIVILEGED_TRANSACTION = JSON.parse(fs.readFileSync(
  requiredEnvironment("SOMPI_PROOF_PRIVILEGED_REPORT"),
  "utf8",
));
assert.deepEqual(PRIVILEGED_TRANSACTION, {
  lateFailureRemovedExactRelease: true,
  successRetainedExactRelease: true,
  signalAfterCommitRetainedExactRelease: true,
  staleReceiptDidNotRetainRelease: true,
  partialReceiptDidNotRetainRelease: true,
  preExistingReleasePreserved: true,
  freshReleaseParentsCreated: true,
  symlinkedReleaseAncestorRejected: true,
});
const TOKEN_FILE = "/root/sompi-telegram-token";
const OWNER_RECOVERY_FILE = "/root/sompi-owner-recovery.json";
const REQUEST_FILE = "/root/sompi-host-bootstrap-request.json";
const AGENT_GROUP_SENTINEL = path.join(
  AGENT_HOME,
  "group-readable-agent-secret",
);
const ORIGINAL_HERMES_CONFIG = Buffer.from(
  fs.readFileSync(path.join(AGENT_HOME, ".hermes", "config.yaml")),
);
const ORIGINAL_AGENT_GROUPS = groupNames(AGENT_USER);

const REQUEST = parseHostBootstrapRequest({
  schema: HOST_BOOTSTRAP_SCHEMA,
  packageVersion: PACKAGE_VERSION,
  agent: { kind: "hermes", user: AGENT_USER },
  ownerRecoveryFile: OWNER_RECOVERY_FILE,
  telegramBotTokenFile: TOKEN_FILE,
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
    merchant: {
      allowRules: [{ hostname: "demo.kaspa-x402.org", ports: [443] }],
    },
    batch: {
      claimFeeReserveAtomic: "100000",
    },
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
});
const REQUEST_DIGEST = hostBootstrapRequestDigest(REQUEST);
const TOPOLOGY = hostBootstrapTopology(REQUEST);

class ProofHostCommandRunner {
  constructor(options = {}) {
    this.failAfterStarting = options.failAfterStarting;
    this.interruptAfterStarting = options.interruptAfterStarting;
    this.interruptSignal = options.interruptSignal ?? "SIGTERM";
    this.failCompatibilityCheck = options.failCompatibilityCheck ?? false;
    this.effectiveDropInUnit = options.effectiveDropInUnit;
    this.effectiveFragmentUnit = options.effectiveFragmentUnit;
    this.hermesActive = options.hermesInitiallyActive ?? true;
    this.commands = [];
    this.activeServices = new Set();
    this.socketProcesses = new Map();
    this.fixturePrincipals = new Map();
    this.hermesSettings = new Map();
    this.hermesLoadedEnvironment = new Map();
    this.hermesEffectiveEnvironment = new Map();
    this.callbackServerPrincipal = undefined;
    this.uidPrivateCredentialHandoffVerified = false;
  }

  run(command, args, options = {}) {
    const copiedArgs = [...args];
    this.commands.push({
      command,
      args: copiedArgs,
      cwd: options.cwd,
    });

    if (
      command === "sh" &&
      copiedArgs[0] === "-c" &&
      copiedArgs[1]?.startsWith("command -v ")
    ) {
      return "";
    }
    if (command === "systemd-tmpfiles") {
      this.createTmpfiles();
      return "";
    }
    if (command === "systemctl") {
      return this.runSystemctl(copiedArgs);
    }
    if (command === "runuser") {
      return this.runAsUser(copiedArgs, options);
    }
    return runReal(command, copiedArgs, options);
  }

  runSystemctl(args) {
    if (args[0] === "daemon-reload") return "";
    if (
      args[0] === "show" &&
      args.includes("--property=UnitPath") &&
      args.includes("--value")
    ) {
      return [
        "/etc/systemd/system.control",
        "/run/systemd/system.control",
        "/run/systemd/transient",
        "/run/systemd/generator.early",
        "/etc/systemd/system",
        "/etc/systemd/system.attached",
        "/run/systemd/system",
        "/run/systemd/system.attached",
        "/run/systemd/generator",
        "/usr/local/lib/systemd/system",
        "/usr/lib/systemd/system",
        "/run/systemd/generator.late",
        "",
      ].join("\n");
    }
    if (args[0] === "enable" && args[1] === "--now") {
      const service = args[2];
      this.startService(service);
      if (service === this.failAfterStarting) {
        throw new Error(`injected failure after ${service} started`);
      }
      if (service === this.interruptAfterStarting) {
        process.emit(this.interruptSignal);
      }
      return "";
    }
    if (args[0] === "disable" && args[1] === "--now") {
      this.stopService(args[2]);
      return "";
    }
    if (args[0] === "is-active") {
      return this.activeServices.has(args.at(-1)) ? "active\n" : "inactive\n";
    }
    if (args[0] === "is-enabled") {
      return this.activeServices.has(args.at(-1)) ? "enabled\n" : "disabled\n";
    }
    if (args[0] === "show") {
      if (args.includes("--property=FragmentPath")) {
        const unit = args[1];
        return [
          "LoadState=loaded",
          `FragmentPath=${
            unit === this.effectiveFragmentUnit
              ? `/usr/local/lib/systemd/system/${unit}`
              : `/etc/systemd/system/${unit}`
          }`,
          `DropInPaths=${
            unit === this.effectiveDropInUnit
              ? `/run/systemd/system.control/${unit}.d/override.conf`
              : ""
          }`,
          "NeedDaemonReload=no",
          "",
        ].join("\n");
      }
      return this.activeServices.has(args[1])
        ? "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"
        : "LoadState=not-found\nActiveState=inactive\nUnitFileState=\n";
    }
    throw new Error(`unsupported proof systemctl command: ${args.join(" ")}`);
  }

  runAsUser(args, options) {
    const systemctlIndex = args.indexOf("systemctl");
    if (systemctlIndex !== -1 && args[systemctlIndex + 1] === "--user") {
      const action = args[systemctlIndex + 2];
      if (action === "show") {
        const property = args.find((value) => value.startsWith("--property="))
          ?.slice("--property=".length);
        if (property === "ActiveState") {
          return this.hermesActive ? "active\n" : "inactive\n";
        }
        if (property === "Environment") {
          return `${[...this.hermesLoadedEnvironment]
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}\n`;
        }
        throw new Error(`unsupported proof Hermes property: ${property}`);
      }
      if (action === "is-active") return this.hermesActive ? "active\n" : "inactive\n";
      if (action === "restart") {
        this.hermesEffectiveEnvironment = new Map(
          this.hermesLoadedEnvironment,
        );
        this.hermesActive = true;
        return "";
      }
      if (action === "stop") {
        this.hermesActive = false;
        return "";
      }
      if (action === "daemon-reload") {
        this.loadHermesEnvironment();
        return "";
      }
    }

    const copySecretIndex = args.lastIndexOf("copy-secret");
    if (copySecretIndex !== -1) {
      const source = args[copySecretIndex + 1];
      const sourceStat = fs.lstatSync(source);
      const directoryStat = fs.lstatSync(path.dirname(source));
      assert.equal(sourceStat.uid, AGENT_UID);
      assert.equal(sourceStat.gid, AGENT_GID);
      assert.equal(sourceStat.mode & 0o777, 0o400);
      assert.equal(directoryStat.uid, AGENT_UID);
      assert.equal(directoryStat.gid, AGENT_GID);
      assert.equal(directoryStat.mode & 0o777, 0o700);
      this.uidPrivateCredentialHandoffVerified = true;
    }

    const hermesIndex = args.indexOf("hermes_cli.main");
    if (hermesIndex !== -1) {
      const hermesArgs = args.slice(hermesIndex + 1);
      if (hermesArgs[0] === "config" && hermesArgs[1] === "set") {
        this.hermesSettings.set(hermesArgs[2], hermesArgs[3]);
        this.writeHermesConfig();
        return "";
      }
      if (hermesArgs[0] === "config" && hermesArgs[1] === "get") {
        const value = this.hermesSettings.get(hermesArgs[2]);
        if (value === undefined) {
          throw new Error(`proof Hermes setting is absent: ${hermesArgs[2]}`);
        }
        return `${value}\n`;
      }
      if (
        hermesArgs[0] === "plugins" &&
        hermesArgs[1] === "enable" &&
        hermesArgs[2] === "sompi-approval"
      ) {
        this.hermesSettings.set("plugins.entries.sompi-approval.enabled", "true");
        this.hermesSettings.set(
          "plugins.entries.sompi-approval.allow_tool_override",
          "false",
        );
        this.writeHermesConfig();
        return "";
      }
    }
    if (
      this.failCompatibilityCheck &&
      args.includes("git") &&
      args.includes("apply") &&
      args.includes("--check")
    ) {
      throw new Error("injected failure before Hermes configuration");
    }
    return runReal("runuser", args, options);
  }

  loadHermesEnvironment() {
    const directory = path.join(
      AGENT_HOME,
      ".config",
      "systemd",
      "user",
      "hermes-gateway.service.d",
    );
    const environment = new Map();
    if (fs.existsSync(directory)) {
      for (const filename of fs.readdirSync(directory).sort()) {
        if (!filename.endsWith(".conf")) continue;
        for (
          const line of fs.readFileSync(path.join(directory, filename), "utf8")
            .split("\n")
        ) {
          const match = /^Environment="([^=]+)=(.*)"$/.exec(line);
          if (match) environment.set(match[1], match[2]);
        }
      }
    }
    this.hermesLoadedEnvironment = environment;
  }

  writeHermesConfig() {
    const filename = path.join(AGENT_HOME, ".hermes", "config.yaml");
    const callback = this.hermesSettings.get(
      "plugins.entries.sompi-approval.callback_socket",
    ) ?? "";
    const timeout = this.hermesSettings.get(
      "plugins.entries.sompi-approval.timeout_ms",
    ) ?? "";
    const enabled = this.hermesSettings.get(
      "plugins.entries.sompi-approval.enabled",
    ) ?? "false";
    const allowOverride = this.hermesSettings.get(
      "plugins.entries.sompi-approval.allow_tool_override",
    ) ?? "false";
    fs.writeFileSync(filename, [
      "proof_sentinel: configured-by-host-bootstrap",
      "plugins:",
      "  entries:",
      "    sompi-approval:",
      `      callback_socket: ${callback}`,
      `      timeout_ms: ${timeout}`,
      `      enabled: ${enabled}`,
      `      allow_tool_override: ${allowOverride}`,
      "",
    ].join("\n"), { mode: 0o600 });
    fs.chownSync(filename, AGENT_UID, AGENT_GID);
    fs.chmodSync(filename, 0o600);
  }

  createTmpfiles() {
    const lines = fs.readFileSync(HOST_BOOTSTRAP_PATHS.tmpfiles, "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      const [kind, directory, modeText, user, group] = line.split(/\s+/);
      assert.equal(kind, "d");
      const ids = principalIds(user, group);
      fs.mkdirSync(directory, { recursive: true, mode: Number.parseInt(modeText, 8) });
      fs.chownSync(directory, ids.uid, ids.gid);
      fs.chmodSync(directory, Number.parseInt(modeText, 8));
    }
  }

  startService(service) {
    if (service === "sompi-authority.service") {
      const authority = passwd(HOST_BOOTSTRAP_PRINCIPALS.authority);
      this.createRuntimeStateFile(
        path.join(HOST_BOOTSTRAP_PATHS.authorityPrivate, "decision.sqlite"),
        authority.uid,
        authority.gid,
      );
      this.startSocket(
        HOST_BOOTSTRAP_PATHS.authoritySocket,
        HOST_BOOTSTRAP_PRINCIPALS.authority,
        authority.uid,
        group(HOST_BOOTSTRAP_GROUPS.authorityIpc).gid,
      );
      this.startAuthorityCallbackSocket(
        HOST_BOOTSTRAP_PATHS.callbackSocket,
        AGENT_GID,
      );
    } else if (service === "sompi-api.service") {
      const api = passwd(HOST_BOOTSTRAP_PRINCIPALS.api);
      for (const filename of [
        "purchase.sqlite",
        "authority-client-replay.sqlite",
      ]) {
        this.createRuntimeStateFile(
          path.join(HOST_BOOTSTRAP_PATHS.apiRuntime, filename),
          api.uid,
          api.gid,
        );
      }
      this.startSocket(
        HOST_BOOTSTRAP_PATHS.agentApiSocket,
        HOST_BOOTSTRAP_PRINCIPALS.api,
        api.uid,
        AGENT_GID,
      );
      this.startSocket(
        HOST_BOOTSTRAP_PATHS.recoverySocket,
        HOST_BOOTSTRAP_PRINCIPALS.api,
        api.uid,
        group(HOST_BOOTSTRAP_GROUPS.recovery).gid,
      );
    } else {
      throw new Error(`unsupported proof service: ${service}`);
    }
    this.activeServices.add(service);
  }

  createRuntimeStateFile(filename, uid, gid) {
    fs.writeFileSync(filename, "fixture runtime state\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.chownSync(filename, uid, gid);
    fs.chmodSync(filename, 0o600);
  }

  startSocket(socketPath, principal, uid, gid) {
    const child = spawn("runuser", [
      "-u",
      principal,
      "--",
      process.execPath,
      path.join(PACKAGE_ROOT, "test", "host-bootstrap", "socket-server.mjs"),
      socketPath,
      String(uid),
      String(gid),
    ], {
      detached: true,
      stdio: "ignore",
    });
    this.fixturePrincipals.set(socketPath, principal);
    this.socketProcesses.set(socketPath, child);
    runReal("sh", [
      "-c",
      "count=0; until test -S \"$1\"; do count=$((count + 1)); if test \"$count\" -ge 100; then exit 1; fi; sleep 0.02; done",
      "socket-ready",
      socketPath,
    ]);
  }

  startAuthorityCallbackSocket(socketPath, gid) {
    const child = spawn("runuser", [
      "-u",
      HOST_BOOTSTRAP_PRINCIPALS.authority,
      "--",
      process.execPath,
      path.join(PACKAGE_ROOT, "test", "host-bootstrap", "callback-server.mjs"),
      socketPath,
      String(gid),
    ], {
      detached: true,
      stdio: "ignore",
    });
    this.callbackServerPrincipal = HOST_BOOTSTRAP_PRINCIPALS.authority;
    this.fixturePrincipals.set(
      socketPath,
      HOST_BOOTSTRAP_PRINCIPALS.authority,
    );
    this.socketProcesses.set(socketPath, child);
    runReal("sh", [
      "-c",
      "count=0; until test -S \"$1\"; do count=$((count + 1)); if test \"$count\" -ge 100; then exit 1; fi; sleep 0.02; done",
      "callback-ready",
      socketPath,
    ]);
  }

  stopService(service) {
    this.activeServices.delete(service);
    const sockets = service === "sompi-authority.service"
      ? [HOST_BOOTSTRAP_PATHS.authoritySocket, HOST_BOOTSTRAP_PATHS.callbackSocket]
      : service === "sompi-api.service"
        ? [HOST_BOOTSTRAP_PATHS.agentApiSocket, HOST_BOOTSTRAP_PATHS.recoverySocket]
        : [];
    for (const socketPath of sockets) this.stopSocket(socketPath);
  }

  stopSocket(socketPath) {
    const child = this.socketProcesses.get(socketPath);
    if (child) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      runReal("sh", ["-c", "sleep 0.05"]);
    }
    this.socketProcesses.delete(socketPath);
    fs.rmSync(socketPath, { force: true });
  }

  stopAll() {
    for (const socketPath of [...this.socketProcesses.keys()]) {
      this.stopSocket(socketPath);
    }
    this.activeServices.clear();
  }
}

const brokenRecoveryTarget = "/proof-missing-sompi-recovery-directory";
fs.symlinkSync(brokenRecoveryTarget, path.dirname(HOST_BOOTSTRAP_PATHS.recoveryCredential));
const brokenTargetRunner = new ProofHostCommandRunner();
await assert.rejects(
  installHostBootstrap(REQUEST, REQUEST_DIGEST, {
    packageRoot: PACKAGE_ROOT,
    runningPackageVersion: PACKAGE_VERSION,
    requestFilename: REQUEST_FILE,
    commandRunner: brokenTargetRunner,
  }),
  /clean host|symbolic link|unsafe/,
);
brokenTargetRunner.stopAll();
assert.equal(
  fs.lstatSync(path.dirname(HOST_BOOTSTRAP_PATHS.recoveryCredential))
    .isSymbolicLink(),
  true,
);
assert.equal(
  fs.readlinkSync(path.dirname(HOST_BOOTSTRAP_PATHS.recoveryCredential)),
  brokenRecoveryTarget,
);
fs.unlinkSync(path.dirname(HOST_BOOTSTRAP_PATHS.recoveryCredential));

for (const conflict of [
  "/usr/local/lib/systemd/system/sompi-api.service.d",
  "/etc/systemd/system.control/sompi-.service.d",
  "/run/systemd/generator/service.d",
]) {
  assert.equal(fs.existsSync(conflict), false);
  fs.mkdirSync(conflict, { recursive: true, mode: 0o755 });
  const sentinel = path.join(conflict, "proof.conf");
  fs.writeFileSync(sentinel, "[Service]\nNoNewPrivileges=no\n", {
    mode: 0o644,
  });
  const conflictRunner = new ProofHostCommandRunner();
  await assert.rejects(
    installHostBootstrap(REQUEST, REQUEST_DIGEST, {
      packageRoot: PACKAGE_ROOT,
      runningPackageVersion: PACKAGE_VERSION,
      requestFilename: REQUEST_FILE,
      commandRunner: conflictRunner,
    }),
    /clean host/,
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "[Service]\nNoNewPrivileges=no\n");
  conflictRunner.stopAll();
  fs.rmSync(conflict, { recursive: true });
}

const ROLLBACK_BASELINE = captureScopedBaseline();
const preConfigurationRunner = new ProofHostCommandRunner({
  failCompatibilityCheck: true,
  hermesInitiallyActive: true,
});
await assert.rejects(
  installHostBootstrap(REQUEST, REQUEST_DIGEST, {
    packageRoot: PACKAGE_ROOT,
    runningPackageVersion: PACKAGE_VERSION,
    requestFilename: REQUEST_FILE,
    commandRunner: preConfigurationRunner,
  }),
  /injected failure|failed safely/,
);
try {
  assert.equal(preConfigurationRunner.hermesActive, true);
  verifyRollback();
} finally {
  preConfigurationRunner.stopAll();
}

for (const failedWrite of [
  path.join(HOST_BOOTSTRAP_PATHS.apiRuntime, "wallet-key"),
  path.join(HOST_BOOTSTRAP_PATHS.authorityPrivate, "telegram-bot-token"),
  OWNER_RECOVERY_FILE,
  HOST_BOOTSTRAP_PATHS.bootstrapReceipt,
]) {
  const partialWriteRunner = new ProofHostCommandRunner({
    hermesInitiallyActive: false,
  });
  await assert.rejects(
    withInjectedWriteFailure(failedWrite, () =>
      installHostBootstrap(REQUEST, REQUEST_DIGEST, {
        packageRoot: PACKAGE_ROOT,
        runningPackageVersion: PACKAGE_VERSION,
        requestFilename: REQUEST_FILE,
        commandRunner: partialWriteRunner,
      })
    ),
    /injected partial write failure|failed safely/,
  );
  try {
    assert.equal(partialWriteRunner.hermesActive, false);
    verifyRollback();
  } finally {
    partialWriteRunner.stopAll();
  }
}

const failureRunner = new ProofHostCommandRunner({
  failAfterStarting: "sompi-api.service",
  hermesInitiallyActive: false,
});
await assert.rejects(
  installHostBootstrap(REQUEST, REQUEST_DIGEST, {
    packageRoot: PACKAGE_ROOT,
    runningPackageVersion: PACKAGE_VERSION,
    requestFilename: REQUEST_FILE,
    commandRunner: failureRunner,
  }),
  /injected failure|failed safely/,
);
try {
  assert.equal(failureRunner.activeServices.size, 0);
  assert.equal(failureRunner.socketProcesses.size, 0);
  assert.equal(failureRunner.hermesActive, false);
  verifyRollback();
} finally {
  failureRunner.stopAll();
}

for (const injectedSystemd of [
  { effectiveFragmentUnit: "sompi-api.service" },
  { effectiveDropInUnit: "sompi-authority.service" },
]) {
  const systemdRunner = new ProofHostCommandRunner({
    ...injectedSystemd,
    hermesInitiallyActive: false,
  });
  await assert.rejects(
    installHostBootstrap(REQUEST, REQUEST_DIGEST, {
      packageRoot: PACKAGE_ROOT,
      runningPackageVersion: PACKAGE_VERSION,
      requestFilename: REQUEST_FILE,
      commandRunner: systemdRunner,
    }),
    /effective Sompi systemd unit projection is unsafe/,
  );
  try {
    assert.equal(
      systemdRunner.commands.some((entry) =>
        entry.command === "systemctl" &&
        entry.args[0] === "enable"
      ),
      false,
    );
    verifyRollback();
  } finally {
    systemdRunner.stopAll();
  }
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  const listenerBaseline = Object.fromEntries(
    ["SIGHUP", "SIGINT", "SIGTERM"].map((name) => [
      name,
      process.listenerCount(name),
    ]),
  );
  const signalRunner = new ProofHostCommandRunner({
    interruptAfterStarting: "sompi-api.service",
    interruptSignal: signal,
    hermesInitiallyActive: false,
  });
  await assert.rejects(
    installHostBootstrap(REQUEST, REQUEST_DIGEST, {
      packageRoot: PACKAGE_ROOT,
      runningPackageVersion: PACKAGE_VERSION,
      requestFilename: REQUEST_FILE,
      commandRunner: signalRunner,
    }),
    new RegExp(`interrupted by ${signal}`),
  );
  try {
    assert.equal(signalRunner.activeServices.size, 0);
    assert.equal(signalRunner.socketProcesses.size, 0);
    assert.equal(signalRunner.hermesActive, false);
    assert.deepEqual(
      signalRunner.commands
        .filter((entry) =>
          entry.command === "systemctl" &&
          entry.args[0] === "disable" &&
          entry.args[1] === "--now"
        )
        .map((entry) => entry.args[2]),
      ["sompi-api.service", "sompi-authority.service"],
    );
    assert.deepEqual(
      Object.fromEntries(
        ["SIGHUP", "SIGINT", "SIGTERM"].map((name) => [
          name,
          process.listenerCount(name),
        ]),
      ),
      listenerBaseline,
    );
    verifyRollback();
  } finally {
    signalRunner.stopAll();
  }
}

const successRunner = new ProofHostCommandRunner();
let receipt;
try {
  receipt = await installHostBootstrap(REQUEST, REQUEST_DIGEST, {
    packageRoot: PACKAGE_ROOT,
    runningPackageVersion: PACKAGE_VERSION,
    requestFilename: REQUEST_FILE,
    commandRunner: successRunner,
  });
  verifySuccess(receipt, successRunner);
  const activationCommandStart = successRunner.commands.length;
  successRunner.effectiveDropInUnit = "sompi-vault-activate.service";
  assert.throws(
    () =>
      activateHostBootstrap(REQUEST, REQUEST_DIGEST, {
        runningPackageVersion: PACKAGE_VERSION,
        commandRunner: successRunner,
      }),
    /effective Sompi systemd unit projection is unsafe/,
  );
  assert.equal(
    successRunner.commands.slice(activationCommandStart).some((entry) =>
      entry.command === "systemctl" &&
      ["stop", "start"].includes(entry.args[0])
    ),
    false,
  );
  successRunner.effectiveDropInUnit = undefined;
} finally {
  successRunner.stopAll();
  ORIGINAL_HERMES_CONFIG.fill(0);
}

const report = {
  schema: "sompi.host-bootstrap-interface-proof.v1",
  status: "pass",
  generatedAt: new Date().toISOString(),
  source: {
    commit: process.env.SOMPI_PROOF_SOURCE_COMMIT ?? "unavailable",
    dirty: process.env.SOMPI_PROOF_SOURCE_DIRTY === "true",
    snapshotSha256: requiredEnvironment("SOMPI_PROOF_SOURCE_SNAPSHOT"),
    packageVersion: PACKAGE_VERSION,
  },
  environment: {
    image: process.env.SOMPI_PROOF_IMAGE ?? "unavailable",
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  topology: TOPOLOGY,
  checks: {
    calledPublicInstallHostBootstrap: true,
    compiledCurrentSourceInDisposableRootContainer: true,
    exactPrincipalAndMembershipTopology: true,
    exactSocketOwnershipModesAndAccess: true,
    generatedSystemdUnitsValidated: true,
    fixtureProcessesFollowedStartupOrderAndSocketReadiness: true,
    fixtureSocketsCreatedByDeclaredPrincipals: true,
    hermesIntegrationFilesAndProjectedConfiguration: true,
    hermesGatewayLifecycleUsedFixtureState: true,
    independentHermesCompatibilityCheckout: true,
    compatibilityBranchRemoteAndVenvPreserved: true,
    compatibilityRemainedValidWithoutSourceCheckout: true,
    authorityCreatedSelectedAgentGroupCallbackSocketWithoutMembership: true,
    apiCannotReadUnrelatedAgentGroupFiles: true,
    dualAgentCredentialsHaveIdenticalBytes: true,
    uidPrivateAgentCredentialHandoff: true,
    hermesEffectiveEnvironmentVerified: true,
    hermesPythonBytecodeWritesDisabled: true,
    positiveAndNegativeSecretAccess: true,
    brokenCleanTargetSymlinkRejectedAndPreserved: true,
    completeSystemdSearchPathConflictsRejected: true,
    effectiveSystemdFragmentAndDropInsVerified: true,
    lateActivationSystemdOverrideRejectedBeforeServiceMutation: true,
    preConfigurationFailureRestoredHermesState: true,
    injectedOwnerRecoveryPartialWriteRolledBack: true,
    injectedReceiptPartialWriteRolledBack: true,
    injectedWalletKeyPartialWriteRolledBack: true,
    injectedTelegramTokenPartialWriteRolledBack: true,
    injectedLateFailureRolledBack: true,
    innerTerminationSignalsTriggeredStrictRollback: true,
    authorityAndApiStartupStateRolledBack: true,
    originalHermesConfigurationRestored: true,
    originalHermesServiceStateRestored: true,
    invocationCreatedPrincipalsAndGroupsRemoved: true,
    ...PRIVILEGED_TRANSACTION,
    reportContainsNoSecretBytes: true,
  },
};

const reportText = `${JSON.stringify(report, null, 2)}\n`;
assert.doesNotMatch(
  reportText,
  /host-bootstrap-proof-token-value/,
  "Host Bootstrap report contains secret bytes",
);
process.stdout.write(reportText);

function verifyRollback() {
  assert.deepEqual(
    captureScopedBaseline(),
    ROLLBACK_BASELINE,
    "injected rollback did not restore the complete scoped baseline",
  );
  for (const principal of [
    HOST_BOOTSTRAP_PRINCIPALS.api,
    HOST_BOOTSTRAP_PRINCIPALS.authority,
  ]) {
    assert.equal(entryExists("passwd", principal), false, `${principal} survived rollback`);
  }
  for (const groupName of Object.values(HOST_BOOTSTRAP_GROUPS)) {
    assert.equal(entryExists("group", groupName), false, `${groupName} survived rollback`);
  }
  assert.deepEqual(groupNames(AGENT_USER), ORIGINAL_AGENT_GROUPS);

  for (const target of [
    "/etc/sompi",
    "/etc/sompi-authority",
    "/etc/sompi-recovery",
    "/var/lib/sompi-api",
    "/var/lib/sompi-authority",
    "/var/lib/sompi-authority-client",
    "/var/lib/sompi-bootstrap",
    "/run/sompi-authority",
    "/run/sompi-telegram-callback",
    "/run/sompi-api",
    "/run/sompi-recovery",
    "/usr/local/bin/sompi-agent",
    "/usr/local/bin/sompi-api",
    "/usr/local/bin/sompi-authority",
    "/usr/local/bin/sompi-operator",
    "/usr/local/bin/sompi-vault-recover",
    HOST_BOOTSTRAP_PATHS.authorityUnit,
    HOST_BOOTSTRAP_PATHS.apiUnit,
    HOST_BOOTSTRAP_PATHS.activationUnit,
    HOST_BOOTSTRAP_PATHS.tmpfiles,
    OWNER_RECOVERY_FILE,
    path.join(AGENT_HOME, ".hermes", "skills", "sompi"),
    path.join(AGENT_HOME, ".hermes", "plugins", "sompi-approval"),
    path.join(
      AGENT_HOME,
      ".config",
      "systemd",
      "user",
      "hermes-gateway.service.d",
      "sompi.conf",
    ),
    expandAgentTopologyPath(HOST_BOOTSTRAP_PATHS.agentCredential),
    path.join(AGENT_HOME, ".sompi", "hermes-compat", PACKAGE_VERSION),
  ]) {
    assert.equal(fs.existsSync(target), false, `${target} survived rollback`);
  }
  assert.equal(fs.existsSync(PACKAGE_ROOT), true);
  assert.equal(fs.existsSync(TOKEN_FILE), true);
  assert.equal(
    fs.readFileSync(path.join(AGENT_HOME, ".hermes", "config.yaml"))
      .equals(ORIGINAL_HERMES_CONFIG),
    true,
  );
  assertFile(path.join(AGENT_HOME, ".hermes", "config.yaml"), {
    uid: AGENT_UID,
    gid: AGENT_GID,
    mode: 0o600,
  });
}

function verifySuccess(receipt, runner) {
  assert.equal(runner.uidPrivateCredentialHandoffVerified, true);
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.package, `@elldeeone/sompi@${PACKAGE_VERSION}`);
  assert.equal(receipt.requestDigest, REQUEST_DIGEST);
  assert.deepEqual(receipt.services, [
    "sompi-authority",
    "sompi-api",
    "hermes-gateway",
  ]);
  assert.equal(receipt.ownerRecoveryFile, OWNER_RECOVERY_FILE);
  const projectedSkill = expandAgentTopologyPath(TOPOLOGY.hermes.skill);
  const projectedPlugin = expandAgentTopologyPath(TOPOLOGY.hermes.plugin);
  const agentCredential = expandAgentTopologyPath(
    TOPOLOGY.secrets.agentCredential,
  );
  assert.equal(TOPOLOGY.hermes.callback, HOST_BOOTSTRAP_PATHS.callbackSocket);
  assert.equal(
    TOPOLOGY.hermes.compatibility,
    "native-hook-or-independent-git-checkout",
  );

  const api = passwd(HOST_BOOTSTRAP_PRINCIPALS.api);
  const authority = passwd(HOST_BOOTSTRAP_PRINCIPALS.authority);
  const apiGroup = group(HOST_BOOTSTRAP_GROUPS.api);
  const authorityGroup = group(HOST_BOOTSTRAP_GROUPS.authority);
  const authorityIpcGroup = group(HOST_BOOTSTRAP_GROUPS.authorityIpc);
  const recoveryGroup = group(HOST_BOOTSTRAP_GROUPS.recovery);

  assert.equal(api.gid, apiGroup.gid);
  assert.equal(authority.gid, authorityGroup.gid);
  assert.deepEqual(groupNames(AGENT_USER).sort(), [...ORIGINAL_AGENT_GROUPS].sort());
  assert.deepEqual(groupNames(HOST_BOOTSTRAP_PRINCIPALS.api).sort(), [
    HOST_BOOTSTRAP_GROUPS.api,
    HOST_BOOTSTRAP_GROUPS.authorityIpc,
    HOST_BOOTSTRAP_GROUPS.recovery,
  ].sort());
  assert.deepEqual(groupNames(HOST_BOOTSTRAP_PRINCIPALS.authority).sort(), [
    HOST_BOOTSTRAP_GROUPS.authority,
    HOST_BOOTSTRAP_GROUPS.authorityIpc,
  ].sort());
  assert.equal(
    runner.callbackServerPrincipal,
    HOST_BOOTSTRAP_PRINCIPALS.authority,
  );

  assertDirectory("/etc/sompi", {
    uid: 0,
    gid: apiGroup.gid,
    mode: 0o750,
  });
  assertFile(HOST_BOOTSTRAP_PATHS.apiManifest, {
    uid: 0,
    gid: apiGroup.gid,
    mode: 0o640,
  });
  assertFile(HOST_BOOTSTRAP_PATHS.apiCredential, {
    uid: 0,
    gid: apiGroup.gid,
    mode: 0o640,
  });
  assertFile(agentCredential, {
    uid: AGENT_UID,
    gid: AGENT_GID,
    mode: 0o600,
  });
  const apiCredentialBytes = fs.readFileSync(HOST_BOOTSTRAP_PATHS.apiCredential);
  const agentCredentialBytes = fs.readFileSync(agentCredential);
  try {
    assert.equal(apiCredentialBytes.length > 0, true);
    assert.deepEqual(agentCredentialBytes, apiCredentialBytes);
  } finally {
    apiCredentialBytes.fill(0);
    agentCredentialBytes.fill(0);
  }
  assertDirectory("/etc/sompi-authority", {
    uid: 0,
    gid: authorityIpcGroup.gid,
    mode: 0o750,
  });
  assertFile(HOST_BOOTSTRAP_PATHS.authorityManifest, {
    uid: 0,
    gid: authorityIpcGroup.gid,
    mode: 0o640,
  });
  assertDirectory(path.dirname(HOST_BOOTSTRAP_PATHS.recoveryCredential), {
    uid: 0,
    gid: recoveryGroup.gid,
    mode: 0o750,
  });
  assertFile(HOST_BOOTSTRAP_PATHS.recoveryCredential, {
    uid: 0,
    gid: recoveryGroup.gid,
    mode: 0o640,
  });

  const apiRuntimeExpectation = {
    uid: api.uid,
    gid: apiGroup.gid,
    mode: 0o700,
  };
  assertDirectory("/var/lib/sompi-api", apiRuntimeExpectation);
  assertDirectory(HOST_BOOTSTRAP_PATHS.apiRuntime, apiRuntimeExpectation);
  assertFile(path.join(HOST_BOOTSTRAP_PATHS.apiRuntime, "wallet-key"), {
    uid: api.uid,
    gid: apiGroup.gid,
    mode: 0o600,
  });
  assertDirectory(HOST_BOOTSTRAP_PATHS.authorityPrivate, {
    uid: authority.uid,
    gid: authorityGroup.gid,
    mode: 0o700,
  });
  assertDirectory(HOST_BOOTSTRAP_PATHS.authorityClient, {
    uid: api.uid,
    gid: apiGroup.gid,
    mode: 0o700,
  });
  assertFile(OWNER_RECOVERY_FILE, {
    uid: 0,
    gid: 0,
    mode: 0o600,
  });
  assertFile(HOST_BOOTSTRAP_PATHS.bootstrapReceipt, {
    uid: 0,
    gid: 0,
    mode: 0o600,
  });

  for (const socket of TOPOLOGY.sockets) {
    const expectedUid = passwd(socket.owner).uid;
    const expectedGid = socket.group === "selected-agent-primary-group"
      ? AGENT_GID
      : group(socket.group).gid;
    const stat = fs.lstatSync(socket.path);
    assert.equal(stat.isSocket(), true, `${socket.path} is not a socket`);
    assert.equal(stat.uid, expectedUid);
    assert.equal(stat.gid, expectedGid);
    assert.equal(stat.mode & 0o777, Number.parseInt(socket.mode, 8));
    assertDirectory(path.dirname(socket.path), {
      uid: expectedUid,
      gid: expectedGid,
      mode: Number.parseInt(socket.directoryMode, 8),
    });
    assert.equal(
      runner.fixturePrincipals.get(socket.path),
      socket.owner,
      `${socket.path} fixture did not run as ${socket.owner}`,
    );
  }

  const authorityStart = commandIndex(
    runner.commands,
    "systemctl",
    ["enable", "--now", "sompi-authority.service"],
  );
  const apiStart = commandIndex(
    runner.commands,
    "systemctl",
    ["enable", "--now", "sompi-api.service"],
  );
  const hermesRestart = runner.commands.findIndex((entry) =>
    entry.command === "runuser" &&
    entry.args.includes("restart") &&
    entry.args.includes("hermes-gateway.service")
  );
  assert.ok(authorityStart >= 0);
  assert.ok(apiStart > authorityStart);
  assert.ok(hermesRestart > apiStart);

  assert.equal(
    fs.existsSync(path.join(projectedSkill, "SKILL.md")),
    true,
  );
  assertAccess(
    AGENT_USER,
    path.join(projectedSkill, "SKILL.md"),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(projectedPlugin, "plugin.yaml")),
    true,
  );
  const dropInPath = path.join(
    AGENT_HOME,
    ".config",
    "systemd",
    "user",
    "hermes-gateway.service.d",
    "sompi.conf",
  );
  assertAccess(
    AGENT_USER,
    path.join(projectedPlugin, "plugin.yaml"),
    true,
  );
  assertAccess(AGENT_USER, dropInPath, true);
  const dropIn = fs.readFileSync(dropInPath, "utf8");
  const compatibilityRoot = path.join(
    AGENT_HOME,
    ".sompi",
    "hermes-compat",
    PACKAGE_VERSION,
  );
  assert.equal(fs.existsSync(path.join(compatibilityRoot, ".git")), true);
  assert.equal(
    runAgentGit(runner, compatibilityRoot, ["branch", "--show-current"]).trim(),
    "proof-main",
  );
  assert.equal(
    runAgentGit(runner, compatibilityRoot, ["remote", "get-url", "origin"]).trim(),
    "https://example.invalid/hermes-agent.git",
  );
  assert.equal(
    fs.existsSync(
      path.join(compatibilityRoot, ".git", "objects", "info", "alternates"),
    ),
    false,
  );
  runAgentGit(runner, compatibilityRoot, ["cat-file", "-e", "HEAD^{tree}"]);
  runAgentGit(runner, compatibilityRoot, ["fsck", "--full"]);
  assert.equal(
    fs.realpathSync(path.join(compatibilityRoot, "venv")),
    path.join(AGENT_HOME, ".hermes", "hermes-agent", "venv"),
  );
  assert.match(
    fs.readFileSync(
      path.join(
        compatibilityRoot,
        "plugins",
        "platforms",
        "telegram",
        "adapter.py",
      ),
      "utf8",
    ),
    /dispatch_plugin_callback_query/,
  );
  verifyCompatibilityIndependence(runner, compatibilityRoot);
  assert.match(dropIn, /PYTHONDONTWRITEBYTECODE=1/);
  assert.match(dropIn, new RegExp(
    `PYTHONPATH=${escapeRegularExpression(compatibilityRoot)}`,
  ));
  assert.match(dropIn, /SOMPI_API_SOCKET=\/run\/sompi-api\/sompi\.sock/);
  assert.match(
    dropIn,
    new RegExp(
      `SOMPI_AGENT_API_CREDENTIAL=${escapeRegularExpression(agentCredential)}`,
    ),
  );
  assert.deepEqual(
    Object.fromEntries(runner.hermesEffectiveEnvironment),
    {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: compatibilityRoot,
      SOMPI_API_SOCKET: HOST_BOOTSTRAP_PATHS.agentApiSocket,
      SOMPI_AGENT_API_CREDENTIAL: agentCredential,
      SOMPI_OPERATOR_UID: "0",
      SOMPI_API_UID: String(api.uid),
      SOMPI_RUNTIME_GID: String(AGENT_GID),
      SOMPI_API_SOCKET_GID: String(AGENT_GID),
    },
  );
  const hermesConfigurationCommands = runner.commands.filter((entry) =>
    entry.command === "runuser" &&
    entry.args.includes("hermes_cli.main")
  );
  assert.ok(hermesConfigurationCommands.length >= 3);
  assert.equal(
    hermesConfigurationCommands.every((entry) =>
      entry.args.includes("PYTHONDONTWRITEBYTECODE=1")
    ),
    true,
  );
  const hermesConfig = fs.readFileSync(
    path.join(AGENT_HOME, ".hermes", "config.yaml"),
    "utf8",
  );
  assert.match(
    hermesConfig,
    /callback_socket: \/run\/sompi-telegram-callback\/telegram-callback\.sock/,
  );
  assert.match(hermesConfig, /timeout_ms: 2000/);
  assert.match(hermesConfig, /enabled: true/);
  assert.match(hermesConfig, /allow_tool_override: false/);

  verifyProjectedAccess();

  const apiUnit = fs.readFileSync(HOST_BOOTSTRAP_PATHS.apiUnit, "utf8");
  assert.match(apiUnit, /After=.*sompi-authority\.service/);
  assert.match(apiUnit, /Requires=sompi-authority\.service/);
  assert.match(apiUnit, /User=sompi-api/);
  assert.match(
    apiUnit,
    /SupplementaryGroups=sompi-authority-ipc sompi-recovery/,
  );
  assert.doesNotMatch(apiUnit, /SupplementaryGroups=.*hermes-proof/);
  assert.match(apiUnit, new RegExp(`SOMPI_RUNTIME_GID=${apiGroup.gid}`));
  assert.match(apiUnit, new RegExp(`SOMPI_API_SOCKET_GID=${AGENT_GID}`));
  assert.match(
    apiUnit,
    /SOMPI_AGENT_API_CREDENTIAL=\/etc\/sompi\/agent-api\.json/,
  );
  const authorityUnit = fs.readFileSync(HOST_BOOTSTRAP_PATHS.authorityUnit, "utf8");
  assert.match(authorityUnit, /User=sompi-authority/);
  assert.match(authorityUnit, /SupplementaryGroups=sompi-authority-ipc/);
  assert.doesNotMatch(authorityUnit, /SupplementaryGroups=.*hermes-proof/);
  assertAccess(AGENT_USER, AGENT_GROUP_SENTINEL, true);
  assertAccess(HOST_BOOTSTRAP_PRINCIPALS.api, AGENT_GROUP_SENTINEL, false);
  verifySystemdUnits();
}

function verifyProjectedAccess() {
  for (const access of TOPOLOGY.access) {
    const user = access.principal === "agent"
      ? AGENT_USER
      : access.principal === "operator"
        ? "root"
        : access.principal;
    for (const check of access.checks) {
      const checkedPath = check.path.startsWith("~/")
        ? expandAgentTopologyPath(check.path)
        : check.path;
      if (check.kind === "read") {
        assertAccess(user, checkedPath, check.allowed);
      } else {
        assertSocketAccess(user, checkedPath, check.allowed);
      }
    }
  }
}

function expandAgentTopologyPath(value) {
  assert.match(value, /^~\/[A-Za-z0-9._/-]+$/);
  return path.join(AGENT_HOME, value.slice(2));
}

function verifySystemdUnits() {
  const units = [
    HOST_BOOTSTRAP_PATHS.authorityUnit,
    HOST_BOOTSTRAP_PATHS.apiUnit,
    HOST_BOOTSTRAP_PATHS.activationUnit,
  ];
  runReal("systemd-analyze", ["verify", ...units]);
  for (const unit of units) {
    const start = fs.readFileSync(unit, "utf8")
      .split("\n")
      .find((line) => line.startsWith("ExecStart="));
    assert.ok(start, `${unit} has no ExecStart`);
    const executable = start.slice("ExecStart=".length).split(/\s+/, 1)[0];
    fs.accessSync(executable, fs.constants.X_OK);
  }
}

function assertAccess(user, target, expected) {
  const result = spawnSync("runuser", [
    "-u",
    user,
    "--",
    "test",
    "-r",
    target,
  ], {
    encoding: "utf8",
  });
  assert.equal(
    result.status === 0,
    expected,
    `${user} read access for ${target} was ${result.status === 0}`,
  );
}

function assertSocketAccess(user, socketPath, expected) {
  const program = [
    "const net = require('node:net');",
    "const socket = net.createConnection(process.argv[1]);",
    "const timeout = setTimeout(() => { socket.destroy(); process.exit(2); }, 1000);",
    "socket.on('connect', () => { clearTimeout(timeout); socket.end(); });",
    "socket.on('close', () => process.exit(0));",
    "socket.on('error', () => { clearTimeout(timeout); process.exit(1); });",
  ].join("");
  const result = spawnSync("runuser", [
    "-u",
    user,
    "--",
    process.execPath,
    "-e",
    program,
    socketPath,
  ], {
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(
    result.status === 0,
    expected,
    `${user} socket access for ${socketPath} was ${result.status === 0}`,
  );
}

function assertDirectory(target, expectation) {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isDirectory(), true, `${target} is not a directory`);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.uid, expectation.uid);
  assert.equal(stat.gid, expectation.gid);
  assert.equal(stat.mode & 0o7777, expectation.mode);
}

function assertFile(target, expectation) {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isFile(), true, `${target} is not a file`);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.uid, expectation.uid);
  assert.equal(stat.gid, expectation.gid);
  assert.equal(stat.mode & 0o777, expectation.mode);
}

function passwd(name) {
  const output = runReal("getent", ["passwd", name]).trim();
  const fields = output.split(":");
  assert.equal(fields.length, 7);
  return {
    name: fields[0],
    uid: Number(fields[2]),
    gid: Number(fields[3]),
    home: fields[5],
  };
}

function group(name) {
  const output = runReal("getent", ["group", name]).trim();
  const fields = output.split(":");
  assert.equal(fields.length, 4);
  return {
    name: fields[0],
    gid: Number(fields[2]),
    members: fields[3] ? fields[3].split(",") : [],
  };
}

function principalIds(user, groupName) {
  return {
    uid: passwd(user).uid,
    gid: group(groupName).gid,
  };
}

function groupNames(user) {
  return runReal("id", ["-nG", user]).trim().split(/\s+/).filter(Boolean);
}

function entryExists(database, name) {
  const result = spawnSync("getent", [database, name], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function commandIndex(commands, command, args) {
  return commands.findIndex((entry) =>
    entry.command === command &&
    entry.args.length === args.length &&
    entry.args.every((value, index) => value === args[index])
  );
}

function runAgentGit(runner, repository, args) {
  return runner.run("runuser", [
    "-u",
    AGENT_USER,
    "--",
    "git",
    "-C",
    repository,
    ...args,
  ]);
}

function verifyCompatibilityIndependence(runner, compatibilityRoot) {
  const sourceCheckout = path.join(AGENT_HOME, ".hermes", "hermes-agent");
  const movedCheckout = `${sourceCheckout}.sompi-proof-moved`;
  assert.equal(fs.existsSync(movedCheckout), false);
  fs.renameSync(sourceCheckout, movedCheckout);
  try {
    assert.notEqual(
      runAgentGit(runner, compatibilityRoot, ["status", "--short"]).trim(),
      "",
    );
    runAgentGit(runner, compatibilityRoot, ["cat-file", "-e", "HEAD^{tree}"]);
    runAgentGit(runner, compatibilityRoot, ["fsck", "--full"]);
  } finally {
    fs.renameSync(movedCheckout, sourceCheckout);
  }
}

async function withInjectedWriteFailure(target, action) {
  const require = createRequire(import.meta.url);
  const mutableFs = require("node:fs");
  const originalWriteFileSync = mutableFs.writeFileSync;
  let injected = false;
  mutableFs.writeFileSync = function injectedWriteFileSync(
    filename,
    ...args
  ) {
    const result = originalWriteFileSync.call(this, filename, ...args);
    if (!injected && typeof filename === "number") {
      let openedPath;
      try {
        openedPath = mutableFs.readlinkSync(`/proc/self/fd/${filename}`);
      } catch {
        openedPath = undefined;
      }
      if (openedPath === target) {
        injected = true;
        throw new Error(`injected partial write failure for ${target}`);
      }
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    mutableFs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
    assert.equal(injected, true, `partial write fault did not reach ${target}`);
  }
}

function runReal(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout ?? "";
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function captureScopedBaseline() {
  const scopedPaths = [
    "/etc/sompi",
    "/etc/sompi-authority",
    "/etc/sompi-recovery",
    "/etc/systemd/system",
    "/etc/tmpfiles.d",
    "/var/lib/sompi-api",
    "/var/lib/sompi-authority",
    "/var/lib/sompi-authority-client",
    "/var/lib/sompi-bootstrap",
    "/run/sompi-authority",
    "/run/sompi-telegram-callback",
    "/run/sompi-api",
    "/run/sompi-recovery",
    "/usr/local/bin/sompi-agent",
    "/usr/local/bin/sompi-api",
    "/usr/local/bin/sompi-authority",
    "/usr/local/bin/sompi-operator",
    "/usr/local/bin/sompi-vault-recover",
    OWNER_RECOVERY_FILE,
    TOKEN_FILE,
    AGENT_GROUP_SENTINEL,
    path.join(AGENT_HOME, ".hermes"),
    path.join(AGENT_HOME, ".config"),
    path.join(AGENT_HOME, ".sompi"),
    path.join(PACKAGE_ROOT, "dist", "agent-main.js"),
    path.join(PACKAGE_ROOT, "dist", "api-main.js"),
    path.join(PACKAGE_ROOT, "dist", "authority-main.js"),
    path.join(PACKAGE_ROOT, "dist", "operator-main.js"),
    path.join(PACKAGE_ROOT, "scripts", "vault-recover.js"),
  ];
  const servicePrincipals = [
    HOST_BOOTSTRAP_PRINCIPALS.api,
    HOST_BOOTSTRAP_PRINCIPALS.authority,
  ];
  const serviceGroups = Object.values(HOST_BOOTSTRAP_GROUPS);
  return {
    filesystem: Object.fromEntries(
      scopedPaths.map((target) => [target, snapshotFilesystem(target)]),
    ),
    transientCandidates: fs.readdirSync("/var/lib")
      .filter((entry) => entry.startsWith(".sompi-bootstrap-"))
      .sort(),
    principals: Object.fromEntries(
      [AGENT_USER, ...servicePrincipals].map((name) => [
        name,
        getentState("passwd", name),
      ]),
    ),
    groups: Object.fromEntries(
      [AGENT_USER, ...serviceGroups].map((name) => [
        name,
        getentState("group", name),
      ]),
    ),
    memberships: Object.fromEntries(
      [AGENT_USER, ...servicePrincipals].map((name) => [
        name,
        entryExists("passwd", name)
          ? {
              ids: runReal("id", ["-G", name]).trim(),
              names: runReal("id", ["-nG", name]).trim(),
            }
          : null,
      ]),
    ),
    systemDatabases: Object.fromEntries(
      ["/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow"]
        .filter((filename) => fs.existsSync(filename))
        .map((filename) => [
          filename,
          createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
        ]),
    ),
  };
}

function snapshotFilesystem(target) {
  if (!fs.existsSync(target) && !isSymbolicLink(target)) {
    return { exists: false };
  }
  const entries = [];
  visit(target, ".");
  return {
    exists: true,
    entries,
  };

  function visit(filename, relative) {
    const stat = fs.lstatSync(filename);
    const common = {
      path: relative,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o7777,
    };
    if (stat.isDirectory()) {
      entries.push({ ...common, type: "directory" });
      for (const name of fs.readdirSync(filename).sort()) {
        visit(path.join(filename, name), path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      entries.push({
        ...common,
        type: "file",
        size: stat.size,
        sha256: createHash("sha256")
          .update(fs.readFileSync(filename))
          .digest("hex"),
      });
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({
        ...common,
        type: "symbolic-link",
        target: fs.readlinkSync(filename),
      });
      return;
    }
    entries.push({ ...common, type: "other" });
  }
}

function isSymbolicLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function getentState(database, name) {
  const result = spawnSync("getent", [database, name], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}
