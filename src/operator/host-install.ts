import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { initializeAuthorityRuntime, authorityRuntimePaths } from "../authority/runtime.js";
import { generateOwnerKey } from "../vault.js";
import { generateWalletKey } from "../wallet.js";
import { installAgentApiCredential, installRecoveryApiCredential } from "./api-credential.js";
import { canonicalOperatorManifestBytes } from "./manifest.js";
import {
  HostBootstrapError,
  hostBootstrapRequestDigest,
  operatorSpecForHostBootstrap,
  parseHostBootstrapRequest,
  type HostBootstrapRequest,
} from "./host-bootstrap.js";
import {
  installOperatorCandidate,
  operatorProvisioningStatus,
  provisionOperatorCandidate,
} from "./provisioning.js";

const PACKAGE_NAME = "@elldeeone/sompi";
const INSTALL_ROOT = "/opt/sompi/releases";
const API_USER = "sompi-api";
const AUTHORITY_USER = "sompi-authority";
const AUTHORITY_IPC_GROUP = "sompi-authority-ipc";
const RECOVERY_GROUP = "sompi-recovery";
const API_MANIFEST = "/etc/sompi/operator-manifest.json";
const AUTHORITY_MANIFEST = "/etc/sompi-authority/operator-manifest.json";
const AGENT_CREDENTIAL = "/etc/sompi/agent-api.json";
const RECOVERY_CREDENTIAL = "/etc/sompi/recovery-api.json";
const API_SOCKET = "/run/sompi-api/sompi.sock";
const RECOVERY_SOCKET = "/run/sompi-recovery/recovery.sock";
const AUTHORITY_SOCKET = "/run/sompi-authority/authority.sock";
const CALLBACK_SOCKET = "/run/sompi-telegram-callback/telegram-callback.sock";

interface PrincipalIds {
  readonly apiUid: number;
  readonly apiGid: number;
  readonly authorityUid: number;
  readonly authorityGid: number;
  readonly authorityIpcGid: number;
  readonly agentApiGid: number;
  readonly recoveryGid: number;
  readonly callbackGid: number;
  readonly agentUid: number;
  readonly agentGid: number;
  readonly agentGroupName: string;
  readonly agentHome: string;
}

interface HermesConfigSnapshot {
  readonly filename: string;
  readonly bytes?: Buffer;
  readonly mode?: number;
}

export interface HostInstallOptions {
  readonly packageRoot: string;
  readonly runningPackageVersion: string;
  readonly requestFilename: string;
  /** Hermetic tests only. Production always uses the real host command runner. */
  readonly commandRunner?: HostCommandRunner;
}

export interface HostActivationOptions {
  readonly runningPackageVersion: string;
  readonly commandRunner?: HostCommandRunner;
}

export interface HostActivationReceipt {
  readonly status: "ready";
  readonly package: string;
  readonly requestDigest: string;
  readonly fundingAddress: string;
  readonly vaultAddress: string;
  readonly covenantId: string;
  readonly currentOutpoint: Readonly<{ txid: string; index: number }>;
  readonly next: "ask the agent to buy an allowed testnet resource";
}

export interface HostCommandRunner {
  run(command: string, args: readonly string[], options?: Readonly<{ cwd?: string }>): string;
}

export interface HostBootstrapReceipt {
  readonly status: "ready";
  readonly package: string;
  readonly requestDigest: string;
  readonly manifestDigest: string;
  readonly vaultAddress: string;
  readonly fundingAddress: string;
  readonly minimumFundingSompi: string;
  readonly ownerRecoveryFile: string;
  readonly agent: Readonly<{ kind: "hermes"; user: string }>;
  readonly services: readonly ["sompi-authority", "sompi-api", "hermes-gateway"];
  readonly activateCommand: string;
  readonly next: "fund the displayed Testnet-10 funding address, then run activateCommand";
}

