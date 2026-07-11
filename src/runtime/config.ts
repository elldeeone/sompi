import * as fs from "node:fs";
import { isIP } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  EgressAllowRule,
  EgressProtocol,
} from "../purchase/egress-policy.js";
import {
  authorityClientRuntimePaths,
  type AuthorityClientRuntimePaths,
} from "../authority/runtime.js";

const TESTNET = "testnet-10" as const;
const X402_TESTNET = "kaspa:testnet-10" as const;
const DEFAULT_ADDITIONAL_COST_CEILING = "25000000";
const DEFAULT_TREASURY_OPERATION_FEE_CEILING = "25000000";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const IPC_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const UINT64_MAX = (1n << 64n) - 1n;
const PATH_MAX_BYTES = 4096;

export interface SompiAuthorityClientConfig {
  readonly paths: AuthorityClientRuntimePaths;
  readonly socketAccess?: Readonly<{
    expectedOwnerUserId: number;
    groupId: number;
  }>;
  readonly issuer: string;
  readonly keyId: string;
  readonly instrumentId: string;
  readonly clientReplayDatabase: string;
}

export interface SompiPurchaseRuntimeConfig {
  readonly networkId: typeof TESTNET;
  readonly x402Network: typeof X402_TESTNET;
  readonly dataDirectory: string;
  readonly journalDatabase: string;
  readonly stagingKeyDirectory: string;
  readonly nodeUrl?: string;
  readonly policyPath?: string;
  readonly authority: SompiAuthorityClientConfig;
  readonly merchantReceiptIssuer: string;
  readonly paymentReceiptIssuer: string;
  readonly additionalCostCeilingAtomic: string;
  readonly treasuryOperationFeeCeilingAtomic: string;
  readonly egressAllowRules: readonly EgressAllowRule[];
  readonly egressProtocols: readonly EgressProtocol[];
}

export class SompiRuntimeConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SompiRuntimeConfigError";
  }
}

