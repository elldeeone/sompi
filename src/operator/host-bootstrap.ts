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
const MAX_REQUEST_BYTES = 64 * 1024;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const PLACEHOLDER_OWNER_PUBLIC = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

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
    package: `@elldeeone/sompi@${request.packageVersion}`,
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
    nextCommand: [
      "sudo npm exec --yes --allow-scripts=better-sqlite3@12.11.1",
      `--package=@elldeeone/sompi@${request.packageVersion} -- sompi-operator bootstrap`,
      shellQuote(path.resolve(requestFilename)),
      shellQuote(digest),
    ].join(" "),
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