export async function installHostBootstrap(
  requestInput: HostBootstrapRequest,
  expectedDigest: string,
  options: HostInstallOptions,
): Promise<HostBootstrapReceipt> {
  const request = parseHostBootstrapRequest(requestInput);
  const digest = hostBootstrapRequestDigest(request);
  if (digest !== expectedDigest) throw new HostBootstrapError("host bootstrap digest does not match the reviewed request");
  if (request.packageVersion !== options.runningPackageVersion) {
    throw new HostBootstrapError("host bootstrap request does not match the running package version");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new HostBootstrapError("host bootstrap must run as root outside the agent session");
  }
  const runner = options.commandRunner ?? new SystemHostCommandRunner();
  preflightCleanHost(request, options.packageRoot, runner);
  const releasePackageRoot = ensureReleasePackage(request.packageVersion, options.packageRoot, runner);
  const ids = ensurePrincipals(request.agent.user, runner);
  const token = readOrPromptTelegramToken(request.telegramBotTokenFile);
  const hermesConfig = snapshotHermesConfig(ids);
  const owner = generateOwnerKey();
  const created: string[] = [];
  const candidate = path.join("/var/lib", `.sompi-bootstrap-${process.pid}-${Date.now()}`);
  let stage = "validating the reviewed request";
  try {
    const telegram = request.operator.authority.telegram;
    if (!telegram || !token.toString("utf8").trim().startsWith(`${telegram.botId}:`)) {
      throw new HostBootstrapError("Telegram bot token does not match the reviewed bot ID");
    }
    stage = "provisioning the operator manifest";
    const spec = operatorSpecForHostBootstrap(request, owner.publicKey);
    const provisioned = provisionOperatorCandidate(spec, candidate);
    created.push(candidate);

    const apiStateParent = path.dirname(spec.dataDirectory);
    if (!fs.existsSync(apiStateParent)) created.push(apiStateParent);
    installOperatorCandidate(candidate, API_MANIFEST, provisioned.digest, {
      operatorUserId: 0,
      runtimeUserId: ids.apiUid,
      runtimeGroupId: ids.agentApiGid,
    });
    created.push(spec.dataDirectory, "/etc/sompi");
    prepareStateDirectory(apiStateParent, ids.apiUid, ids.apiGid);
    const fundingAddress = installFundingWallet(spec.dataDirectory, ids);
    installAuthorityManifest(provisioned.manifest, ids.authorityIpcGid);
    created.push("/etc/sompi-authority");
    installAgentApiCredential(AGENT_CREDENTIAL, { operatorUserId: 0, runtimeGroupId: ids.agentApiGid });
    installRecoveryApiCredential(RECOVERY_CREDENTIAL, { operatorUserId: 0, runtimeGroupId: ids.recoveryGid });

    stage = "initializing the trusted Authority";
    const authorityPaths = authorityRuntimePaths({
      privateDirectory: "/var/lib/sompi-authority/private",
      clientDirectory: "/var/lib/sompi-authority-client",
      runtimeDirectory: "/run/sompi-authority",
      callbackRuntimeDirectory: "/run/sompi-telegram-callback",
      socketPath: AUTHORITY_SOCKET,
    });
    if (!fs.existsSync(path.dirname(authorityPaths.privateDirectory))) {
      created.push(path.dirname(authorityPaths.privateDirectory));
    }
    created.push(
      "/var/lib/sompi-authority",
      "/var/lib/sompi-authority-client",
      "/run/sompi-authority",
      "/run/sompi-telegram-callback",
    );
    await initializeAuthorityRuntime(authorityPaths, {
      issuer: authorityIssuer(request.agent.user),
      kid: "authority-signing-key-1",
    });
    prepareStateDirectory(path.dirname(authorityPaths.privateDirectory), ids.authorityUid, ids.authorityGid);
    writeSecret(authorityPaths.telegramBotToken, token, ids.authorityUid, ids.authorityGid);
    chownTree(authorityPaths.privateDirectory, ids.authorityUid, ids.authorityGid, 0o700, 0o600);
    chownTree(authorityPaths.clientDirectory, ids.apiUid, ids.apiGid, 0o700, 0o600);
    prepareRuntimeDirectory("/run/sompi-authority", ids.authorityUid, ids.authorityIpcGid);
    prepareRuntimeDirectory("/run/sompi-telegram-callback", ids.authorityUid, ids.callbackGid);
    prepareRuntimeDirectory("/run/sompi-api", ids.apiUid, ids.agentApiGid);
    prepareRuntimeDirectory("/run/sompi-recovery", ids.apiUid, ids.recoveryGid);

    stage = "installing recovery and service assets";
    created.push(request.ownerRecoveryFile);
    installRecoveryRecord(request.ownerRecoveryFile, {
      requestDigest: digest,
      ownerPrivate: owner.privateKey,
      ownerPublic: owner.publicKey,
      vaultAddress: provisioned.vaultAddress,
      manifestDigest: provisioned.digest,
    });
    created.push(...executableLinks());
    installExecutables(releasePackageRoot);
    created.push(
      "/etc/systemd/system/sompi-api.service",
      "/etc/systemd/system/sompi-authority.service",
      "/etc/systemd/system/sompi-vault-activate.service",
      "/etc/tmpfiles.d/sompi.conf",
    );
    installSystemd(releasePackageRoot, request, ids);
    stage = "installing the Hermes integration";
    created.push(path.join(ids.agentHome, ".hermes", "skills", "sompi"));
    created.push(path.join(ids.agentHome, ".hermes", "plugins", "sompi-approval"));
    created.push(path.join(ids.agentHome, ".sompi", "hermes-compat", request.packageVersion));
    const hermesPythonPath = installHermesIntegration(releasePackageRoot, request, ids, runner);
    created.push(path.join(ids.agentHome, ".config", "systemd", "user", "hermes-gateway.service.d", "sompi.conf"));
    installHermesServiceDropIn(request, ids, hermesPythonPath);
    configureHermes(request, ids, hermesPythonPath, runner);

    stage = "starting and verifying services";
    runner.run("systemctl", ["daemon-reload"]);
    runner.run("systemd-tmpfiles", ["--create", "/etc/tmpfiles.d/sompi.conf"]);
    runner.run("systemctl", ["enable", "--now", "sompi-authority.service"]);
    runner.run("systemctl", ["enable", "--now", "sompi-api.service"]);
    restartHermes(ids, runner);
    assertServiceActive("sompi-authority.service", runner);
    assertServiceActive("sompi-api.service", runner);
    assertHermesActive(ids, runner);
    operatorProvisioningStatus(API_MANIFEST, {
      operatorUserId: 0,
      runtimeUserId: ids.apiUid,
      runtimeGroupId: ids.agentApiGid,
    });
    const receipt: HostBootstrapReceipt = Object.freeze({
      status: "ready",
      package: `${PACKAGE_NAME}@${request.packageVersion}`,
      requestDigest: digest,
      manifestDigest: provisioned.digest,
      vaultAddress: provisioned.vaultAddress,
      fundingAddress,
      minimumFundingSompi: minimumFundingSompi(request),
      ownerRecoveryFile: request.ownerRecoveryFile,
      agent: request.agent,
      services: ["sompi-authority", "sompi-api", "hermes-gateway"] as const,
      activateCommand: `sudo sompi-operator bootstrap-activate ${shellQuote(path.resolve(options.requestFilename))} ${shellQuote(digest)}`,
      next: "fund the displayed Testnet-10 funding address, then run activateCommand",
    });
    writeBootstrapReceipt(receipt);
    fs.rmSync(candidate, { recursive: true, force: true });
    return receipt;
  } catch (cause) {
    rollbackUnfundedInstall(created, request, runner);
    restoreHermesConfig(hermesConfig, ids, runner);
    if (cause instanceof HostBootstrapError) throw cause;
    throw new HostBootstrapError(`host bootstrap failed safely during ${stage} and removed incomplete unfunded state`, { cause });
  } finally {
    token.fill(0);
    hermesConfig.bytes?.fill(0);
  }
}