/** Strict environment boundary for the initial AP2 + exact testnet profile. */
export function purchaseRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir()
): SompiPurchaseRuntimeConfig {
  const configuredNetwork = env.SOMPI_NETWORK ?? TESTNET;
  if (configuredNetwork !== TESTNET) {
    throw new SompiRuntimeConfigError(
      "the initial Purchase runtime supports only testnet-10"
    );
  }

  // Parse every environment value before creating or changing operator state.
  const home = configuredPath(homeDirectory, "home directory");
  const dataDirectory = configuredPath(
    env.SOMPI_DATA_DIR ?? path.join(home, ".sompi", TESTNET),
    "Sompi data directory"
  );
  const authorityRoot = configuredPath(
    env.SOMPI_AUTHORITY_ROOT_DIR ?? path.join(home, ".sompi", "authority"),
    "authority root directory"
  );
  const authorityClientDirectory = configuredPath(
    env.SOMPI_AUTHORITY_CLIENT_DIR ?? path.join(authorityRoot, "client"),
    "authority client directory"
  );
  const authorityRuntimeDirectory = configuredPath(
    env.SOMPI_AUTHORITY_RUNTIME_DIR ?? path.join(authorityRoot, "run"),
    "authority runtime directory"
  );
  const authoritySocket = optionalPath(
    env.SOMPI_AUTHORITY_SOCKET,
    "authority socket"
  );
  let authorityPaths: AuthorityClientRuntimePaths;
  try {
    authorityPaths = authorityClientRuntimePaths({
      rootDirectory: authorityRoot,
      clientDirectory: authorityClientDirectory,
      runtimeDirectory: authorityRuntimeDirectory,
      ...(authoritySocket ? { socketPath: authoritySocket } : {}),
    });
  } catch (error) {
    throw new SompiRuntimeConfigError("authority client paths are invalid", {
      cause: error,
    });
  }
  const socketOwnerUserId = optionalNumericId(
    env.SOMPI_AUTHORITY_SOCKET_UID,
    "authority socket owner user ID"
  );
  const socketGroupId = optionalNumericId(
    env.SOMPI_AUTHORITY_SOCKET_GID,
    "authority socket group ID"
  );
  if (socketOwnerUserId === undefined || socketGroupId === undefined) {
    throw new SompiRuntimeConfigError(
      "a separate authority socket owner UID and shared IPC GID are required"
    );
  }
  const issuer = identity(
    env.SOMPI_AUTHORITY_ISSUER ?? "urn:sompi:authority:local",
    "authority issuer"
  );
  const keyId = ipcKeyId(
    env.SOMPI_AUTHORITY_IPC_KEY_ID ?? "authority-ipc-key-1",
    "authority IPC key ID"
  );
  const instrumentId = identity(
    env.SOMPI_AUTHORITY_INSTRUMENT_ID ?? "kaspa:testnet-10:vault-treasury",
    "authority instrument ID"
  );
  const merchantReceiptIssuer = identity(
    requiredEnv(env, "SOMPI_AP2_MERCHANT_RECEIPT_ISSUER"),
    "Merchant Receipt issuer"
  );
  const paymentReceiptIssuer = identity(
    requiredEnv(env, "SOMPI_AP2_PAYMENT_RECEIPT_ISSUER"),
    "Payment Receipt issuer"
  );
  requireDistinctReceiptIssuers(merchantReceiptIssuer, paymentReceiptIssuer);
  const additionalCostCeilingAtomic = atomic(
    env.SOMPI_PURCHASE_ADDITIONAL_COST_CEILING ??
      DEFAULT_ADDITIONAL_COST_CEILING,
    "Purchase additional-cost ceiling"
  );
  const treasuryOperationFeeCeilingAtomic = positiveAtomic(
    env.SOMPI_TREASURY_OPERATION_FEE_CEILING ??
      DEFAULT_TREASURY_OPERATION_FEE_CEILING,
    "direct Treasury operation fee ceiling"
  );
  const egressAllowRules = parseAllowRules(
    requiredEnv(env, "SOMPI_EGRESS_ALLOW")
  );
  const egressProtocols = parseProtocols(env.SOMPI_EGRESS_PROTOCOLS);
  const nodeUrl = optionalUrl(env.SOMPI_NODE_URL, "Kaspa node URL");
  const policyPath = optionalPath(env.SOMPI_POLICY, "Treasury policy file");

  secureRuntimeDirectory(dataDirectory);
  return Object.freeze({
    networkId: TESTNET,
    x402Network: X402_TESTNET,
    dataDirectory,
    journalDatabase: path.join(dataDirectory, "purchase.sqlite"),
    stagingKeyDirectory: path.join(dataDirectory, "staging-keys"),
    ...(nodeUrl ? { nodeUrl } : {}),
    ...(policyPath ? { policyPath } : {}),
    authority: Object.freeze({
      paths: authorityPaths,
      socketAccess: Object.freeze({
        expectedOwnerUserId: socketOwnerUserId,
        groupId: socketGroupId,
      }),
      issuer,
      keyId,
      instrumentId,
      clientReplayDatabase: path.join(
        dataDirectory,
        "authority-client-replay.sqlite"
      ),
    }),
    merchantReceiptIssuer,
    paymentReceiptIssuer,
    additionalCostCeilingAtomic,
    treasuryOperationFeeCeilingAtomic,
    egressAllowRules,
    egressProtocols,
  });
}

