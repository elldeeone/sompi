import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  OPERATOR_PROVISIONING_SCHEMA,
  OperatorProvisioningError,
  parseOperatorProvisioningSpec,
  type OperatorProvisioningSpec,
} from "./provisioning.js";

export const HOST_BOOTSTRAP_SCHEMA = "sompi-host-bootstrap-v1" as const;
export const HOST_BOOTSTRAP_TOPOLOGY_SCHEMA =
  "sompi-host-bootstrap-topology-v1" as const;
export const HOST_BOOTSTRAP_INSTALLER_SHA256 =
  "d9f639c5dcf0fcb76e0ccdac96d284740e9a79cb04530ccff3bc5ba10ccc999c" as const;
export const HOST_BOOTSTRAP_PRINCIPALS = Object.freeze({
  operator: "root",
  api: "sompi-api",
  authority: "sompi-authority",
} as const);
export const HOST_BOOTSTRAP_GROUPS = Object.freeze({
  api: "sompi-api",
  authority: "sompi-authority",
  authorityIpc: "sompi-authority-ipc",
  recovery: "sompi-recovery",
} as const);
export const HOST_BOOTSTRAP_PATHS = Object.freeze({
  releaseRoot: "/opt/sompi/releases",
  apiManifest: "/etc/sompi/operator-manifest.json",
  authorityManifest: "/etc/sompi-authority/operator-manifest.json",
  apiCredential: "/etc/sompi/agent-api.json",
  agentCredential: "~/.sompi/agent-api.json",
  recoveryCredential: "/etc/sompi-recovery/recovery-api.json",
  apiRuntime: "/var/lib/sompi-api/runtime",
  authorityPrivate: "/var/lib/sompi-authority/private",
  authorityClient: "/var/lib/sompi-authority-client",
  bootstrapReceipt: "/var/lib/sompi-bootstrap/receipt.json",
  authoritySocket: "/run/sompi-authority/authority.sock",
  callbackSocket: "/run/sompi-telegram-callback/telegram-callback.sock",
  agentApiSocket: "/run/sompi-api/sompi.sock",
  recoverySocket: "/run/sompi-recovery/recovery.sock",
  authorityUnit: "/etc/systemd/system/sompi-authority.service",
  apiUnit: "/etc/systemd/system/sompi-api.service",
  activationUnit: "/etc/systemd/system/sompi-vault-activate.service",
  tmpfiles: "/etc/tmpfiles.d/sompi.conf",
} as const);
const MAX_REQUEST_BYTES = 64 * 1024;
const PACKAGE_NAME = "@elldeeone/sompi";
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const PLACEHOLDER_OWNER_PUBLIC = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PRIVILEGED_BOOTSTRAP_SCRIPT = [
  "umask 077",
  "work=$(mktemp -d)",
  "release_prefix=$3",
  "sompi_root=/opt/sompi",
  "release_root=/opt/sompi/releases",
  "expected_package=$4",
  "expected_request_digest=$7",
  "release_created=0",
  "sompi_root_created=0",
  "release_root_created=0",
  "receipt=/var/lib/sompi-bootstrap/receipt.json",
  "receipt_preexisting=0",
  "if [ -e \"$receipt\" ] || [ -L \"$receipt\" ]; then receipt_preexisting=1; fi",
  "safe_root_directory() { [ ! -L \"$1\" ] && [ -d \"$1\" ] && [ \"$(stat -c %u -- \"$1\")\" = 0 ] || return 1; permissions=$(stat -c %A -- \"$1\"); case \"$permissions\" in ?????w????|????????w?) return 1;; esac; }",
  "cleanup() { status=$?; trap - EXIT HUP INT TERM; committed=0; commit_check=\"$release_prefix/node_modules/.bin/sompi-operator\"; if [ \"$status\" -ne 0 ] && [ \"$receipt_preexisting\" -eq 0 ] && [ -x \"$commit_check\" ] && \"$commit_check\" bootstrap-commit-status \"$receipt\" \"$expected_package\" \"$expected_request_digest\" >/dev/null 2>&1; then committed=1; fi; if ! rm -rf -- \"$work\"; then status=125; fi; if [ \"$status\" -ne 0 ] && [ \"$committed\" -eq 0 ] && [ \"$release_created\" -eq 1 ] && ! rm -rf -- \"$release_prefix\"; then status=125; fi; if [ \"$status\" -ne 0 ] && [ \"$committed\" -eq 0 ] && [ \"$release_root_created\" -eq 1 ] && ! rmdir -- \"$release_root\"; then status=125; fi; if [ \"$status\" -ne 0 ] && [ \"$committed\" -eq 0 ] && [ \"$sompi_root_created\" -eq 1 ] && ! rmdir -- \"$sompi_root\"; then status=125; fi; exit \"$status\"; }",
  "trap cleanup EXIT",
  "trap 'exit 129' HUP",
  "trap 'exit 130' INT",
  "trap 'exit 143' TERM",
  "curl --proto \"=https\" --proto-redir \"=https\" --tlsv1.2 --fail --location --max-time 30 --output \"$work/install-runtime-package.mjs\" \"$1\"",
  "printf \"%s  %s\\n\" \"$2\" \"$work/install-runtime-package.mjs\" | sha256sum --check --strict -",
  "[ \"$release_prefix\" = \"$release_root/$5\" ]",
  "safe_root_directory /opt",
  "if [ -e \"$sompi_root\" ] || [ -L \"$sompi_root\" ]; then safe_root_directory \"$sompi_root\"; else mkdir -m 0755 -- \"$sompi_root\"; sompi_root_created=1; safe_root_directory \"$sompi_root\"; fi",
  "if [ -e \"$release_root\" ] || [ -L \"$release_root\" ]; then safe_root_directory \"$release_root\"; else mkdir -m 0755 -- \"$release_root\"; release_root_created=1; safe_root_directory \"$release_root\"; fi",
  "[ ! -e \"$release_prefix\" ] && [ ! -L \"$release_prefix\" ]",
  "mkdir -m 0755 -- \"$release_prefix\"",
  "release_created=1",
  "node \"$work/install-runtime-package.mjs\" --prefix \"$release_prefix\" --package \"$4\" --expected-version \"$5\" --omit-dev",
  "\"$release_prefix/node_modules/.bin/sompi-operator\" bootstrap \"$6\" \"$7\"",
  "release_created=0",
].join("; ");

