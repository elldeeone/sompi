import * as fs from "node:fs";
import { isIP } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  EgressAllowRule,
} from "../purchase/egress-policy.js";
import type { Policy } from "../policy.js";
import {
  loadOperatorManifest,
  operatorManifestIdentity,
  operatorPolicy,
  type LoadedOperatorManifest,
  type OperatorFinalityFloor,
} from "../operator/manifest.js";
import {
  authorityClientRuntimePaths,
  type AuthorityClientRuntimePaths,
} from "../authority/runtime.js";

const TESTNET = "testnet-10" as const;
const X402_TESTNET = "kaspa:testnet-10" as const;
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
  readonly operatorManifest: LoadedOperatorManifest;
  readonly nodeUrl: string;
  readonly witnessBaseUrl: string;
  readonly depthConfirmationDaa: string;
  readonly finalityFloors: Readonly<{
    settlement: OperatorFinalityFloor;
    directTreasury: OperatorFinalityFloor;
    vault: OperatorFinalityFloor;
    staging: OperatorFinalityFloor;
    recoveryRelease: OperatorFinalityFloor;
  }>;
  readonly admission: LoadedOperatorManifest["manifest"]["admission"];
  readonly policy: Readonly<Policy>;
  readonly authority: SompiAuthorityClientConfig;
  readonly additionalCostCeilingAtomic: string;
  readonly batchClaimFeeReserveAtomic: string;
  readonly treasuryOperationFeeCeilingAtomic: string;
  readonly egressAllowRules: readonly EgressAllowRule[];
}