export function activateHostBootstrap(
  requestInput: HostBootstrapRequest,
  expectedDigest: string,
  options: HostActivationOptions,
): HostActivationReceipt {
  const request = parseHostBootstrapRequest(requestInput);
  const digest = hostBootstrapRequestDigest(request);
  if (digest !== expectedDigest) throw new HostBootstrapError("host activation digest does not match the reviewed request");
  if (request.packageVersion !== options.runningPackageVersion) throw new HostBootstrapError("host activation package version changed");
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new HostBootstrapError("host activation must run as root outside the agent session");
  }
  const runner = options.commandRunner ?? new SystemHostCommandRunner();
  const ids = ensurePrincipals(request.agent.user, runner);
  const receipt = readBootstrapReceipt();
  if (
    receipt.requestDigest !== digest ||
    receipt.package !== `${PACKAGE_NAME}@${request.packageVersion}` ||
    !/^kaspatest:[a-z0-9]{11,240}$/.test(receipt.fundingAddress)
  ) {
    throw new HostBootstrapError("host activation does not match the installed bootstrap receipt");
  }
  const expectedUnit = renderVaultActivationUnit(request, ids);
  if (readRegularText("/etc/systemd/system/sompi-vault-activate.service", 64 * 1024, 0) !== expectedUnit) {
    throw new HostBootstrapError("vault activation service changed after bootstrap");
  }
  runner.run("systemctl", ["stop", "sompi-api.service"]);
  try {
    runner.run("systemctl", ["start", "sompi-vault-activate.service"]);
  } finally {
    runner.run("systemctl", ["start", "sompi-api.service"]);
  }
  assertServiceActive("sompi-authority.service", runner);
  assertServiceActive("sompi-api.service", runner);
  const vault = readActivatedVaultConfig("/var/lib/sompi-api/runtime/vault/config.json", ids.apiUid);
  return Object.freeze({
    status: "ready",
    package: receipt.package,
    requestDigest: digest,
    fundingAddress: receipt.fundingAddress,
    vaultAddress: vault.address,
    covenantId: vault.covenantId,
    currentOutpoint: vault.currentOutpoint,
    next: "ask the agent to buy an allowed testnet resource",
  });
}

function preflightCleanHost(request: HostBootstrapRequest, packageRoot: string, runner: HostCommandRunner): void {
  for (const command of ["getent", "groupadd", "useradd", "usermod", "npm", "git", "systemctl", "systemd-tmpfiles"]) {
    runner.run("sh", ["-c", `command -v ${command} >/dev/null`]);
  }
  if (!fs.existsSync("/run/systemd/system")) throw new HostBootstrapError("host bootstrap requires systemd");
  for (const target of [
    API_MANIFEST,
    AUTHORITY_MANIFEST,
    "/var/lib/sompi-api/runtime",
    "/var/lib/sompi-authority/private",
    "/var/lib/sompi-bootstrap/receipt.json",
    "/etc/systemd/system/sompi-api.service",
    "/etc/systemd/system/sompi-authority.service",
    "/etc/systemd/system/sompi-vault-activate.service",
    request.ownerRecoveryFile,
    ...executableLinks(),
  ]) {
    if (fs.existsSync(target)) throw new HostBootstrapError("host bootstrap requires a clean host without active Sompi state");
  }
  const packageStat = fs.lstatSync(path.resolve(packageRoot));
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new HostBootstrapError("running Sompi package root is unsafe");
  const passwd = getPasswd(request.agent.user, runner);
  const checkout = path.join(passwd.home, ".hermes", "hermes-agent");
  const python = path.join(checkout, "venv", "bin", "python");
  if (!fs.existsSync(python) || !fs.existsSync(path.join(checkout, "plugins", "platforms", "telegram", "adapter.py"))) {
    throw new HostBootstrapError("Hermes checkout or runtime is unavailable for the selected OS user");
  }
  for (const target of [
    path.join(passwd.home, ".hermes", "skills", "sompi"),
    path.join(passwd.home, ".hermes", "plugins", "sompi-approval"),
    path.join(passwd.home, ".config", "systemd", "user", "hermes-gateway.service.d", "sompi.conf"),
  ]) {
    if (fs.existsSync(target)) throw new HostBootstrapError("host bootstrap requires a clean Hermes integration target");
  }
  if (fs.existsSync(request.telegramBotTokenFile)) {
    readRootSecret(request.telegramBotTokenFile, "Telegram bot token").fill(0);
  } else if (!fs.existsSync("/dev/tty")) {
    throw new HostBootstrapError("Telegram bot token file is absent and no local operator terminal is available");
  }
}

function ensureReleasePackage(version: string, currentPackageRoot: string, runner: HostCommandRunner): string {
  const releasePrefix = path.join(INSTALL_ROOT, version);
  const installedRoot = path.join(releasePrefix, "node_modules", "@elldeeone", "sompi");
  const current = fs.realpathSync(path.resolve(currentPackageRoot));
  if (fs.existsSync(installedRoot) && fs.realpathSync(installedRoot) === current) return installedRoot;
  if (fs.existsSync(releasePrefix)) throw new HostBootstrapError("Sompi release target already exists but is not the running package");
  fs.mkdirSync(releasePrefix, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(releasePrefix, "package.json"), `${JSON.stringify({
    private: true,
  })}\n`, { mode: 0o644 });
  runner.run(process.execPath, [
    path.join(currentPackageRoot, "scripts", "install-runtime-package.mjs"),
    "--prefix", releasePrefix,
    "--package", `${PACKAGE_NAME}@${version}`,
    "--expected-version", version,
    "--omit-dev",
  ]);
  if (!fs.existsSync(installedRoot)) throw new HostBootstrapError("exact Sompi release was not installed");
  return installedRoot;
}

function ensurePrincipals(agentUser: string, runner: HostCommandRunner): PrincipalIds {
  for (const group of [API_USER, AUTHORITY_USER, AUTHORITY_IPC_GROUP, RECOVERY_GROUP]) {
    if (!getGroup(group, runner, true)) runner.run("groupadd", ["--system", group]);
  }
  if (!getPasswd(API_USER, runner, true)) {
    runner.run("useradd", ["--system", "--gid", API_USER, "--home-dir", "/var/lib/sompi-api", "--shell", "/usr/sbin/nologin", API_USER]);
  }
  if (!getPasswd(AUTHORITY_USER, runner, true)) {
    runner.run("useradd", ["--system", "--gid", AUTHORITY_USER, "--home-dir", "/var/lib/sompi-authority", "--shell", "/usr/sbin/nologin", AUTHORITY_USER]);
  }
  const api = getPasswd(API_USER, runner);
  const authority = getPasswd(AUTHORITY_USER, runner);
  const agent = getPasswd(agentUser, runner);
  const agentGroup = getGroupById(agent.gid, runner);
  runner.run("usermod", ["-a", "-G", `${AUTHORITY_IPC_GROUP},${agentGroup.name},${RECOVERY_GROUP}`, API_USER]);
  runner.run("usermod", ["-a", "-G", `${AUTHORITY_IPC_GROUP},${agentGroup.name}`, AUTHORITY_USER]);
  return Object.freeze({
    apiUid: api.uid,
    apiGid: getGroup(API_USER, runner).gid,
    authorityUid: authority.uid,
    authorityGid: getGroup(AUTHORITY_USER, runner).gid,
    authorityIpcGid: getGroup(AUTHORITY_IPC_GROUP, runner).gid,
    agentApiGid: agent.gid,
    recoveryGid: getGroup(RECOVERY_GROUP, runner).gid,
    callbackGid: agent.gid,
    agentUid: agent.uid,
    agentGid: getGroupById(agent.gid, runner).gid,
    agentGroupName: agentGroup.name,
    agentHome: agent.home,
  });
}