export interface HostBootstrapRequest {
  readonly schema: typeof HOST_BOOTSTRAP_SCHEMA;
  readonly packageVersion: string;
  readonly agent: Readonly<{
    kind: "hermes";
    user: string;
  }>;
  readonly ownerRecoveryFile: string;
  readonly telegramBotTokenFile: string;
  readonly initialVault: Readonly<{
    minimumDepositSompi: string;
    keepFloatSompi: string;
  }>;
  readonly operator: Omit<OperatorProvisioningSpec, "schema" | "dataDirectory" | "ownerPublic">;
}

export interface HostBootstrapTopology {
  readonly schema: typeof HOST_BOOTSTRAP_TOPOLOGY_SCHEMA;
  readonly principals: Readonly<{
    operator: "root";
    api: "sompi-api";
    authority: "sompi-authority";
    agent: string;
  }>;
  readonly groups: Readonly<{
    api: "sompi-api";
    authority: "sompi-authority";
    authorityIpc: "sompi-authority-ipc";
    recovery: "sompi-recovery";
    agentSockets: "selected-agent-primary-group";
  }>;
  readonly memberships: Readonly<{
    api: Readonly<{
      primary: "sompi-api";
      supplementary: readonly [
        "sompi-authority-ipc",
        "sompi-recovery",
      ];
    }>;
    authority: Readonly<{
      primary: "sompi-authority";
      supplementary: readonly ["sompi-authority-ipc"];
    }>;
    agent: Readonly<{
      supplementary: readonly [];
      forbidden: readonly [
        "root",
        "sompi-api",
        "sompi-authority",
        "sompi-authority-ipc",
        "sompi-recovery",
      ];
    }>;
  }>;
  readonly sockets: readonly Readonly<{
    role: "authority" | "telegram-callback" | "agent-api" | "operator-recovery";
    path: string;
    owner: "sompi-api" | "sompi-authority";
    group: "sompi-authority-ipc" | "sompi-recovery" | "selected-agent-primary-group";
    directoryMode: "0710" | "2710";
    mode: "0660";
  }>[];
  readonly startupOrder: readonly [
    "sompi-authority",
    "sompi-api",
    "hermes-gateway",
  ];
  readonly hermes: Readonly<{
    skill: "~/.hermes/skills/sompi";
    plugin: "~/.hermes/plugins/sompi-approval";
    callback: "/run/sompi-telegram-callback/telegram-callback.sock";
    compatibility: "native-hook-or-independent-git-checkout";
  }>;
  readonly secrets: Readonly<{
    ownerRecovery: string;
    telegramInput: string;
    authorityPrivate: "/var/lib/sompi-authority/private";
    apiRuntime: "/var/lib/sompi-api/runtime";
    apiCredential: "/etc/sompi/agent-api.json";
    agentCredential: "~/.sompi/agent-api.json";
    recoveryCredential: "/etc/sompi-recovery/recovery-api.json";
  }>;
  readonly access: readonly Readonly<{
    principal: "agent" | "sompi-api" | "sompi-authority" | "operator";
    checks: readonly Readonly<{
      kind: "read" | "connect";
      path: string;
      allowed: boolean;
    }>[];
  }>[];
  readonly rollback: Readonly<{
    scope: "invocation-created-resources-only";
    reverses: readonly [
      "service activation",
      "Hermes configuration",
      "files and directories",
      "supplementary memberships",
      "service principals and groups",
    ];
  }>;
}