export interface PurchaseRuntimeConfigFromEnvOptions {
  readonly allowSameUserOperatorManifestForTests?: boolean;
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
  homeDirectory: string = os.homedir(),
  options: PurchaseRuntimeConfigFromEnvOptions = {}
): SompiPurchaseRuntimeConfig {
  const configuredNetwork = env.SOMPI_NETWORK ?? TESTNET;
  if (configuredNetwork !== TESTNET) {
    throw new SompiRuntimeConfigError(
      "the initial Purchase runtime supports only testnet-10"
    );
  }

  rejectRemovedOperatorEnvironment(env);
  const manifestPath = configuredPath(
    requiredEnv(env, "SOMPI_OPERATOR_MANIFEST"),
    "Operator Manifest path"
  );
  const operatorUserId = requiredNumericId(env, "SOMPI_OPERATOR_UID", "operator user ID");
  const runtimeGroupId = requiredNumericId(env, "SOMPI_RUNTIME_GID", "runtime group ID");
  const operatorManifest = loadOperatorManifest(manifestPath, {
    expectedOperatorUserId: operatorUserId,
    runtimeGroupId,
    ...(options.allowSameUserOperatorManifestForTests
      ? { allowSameUserForTests: true }
      : {}),
  });

  // Parse every deployment locator before creating or changing runtime state.
  const home = configuredPath(homeDirectory, "home directory");
  const dataDirectory = operatorManifest.manifest.dataDirectory;
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
  const additionalCostCeilingAtomic =
    operatorManifest.manifest.treasury.additionalCostCeilingAtomic;
  const batchClaimFeeReserveAtomic =
    operatorManifest.manifest.batch.claimFeeReserveAtomic;
  const treasuryOperationFeeCeilingAtomic =
    operatorManifest.manifest.treasury.operationFeeCeilingAtomic;
  const egressAllowRules = operatorManifest.manifest.merchant.allowRules;
  const nodeUrl = operatorManifest.manifest.chainEvidence.operatorNodeUrl;

  secureRuntimeDirectory(dataDirectory);
  return Object.freeze({
    networkId: TESTNET,
    x402Network: X402_TESTNET,
    dataDirectory,
    journalDatabase: path.join(dataDirectory, "purchase.sqlite"),
    stagingKeyDirectory: path.join(dataDirectory, "staging-keys"),
    operatorManifest,
    nodeUrl,
    witnessBaseUrl: operatorManifest.manifest.chainEvidence.witnessBaseUrl,
    depthConfirmationDaa: operatorManifest.manifest.chainEvidence.depthConfirmationDaa,
    finalityFloors: operatorManifest.manifest.chainEvidence.finalityFloors,
    admission: operatorManifest.manifest.admission,
    policy: operatorPolicy(operatorManifest.manifest),
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
    additionalCostCeilingAtomic,
    batchClaimFeeReserveAtomic,
    treasuryOperationFeeCeilingAtomic,
    egressAllowRules,
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
      "operatorManifest",
      "nodeUrl",
      "witnessBaseUrl",
      "depthConfirmationDaa",
      "finalityFloors",
      "admission",
      "policy",
      "authority",
      "additionalCostCeilingAtomic",
      "batchClaimFeeReserveAtomic",
      "treasuryOperationFeeCeilingAtomic",
      "egressAllowRules",
    ],
    new Set(),
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
  if (!isRecord(value.operatorManifest)) {
    throw new SompiRuntimeConfigError("Operator Manifest configuration is invalid");
  }
  exactKeys(
    value.operatorManifest,
    ["manifest", "identity", "filename"],
    new Set(),
    "Operator Manifest configuration"
  );
  if (!isRecord(value.operatorManifest.manifest) || !isRecord(value.operatorManifest.identity)) {
    throw new SompiRuntimeConfigError("Operator Manifest configuration is invalid");
  }
  const expectedIdentity = operatorManifestIdentity(value.operatorManifest.manifest as any);
  if (
    value.operatorManifest.identity.revision !== expectedIdentity.revision ||
    value.operatorManifest.identity.digest !== expectedIdentity.digest ||
    value.operatorManifest.manifest.dataDirectory !== dataDirectory ||
    absoluteConfiguredPath(value.operatorManifest.filename, "Operator Manifest path") !==
      value.operatorManifest.filename
  ) {
    throw new SompiRuntimeConfigError("Operator Manifest identity or runtime binding is invalid");
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
  atomic(
    requireString(value.additionalCostCeilingAtomic, "Purchase additional-cost ceiling"),
    "Purchase additional-cost ceiling"
  );
  positiveAtomic(
    requireString(value.batchClaimFeeReserveAtomic, "batch claim-fee reserve"),
    "batch claim-fee reserve"
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
  const manifest = value.operatorManifest.manifest as any;
  if (
    value.nodeUrl !== manifest.chainEvidence.operatorNodeUrl ||
    value.witnessBaseUrl !== manifest.chainEvidence.witnessBaseUrl ||
    value.depthConfirmationDaa !== manifest.chainEvidence.depthConfirmationDaa ||
    JSON.stringify(value.finalityFloors) !== JSON.stringify(manifest.chainEvidence.finalityFloors) ||
    JSON.stringify(value.admission) !== JSON.stringify(manifest.admission) ||
    JSON.stringify(value.egressAllowRules) !== JSON.stringify(manifest.merchant.allowRules) ||
    value.additionalCostCeilingAtomic !== manifest.treasury.additionalCostCeilingAtomic ||
    value.batchClaimFeeReserveAtomic !== manifest.batch.claimFeeReserveAtomic ||
    value.treasuryOperationFeeCeilingAtomic !== manifest.treasury.operationFeeCeilingAtomic
  ) {
    throw new SompiRuntimeConfigError("runtime configuration is not an exact Operator Manifest projection");
  }
  const policy = operatorPolicy(manifest);
  if (
    !isRecord(value.policy) ||
    value.policy.maxSompiPerTx !== policy.maxSompiPerTx ||
    value.policy.maxSompiPerHour !== policy.maxSompiPerHour ||
    JSON.stringify(value.policy.allowlist) !== JSON.stringify(policy.allowlist)
  ) {
    throw new SompiRuntimeConfigError("runtime policy is not an exact Operator Manifest projection");
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

function requiredNumericId(
  env: NodeJS.ProcessEnv,
  name: string,
  label: string
): number {
  const value = optionalNumericId(env[name], label);
  if (value === undefined) {
    throw new SompiRuntimeConfigError(`${name} is required for the Purchase runtime`);
  }
  return value;
}

function rejectRemovedOperatorEnvironment(env: NodeJS.ProcessEnv): void {
  const removed = [
    "SOMPI_DATA_DIR",
    "SOMPI_POLICY",
    "SOMPI_NODE_URL",
    "SOMPI_EGRESS_ALLOW",
    "SOMPI_EGRESS_PROTOCOLS",
    "SOMPI_PURCHASE_ADDITIONAL_COST_CEILING",
    "SOMPI_TREASURY_OPERATION_FEE_CEILING",
  ];
  const configured = removed.filter((name) => env[name] !== undefined);
  if (configured.length > 0) {
    throw new SompiRuntimeConfigError(
      `${configured.join(", ")} were removed; install these facts through sompi-operator`
    );
  }
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