function installAuthorityManifest(manifest: unknown, gid: number): void {
  fs.mkdirSync(path.dirname(AUTHORITY_MANIFEST), { recursive: true, mode: 0o750 });
  fs.chownSync(path.dirname(AUTHORITY_MANIFEST), 0, gid);
  fs.chmodSync(path.dirname(AUTHORITY_MANIFEST), 0o750);
  const bytes = canonicalOperatorManifestBytes(manifest);
  try { writeExclusive(AUTHORITY_MANIFEST, bytes, 0, gid, 0o640); } finally { bytes.fill(0); }
}

function installExecutables(packageRoot: string): void {
  const entries: Readonly<Record<string, string>> = Object.freeze({
    "sompi-agent": "dist/agent-main.js",
    "sompi-api": "dist/api-main.js",
    "sompi-authority": "dist/authority-main.js",
    "sompi-operator": "dist/operator-main.js",
    "sompi-vault-recover": "scripts/vault-recover.js",
  });
  for (const [name, relative] of Object.entries(entries)) {
    const source = path.join(packageRoot, relative);
    const target = path.join("/usr/local/bin", name);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HostBootstrapError("installed Sompi executable is unsafe");
    fs.chmodSync(source, 0o755);
    fs.symlinkSync(source, target);
  }
}

function executableLinks(): string[] {
  return ["sompi-agent", "sompi-api", "sompi-authority", "sompi-operator", "sompi-vault-recover"]
    .map((name) => path.join("/usr/local/bin", name));
}

function installSystemd(packageRoot: string, request: HostBootstrapRequest, ids: PrincipalIds): void {
  const authority = renderAuthorityUnit(request, ids);
  const api = renderApiUnit(request, ids);
  const activation = renderVaultActivationUnit(request, ids);
  const tmpfiles = renderTmpfiles(ids.agentGroupName);
  writeText("/etc/systemd/system/sompi-authority.service", authority, 0, 0, 0o644);
  writeText("/etc/systemd/system/sompi-api.service", api, 0, 0, 0o644);
  writeText("/etc/systemd/system/sompi-vault-activate.service", activation, 0, 0, 0o644);
  writeText("/etc/tmpfiles.d/sompi.conf", tmpfiles, 0, 0, 0o644);
  void packageRoot;
}

export function renderVaultActivationUnit(request: HostBootstrapRequest, ids: PrincipalIds): string {
  const digest = hostBootstrapRequestDigest(request);
  return `[Unit]\nDescription=Sompi one-time initial vault activation\nAfter=network-online.target sompi-authority.service\nWants=network-online.target\nRequires=sompi-authority.service\nConflicts=sompi-api.service\n\n[Service]\nType=oneshot\nUser=${API_USER}\nGroup=${API_USER}\nSupplementaryGroups=${AUTHORITY_IPC_GROUP} ${ids.agentGroupName} ${RECOVERY_GROUP}\nUMask=0077\nEnvironment=NODE_OPTIONS=--no-network-family-autoselection\nEnvironment=SOMPI_NETWORK=testnet-10\nEnvironment=SOMPI_OPERATOR_MANIFEST=${API_MANIFEST}\nEnvironment=SOMPI_OPERATOR_UID=0\nEnvironment=SOMPI_API_UID=${ids.apiUid}\nEnvironment=SOMPI_RUNTIME_GID=${ids.agentApiGid}\nEnvironment=SOMPI_RECOVERY_GID=${ids.recoveryGid}\nEnvironment=SOMPI_API_SOCKET=${API_SOCKET}\nEnvironment=SOMPI_AGENT_API_CREDENTIAL=${AGENT_CREDENTIAL}\nEnvironment=SOMPI_RECOVERY_API_SOCKET=${RECOVERY_SOCKET}\nEnvironment=SOMPI_RECOVERY_API_CREDENTIAL=${RECOVERY_CREDENTIAL}\nEnvironment=SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client\nEnvironment=SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority\nEnvironment=SOMPI_AUTHORITY_SOCKET=${AUTHORITY_SOCKET}\nEnvironment=SOMPI_AUTHORITY_SOCKET_UID=${ids.authorityUid}\nEnvironment=SOMPI_AUTHORITY_SOCKET_GID=${ids.authorityIpcGid}\nEnvironment=SOMPI_AUTHORITY_ISSUER=${authorityIssuer(request.agent.user)}\nEnvironment=SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1\nEnvironment=SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury\nEnvironment=SOMPI_BOOTSTRAP_REQUEST_DIGEST=${digest}\nEnvironment=SOMPI_BOOTSTRAP_MINIMUM_FUNDING_SOMPI=${minimumFundingSompi(request)}\nEnvironment=SOMPI_BOOTSTRAP_MINIMUM_DEPOSIT_SOMPI=${request.initialVault.minimumDepositSompi}\nEnvironment=SOMPI_BOOTSTRAP_KEEP_FLOAT_SOMPI=${request.initialVault.keepFloatSompi}\nExecStart=/usr/local/bin/sompi-operator bootstrap-activate-worker\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nLockPersonality=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nReadWritePaths=/var/lib/sompi-api/runtime /var/lib/sompi-authority-client\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n`;
}