export interface HostBootstrapPreview {
  readonly schema: typeof HOST_BOOTSTRAP_SCHEMA;
  readonly requestDigest: string;
  readonly package: string;
  readonly agent: HostBootstrapRequest["agent"];
  readonly network: "kaspa:testnet-10";
  readonly vaultCapSompi: string;
  readonly vaultWindowDaa: string;
  readonly merchants: readonly string[];
  readonly authority: "telegram-inline-v1";
  readonly ownerRecoveryFile: string;
  readonly minimumFundingSompi: string;
  readonly secretInput: "root-only Telegram bot-token file";
  readonly topology: HostBootstrapTopology;
  readonly nextCommand: string;
}

export class HostBootstrapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostBootstrapError";
  }
}

export function loadHostBootstrapRequest(filename: string): HostBootstrapRequest {
  const resolved = path.resolve(filename);
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollowFlag());
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_REQUEST_BYTES) {
      throw new HostBootstrapError("host bootstrap request is not a bounded regular file");
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new HostBootstrapError("host bootstrap request was truncated");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const pathname = fs.lstatSync(resolved);
    if (
      pathname.isSymbolicLink() || !pathname.isFile() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      after.dev !== pathname.dev || after.ino !== pathname.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    ) {
      throw new HostBootstrapError("host bootstrap request changed during stable read");
    }
    return parseHostBootstrapRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (cause) {
    if (cause instanceof HostBootstrapError) throw cause;
    throw new HostBootstrapError("host bootstrap request could not be loaded", { cause });
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function parseHostBootstrapRequest(value: unknown): HostBootstrapRequest {
  const request = record(value, "host bootstrap request");
  exactKeys(request, [
    "schema", "packageVersion", "agent", "ownerRecoveryFile", "telegramBotTokenFile", "initialVault", "operator",
  ], "host bootstrap request");
  if (request.schema !== HOST_BOOTSTRAP_SCHEMA) throw new HostBootstrapError("host bootstrap schema is unsupported");
  if (typeof request.packageVersion !== "string" || !VERSION_PATTERN.test(request.packageVersion)) {
    throw new HostBootstrapError("host bootstrap package version is invalid");
  }
  const agent = record(request.agent, "host bootstrap agent");
  exactKeys(agent, ["kind", "user"], "host bootstrap agent");
  if (agent.kind !== "hermes" || typeof agent.user !== "string" || !USER_PATTERN.test(agent.user)) {
    throw new HostBootstrapError("host bootstrap supports one valid Hermes OS user");
  }
  if (
    agent.user === HOST_BOOTSTRAP_PRINCIPALS.operator ||
    agent.user === HOST_BOOTSTRAP_PRINCIPALS.api ||
    agent.user === HOST_BOOTSTRAP_PRINCIPALS.authority ||
    (Object.values(HOST_BOOTSTRAP_GROUPS) as readonly string[]).includes(agent.user)
  ) {
    throw new HostBootstrapError("host bootstrap Hermes OS user conflicts with a protected principal");
  }
  const ownerRecoveryFile = rootOnlyPath(request.ownerRecoveryFile, "owner recovery file");
  const telegramBotTokenFile = rootOnlyPath(request.telegramBotTokenFile, "Telegram bot-token file");
  if (ownerRecoveryFile === telegramBotTokenFile) throw new HostBootstrapError("host bootstrap secret paths must be distinct");

  const initialVaultInput = record(request.initialVault, "host bootstrap initial vault");
  exactKeys(initialVaultInput, ["minimumDepositSompi", "keepFloatSompi"], "host bootstrap initial vault");
  const initialVault = {
    minimumDepositSompi: positiveAtomic(initialVaultInput.minimumDepositSompi, "minimum vault deposit"),
    keepFloatSompi: positiveAtomic(initialVaultInput.keepFloatSompi, "funding-wallet float"),
  };

  const input = record(request.operator, "host bootstrap operator policy");
  exactKeys(input, [
    "revision", "maxOutflowSompi", "windowSizeDaa", "treasury", "merchant", "batch", "authority",
    "chainEvidence", "admission",
  ], "host bootstrap operator policy");
  let operator: OperatorProvisioningSpec;
  try {
    operator = parseOperatorProvisioningSpec({
      schema: OPERATOR_PROVISIONING_SCHEMA,
      dataDirectory: "/var/lib/sompi-api/runtime",
      ownerPublic: PLACEHOLDER_OWNER_PUBLIC,
      ...input,
    });
  } catch (cause) {
    if (cause instanceof OperatorProvisioningError) {
      throw new HostBootstrapError("host bootstrap operator policy is invalid", { cause });
    }
    throw cause;
  }
  if (operator.authority.provider !== "telegram" || !operator.authority.telegram) {
    throw new HostBootstrapError("host bootstrap requires the Telegram human Authority profile");
  }
  return deepFreeze({
    schema: HOST_BOOTSTRAP_SCHEMA,
    packageVersion: request.packageVersion,
    agent: { kind: "hermes", user: agent.user },
    ownerRecoveryFile,
    telegramBotTokenFile,
    initialVault,
    operator: {
      revision: operator.revision,
      maxOutflowSompi: operator.maxOutflowSompi,
      windowSizeDaa: operator.windowSizeDaa,
      treasury: operator.treasury,
      merchant: operator.merchant,
      batch: operator.batch,
      authority: operator.authority,
      chainEvidence: operator.chainEvidence,
      admission: operator.admission,
    },
  });
}

export function canonicalHostBootstrapBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(parseHostBootstrapRequest(value), null, 2)}\n`, "utf8");
}

export function hostBootstrapRequestDigest(value: HostBootstrapRequest): string {
  const bytes = canonicalHostBootstrapBytes(value);
  try {
    return `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
  } finally {
    bytes.fill(0);
  }
}