/** Revalidates programmatic configuration before the composition root acts. */
export function assertSompiPurchaseRuntimeConfig(
  value: unknown
): asserts value is SompiPurchaseRuntimeConfig {
  if (!isRecord(value)) {
    throw new SompiRuntimeConfigError("Sompi Purchase runtime configuration is invalid");
  }
  exactKeys(
    value,
    [
      "networkId",
      "x402Network",
      "dataDirectory",
      "journalDatabase",
      "stagingKeyDirectory",
      "authority",
      "merchantReceiptIssuer",
      "paymentReceiptIssuer",
      "additionalCostCeilingAtomic",
      "treasuryOperationFeeCeilingAtomic",
      "egressAllowRules",
      "egressProtocols",
    ],
    new Set(["nodeUrl", "policyPath"]),
    "Purchase runtime configuration"
  );
  if (value.networkId !== TESTNET || value.x402Network !== X402_TESTNET) {
    throw new SompiRuntimeConfigError(
      "the initial Purchase runtime supports only testnet-10"
    );
  }
  const dataDirectory = absoluteConfiguredPath(
    value.dataDirectory,
    "Sompi data directory"
  );
  if (
    absoluteConfiguredPath(value.journalDatabase, "Purchase Journal database") !==
      path.join(dataDirectory, "purchase.sqlite") ||
    absoluteConfiguredPath(value.stagingKeyDirectory, "staging key directory") !==
      path.join(dataDirectory, "staging-keys")
  ) {
    throw new SompiRuntimeConfigError(
      "Purchase runtime state paths are not bound to the Sompi data directory"
    );
  }
  if (!isRecord(value.authority)) {
    throw new SompiRuntimeConfigError("authority client configuration is invalid");
  }
  exactKeys(
    value.authority,
    ["paths", "issuer", "keyId", "instrumentId", "clientReplayDatabase"],
    new Set(["socketAccess"]),
    "authority client configuration"
  );
  identity(requireString(value.authority.issuer, "authority issuer"), "authority issuer");
  ipcKeyId(requireString(value.authority.keyId, "authority IPC key ID"), "authority IPC key ID");
  identity(
    requireString(value.authority.instrumentId, "authority instrument ID"),
    "authority instrument ID"
  );
  if (
    absoluteConfiguredPath(
      value.authority.clientReplayDatabase,
      "authority client replay database"
    ) !== path.join(dataDirectory, "authority-client-replay.sqlite")
  ) {
    throw new SompiRuntimeConfigError(
      "authority client replay database is not bound to the Sompi data directory"
    );
  }
  assertAuthorityPaths(value.authority.paths);
  if (value.authority.socketAccess !== undefined) {
    if (!isRecord(value.authority.socketAccess)) {
      throw new SompiRuntimeConfigError("authority socket access configuration is invalid");
    }
    exactKeys(
      value.authority.socketAccess,
      ["expectedOwnerUserId", "groupId"],
      new Set(),
      "authority socket access configuration"
    );
    numericId(
      value.authority.socketAccess.expectedOwnerUserId,
      "authority socket owner user ID"
    );
    numericId(value.authority.socketAccess.groupId, "authority socket group ID");
  }
  const merchantReceiptIssuer = identity(
    requireString(value.merchantReceiptIssuer, "Merchant Receipt issuer"),
    "Merchant Receipt issuer"
  );
  const paymentReceiptIssuer = identity(
    requireString(value.paymentReceiptIssuer, "Payment Receipt issuer"),
    "Payment Receipt issuer"
  );
  requireDistinctReceiptIssuers(merchantReceiptIssuer, paymentReceiptIssuer);
  atomic(
    requireString(value.additionalCostCeilingAtomic, "Purchase additional-cost ceiling"),
    "Purchase additional-cost ceiling"
  );
  positiveAtomic(
    requireString(
      value.treasuryOperationFeeCeilingAtomic,
      "direct Treasury operation fee ceiling"
    ),
    "direct Treasury operation fee ceiling"
  );

  const rules = normalizeAllowRules(value.egressAllowRules);
  if (JSON.stringify(rules) !== JSON.stringify(value.egressAllowRules)) {
    throw new SompiRuntimeConfigError("egress allow rules are not canonical");
  }
  const protocols = normalizeProtocols(value.egressProtocols);
  if (JSON.stringify(protocols) !== JSON.stringify(value.egressProtocols)) {
    throw new SompiRuntimeConfigError("egress protocols are not canonical");
  }
  if (value.nodeUrl !== undefined) {
    optionalUrl(requireString(value.nodeUrl, "Kaspa node URL"), "Kaspa node URL");
  }
  if (value.policyPath !== undefined) {
    absoluteConfiguredPath(value.policyPath, "Treasury policy file");
  }
}