export function renderAuthorityUnit(request: HostBootstrapRequest, ids: PrincipalIds): string {
  return `[Unit]\nDescription=Sompi Trusted Authority\nAfter=network-online.target systemd-tmpfiles-setup.service\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${AUTHORITY_USER}\nGroup=${AUTHORITY_USER}\nSupplementaryGroups=${AUTHORITY_IPC_GROUP} ${ids.agentGroupName}\nUMask=0077\nEnvironment=NODE_OPTIONS=--no-network-family-autoselection\nEnvironment=SOMPI_AUTHORITY_PRIVATE_DIR=/var/lib/sompi-authority/private\nEnvironment=SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client\nEnvironment=SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority\nEnvironment=SOMPI_AUTHORITY_CALLBACK_RUNTIME_DIR=/run/sompi-telegram-callback\nEnvironment=SOMPI_AUTHORITY_SOCKET=${AUTHORITY_SOCKET}\nEnvironment=SOMPI_AUTHORITY_SOCKET_GID=${ids.authorityIpcGid}\nEnvironment=SOMPI_AUTHORITY_CALLBACK_SOCKET_GID=${ids.callbackGid}\nEnvironment=SOMPI_AUTHORITY_ISSUER=${authorityIssuer(request.agent.user)}\nEnvironment=SOMPI_AUTHORITY_SIGNING_KID=authority-signing-key-1\nEnvironment=SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1\nEnvironment=SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury\nEnvironment=SOMPI_OPERATOR_MANIFEST=${AUTHORITY_MANIFEST}\nEnvironment=SOMPI_OPERATOR_UID=0\nEnvironment=SOMPI_RUNTIME_GID=${ids.authorityIpcGid}\nExecStart=/usr/local/bin/sompi-authority\nRestart=on-failure\nRestartSec=3s\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nLockPersonality=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nReadWritePaths=/var/lib/sompi-authority/private /run/sompi-authority /run/sompi-telegram-callback\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderApiUnit(request: HostBootstrapRequest, ids: PrincipalIds): string {
  return `[Unit]\nDescription=Sompi API\nAfter=network-online.target sompi-authority.service systemd-tmpfiles-setup.service\nWants=network-online.target\nRequires=sompi-authority.service\n\n[Service]\nType=simple\nUser=${API_USER}\nGroup=${API_USER}\nSupplementaryGroups=${AUTHORITY_IPC_GROUP} ${ids.agentGroupName} ${RECOVERY_GROUP}\nUMask=0077\nEnvironment=NODE_OPTIONS=--no-network-family-autoselection\nEnvironment=SOMPI_NETWORK=testnet-10\nEnvironment=SOMPI_OPERATOR_MANIFEST=${API_MANIFEST}\nEnvironment=SOMPI_OPERATOR_UID=0\nEnvironment=SOMPI_API_UID=${ids.apiUid}\nEnvironment=SOMPI_RUNTIME_GID=${ids.agentApiGid}\nEnvironment=SOMPI_RECOVERY_GID=${ids.recoveryGid}\nEnvironment=SOMPI_API_SOCKET=${API_SOCKET}\nEnvironment=SOMPI_AGENT_API_CREDENTIAL=${AGENT_CREDENTIAL}\nEnvironment=SOMPI_RECOVERY_API_SOCKET=${RECOVERY_SOCKET}\nEnvironment=SOMPI_RECOVERY_API_CREDENTIAL=${RECOVERY_CREDENTIAL}\nEnvironment=SOMPI_AUTHORITY_CLIENT_DIR=/var/lib/sompi-authority-client\nEnvironment=SOMPI_AUTHORITY_RUNTIME_DIR=/run/sompi-authority\nEnvironment=SOMPI_AUTHORITY_SOCKET=${AUTHORITY_SOCKET}\nEnvironment=SOMPI_AUTHORITY_SOCKET_UID=${ids.authorityUid}\nEnvironment=SOMPI_AUTHORITY_SOCKET_GID=${ids.authorityIpcGid}\nEnvironment=SOMPI_AUTHORITY_ISSUER=${authorityIssuer(request.agent.user)}\nEnvironment=SOMPI_AUTHORITY_IPC_KEY_ID=authority-ipc-key-1\nEnvironment=SOMPI_AUTHORITY_INSTRUMENT_ID=kaspa:testnet-10:vault-treasury\nExecStart=/usr/local/bin/sompi-api\nRestart=on-failure\nRestartSec=3s\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nLockPersonality=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nReadWritePaths=/var/lib/sompi-api/runtime /run/sompi-api /run/sompi-recovery\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderTmpfiles(agentGroupName = "sompi-agent"): string {
  return `d /run/sompi-authority 0710 ${AUTHORITY_USER} ${AUTHORITY_IPC_GROUP} -\nd /run/sompi-telegram-callback 0710 ${AUTHORITY_USER} ${agentGroupName} -\nd /run/sompi-api 0710 ${API_USER} ${agentGroupName} -\nd /run/sompi-recovery 0710 ${API_USER} ${RECOVERY_GROUP} -\n`;
}

function installHermesIntegration(packageRoot: string, request: HostBootstrapRequest, ids: PrincipalIds, runner: HostCommandRunner): string {
  const hermesRoot = path.join(ids.agentHome, ".hermes");
  const checkout = path.join(hermesRoot, "hermes-agent");
  const skillTarget = path.join(hermesRoot, "skills", "sompi");
  const pluginTarget = path.join(hermesRoot, "plugins", "sompi-approval");
  copyTree(path.join(packageRoot, "integrations", "hermes", "sompi"), skillTarget);
  copyTree(path.join(packageRoot, "integrations", "hermes", "plugin"), pluginTarget);
  let pythonPath = checkout;
  const adapter = path.join(checkout, "plugins", "platforms", "telegram", "adapter.py");
  const pluginManager = path.join(checkout, "hermes_cli", "plugins.py");
  if (!fileContains(adapter, "gateway_callback_query") || !fileContains(pluginManager, '"gateway_callback_query"')) {
    const compatRoot = path.join(ids.agentHome, ".sompi", "hermes-compat", request.packageVersion);
    const patch = path.join(packageRoot, "integrations", "hermes", "compat", "callback-hook.patch");
    installHermesCompatibilityCheckout(checkout, compatRoot, patch, runner);
    if (!fileContains(path.join(compatRoot, "plugins", "platforms", "telegram", "adapter.py"), "dispatch_plugin_callback_query")) {
      throw new HostBootstrapError("Hermes callback compatibility profile did not install");
    }
    pythonPath = compatRoot;
  }
  chownTree(skillTarget, ids.agentUid, ids.agentGid, 0o700, 0o600);
  chownTree(pluginTarget, ids.agentUid, ids.agentGid, 0o700, 0o600);
  if (pythonPath !== checkout) {
    chownTree(pythonPath, ids.agentUid, ids.agentGid, 0o700, 0o600, true);
    installHermesCompatibilityVenvLink(checkout, pythonPath);
  }
  return pythonPath;
}

export function installHermesCompatibilityCheckout(
  checkout: string,
  compatRoot: string,
  patch: string,
  runner: HostCommandRunner,
): void {
  if (fs.existsSync(compatRoot)) throw new HostBootstrapError("Hermes compatibility target already exists");
  const branch = runner.run("git", ["branch", "--show-current"], { cwd: checkout }).trim();
  const origin = runner.run("git", ["remote", "get-url", "origin"], { cwd: checkout }).trim();
  if (!branch || !origin) throw new HostBootstrapError("Hermes compatibility source is not an updateable checkout");
  runner.run("git", ["clone", "--shared", "--single-branch", "--branch", branch, checkout, compatRoot]);
  runner.run("git", ["remote", "set-url", "origin", origin], { cwd: compatRoot });
  runner.run("git", ["apply", "--check", patch], { cwd: compatRoot });
  runner.run("git", ["apply", patch], { cwd: compatRoot });
  if (!fs.existsSync(path.join(compatRoot, ".git"))) {
    throw new HostBootstrapError("Hermes compatibility checkout lost its update metadata");
  }
}

export function installHermesCompatibilityVenvLink(checkout: string, compatRoot: string): void {
  const source = path.join(checkout, "venv");
  const target = path.join(compatRoot, "venv");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || fs.existsSync(target)) {
    throw new HostBootstrapError("Hermes compatibility runtime link is unsafe");
  }
  fs.symlinkSync(source, target, "dir");
  const exclude = path.join(compatRoot, ".git", "info", "exclude");
  fs.appendFileSync(exclude, "\n/venv\n", { encoding: "utf8" });
}