export function hostBootstrapTopology(
  requestInput: HostBootstrapRequest,
): HostBootstrapTopology {
  const request = parseHostBootstrapRequest(requestInput);
  return deepFreeze({
    schema: HOST_BOOTSTRAP_TOPOLOGY_SCHEMA,
    principals: {
      ...HOST_BOOTSTRAP_PRINCIPALS,
      agent: request.agent.user,
    },
    groups: {
      ...HOST_BOOTSTRAP_GROUPS,
      agentSockets: "selected-agent-primary-group",
    },
    memberships: {
      api: {
        primary: HOST_BOOTSTRAP_GROUPS.api,
        supplementary: [
          HOST_BOOTSTRAP_GROUPS.authorityIpc,
          HOST_BOOTSTRAP_GROUPS.recovery,
        ],
      },
      authority: {
        primary: HOST_BOOTSTRAP_GROUPS.authority,
        supplementary: [HOST_BOOTSTRAP_GROUPS.authorityIpc],
      },
      agent: {
        supplementary: [],
        forbidden: [
          "root",
          HOST_BOOTSTRAP_GROUPS.api,
          HOST_BOOTSTRAP_GROUPS.authority,
          HOST_BOOTSTRAP_GROUPS.authorityIpc,
          HOST_BOOTSTRAP_GROUPS.recovery,
        ],
      },
    },
    sockets: [
      {
        role: "authority",
        path: HOST_BOOTSTRAP_PATHS.authoritySocket,
        owner: HOST_BOOTSTRAP_PRINCIPALS.authority,
        group: HOST_BOOTSTRAP_GROUPS.authorityIpc,
        directoryMode: "0710",
        mode: "0660",
      },
      {
        role: "telegram-callback",
        path: HOST_BOOTSTRAP_PATHS.callbackSocket,
        owner: HOST_BOOTSTRAP_PRINCIPALS.authority,
        group: "selected-agent-primary-group",
        directoryMode: "2710",
        mode: "0660",
      },
      {
        role: "agent-api",
        path: HOST_BOOTSTRAP_PATHS.agentApiSocket,
        owner: HOST_BOOTSTRAP_PRINCIPALS.api,
        group: "selected-agent-primary-group",
        directoryMode: "2710",
        mode: "0660",
      },
      {
        role: "operator-recovery",
        path: HOST_BOOTSTRAP_PATHS.recoverySocket,
        owner: HOST_BOOTSTRAP_PRINCIPALS.api,
        group: HOST_BOOTSTRAP_GROUPS.recovery,
        directoryMode: "0710",
        mode: "0660",
      },
    ],
    startupOrder: [
      "sompi-authority",
      "sompi-api",
      "hermes-gateway",
    ],
    hermes: {
      skill: "~/.hermes/skills/sompi",
      plugin: "~/.hermes/plugins/sompi-approval",
      callback: HOST_BOOTSTRAP_PATHS.callbackSocket,
      compatibility: "native-hook-or-independent-git-checkout",
    },
    secrets: {
      ownerRecovery: request.ownerRecoveryFile,
      telegramInput: request.telegramBotTokenFile,
      authorityPrivate: HOST_BOOTSTRAP_PATHS.authorityPrivate,
      apiRuntime: HOST_BOOTSTRAP_PATHS.apiRuntime,
      apiCredential: HOST_BOOTSTRAP_PATHS.apiCredential,
      agentCredential: HOST_BOOTSTRAP_PATHS.agentCredential,
      recoveryCredential: HOST_BOOTSTRAP_PATHS.recoveryCredential,
    },
    access: [
      {
        principal: "agent",
        checks: [
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.agentCredential, allowed: true },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.apiCredential, allowed: false },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.recoveryCredential, allowed: false },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.authorityPrivate}/telegram-bot-token`, allowed: false },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.apiRuntime}/wallet-key`, allowed: false },
          { kind: "read", path: request.telegramBotTokenFile, allowed: false },
          { kind: "read", path: request.ownerRecoveryFile, allowed: false },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.agentApiSocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.callbackSocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.authoritySocket, allowed: false },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.recoverySocket, allowed: false },
        ],
      },
      {
        principal: "sompi-api",
        checks: [
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.apiCredential, allowed: true },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.agentCredential, allowed: false },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.recoveryCredential, allowed: true },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.authorityPrivate}/telegram-bot-token`, allowed: false },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.apiRuntime}/wallet-key`, allowed: true },
          { kind: "read", path: request.telegramBotTokenFile, allowed: false },
          { kind: "read", path: request.ownerRecoveryFile, allowed: false },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.authoritySocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.callbackSocket, allowed: false },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.agentApiSocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.recoverySocket, allowed: true },
        ],
      },
      {
        principal: "sompi-authority",
        checks: [
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.apiCredential, allowed: false },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.agentCredential, allowed: false },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.recoveryCredential, allowed: false },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.authorityPrivate}/telegram-bot-token`, allowed: true },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.apiRuntime}/wallet-key`, allowed: false },
          { kind: "read", path: request.telegramBotTokenFile, allowed: false },
          { kind: "read", path: request.ownerRecoveryFile, allowed: false },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.authoritySocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.callbackSocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.agentApiSocket, allowed: false },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.recoverySocket, allowed: false },
        ],
      },
      {
        principal: "operator",
        checks: [
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.apiCredential, allowed: true },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.agentCredential, allowed: true },
          { kind: "read", path: HOST_BOOTSTRAP_PATHS.recoveryCredential, allowed: true },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.authorityPrivate}/telegram-bot-token`, allowed: true },
          { kind: "read", path: `${HOST_BOOTSTRAP_PATHS.apiRuntime}/wallet-key`, allowed: true },
          { kind: "read", path: request.telegramBotTokenFile, allowed: true },
          { kind: "read", path: request.ownerRecoveryFile, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.authoritySocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.callbackSocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.agentApiSocket, allowed: true },
          { kind: "connect", path: HOST_BOOTSTRAP_PATHS.recoverySocket, allowed: true },
        ],
      },
    ],
    rollback: {
      scope: "invocation-created-resources-only",
      reverses: [
        "service activation",
        "Hermes configuration",
        "files and directories",
        "supplementary memberships",
        "service principals and groups",
      ],
    },
  });
}

export function previewHostBootstrap(
  requestInput: HostBootstrapRequest,
  runningPackageVersion: string,
  requestFilename = "REQUEST.json",
): HostBootstrapPreview {
  const request = parseHostBootstrapRequest(requestInput);
  if (request.packageVersion !== runningPackageVersion) {
    throw new HostBootstrapError("host bootstrap request does not match the running package version");
  }
  const digest = hostBootstrapRequestDigest(request);
  return deepFreeze({
    schema: HOST_BOOTSTRAP_SCHEMA,
    requestDigest: digest,
    package: `${PACKAGE_NAME}@${request.packageVersion}`,
    agent: request.agent,
    network: "kaspa:testnet-10",
    vaultCapSompi: request.operator.maxOutflowSompi,
    vaultWindowDaa: request.operator.windowSizeDaa,
    merchants: request.operator.merchant.allowRules.map((rule) => `${rule.hostname}:${rule.ports.join(",")}`),
    authority: "telegram-inline-v1",
    ownerRecoveryFile: request.ownerRecoveryFile,
    minimumFundingSompi: (
      BigInt(request.initialVault.minimumDepositSompi) +
      BigInt(request.initialVault.keepFloatSompi) +
      BigInt(request.operator.treasury.operationFeeCeilingAtomic)
    ).toString(),
    secretInput: "root-only Telegram bot-token file",
    topology: hostBootstrapTopology(request),
    nextCommand: privilegedBootstrapCommand(request.packageVersion, requestFilename, digest),
  });
}

export function operatorSpecForHostBootstrap(
  requestInput: HostBootstrapRequest,
  ownerPublic: string,
): OperatorProvisioningSpec {
  const request = parseHostBootstrapRequest(requestInput);
  return parseOperatorProvisioningSpec({
    schema: OPERATOR_PROVISIONING_SCHEMA,
    dataDirectory: "/var/lib/sompi-api/runtime",
    ownerPublic,
    ...request.operator,
  });
}

function rootOnlyPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== path.resolve(value) || !value.startsWith("/root/") || value === "/root/") {
    throw new HostBootstrapError(`host bootstrap ${label} must be below /root`);
  }
  return value;
}

function positiveAtomic(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new HostBootstrapError(`host bootstrap ${label} is invalid`);
  }
  const amount = BigInt(value);
  if (amount > 21_000_000_000_000_000n) throw new HostBootstrapError(`host bootstrap ${label} is invalid`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostBootstrapError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new HostBootstrapError(`${label} has unknown or missing fields`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function privilegedBootstrapCommand(version: string, requestFilename: string, digest: string): string {
  const installerUrl =
    `https://raw.githubusercontent.com/elldeeone/sompi/v${version}/scripts/install-runtime-package.mjs`;
  const releasePrefix = path.join(HOST_BOOTSTRAP_PATHS.releaseRoot, version);
  return [
    "sudo sh -eu -c",
    shellQuote(PRIVILEGED_BOOTSTRAP_SCRIPT),
    "sompi-bootstrap",
    shellQuote(installerUrl),
    shellQuote(HOST_BOOTSTRAP_INSTALLER_SHA256),
    shellQuote(releasePrefix),
    shellQuote(`${PACKAGE_NAME}@${version}`),
    shellQuote(version),
    shellQuote(path.resolve(requestFilename)),
    shellQuote(digest),
  ].join(" ");
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