function requireDistinctReceiptIssuers(
  merchantReceiptIssuer: string,
  paymentReceiptIssuer: string
): void {
  if (merchantReceiptIssuer === paymentReceiptIssuer) {
    throw new SompiRuntimeConfigError(
      "Merchant Receipt issuer and Payment Receipt issuer must be distinct"
    );
  }
}

export function secureRuntimeDirectory(directory: string): string {
  const resolved = configuredPath(directory, "Sompi data directory");
  let descriptor: number | undefined;
  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | directoryFlag() | noFollowFlag()
    );
    const before = fs.fstatSync(descriptor);
    const expectedUid =
      typeof process.getuid === "function" ? process.getuid() : before.uid;
    if (!before.isDirectory() || before.uid !== expectedUid) {
      throw new SompiRuntimeConfigError(
        "Sompi data directory ownership or type is unsafe"
      );
    }
    fs.fchmodSync(descriptor, 0o700);
    const after = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(resolved);
    if (
      !after.isDirectory() ||
      !pathStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      after.uid !== expectedUid ||
      (after.mode & 0o077) !== 0 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      pathStat.dev !== after.dev ||
      pathStat.ino !== after.ino
    ) {
      throw new SompiRuntimeConfigError(
        "Sompi data directory failed its secure mode check"
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof SompiRuntimeConfigError) throw error;
    throw new SompiRuntimeConfigError("Sompi data directory is unavailable", {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseAllowRules(value: string): readonly EgressAllowRule[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch (cause) {
    throw new SompiRuntimeConfigError(
      "SOMPI_EGRESS_ALLOW must be a JSON array of exact hostname and port rules",
      { cause }
    );
  }
  return normalizeAllowRules(candidate);
}

function normalizeAllowRules(candidate: unknown): readonly EgressAllowRule[] {
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 128) {
    throw new SompiRuntimeConfigError(
      "SOMPI_EGRESS_ALLOW must contain 1 to 128 exact rules"
    );
  }
  const seen = new Set<string>();
  const rules = candidate.map((value, index): EgressAllowRule => {
    if (!isRecord(value)) {
      throw new SompiRuntimeConfigError(`egress rule ${index} is invalid`);
    }
    exactKeys(value, ["hostname", "ports"], new Set(), `egress rule ${index}`);
    const hostname = allowHostname(value.hostname, index);
    if (!Array.isArray(value.ports) || value.ports.length === 0 || value.ports.length > 32) {
      throw new SompiRuntimeConfigError(`egress rule ${index} ports are invalid`);
    }
    const ports = value.ports.map((port) => {
      if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
        throw new SompiRuntimeConfigError(`egress rule ${index} port is invalid`);
      }
      return Number(port);
    });
    if (new Set(ports).size !== ports.length) {
      throw new SompiRuntimeConfigError(`egress rule ${index} contains duplicate ports`);
    }
    ports.sort((left, right) => left - right);
    if (seen.has(hostname)) {
      throw new SompiRuntimeConfigError(`egress rule ${index} duplicates a hostname`);
    }
    seen.add(hostname);
    return Object.freeze({ hostname, ports: Object.freeze(ports) });
  });
  return Object.freeze(rules);
}

function parseProtocols(value: string | undefined): readonly EgressProtocol[] {
  if (value === undefined) return Object.freeze(["https:"] as const);
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch (cause) {
    throw new SompiRuntimeConfigError(
      "SOMPI_EGRESS_PROTOCOLS must be a JSON array",
      { cause }
    );
  }
  return normalizeProtocols(candidate);
}

function normalizeProtocols(candidate: unknown): readonly EgressProtocol[] {
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.length > 2 ||
    candidate.some((item) => item !== "https:" && item !== "http:") ||
    new Set(candidate).size !== candidate.length
  ) {
    throw new SompiRuntimeConfigError(
      "SOMPI_EGRESS_PROTOCOLS may contain only unique https: and http: entries"
    );
  }
  return Object.freeze([...(candidate as EgressProtocol[])]);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SompiRuntimeConfigError(
      `${name} is required for the Purchase runtime`
    );
  }
  return value;
}