function installHermesServiceDropIn(request: HostBootstrapRequest, ids: PrincipalIds, pythonPath: string): void {
  const directory = path.join(ids.agentHome, ".config", "systemd", "user", "hermes-gateway.service.d");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const text = `[Service]\nEnvironment="PYTHONPATH=${pythonPath}"\nEnvironment="SOMPI_API_SOCKET=${API_SOCKET}"\nEnvironment="SOMPI_AGENT_API_CREDENTIAL=${AGENT_CREDENTIAL}"\nEnvironment="SOMPI_OPERATOR_UID=0"\nEnvironment="SOMPI_API_UID=${ids.apiUid}"\nEnvironment="SOMPI_RUNTIME_GID=${ids.agentApiGid}"\n`;
  writeText(path.join(directory, "sompi.conf"), text, ids.agentUid, ids.agentGid, 0o600);
  void request;
}

function configureHermes(request: HostBootstrapRequest, ids: PrincipalIds, pythonPath: string, runner: HostCommandRunner): void {
  const python = path.join(ids.agentHome, ".hermes", "hermes-agent", "venv", "bin", "python");
  const base = [python, "-m", "hermes_cli.main"];
  const env = ["env", `PYTHONPATH=${pythonPath}`];
  runAsUser(request.agent.user, env[0], [...env.slice(1), base[0], ...base.slice(1), "config", "set", "plugins.entries.sompi-approval.callback_socket", CALLBACK_SOCKET], runner);
  runAsUser(request.agent.user, env[0], [...env.slice(1), base[0], ...base.slice(1), "config", "set", "plugins.entries.sompi-approval.timeout_ms", "2000"], runner);
  runAsUser(request.agent.user, env[0], [...env.slice(1), base[0], ...base.slice(1), "plugins", "enable", "sompi-approval", "--no-allow-tool-override"], runner);
}

function restartHermes(ids: PrincipalIds, runner: HostCommandRunner): void {
  const environment = [`XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`];
  runner.run("runuser", ["-u", getPasswdById(ids.agentUid, runner).name, "--", "env", ...environment, "systemctl", "--user", "daemon-reload"]);
  runner.run("runuser", ["-u", getPasswdById(ids.agentUid, runner).name, "--", "env", ...environment, "systemctl", "--user", "restart", "hermes-gateway.service"]);
}

function assertServiceActive(service: string, runner: HostCommandRunner): void {
  if (runner.run("systemctl", ["is-active", service]).trim() !== "active") throw new HostBootstrapError("Sompi service did not become active");
}

function assertHermesActive(ids: PrincipalIds, runner: HostCommandRunner): void {
  const user = getPasswdById(ids.agentUid, runner).name;
  const result = runner.run("runuser", ["-u", user, "--", "env", `XDG_RUNTIME_DIR=/run/user/${ids.agentUid}`, "systemctl", "--user", "is-active", "hermes-gateway.service"]);
  if (result.trim() !== "active") throw new HostBootstrapError("Hermes gateway did not become active");
}

function runAsUser(user: string, command: string, args: readonly string[], runner: HostCommandRunner): void {
  runner.run("runuser", ["-u", user, "--", command, ...args]);
}

function installRecoveryRecord(filename: string, value: Readonly<Record<string, string>>): void {
  const bytes = Buffer.from(`${JSON.stringify({ schema: "sompi-owner-recovery-v1", ...value }, null, 2)}\n`, "utf8");
  try { writeExclusive(filename, bytes, 0, 0, 0o600); } finally { bytes.fill(0); }
}

function installFundingWallet(dataDirectory: string, ids: PrincipalIds): string {
  const key = generateWalletKey("testnet-10");
  const bytes = Buffer.from(`${key.privateKey}\n`, "utf8");
  try {
    writeExclusive(path.join(dataDirectory, "wallet-key"), bytes, ids.apiUid, ids.apiGid, 0o600);
  } finally {
    bytes.fill(0);
  }
  return key.address;
}