function identity(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return value;
}

function ipcKeyId(value: string, label: string): string {
  if (!IPC_KEY_ID_PATTERN.test(value)) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return value;
}

function atomic(value: string, label: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > UINT64_MAX) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return value;
}

function positiveAtomic(value: string, label: string): string {
  const canonical = atomic(value, label);
  if (canonical === "0") throw new SompiRuntimeConfigError(`${label} must be positive`);
  return canonical;
}

function optionalUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new SompiRuntimeConfigError(`${label} is invalid`, { cause });
  }
  if (
    !["ws:", "wss:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  ) {
    throw new SompiRuntimeConfigError(
      `${label} must be an uncredentialed ws or wss URL without query or fragment`
    );
  }
  return parsed.href;
}

function optionalPath(
  value: string | undefined,
  label: string
): string | undefined {
  return value === undefined ? undefined : configuredPath(value, label);
}

function configuredPath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > PATH_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return path.resolve(value);
}

function absoluteConfiguredPath(value: unknown, label: string): string {
  const text = requireString(value, label);
  const resolved = configuredPath(text, label);
  if (!path.isAbsolute(text) || resolved !== text) {
    throw new SompiRuntimeConfigError(`${label} must be an absolute canonical path`);
  }
  return resolved;
}

function allowHostname(value: unknown, index: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\s/@?#*]/.test(value)
  ) {
    throw new SompiRuntimeConfigError(`egress rule ${index} hostname is invalid`);
  }
  const bracketed = value.startsWith("[") && value.endsWith("]");
  const unbracketed = bracketed ? value.slice(1, -1) : value;
  const family = isIP(unbracketed);
  if (family === 4) return unbracketed;
  if (family === 6) {
    return new URL(`https://[${unbracketed}]/`)
      .hostname.slice(1, -1).toLowerCase();
  }
  if (bracketed || /^[0-9.]+$/.test(value)) {
    throw new SompiRuntimeConfigError(`egress rule ${index} hostname is invalid`);
  }
  const lowered = value.toLowerCase();
  const hostname = lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname.split(".").some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    throw new SompiRuntimeConfigError(`egress rule ${index} hostname is invalid`);
  }
  return hostname;
}

function assertAuthorityPaths(value: unknown): asserts value is AuthorityClientRuntimePaths {
  if (!isRecord(value)) {
    throw new SompiRuntimeConfigError("authority runtime paths are invalid");
  }
  const keys = ["directory", "macKey", "trust", "socket"];
  exactKeys(value, keys, new Set(), "authority runtime paths");
  const directory = absoluteConfiguredPath(value.directory, "authority client directory");
  const socket = absoluteConfiguredPath(value.socket, "authority socket");
  let expected: Record<string, unknown>;
  try {
    expected = authorityClientRuntimePaths({
      clientDirectory: directory,
      runtimeDirectory: path.dirname(socket),
      socketPath: socket,
    }) as unknown as Record<string, unknown>;
  } catch (error) {
    throw new SompiRuntimeConfigError("authority runtime paths are inconsistent", {
      cause: error,
    });
  }
  for (const key of keys) {
    if (
      absoluteConfiguredPath(value[key], `authority ${key} path`) !==
      expected[key]
    ) {
      throw new SompiRuntimeConfigError("authority runtime paths are inconsistent");
    }
  }
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: ReadonlySet<string>,
  label: string
): void {
  const actual = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    actual.some((key) => !required.includes(key) && !optional.has(key))
  ) {
    throw new SompiRuntimeConfigError(`${label} has unknown or missing fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return value;
}

function optionalNumericId(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return numericId(Number(value), label);
}

function numericId(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0x7fffffff
  ) {
    throw new SompiRuntimeConfigError(`${label} is invalid`);
  }
  return value;
}

function directoryFlag(): number {
  return typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}