function minimumFundingSompi(request: HostBootstrapRequest): string {
  return (
    BigInt(request.initialVault.minimumDepositSompi) +
    BigInt(request.initialVault.keepFloatSompi) +
    BigInt(request.operator.treasury.operationFeeCeilingAtomic)
  ).toString();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeBootstrapReceipt(receipt: HostBootstrapReceipt): void {
  fs.mkdirSync("/var/lib/sompi-bootstrap", { recursive: true, mode: 0o700 });
  fs.chownSync("/var/lib/sompi-bootstrap", 0, 0);
  fs.chmodSync("/var/lib/sompi-bootstrap", 0o700);
  writeText("/var/lib/sompi-bootstrap/receipt.json", `${JSON.stringify(receipt, null, 2)}\n`, 0, 0, 0o600);
}

function readBootstrapReceipt(): HostBootstrapReceipt {
  let value: unknown;
  try { value = JSON.parse(readRegularText("/var/lib/sompi-bootstrap/receipt.json", 64 * 1024, 0)); }
  catch (cause) { throw new HostBootstrapError("installed bootstrap receipt is unavailable", { cause }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostBootstrapError("installed bootstrap receipt is invalid");
  const receipt = value as Record<string, unknown>;
  if (
    receipt.status !== "ready" || typeof receipt.package !== "string" ||
    typeof receipt.requestDigest !== "string" || typeof receipt.fundingAddress !== "string"
  ) {
    throw new HostBootstrapError("installed bootstrap receipt is invalid");
  }
  return receipt as unknown as HostBootstrapReceipt;
}

function readActivatedVaultConfig(filename: string, expectedUid: number): {
  address: string;
  covenantId: string;
  currentOutpoint: { txid: string; index: number };
} {
  let value: unknown;
  try { value = JSON.parse(readRegularText(filename, 64 * 1024, expectedUid)); }
  catch (cause) { throw new HostBootstrapError("activated vault configuration is unavailable", { cause }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostBootstrapError("activated vault configuration is invalid");
  const config = value as Record<string, unknown>;
  const outpoint = config.currentOutpoint as Record<string, unknown> | undefined;
  if (
    typeof config.address !== "string" || !/^kaspatest:[a-z0-9]{11,240}$/.test(config.address) ||
    typeof config.covenantId !== "string" || !/^[a-f0-9]{64}$/.test(config.covenantId) ||
    !outpoint || typeof outpoint.txid !== "string" || !/^[a-f0-9]{64}$/.test(outpoint.txid) ||
    !Number.isSafeInteger(outpoint.index) || Number(outpoint.index) < 0 || Number(outpoint.index) > 0xffff_ffff
  ) {
    throw new HostBootstrapError("activated vault configuration is invalid");
  }
  return {
    address: config.address,
    covenantId: config.covenantId,
    currentOutpoint: { txid: outpoint.txid, index: Number(outpoint.index) },
  };
}

function readRegularText(filename: string, maximumBytes: number, expectedUid: number): string {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() || stat.nlink !== 1 || stat.uid !== expectedUid ||
      (stat.mode & 0o022) !== 0 || stat.size <= 0 || stat.size > maximumBytes
    ) {
      throw new HostBootstrapError("host bootstrap file is unsafe");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally { fs.closeSync(descriptor); }
}

function rollbackUnfundedInstall(created: readonly string[], request: HostBootstrapRequest, runner: HostCommandRunner): void {
  for (const service of ["sompi-api.service", "sompi-authority.service"]) {
    try { runner.run("systemctl", ["disable", "--now", service]); } catch { /* best effort */ }
  }
  for (const target of [...created].reverse()) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try {
    const agent = getPasswd(request.agent.user, runner);
    fs.rmSync(path.join(agent.home, ".sompi", "hermes-compat", request.packageVersion), { recursive: true, force: true });
  } catch { /* best effort */ }
  try { runner.run("systemctl", ["daemon-reload"]); } catch { /* best effort */ }
}

function snapshotHermesConfig(ids: PrincipalIds): HermesConfigSnapshot {
  const filename = path.join(ids.agentHome, ".hermes", "config.yaml");
  if (!fs.existsSync(filename)) return Object.freeze({ filename });
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== ids.agentUid || stat.size > 1024 * 1024) {
      throw new HostBootstrapError("Hermes configuration is unsafe to snapshot");
    }
    return Object.freeze({ filename, bytes: fs.readFileSync(descriptor), mode: stat.mode & 0o777 });
  } finally {
    fs.closeSync(descriptor);
  }
}

function restoreHermesConfig(snapshot: HermesConfigSnapshot, ids: PrincipalIds, runner: HostCommandRunner): void {
  try {
    if (!snapshot.bytes) {
      fs.rmSync(snapshot.filename, { force: true });
    } else {
      const temporary = `${snapshot.filename}.sompi-rollback-${process.pid}`;
      const bytes = Buffer.from(snapshot.bytes);
      try {
        writeExclusive(temporary, bytes, ids.agentUid, ids.agentGid, snapshot.mode ?? 0o600);
        fs.renameSync(temporary, snapshot.filename);
      } finally {
        bytes.fill(0);
        fs.rmSync(temporary, { force: true });
      }
    }
    restartHermes(ids, runner);
  } catch { /* best effort; original bootstrap failure remains authoritative */ }
}

function prepareRuntimeDirectory(directory: string, uid: number, gid: number): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o710 });
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o710);
}

function prepareStateDirectory(directory: string, uid: number, gid: number): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HostBootstrapError("host bootstrap state parent is unsafe");
  fs.chownSync(directory, uid, gid);
  fs.chmodSync(directory, 0o700);
}

function chownTree(root: string, uid: number, gid: number, directoryMode: number, fileMode: number, executableFiles = false): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new HostBootstrapError("host bootstrap state contains a symbolic link");
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) chownTree(path.join(root, entry), uid, gid, directoryMode, fileMode, executableFiles);
    fs.chownSync(root, uid, gid);
    fs.chmodSync(root, directoryMode);
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new HostBootstrapError("host bootstrap state contains an unsafe entry");
  fs.chownSync(root, uid, gid);
  fs.chmodSync(root, executableFiles && (stat.mode & 0o111) !== 0 ? 0o700 : fileMode);
}

function copyTree(source: string, target: string, include?: (basename: string) => boolean): void {
  if (fs.existsSync(target)) throw new HostBootstrapError("host bootstrap integration target already exists");
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (entry) => include ? include(path.basename(entry)) : true,
  });
}

function readRootSecret(filename: string, label: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollowFlag());
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 || stat.size < 20 || stat.size > 256) {
      throw new HostBootstrapError(`${label} file is unsafe`);
    }
    const bytes = fs.readFileSync(descriptor);
    if (/\r|\0/.test(bytes.toString("utf8")) || bytes.toString("utf8").trim().length < 20) {
      bytes.fill(0);
      throw new HostBootstrapError(`${label} is invalid`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readOrPromptTelegramToken(filename: string): Buffer {
  if (fs.existsSync(filename)) return readRootSecret(filename, "Telegram bot token");
  let descriptor: number | undefined;
  let echoDisabled = false;
  try {
    descriptor = fs.openSync("/dev/tty", fs.constants.O_RDWR | noFollowFlag());
    const disabled = spawnSync("stty", ["-echo"], { stdio: [descriptor, descriptor, descriptor] });
    if (disabled.status !== 0) throw new HostBootstrapError("local terminal could not protect Telegram token input");
    echoDisabled = true;
    fs.writeSync(descriptor, "Telegram bot token (input hidden): ");
    const bytes = Buffer.alloc(257);
    let length = 0;
    while (length < bytes.length) {
      const one = Buffer.alloc(1);
      const count = fs.readSync(descriptor, one, 0, 1, null);
      if (count === 0 || one[0] === 0x0a) break;
      if (one[0] !== 0x0d) bytes[length++] = one[0];
      one.fill(0);
    }
    fs.writeSync(descriptor, "\n");
    if (length < 20 || length > 256) {
      bytes.fill(0);
      throw new HostBootstrapError("Telegram bot token is invalid");
    }
    const token = Buffer.from(bytes.subarray(0, length));
    bytes.fill(0);
    const persisted = Buffer.from(`${token.toString("utf8")}\n`, "utf8");
    try { writeExclusive(filename, persisted, 0, 0, 0o600); } finally { persisted.fill(0); }
    return token;
  } catch (cause) {
    if (cause instanceof HostBootstrapError) throw cause;
    throw new HostBootstrapError("Telegram bot token could not be read from the local operator terminal", { cause });
  } finally {
    if (descriptor !== undefined && echoDisabled) spawnSync("stty", ["echo"], { stdio: [descriptor, descriptor, descriptor] });
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeSecret(filename: string, bytes: Buffer, uid: number, gid: number): void {
  const persisted = Buffer.from(`${bytes.toString("utf8").trim()}\n`, "utf8");
  try { writeExclusive(filename, persisted, uid, gid, 0o600); } finally { persisted.fill(0); }
}

function writeExclusive(filename: string, bytes: Buffer, uid: number, gid: number, mode: number): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(), mode);
  try {
    fs.fchownSync(descriptor, uid, gid);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function writeText(filename: string, text: string, uid: number, gid: number, mode: number): void {
  const bytes = Buffer.from(text, "utf8");
  try { writeExclusive(filename, bytes, uid, gid, mode); } finally { bytes.fill(0); }
}

function getPasswd(name: string, runner: HostCommandRunner): { name: string; uid: number; gid: number; home: string };
function getPasswd(name: string, runner: HostCommandRunner, optional: true): { name: string; uid: number; gid: number; home: string } | undefined;
function getPasswd(name: string, runner: HostCommandRunner, optional = false): { name: string; uid: number; gid: number; home: string } | undefined {
  let output: string;
  try { output = runner.run("getent", ["passwd", name]); } catch (cause) {
    if (optional) return undefined;
    throw cause;
  }
  const fields = output.trim().split(":");
  if (fields.length !== 7 || fields[0] !== name) throw new HostBootstrapError("host user database returned invalid data");
  return { name, uid: numericId(fields[2]), gid: numericId(fields[3]), home: absolutePath(fields[5]) };
}

function getPasswdById(uid: number, runner: HostCommandRunner): { name: string; uid: number; gid: number; home: string } {
  const output = runner.run("getent", ["passwd", String(uid)]).trim();
  const name = output.split(":", 1)[0];
  return getPasswd(name, runner);
}

function getGroup(name: string, runner: HostCommandRunner): { gid: number };
function getGroup(name: string, runner: HostCommandRunner, optional: true): { gid: number } | undefined;
function getGroup(name: string, runner: HostCommandRunner, optional = false): { gid: number } | undefined {
  let output: string;
  try { output = runner.run("getent", ["group", name]); } catch (cause) {
    if (optional) return undefined;
    throw cause;
  }
  const fields = output.trim().split(":");
  if (fields.length !== 4 || fields[0] !== name) throw new HostBootstrapError("host group database returned invalid data");
  return { gid: numericId(fields[2]) };
}

function getGroupById(gid: number, runner: HostCommandRunner): { gid: number; name: string } {
  const output = runner.run("getent", ["group", String(gid)]).trim();
  const fields = output.split(":");
  if (fields.length !== 4) throw new HostBootstrapError("host group database returned invalid data");
  return { gid: numericId(fields[2]), name: fields[0] };
}

function numericId(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new HostBootstrapError("host principal ID is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0x7fffffff) throw new HostBootstrapError("host principal ID is invalid");
  return parsed;
}

function absolutePath(value: string): string {
  if (!value || path.resolve(value) !== value || value === path.parse(value).root) throw new HostBootstrapError("host home directory is invalid");
  return value;
}

function authorityIssuer(agentUser: string): string {
  return `urn:sompi:authority:${agentUser}`;
}

function fileContains(filename: string, needle: string): boolean {
  try { return fs.readFileSync(filename, "utf8").includes(needle); } catch { return false; }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

class SystemHostCommandRunner implements HostCommandRunner {
  run(command: string, args: readonly string[], options: Readonly<{ cwd?: string }> = {}): string {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0) throw new HostBootstrapError(`required host operation failed: ${command}`);
    return result.stdout ?? "";
  }
}
